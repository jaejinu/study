---
title: "속성 기반 테스트 — 예시 대신 성질을 쓰고, 도구가 반례를 찾아 줄인다"
order: 5
level: 심화
summary: "예시 기반 테스트의 한계, 속성(property)이란 무엇이고 어떻게 찾나(왕복·불변식·대칭·멱등·오라클·변형 관계), fast-check 의 구조(arbitrary·property·runner), 생성기 설계(분포·제약·사용자 정의), 축소(shrinking)와 재현(seed·path), 비동기·상태 기반(모델 기반) 테스트와 동시성 버그 찾기, 흔한 실수(속성이 구현을 베낌, 너무 느슨한 속성), 그리고 Redis 레이트리미터의 경쟁 조건을 fast-check 로 잡은 실측"
tags: [속성 기반 테스트, fast-check, 생성기, shrinking, 모델 기반 테스트, 불변식, 경쟁 조건, 오라클]
experiments: [test-property-ratelimit]
---

## 예시 기반 테스트의 한계

```ts
test("레이트리미터: 한도 3", async () => {
  for (let i = 0; i < 5; i++) results.push(await limiter(key, 3));
  expect(results.filter(Boolean)).toHaveLength(3);      // ✓ 통과
});
```

이 테스트는 **내가 떠올린 한 가지 시나리오**(순차 요청 5개)만 검사한다. 실험 [`test-property-ratelimit`](/testing/lab/test-property-ratelimit) 의 비원자 구현(GET → 판단 → SET)은 이 테스트를 통과한다. 하지만 동시 요청 2개만 섞어도 한도 1 에서 2건을 허용한다. 사람은 그 입력을 잘 떠올리지 못한다.

속성 기반 테스트(property-based testing, PBT)는 질문을 바꾼다.

> "이 입력에서 이 출력이 나오나?" → "**어떤** 입력이든 이 성질이 성립하나?"

그리고 입력을 **도구가 수백 개 생성**한다. 실패하면 그 입력을 가장 작은 형태로 **축소(shrinking)** 해 보여 준다.

## 실측 — 레이트리미터의 경쟁 조건

속성: *한도 N, 한 창 안에서 어떤 요청 묶음 순서로 보내든 허용된 수 ≤ N*

```ts
fc.asyncProperty(
  fc.integer({ min: 1, max: 10 }),                                          // N
  fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 6 }), // 묶음 크기들 (묶음 안은 동시)
  async (limit, bursts) => (await runBursts(limiter, freshKey(), limit, bursts)) <= limit,
)
```

| 구현 | 결과 |
|---|---|
| 원자적 (Lua `INCR` 한 번으로 판정) | 무작위 입력 **200개 모두 통과** |
| 비원자 (`GET` → 판단 → `SET`) | **첫 실행에서 실패**, 5번 축소해 반례 `{ limit: 1, bursts: [2] }` |
| 비원자 + 순차 예시 테스트 | 통과 — 버그를 못 잡는다 |

반례 `limit 1, 동시 2` 를 보는 순간 원인이 보인다: 두 요청이 동시에 0 을 읽고 둘 다 "여유 있음" 으로 판단한 뒤 1 을 쓴다. 해결은 판정과 증가를 원자적으로 — [Redis 레이트리밋](/redis/notes/10-rate-limiting), [트랜잭션과 Lua](/redis/notes/05-transactions-lua).

## 속성은 어떻게 찾나

"성질을 쓰라" 가 막막하면 아래 패턴부터 시도한다.

