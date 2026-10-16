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
