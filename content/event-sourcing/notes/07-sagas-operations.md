---
title: "심화 — 사가·프로세스 매니저·운영: GDPR 삭제, 감사, 재처리 사고"
order: 7
level: 심화
summary: "여러 집합에 걸친 업무를 이벤트로 잇는 사가(코레오그래피 vs 오케스트레이션)와 프로세스 매니저, 보상 이벤트, 타임아웃. 운영에서 마주치는 일들: 불변 로그와 '잊힐 권리'(암호 삭제·개인정보 분리), 감사·시간 여행 질의, 프로젝션 재처리 사고와 부작용 이중 실행, 모니터링 지표와 런북"
tags: [사가, 프로세스 매니저, 보상, GDPR, 암호 삭제, 감사, 운영, 재처리]
experiments: [es-projection-rebuild, es-optimistic-concurrency]
---

## 집합을 넘는 업무 — 사가

"주문 → 재고 예약 → 결제 → 출고" 는 집합 네 개에 걸친다. 한 트랜잭션으로 묶지 않고(분산 트랜잭션 회피 — [분산 시스템 노트 06](/distributed-systems/notes/06-transactions-coordination)) **이벤트로 잇는다**. 각 단계가 실패하면 앞 단계를 **보상**한다.

```
OrderPlaced ─▶ ReserveStock ─▶ StockReserved ─▶ AuthorizePayment ─▶ PaymentAuthorized ─▶ Ship
                                    │                                   │
                                    └─ StockUnavailable ─▶ CancelOrder  └─ PaymentDeclined ─▶ ReleaseStock ─▶ CancelOrder
```

| 방식 | 모양 | 장점 | 단점 |
|---|---|---|---|
| 코레오그래피 | 각 서비스가 이벤트를 듣고 스스로 다음 명령 | 결합 낮음, 시작이 쉽다 | 흐름이 코드 곳곳에 흩어져 전체가 안 보인다 |
| 오케스트레이션 (프로세스 매니저) | 사가 상태를 가진 조정자가 명령을 보낸다 | 흐름이 한 곳에, 타임아웃·보상이 명확 | 조정자가 중심이 된다 |

**프로세스 매니저는 그 자체가 이벤트 소싱 집합**이 될 수 있다. 상태(`AwaitingPayment`), 받은 이벤트, 보낸 명령이 모두 스트림에 남아 "이 주문은 왜 30분째 결제 대기인가" 에 답할 수 있다.

```ts
// 프로세스 매니저: 이벤트 → (상태 전이) → 명령
on("StockReserved", (pm, e) => { pm.state = "AwaitingPayment"; send(AuthorizePayment(e.orderId)); schedule(Timeout(e.orderId), "15m"); });
on("PaymentDeclined", (pm, e) => { pm.state = "Compensating"; send(ReleaseStock(e.orderId)); send(CancelOrder(e.orderId, "payment_declined")); });
on("Timeout", (pm, e) => { if (pm.state === "AwaitingPayment") { /* 결제 상태를 PG 에 조회 후 결정 */ } });
```

| 사가 함정 | 대책 |
|---|---|
| 보상이 실패한다 | 보상도 재시도 가능한 명령, 끝내 실패하면 사람에게(수동 처리 큐) |
| 이벤트 중복 수신 | 처리 기록(이벤트 ID)으로 멱등 |
| 응답이 영영 안 온다 | 타임아웃 이벤트를 예약하고 상태를 조회해 결정 |
| 보상이 "되돌리기" 가 아니다 | 이미 보낸 메일은 못 지운다 → "취소 안내" 라는 새 사실 |

결제 도메인의 사가·원장은 [아키텍처 노트 09](/architecture/notes/09-payments-ledger-consistency), 메시지 전달 보장은 [메시징 노트 04](/messaging/notes/04-delivery-guarantees-delay).

주문·결제 사가 전체를 멱등 키·원장·외부 PG 타임아웃과 함께 설계하는 사례는 [시스템 디자인 노트 06](/system-design/notes/06-payments-orders).

## 불변 로그와 "잊힐 권리"

