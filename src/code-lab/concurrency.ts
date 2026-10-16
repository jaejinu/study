import os from "node:os";
import { Worker } from "node:worker_threads";
import type { CodeExperiment } from "./types";

/**
 * 동시성 실험 — Node 의 worker_threads + SharedArrayBuffer + Atomics 로
 * 경합 조건, 스핀락 vs 뮤텍스, 데드락, CSP 채널을 실제 스레드 위에서 재현한다.
 *
 * 워커 코드는 문자열로 만들어 `new Worker(code, { eval: true })` 로 띄운다(파일 없이).
 * 메인 스레드는 Atomics.wait 를 쓰지 않는다 — 개발 서버의 이벤트 루프를 막지 않기 위해 setTimeout 폴링과 메시지로만 기다린다.
 * 모든 워커는 finally 에서 terminate 한다.
 */

type WorkerResult = Record<string, number | string | boolean>;

/** 워커 n 개를 띄우고 각자 postMessage 한 결과를 모은다. timeoutMs 안에 끝나지 않으면 전부 종료하고 실패 */
async function runWorkers(code: string, datas: Record<string, unknown>[], timeoutMs = 30_000): Promise<WorkerResult[]> {
  const workers = datas.map((d) => new Worker(code, { eval: true, workerData: d }));
  try {
    const results = await Promise.race([
      Promise.all(
        workers.map(
          (w) =>
            new Promise<WorkerResult>((resolve, reject) => {
              w.once("message", (m) => resolve(m as WorkerResult));
              w.once("error", reject);
              w.once("exit", (c) => c !== 0 && reject(new Error(`worker exit ${c}`)));
            }),
        ),
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`워커가 ${timeoutMs}ms 안에 끝나지 않음`)), timeoutMs)),
    ]);
    return results;
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => 0)));
  }
}

