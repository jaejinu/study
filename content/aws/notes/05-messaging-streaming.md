---
title: "메시징·스트리밍 — SQS·SNS·EventBridge·MSK·Kinesis 를 Kafka·RabbitMQ·NATS 실험과 비교하기"
order: 5
level: 중급
summary: "큐·토픽·로그 세 모델(메시징 01)이 AWS 에서 어떤 서비스가 되는지: SQS 표준·FIFO, 가시성 타임아웃·롱 폴링·DLQ·redrive, SNS 팬아웃과 필터, EventBridge 규칙·스키마·아카이브, MSK 와 Kinesis 의 샤드·파티션, S3 이벤트 알림, 그리고 실험으로 보는 s3:TestEvent·재전달·DLQ"
tags: [SQS, SNS, EventBridge, MSK, Kinesis, DLQ, 가시성 타임아웃, 팬아웃, S3 이벤트 알림]
experiments: [aws-s3-sqs-pipeline]
---

## 세 모델 → AWS 서비스

[메시징 01](/messaging/notes/01-queue-topic-log-models)의 분류가 그대로 쓰인다.

| 모델 | 이 사이트에서 직접 | AWS |
|---|---|---|
| 큐 (경쟁 소비자, 처리하면 사라짐) | RabbitMQ, Redis List, NATS 큐 그룹 | **SQS** |
| 토픽 (팬아웃, 구독자마다 사본) | RabbitMQ fanout, Redis Pub/Sub | **SNS** |
| 이벤트 버스 (내용 기반 라우팅) | RabbitMQ topic exchange | **EventBridge** |
| 로그 (보존·재생·순서) | Kafka, Redis Streams, JetStream | **MSK**, **Kinesis Data Streams** |

## SQS — 매니지드 큐

| 속성 | 표준 큐 | FIFO 큐 |
|---|---|---|
| 처리량 | 사실상 무제한 | 큐당 초당 300 (배치 3,000), 고처리량 모드면 훨씬 큼 |
| 순서 | 대략적 (보장 없음) | 메시지 그룹 ID 안에서 엄격 |
| 중복 | **최소 한 번** — 중복 가능 | 5분 창 중복 제거(중복 제거 ID) |
| 맞는 곳 | 대부분의 작업 큐 | 주문 단위 순서가 중요한 처리 |

FIFO 의 **메시지 그룹 ID** 는 Kafka 의 파티션 키와 같은 역할이다. 같은 그룹은 한 번에 한 소비자만 처리해 순서를 지킨다([Kafka 02](/kafka/notes/02-topics-partitions)).

### 가시성 타임아웃과 재전달

SQS 는 **삭제할 때까지 메시지를 지우지 않는다.** 받는 순간 메시지는 가시성 타임아웃 동안 숨겨질 뿐이고, 그 안에 `DeleteMessage` 를 하지 않으면 다시 나타난다. 이것이 at-least-once 의 구현이다.

[S3 → SQS 실험](/aws/lab/aws-s3-sqs-pipeline)은 이 동작을 그대로 보여 준다.

```
1번째 받기  ApproximateReceiveCount=1  ObjectCreated:Put in/report.csv   (삭제 안 함)
(2초 후 — 가시성 타임아웃 2초)
2번째 받기  ApproximateReceiveCount=2  같은 MessageId                    (삭제 안 함)
3번째 받기  큐에 없음 → maxReceiveCount(2) 를 넘겨 DLQ 로 이동
DLQ 확인   같은 MessageId 가 있다
redrive    DLQ → 원래 큐 → 이번엔 처리하고 삭제
```

![S3 → SQS → DLQ → redrive](/diagrams/aws-sqs-dlq.svg)

| 설정 | 의미 | 정하는 법 |
|---|---|---|
| VisibilityTimeout | 처리 중 숨김 시간 | 최악 처리 시간 + 여유. 짧으면 처리 중에 다른 소비자가 또 받는다 |
| ChangeMessageVisibility | 처리 중 연장 | 긴 작업은 하트비트처럼 연장 |
| ReceiveMessageWaitTimeSeconds | **롱 폴링** (최대 20초) | 빈 응답·요청 비용을 줄인다. 거의 항상 켠다 |
| RedrivePolicy (maxReceiveCount) | N번 받고도 삭제 안 되면 DLQ | 3~5. 독 메시지가 큐를 막지 않게 |
| DelaySeconds | 보내고 N초 뒤부터 보임 | 지연 재시도 ([메시징 04](/messaging/notes/04-delivery-guarantees-delay)) |
| MessageRetentionPeriod | 최대 14일 | DLQ 는 길게 |

