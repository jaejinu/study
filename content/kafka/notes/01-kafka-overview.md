---
title: Kafka 란 무엇인가
order: 1
level: 기초
summary: 로그 기반 이벤트 스트리밍의 핵심 모델, 브로커·토픽·파티션·오프셋, 큐·Pub/Sub 과의 차이, KRaft
tags: [개요, 로그, 브로커, KRaft, 이벤트스트리밍]
experiments: [kafka-produce-consume]
---

## 한 줄 정의

Kafka 는 **분산 append-only 로그**다. 프로듀서가 이벤트를 토픽에 쓰고, 컨슈머가 자기 속도로 읽는다. 메시지는 읽혀도 사라지지 않고 보존 기간 동안 남는다.

## 핵심 모델

```
Producer ──▶ Topic "orders"
               ├─ Partition 0: [0][1][2][3][4] ──▶ Consumer A (group g1)
               ├─ Partition 1: [0][1][2]       ──▶ Consumer B (group g1)
               └─ Partition 2: [0][1][2][3]    ──▶ Consumer B (group g1)
                                               └─▶ Consumer C (group g2, 전부 읽음)
```

| 개념 | 설명 |
|---|---|
| **Broker** | Kafka 서버 프로세스. 여러 대가 클러스터를 이룬다 |
| **Topic** | 이벤트의 논리적 분류 (테이블 이름과 비슷) |
| **Partition** | 토픽을 나눈 물리적 로그. 병렬성과 순서 보장의 단위 |
| **Offset** | 파티션 안에서 메시지의 순번. 컨슈머가 "어디까지 읽었나" 를 기록 |
| **Consumer Group** | 파티션을 나눠 읽는 컨슈머 집합. 그룹마다 독립 오프셋 |
| **Replication** | 파티션을 여러 브로커에 복제 (leader / follower, ISR) |

![토픽·파티션·그룹](/diagrams/kafka-topology.svg)

### 예시로 보기: 주문 이벤트 설계

```
토픽 order.events (파티션 12, 보존 7일, 키 = orderId)
  key=order-1  value={"type":"created","amount":89000}     → p7, offset 0
  key=order-1  value={"type":"paid"}                       → p7, offset 1   ← 같은 키, 같은 파티션, 순서 보장
  key=order-2  value={"type":"created"}                    → p3, offset 0
그룹 inventory (워커 3) : p0-3 / p4-7 / p8-11 로 분배, 재고 예약
그룹 analytics (워커 1) : 전부 받아 집계 (독립 오프셋)
그룹 email (워커 2)     : paid 만 골라 영수증 발송 (나머지는 건너뜀)
```
워커가 죽어도 커밋 안 된 오프셋부터 다시 받으므로 "재고 예약" 은 orderId 로 멱등해야 한다. 실험실의 세 실험이 이 그림의 파티션 배치·분배·재처리를 각각 보여준다.

## 큐·Pub/Sub 과의 차이

| | Redis List / RabbitMQ 큐 | Redis Pub/Sub | Kafka |
|---|---|---|---|
| 소비 후 메시지 | 삭제 | 저장 안 함 | **보존** (retention) |
| 여러 소비자 그룹 | 복제 필요 | 자연스러움 | 자연스러움 (그룹별 오프셋) |
| 재처리 | 불가 | 불가 | 오프셋 되감기 |
| 순서 | 큐 전체 | 없음 | 파티션 내 보장 |
| 처리량 | 중간 | 중간 | 매우 높음 (순차 I/O, 배치, zero-copy) |

Redis Stream 은 Kafka 의 축소판이라 할 수 있다 (컨슈머 그룹, ID 기반 재읽기).

## 왜 빠른가

- 디스크에 **순차 쓰기**만 한다. 랜덤 I/O 가 없어 HDD 에서도 빠르다.
- OS 페이지 캐시를 적극 활용하고 `sendfile` 로 **zero-copy** 전송.
- 프로듀서·컨슈머 모두 **배치**로 주고받는다 (`linger.ms`, `batch.size`, `fetch.min.bytes`).
- 브로커는 메시지를 해석하지 않는다. 바이트 그대로 저장.

## ZooKeeper 에서 KRaft 로

예전엔 메타데이터(브로커 목록, 파티션 리더)를 ZooKeeper 에 두었다. Kafka 3.3+ 의 **KRaft** 모드는 브로커 중 일부가 컨트롤러 역할을 하며 Raft 로 메타데이터를 합의한다. 운영 컴포넌트가 하나 줄고 메타데이터 처리가 빨라졌다. 이 프로젝트의 compose 는 KRaft 단일 노드(브로커+컨트롤러 겸임)다.

## 어디에 쓰나

