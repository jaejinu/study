import { ensureConnected, getRedis } from "@/lib/redis";
import type { CodeExperiment } from "./types";

/** 분산 시스템 이론의 "증거 실험": 펜싱 토큰, 쿼럼, 논리 시계를 작은 코드로 재현한다. */

// ---------------------------------------------------------------- 펜싱 토큰
export const dsFencingToken: CodeExperiment = {
  id: "ds-fencing-token",
  subject: "distributed-systems",
  title: "펜싱 토큰: 리스가 만료된 뒤 깨어난 옛 소유자의 쓰기를 저장소가 거부한다",
  category: "코디네이션",
  summary: "Redis 로 리스(TTL 락) + 단조 증가 토큰을 발급하고, 클라이언트 A 가 GC 정지처럼 멈춘 사이 리스가 만료되어 B 가 더 큰 토큰을 받는다. 저장소(Lua 스크립트)는 '마지막으로 본 토큰보다 작은' A 의 쓰기를 거부하고 B 의 쓰기만 받는다. 토큰 비교가 없으면 A 의 쓰기가 B 를 덮어쓰는 것도 함께 보여 준다",
  notes: ["06-transactions-coordination", "05-consensus"],
  description: `
분산 락의 유명한 함정: 락을 쥔 클라이언트가 **멈춘 사이**(GC 정지, 네트워크 지연, 페이지 폴트) 락 TTL 이 만료되고 다른 클라이언트가 락을 얻는다. 멈췄던 클라이언트는 깨어나 **자기가 아직 락 소유자라고 믿고** 쓴다. 락 서비스는 그 쓰기를 막을 수 없다 — 쓰기는 저장소로 가기 때문이다.
**펜싱 토큰**(Kleppmann 의 "How to do distributed locking")은 락을 줄 때 **단조 증가 번호**를 함께 주고, **저장소**가 "지금까지 본 가장 큰 토큰보다 작은 토큰의 쓰기는 거부" 하게 만든다. 락 서비스가 아니라 저장소가 최후의 심판이 된다.
이 실험은 Redis 하나로 락 서비스(INCR 토큰 + SET NX PX)와 저장소(Lua 로 토큰 비교 쓰기)를 모두 흉내 낸다.
`,
  code: `-- 락 획득: token = INCR lock:seq; SET lock:res <token> NX PX 500
-- 저장소 쓰기 (Lua, 원자적):
local seen = tonumber(redis.call('GET', KEYS[1]..':token') or '0')
if tonumber(ARGV[1]) < seen then return {0, seen} end          -- 오래된 토큰 → 거부
redis.call('SET', KEYS[1]..':token', ARGV[1]); redis.call('SET', KEYS[1], ARGV[2]); return {1, tonumber(ARGV[1])}
-- A: token 1 획득 → (멈춤 700ms, TTL 500ms 만료) → B: token 2 획득, 쓰기 OK → A 깨어나 token 1 로 쓰기 → 거부`,
  async run({ rec, k }) {
    const r = getRedis();
    await ensureConnected(r);
    const seq = k("fence:seq"), lock = k("fence:lock"), res = k("fence:res");
    await r.del(seq, lock, res, `${res}:token`);
    const WRITE = `
local seen = tonumber(redis.call('GET', KEYS[1]..':token') or '0')
if tonumber(ARGV[1]) < seen then return {0, seen} end
redis.call('SET', KEYS[1]..':token', ARGV[1])
redis.call('SET', KEYS[1], ARGV[2])
return {1, tonumber(ARGV[1])}`;
    const NAIVE = `redis.call('SET', KEYS[1], ARGV[2]) return {1, 0}`;
    const acquire = async (who: string) => {
      const token = await r.incr(seq);
      const ok = await r.set(lock, `${who}:${token}`, "PX", 500, "NX");
      return ok ? token : null;
    };
    const write = async (script: string, token: number, value: string) => (await r.eval(script, 1, res, String(token), value)) as [number, number];

    rec.note("라운드 1 — 저장소가 토큰을 비교하지 않는 순진한 쓰기");
    let a = await acquire("A");
    rec.check("A 가 락을 얻고 토큰 1 을 받았다", a === 1, a);
    await rec.measure("A 가 멈춘다 (GC 정지 흉내 700ms) — 락 TTL 500ms 는 그 사이 만료", () => new Promise((x) => setTimeout(x, 700)));
    let b = await acquire("B");
    rec.check("B 가 락을 얻고 토큰 2 를 받았다 (A 의 락은 만료됨)", b === 2, b);
    await write(NAIVE, b!, "B 의 값");
    await write(NAIVE, a!, "A 의 늦은 값");
    const naiveFinal = await r.get(res);
    rec.steps.push({ cmd: "저장소 최종 값 (토큰 비교 없음)", result: naiveFinal, ms: 0 });
    rec.check("순진한 저장소에선 깨어난 A 의 쓰기가 B 를 덮어쓴다 — 락이 있어도 소용없다", naiveFinal === "A 의 늦은 값");

    rec.note("라운드 2 — 저장소가 펜싱 토큰을 비교한다 (Lua 원자 쓰기)");
    await r.del(seq, lock, res, `${res}:token`);
    a = await acquire("A");
    await new Promise((x) => setTimeout(x, 700));
    b = await acquire("B");
    const wb = await write(WRITE, b!, "B 의 값");
    const wa = await write(WRITE, a!, "A 의 늦은 값");
    const fencedFinal = await r.get(res);
    rec.steps.push({ cmd: "B(token 2) 쓰기 → A(token 1) 쓰기", result: { B: wb[0] ? "accepted" : "rejected", A: wa[0] ? "accepted" : `rejected (저장소가 본 최대 토큰 ${wa[1]})`, final: fencedFinal }, ms: 0 });
    rec.check("B 의 쓰기는 받고 A 의 늦은 쓰기는 거부 — 최종 값은 B", wb[0] === 1 && wa[0] === 0 && fencedFinal === "B 의 값");
    rec.note("교훈: 락은 '조언' 일 뿐이다. 안전성은 저장소가 토큰(또는 버전·CAS)을 검사해야 생긴다. Redlock 논쟁의 핵심도 이것 — TTL 기반 락은 시계와 정지에 취약하고, 펜싱 없이는 상호 배제를 보장하지 못한다. ZooKeeper 의 zxid, etcd 의 revision 이 이 토큰 역할을 한다.");
    await r.del(seq, lock, res, `${res}:token`);
  },
};

