---
title: "경합 조건과 임계 구역 — 원자성·가시성·순서"
order: 2
level: 기초
summary: "경합 조건이 생기는 세 가지 이유(원자성 깨짐·가시성 없음·순서 바뀜), read-modify-write 와 check-then-act 패턴, 데이터 경합과 경합 조건의 차이, 임계 구역과 상호 배제의 조건, Node 의 단일 스레드도 await 사이에서 경합이 생기는 이유, 데이터베이스·Redis·분산 시스템에서 같은 버그가 나타나는 모양, 실험으로 보는 잃어버린 갱신"
tags: [경합 조건, 임계 구역, read-modify-write, check-then-act, 데이터 경합, 원자성, 가시성, 잃어버린 갱신]
experiments: [conc-race-condition]
---

## 경합 조건이란

**결과가 실행 순서(타이밍)에 따라 달라지는** 상황. 그 중 일부 순서가 잘못된 결과를 낸다면 버그다.

가장 유명한 예는 카운터 증가다. `count++` 는 한 줄이지만 기계에게는 세 단계다.

```
스레드 A                 스레드 B                 count
read  count → 7                                    7
                          read  count → 7          7
add   7 + 1 = 8                                    7
                          add   7 + 1 = 8          7
write count ← 8                                    8
                          write count ← 8          8   ← 9 여야 했다 (잃어버린 갱신)
```

![count++ 의 인터리빙](/diagrams/conc-race-interleaving.svg)

[경합 조건 실험](/concurrency/lab/conc-race-condition)에서 워커 4개가 100만 번씩 증가시키면 400만이어야 할 값이 그보다 한참 작게 나온다. 잃어버린 수는 실행마다 다르다 — 비결정성.

## 세 가지 원인 — 원자성·가시성·순서

| 원인 | 의미 | 예 | 해법 |
|---|---|---|---|
| **원자성** 없음 | 여러 단계 연산 중간에 다른 스레드가 끼어든다 | `count++`, `if (!map.has(k)) map.set(k, v)` | 락, 원자 연산(4편) |
| **가시성** 없음 | 한 스레드가 쓴 값이 다른 스레드에 (언제) 보일지 보장이 없다 | 종료 플래그를 써도 루프가 영원히 돔 | volatile·Atomics·락(5편) |
| **순서** 바뀜 | 컴파일러·CPU 가 독립적인 읽기·쓰기 순서를 바꾼다 | 객체 초기화 전에 참조가 공개됨 | 메모리 배리어, 안전한 공개(5편) |

실험의 두 번째 방식이 원자성의 함정을 정확히 보여 준다. `Atomics.store(a, 0, Atomics.load(a, 0) + 1)` 은 읽기와 쓰기가 **각각** 원자적이지만, 둘 사이에 다른 워커가 끼어든다. **원자 연산 두 개를 이어 붙인다고 원자적 연산 하나가 되지 않는다.** 이것이 동시성에서 가장 자주 하는 착각이다.

## 두 가지 패턴

### read-modify-write

읽고 → 계산하고 → 쓴다. 카운터, 잔액 차감, 재고 감소.

```js
// 잘못
const stock = await redis.get("stock");
if (Number(stock) > 0) await redis.set("stock", Number(stock) - 1);   // 두 요청이 같은 stock 을 읽으면 과판매
// 올바름 — 원자적 명령
await redis.decr("stock");                                          // 또는 Lua 로 '확인 + 감소' 를 한 번에
```

### check-then-act

조건을 확인하고 → 그 조건을 전제로 행동한다. 확인과 행동 사이에 조건이 바뀌면 깨진다(TOCTOU, Time-Of-Check to Time-Of-Use).

```js
// 잘못 — 두 요청이 동시에 "없음" 을 보고 둘 다 만든다
if (!(await db.query("select 1 from users where email = $1", [email])).rowCount) {
  await db.query("insert into users(email) values ($1)", [email]);
}
// 올바름 — 확인과 행동을 저장소가 원자적으로
await db.query("insert into users(email) values ($1) on conflict (email) do nothing", [email]);   // + unique 제약
```

