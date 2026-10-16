import type { Experiment } from "./types";

export const transactionMulti: Experiment = {
  id: "transaction-multi",
  title: "MULTI/EXEC: 명령 묶음의 원자적 실행",
  category: "원자성·동시성",
  summary: "트랜잭션 큐잉, 중간에 끼어들 수 없음, 실패해도 롤백은 없다",
  notes: ["05-transactions-lua"],
  description: `
\`MULTI\` 이후의 명령은 서버에 **큐잉**되고 \`EXEC\` 시점에 한 번에, 다른 클라이언트의 명령이 끼어들지 못하게 실행된다.

중요한 차이: RDBMS 트랜잭션과 달리 **롤백이 없다**. 중간 명령이 실행 중 에러(예: 문자열에 INCR)를 내도
나머지는 그대로 실행된다. 문법 오류(큐잉 단계에서 거부)가 있으면 EXEC 전체가 거부된다.
`,
  code: `MULTI
SET balance 100
INCRBY balance 50
GET balance
EXEC          # [OK, 150, "150"]

# 런타임 에러가 있어도 롤백되지 않는다
SET str "abc"
MULTI
INCR str      # 큐잉은 된다 (QUEUED)
SET other ok
EXEC          # [ERR value is not an integer, OK]  ← other 는 저장됨`,
  async run({ redis, rec, k }) {
    const res = await redis.multi().set(k("balance"), 100).incrby(k("balance"), 50).get(k("balance")).exec();
    rec.check("EXEC 결과 3개, 마지막 GET = 150", res?.length === 3 && res[2][1] === "150", res?.map((r) => r[1]));

    rec.note("런타임 에러는 롤백되지 않는다");
    await redis.set(k("str"), "abc");
    const res2 = await redis.multi().incr(k("str")).set(k("other"), "ok").exec();
    const firstErr = res2?.[0][0];
    rec.check("첫 명령은 에러", firstErr instanceof Error, firstErr?.message);
    rec.check("두 번째 SET 은 그대로 실행됨", (await redis.get(k("other"))) === "ok");
  },
};

export const watchOptimistic: Experiment = {
  id: "watch-optimistic-lock",
  title: "WATCH: 낙관적 락 (CAS)",
  category: "원자성·동시성",
  summary: "WATCH 한 키를 다른 클라이언트가 바꾸면 EXEC 가 null 로 실패한다 — 두 커넥션으로 재현",
  notes: ["05-transactions-lua", "09-distributed-lock"],
  description: `
"읽고 → 계산하고 → 쓰기" 는 그 사이 누가 값을 바꾸면 잘못된 결과가 된다 (lost update).
\`WATCH key\` 를 걸어두면, EXEC 전에 그 키가 변경됐을 때 트랜잭션이 **아무것도 실행하지 않고 null** 을 돌려준다.
클라이언트는 이를 보고 재시도하면 된다. 이것이 Redis 의 낙관적 락(Compare-And-Set)이다.
`,
  code: `# 클라이언트 A
WATCH stock
GET stock            # 10 을 읽음 → 1 감소해야지
# 클라이언트 B 가 끼어든다
  SET stock 5
# 클라이언트 A
MULTI
SET stock 9
EXEC                 # (nil)  ← 실패! stock 은 5 그대로`,
  async run({ redis, rec, k, newClient }) {
    const a = await newClient("A");
    const b = await newClient("B");
    await redis.set(k("stock"), 10);

    await a.watch(k("stock"));
    const read = await a.get(k("stock"));
    rec.note(`A 가 읽은 값: ${read}. 이제 B 가 끼어든다`);
    await b.set(k("stock"), 5);

    const res = await a.multi().set(k("stock"), Number(read) - 1).exec();
    rec.check("A 의 EXEC 는 null (중단됨)", res === null, res);
    const final = await redis.get(k("stock"));
    rec.check("stock 은 B 가 쓴 5 그대로", final === "5", final);

    rec.note("간섭이 없으면 정상 성공");
    await a.watch(k("stock"));
    const read2 = await a.get(k("stock"));
    const res2 = await a.multi().set(k("stock"), Number(read2) - 1).exec();
    rec.check("이번엔 성공", res2 !== null && (await redis.get(k("stock"))) === "4", res2);
  },
};

