---
title: "심화 — 같은 워크로드, 네 브로커: 실측 비교와 아웃박스·사가 구현"
order: 6
level: 심화
summary: "1만 메시지를 Redis Streams·Kafka·RabbitMQ·NATS core·JetStream 으로 흘려 잰 처리량·지연을 보장 수준과 함께 읽는 법, 벤치마크가 거짓말하는 지점(묶음 크기·조정 누락·로컬 환경·단일 노드), 같은 소비자 코드를 네 브로커로 옮길 때 바뀌는 것, 그리고 아웃박스 발행기와 주문 사가를 각 브로커로 구현할 때의 차이를 정리한다"
tags: [벤치마크, Redis Streams, Kafka, RabbitMQ, NATS, JetStream, 아웃박스, 사가, 처리량, 지연]
experiments: [mq-broker-benchmark, mq-rabbit-dlx-retry, mq-nats-jetstream-ack]
---

## 실험 설계

실험 `mq-broker-benchmark` 는 한 프로세스에서 다섯 경로를 같은 조건으로 잰다.

- 메시지 1만 건, 각 256바이트. 앞 4바이트에 순번을 넣는다.
- 소비자를 먼저 띄우고, 생산자는 **500개 묶음**으로 보낸다.
- 지연 = "발행 직전 시각 → 소비 콜백 시각". 한 프로세스라 시계가 같다.
- 처리량 = 1만 ÷ (마지막 수신 − 첫 발행).

| 경로 | 생산 | 소비 | 보장 |
|---|---|---|---|
| Redis Streams | 파이프라인 `XADD` × 500 | `XREAD BLOCK 200 COUNT 2000` | 메모리 + AOF 설정에 따름 |
| Kafka | `producer.send(500개, acks=-1)` | `eachBatch` | acks=all (복제 1) |
| RabbitMQ | confirm 채널 `sendToQueue` × 500 + `waitForConfirms` | prefetch 1000 + ack | persistent + 퍼블리셔 확인 |
| NATS core | `publish` × 500 + `flush` | `subscribe` | 저장 없음 |
| NATS JetStream | `Promise.all(js.publish × 500)` | `consume` + ack | 파일 저장 + PubAck + 명시적 ack |

## 결과

이 노트북(Apple Silicon), Docker Desktop 포트 포워딩, 브로커 하나짜리 환경의 실측이다.

| 브로커 | 보장 | 발행 (ms) | 종단 (ms) | 처리량 (msg/s) | p50 (ms) | p99 (ms) |
|---|---|---|---|---|---|---|
| NATS core | 저장 없음 | 38 | 37 | 267,137 | 1.2 | 4.6 |
| Redis Streams | 메모리 + AOF | 61 | 61 | 163,751 | 3.6 | 7.7 |
| Kafka | acks=all, 복제 1 | 92 | 95 | 105,709 | 9.4 | 21.6 |
| RabbitMQ | persistent + confirm | 148 | 148 | 67,697 | 4.2 | 10.7 |
| NATS JetStream | 파일 + PubAck + ack | 223 | 224 | 44,721 | 6.9 | 18.4 |

## 읽는 법

### 1. 보장 열을 먼저 본다

순위는 거의 **보장 수준의 역순**이다. 디스크에 쓰지 않고 확인도 없는 NATS core 가 1위다. 파일에 쓰고, 서버가 PubAck 를 주고, 소비자가 ack 를 돌려보내는 JetStream 이 마지막이다. 같은 NATS 서버인데 6배 차이가 난다. 이 차이가 "보장의 값" 이다.

### 2. Kafka 의 p99 가 큰 이유

Kafka 는 처리량 2위인데 p99 는 가장 크다. 프로듀서가 묶어 보내고 소비자가 묶어 가져가는(fetch) 구조라, 묶음 안의 앞 메시지가 뒤 메시지를 기다리는 시간이 지연에 섞인다. `linger.ms`·`fetch.max.wait.ms` 를 줄이면 지연이 줄고 처리량도 준다. **처리량과 지연은 같은 손잡이의 양 끝**이다.

### 3. RabbitMQ 의 발행 시간