파일 시스템(`if (!exists(f)) create(f)` 대신 `O_CREAT|O_EXCL`), 캐시 스탬피드([Redis 08](/redis/notes/08-caching-patterns)), 분산 락의 "락 없으면 획득" (SET NX) 모두 이 패턴의 변형이다.

## 데이터 경합 vs 경합 조건

둘은 다르다.

| | 데이터 경합 (data race) | 경합 조건 (race condition) |
|---|---|---|
| 정의 | 두 스레드가 같은 메모리에 **동기화 없이** 접근하고 그중 하나가 쓰기 | 결과가 타이밍에 따라 잘못될 수 있음 |
| 수준 | 메모리 모델 수준 (기계적으로 판정 가능) | 프로그램 의미 수준 |
| 결과 | C/C++ 에서는 **정의되지 않은 동작**, Java 에선 이상한 값이 보일 수 있음 | 잘못된 비즈니스 결과 |
| 예 | 락 없이 공유 int 를 읽고 씀 | 각 연산은 락으로 보호했지만 "잔액 확인" 과 "차감" 을 다른 락 구간에서 함 |

데이터 경합이 없어도 경합 조건은 있을 수 있다(위 표의 두 번째 예). 그래서 "모든 접근에 락을 걸었다" 가 정답이 아니라 **불변식(invariant)을 지키는 단위로 락을 거는 것**이 정답이다. "잔액 ≥ 0" 을 지켜야 한다면 확인과 차감이 **같은 임계 구역** 안에 있어야 한다.

## 임계 구역과 상호 배제

**임계 구역(critical section)**: 공유 상태를 다루어서 한 번에 한 실행 단위만 들어가야 하는 코드 구간. 올바른 해법이 만족해야 할 조건:

1. **상호 배제**: 동시에 둘이 들어가지 않는다.
2. **진행(progress)**: 아무도 안에 없으면 들어가려는 쪽이 결국 들어간다.
3. **한정 대기(bounded waiting)**: 어떤 쪽도 무한히 밀리지 않는다(6편의 기아).

락만이 해법은 아니다. **임계 구역 자체를 없애는** 방법이 더 좋을 때가 많다.

| 방법 | 아이디어 | 예 |
|---|---|---|
| 불변 데이터 | 바꾸지 않으면 경합도 없다 | 새 객체를 만들고 참조만 원자적으로 교체 |
| 스레드 국한 | 한 스레드만 만지게 한다 | 요청별 객체, 워커별 지역 카운터 |
| 원자 연산 | 하드웨어가 한 단계로 | Atomics.add, Redis INCR, `UPDATE … SET n = n + 1` |
| 메시지 전달 | 소유자 하나에게 요청을 보낸다 | 액터, 채널(7편) |
| 저장소에 위임 | DB·Redis 가 원자성을 제공 | unique 제약, 조건부 UPDATE, Lua |

## Node 는 단일 스레드인데 경합이 생기나?

생긴다. JavaScript 코드 자체는 한 번에 하나씩 실행되지만, **`await` 마다 다른 요청이 끼어들 수 있다.**

```js
let balance = 100;
async function withdraw(amount) {
  if (balance >= amount) {               // 확인
    await chargeCard(amount);            // ← 여기서 다른 withdraw 가 실행된다
    balance -= amount;                   // 행동
  }
}
await Promise.all([withdraw(80), withdraw(80)]);   // balance = -60
```

스레드 경합과 달리 끼어들 수 있는 지점이 `await` 로 **보인다**는 것이 장점이다. 규칙은 같다 — 확인과 행동 사이에 `await` 를 두지 말거나, 그 구간을 직렬화한다(뮤텍스 라이브러리, 작업 큐). Node 의 이벤트 루프 순서는 [Node.js](/nodejs) 주제에서 자세히 다룬다.

## 같은 버그, 다른 층