| 패턴 | 형태 | 예 |
|---|---|---|
| **왕복 (round-trip)** | `decode(encode(x)) == x` | JSON 직렬화, URL 인코딩, Protobuf, 압축 |
| **불변식** | 연산 후에도 항상 참 | 정렬 결과의 길이 = 입력 길이, 잔액 ≥ 0, 원장 합 = 0 |
| **멱등** | `f(f(x)) == f(x)` | 정규화, 중복 제거, 멱등 키 처리 |
| **대칭·교환** | `merge(a, b) == merge(b, a)` | CRDT 병합, 집합 연산 — [분산 복제](/distributed-systems/notes/04-replication) |
| **오라클** | 느리지만 확실한 구현과 비교 | 최적화한 검색 vs 단순 전수 검색 |
| **변형 관계 (metamorphic)** | 입력을 바꾸면 출력이 예측 가능하게 바뀐다 | 검색어에 문서를 추가하면 결과 수가 줄지 않는다 |
| **상한·하한** | 결과가 범위 안 | 레이트리미터 허용 ≤ N, 재시도 지연 ≤ max |
| "망가지지 않음" | 어떤 입력에도 예외 없이 | 파서에 무작위 문자열 (퍼징과 비슷) |

이 사이트의 함수로 예를 들면:

| 함수 | 속성 |
|---|---|
| `stripJosa(t)` | 결과는 항상 입력의 접두사이고, 길이 ≥ 2 이거나 입력과 같다 |
| `cardKey(note, q)` | 같은 입력이면 같은 키(결정적), 12자 16진수 |
| `searchSmart(q)` | `searchAll(q, "all")` 의 결과는 모두 `searchSmart(q)` 결과에 포함된다 |
| `summarizeReview(keys, stats)` | `unseen + (본 카드 수) == total`, `due ≤ total` |
| 라이트너 상자 갱신 | 정답이면 box 가 1 증가하되 최대 4, 오답이면 0 |

## fast-check 의 구조

```ts
import fc from "fast-check";

fc.assert(                                         // 실패하면 예외 (테스트 러너용). fc.check 는 결과 객체
  fc.property(                                     // 동기. 비동기는 fc.asyncProperty
    fc.string(), fc.string(),                      // arbitrary: 값 생성기 + 축소기
    (a, b) => (a + b).length === a.length + b.length,
  ),
  { numRuns: 1000, seed: 42 },                     // 실행 횟수, 재현용 시드
);
```

| 요소 | 역할 |
|---|---|
| arbitrary | 무작위 값 생성 + 실패 시 더 작은 값 제안(축소) |
| property | 입력 → 참/거짓 (또는 예외 = 실패) |
| runner | numRuns 만큼 실행, 실패 시 축소, 시드·경로 보고 |

### 생성기 만들기

```ts
// 기본: 정수, 문자열, 배열, 레코드, 선택지
fc.integer({ min: 0, max: 100_000 })
fc.constantFrom("redis", "kafka", "postgres")
fc.record({ total: fc.nat(200_000), member: fc.boolean() })

// 조합: 퀴즈 카드
const card = fc.record({ note: fc.stringMatching(/^\d{2}-[a-z-]{3,20}$/), q: fc.string({ minLength: 1 }), a: fc.string() });

// 변환: 정렬된 배열이 필요하면 생성 후 정렬 (filter 로 거르면 대부분 버려져 느리다)
fc.array(fc.integer()).map((xs) => [...xs].sort((a, b) => a - b))

// 경계값 편향: fast-check 는 기본적으로 0, 최소·최대, 빈 배열 같은 값을 자주 섞는다
```

| 실수 | 결과 | 대신 |
|---|---|---|
| `.filter()` 로 대부분을 버림 | 느리고 "너무 많이 거름" 경고 | `.map()` 으로 원하는 형태로 변환 |
| 범위를 너무 넓게 (`fc.integer()` 전체) | 실제로 의미 있는 영역을 거의 안 봄 | 도메인 범위로 (`min/max`) |
| 범위를 너무 좁게 | 버그가 있는 영역을 안 봄 | 경계 바깥도 조금 포함 |

## 축소 — 가장 작은 반례

실패한 입력 `{ limit: 7, bursts: [3, 12, 1, 9] }` 를 그대로 받으면 원인을 찾기 어렵다. fast-check 는 각 arbitrary 의 축소기로 "더 작은 후보" 를 시도해, **여전히 실패하는** 가장 작은 입력을 찾는다.

```
{ limit: 7, bursts: [3, 12, 1, 9] }   실패
→ { limit: 1, bursts: [12] }          실패 (더 작게)
→ { limit: 1, bursts: [2] }           실패 (더 이상 줄일 수 없음)  ← 보고
```

