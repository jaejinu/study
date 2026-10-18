---
title: "단위 테스트 설계 — 결정성, 가짜(fake) vs mock, 시간·난수 주입, 픽스처"
order: 2
level: 중급
summary: "읽히는 테스트의 구조(Arrange-Act-Assert, 하나의 행동), 이름 짓기, 비결정성의 원천(시간·난수·동시성·전역 상태·네트워크)과 주입으로 다스리는 법, 가짜 시계(vi.useFakeTimers), fake 와 mock 의 차이와 선택 기준, 픽스처와 테스트 데이터 빌더, 매개변수화 테스트로 경계값 표 만들기, 단언의 품질(구체적 실패 메시지), 리팩터링에 강한 테스트, 그리고 이 사이트 코드로 직접 써 보는 예"
tags: [단위 테스트, AAA, 결정성, fake, mock, 가짜 시계, 의존성 주입, 픽스처, 매개변수화, vitest]
experiments: [test-mutation-mini, test-flaky-detector, test-property-ratelimit]
---

## 테스트 하나의 모양

```ts
test("회원은 3만 원부터 무료 배송", () => {
  // Arrange — 준비
  const total = 30_000;
  // Act — 실행 (한 번)
  const fee = shippingFee(total, true);
  // Assert — 단언
  expect(fee).toBe(0);
});
```

| 원칙 | 설명 |
|---|---|
| **하나의 행동** | 테스트 하나는 하나의 동작을 검증한다. 실패하면 무엇이 깨졌는지 이름만 보고 안다 |
| Act 는 한 줄 | 여러 단계를 실행하면 어느 단계가 문제인지 모른다 |
| 이름 = 명세 | `test("회원은 3만 원부터 무료 배송")` — 함수 이름(`test_shippingFee_1`)이 아니라 규칙 |
| 조건문 금지 | 테스트 안의 `if` 는 "어떤 경우엔 검증 안 함" 이다 |
| 로직 금지 | 기대값을 테스트 안에서 계산하면 같은 버그를 두 번 쓴다 — 기대값은 **리터럴** |

## 결정성 — 비결정성의 원천을 끊는다

| 원천 | 증상 | 대응 |
|---|---|---|
| **시간** | 자정·월말·서머타임에 실패 | 시계를 주입 (`now: () => Date`), 가짜 타이머 |
| **난수** | 가끔 실패 | 난수 생성기를 주입하거나 시드 고정 |
| 동시성·타이밍 | `sleep` 후 확인이 가끔 실패 | 조건·이벤트를 기다린다 — 실험 [`test-flaky-detector`](/testing/lab/test-flaky-detector) |
| 전역·공유 상태 | 순서에 따라 실패 | 테스트마다 새로 만든다 (`beforeEach`) |
| 네트워크·외부 | 외부 장애 시 실패 | 단위 테스트에서는 대역, 통합 테스트에서는 로컬 컨테이너 |
| 환경 | 내 PC 에서만 통과 (로캘·시간대·경로) | `TZ=UTC`, 로캘 고정 |

실험 [`test-flaky-detector`](/testing/lab/test-flaky-detector) 에서 `sleep(15)` 후 확인하는 테스트는 50회 중 **36%** 실패했고, 완료 약속(promise)을 기다리는 테스트는 **0%** 실패에 평균 시간도 비슷했다(17ms). 고정 대기는 "최악을 가정한 시간을 낭비" 하거나 "부족해서 실패" 하거나 둘 중 하나다.

### 시간 주입

```ts
// ✗ 테스트할 수 없다 — 함수 안에서 시간을 직접 읽는다
function isDue(stat: QuizStat) { return stat.due <= Date.now(); }

// ✓ 시간을 인자로 받는다 (기본값은 실제 시간)
function isDue(stat: QuizStat, now = Date.now()) { return stat.due <= now; }

test("기한이 지난 카드", () => {
  expect(isDue({ due: 1_000 } as QuizStat, 1_001)).toBe(true);
  expect(isDue({ due: 1_000 } as QuizStat, 999)).toBe(false);
});
```

이 사이트의 `summarizeReview(keys, stats, now = Date.now())` 가 이미 이 모양이다.

### 가짜 타이머

```ts
import { vi } from "vitest";
test("1일 상자는 24시간 뒤 다시 나온다", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  const stat = nextStat(prev, /* right */ true);         // box 0 → 1
  vi.advanceTimersByTime(24 * 3600_000 - 1);
  expect(isDue(stat)).toBe(false);
  vi.advanceTimersByTime(1);
  expect(isDue(stat)).toBe(true);
  vi.useRealTimers();
});
```

## fake vs mock