| 층 | 경합 조건의 모양 | 이 사이트에서 |
|---|---|---|
| CPU·스레드 | 공유 변수 증가 | [경합 조건 실험](/concurrency/lab/conc-race-condition) |
| 이벤트 루프 | await 사이 끼어들기 | 위 withdraw 예 |
| Redis | GET → 계산 → SET | [레이트 리미터 속성 테스트](/testing/lab/test-property-ratelimit) 가 GET→SET 구현의 반례를 찾는다 |
| 데이터베이스 | 잃어버린 갱신, 쓰기 왜곡 | [PostgreSQL 격리 수준](/postgres/notes/03-mvcc-isolation) |
| 분산 시스템 | 두 노드가 각자 리더라고 믿음 | [펜싱 토큰](/distributed-systems/notes/06-transactions-coordination) |
| 이벤트 소싱 | 같은 스트림에 동시 명령 | [낙관적 동시성](/event-sourcing/notes/03-event-store) |

층이 바뀌어도 해법의 모양은 같다: **원자적 연산으로 합치거나, 직렬화하거나, 버전을 비교한다.**

## 예시로 보기 — 이 프로젝트에서

이 사이트의 진행률 저장은 경합을 Redis 의 원자 명령으로 피한다.

```ts
// src/lib/study.ts — 학습 시간 누적: GET 후 SET 이 아니라 INCRBY (원자적)
await r.incrby(`study:time:${subject}/${slug}`, seconds);
// 읽음 표시: SADD 는 이미 있어도 안전 (멱등)
await r.sadd("progress:read", `${subject}/${slug}`);
```

반대로 퀴즈 기록(`recordQuiz`)은 HGET → 계산 → HSET 이라 같은 카드를 두 탭에서 동시에 채점하면 한쪽 결과를 잃을 수 있다. 개인 학습 사이트라 위험이 작아 그대로 두었지만, 여러 사용자라면 Lua 스크립트나 WATCH/MULTI([Redis 05](/redis/notes/05-transactions-lua))로 묶어야 한다.

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| 각 연산은 보호했지만 불변식은 아님 | 확인과 행동 사이 끼어들기 | 불변식 단위로 임계 구역 |
| 동시성 컬렉션이면 안전하다고 믿음 | `if (!map.containsKey(k)) map.put(k, v)` 는 여전히 경합 | `putIfAbsent`·`computeIfAbsent` 같은 원자 메서드 |
| 테스트가 통과해서 안전하다고 믿음 | 1만 번에 한 번 나는 버그 | 스트레스 테스트, ThreadSanitizer, 속성 기반 테스트 ([테스트 05](/testing/notes/05-property-based-testing)) |
| await 사이를 원자적이라고 착각 (Node) | 확인과 행동 사이 다른 요청 | 확인·행동을 저장소의 원자 연산으로 |
| 캐시 갱신을 GET → SET 으로 | 스탬피드·덮어쓰기 | SET NX, 원자 명령, 단일 비행 |

## 실습 체크리스트

- [ ] [동시성과 병렬성](/concurrency/notes/01-concurrency-vs-parallelism)의 암달의 법칙으로, 임계 구역이 전체의 5% 일 때 워커 4개·64개의 최대 속도 향상을 계산하기
- [ ] [경합 조건 실험](/concurrency/lab/conc-race-condition)에서 세 방식의 최종값을 비교하고 load+store 가 왜 여전히 틀린지 설명하기
- [ ] 위 `withdraw` 예를 직접 돌려 잔액이 음수가 되는 것을 보고, await 위치를 옮겨 고치기
- [ ] check-then-act 를 unique 제약 + `on conflict` 로 바꾼 코드를 하나 써 보기
- [ ] 데이터 경합은 없지만 경합 조건이 있는 예를 하나 만들어 보기
- [ ] 지금 다루는 코드에서 GET → 계산 → SET 패턴을 찾아 원자적 연산으로 바꿀 수 있는지 검토하기