- 이벤트 소싱 / 변경 데이터 캡처(CDC, Debezium)
- 서비스 간 비동기 통합 (주문 → 결제 → 배송)
- 로그·메트릭 파이프라인 (앱 → Kafka → Elasticsearch/S3)
- 스트림 처리 (Kafka Streams, Flink)

## 실전에서는 어디에 쓰이나 — Kafka 지도

> Kafka 는 서비스 사이를 흐르는 이벤트의 "중앙 로그" 역할을 한다. 한 번 쓴 이벤트를 여러 팀이 각자 속도로 읽고, 필요하면 되감아 다시 읽을 수 있다는 점이 일반 큐와 다른 쓰임을 만든다. 원래 LinkedIn 이 활동 데이터 파이프라인을 위해 만들어 오픈소스로 공개했다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 커머스 주문 → 결제·재고·알림 | 키 기반 파티션 순서, acks, 보존 | [토픽·파티션·프로듀서](/kafka/notes/02-topics-partitions) |
| 같은 이벤트를 여러 팀이 각자 소비 | 컨슈머 그룹, LAG, 리밸런스, 재처리 | [컨슈머 그룹·오프셋·리밸런스](/kafka/notes/03-consumer-groups) |
| 결제·포인트처럼 중복·유실이 안 되는 곳 | at-least-once + 멱등 소비자, DLQ | [전달 보장과 설계 패턴](/kafka/notes/04-delivery-guarantees) |
| 대용량 로그·클릭스트림 수집 | 순차 I/O, 페이지 캐시, 복제와 ISR | [Kafka 내부](/kafka/notes/05-internals-storage-replication) |
| 실시간 집계·사기 탐지·저장소 연동 | Kafka Streams, Connect, Schema Registry | [Streams·Connect·Schema](/kafka/notes/06-streams-connect-schema) |
| 사내 공용 Kafka 플랫폼 | 파티션 산정, 모니터링, ACL·쿼터, 용량 | [운영과 튜닝](/kafka/notes/07-operations-tuning) |
| DB 변경을 이벤트·검색·캐시로 | Outbox, CDC, Debezium | [CDC 와 Outbox](/kafka/notes/08-cdc-outbox-debezium) |

**회사 규모에 따라** — 스타트업은 대개 Kafka 가 아직 필요 없어 DB 큐(SKIP LOCKED)·Redis Stream·관리형 큐로 시작하고, 쓰더라도 관리형 Kafka 를 쓴다.
성장기에는 서비스가 늘어 여러 팀이 같은 이벤트를 구독하게 되면서 Kafka 를 도입하고, Outbox/CDC 로 DB 와 정합을 맞추며 Schema Registry 로 이벤트 계약을 관리한다.
대규모 조직에서는 데이터 플랫폼 팀이 여러 클러스터를 공용 인프라로 운영하며 토픽 소유권·ACL·쿼터·보존 비용·리전 간 복제를 관리한다.

**이럴 땐 안 맞는다**
- 작업 하나를 워커 하나가 처리하고 끝나는 단순 작업 큐 → 메시지별 확인·지연 재시도·우선순위는 RabbitMQ·SQS 같은 큐가 더 편하다.
- 즉시 응답이 필요한 요청-응답 호출 → 이벤트 로그로 RPC 를 흉내 내면 복잡도만 는다. HTTP·gRPC 로.
- 트래픽이 작은 초기 서비스 → 브로커 클러스터 운영 부담이 이득보다 크다.

**누가 매일 만나나** — 백엔드 개발자는 이벤트를 발행·소비하며 키와 멱등성을 고민하고, 데이터 엔지니어는 토픽을 데이터 레이크·검색으로 잇고, SRE·플랫폼 팀은 LAG·UnderReplicatedPartitions 알림을 받는다.

## 이 노트 시리즈의 실습

```bash
pnpm kafka:up                     # apache/kafka:3.9.1 KRaft, 호스트 포트 19092
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
pnpm kafka:down
```

실험실은 kafkajs 로 브로커에 붙어 파티션 배치, 컨슈머 그룹 분배, 오프셋 리셋을 실제로 보여준다. CLI 도구는 컨테이너 안 `/opt/kafka/bin/` 에 있다.

## 관련 노트

- [Redis 메시징 — List, Pub/Sub, Stream](/redis/notes/07-pubsub-streams) — Stream 과의 비교
- [토픽·파티션·프로듀서](/kafka/notes/02-topics-partitions)

> 이어서 읽기: [큐·토픽·로그 — 메시징의 세 가지 모델](/messaging/notes/01-queue-topic-log-models) — 큐·토픽·로그 세 모델 속에서 Kafka 의 자리 · [Kafka 를 쓰지 말아야 할 때 — 브로커 선택 기준](/messaging/notes/05-when-not-kafka) — Kafka 를 쓰지 말아야 할 때
