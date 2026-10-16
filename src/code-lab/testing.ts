import fc from "fast-check";
import Redis from "ioredis";
import type { CodeExperiment } from "./types";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 속성 기반 테스트: 레이트리미터
/** 원자적 고정 윈도우: INCR 한 번으로 판정 (Lua 로 INCR + 첫 요청이면 만료 설정) */
const FIXED_WINDOW_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
if n <= tonumber(ARGV[1]) then return 1 else return 0 end`;

type Limiter = (r: Redis, key: string, limit: number) => Promise<boolean>;

const atomicLimiter: Limiter = async (r, key, limit) => (await r.eval(FIXED_WINDOW_LUA, 1, key, limit, 10_000)) === 1;

/** 버그: 읽고(GET) 판단하고 쓴다(SET) — 그 사이에 다른 요청이 끼어든다 */
const racyLimiter: Limiter = async (r, key, limit) => {
  const cur = Number((await r.get(key)) ?? 0);
  if (cur >= limit) return false;
  await r.set(key, cur + 1, "PX", 10_000);
  return true;
};

/** 요청 묶음(burst)을 차례로 보낸다. 묶음 안의 요청은 동시에 날아간다 */
async function runBursts(r: Redis, limiter: Limiter, key: string, limit: number, bursts: number[]): Promise<number> {
  let allowed = 0;
  for (const size of bursts) {
    const res = await Promise.all(Array.from({ length: size }, () => limiter(r, key, limit)));
    allowed += res.filter(Boolean).length;
  }
  return allowed;
}

export const testPropertyRatelimit: CodeExperiment = {
  id: "test-property-ratelimit",
  subject: "testing",
  title: "속성 기반 테스트: '어떤 요청 순서든 창당 허용 ≤ N' 을 fast-check 로 수백 가지 입력에 검사하고, 경쟁 조건 버그의 최소 반례를 찾게 한다",
  category: "속성 기반",
  summary: "Redis 고정 윈도우 레이트리미터 두 구현(원자적 Lua INCR, 비원자 GET→SET)에 같은 속성을 fast-check 로 검사한다. 원자 구현은 모든 무작위 입력을 통과하고, 비원자 구현은 반례를 찾은 뒤 축소(shrinking)해 '한도 1 에 동시 요청 2개' 같은 최소 재현 사례까지 줄여 준다",
  notes: ["05-property-based-testing", "02-unit-test-design"],
  description: `