실험에서는 축소 5회 만에 `{ limit: 1, bursts: [2] }` 에 도달했다.

### 재현

```
Property failed after 1 tests
{ seed: 42, path: "0:0:1:0:0:0", endOnFailure: true }
Counterexample: [1, [2]]
```

`seed` 와 `path` 를 옵션에 넣으면 같은 반례를 바로 재현한다. 실패한 반례는 **예시 테스트로 고정**해 두는 것이 관례다(`fc.assert(..., { examples: [[1, [2]]] })`) — 회귀 방지.

## 상태 기반(모델 기반) 테스트

함수 하나가 아니라 **연산의 순서**에서 생기는 버그를 찾는다. 시스템과 단순한 모델에 같은 명령 시퀀스를 적용하고 결과를 비교한다.

```ts
// 모델: 단순한 메모리 카운터.  실제: Redis 레이트리미터
class Acquire implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  async run(m: Model, r: Real) {
    const ok = await r.limiter.acquire();
    const expected = m.used < m.limit;
    if (expected) m.used++;
    expect(ok).toBe(expected);                      // 모델과 다르면 실패
  }
  toString = () => "acquire";
}
class AdvanceWindow implements fc.AsyncCommand<Model, Real> { /* 창 넘기기: m.used = 0, 시계 이동 */ }

await fc.assert(fc.asyncProperty(fc.commands([fc.constant(new Acquire()), fc.constant(new AdvanceWindow())]), (cmds) =>
  fc.asyncModelRun(() => ({ model: { used: 0, limit: 3 }, real: makeReal() }), cmds)));
```

| | 일반 속성 | 모델 기반 |
|---|---|---|
| 입력 | 값 | 명령 시퀀스 |
| 찾는 버그 | 계산·경계 | **상태 전이·순서** (닫은 뒤 쓰기, 만료 직후 재요청) |
| 축소 | 값 | 명령 시퀀스를 짧게 |
| 동시성 | — | `fc.scheduler()` 로 비동기 실행 순서를 무작위화 → 경쟁 조건 탐색 |

`fc.scheduler()` 는 Promise 해결 순서를 fast-check 가 제어하게 해서, 단일 프로세스 안의 경쟁 조건을 결정적으로 재현한다. 분산 시스템에서는 이 아이디어를 극단으로 밀어붙인 것이 [Jepsen 과 TLA+](/distributed-systems/notes/08-verification-and-practice) 다.

## 흔한 실수

| 실수 | 증상 | 대응 |
|---|---|---|
| **속성이 구현을 베낌** | `expect(fee(t, m)).toBe(t >= 50000 ? 0 : …)` — 같은 버그를 두 번 | 오라클은 다른 방식(더 단순한 구현, 표)으로 |
| 너무 느슨한 속성 | "예외가 안 난다" 만 검사 | 불변식·관계를 추가 |
| 느린 속성 | 실행마다 컨테이너·DB 준비 | 준비는 `beforeAll`, 속성 안에서는 고유 키로 격리 |
| 비결정적 속성 | 같은 시드에서도 가끔 실패 | 외부 시간·난수를 주입 ([단위 테스트 설계](/testing/notes/02-unit-test-design)) |
| 예시 테스트를 버림 | 중요한 경계가 우연에 맡겨짐 | 둘 다 쓴다: 경계는 예시로, 넓은 공간은 속성으로 |

## 예시로 보기 — 이 프로젝트에서

실험 [`test-property-ratelimit`](/testing/lab/test-property-ratelimit) 의 핵심 구조:

```ts
const prop = (limiter: Limiter) =>
  fc.asyncProperty(fc.integer({ min: 1, max: 10 }), fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 6 }),
    async (limit, bursts) => (await runBursts(r, limiter, freshKey(), limit, bursts)) <= limit);

const good = await fc.check(prop(atomicLimiter), { numRuns: 200, seed: 42 });   // 통과
const bad  = await fc.check(prop(racyLimiter),  { numRuns: 200, seed: 42 });   // 반례 [1, [2]]
```