/** 메인 스레드에서 막지 않고 조건을 기다린다 */
async function until(cond: () => boolean, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("대기 시간 초과");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");

// ---------------------------------------------------------------- 1. 경합 조건
const RACE_WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const { sab, n, mode } = workerData;
const a = new Int32Array(sab); // [0]=카운터 [1]=시작 신호 [2]=준비된 워커 수
Atomics.add(a, 2, 1);
Atomics.wait(a, 1, 0); // 시작 신호를 기다린다 — 모든 워커가 동시에 출발하도록
const t0 = performance.now();
if (mode === "plain") { for (let i = 0; i < n; i++) a[0] = a[0] + 1; }
else if (mode === "loadstore") { for (let i = 0; i < n; i++) Atomics.store(a, 0, Atomics.load(a, 0) + 1); }
else { for (let i = 0; i < n; i++) Atomics.add(a, 0, 1); }
parentPort.postMessage({ ms: performance.now() - t0 });
`;

export const concRaceCondition: CodeExperiment = {
  id: "conc-race-condition",
  subject: "concurrency",
  title: "경합 조건: 워커 4개가 공유 카운터를 100만 번씩 올리면 얼마나 잃어버리는가",
  category: "경합",
  summary: "SharedArrayBuffer 위의 카운터를 워커 4개가 동시에 증가시킨다. 일반 read-modify-write(a[0] = a[0] + 1), 읽기·쓰기만 원자적인 Atomics.load + Atomics.store, 그리고 Atomics.add 세 방식을 같은 출발선(시작 신호)에서 비교해 잃어버린 갱신 수와 처리 시간을 잰다",
  notes: ["02-race-conditions-critical-sections", "04-atomics-cas-lock-free", "01-concurrency-vs-parallelism"],
  description: `
**경합 조건**은 결과가 스레드 실행 순서에 따라 달라지는 버그다. 가장 흔한 형태가 read-modify-write: 두 스레드가 같은 값 7을 읽고, 둘 다 8을 쓰면 증가 하나가 사라진다.
이 실험은 진짜 OS 스레드(worker_threads) 4개가 **같은 메모리**(SharedArrayBuffer)를 두드리게 한다. 워커들이 준비되면 메인 스레드가 시작 신호를 한 번에 풀어, 겹쳐 실행되도록 만든다.
세 방식을 비교한다.
- 일반 대입: 원자성도, 순서 보장도 없다.
- Atomics.load + Atomics.store: 읽기와 쓰기 **각각**은 원자적이지만 그 사이에 끼어들 수 있다 — "원자 연산 두 개 ≠ 원자적 연산 하나".
- Atomics.add: 하드웨어의 원자적 증가(lock xadd · ldadd)로 읽기-수정-쓰기 전체가 한 번에 일어난다.
`,
  code: `// 워커 4개 × 1,000,000회
a[0] = a[0] + 1;                                   // 잃어버린 갱신 발생
Atomics.store(a, 0, Atomics.load(a, 0) + 1);       // 여전히 잃음 (사이에 끼어듦)
Atomics.add(a, 0, 1);                              // 정확히 4,000,000`,
  async run({ rec }) {
    const W = 4;
    const N = 1_000_000;
    const expected = W * N;
    rec.note(`워커 ${W}개 × ${fmt(N)}회 = 기대값 ${fmt(expected)} · CPU 코어 ${os.cpus().length}개`);
    const rows: { mode: string; final: number; lost: number; lostPct: string; ms: number }[] = [];
    for (const mode of ["plain", "loadstore", "atomic"] as const) {
      const sab = new SharedArrayBuffer(16);
      const a = new Int32Array(sab);
      const t0 = performance.now();
      const done = runWorkers(RACE_WORKER, Array.from({ length: W }, () => ({ sab, n: N, mode })));
      await until(() => Atomics.load(a, 2) === W);
      Atomics.store(a, 1, 1);
      Atomics.notify(a, 1);
      const res = await done;
      const ms = Math.round(performance.now() - t0);
      const final = Atomics.load(a, 0);
      rows.push({ mode, final, lost: expected - final, lostPct: `${(((expected - final) / expected) * 100).toFixed(1)}%`, ms });
      rec.steps.push({ cmd: `${mode === "plain" ? "a[0] = a[0] + 1" : mode === "loadstore" ? "Atomics.store(a, 0, Atomics.load(a, 0) + 1)" : "Atomics.add(a, 0, 1)"} × ${W} 워커`, result: { 최종값: fmt(final), 잃어버린_갱신: fmt(expected - final), 워커별_ms: res.map((r) => Math.round(Number(r.ms))) }, ms });
    }
    rec.steps.push({ cmd: "요약 (방식 · 최종값 · 잃어버린 갱신 · 비율 · 전체 ms)", result: rows.map((r) => `${r.mode.padEnd(9)} ${fmt(r.final).padStart(10)}  잃음 ${fmt(r.lost).padStart(10)} (${r.lostPct})  ${r.ms}ms`), ms: 0 });
    const [plain, ls, atomic] = rows;
    rec.check("일반 read-modify-write 는 갱신을 잃어버린다", plain.lost > 0, `${fmt(plain.lost)}개 (${plain.lostPct})`);
    rec.check("load·store 가 각각 원자적이어도 그 사이에 끼어들어 여전히 잃는다", ls.lost > 0, `${fmt(ls.lost)}개`);
    rec.check("Atomics.add 는 정확히 기대값", atomic.final === expected, fmt(atomic.final));
    rec.note(`원자적 증가는 정확하지만 공짜가 아니다: 같은 캐시 라인을 코어들이 서로 빼앗으며(캐시 라인 핑퐁) ${atomic.ms}ms 걸렸다. 진짜 해법은 공유를 줄이는 것 — 워커마다 지역 카운터를 두고 마지막에 한 번 합치면 경합 자체가 사라진다.`);
  },
};