export const pipelineVsSequential: Experiment = {
  id: "pipeline-vs-sequential",
  title: "Pipeline: 왕복 시간을 없애면 얼마나 빨라질까",
  category: "원자성·동시성",
  summary: "1000번 SET 을 순차 await 와 파이프라인으로 각각 실행해 시간을 비교",
  notes: ["06-pipelining"],
  description: `
Redis 명령 하나는 마이크로초 단위로 끝나지만, 클라이언트↔서버 **왕복(RTT)** 은 로컬에서도 수십 µs, 네트워크에선 ms 단위다.
파이프라인은 응답을 기다리지 않고 명령을 몰아서 보내 RTT 를 1번으로 줄인다. MULTI 와 달리 원자성은 없다.

로컬 루프백에서도 보통 **수 배 ~ 수십 배** 차이가 난다.
`,
  code: `# 순차: 1000번의 RTT
for i in 1..1000: SET k:i i   (각각 응답을 기다림)

# 파이프라인: 명령을 한 번에 보내고 응답도 한 번에 받는다
PIPELINE { SET k:1 1 ; SET k:2 2 ; ... ; SET k:1000 1000 } → EXEC

# redis-cli 로도 가능:
#   printf "SET a 1\\nSET b 2\\n" | redis-cli --pipe`,
  async run({ raw, rec, k }) {
    const N = 1000;
    rec.note(`${N}개의 SET 을 두 방식으로 실행한다 (개별 명령 로그는 생략)`);
    await rec.measure(`순차 SET x ${N}`, async () => {
      for (let i = 0; i < N; i++) await raw.set(k(`seq:${i}`), i);
      return `${N} commands, ${N} round-trips`;
    });
    await rec.measure(`파이프라인 SET x ${N}`, async () => {
      const p = raw.pipeline();
      for (let i = 0; i < N; i++) p.set(k(`pipe:${i}`), i);
      const r = await p.exec();
      return `${r?.length} replies, 1 round-trip`;
    });
    const seq = rec.steps.find((s) => s.cmd.startsWith("순차"))!;
    const pipe = rec.steps.find((s) => s.cmd.startsWith("파이프라인"))!;
    rec.note(`순차 ${seq.ms}ms vs 파이프라인 ${pipe.ms}ms → 약 ${(seq.ms / Math.max(pipe.ms, 0.01)).toFixed(1)}배 빠름`);
    rec.check("파이프라인이 더 빠르다", pipe.ms < seq.ms, { sequential: seq.ms, pipeline: pipe.ms });
  },
};

