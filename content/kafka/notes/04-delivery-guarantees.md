---
title: 전달 보장과 설계 패턴
order: 4
level: 중급
summary: at-most/at-least/exactly-once 의 실제 의미, 복제와 ISR, 멱등 소비자, DLQ, 이벤트 설계, 운영 체크
tags: [전달보장, exactly-once, ISR, 멱등성, DLQ, 스키마]
experiments: [kafka-offsets-replay]
---

## 세 가지 보장

| 보장 | 프로듀서 | 컨슈머 | 결과 |
|---|---|---|---|
| at-most-once | acks=0, 재시도 없음 | 처리 전 커밋 | 유실 가능, 중복 없음 |
| at-least-once | acks=all + 재시도 | 처리 후 커밋 | 유실 없음, **중복 가능** |
| exactly-once | 멱등 프로듀서 + 트랜잭션 | 트랜잭션 안에서 오프셋 커밋 (read-process-write) | Kafka 안에서만 정확히 한 번 |

"exactly-once" 는 **Kafka → Kafka** 파이프라인(Kafka Streams)에 한정된다. 외부 DB 에 쓰는 소비자는 결국 **at-least-once + 멱등 처리**로 설계한다.

## 멱등 소비자 만들기

- 자연키로 **upsert** (`INSERT ... ON CONFLICT DO UPDATE`)
- 처리한 메시지 ID 를 저장하고 건너뛰기 (Redis Set, DB unique)
- 상태 전이 검증: "이미 paid 면 또 paid 하지 않기"
- 외부 API 호출엔 idempotency key

## 복제와 내구성

```
replication.factor=3          각 파티션을 3개 브로커에
min.insync.replicas=2         acks=all 일 때 최소 2개가 써야 성공
unclean.leader.election=false ISR 밖 레플리카를 리더로 뽑지 않음 (유실 방지, 가용성 희생)
```

ISR(In-Sync Replicas) 밖으로 밀려난 팔로워가 리더가 되면 그 사이 데이터가 사라진다. 내구성이 중요하면 `unclean.leader.election.enable=false`.

## 실패 처리: 재시도와 DLQ

- 일시적 오류(네트워크): 소비자 안에서 백오프 재시도.
- 영구 오류(잘못된 메시지): 무한 재시도하면 파티션이 막힌다 → **Dead Letter Topic** 으로 보내고 다음으로 진행. 나중에 사람이 검토·재투입.
- 재시도 토픽(`orders.retry.5m`) 으로 지연 재처리 패턴도 흔하다.

## 이벤트 설계

- **키**: 순서가 필요한 엔티티 ID.
- **스키마 진화**: 필드 추가는 안전, 삭제·타입 변경은 위험. Schema Registry + Avro/Protobuf 로 호환성 검사(backward/forward).
- **헤더**에 이벤트 타입, 트레이스 ID, 스키마 버전.
- 큰 페이로드(이미지)는 넣지 말고 참조(S3 URL)만. `message.max.bytes` 기본 1MB.
- 토픽 이름 규칙: `<도메인>.<엔티티>.<이벤트>` 예 `order.payment.completed`.

## Outbox 패턴

DB 트랜잭션과 Kafka 발행을 원자적으로 묶을 수 없다 (dual write 문제). 해법: 같은 DB 트랜잭션에서 **outbox 테이블**에 이벤트를 넣고, 별도 프로세스(또는 Debezium CDC)가 그 테이블을 읽어 Kafka 로 보낸다. 적어도 한 번 전달되므로 소비자는 멱등.

## 운영 체크리스트

- [ ] 토픽 보존 기간·파티션 수를 명시적으로 정했는가
- [ ] 프로듀서 `acks=all`, 멱등성 on, 압축 설정
- [ ] 소비자 처리 시간 < `max.poll.interval.ms`
- [ ] LAG 모니터링과 알림 (Burrow, kafka_exporter + Prometheus)
- [ ] DLQ 와 재처리 절차
- [ ] 스키마 호환성 정책

## 실전에서는 어디에 쓰이나

> "이벤트가 사라지면 안 되고, 두 번 처리돼도 안 된다" 는 요구는 결제·포인트·재고처럼 돈과 수량이 걸린 곳에서 나온다. 실무의 답은 대개 at-least-once + 멱등 소비자다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 결제 완료 → 포인트 적립 | 중복 적립 방지 | 이벤트 ID 를 unique 키로 기록하고 이미 있으면 건너뜀 | exactly-once 는 Kafka → Kafka 에 한정 |
| 실시간 집계 파이프라인 | Kafka → Kafka 변환의 정확한 수치 | 트랜잭션 프로듀서 + 오프셋을 같은 트랜잭션에 커밋 | 멱등 upsert 로 근사 |
| 외부 결제·문자 발송 연동 | 형식 오류 메시지가 파티션을 막음 | 일시 오류는 백오프 재시도, 영구 오류는 DLQ 로 보내고 진행 | 무한 재시도 |
| 주문 서비스 이벤트 발행 | DB 커밋과 발행의 이중 쓰기 | Outbox 테이블 + 릴레이(CDC) | 2PC 는 느리고 Kafka 가 지원하지 않음 |
| 여러 팀이 공유하는 이벤트 | 필드 변경으로 인한 소비자 장애 | Schema Registry 호환성 검사, 헤더에 스키마 버전 | 문서로만 계약 |

**이럴 땐 안 맞는다**
- 외부 DB·API 에 쓰는 소비자에서 "exactly-once 를 켰으니 안전" → 외부 부작용은 Kafka 트랜잭션 밖이다. 멱등 키가 여전히 필요하다.
- 유실을 허용하는 메트릭·디버그 로그까지 최고 내구성 설정 → 지연·비용만 는다. 데이터 중요도별로 acks·복제 설정을 나눈다.

**누가 매일 만나나** — 결제·정산 백엔드 개발자가 "포인트가 두 번 들어갔다" 문의를 추적할 때, SRE 가 DLQ 적체 알림을 받고 재투입 절차를 밟을 때.

**면접·실무 단골 질문**
- Q. Kafka 의 exactly-once 는 어디까지인가? → Kafka 안의 read-process-write 에 한정된다. 외부 시스템은 at-least-once + 멱등 처리.
- Q. 멱등 소비자는 어떻게 만드나? → 자연키 upsert, 처리한 ID 기록, 상태 전이 검증, 외부 호출엔 idempotency key.

## 더 공부할 것

- Kafka Streams / ksqlDB — 스트림 조인·윈도우 집계
- Kafka Connect / Debezium — DB ↔ Kafka 커넥터, CDC
- "Designing Data-Intensive Applications" 11장 (스트림 처리)
- Confluent 블로그 "Exactly-once semantics are possible"