```ts
// mock — 호출 방식을 검증
const repo = { save: vi.fn() };
await registerUser(repo, "a@b.c");
expect(repo.save).toHaveBeenCalledWith({ email: "a@b.c", verified: false });

// fake — 결과 상태를 검증
const repo = new InMemoryUserRepo();
await registerUser(repo, "a@b.c");
expect(await repo.findByEmail("a@b.c")).toMatchObject({ verified: false });
```

| | mock | fake |
|---|---|---|
| 검증 대상 | **어떻게** 호출했나 (상호작용) | **무엇이** 됐나 (상태) |
| 리팩터링 | `save` 를 `upsert` 로 바꾸면 깨짐 | 결과가 같으면 통과 |
| 작성 비용 | 낮음 | fake 구현이 필요 (재사용 가능) |
| 쓸 곳 | 부수 효과 자체가 계약일 때 (이메일 발송, 결제 호출 횟수) | 저장소·캐시·시계·큐 |

> **원칙:** 내가 소유한 내부 협력자는 mock 하지 않는다. 프로세스 밖 경계(외부 API, 메일 서버)에서만 대역을 쓰고, 가능하면 fake 를 쓴다.

### fake 의 함정

fake 가 진짜와 다르게 동작하면 거짓 안심을 준다. 메모리 Map 은 원자성·TTL·직렬화를 흉내 내지 않는다. 실험 [`test-property-ratelimit`](/testing/lab/test-property-ratelimit) 의 경쟁 조건은 **진짜 Redis + 동시 요청**에서만 드러났다. 그래서 "fake 로 단위 테스트 + 진짜로 통합 테스트" 를 같이 둔다 — [통합 테스트](/testing/notes/03-integration-containers). 같은 테스트 묶음을 fake 와 진짜 양쪽에 돌리는 **계약 테스트 for fake** 도 좋은 방법이다.

## 픽스처와 테스트 데이터 빌더

```ts
// 빌더 — 기본값이 있고, 테스트마다 중요한 필드만 바꾼다
const aCard = (over: Partial<QuizCard> = {}): QuizCard => ({ note: "01-redis-overview", q: "질문", a: "답", ...over });
const aStat = (over: Partial<QuizStat> = {}): QuizStat => ({ right: 0, wrong: 0, streak: 0, box: 0, due: 0, last: 0, ...over });

test("틀린 카드는 상자 0 으로", () => {
  expect(nextStat(aStat({ box: 3, streak: 4 }), false).box).toBe(0);
});
```

| 패턴 | 장점 | 주의 |
|---|---|---|
| 빌더/팩토리 | 테스트가 "중요한 값" 만 드러냄 | 기본값이 의미를 숨기지 않게 |
| 공유 픽스처 (`beforeAll`) | 비싼 준비를 한 번 | **변경 가능하면 순서 의존**이 생김 — 읽기 전용만 |
| 테스트마다 준비 (`beforeEach`) | 독립성 | 느리면 통합 테스트로 옮긴다 |

## 매개변수화 — 경계값 표

```ts
test.each([
  // total,  member, fee
  [29_999, true,  3000],
  [30_000, true,  0],      // 경계
  [49_999, false, 3000],
  [50_000, false, 0],      // 경계
  [40_000, false, 3000],   // 회원 조건이 실제로 쓰이는지
])("shippingFee(%i, %s) = %i", (total, member, fee) => {
  expect(shippingFee(total, member)).toBe(fee);
});
```

경계값 분석: 조건 `x >= 30000` 이 있으면 **29999, 30000** 두 값을 반드시 넣는다. 실험 [`test-mutation-mini`](/testing/lab/test-mutation-mini) 에서 `>=` → `>` 돌연변이가 살아남은 이유가 바로 30000 을 안 넣었기 때문이다. 이 표의 다섯 줄을 추가하자 돌연변이 8개가 전부 죽었다.

## 단언의 품질

```ts
// ✗ 실패하면 "expected false to be true"
expect(result.items.length === 3 && result.total === 9000).toBe(true);

// ✓ 실패하면 무엇이 다른지 보인다
expect(result).toMatchObject({ total: 9000 });
expect(result.items).toHaveLength(3);
```

- 구조 비교(`toEqual`, `toMatchObject`)가 불리언 비교보다 실패 메시지가 좋다
- 예외 테스트는 **메시지·타입까지** (`toThrow(/한도 초과/)`)
- 부동소수점은 `toBeCloseTo`
- 스냅샷은 "큰 출력의 변화 감지" 용 — 내용을 검토하지 않고 `-u` 로 갱신하는 순간 테스트가 아니다

## 리팩터링에 강한 테스트