예시 기반 테스트는 **내가 떠올린 입력**만 검사한다. 속성 기반 테스트는 "**모든** 입력에 대해 참이어야 하는 성질(속성)" 을 적고, 도구가 입력을 수백 개 생성해 반례를 찾는다. 반례를 찾으면 **축소(shrinking)** 해서 가장 작은 재현 입력을 돌려준다 — 디버깅이 바로 시작된다.
레이트리미터의 속성: *한도 N, 한 창 안에서 어떤 요청 묶음 순서로 보내든 허용된 요청 수 ≤ N*. 생성기: N ∈ [1,10], 묶음 크기 배열 ∈ [1,15]^(1..6) (묶음 안은 동시 요청).
비원자 구현은 단일 스레드 테스트로는 영원히 통과한다. 동시 요청이 섞여야 터진다 — 사람이 예시로 떠올리기 어려운 입력을 생성기가 대신 떠올린다.
`,
  code: `fc.assert(fc.asyncProperty(
  fc.integer({ min: 1, max: 10 }),                                        // 한도 N
  fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 6 }), // 동시 요청 묶음들
  async (limit, bursts) => (await runBursts(limiter, freshKey(), limit, bursts)) <= limit
), { numRuns: 100 })
// 원자 구현: INCR 한 번으로 판정 (Lua)    → 통과
// 비원자 구현: GET → 판단 → SET            → 반례 { limit: 1, bursts: [2] } 로 축소`,
  requires: async () => {
    const r = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 0 });
    try {
      await r.connect();
      await r.ping();
      return null;
    } catch {
      return "Redis(6379) 에 연결할 수 없습니다: pnpm redis:docker";
    } finally {
      r.disconnect();
    }
  },
  async run({ rec, k }) {
    const r = new Redis(REDIS_URL);
    let n = 0;
    const freshKey = () => k(`rl:${n++}`);
    const prop = (limiter: Limiter) =>
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 6 }), async (limit, bursts) => (await runBursts(r, limiter, freshKey(), limit, bursts)) <= limit);
    try {
      let good!: fc.RunDetails<[number, number[]]>;
      await rec.measure("원자 구현(Lua INCR) — 무작위 입력 200개", async () => {
        good = await fc.check(prop(atomicLimiter), { numRuns: 200, seed: 42 });
        return { 실패: good.failed, 실행: good.numRuns, seed: good.seed };
      });
      rec.check("원자 구현은 생성된 모든 입력에서 속성을 지킨다", !good.failed);

      let bad!: fc.RunDetails<[number, number[]]>;
      await rec.measure("비원자 구현(GET → SET) — 같은 속성", async () => {
        bad = await fc.check(prop(racyLimiter), { numRuns: 200, seed: 42 });
        return { 실패: bad.failed };
      });
      const ce = bad.counterexample as [number, number[]] | null;
      rec.steps.push({
        cmd: "fast-check 가 찾은 반례 (축소 후)",
        result: { 실패: bad.failed, "실패까지 실행 수": bad.numRuns, "축소 횟수": bad.numShrinks, 반례: ce ? { limit: ce[0], bursts: ce[1] } : null, "재현용 seed·path": { seed: bad.seed, path: bad.counterexamplePath } },
        ms: 0,
      });
      rec.check("비원자 구현의 반례를 찾았다", bad.failed && !!ce);
      rec.check("반례가 '동시 요청 2개 이상' 으로 축소됐다 (경쟁 조건이 원인임을 가리킨다)", !!ce && Math.max(...ce[1]) >= 2 && ce[1].length <= 2, ce);
      if (ce) {
        const allowed = await runBursts(r, racyLimiter, freshKey(), ce[0], ce[1]);
        rec.steps.push({ cmd: `반례 재현: limit=${ce[0]}, bursts=${JSON.stringify(ce[1])}`, result: `허용 ${allowed}건 (> ${ce[0]})`, ms: 0 });
        rec.note("원인: 동시 요청들이 모두 같은 옛 값을 GET 하고 각자 '아직 여유 있음' 이라 판단한 뒤 SET 한다. 해결은 판정과 증가를 하나의 원자 연산으로(INCR, Lua, MULTI+WATCH) — Redis 노트의 레이트리밋 실험과 같은 결론.");
      }
      // 예시 기반 테스트가 놓치는 이유
      const seqOnly = await runBursts(r, racyLimiter, freshKey(), 3, [1, 1, 1, 1, 1]);
      rec.steps.push({ cmd: "예시 기반 테스트: limit=3 에 순차 요청 5개 (흔히 쓰는 단위 테스트)", result: `허용 ${seqOnly}건 — 통과. 버그를 못 잡는다`, ms: 0 });
      rec.check("순차 예시 테스트는 비원자 구현도 통과시킨다 (그래서 속성 테스트가 필요)", seqOnly === 3);
    } finally {
      const keys = await r.keys(k("rl:*"));
      if (keys.length) await r.del(...keys);
      r.disconnect();
    }
  },
};

// ------------------------------------------------------------------ 뮤테이션 테스트 (미니)
/** 테스트 대상: 무료 배송 규칙. 회원은 3만 원 이상, 비회원은 5만 원 이상이면 무료, 아니면 3,000원 */
const FEE_SRC = `function shippingFee(total, isMember) {
  if (isMember && total >= 30000) return 0;
  if (total >= 50000) return 0;
  return 3000;
}`;

type Fee = (total: number, isMember: boolean) => number;
type Case = [number, boolean, number];