// ---------------------------------------------------------------- 쿼럼 읽기/쓰기
export const dsQuorumReadWrite: CodeExperiment = {
  id: "ds-quorum-read-write",
  subject: "distributed-systems",
  title: "쿼럼: N=3 복제본에서 W+R>N 이면 최신 값을 반드시 읽고, 아니면 stale 읽기가 생긴다",
  category: "복제",
  summary: "Redis 키 3개를 느린 복제본 3개로 흉내 낸다(쓰기마다 복제본별 무작위 지연·일부 유실). (W=1,R=1)·(W=2,R=2)·(W=3,R=1) 조합으로 각 200회 쓰고-바로-읽어 stale 비율을 재고, 쿼럼 읽기가 '가장 큰 버전' 을 고르는 과정과 읽기 복구(read repair)를 보여 준다",
  notes: ["04-replication", "03-consistency-models"],
  description: `
무리더 복제(Dynamo·Cassandra)는 쓰기를 N 개 복제본에 보내고 **W 개의 확인**을 받으면 성공, 읽기는 **R 개**에서 읽어 **버전이 가장 큰 값**을 고른다. W+R>N 이면 읽은 집합과 쓴 집합이 **반드시 겹치므로** 최신 값이 적어도 하나 들어 있다.
W+R≤N 이면 겹치지 않을 수 있어 **stale 읽기**가 가능하다. 이 실험은 복제본마다 전파 지연과 유실을 흉내 내어 그 차이를 숫자로 보여 준다. (주의: 쿼럼은 선형화를 보장하지 않는다 — 동시 쓰기·부분 실패·슬로피 쿼럼에서 깨진다. 노트 04 참고)
`,
  code: `// 복제본 i: SET rep:i  "<version>:<value>"  (지연 0~150ms, 10% 유실)
// 쓰기(W): N 개에 전송, W 개 ack 를 기다린 뒤 반환
// 읽기(R): R 개에서 읽어 version 이 가장 큰 값 반환 (+ 뒤처진 복제본에 read repair)
// 조합: (W1,R1) (W2,R2) (W3,R1) (W1,R3) × 200회 → stale 비율`,
  async run({ rec, k }) {
    const r = getRedis();
    await ensureConnected(r);
    const N = 3;
    const reps = Array.from({ length: N }, (_, i) => k(`quorum:rep${i}`));
    await r.del(...reps);
    let version = 0;
    const replicate = async (i: number, v: number, val: string) => {
      // 복제본마다 전파 지연 0~150ms, 10% 확률로 유실 → 유실은 재전송 (ack 가 올 때까지)
      for (;;) {
        await new Promise((x) => setTimeout(x, Math.random() * 150));
        if (Math.random() < 0.1) continue;
        // 오래된 버전이 늦게 도착해도 덮어쓰지 않게: 더 큰 버전만 (Lua 로 원자적 비교-쓰기)
        await r.eval("local c = redis.call('GET', KEYS[1]); if (not c) or tonumber(string.match(c, '^(%d+):')) < tonumber(ARGV[1]) then redis.call('SET', KEYS[1], ARGV[1]..':'..ARGV[2]) end return 1", 1, reps[i], String(v), val);
        return true;
      }
    };
    const write = async (W: number, val: string) => {
      const v = ++version;
      const ps = reps.map((_, i) => replicate(i, v, val));
      // W 개의 ack 를 받으면 반환 (나머지는 백그라운드로 계속)
      await new Promise<void>((resolve) => {
        let acks = 0;
        ps.forEach((p) => p.then(() => { acks++; if (acks >= W) resolve(); }));
      });
      return v;
    };
    const read = async (R: number, repair: boolean) => {
      const idx = [...reps.keys()].sort(() => Math.random() - 0.5).slice(0, R);
      const vals = await Promise.all(idx.map(async (i) => ({ i, raw: await r.get(reps[i]) })));
      const parsed = vals.map((x) => ({ i: x.i, v: x.raw ? Number(x.raw.split(":")[0]) : 0, val: x.raw?.split(":")[1] ?? "" }));
      const best = parsed.reduce((a, b) => (b.v > a.v ? b : a));
      if (repair) for (const p of parsed) if (p.v < best.v) await r.set(reps[p.i], `${best.v}:${best.val}`);
      return best;
    };
    const combos: [number, number][] = [[1, 1], [2, 2], [3, 1], [1, 3]];
    const rows: { combo: string; overlap: string; stale: number; staleRate: string; avgWriteMs: number }[] = [];
    for (const [W, R] of combos) {
      await r.del(...reps);
      version = 0;
      let stale = 0, writeMs = 0;
      const ROUNDS = 120;
      for (let i = 0; i < ROUNDS; i++) {
        const t = performance.now();
        const v = await write(W, `v${i}`);
        writeMs += performance.now() - t;
        const got = await read(R, false);
        if (got.v < v) stale++;
      }
      // 백그라운드 복제 마무리 대기
      await new Promise((x) => setTimeout(x, 200));
      rows.push({ combo: `W=${W} R=${R}`, overlap: W + R > N ? "W+R>N ✓" : "W+R≤N ✗", stale, staleRate: `${((stale / ROUNDS) * 100).toFixed(1)}%`, avgWriteMs: Math.round(writeMs / ROUNDS) });
    }
    rec.steps.push({ cmd: "조합별 stale 읽기 (쓰기 직후 읽기, 120회)", result: rows, ms: 0 });
    const strict = rows.filter((x) => x.overlap.includes("✓")), loose = rows.filter((x) => x.overlap.includes("✗"));
    rec.check("W+R>N 조합은 stale 0 (최신 버전이 반드시 읽은 집합에 포함)", strict.every((x) => x.stale === 0), strict);
    rec.check("W=1 R=1 은 stale 읽기가 생긴다", (loose[0]?.stale ?? 0) > 0, loose);
    rec.check("W 가 클수록 쓰기 지연이 길다 (느린 복제본을 기다림)", rows.find((x) => x.combo === "W=3 R=1")!.avgWriteMs > rows.find((x) => x.combo === "W=1 R=3")!.avgWriteMs, rows.map((x) => `${x.combo}: ${x.avgWriteMs}ms`));

    rec.note("읽기 복구(read repair): 읽을 때 뒤처진 복제본을 최신으로 고친다");
    await r.del(...reps);
    version = 0;
    await write(1, "final");
    await new Promise((x) => setTimeout(x, 200));
    // 한 복제본을 일부러 낡게
    await r.set(reps[0], "0:old");
    const before = await Promise.all(reps.map((x) => r.get(x)));
    const got = await read(3, true);
    const after = await Promise.all(reps.map((x) => r.get(x)));
    rec.steps.push({ cmd: "R=3 읽기 + read repair", result: { before, chosen: `${got.v}:${got.val}`, after }, ms: 0 });
    rec.check("읽기 후 모든 복제본이 최신 버전으로 수렴", after.every((x) => x === after[0]));
    rec.note("교훈: 쿼럼은 '최신 값이 포함됨' 을 보장하지 집합 전체의 일관성을 보장하지 않는다. 버전(또는 벡터 시계)이 없으면 '최신' 을 고를 수 없고, 동시 쓰기는 충돌로 남는다(LWW 또는 병합). Cassandra 의 QUORUM, DynamoDB 의 strongly consistent read 가 이 모델이다.");
    await r.del(...reps);
  },
};