이 사이트의 [RabbitMQ DLX 지연 재시도 실험](/messaging/lab/mq-rabbit-dlx-retry)과 비교하면 같은 패턴이다. RabbitMQ 는 nack + TTL 큐 + DLX 로 직접 조립했고, SQS 는 가시성 타임아웃 + RedrivePolicy 로 내장돼 있다.

### s3:TestEvent 의 함정

S3 버킷에 알림을 연결하면 **연결 직후 `s3:TestEvent` 메시지가 한 번 온다.** `Records` 가 없는 형식이라, 이벤트를 무조건 `Records[0]` 로 파싱하는 소비자는 첫 메시지에서 예외를 던지고 — 그 메시지는 재전달되다 DLQ 로 간다. 실험의 첫 검사가 이것이다. 실제 AWS 에서도 똑같이 일어난다.

## SNS — 팬아웃

SNS 토픽에 한 번 발행하면 구독자(SQS 큐, Lambda, HTTP, 이메일)마다 사본이 간다. **SNS → 여러 SQS** 가 정석 팬아웃이다. 각 소비 서비스가 자기 큐를 가지므로 속도·장애가 서로 격리된다.

- **구독 필터 정책**: 메시지 속성·본문으로 구독자별로 걸러 받는다.
- SNS FIFO + SQS FIFO 로 순서 있는 팬아웃.
- SNS 자체는 저장하지 않는다 — 구독 큐가 버퍼다.

## EventBridge — 이벤트 버스

AWS 서비스 이벤트, SaaS 이벤트, 내 앱 이벤트를 **규칙(이벤트 패턴)** 으로 대상(Lambda·SQS·Step Functions·API)에 보낸다.

```json
{ "source": ["study.orders"], "detail-type": ["OrderPaid"], "detail": { "amount": [{ "numeric": [">", 100000] }] } }
```

| 기능 | 쓰임 |
|---|---|
| 내용 기반 라우팅 | 큐마다 필터를 두는 대신 버스에서 |
| 스키마 레지스트리 | 이벤트 모양 탐지·코드 생성 ([API 설계 07](/api-design/notes/07-versioning-evolution-governance)의 계약) |
| 아카이브 & 재생 | 지난 이벤트를 다시 흘리기 — 로그 모델의 일부를 흉내 |
| EventBridge Pipes | SQS·Kinesis·DynamoDB 스트림 → 필터·변환 → 대상, 코드 없이 |
| 스케줄러 | cron·일회성 예약 |

EventBridge 는 **최소 한 번 + 순서 보장 없음**이다. 순서와 재생이 핵심이면 로그(MSK·Kinesis)를 쓴다.

## MSK 와 Kinesis — 로그

| | MSK (매니지드 Kafka) | Kinesis Data Streams |
|---|---|---|
| API | Kafka 그대로 — kafkajs·Connect·Debezium 그대로 | AWS 전용 SDK·KCL |
| 확장 단위 | 브로커·파티션 | **샤드** (샤드당 쓰기 1MB/s·1,000건, 읽기 2MB/s) |
| 보존 | 무제한(티어드 스토리지) | 기본 24시간, 최대 365일 |
| 운영 | 브로커 크기·스토리지·파티션 관리 (Serverless 옵션 있음) | 샤드 수 또는 온디맨드 |
| 이 사이트와의 대응 | [Kafka 전체](/kafka/notes/01-kafka-overview), [CDC](/kafka/notes/08-cdc-outbox-debezium) | Redis Streams 와 비슷한 단순함 |

이 사이트의 [CDC → 레이크 실험](/data-engineering/lab/de-cdc-to-lake)(PG → Debezium → Kafka → S3 Parquet)은 AWS 에서 RDS(논리 복제) → MSK Connect(Debezium) → MSK → S3 싱크로 거의 그대로 옮겨진다. API 가 Kafka 라는 것이 MSK 의 최대 장점이다.

## S3 이벤트 알림 vs EventBridge