GDPR 은 개인정보 삭제를 요구하고, 이벤트 소싱은 로그를 지우지 않는다. 충돌을 푸는 방법:

| 방법 | 설명 | 주의 |
|---|---|---|
| 개인정보 분리 | 이벤트에는 `customerId` 만, 이름·주소는 별도 개인정보 저장소 | 삭제 = 그 저장소의 행 삭제. 가장 깔끔 |
| **암호 삭제 (crypto-shredding)** | 사용자별 키로 이벤트의 개인정보 필드를 암호화, 삭제 요청 시 **키만 파기** | 키 관리 시스템 필요, 프로젝션·백업의 평문 사본도 처리 |
| 이벤트 다시 쓰기 | 해당 이벤트를 마스킹해 다시 쓴다 | 원칙 위반, 최후의 수단, 감사 기록 남기기 |

```json
{ "type": "ShippingAddressChanged",
  "data": { "customerId": "c-331", "address_enc": "AES-GCM(k_c331, '서울시 …')" } }
// 삭제 요청 → keys 테이블에서 k_c331 파기 → 이벤트는 남지만 주소는 영원히 복호화 불가
```

> 잊지 말 것: 프로젝션(읽기 모델), 검색 인덱스, 분석 사본, 로그, **백업**에도 평문이 있다. 삭제 요청은 이 모든 사본에 대한 작업 목록이다. 보안 관점은 [보안 노트 04](/security/notes/04-secrets-management).

## 감사와 시간 여행 질의

이벤트 로그는 감사 질문에 바로 답한다.

```sql
-- "이 계좌가 2026-09-30 자정에 얼마였나?"
select sum(case when type = 'MoneyDeposited' then (data->>'amount')::int else -(data->>'amount')::int end)
from events where stream_id = 'acc-1' and created_at < '2026-10-01';

-- "누가 이 주문의 배송지를 바꿨나?"
select version, metadata->>'actor', metadata->>'occurred_at', data
from events where stream_id = 'order-7731' and type = 'ShippingAddressChanged' order by version;
```

`created_at`(저장 시각)과 `occurred_at`(업무상 발생 시각)을 구분하라. 오프라인에서 일어난 일이 나중에 들어오면 둘이 다르다 — 이벤트 시간과 처리 시간의 구분은 [데이터 엔지니어링 노트 05](/data-engineering/notes/05-stream-processing).

## 재처리 사고 — 가장 흔한 운영 장애

프로젝션 버그를 고치고 처음부터 재생했더니 **고객에게 메일 10만 통이 다시 나갔다** — 실제로 자주 일어나는 사고다.

| 원인 | 예방 |
|---|---|
| 프로젝터 안에 부작용(메일·결제·외부 API) | 프로젝터는 순수하게: 읽기 모델만 갱신. 부작용은 별도 반응기 + 처리 기록 |
| 반응기의 처리 기록이 재구축 때 함께 지워짐 | 처리 기록은 읽기 모델과 별개로 보관 |
| 재생 속도가 너무 빨라 하위 시스템 폭주 | 재처리 속도 제한, 하위로 가는 통합 이벤트는 재생 대상에서 제외 |
| 새 버전 프로젝터와 옛 버전이 동시에 같은 테이블 갱신 | 블루·그린 테이블 ([노트 04](/event-sourcing/notes/04-projections-replay)) |

[es-projection-rebuild](/event-sourcing/lab/es-projection-rebuild) 에서 10만 이벤트 재구축은 202ms 였다. 빠른 재생은 장점이지만, 그 안에 부작용이 섞여 있으면 사고도 그만큼 빨리 퍼진다.

## 모니터링 — 무엇을 볼까

| 지표 | 의미 | 알림 기준 예 |
|---|---|---|
| 프로젝션 지연 (now − 체크포인트 이벤트 시각) | 읽기 모델이 얼마나 뒤처졌나 | p99 > 5초 |
| 낙관적 동시성 충돌률 | 경합이 심한 스트림 | 충돌/명령 > 5% |
| 집합 로딩 이벤트 수 p99 | 스냅샷·스트림 설계 필요 | > 1,000 |
| 사가 체류 시간 (상태별) | 멈춘 업무 흐름 | 결제 대기 > 15분 |
| 업캐스팅 비율 | 옛 스키마가 얼마나 남았나 | 체인 길이 > 3 |