// ---------------------------------------------------------------- Lamport vs 벡터 시계
type Ev = { proc: string; name: string; lamport: number; vector: number[] };

export const dsLamportVectorClock: CodeExperiment = {
  id: "ds-lamport-vector-clock",
  subject: "distributed-systems",
  title: "Lamport 시계는 순서를 매기지만 동시성을 못 가리고, 벡터 시계는 인과와 동시를 구분한다",
  category: "시간과 순서",
  summary: "세 프로세스 P0·P1·P2 가 로컬 이벤트와 메시지를 주고받는 시나리오를 순수 TS 로 시뮬레이션한다. 각 이벤트의 Lamport 타임스탬프와 벡터 시계를 표로 만들고, 'Lamport 가 작으면 happens-before 인가?' 를 모든 쌍에 대해 검사해 반례(동시 이벤트인데 Lamport 는 순서가 있는 것처럼 보임)를 찾는다. 벡터 시계는 성분별 비교로 동시성을 정확히 판정한다",
  notes: ["02-time-and-order", "04-replication"],
  description: `
분산 시스템엔 전역 시계가 없다. 대신 **happens-before**(같은 프로세스의 순서, 송신→수신, 추이성)로 인과를 정의한다.
- **Lamport 시계**: 이벤트마다 카운터+1, 메시지엔 카운터를 실어 수신 측이 max(자기, 받은)+1. a→b 이면 L(a)<L(b) 가 **보장**된다. 하지만 역은 성립하지 않는다 — L(a)<L(b) 라도 a,b 가 **동시**(concurrent)일 수 있다.
- **벡터 시계**: 프로세스 수만큼의 카운터. 성분별로 모두 ≤ 이고 하나라도 < 이면 happens-before, 어느 쪽도 아니면 동시. **인과와 동시를 정확히 구분**한다. 그래서 충돌 감지(Dynamo 의 sibling), CRDT 의 기반이 된다.
이 실험은 같은 이벤트 열에 두 시계를 붙여 차이를 표로 보여 준다.
`,
  code: `// Lamport: local: c=c+1 / send: c=c+1, msg(c) / recv: c=max(c,m)+1
// Vector:  local: v[i]++  / send: v[i]++, msg(v) / recv: v=max(v,m) 성분별, v[i]++
// happens-before(a,b) ⇔ V(a) ≤ V(b) 성분별 && V(a) ≠ V(b)
// concurrent(a,b)     ⇔ !hb(a,b) && !hb(b,a)`,
  async run({ rec }) {
    const N = 3;
    const procs = ["P0", "P1", "P2"];
    const lamport = [0, 0, 0];
    const vec = procs.map(() => Array(N).fill(0) as number[]);
    const events: Ev[] = [];
    const local = (p: number, name: string) => { lamport[p]++; vec[p][p]++; events.push({ proc: procs[p], name, lamport: lamport[p], vector: [...vec[p]] }); return events.at(-1)!; };
    const send = (p: number, name: string) => { const e = local(p, name); return { l: e.lamport, v: [...e.vector] }; };
    const recv = (p: number, name: string, m: { l: number; v: number[] }) => { lamport[p] = Math.max(lamport[p], m.l) + 1; for (let i = 0; i < N; i++) vec[p][i] = Math.max(vec[p][i], m.v[i]); vec[p][p]++; events.push({ proc: procs[p], name, lamport: lamport[p], vector: [...vec[p]] }); return events.at(-1)!; };

    // 시나리오: 주문 생성 → 재고 서비스에 통지 / 그 사이 결제 서비스는 독립적으로 바쁨 / 재고가 결제에 통지
    const a = local(0, "a: 주문 생성");
    const m1 = send(0, "b: P1 에 '주문 생성' 전송");
    const c = local(2, "c: 결제 서비스 로컬 작업 #1");
    const d = local(2, "d: 결제 서비스 로컬 작업 #2");
    const e = recv(1, "e: P1 수신(주문 생성)", m1);
    const m2 = send(1, "f: P2 에 '재고 확보' 전송");
    const g = local(2, "g: 결제 서비스 로컬 작업 #3");
    const h = recv(2, "h: P2 수신(재고 확보)", m2);
    const i = local(0, "i: 주문 서비스 로컬 작업");
    void a; void c; void d; void e; void g; void h; void i;

    rec.steps.push({ cmd: "이벤트 표 (발생 순서대로)", result: events.map((x) => ({ proc: x.proc, event: x.name, lamport: x.lamport, vector: `[${x.vector.join(",")}]` })), ms: 0 });
    const hb = (x: Ev, y: Ev) => x.vector.every((v, idx) => v <= y.vector[idx]) && x.vector.some((v, idx) => v < y.vector[idx]);
    const pairs: { a: string; b: string; lamport: string; vector: string; mismatch: boolean }[] = [];
    let lamportImplied = 0, actuallyConcurrent = 0, violations = 0;
    for (let x = 0; x < events.length; x++) for (let y = 0; y < events.length; y++) {
      if (x === y) continue;
      const A = events[x], B = events[y];
      const ab = hb(A, B), ba = hb(B, A);
      const rel = ab ? "A→B" : ba ? "B→A" : "동시";
      if (ab && !(A.lamport < B.lamport)) violations++;
      if (A.lamport < B.lamport) { lamportImplied++; if (rel === "동시") { actuallyConcurrent++; if (pairs.length < 8) pairs.push({ a: A.name.split(":")[0], b: B.name.split(":")[0], lamport: `${A.lamport} < ${B.lamport}`, vector: `[${A.vector}] vs [${B.vector}] → 동시`, mismatch: true }); } }
    }
    rec.steps.push({ cmd: "Lamport 가 '먼저' 라고 말하지만 실제론 동시인 쌍 (일부)", result: pairs, ms: 0 });
    rec.check("happens-before 인 모든 쌍에서 Lamport(a) < Lamport(b) (시계 조건 만족, 위반 0)", violations === 0, violations);
    rec.check("Lamport 순서가 있는 쌍 중 일부는 실제로 동시 — Lamport 는 동시성을 못 가린다", actuallyConcurrent > 0, { lamportOrdered: lamportImplied, actuallyConcurrent });
    const cd = events.find((x) => x.name.startsWith("c"))!, ee = events.find((x) => x.name.startsWith("e"))!, hh = events.find((x) => x.name.startsWith("h"))!, aa = events.find((x) => x.name.startsWith("a"))!;
    rec.steps.push({ cmd: "예: a(주문 생성) 와 h(P2 수신) / c(결제 로컬) 와 e(P1 수신)", result: { "a→h": hb(aa, hh) ? "인과 (메시지 체인 a→b→e→f→h)" : "동시", "c vs e": hb(cd, ee) || hb(ee, cd) ? "인과" : `동시 (Lamport 는 ${cd.lamport} vs ${ee.lamport} 로 순서가 있어 보임)` }, ms: 0 });
    rec.check("벡터 시계: a→h 는 인과, c 와 e 는 동시로 정확히 판정", hb(aa, hh) && !hb(cd, ee) && !hb(ee, cd));
    rec.note("교훈: Lamport 는 '전순서를 만들어 결정적으로 정렬' 할 때(분산 뮤텍스, 로그 순서), 벡터 시계는 '충돌(동시 쓰기)을 감지' 할 때 쓴다. 벡터는 프로세스 수만큼 커지므로 Dynamo 는 (노드, 카운터) 쌍을 가지치기하고, 많은 시스템은 HLC(하이브리드 논리 시계)로 벽시계에 가깝게 유지한다.");
  },
};
