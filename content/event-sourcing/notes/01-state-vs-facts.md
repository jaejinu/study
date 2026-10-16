---
title: "상태 저장 vs 사실 저장 — 이벤트 소싱은 언제 맞고 언제 과잉인가"
order: 1
level: 기초
summary: "현재 상태만 덮어쓰는 CRUD 와, 일어난 일을 사실(이벤트)로 쌓고 상태는 그로부터 계산하는 이벤트 소싱의 차이. 감사·시간 여행·재해석·통합에서 얻는 것과 학습 곡선·결과적 일관성·스키마 진화·삭제의 어려움이라는 대가, 그리고 '도입해도 되는가' 를 판단하는 체크리스트"
tags: [이벤트 소싱, CQRS, 상태 저장, 감사 로그, 도메인 이벤트, 결과적 일관성]
experiments: [es-optimistic-concurrency]
---

## 같은 계좌, 두 가지 저장 방식

은행 계좌를 생각해 보자. 가장 흔한 저장 방식은 **현재 상태**를 한 줄로 두고 바꿀 때마다 덮어쓰는 것이다.

```sql
-- 상태 저장 (CRUD)
update accounts set balance = balance - 10 where id = 'acc-1';
select balance from accounts where id = 'acc-1';   -- 90
```

이벤트 소싱은 "무슨 일이 있었는가" 를 **지우지 않는 사실의 목록**으로 쌓고, 잔액은 필요할 때 그 목록을 접어서(fold) 계산한다.

```sql
-- 사실 저장 (이벤트 소싱)
insert into events (stream_id, version, type, data) values
  ('acc-1', 1, 'AccountOpened',  '{"owner":"jae"}'),
  ('acc-1', 2, 'MoneyDeposited', '{"amount":100}'),
  ('acc-1', 3, 'MoneyWithdrawn', '{"amount":10}');
-- 잔액 = 100 - 10 = 90  (이벤트를 순서대로 적용한 결과)
```

| | 상태 저장 | 사실 저장 (이벤트 소싱) |
|---|---|---|
| 진실의 원천 | 현재 행 | 이벤트 로그 (append-only) |
| 과거 | 덮어써져 사라짐 (별도 이력 테이블이 없으면) | 전부 남음 |
| 쓰기 | UPDATE (경합 시 행 잠금) | INSERT 만 (버전 충돌 검사) |
| 읽기 | 그대로 SELECT | 접어서 계산 → 보통 **읽기 모델(프로젝션)** 을 따로 둔다 |
| 스키마 변경 | ALTER TABLE + 마이그레이션 | 이벤트는 못 고친다 → **업캐스팅** ([노트 06](/event-sourcing/notes/06-schema-evolution)) |
| 삭제 | DELETE | 어렵다 → 암호 삭제 등 ([노트 07](/event-sourcing/notes/07-sagas-operations)) |

> 핵심: 이벤트 소싱에서 **상태는 파생값**이고 **이벤트가 진실**이다. 데이터베이스의 WAL 이 진실이고 테이블은 그 결과라는 것과 같은 구조다 — [DB 내부 노트 04](/db-internals/notes/04-wal-checkpoint-recovery)의 WAL 을 업무 수준으로 끌어올린 것이라고 보면 된다.

![이벤트 소싱 + CQRS 흐름](/diagrams/es-cqrs-flow.svg)

## 이벤트란 무엇인가

이벤트는 **과거형의 사실**이다. "출금하라" 가 아니라 "출금됐다".

| 구분 | 예 | 성격 |
|---|---|---|
| 명령 (command) | `WithdrawMoney{amount:10}` | 요청. 거절될 수 있다 |
| 이벤트 (event) | `MoneyWithdrawn{amount:10}` | 이미 일어난 일. 거절할 수 없다 |
| 상태 (state) | `{balance: 90}` | 이벤트를 접은 결과 |

명령 처리의 모양은 늘 같다.

```ts
// 1) 읽기: 스트림을 읽어 현재 상태를 만든다
const { balance, version } = fold(await loadEvents("acc-1"));
// 2) 결정: 비즈니스 규칙을 검사하고 일어날 일을 이벤트로 만든다
if (balance < cmd.amount) throw new InsufficientFunds();
const events = [{ type: "MoneyWithdrawn", data: { amount: cmd.amount } }];
// 3) 추가: "내가 본 버전" 을 함께 보내 동시 변경을 막는다
await append("acc-1", events, { expectedVersion: version });
```

3번의 `expectedVersion` 이 이벤트 소싱 동시성의 전부다. 실험 [es-optimistic-concurrency](/event-sourcing/lab/es-optimistic-concurrency) 에서 잔액 100 계좌에 10원 출금 20건을 동시에 보내면 다음과 같다.