// ---------------------------------------------------------------- 2. 스핀락 vs 뮤텍스
const LOCK_WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const { sab, ops, kind, work } = workerData;
const a = new Int32Array(sab); // [0]=락 [1]=보호되는 카운터 [2]=준비 수 [3]=시작 신호 [4]=futex 대기 횟수 합
Atomics.add(a, 2, 1);
Atomics.wait(a, 3, 0);
let spins = 0, waits = 0;
function spinLock() { while (Atomics.compareExchange(a, 0, 0, 1) !== 0) spins++; }
function spinUnlock() { Atomics.store(a, 0, 0); }
// Drepper 의 futex 뮤텍스: 0=풀림 1=잠김(대기자 없음) 2=잠김(대기자 있을 수 있음)
function mutexLock() {
  let c = Atomics.compareExchange(a, 0, 0, 1);
  if (c === 0) return;
  if (c !== 2) c = Atomics.exchange(a, 0, 2);
  while (c !== 0) { waits++; Atomics.wait(a, 0, 2); c = Atomics.exchange(a, 0, 2); }
}
function mutexUnlock() { if (Atomics.sub(a, 0, 1) !== 1) { Atomics.store(a, 0, 0); Atomics.notify(a, 0, 1); } }
const lock = kind === "spin" ? spinLock : mutexLock;
const unlock = kind === "spin" ? spinUnlock : mutexUnlock;
let x = 0;
const t0 = performance.now();
for (let i = 0; i < ops; i++) {
  lock();
  a[1] = a[1] + 1;                       // 임계 구역: 락이 지켜 주므로 일반 대입이어도 안전
  for (let j = 0; j < work; j++) x += j;  // 임계 구역 안의 작은 일
  unlock();
}
Atomics.add(a, 4, waits);
parentPort.postMessage({ ms: performance.now() - t0, spins, waits, x });
`;

export const concCasSpinlock: CodeExperiment = {
  id: "conc-cas-spinlock",
  subject: "concurrency",
  title: "스핀락 vs 뮤텍스: CAS 로 도는 락과 잠드는 락은 경합이 심해질 때 어떻게 다른가",
  category: "락",
  summary: "Atomics.compareExchange 로 만든 스핀락과 Atomics.wait/notify(futex) 로 만든 뮤텍스를 워커 수 = 코어 수, 코어 수 × 2 두 조건에서 비교한다. 보호되는 카운터가 정확한지, 처리량, 그리고 프로세스 CPU 시간(헛돌며 태운 CPU)을 잰다",
  notes: ["03-locks-semaphores-monitors", "04-atomics-cas-lock-free"],
  description: `
락을 얻지 못한 스레드가 할 수 있는 일은 둘이다. **계속 확인하며 돌거나(spin)**, **커널에 재워 달라고 하거나(block)**.
- 스핀락: 임계 구역이 아주 짧고, 기다리는 스레드가 자기 코어를 갖고 있으면 가장 빠르다. 컨텍스트 스위치가 없기 때문이다. 하지만 스레드가 코어보다 많으면 락을 쥔 스레드가 선점된 동안 다른 스레드들이 CPU 를 헛되이 태운다.
- 뮤텍스(futex): 경합이 없으면 CAS 한 번으로 끝나고(사용자 공간), 경합할 때만 커널에 들어가 잠든다. Linux 의 pthread_mutex, Java 의 ReentrantLock(파킹) 이 이 구조다.
이 실험의 뮤텍스는 Ulrich Drepper 의 "Futexes Are Tricky" 3단계 상태(0 풀림 · 1 잠김 · 2 잠김+대기자)를 그대로 옮겼다.
`,
  code: `// 스핀락
while (Atomics.compareExchange(a, 0, 0, 1) !== 0) {}   // 돈다
Atomics.store(a, 0, 0);
// futex 뮤텍스 (0=풀림 1=잠김 2=잠김+대기자)
let c = Atomics.compareExchange(a, 0, 0, 1);
if (c !== 0) { if (c !== 2) c = Atomics.exchange(a, 0, 2);
  while (c !== 0) { Atomics.wait(a, 0, 2); c = Atomics.exchange(a, 0, 2); } }
