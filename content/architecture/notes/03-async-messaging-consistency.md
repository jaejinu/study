---
title: 비동기·메시징과 데이터 일관성
order: 3
level: 중급
summary: 동기 호출 체인의 문제, 큐·이벤트의 쓰임과 전달 보장, 멱등성 설계, Outbox 와 CDC, Saga(코레오그래피·오케스트레이션)와 보상 트랜잭션, 정확히 한 번의 환상, 순서 보장, 백프레셔. 실험과 연결
tags: [비동기, 메시징, 멱등성, Outbox, Saga, 보상트랜잭션, 백프레셔]
experiments: []
---

## 동기 호출 체인의 문제

```
주문 API ─▶ 재고 서비스 ─▶ 결제 서비스 ─▶ 알림 서비스
```
- 가용성이 곱해진다: 각 99.9% × 4 = 99.6%.
- 지연이 더해진다. 느린 서비스 하나가 전체를 잡는다.
- 알림 장애가 주문 실패로 번진다 (강결합).

**비동기**로 바꾸면: 주문은 DB 에 쓰고 이벤트를 발행한 뒤 즉시 응답. 재고·알림은 이벤트를 각자 소비. 장애가 격리되고 피크가 완충된다. 대가: **최종 일관성**과 복잡성.

## 큐 vs 이벤트 스트림

| | 작업 큐 (Redis List, SQS, RabbitMQ) | 이벤트 스트림 (Kafka, Redis Stream) |
|---|---|---|
| 의미 | "이 일을 해라" (명령) | "이 일이 있었다" (사실) |
| 소비자 | 하나가 가져가면 끝 | 여러 그룹이 독립적으로 |
| 재처리 | 어려움 | 오프셋 되감기 |
| 용도 | 이메일 발송, 썸네일 생성 | 주문 이벤트, 감사 로그, 파이프라인 |

[Redis 메시징 노트](/redis/notes/07-pubsub-streams), [Kafka 노트](/kafka/notes/01-kafka-overview).

## 전달 보장과 멱등성

네트워크에서 "정확히 한 번" 은 없다. 보내는 쪽은 ACK 를 못 받으면 **재전송**해야 하고(at-least-once), 그러면 받는 쪽은 **중복**을 감당해야 한다. 결론: **모든 소비자는 멱등해야 한다.**

```sql
-- 멱등 소비자: 처리한 메시지 ID 를 같은 트랜잭션에 기록
BEGIN;
INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING;
-- 삽입된 행이 0 이면 이미 처리 → 커밋만 하고 종료
UPDATE inventory SET qty = qty - $2 WHERE sku = $3;
COMMIT;
```

- 자연 멱등: `SET`, upsert, "상태를 X 로" (증감이 아니라 절대값).
- 멱등 키: 클라이언트가 생성한 UUID 를 요청에 실어 서버가 중복 식별 (결제 API 의 `Idempotency-Key`). Redis `SET key NX EX` 로 빠른 중복 체크 + DB 영구 기록.
- 외부 부작용(이메일)은 멱등 키와 함께 기록하고 재시도 시 건너뛴다.

## 이중 쓰기 문제와 Outbox

"DB 에 주문 저장 + Kafka 에 이벤트 발행" 을 둘 다 하면, 둘 사이에 죽을 때 불일치가 난다(저장됐지만 이벤트 없음, 또는 반대).

![Outbox 패턴](/diagrams/outbox-pattern.svg)

**Outbox**: 같은 DB 트랜잭션에서 `orders` 와 `outbox` 테이블에 함께 쓴다. 별도 릴레이가 outbox 를 읽어 Kafka 에 발행하고 표시. 릴레이가 죽어도 outbox 에 남아 있으니 유실 없음(중복 가능 → 소비자 멱등).

```sql
BEGIN;
INSERT INTO orders (...) VALUES (...);
INSERT INTO outbox (id, topic, key, payload) VALUES (gen_random_uuid(), 'order.created', $order_id, $json);
COMMIT;
-- 릴레이: SELECT ... FROM outbox WHERE published = false ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED → 발행 → UPDATE published = true
```