const WEAK_SUITE: Case[] = [
  [60000, false, 0],
  [10000, false, 3000],
  [40000, true, 0],
];
const STRONG_SUITE: Case[] = [
  ...WEAK_SUITE,
  [30000, true, 0], // 경계: 회원 정확히 3만
  [29999, true, 3000],
  [50000, false, 0], // 경계: 비회원 정확히 5만
  [49999, false, 3000],
  [40000, false, 3000], // 회원 조건이 실제로 쓰이는지
];

/** 각 돌연변이: 원본 코드에서 한 군데를 바꾼다 (Stryker 의 연산자들과 같은 종류) */
const MUTANTS: { name: string; from: string; to: string }[] = [
  { name: "경계: >= 30000 → > 30000", from: "total >= 30000", to: "total > 30000" },
  { name: "경계: >= 50000 → > 50000", from: "total >= 50000", to: "total > 50000" },
  { name: "논리: && → ||", from: "isMember && total", to: "isMember || total" },
  { name: "상수: 30000 → 3000", from: ">= 30000", to: ">= 3000" },
  { name: "조건 제거: isMember && 삭제", from: "isMember && total >= 30000", to: "total >= 30000" },
  { name: "반환값: return 3000 → return 0", from: "return 3000", to: "return 0" },
  { name: "부정: >= 50000 → < 50000", from: "total >= 50000", to: "total < 50000" },
  { name: "반환값: 첫 return 0 → return 3000", from: "30000) return 0", to: "30000) return 3000" },
];

function compile(src: string, hits?: number[]): Fee {
  // 커버리지 계측: 각 return 앞에 hit(i) 를 끼워 넣는다
  let i = 0;
  const instrumented = hits ? src.replace(/return /g, () => `{ __hit(${i++}); return `).replace(/return ([^;]+);/g, "return $1; }") : src;
  const factory = new Function("__hit", `${instrumented}; return shippingFee;`) as (hit: (n: number) => void) => Fee;
  return factory((n) => {
    if (hits) hits[n] = (hits[n] ?? 0) + 1;
  });
}

function runSuite(fn: Fee, suite: Case[]): { passed: number; failed: number } {
  let failed = 0;
  for (const [t, m, want] of suite) if (fn(t, m) !== want) failed++;
  return { passed: suite.length - failed, failed };
}