// 해제
if (Atomics.sub(a, 0, 1) !== 1) { Atomics.store(a, 0, 0); Atomics.notify(a, 0, 1); }`,
  async run({ rec }) {
    const cores = os.cpus().length;
    const OPS = 100_000;
    const WORK = 30;
    const rows: string[] = [];
    const results: { kind: string; w: number; opsPerSec: number; cpuMs: number; wallMs: number; correct: boolean; waits: number }[] = [];
    for (const w of [cores, cores * 2]) {
      for (const kind of ["spin", "mutex"] as const) {
        const sab = new SharedArrayBuffer(32);
        const a = new Int32Array(sab);
        const cpu0 = process.cpuUsage();
        const t0 = performance.now();
        const done = runWorkers(LOCK_WORKER, Array.from({ length: w }, () => ({ sab, ops: OPS, kind, work: WORK })), 120_000);
        await until(() => Atomics.load(a, 2) === w, 20_000);
        Atomics.store(a, 3, 1);
        Atomics.notify(a, 3);
        await done;
        const wallMs = performance.now() - t0;
        const cpu = process.cpuUsage(cpu0);
        const cpuMs = (cpu.user + cpu.system) / 1000;
        const total = w * OPS;
        const correct = Atomics.load(a, 1) === total;
        const opsPerSec = total / (wallMs / 1000);
        const waits = Atomics.load(a, 4);
        results.push({ kind, w, opsPerSec, cpuMs, wallMs, correct, waits });
        rows.push(`${kind === "spin" ? "스핀락" : "뮤텍스"} · 워커 ${String(w).padStart(2)}  처리량 ${fmt(Math.round(opsPerSec)).padStart(10)} ops/s  벽시계 ${Math.round(wallMs)}ms  CPU ${Math.round(cpuMs)}ms (×${(cpuMs / wallMs).toFixed(1)})  잠든 횟수 ${fmt(waits)}  카운터 ${correct ? "정확" : "틀림"}`);
      }
    }
    rec.steps.push({ cmd: `락 종류 × 워커 수 (코어 ${cores}개, 워커당 ${fmt(OPS)}회, 임계 구역 안 작은 일 ${WORK}회)`, result: rows, ms: 0 });
    rec.check("두 락 모두 보호되는 카운터가 정확하다 (상호 배제 성립)", results.every((r) => r.correct));
    const spinOver = results.find((r) => r.kind === "spin" && r.w === cores * 2)!;
    const mutexOver = results.find((r) => r.kind === "mutex" && r.w === cores * 2)!;
    rec.check("뮤텍스는 경합 시 실제로 잠든다 (futex 대기 > 0)", results.filter((r) => r.kind === "mutex").some((r) => r.waits > 0), String(mutexOver.waits));
    rec.note(`코어보다 워커가 많을 때(×2): 스핀락 CPU ${Math.round(spinOver.cpuMs)}ms / 벽시계 ${Math.round(spinOver.wallMs)}ms, 뮤텍스 CPU ${Math.round(mutexOver.cpuMs)}ms / 벽시계 ${Math.round(mutexOver.wallMs)}ms. 'CPU ÷ 벽시계' 가 클수록 여러 코어가 동시에 바빴다는 뜻 — 스핀락은 기다리는 동안에도 코어를 태운다.`);
    rec.note("결론은 상황에 따라 갈린다: 임계 구역이 짧고 스레드 ≤ 코어면 스핀이 빠를 수 있고, 과구독·긴 임계 구역이면 잠드는 락이 시스템 전체에 친절하다. 실제 라이브러리는 '조금 돌다가 잠드는' 적응형 락(adaptive mutex)을 쓴다.");
  },
};

// ---------------------------------------------------------------- 3. 데드락
const DEADLOCK_WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const { sab, first, second, holdMs, timeoutMs, name } = workerData;
const a = new Int32Array(sab); // [0]=락 A [1]=락 B [2]=준비 수 [3]=시작 신호 [4]=수면용
function tryAcquire(i, timeout) {
  const deadline = Date.now() + timeout;
  while (Atomics.compareExchange(a, i, 0, 1) !== 0) {
    if (Date.now() > deadline) return false;
    Atomics.wait(a, i, 1, 5); // 풀릴 때까지 최대 5ms 씩 잠든다
  }
  return true;
}
function release(i) { Atomics.store(a, i, 0); Atomics.notify(a, i); }
Atomics.add(a, 2, 1);
Atomics.wait(a, 3, 0);
const t0 = Date.now();
tryAcquire(first, 10000);
Atomics.wait(a, 4, 0, holdMs); // 첫 락을 쥔 채 잠깐 다른 일 — 상대도 자기 첫 락을 잡을 시간을 준다
const got = tryAcquire(second, timeoutMs);
if (got) release(second);
release(first);
parentPort.postMessage({ name, holds: first, wants: second, got, ms: Date.now() - t0 });
`;