| 스토어 | 성공 | 거절 | 재시도 | 최종 잔액 |
|---|---|---|---|---|
| `unique(stream_id, version)` + 재시도 | 10 | 10 (잔액 부족) | 55회 | **0** |
| 유일 제약, 재시도 없음 | 1 | 19 (충돌 → 409) | 0 | 90 |
| 버전 검사 없음 | 20 | 0 | 0 | **-100** (같은 버전 19번 중복) |

버전 검사가 없으면 20개 명령이 모두 "잔액 100" 을 보고 결정해 잔액이 음수가 된다. 자세한 구현은 [노트 03 이벤트 스토어](/event-sourcing/notes/03-event-store).

## 무엇을 얻는가

1. **완전한 감사 기록**: "왜 잔액이 이렇게 됐나?" 에 이벤트 목록이 곧 답이다. 금융·의료·물류처럼 이력이 법적 요구인 영역에서 강하다. 이력 테이블을 따로 유지하다 원본과 어긋나는 일이 없다.
2. **시간 여행**: 이벤트를 어느 시점까지만 접으면 그 시점의 상태가 나온다. "지난달 말 기준 재고" 를 새로 계산할 수 있다.
3. **재해석**: 이벤트는 그대로 두고 **새 읽기 모델**을 처음부터 만들 수 있다. 1년 전부터 쌓인 `ItemAddedToCart`·`ItemRemovedFromCart` 로 "장바구니에 넣었다 뺀 상품" 분석을 오늘 시작할 수 있다. 상태 저장에서는 그 정보가 이미 덮어써져 없다.
4. **통합**: 이벤트를 그대로 다른 서비스에 발행할 수 있다. [Outbox·CDC](/kafka/notes/08-cdc-outbox-debezium) 로 하던 일을 이벤트 스토어가 구조적으로 해 준다.
5. **디버깅**: 버그를 재현하려면 그 스트림의 이벤트를 그대로 다시 재생하면 된다.

## 무엇을 대가로 내는가

| 대가 | 실제 모습 | 완화 |
|---|---|---|
| 학습 곡선 | 팀 전체가 명령·이벤트·집합·프로젝션 어휘를 익혀야 한다 | 경계 하나에서 시작 |
| 결과적 일관성 | 쓰자마자 목록 화면을 읽으면 아직 반영 안 됐을 수 있다 | 쓰기 결과에 버전 반환, 읽기에서 그 버전까지 기다리기 ([노트 04](/event-sourcing/notes/04-projections-replay)) |
| 스키마 진화 | 저장된 이벤트를 고칠 수 없다 | 업캐스터·버전 필드 |
| 이벤트 폭증 | 뜨거운 집합 하나에 이벤트 수만 개 → 로딩이 느려짐 | 스냅샷 ([노트 05](/event-sourcing/notes/05-snapshots-performance)) |
| 삭제 요구 | GDPR "잊힐 권리" vs 불변 로그 | 개인정보 분리·암호 삭제 |
| 질의 | "잔액 100 이상인 계좌" 같은 질의를 로그에 직접 할 수 없다 | 질의용 프로젝션 (CQRS) |
| 운영 | 프로젝션 재구축, 체크포인트, 재처리 사고 | 도구·런북 |

## CQRS 와의 관계

CQRS(Command Query Responsibility Segregation)는 **쓰기 모델과 읽기 모델을 분리**하는 것이다. 이벤트 소싱이 아니어도 CQRS 는 할 수 있다(쓰기는 정규화 테이블, 읽기는 비정규화 캐시·검색 인덱스). 반대로 이벤트 소싱은 로그를 직접 질의하기 어려워 **거의 항상 CQRS 와 함께** 간다.

```
명령 ──▶ 집합(쓰기 모델) ──▶ 이벤트 스토어 ──▶ 프로젝터 ──▶ 읽기 모델 (잔액 테이블, 검색 인덱스, 캐시)
                                              ▲                         ▲
                                         진실의 원천              질의는 여기로
```

아키텍처 관점의 정리는 [아키텍처 노트 05](/architecture/notes/05-data-modeling-cqrs-event-sourcing)에 있다. 이 주제는 그 패턴을 실제 코드와 숫자로 내려간다.

## 언제 쓰고 언제 쓰지 말까

**맞는 경우**
- 도메인 자체가 이벤트로 말한다: 회계 원장, 주문 상태 흐름, 예약, 재고 이동, 보험 청구.
- 이력·감사가 요구사항이다.
- 같은 사실을 여러 방식으로 보고 싶다(실시간 대시보드, 분석, 알림).
- 협업·동시 편집처럼 "누가 언제 무엇을" 이 중요하다.