export const luaAtomic: Experiment = {
  id: "lua-atomic",
  title: "Lua 스크립트: 서버에서 원자적으로 읽고-판단하고-쓰기",
  category: "원자성·동시성",
  summary: "EVAL 로 compare-and-delete 구현, SCRIPT LOAD + EVALSHA 로 재사용",
  notes: ["05-transactions-lua"],
  description: `
Lua 스크립트는 서버에서 **단일 명령처럼 원자적으로** 실행된다. WATCH 재시도 루프 없이
"값이 X 일 때만 삭제" 같은 조건부 로직을 한 번에 처리할 수 있다.

- \`KEYS[]\` 와 \`ARGV[]\` 를 명확히 분리하자 (클러스터에서 키 라우팅에 필요).
- 스크립트가 오래 걸리면 서버 전체가 멈춘다. 반복문 남발 금지.
- \`EVALSHA\` 는 SHA1 로 캐시된 스크립트를 호출한다 (대역폭 절약).
`,
  code: `SET lock:order:1 "token-abc"

# 토큰이 일치할 때만 삭제 (분산 락 해제의 핵심)
EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      else
        return 0
      end" 1 lock:order:1 wrong-token    # 0
EVAL "..." 1 lock:order:1 token-abc       # 1

SCRIPT LOAD "return redis.call('INCRBY', KEYS[1], ARGV[1])"
EVALSHA <sha> 1 counter 5`,
  async run({ redis, rec, k }) {
    const cad = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
    await redis.set(k("lock"), "token-abc");
    const r1 = await redis.eval(cad, 1, k("lock"), "wrong-token");
    rec.check("토큰이 다르면 삭제하지 않음 (0)", r1 === 0, r1);
    const r2 = await redis.eval(cad, 1, k("lock"), "token-abc");
    rec.check("토큰이 맞으면 삭제 (1)", r2 === 1, r2);

    rec.note("스크립트 캐싱: SCRIPT LOAD → EVALSHA");
    const sha = (await redis.script("LOAD", `return redis.call('INCRBY', KEYS[1], ARGV[1])`)) as string;
    const v = await redis.evalsha(sha, 1, k("counter"), 5);
    rec.check("EVALSHA 로 5 증가", v === 5, v);
  },
};

export const distributedLock: Experiment = {
  id: "distributed-lock",
  title: "분산 락: SET NX PX + 토큰 검증 해제",
  category: "원자성·동시성",
  summary: "두 클라이언트가 같은 락을 다투고, 만료·소유자 검증까지 한 번에 확인",
  notes: ["09-distributed-lock", "05-transactions-lua"],
  description: `
단일 Redis 인스턴스 기반 락의 정석:

1. **획득**: \`SET lock <랜덤토큰> NX PX <ttl>\` — 없을 때만(NX) 만료와 함께(PX) 설정. 원자적.
2. **해제**: 내 토큰일 때만 DEL (Lua). 그냥 DEL 하면 만료 후 남이 잡은 락을 지워버릴 수 있다.
3. **TTL** 은 안전장치다. 작업이 TTL 보다 오래 걸리면 락이 풀린다 → fencing token 이 필요한 이유.
`,
  code: `# 클라이언트 A
SET lock:resource tokenA NX PX 500     # OK
# 클라이언트 B
SET lock:resource tokenB NX PX 500     # (nil) ← 실패
# B 가 그냥 DEL 하면 A 의 락을 지워버린다 → 토큰 검증 Lua 로 해제
EVAL "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end" 1 lock:resource tokenB   # 0
# A 가 해제
EVAL "..." 1 lock:resource tokenA      # 1
# 이제 B 가 획득 가능
SET lock:resource tokenB NX PX 500     # OK`,
  async run({ redis, rec, k, newClient }) {
    const a = await newClient("A");
    const b = await newClient("B");
    const release = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`;
    const lock = k("resource");

    const ga = await a.set(lock, "tokenA", "PX", 500, "NX");
    rec.check("A 획득 성공", ga === "OK", ga);
    const gb = await b.set(lock, "tokenB", "PX", 500, "NX");
    rec.check("B 획득 실패 (null)", gb === null, gb);

    const wrong = await b.eval(release, 1, lock, "tokenB");
    rec.check("B 는 남의 락을 해제할 수 없다", wrong === 0, wrong);
    const mine = await a.eval(release, 1, lock, "tokenA");
    rec.check("A 는 자기 락을 해제", mine === 1, mine);

    const gb2 = await b.set(lock, "tokenB", "PX", 500, "NX");
    rec.check("해제 후 B 획득 성공", gb2 === "OK", gb2);

    rec.note("TTL 만료 시 락은 자동으로 풀린다 (작업이 길어지면 위험한 이유)");
    await rec.measure("600ms 대기", () => rec.sleep(600));
    rec.check("만료 후 키 없음", (await redis.exists(lock)) === 0);
    void redis;
  },
};