export const concDeadlock: CodeExperiment = {
  id: "conc-deadlock",
  subject: "concurrency",
  title: "데드락: 두 락을 반대 순서로 잡으면 서로를 영원히 기다린다 — 타임아웃으로 감지하고 락 순서로 없앤다",
  category: "데드락",
  summary: "워커 1은 A→B, 워커 2는 B→A 순서로 락을 잡는다. 둘 다 첫 락을 쥔 채 두 번째 락을 기다리는 순환 대기를 타임아웃(500ms)으로 감지하고 대기 그래프를 출력한 뒤, 전역 락 순서(항상 A→B) 규칙으로 바꾸면 둘 다 끝나는 것을 확인한다",
  notes: ["06-deadlock-livelock-starvation", "03-locks-semaphores-monitors"],
  description: `
데드락의 네 조건(코프먼 조건): **상호 배제**, **점유와 대기**(락을 쥔 채 다른 락을 기다림), **비선점**(남이 쥔 락을 빼앗을 수 없음), **순환 대기**. 넷이 모두 성립해야 데드락이고, 하나만 깨면 사라진다.
가장 실용적인 해법은 **순환 대기를 깨는 것** — 모든 코드가 락을 같은 전역 순서로 잡으면 순환이 생길 수 없다. 데이터베이스는 대신 **대기 그래프에서 순환을 찾아 한 쪽을 희생**시킨다(PostgreSQL 의 deadlock_timeout 후 검사).
실제 블로킹 락이면 이 실험은 영원히 멈춘다. 그래서 두 번째 락은 타임아웃이 있는 시도(tryLock(timeout))로 잡고, 실패를 데드락 신호로 쓴다.
`,
  code: `// 워커 1: lock(A); …; lock(B)    워커 2: lock(B); …; lock(A)
// → 1 은 A 를 쥐고 B 를, 2 는 B 를 쥐고 A 를 기다린다 (순환)
// 해법: 전역 락 순서 — 모두 lock(A) → lock(B)
// Java: tryLock(500, MILLISECONDS) · PostgreSQL: deadlock_timeout · Go: runtime "all goroutines are asleep"`,
  async run({ rec }) {
    const run = async (label: string, pairs: [number, number][]) => {
      const sab = new SharedArrayBuffer(32);
      const a = new Int32Array(sab);
      const done = runWorkers(
        DEADLOCK_WORKER,
        pairs.map(([first, second], i) => ({ sab, first, second, holdMs: 50, timeoutMs: 500, name: `워커 ${i + 1}` })),
      );
      await until(() => Atomics.load(a, 2) === pairs.length);
      Atomics.store(a, 3, 1);
      Atomics.notify(a, 3);
      const res = await done;
      const L = ["A", "B"];
      rec.steps.push({ cmd: label, result: res.map((r) => `${r.name}: ${L[Number(r.holds)]} 보유 → ${L[Number(r.wants)]} 요청 → ${r.got ? "획득" : "타임아웃"} (${r.ms}ms)`), ms: 0 });
      return res;
    };
    const dead = await run("반대 순서: 워커 1 = A→B, 워커 2 = B→A", [
      [0, 1],
      [1, 0],
    ]);
    const timeouts = dead.filter((r) => !r.got);
    rec.check("적어도 한 워커가 두 번째 락을 얻지 못하고 타임아웃 (데드락 감지)", timeouts.length >= 1, `${timeouts.length}개`);
    if (timeouts.length === 2) rec.note("대기 그래프: 워커 1 —(B 를 기다림)→ 워커 2 —(A 를 기다림)→ 워커 1. 순환이 있으므로 데드락. 블로킹 락이었다면 둘 다 영원히 멈췄다.");
    else rec.note("한 워커만 타임아웃했다면 그 워커가 첫 락을 풀어 준 덕에 다른 쪽이 진행한 것 — DB 가 '희생자' 하나를 고르는 방식과 같다.");
    const ordered = await run("전역 락 순서: 둘 다 A→B", [
      [0, 1],
      [0, 1],
    ]);
    rec.check("락 순서를 통일하면 두 워커 모두 두 락을 얻는다 (순환 대기 제거)", ordered.every((r) => r.got));
    rec.note("교훈: 데드락은 '운 나쁜 타이밍' 이 아니라 설계 문제다. 락 순서 규칙(주소·id 순), 한 번에 하나의 락만, tryLock + 백오프, 또는 락 대신 메시지 전달(액터·채널)로 순환 대기를 없앤다.");
  },
};