| 깨지기 쉬운 테스트 | 강한 테스트 |
|---|---|
| private 함수를 직접 호출 | 공개 동작으로 검증 |
| 내부 호출 순서를 mock 으로 검증 | 결과 상태를 검증 |
| 구현과 같은 알고리즘으로 기대값 계산 | 리터럴 기대값, 손으로 계산한 예 |
| 문구·HTML 전체 스냅샷 | 의미 있는 부분만 (역할·텍스트) |

신호: **동작은 그대로인데 리팩터링으로 테스트가 깨졌다면, 그 테스트는 구현을 검증하고 있었다.**

## 예시로 보기 — 이 프로젝트에서

`src/lib/search.ts` 의 `stripJosa` 는 단위 테스트하기 좋은 순수 함수다(현재는 모듈 내부 함수라 export 가 필요하다).

```ts
test.each([
  ["파이프라인은", "파이프라인"],
  ["리밸런스가", "리밸런스"],
  ["Redis", "Redis"],          // 영문은 그대로
  ["이", "이"],                // 너무 짧으면 자르지 않음
  ["에서", "에서"],            // 조사 자체
])("stripJosa(%s) = %s", (input, want) => expect(stripJosa(input)).toBe(want));
```

`src/lib/study.ts` 의 라이트너 상자 계산(`recordQuiz`)은 Redis 를 직접 부르기 때문에 단위 테스트가 어렵다. 순수한 부분(이전 상태 + 정답 여부 + 현재 시각 → 다음 상태)을 함수로 분리하면 시간 주입과 경계값 표로 단위 테스트할 수 있고, Redis 저장은 통합 테스트로 남긴다. 이 분리가 "테스트하기 어려운 코드는 설계 신호" 의 실제 예다.

## 실전에서는 어디에 쓰이나

> 테스트가 "가끔 실패" 하거나 리팩터링할 때마다 깨지는 문제를 만났을 때 이 노트의 기법이 쓰인다. 시간·난수를 주입하고, 내부 협력자는 mock 대신 fake 로 바꾸고, 경계값을 표로 고정하는 일이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 이자·연체료 계산 | 월말·윤년·자정에만 실패하는 테스트 | `now` 를 인자로 주입, 가짜 타이머로 날짜 경계 고정 | 실제 시각 사용(특정 날에만 실패) |
| 커머스 쿠폰·배송비 규칙 | 경계값(정확히 3만 원)에서의 버그 | `test.each` 로 경계 바로 위·아래 값을 표로 | 대표값 몇 개만 테스트 |
| 구독 SaaS 결제 갱신 로직 | 저장소 메서드 이름만 바꿔도 깨지는 테스트 | 메모리 fake 저장소로 결과 상태를 단언 | mock 으로 호출 순서 검증 |
| 게임 확률형 보상 | 난수 때문에 재현 불가 | 시드 고정 난수 생성기를 주입 | 여러 번 돌려 통계로 확인 |
| 이메일·알림 발송 | 발송 자체가 계약인 부수 효과 | 외부 경계에서만 mock·spy 로 호출 횟수 검증 | 실제 메일 서버 호출 |

**이럴 땐 안 맞는다**
- SQL·트랜잭션·Lua 원자성이 핵심인 코드: fake 는 원자성·TTL 을 흉내 내지 못한다. 진짜 의존성으로 통합 테스트를 쓴다.
- 레거시 코드에 단위 테스트부터 붙이기: 의존성이 얽혀 있어 mock 만 늘어난다. 먼저 바깥에서 특성 테스트(characterization test)로 동작을 고정하고 순수 함수를 분리한다.

**누가 매일 만나나** — 백엔드 개발자는 비즈니스 규칙을 구현하며 경계값 테스트를 쓸 때, 시니어 개발자는 코드 리뷰에서 "이 테스트는 구현을 검증한다" 를 지적할 때 만난다.

**면접·실무 단골 질문**
- Q. mock 과 fake 의 차이는? → mock 은 호출 방식(상호작용)을, fake 는 결과 상태를 검증한다. 내부 협력자는 fake, 외부 부수 효과만 mock.
- Q. 시간에 의존하는 코드는 어떻게 테스트하나? → 시계를 주입하거나 가짜 타이머를 쓰고, `TZ=UTC` 로 환경을 고정한다.

## 실습 체크리스트

- [ ] `stripJosa` 를 export 하고 위 매개변수화 테스트를 vitest 로 작성해 돌리기
- [ ] `recordQuiz` 에서 순수 함수 `nextStat(prev, right, now)` 를 분리하는 리팩터링을 설계하기
- [ ] 가짜 타이머로 "3일 상자는 72시간 뒤 기한" 을 테스트하는 코드 쓰기
- [ ] 실험 `test-flaky-detector` 를 돌리고 시간 대기 테스트를 고치는 두 가지 방법을 적기
- [ ] 지금 프로젝트에서 mock 을 fake 로 바꿀 만한 테스트 하나를 골라 비교하기