- 속성 안에서 매번 `freshKey()` 로 새 키를 써서 실행끼리 격리한다 (통합 테스트의 접두어 격리 — [노트 03](/testing/notes/03-integration-containers))
- 진짜 Redis 와 진짜 동시 요청(같은 연결에 파이프라인된 GET 들)이라 경쟁이 재현된다
- 실험이 끝나면 `k("rl:*")` 키를 전부 지운다

다음 후보는 `summarizeReview` 의 불변식과 `searchSmart` 의 "AND 결과 ⊆ 결과" 속성이다. 둘 다 Redis 없이 순수하게 돌아서 vitest 에 바로 넣을 수 있다.

## 실전에서는 어디에 쓰이나

> 사람이 떠올리지 못하는 입력 조합에서만 터지는 버그 — 경쟁 조건, 직렬화 왕복 실패, 경계값 — 를 찾아야 할 때 속성 기반 테스트가 쓰인다. 예시 대신 "어떤 입력이든 성립해야 하는 성질" 을 쓰면 도구가 반례를 찾아 가장 작게 줄여 준다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| API 게이트웨이 레이트리미터 | 동시 요청에서 한도 초과 허용 | "허용 수 ≤ N" 상한 속성 + 진짜 Redis 동시 요청 | 순차 예시 테스트(경쟁을 못 봄) |
| 핀테크 원장·정산 | 어떤 거래 순서에서도 합계 불일치 없음 | "원장 합 = 0", "잔액 ≥ 0" 불변식 | 대표 시나리오 몇 개 |
| 직렬화·파서(JSON·Protobuf·URL) | 특수 문자·빈 값에서 깨짐 | `decode(encode(x)) == x` 왕복 속성, 파서 무작위 입력 | 퍼저(fuzzer) 단독 |
| 협업 편집·오프라인 동기화 | 병합 순서에 따라 결과가 다름 | CRDT 병합의 교환·결합·멱등 속성 | 수동 시나리오 테스트 |
| 검색·추천 최적화 | 빠른 구현이 느린 정답과 다름 | 단순 전수 구현을 오라클로 비교 | 결과 샘플 수동 검토 |

**이럴 땐 안 맞는다**
- 성질을 말로 정의하기 어려운 UI·문구·LLM 출력: 성립 여부를 판정할 수 없다. 스냅샷·평가 셋·사람 검토를 쓴다.
- 실행마다 DB 를 새로 준비해야 하는 느린 경로: 수백 번 실행이 감당이 안 된다. 순수 로직으로 분리하거나 고유 키 격리로 준비 비용을 줄인다.

**누가 매일 만나나** — 백엔드 개발자는 동시성·직렬화 로직을 검증할 때, 라이브러리·데이터베이스 개발자는 상태 기반(모델 기반) 테스트로 연산 순서 버그를 찾을 때 만난다.

**면접·실무 단골 질문**
- Q. 속성은 어떻게 찾나? → 왕복·불변식·멱등·교환·오라클·변형 관계·상한 패턴부터 시도한다.
- Q. 반례를 찾은 뒤에는? → seed·path 로 재현하고, 축소된 반례를 예시 테스트(`examples`)로 고정해 회귀를 막는다.

## 실습 체크리스트

- [ ] 실험 `test-property-ratelimit` 를 돌리고 반례 `[1, [2]]` 가 왜 경쟁 조건을 가리키는지 설명하기
- [ ] `summarizeReview` 의 불변식 두 개를 fast-check 속성으로 써 보기
- [ ] `stripJosa` 에 대해 "결과는 입력의 접두사" 속성을 쓰고 생성기로 한글 문자열을 만드는 방법 찾기
- [ ] 레이트리미터를 모델 기반 테스트(acquire / 창 넘기기)로 설계하고, 창 경계에서 어떤 버그가 숨을 수 있는지 적기
- [ ] 반례를 `examples` 로 고정하는 것이 왜 회귀 방지인지 설명하기