// ---------------------------------------------------------------- 4. 채널(CSP)
const CHANNEL_WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const { hdrSab, dataSab, cap, m, role } = workerData;
const h = new Int32Array(hdrSab);   // [0]=head(읽은 개수) [1]=tail(쓴 개수) [2]=준비 수 [3]=시작 신호
const d = new Int32Array(dataSab);
Atomics.add(h, 2, 1);
Atomics.wait(h, 3, 0);
const t0 = performance.now();
let waits = 0;
if (role === "producer") {
  for (let i = 0; i < m; i++) {
    const tail = Atomics.load(h, 1);
    let head = Atomics.load(h, 0);
    while (tail - head === cap) { waits++; Atomics.wait(h, 0, head, 20); head = Atomics.load(h, 0); } // 가득 참 → 백프레셔
    d[tail % cap] = i;
    Atomics.store(h, 1, tail + 1);
    Atomics.notify(h, 1);
  }
  parentPort.postMessage({ role, ms: performance.now() - t0, waits });
} else {
  let sum = 0;
  for (let i = 0; i < m; i++) {
    const head = Atomics.load(h, 0);
    let tail = Atomics.load(h, 1);
    while (tail === head) { waits++; Atomics.wait(h, 1, tail, 20); tail = Atomics.load(h, 1); } // 비어 있음 → 기다림
    sum += d[head % cap];
    Atomics.store(h, 0, head + 1);
    Atomics.notify(h, 0);
  }
  parentPort.postMessage({ role, ms: performance.now() - t0, waits, sum });
}
`;

export const concChannelCsp: CodeExperiment = {
  id: "conc-channel-csp",
  subject: "concurrency",
  title: "CSP 채널: 유한 버퍼 채널로 생산자·소비자를 잇고, 버퍼 크기가 처리량과 백프레셔를 어떻게 바꾸는지 잰다",
  category: "메시지 전달",
  summary: "SharedArrayBuffer 링 버퍼로 단일 생산자·단일 소비자 유한 채널을 만들고(Go 의 make(chan int, n) 흉내), 메시지 10만 개를 버퍼 1·16·1024 로 보낸다. 합계로 유실·중복이 없는지 확인하고, 처리량과 생산자가 가득 찬 채널 때문에 기다린 횟수(백프레셔)를 비교한다",
  notes: ["07-actors-csp-structured-concurrency", "04-atomics-cas-lock-free"],
  description: `