**과잉인 경우**
- CRUD 화면 위주의 관리 도구, 설정 테이블.
- 이력이 필요 없고 "현재 값" 만 의미가 있다(사용자 프로필 사진 URL).
- 팀이 작고 마감이 급하다 — 이벤트 소싱은 시스템 전체가 아니라 **핵심 경계 하나**에만 쓰는 편이 대부분 맞다.
- 단순 이력이 목적이면 **이력 테이블 + 트리거**나 CDC 로 충분할 수 있다.

> 판단 질문 세 개: (1) 과거 상태를 다시 계산할 일이 있는가? (2) 같은 사실로 새로운 뷰를 만들 일이 있는가? (3) 감사가 법적·사업적 요구인가? 셋 다 "아니오" 면 상태 저장이 낫다.

## 흔한 오해

- **"이벤트 소싱 = Kafka"**: Kafka 는 이벤트를 나르는 로그다. 집합별 낙관적 동시성(스트림 버전 검사)을 Kafka 로 하기는 어렵다. 이벤트 스토어는 보통 DB(PostgreSQL, EventStoreDB)이고, Kafka 는 **발행 채널**이다. [Kafka 노트 04](/kafka/notes/04-delivery-guarantees) 참고.
- **"이벤트는 테이블 변경 기록이다"**: `RowUpdated{balance:90}` 은 도메인 이벤트가 아니다. 의도가 사라진다. `MoneyWithdrawn{amount:10, atm:"강남-3"}` 처럼 **업무 언어**로 쓴다.
- **"모든 것을 이벤트로"**: 조회수, 마우스 이동 같은 원격 측정은 분석 이벤트(로그)이지 도메인 이벤트가 아니다.

## 이 주제의 순서

1. 이 노트 — 언제 쓰나
2. [이벤트 모델링](/event-sourcing/notes/02-event-modeling) — 무엇을 이벤트로, 집합 경계
3. [이벤트 스토어](/event-sourcing/notes/03-event-store) — PostgreSQL 로 만들기, 낙관적 동시성
4. [프로젝션과 재생](/event-sourcing/notes/04-projections-replay) — 읽기 모델, 체크포인트, 재구축
5. [스냅샷과 성능](/event-sourcing/notes/05-snapshots-performance) — 긴 스트림 다루기
6. [스키마 진화](/event-sourcing/notes/06-schema-evolution) — 업캐스팅
7. [사가·운영](/event-sourcing/notes/07-sagas-operations) — 여러 집합, 삭제, 재처리 사고

결제·주문처럼 이벤트 소싱이 잘 맞는 사례는 [시스템 디자인 노트 06](/system-design/notes/06-payments-orders)에서 다른 부품과 함께 본다.

## 예시로 보기 — 이 프로젝트에서

이 사이트의 학습 기록을 이벤트 소싱으로 다시 설계해 보면 감이 온다. 지금은 Redis 에 **상태**만 저장한다.

| 지금 (상태) | 이벤트 소싱이라면 |
|---|---|
| `progress:read` Set 에 `kafka/08-…` 추가 | `NoteRead{subject, slug, at}` |
| `quiz:stats:<subject>` Hash 에 상자·기한 덮어쓰기 | `QuizAnswered{card, right, at}` → 상자는 프로젝션 |
| `study:day:<날짜>` 에 초 누적 | `StudyHeartbeat{subject, slug, seconds, at}` |

이벤트로 저장했다면 "간격 반복 규칙을 1·3·7·14일에서 1·2·4·8·16일로 바꾸면 지금 복습할 카드는?" 을 과거 답안을 **다시 재생**해 바로 계산할 수 있다. 지금 구조에선 과거 답안 순서가 사라져 불가능하다. 반대로 "읽음 표시" 같은 단순 토글은 상태 저장으로 충분하다 — 한 시스템 안에서도 경계마다 다르게 고른다.

실험 [es-optimistic-concurrency](/event-sourcing/lab/es-optimistic-concurrency) 는 PostgreSQL 테이블 하나로 이벤트 스토어를 만들고 동시 출금을 재현한다. 결과 표의 "버전 검사 없음" 줄이 왜 이벤트 스토어에 `unique(stream_id, version)` 이 필수인지 보여 준다.

## 실습 체크리스트

- [ ] 실험 es-optimistic-concurrency 를 돌리고, 버전 검사 없는 스토어의 잔액이 왜 -100 인지 설명하기
- [ ] 내가 아는 시스템 하나를 골라 "명령 / 이벤트 / 상태" 를 세 개씩 적어 보기
- [ ] 같은 시스템에서 이벤트 소싱이 과잉인 부분과 맞는 부분을 나누기
- [ ] 이 사이트의 퀴즈 기록을 이벤트로 바꿨을 때 새로 할 수 있는 분석 두 가지 적기