| | S3 → SQS/SNS/Lambda 직접 | S3 → EventBridge |
|---|---|---|
| 필터 | 접두사·접미사 | 키·크기·메타데이터 등 풍부 |
| 대상 | 3종 | EventBridge 의 모든 대상 |
| 같은 이벤트를 여러 대상에 | 겹치는 접두사 불가 → SNS 팬아웃 필요 | 규칙 여러 개로 자연스럽게 |

## 전달 보장과 소비자 설계 — 어디서나 같다

| 원칙 | 이유 | 이 사이트에서 |
|---|---|---|
| 소비자는 멱등 | 최소 한 번이라 중복이 온다 | [멱등 키 실험](/api-design/lab/api-idempotency-key) |
| DLQ 깊이에 알림 | 조용히 쌓이는 실패를 놓치지 않게 | [메시징 07](/messaging/notes/07-operations-observability) |
| 가장 오래된 메시지 나이 | 큐 깊이보다 사용자 체감에 가깝다 | CloudWatch `ApproximateAgeOfOldestMessage` |
| 아웃박스로 발행 | DB 커밋과 발행의 이중 쓰기 문제 | [CDC 와 Outbox](/kafka/notes/08-cdc-outbox-debezium) |

## 로컬 실험 ↔ AWS — 무엇이 달라지나

| 로컬 | AWS |
|---|---|
| RabbitMQ 큐를 직접 선언 | 큐가 API 리소스 — Terraform 으로 관리, 큐 URL·ARN |
| 브로커 메모리가 한계 | 사실상 무제한 큐 깊이 → 쌓이는 걸 **알림으로** 알아야 한다 |
| 브로커가 죽으면 끝 | 리전 서비스로 고가용 (대신 리전 장애는 남음) |
| 처리량 측정 = 내 Mac | 요청 수 과금 — 롱 폴링·배치(최대 10건)로 비용 절감 |

## 예시로 보기 — 이 프로젝트에서

이 사이트의 Alertmanager 웹훅(`/api/alerts`)은 알림이 오면 바로 처리한다. AWS 라면 CloudWatch 알람 → SNS → (SQS → 처리 Lambda, 이메일, Slack) 로 팬아웃한다. 처리기가 죽어도 SQS 가 버퍼가 되고, 실패가 반복되면 DLQ 로 가서 사람이 볼 수 있다.

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| 소비자가 멱등하지 않음 | 재전달마다 이중 처리(이중 결제·이중 메일) | 메시지 id·업무 키로 중복 제거 |
| 가시성 타임아웃 < 처리 시간 | 처리 중인 메시지를 다른 소비자가 또 받음 | 타임아웃을 최악 처리 시간보다 길게, 긴 작업은 연장 |
| DLQ 없음 | 독 메시지가 무한 재시도하며 큐를 막고 비용을 태움 | 모든 큐에 DLQ + 깊이 알람 |
| DLQ 는 있는데 아무도 안 봄 | 실패가 조용히 쌓였다가 14일 뒤 사라짐 | DLQ 보존 14일, 알람, redrive 런북 ([SRE 04](/sre/notes/04-oncall-runbooks)) |
| 짧은 폴링 | 빈 응답 요청이 대부분, 요금·CPU 낭비 | 롱 폴링 20초, 배치 10건 |
| 표준 큐에 순서를 기대 | 가끔 순서가 뒤바뀜 | FIFO + 메시지 그룹, 또는 순서 없이 견디는 설계 |
| 큰 메시지를 큐에 | 256KB 한도, 비용 | 본문은 S3 에, 큐에는 포인터 (클레임 체크 패턴) |

## 실습 체크리스트

- [ ] [S3 → SQS 실험](/aws/lab/aws-s3-sqs-pipeline)을 돌려 수신 횟수가 오르다 DLQ 로 가는 과정을 표로 확인하기
- [ ] 가시성 타임아웃을 처리 시간보다 짧게 잡으면 어떤 일이 생기는지 시나리오로 설명하기
- [ ] s3:TestEvent 를 무시하는 소비자 코드를 써 보기
- [ ] 주문 이벤트를 SNS → SQS 3개로 팬아웃하는 구조와 EventBridge 규칙 3개 구조를 비교하기
- [ ] 이 사이트의 Kafka 실험 하나를 골라 MSK 로 옮길 때 바뀌는 설정(엔드포인트, 인증, 보안 그룹)을 적어 보기