**CDC(Change Data Capture)**: Debezium 이 DB 의 WAL/binlog 를 읽어 변경을 Kafka 로 — outbox 테이블을 폴링 없이 스트리밍. [PostgreSQL 논리 복제](/postgres/notes/05-operations) 가 기반. [SKIP LOCKED 실험](/postgres/lab/pg-row-locks) 이 릴레이의 핵심.

## 분산 트랜잭션 — Saga

여러 서비스의 DB 를 한 트랜잭션으로 묶을 수 없다(2PC 는 느리고 취약). **Saga** 는 로컬 트랜잭션의 연쇄 + 실패 시 **보상 트랜잭션**.

```
주문 생성 → 재고 예약 → 결제 승인 → 배송 요청
    ↑ 실패 시 역순 보상: 배송 취소 ← 결제 취소 ← 재고 해제 ← 주문 취소
```

| 방식 | 조정자 | 장단 |
|---|---|---|
| 코레오그래피 | 없음. 각 서비스가 이벤트에 반응 | 단순, 느슨. 흐름이 흩어져 추적 어려움 |
| 오케스트레이션 | 중앙 Saga 코디네이터(상태 머신) | 흐름이 한곳에. 코디네이터 운영 |

- 보상은 "취소" 지 "되돌리기" 가 아니다 — 이메일은 보낸 뒤 "취소 메일" 을 보낸다.
- 중간 상태가 사용자에게 보인다("결제 처리 중"). UI 가 이를 다루게 설계.
- 워크플로 엔진(Temporal)이 오케스트레이션 + 재시도 + 내구성을 제공.

## 순서

- 전역 순서는 포기한다. **같은 엔티티(주문 ID)의 순서**만 보장: Kafka 파티션 키, Redis Stream 하나, 단일 워커.
- 순서가 뒤바뀐 이벤트를 처리하려면 버전 번호(낙관적 잠금)로 오래된 이벤트를 무시.
- 재처리 시에도 순서가 유지되는지 확인 ([Kafka 오프셋 실험](/kafka/lab/kafka-offsets-replay)).

## 백프레셔와 과부하

- 생산 > 소비면 큐가 무한히 자란다. **경계 큐**(최대 길이) + 생산자 차단/거부, 또는 소비자 스케일(KEDA 로 LAG 기반 오토스케일).
- 소비자는 배치·병렬로, 그러나 DB 가 감당할 만큼만 (동시성 제한).
- 우선순위 큐: 긴급 작업을 별도 토픽/리스트로.
- 죽은 편지(DLQ): 반복 실패 메시지는 옆으로 빼서 흐름을 막지 않는다 ([Kafka 전달 보장](/kafka/notes/04-delivery-guarantees)).

## 예시: 주문 처리

```
POST /orders ─▶ 주문 서비스: BEGIN; INSERT orders; INSERT outbox; COMMIT → 201 (주문 ID, 상태 PENDING)
릴레이 ─▶ Kafka order.created (key=order_id)
재고 서비스(그룹 inventory) ─▶ 예약, 멱등(event_id), 발행 inventory.reserved / inventory.failed
결제 서비스(그룹 payment) ─▶ inventory.reserved 받으면 결제, 발행 payment.approved / payment.failed
주문 서비스 ─▶ 결과 이벤트로 상태 갱신(CONFIRMED / CANCELLED + 보상 이벤트)
알림 서비스(그룹 notify) ─▶ 모든 상태 변화를 사용자에게
```

실패 시나리오를 하나씩 따라가 보자: 재고 서비스가 죽으면? (Kafka 에 남아 재시작 후 처리) 결제가 승인됐는데 주문 서비스가 이벤트를 못 받으면? (재전송·멱등) 같은 이벤트가 두 번 오면? (processed_events).

## 실습 체크리스트

- [ ] Kafka 컨슈머 그룹 실험으로 fan-out 확인
- [ ] PostgreSQL SKIP LOCKED 실험을 outbox 릴레이로 상상하며 읽기
- [ ] 멱등 소비자 SQL 을 study DB 에 직접 작성해 같은 event_id 두 번 처리해 보기
- [ ] 주문 Saga 의 보상 트랜잭션 표 만들기 (단계별 보상 동작)