RabbitMQ 는 p50 이 낮은데(4.2ms) 발행 시간이 길다. 퍼블리셔 확인을 500개마다 기다리기 때문이다. 확인 창을 키우거나(묶음 크기 ↑), 확인을 비동기 콜백으로 받으면 늘어난다.

### 4. Redis Streams 가 빠른 이유와 대가

Redis 는 메모리에 쓰고 AOF 는 기본 `everysec` 다. 즉 마지막 1초는 장애 시 잃을 수 있다. `appendfsync always` 로 바꾸면 이 표의 자리가 크게 바뀐다. [Redis 영속성](/redis/notes/04-persistence) 과 [데이터베이스 내부의 WAL](/db-internals) 이 같은 트레이드오프를 다룬다.

## 벤치마크가 거짓말하는 지점

이 표를 "RabbitMQ 는 초당 6.8만" 으로 외우면 안 된다. 다음 요인이 결과를 몇 배씩 바꾼다.

| 요인 | 이 실험 | 운영에서는 |
|---|---|---|
| 묶음 크기 | 500 | 한 건씩 기다리면 모든 경로가 RTT 에 묶여 수천/초로 떨어진다 |
| 메시지 크기 | 256B | 10KB 면 네트워크·디스크가 병목 |
| 노드 수·복제 | 1, 복제 없음 | 3노드 복제면 쓰기마다 과반 왕복 — Kafka acks=all, quorum 큐, JetStream R3 모두 느려짐 |
| 네트워크 | 로컬 루프백 + Docker 포워딩 | 서버 간 RTT 0.2~1ms |
| 소비자 처리 | 아무것도 안 함 | 실제 처리 시간이 대부분을 차지 |
| 측정 시간 | 수백 ms | 디스크 캐시·GC·세그먼트 롤링이 드러나려면 수 분 이상 |
| 부하 모델 | 닫힌 모델(묶음 완료 후 다음) | 열린 모델이 아니면 [조정 누락](/performance/notes/01-language-of-performance) 으로 지연이 과소평가 |

그래서 이 실험의 결론은 숫자 자체가 아니라 **상대적 성격**이다. 저장·확인이 붙을수록 느려지고, 묶음이 지연을 만들고, 이 규모(초당 수만)에서는 다섯 경로 모두 충분하다는 것이다. 실제 선택은 [모델](/messaging/notes/01-queue-topic-log-models)과 [운영 비용](/messaging/notes/05-when-not-kafka)으로 한다.

## 같은 소비자, 네 브로커

"주문 생성 이벤트를 받아 재고를 줄인다" 소비자를 네 브로커로 쓰면 무엇이 달라질까.

| 관심사 | Redis Streams | Kafka | RabbitMQ | JetStream |
|---|---|---|---|---|
| 경쟁 소비자 | 소비자 그룹 `XREADGROUP` | 컨슈머 그룹 (≤ 파티션 수) | 같은 큐를 여럿이 consume | 같은 durable 을 여럿이 pull |
| 확인 | `XACK` | 오프셋 커밋 (파티션당 하나) | `ack` (메시지별) | `ack` (메시지별) |
| 죽은 소비자의 미확인 메시지 | `XAUTOCLAIM` 로 직접 회수 | 리밸런스 후 마지막 커밋부터 | 연결 끊기면 자동 재배달 | ack_wait 후 자동 재배달 |
| 재시도 지연 | 직접 (Sorted Set 등) | 재시도 토픽 직접 | DLX + TTL | `nak(delay)` |
| 독 메시지 | `XPENDING` 의 배달 횟수 보고 직접 | DLT 직접 | `x-delivery-limit` (quorum) | `max_deliver` + 어드바이저리 |
| 엔티티별 순서 | 스트림을 키로 샤딩 | 파티션 키 | 큐를 키로 샤딩 (consistent-hash 익스체인지) | subject 에 키 + 컨슈머 분리 |
| 재처리 | `XRANGE` 로 처음부터 | 오프셋 리셋 | 불가 (Streams 큐 제외) | 새 컨슈머 `DeliverPolicy.All` |

Redis Streams 는 가장 가볍지만 **브로커가 대신 해 주는 일이 가장 적다**. 미확인 메시지 회수, 재시도 지연, 독 메시지 처리를 모두 앱이 한다. JetStream 과 RabbitMQ 는 그것들을 설정으로 준다.