export const testMutationMini: CodeExperiment = {
  id: "test-mutation-mini",
  subject: "testing",
  title: "뮤테이션 테스트: 커버리지 100% 인 테스트가 돌연변이 코드를 절반도 못 잡는 것을 보고, 경계 테스트로 돌연변이를 전부 죽인다",
  category: "뮤테이션",
  summary: "무료 배송 함수에 대해 return 문 커버리지 100% 인 '약한' 테스트 3개와 경계값을 더한 '강한' 테스트 8개를 만들고, 연산자·경계·상수·논리를 뒤집은 돌연변이 8개를 실행한다. 약한 테스트의 뮤테이션 점수와 살아남은 돌연변이 목록이 '테스트가 무엇을 안 보고 있는지' 를 정확히 가리킨다",
  notes: ["07-mutation-testing-cost", "02-unit-test-design"],
  description: `
**커버리지는 "실행됐다" 이지 "검증됐다" 가 아니다.** 모든 줄을 지나가도 결과를 제대로 단언하지 않으면 버그가 숨어든다.
**뮤테이션 테스트**는 코드에 작은 버그(돌연변이)를 일부러 넣고 테스트를 돌린다. 테스트가 실패하면 돌연변이를 *죽인* 것, 통과하면 돌연변이가 *살아남은* 것 — 즉 그 버그를 테스트가 못 잡는다는 증거다. **뮤테이션 점수 = 죽인 수 / 전체**.
이 실험은 Stryker 같은 도구가 하는 일을 코드 몇십 줄로 재현한다: 원본 소스 문자열을 바꿔 \`new Function\` 으로 컴파일하고 테스트 묶음을 돌린다. 살아남은 돌연변이는 대부분 **경계값**(>= vs >)과 **조건의 일부**(&& 의 한쪽)를 안 본 테스트에서 나온다.
`,
  code: `${FEE_SRC}

// 약한 테스트 (모든 return 문을 실행 → 커버리지 100%)
expect(shippingFee(60000, false)).toBe(0)
expect(shippingFee(10000, false)).toBe(3000)
expect(shippingFee(40000, true)).toBe(0)

// 돌연변이 예: total >= 30000 → total > 30000  — 위 테스트는 모두 통과한다 (살아남음)
// 강한 테스트: 경계 30000/29999, 50000/49999, 비회원 40000 추가 → 돌연변이 전부 죽음`,
  async run({ rec }) {
    const hits: number[] = [];
    const original = compile(FEE_SRC, hits);
    const weak = runSuite(original, WEAK_SUITE);
    const coverage = hits.filter((h) => h > 0).length;
    rec.steps.push({ cmd: "원본 + 약한 테스트 3개", result: { 통과: `${weak.passed}/${WEAK_SUITE.length}`, "return 문 커버리지": `${coverage}/3 (${Math.round((coverage / 3) * 100)}%)` }, ms: 0 });
    rec.check("원본은 약한 테스트를 모두 통과하고 return 문 커버리지가 100%", weak.failed === 0 && coverage === 3);
    rec.check("원본은 강한 테스트도 모두 통과한다", runSuite(original, STRONG_SUITE).failed === 0);

    const rows: Record<string, string>[] = [];
    let weakKilled = 0;
    let strongKilled = 0;
    for (const m of MUTANTS) {
      if (!FEE_SRC.includes(m.from)) throw new Error(`돌연변이 패턴 없음: ${m.from}`);
      const mutant = compile(FEE_SRC.replace(m.from, m.to));
      const w = runSuite(mutant, WEAK_SUITE);
      const s = runSuite(mutant, STRONG_SUITE);
      if (w.failed) weakKilled++;
      if (s.failed) strongKilled++;
      rows.push({ 돌연변이: m.name, "약한 테스트": w.failed ? `죽음 (${w.failed}개 실패)` : "살아남음 ⚠", "강한 테스트": s.failed ? `죽음 (${s.failed}개 실패)` : "살아남음 ⚠" });
    }
    rec.steps.push({ cmd: `돌연변이 ${MUTANTS.length}개 실행`, result: rows, ms: 0 });
    const weakScore = weakKilled / MUTANTS.length;
    const strongScore = strongKilled / MUTANTS.length;
    rec.steps.push({ cmd: "뮤테이션 점수", result: { "약한 테스트(커버리지 100%)": `${Math.round(weakScore * 100)}%`, "강한 테스트(경계값 추가)": `${Math.round(strongScore * 100)}%` }, ms: 0 });
    rec.check("커버리지 100% 인 약한 테스트가 돌연변이를 절반 넘게 놓친다", weakScore < 0.5, `${weakKilled}/${MUTANTS.length}`);
    rec.check("경계값 테스트를 더하면 돌연변이를 모두 죽인다", strongScore === 1, `${strongKilled}/${MUTANTS.length}`);
    rec.note("살아남은 돌연변이 = 테스트에 빠진 질문. '>= → >' 가 살면 경계값을, '&& → ||' 가 살면 그 조건의 반대편을 안 본 것이다. 커버리지 숫자는 이걸 절대 알려 주지 않는다.");
    rec.note("실무에서는 Stryker(JS/TS) 가 수백 가지 연산자로 돌연변이를 자동 생성하고 증분 실행으로 비용을 줄인다. 전부가 아니라 핵심 도메인 로직(금액·권한·한도)에 집중해서 돌린다 — 노트 07.");
  },
};

