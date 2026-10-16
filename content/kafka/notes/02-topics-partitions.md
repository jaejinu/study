---
title: 토픽·파티션·프로듀서
order: 2
level: 기초
summary: 파티션 수와 키 선택이 순서·병렬성을 결정하는 방식, 프로듀서의 acks·배치·멱등성, 보존 정책
tags: [파티션, 키, 프로듀서, acks, 멱등성, retention]
experiments: [kafka-produce-consume]
---

## 파티션이 결정하는 것

- **병렬성 상한**: 한 그룹에서 파티션 수보다 많은 컨슈머는 논다.
- **순서 보장 단위**: 같은 파티션 안에서만 보낸 순서 = 읽는 순서.
- **키 → 파티션**: `murmur2(key) % partitions`. 같은 키는 항상 같은 파티션. 키가 없으면 배치 단위로 파티션을 돌아가며 채움(sticky).

```
주문 ID 를 키로 → 한 주문의 created/paid/shipped 가 순서대로 한 파티션에
사용자 ID 를 키로 → 한 사용자의 이벤트가 순서대로
키 없음           → 순서 무관, 처리량 최대
```

**파티션 수는 나중에 늘릴 수 있지만 줄일 수 없고**, 늘리면 키→파티션 매핑이 바뀌어 순서 보장이 잠시 깨진다. 처음에 여유 있게(소비자 수의 2~3배) 잡는다. 핫 키(한 키에 트래픽 집중)는 한 파티션만 바쁘게 만든다.

## 토픽 관리

```bash
# 컨테이너 안에서 (docker compose exec kafka ...)
kafka-topics.sh --bootstrap-server localhost:9092 --create --topic orders --partitions 6 --replication-factor 1
kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic orders
kafka-topics.sh --bootstrap-server localhost:9092 --alter --topic orders --partitions 12
kafka-configs.sh --bootstrap-server localhost:9092 --alter --entity-type topics --entity-name orders --add-config retention.ms=604800000
```

`auto.create.topics.enable` 은 개발 편의용. 운영에선 끄고 명시적으로 만든다 (파티션 수·보존을 통제).

## 보존 (retention)

| 설정 | 의미 |
|---|---|
| `retention.ms` | 시간 기준 삭제 (기본 7일) |
| `retention.bytes` | 파티션 크기 기준 |
| `cleanup.policy=compact` | **로그 컴팩션**: 키별 최신 값만 남김. 상태 스냅샷(사용자 프로필, 설정)에 |
| `cleanup.policy=delete,compact` | 둘 다 |

컴팩션 토픽은 "테이블" 처럼 쓰인다. 삭제는 값이 null 인 메시지(tombstone)로 표현.

## 프로듀서

```
acks=0      응답 안 기다림. 유실 가능, 가장 빠름
acks=1      리더가 쓰면 OK. 리더 장애 시 유실 가능
acks=all    ISR(동기화된 레플리카) 전부 쓰면 OK. min.insync.replicas 와 함께 내구성 보장
```

- **배치**: `linger.ms`(기다렸다 모아 보냄), `batch.size`. 지연을 조금 주고 처리량을 크게 올린다.
- **압축**: `compression.type=lz4|zstd|snappy`. 배치 단위로 압축되어 네트워크·디스크 절약.
- **멱등 프로듀서** (`enable.idempotence=true`, 기본 on): 재시도로 인한 중복 쓰기를 브로커가 시퀀스 번호로 걸러낸다. 파티션 내 정확히 한 번 쓰기.
- **트랜잭션**: 여러 파티션에 원자적으로 쓰기 + 컨슈머 오프셋 커밋을 묶기 (exactly-once 스트림 처리).

```ts
// kafkajs
const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 });
await producer.send({ topic: "orders", acks: -1, messages: [{ key: "order-1", value: JSON.stringify(evt), headers: { type: "created" } }] });
```

`send` 의 결과엔 파티션과 baseOffset 이 들어 있다 — 실험실에서 키별 파티션이 고정되는 것을 확인한다.

## 메시지 구조

키, 값(바이트), 헤더, 타임스탬프. 스키마는 Kafka 가 강제하지 않는다 → JSON 이면 편하고, Avro/Protobuf + Schema Registry 를 쓰면 호환성 관리가 된다.

## 실습 체크리스트

- [ ] 파티션 3개 토픽을 만들고 키 있는 메시지를 보내 `--describe` 와 `print.partition` 으로 배치 확인
- [ ] 같은 키의 메시지가 같은 파티션에 순서대로 쌓이는지 확인 (실험실 첫 실험)
- [ ] `retention.ms=60000` 으로 바꾸고 1분 뒤 오래된 세그먼트가 사라지는지 보기 (`segment.ms` 도 줄여야 함)