## 아웃박스 발행기를 각 브로커로

[아웃박스 패턴](/kafka/notes/08-cdc-outbox-debezium) 은 DB 트랜잭션에 이벤트를 함께 쓰고, 별도 발행기가 그것을 브로커로 옮긴다. 발행기의 핵심은 "브로커가 받았다는 확인을 받은 뒤에만 아웃박스 행을 발행 완료로 표시" 하는 것이다.

```ts
// 공통 골격: 폴링 발행기
const rows = await db.query(
  "SELECT id, topic, key, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED",
);
await publishBatch(rows);                                   // ← 브로커별로 다름
await db.query("UPDATE outbox SET published_at = now() WHERE id = ANY($1)", [rows.map((r) => r.id)]);
```

| 브로커 | `publishBatch` 의 확인 | 중복 제거 |
|---|---|---|
| Kafka | `producer.send({ acks: -1 })` 완료 | 멱등 프로듀서 + 소비자 멱등 (`outbox.id` 를 헤더로) |
| RabbitMQ | confirm 채널 `waitForConfirms()` | `messageId = outbox.id`, 소비자 멱등 |
| JetStream | 모든 `js.publish` 의 PubAck | `msgID = outbox.id` → 발행기 재시작으로 인한 중복을 서버가 제거 |
| Redis Streams | `XADD` 응답 | `XADD key <outbox.id 기반 ID>` 로 같은 ID 거절 (단조 증가 필요) |

발행 후 `UPDATE` 전에 발행기가 죽으면 같은 행을 다시 발행한다. 그래서 아웃박스는 본질적으로 at-least-once 다. JetStream 의 `msgID` 는 이 중복을 duplicate window 안에서 서버가 걸러 주는 드문 경우다.

## 주문 사가를 각 브로커로

[사가](/distributed-systems/notes/06-transactions-coordination) 는 여러 서비스의 단계를 이벤트로 잇고 실패하면 보상한다.

```
주문 생성 → 재고 예약 → 결제 → 배송 요청
                ↑ 실패 시: 결제 취소 ← 재고 해제 ← 주문 취소 (보상)
```

| 측면 | 어울리는 브로커 | 이유 |
|---|---|---|
| 단계 명령 ("재고를 예약하라") | RabbitMQ, JetStream WorkQueue | 한 서비스만 처리, 개별 재시도·지연 |
| 단계 결과 이벤트 ("재고 예약됨") | Kafka, JetStream Limits | 여러 구독자(오케스트레이터, 분석, 알림), 재생 |
| 타임아웃 ("결제가 30분 안에 안 오면 취소") | RabbitMQ TTL, JetStream nak 지연, Redis Sorted Set | [지연 메시지](/messaging/notes/04-delivery-guarantees-delay) |
| 사가 상태 | DB (오케스트레이터) | 브로커는 상태 저장소가 아니다 |

실무에서는 섞는다. "이벤트는 Kafka, 명령과 타임아웃은 작업 큐" 가 흔한 조합이다. 하지만 브로커가 둘이 되면 운영도 두 배다. JetStream 처럼 한 제품에서 보존 정책으로 두 모델을 다 주는 선택지가 이 지점에서 매력적이다.

## 실습 체크리스트

- [ ] `pnpm kafka:up` 과 `pnpm mq:up` 상태에서 실험 `mq-broker-benchmark` 를 두 번 돌려 숫자가 얼마나 흔들리는지 보기
- [ ] 실험 코드의 묶음 크기 500 을 1 로 바꾸면 각 경로의 처리량이 어떻게 될지 예측하고 이유를 RTT 로 설명하기
- [ ] 위 결과표에서 Kafka 가 처리량 2위인데 p99 가 가장 큰 이유를 묶음과 폴링으로 설명하기
- [ ] "같은 소비자, 네 브로커" 표에서 Redis Streams 를 쓸 때 앱이 직접 구현해야 하는 것을 모두 나열하기
- [ ] 주문 사가의 "결제 30분 타임아웃" 을 RabbitMQ·JetStream·Redis 로 각각 구현하는 방법을 한 줄씩 적기