"메모리를 공유해서 통신하지 말고, 통신해서 메모리를 공유하라" (Go 속담). CSP 는 스레드들이 공유 변수 대신 **채널**로 값을 주고받게 해 락을 코드에서 지운다.
유한 채널(bounded channel)은 동시에 **백프레셔** 장치다. 가득 차면 생산자가 멈추므로, 느린 소비자가 메모리 폭증 없이 전체 속도를 정한다.
이 실험의 채널은 head(읽은 수)·tail(쓴 수) 두 카운터와 데이터 배열로 된 SPSC 링 버퍼다. 생산자만 tail 을, 소비자만 head 를 쓰므로 락이 필요 없다(lock-free). 비었거나 가득 차면 Atomics.wait 로 잠든다.
버퍼 1 은 매 메시지마다 두 스레드가 서로를 깨우는 핑퐁(동기 채널에 가깝다), 버퍼가 크면 묶음으로 흐른다.
`,
  code: `// Go 로 쓰면
ch := make(chan int, 16)
go func() { for i := 0; i < 100000; i++ { ch <- i }; close(ch) }()
for v := range ch { sum += v }
// 여기선 SharedArrayBuffer 링 버퍼: tail-head == cap 이면 생산자 대기, tail == head 면 소비자 대기`,
  async run({ rec }) {
    const M = 100_000;
    const expectedSum = (M * (M - 1)) / 2;
    const rows: string[] = [];
    const out: { cap: number; perSec: number; pWaits: number; ok: boolean }[] = [];
    for (const cap of [1, 16, 1024]) {
      const hdrSab = new SharedArrayBuffer(16);
      const dataSab = new SharedArrayBuffer(cap * 4);
      const h = new Int32Array(hdrSab);
      const t0 = performance.now();
      const done = runWorkers(CHANNEL_WORKER, [
        { hdrSab, dataSab, cap, m: M, role: "producer" },
        { hdrSab, dataSab, cap, m: M, role: "consumer" },
      ], 120_000);
      await until(() => Atomics.load(h, 2) === 2);
      Atomics.store(h, 3, 1);
      Atomics.notify(h, 3);
      const [p, c] = await done;
      const ms = performance.now() - t0;
      const ok = Number(c.sum) === expectedSum;
      const perSec = M / (ms / 1000);
      out.push({ cap, perSec, pWaits: Number(p.waits), ok });
      rows.push(`버퍼 ${String(cap).padStart(4)}  처리량 ${fmt(Math.round(perSec)).padStart(10)} msg/s  ${Math.round(ms)}ms  생산자 대기 ${fmt(Number(p.waits))}회 · 소비자 대기 ${fmt(Number(c.waits))}회  합계 ${ok ? "정확" : "틀림"}`);
    }
    rec.steps.push({ cmd: `SPSC 유한 채널로 메시지 ${fmt(M)}개 전송 (버퍼 크기별)`, result: rows, ms: 0 });
    rec.check("모든 버퍼 크기에서 합계가 정확하다 — 유실·중복 없음", out.every((o) => o.ok));
    const one = out[0];
    const big = out[2];
    rec.check("버퍼 1 은 생산자가 거의 매번 막힌다 (백프레셔가 가장 강함)", one.pWaits > big.pWaits, `${fmt(one.pWaits)} vs ${fmt(big.pWaits)}`);
    rec.note(`버퍼를 1 → 1024 로 키우니 처리량이 ${(big.perSec / one.perSec).toFixed(1)}배. 버퍼가 클수록 스레드 간 깨우기(컨텍스트 스위치) 횟수가 줄어서다. 그러나 버퍼는 지연을 숨기는 큐이기도 하다 — 너무 크면 소비자가 느려진 것을 늦게 알아챈다(버퍼블로트와 같은 원리).`);
  },
};