// ------------------------------------------------------------------ 플레이키 테스트 탐지
/** 테스트 대상: 비동기로 끝나는 작업. 걸리는 시간이 매번 다르다 (5~25ms) */
function startJob(): { done: boolean; promise: Promise<void> } {
  const job = { done: false, promise: Promise.resolve() };
  job.promise = new Promise<void>((resolve) =>
    setTimeout(() => {
      job.done = true;
      resolve();
    }, 5 + Math.random() * 20),
  );
  return job;
}

/** 나쁜 테스트: 고정 시간만큼 자고 결과를 확인한다 */
async function flakyTest(): Promise<boolean> {
  const job = startJob();
  await sleep(15);
  return job.done;
}

/** 좋은 테스트: 완료 이벤트(약속)를 기다린다. 상한 시간은 '실패 판정' 용 */
async function stableTest(): Promise<boolean> {
  const job = startJob();
  await Promise.race([job.promise, sleep(1000)]);
  return job.done;
}

/** 공유 상태 플레이키: 모듈 수준 배열을 두 테스트가 같이 쓴다. 실행 순서에 따라 결과가 바뀐다 */
function makeOrderSuite(isolated: boolean) {
  let cart: string[] = [];
  const tests: Record<string, () => boolean> = {
    addItem: () => {
      if (isolated) cart = [];
      cart.push("keyboard");
      return cart.length === 1;
    },
    emptyCartTotal: () => {
      if (isolated) cart = [];
      return cart.length === 0; // 빈 장바구니를 가정
    },
  };
  return tests;
}