[es-optimistic-concurrency](/event-sourcing/lab/es-optimistic-concurrency) 의 재시도 55회(성공 10건)는 경합이 심한 스트림의 모습이다. 충돌률 지표가 이것을 보여 준다. 알림 설계는 [SRE 노트 03](/sre/notes/03-burn-rate-alerting).

## 예시로 보기 — 이 프로젝트에서

이 사이트의 장애 주입 실험은 작은 사가다. "장애 주입 → 검증 → 원복" 에서 원복이 보상이고, 데드맨 스위치는 **타임아웃 이벤트**다(정해진 시간 안에 정상 원복이 없으면 강제 원복). 실험 프로세스가 죽어도 보상이 실행되도록 조정자를 분리한 것 — 사가의 "조정자 상태는 영속돼야 한다" 원칙을 프로세스 수준에서 구현한 것이다. 설명은 [장애 실험실 노트 04](/chaos/notes/04-gameday-and-automation).

## 심화 — 사가를 견고하게 구현하기

### 상태 기계로 먼저 그린다

```
             StockReserved              PaymentAuthorized
 [Started] ───────────────▶ [AwaitingPayment] ───────────────▶ [Shipping] ──ShipmentDispatched──▶ [Completed]
     │                         │        │
     │ StockUnavailable        │        │ PaymentDeclined / Timeout(결제 실패 확인)
     ▼                         │        ▼
 [Cancelled] ◀── OrderCancelled ── [Compensating] ── ReleaseStock 성공 ──▶ CancelOrder
                                        │
                                        └─ 보상 3회 실패 ──▶ [NeedsManualAction]  (사람 처리 큐)
```

상태 수가 손에 꼽힐 때 그려 두면 "AwaitingPayment 에서 StockUnavailable 이 오면?" 같은 **빠진 전이**가 보인다. 정의되지 않은 (상태, 이벤트) 쌍은 무시가 아니라 로그 + 메트릭으로 남겨야 한다.

### 상태 변경과 명령 발송을 한 트랜잭션에

프로세스 매니저가 상태를 `AwaitingPayment` 로 바꾸고 `AuthorizePayment` 를 큐에 보내는 사이에 죽으면, 상태만 바뀌고 명령은 영영 안 나간다. 아웃박스로 묶는다.

```sql
begin;
insert into events (stream_id, version, type, data) values ('pm-order-7731', 3, 'PaymentRequested', '{…}');
insert into outbox (id, destination, payload) values (gen_random_uuid(), 'payments', '{"type":"AuthorizePayment","orderId":"7731"}');
insert into saga_timeouts (saga_id, kind, due_at) values ('pm-order-7731', 'payment', now() + interval '15 minutes');
commit;
```

```sql
-- 타임아웃 워커: 여러 인스턴스가 같은 행을 집지 않게
select saga_id, kind from saga_timeouts
where due_at <= now() order by due_at limit 100
for update skip locked;
```

결제 서비스는 같은 `AuthorizePayment` 를 두 번 받을 수 있으므로(아웃박스는 최소 한 번 전달) **주문 ID 를 멱등 키**로 처리한다. 타임아웃이 발생해도 바로 실패로 보지 말고 PG 에 결제 상태를 **조회한 뒤** 결정한다 — 응답만 늦었고 결제는 성공했을 수 있다.

## 런북 — "주문이 결제 대기에서 멈췄다"

경보: `saga_stuck_total{state="AwaitingPayment"}` 가 0 보다 큼(15분 초과).

```sql
-- 1. 멈춘 사가 목록과 마지막 이벤트
select stream_id, max(version) as v, max(created_at) as last_at
from events where stream_id like 'pm-order-%'
group by stream_id
having max(created_at) < now() - interval '15 minutes'
   and bool_or(type = 'PaymentRequested') and not bool_or(type in ('PaymentAuthorized','PaymentDeclined','OrderCancelled'));

-- 2. 아웃박스에서 명령이 실제로 나갔나
select id, created_at, published_at from outbox where payload->>'orderId' = '7731';
```