export const testFlakyDetector: CodeExperiment = {
  id: "test-flaky-detector",
  subject: "testing",
  title: "플레이키 테스트 탐지: 같은 테스트를 50번 돌려 실패율을 재고, 시간 대기·공유 상태라는 두 원인을 고친 버전과 비교한다",
  category: "플레이키",
  summary: "비동기 작업(5~25ms)을 고정 15ms 대기 후 확인하는 테스트와 완료 이벤트를 기다리는 테스트를 각각 50회, 모듈 수준 상태를 공유하는 테스트 묶음을 무작위 순서로 50회 실행해 실패율을 측정한다. 재시도(retry=2)가 플레이키를 어떻게 '숨기는지' 도 숫자로 보여 준다",
  notes: ["06-e2e-flaky-management", "02-unit-test-design"],
  description: `
**플레이키 테스트**는 코드가 바뀌지 않았는데 통과·실패가 오가는 테스트다. 신호를 잡음으로 만들고, 결국 모두가 빨간불을 무시하게 만든다.
흔한 원인 두 가지를 재현한다:
1. **시간 기반 대기** — \`sleep(15)\` 후 확인. 작업이 15ms 보다 늦으면 실패한다. 고치는 법: 시간이 아니라 **조건(이벤트·약속·폴링)** 을 기다린다.
2. **공유 상태와 실행 순서** — 앞 테스트가 남긴 상태를 뒤 테스트가 본다. 순서를 섞으면(\`--sequence.shuffle\`) 드러난다. 고치는 법: 테스트마다 상태를 새로 만든다(beforeEach).
그리고 **재시도의 함정**: 실패 시 2번 다시 돌리면 실패율 p 가 p³ 로 줄어 녹색이 되지만, 원인은 그대로이고 실행 시간만 늘어난다.
`,
  code: `// 나쁜 예
test("job finishes", async () => { const job = startJob(); await sleep(15); expect(job.done).toBe(true) })
// 좋은 예 — 조건을 기다린다
test("job finishes", async () => { const job = startJob(); await job.promise; expect(job.done).toBe(true) })
// Playwright 라면: await page.waitForTimeout(500) ✗  →  await expect(locator).toBeVisible() ✓ (자동 재시도 단언)

// 공유 상태
let cart = []                      // ✗ 모듈 수준
beforeEach(() => { cart = [] })    // ✓ 테스트마다 초기화
// vitest --sequence.shuffle --repeat 50  로 순서·반복 의존성 찾기`,
  async run({ rec }) {
    const RUNS = 50;
    const measure = async (fn: () => Promise<boolean>) => {
      let fail = 0;
      const t0 = performance.now();
      for (let i = 0; i < RUNS; i++) if (!(await fn())) fail++;
      return { fail, ms: performance.now() - t0 };
    };
    const flaky = await rec.measure(`시간 대기 테스트 × ${RUNS}`, () => measure(flakyTest));
    const stable = await rec.measure(`조건 대기 테스트 × ${RUNS}`, () => measure(stableTest));
    const retried = await rec.measure(`시간 대기 테스트 + 재시도 2회 × ${RUNS}`, () =>
      measure(async () => {
        for (let a = 0; a < 3; a++) if (await flakyTest()) return true;
        return false;
      }),
    );
    rec.steps.push({
      cmd: "타이밍 플레이키",
      result: [
        { 테스트: "sleep(15) 후 확인", 실패율: `${Math.round((flaky.fail / RUNS) * 100)}%`, "평균 소요_ms": r1(flaky.ms / RUNS) },
        { 테스트: "완료 약속(promise) 대기", 실패율: `${Math.round((stable.fail / RUNS) * 100)}%`, "평균 소요_ms": r1(stable.ms / RUNS) },
        { 테스트: "sleep(15) + 재시도 2회", 실패율: `${Math.round((retried.fail / RUNS) * 100)}%`, "평균 소요_ms": r1(retried.ms / RUNS) },
      ],
      ms: 0,
    });
    rec.check("시간 대기 테스트는 같은 코드에서 통과·실패가 오간다 (실패율 10~90%)", flaky.fail >= RUNS * 0.1 && flaky.fail <= RUNS * 0.9, flaky.fail);
    rec.check("조건 대기 테스트는 50회 모두 통과한다", stable.fail === 0);
    rec.check("재시도는 실패율을 낮춰 '녹색처럼' 보이게 하지만 실행 시간을 늘린다", retried.fail < flaky.fail && retried.ms > flaky.ms, { 실패: retried.fail, ms: Math.round(retried.ms) });
    rec.note(`조건 대기는 평균 ${r1(stable.ms / RUNS)}ms 로 오히려 더 빠르다 — 고정 대기는 '최악을 가정한 시간' 을 매번 낭비하거나, 부족하면 실패한다. 둘 다 나쁘다.`);

    const order = (isolated: boolean) => {
      let fail = 0;
      const orders: Record<string, number> = {};
      for (let i = 0; i < RUNS; i++) {
        const suite = makeOrderSuite(isolated);
        const names = Object.keys(suite).sort(() => Math.random() - 0.5);
        const ok = names.every((n) => suite[n]());
        const key = names.join(" → ");
        orders[key] = (orders[key] ?? 0) + (ok ? 0 : 1);
        if (!ok) fail++;
      }
      return { fail, orders };
    };
    const shared = order(false);
    const isolated = order(true);
    rec.steps.push({
      cmd: "순서 의존 플레이키 (무작위 순서 50회)",
      result: [
        { 묶음: "모듈 수준 상태 공유", 실패율: `${Math.round((shared.fail / RUNS) * 100)}%`, "순서별 실패": shared.orders },
        { 묶음: "테스트마다 초기화(beforeEach)", 실패율: `${Math.round((isolated.fail / RUNS) * 100)}%` },
      ],
      ms: 0,
    });
    rec.check("공유 상태 묶음은 특정 순서(addItem 이 먼저)에서만 실패한다", shared.fail > 0 && Object.entries(shared.orders).every(([k, v]) => (k.startsWith("addItem") ? v > 0 : v === 0)), shared.orders);
    rec.check("테스트마다 상태를 초기화하면 순서와 무관하게 통과한다", isolated.fail === 0);
    rec.note("플레이키를 찾는 법: 반복(--repeat), 순서 섞기(--sequence.shuffle), 병렬도 바꾸기. CI 에서는 테스트별 통과율을 기록해 일정 이하를 격리(quarantine)하고 소유자에게 티켓 — 노트 06.");
  },
};

const r1 = (n: number) => Math.round(n * 10) / 10;