```
# 3. 서비스 경계를 넘어 한 흐름 보기 (Loki)
{app=~"orders|payments"} | json | correlation_id="req-88f" | line_format "{{.ts}} {{.app}} {{.msg}}"
```

| 확인 결과 | 원인 | 조치 |
|---|---|---|
| outbox `published_at` 이 비어 있음 | 발행기(릴레이) 정지 | 릴레이 재시작, 발행 지연 메트릭 확인 |
| 발행됐지만 결제 서비스 로그 없음 | 브로커·구독 문제 | 소비자 지연·DLQ 확인 ([메시징 노트 07](/messaging/notes/07-operations-observability)) |
| 결제 서비스가 PG 호출 후 응답 없음 | PG 타임아웃 | 타임아웃 워커가 PG 조회로 결론 내는지 확인 |
| 타임아웃 행이 남아 있는데 처리 안 됨 | 타임아웃 워커 정지 | 워커 재시작. 밀린 타임아웃이 한꺼번에 터지지 않게 속도 제한 |

조치 후에는 **수동으로 상태를 고치지 말고** 보정 명령(예: `RetryPayment`, `ForceCancel{by: "oncall:kim"}`)을 보내 사가 스트림에 기록이 남게 한다. 수동 SQL 수정은 다음 사고 분석에서 설명할 수 없는 구멍이 된다. 런북 작성법은 [SRE 노트 04](/sre/notes/04-oncall-runbooks).

## 흔한 실수와 오해

- **사가 = 분산 트랜잭션의 대체품이라 격리도 된다**: 사가에는 격리(I)가 없다. 결제 대기 중인 주문의 재고는 다른 사람에게 "예약됨" 으로 보이고, 보상 전까지 중간 상태가 노출된다. 업무적으로 받아들일 수 있는 중간 상태인지 확인해야 한다.
- **코레오그래피가 항상 더 느슨하다**: 단계가 5개를 넘으면 흐름이 이벤트 구독 관계 속에 숨어 "누가 다음을 하나" 를 아무도 모르게 된다. 결합이 코드에서 사라진 게 아니라 보이지 않게 된 것이다.
- **보상은 반드시 성공한다**: 환불 API 도 실패한다. 보상에도 재시도·타임아웃·사람 처리 경로가 필요하다.
- **암호 삭제 후 키 백업이 남아 있다**: 키 관리 시스템의 백업·스냅샷에 키가 살아 있으면 파기가 아니다. 키의 보존 기간도 함께 설계한다.

## 스스로 점검

1. 프로세스 매니저가 상태 변경 후 명령 발송 전에 죽으면? 어떻게 막나? — 명령이 영영 안 나간다. 상태 이벤트·아웃박스·타임아웃을 한 트랜잭션으로.
2. 결제 타임아웃이 났을 때 바로 주문을 취소하면 안 되는 이유는? — 응답만 늦었고 결제는 성공했을 수 있다. PG 에 상태를 조회한 뒤 결정(그리고 결제 요청은 멱등 키로).
3. 사가에 격리가 없다는 것이 사용자에게 어떻게 보이나? — 결제 중인 주문의 재고가 줄어 보이거나, 취소될 주문이 잠깐 "진행 중" 으로 보인다.
4. 멈춘 사가를 운영자가 DB 를 직접 고쳐 풀면 무엇을 잃나? — 감사 기록과 재현성. 보정 명령으로 이벤트를 남겨야 한다.

## 실습 체크리스트

- [ ] 주문 사가를 코레오그래피와 오케스트레이션으로 각각 그리고, 결제 타임아웃 처리 위치 비교하기
- [ ] 암호 삭제를 적용할 때 키를 파기해도 남는 평문 사본 목록 만들기
- [ ] 시간 여행 SQL 로 특정 시점 잔액을 구하고 created_at·occurred_at 차이가 결과를 바꾸는 예 만들기
- [ ] "재생 때 메일이 다시 나간다" 를 막는 처리 기록 테이블 스키마 설계하기
