---
title: 심화 — Kafka Streams, Connect, Schema Registry
order: 6
level: 심화
summary: 토픽 사이에서 상태를 가진 처리를 하는 Kafka Streams(KStream·KTable·윈도우·조인·정확히 한 번), 외부 시스템과 잇는 Connect(소스·싱크 커넥터, Debezium CDC, SMT), 스키마를 강제하는 Schema Registry(Avro/Protobuf/JSON, 호환성 모드), ksqlDB·Flink 와의 비교
tags: [Kafka Streams, KTable, 윈도우, Connect, Debezium, Schema Registry, Avro, exactly-once]
experiments: [kafka-consumer-groups, cdc-outbox-debezium]
---

## Kafka Streams — 라이브러리로 하는 스트림 처리

별도 클러스터 없이 **앱 안에 포함되는 Java 라이브러리**. 입력 토픽을 읽어 변환·집계·조인한 결과를 출력 토픽에 쓴다. 병렬성은 입력 파티션 수, 확장은 인스턴스 추가(컨슈머 그룹 리밸런스와 같다).

```java
StreamsBuilder b = new StreamsBuilder();
KStream<String, Order> orders = b.stream("orders", Consumed.with(Serdes.String(), orderSerde));
// 1) 무상태 변환
KStream<String, Order> paid = orders.filter((k, o) -> o.status.equals("paid"));
// 2) 상태 있는 집계: 사용자별 5분 텀블링 윈도우 매출
KTable<Windowed<String>, Double> revenue = paid
    .groupBy((k, o) -> o.userId)
    .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(5)))
    .aggregate(() -> 0.0, (uid, o, sum) -> sum + o.amount, Materialized.as("revenue-store"));
// 3) 조인: 주문 스트림 + 사용자 테이블(컴팩션 토픽)
KTable<String, User> users = b.table("users");
paid.join(users, (o, u) -> enrich(o, u)).to("orders-enriched");
```

| 개념 | 의미 |
|---|---|
| **KStream** | 이벤트의 흐름 (insert 의미). 같은 키가 여러 번 |
| **KTable** | 키별 최신 값 (upsert 의미). 컴팩션 토픽 ↔ 테이블 |
| GlobalKTable | 모든 인스턴스에 전체 복제 (작은 참조 데이터 조인) |
| 상태 저장소 | RocksDB(로컬) + **changelog 토픽**(복구용). 인스턴스가 죽으면 다른 인스턴스가 changelog 로 상태 재구성 |
| 윈도우 | 텀블링(고정), 호핑(겹침), 세션(활동 간격), 슬라이딩. **grace** 로 늦게 온 이벤트 허용 |
| 시간 | 이벤트 시간(레코드 타임스탬프) 기준. 처리 시간과 다름 — 지연 도착 처리의 핵심 |
| 정확히 한 번 | `processing.guarantee=exactly_once_v2`: 소비 오프셋 + 상태 changelog + 출력을 **트랜잭션**으로 묶음 |

내부 토픽: `<app-id>-revenue-store-changelog`, `<app-id>-…-repartition`(키 변경 시). 토픽 수와 파티션이 늘어나므로 브로커 설정 확인.

## Connect — 코드 없이 외부 시스템 연결

Connect 는 **워커 클러스터**(별도 프로세스) 위에 **커넥터**(플러그인) 를 REST 로 등록한다.

```
소스 커넥터: DB/파일/큐 → Kafka       (Debezium, JDBC source, S3 source)
싱크 커넥터: Kafka → DB/검색/스토리지  (JDBC sink, Elasticsearch, S3, BigQuery)
```

```bash
# Debezium PostgreSQL CDC 등록 (Connect 워커가 있다고 가정)
curl -X POST localhost:8083/connectors -H 'Content-Type: application/json' -d '{
  "name": "study-pg",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres", "database.port": "5432", "database.user": "study", "database.password": "study", "database.dbname": "study",
    "topic.prefix": "pg", "table.include.list": "public.orders,public.outbox",
    "plugin.name": "pgoutput", "slot.name": "debezium",
    "transforms": "outbox", "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter"   # outbox 테이블 → 토픽 라우팅
  }}'
curl localhost:8083/connectors/study-pg/status
```

- Debezium 은 PostgreSQL **논리 복제 슬롯**(`wal_level=logical`)을 읽는다 — 폴링 없이 모든 INSERT/UPDATE/DELETE 가 이벤트로. 슬롯이 쌓이면 WAL 디스크가 차니 모니터링 ([PostgreSQL 운영](/postgres/notes/05-operations)).
- **Outbox EventRouter** SMT 가 outbox 테이블 행을 `aggregate_type` 별 토픽으로 보낸다 — [Outbox 패턴](/architecture/notes/03-async-messaging-consistency) 의 완성형. 자세한 동작·운영 함정은 [CDC 와 Outbox](/kafka/notes/08-cdc-outbox-debezium).
- SMT(Single Message Transform): 필드 마스킹, 라우팅, 타임스탬프 변환을 설정으로.
- Connect 의 오프셋·설정·상태는 내부 토픽(`connect-offsets` 등)에 저장 → 워커가 죽어도 이어서.
- 싱크는 멱등/upsert 모드로 (`insert.mode=upsert`, `pk.mode=record_key`) at-least-once 중복을 흡수.

## Schema Registry — 계약을 강제한다

Kafka 는 바이트만 저장한다. 생산자가 필드를 바꾸면 소비자가 깨진다. **Schema Registry** 가 토픽(subject)별 스키마 버전을 저장하고, 직렬화 시 스키마 ID 를 메시지 앞에 붙인다(5바이트 헤더). 등록 시 **호환성 검사**로 깨지는 변경을 거부한다.

| 포맷 | 특징 |
|---|---|
| **Avro** | 스키마 진화 규칙이 명확, 작음, Kafka 생태계 표준 |
| Protobuf | gRPC 와 공유, 코드 생성 |
| JSON Schema | 읽기 쉬움, 검증은 되지만 크다 |

| 호환성 모드 | 허용 변경 | 배포 순서 |
|---|---|---|
| BACKWARD (기본) | 필드 삭제, 기본값 있는 필드 추가 | 소비자 먼저 |
| FORWARD | 필드 추가, 기본값 있는 필드 삭제 | 생산자 먼저 |
| FULL | 둘 다 (기본값 있는 추가/삭제만) | 순서 무관 |
| NONE | 검사 없음 | 위험 |

```json
{ "type": "record", "name": "OrderCreated", "namespace": "study.order", "fields": [
  { "name": "orderId", "type": "string" },
  { "name": "amount", "type": "double" },
  { "name": "currency", "type": "string", "default": "KRW" }      // 기본값이 있어야 BACKWARD 호환 추가
]}
```

```bash
curl localhost:8081/subjects/orders-value/versions            # 버전 목록
curl -X POST localhost:8081/compatibility/subjects/orders-value/versions/latest -d @new-schema.json   # 사전 검사
```
kafkajs 는 `@kafkajs/confluent-schema-registry` 로 encode/decode. CI 에서 스키마 호환성 검사를 돌려 PR 단계에서 막는다.

## 무엇을 고를까

| 요구 | 선택 |
|---|---|
| 토픽 → 토픽 변환·집계, JVM 앱 | Kafka Streams |
| SQL 로 스트림 질의, 빠른 프로토타입 | ksqlDB |
| 대규모·복잡한 상태·다중 소스(파일·DB·Kafka), 정교한 윈도우 | **Apache Flink** (별도 클러스터, 사실상 스트림 처리 표준) |
| DB ↔ Kafka 동기화 | Connect + Debezium |
| 간단한 소비자 로직 | 그냥 컨슈머 (kafkajs) — 대부분은 이걸로 충분 |

> 이어서 읽기: [데이터 엔지니어링](/data-engineering) — 데이터 엔지니어링 — CDC 를 레이크하우스로 · [ClickHouse · OLAP](/clickhouse) — ClickHouse — Kafka 토픽을 분석 저장소로

## 실전에서는 어디에 쓰이나

> 토픽에 쌓인 이벤트를 실시간으로 집계·조인하거나, DB·검색·스토리지와 코드 없이 잇거나, 여러 팀이 이벤트 형식을 계약으로 관리해야 할 때 이 생태계가 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 이상 거래 탐지 | 사용자별 최근 N분 거래 패턴 | Kafka Streams 윈도우 집계 + 상태 저장소 | 대규모·복잡한 상태는 Flink |
| 커머스 실시간 매출 대시보드 | 주문 스트림과 상품·사용자 정보 결합 | KStream–KTable 조인, 결과 토픽을 대시보드가 구독 | 분 단위 배치 집계 |
| 검색·분석 저장소 적재 | 토픽을 OpenSearch·S3·DW 로 | Connect 싱크 커넥터, upsert 모드로 중복 흡수 | 직접 짠 컨슈머 |
| 레거시 DB 변경 이벤트화 | 앱 수정 없이 변경 스트림 | Connect + Debezium 소스 커넥터 | 폴링 ETL |
| 여러 팀이 쓰는 주문 이벤트 | 필드 변경이 소비자를 깨뜨림 | Schema Registry + Avro, CI 에서 호환성 검사 | JSON + 문서 합의 |

**이럴 땐 안 맞는다**
- 간단한 필터·변환 → Streams·Flink 도입은 과하다. 일반 컨슈머 하나로 충분하다.
- Node·Python 중심 팀의 상태 있는 처리 → Kafka Streams 는 JVM 라이브러리다. Flink·관리형 스트림 처리나 직접 구현을 검토한다.

**누가 매일 만나나** — 데이터 엔지니어가 커넥터 상태와 스트림 앱의 지연을 확인할 때, 백엔드 개발자가 이벤트 스키마를 바꾸는 PR 에서 호환성 검사 결과를 볼 때.

**면접·실무 단골 질문**
- Q. KStream 과 KTable 의 차이는? → 이벤트 흐름(insert) 대 키별 최신 값(upsert). KTable 은 컴팩션 토픽과 대응한다.
- Q. BACKWARD 호환 모드에서는 무엇을 먼저 배포하나? → 소비자를 먼저. 새 스키마로 옛 데이터를 읽을 수 있어야 한다.

## 실습 체크리스트

- [ ] Connect 워커(`confluentinc/cp-kafka-connect` 또는 `debezium/connect`)를 compose 에 추가하고 PostgreSQL 컨테이너에 `wal_level=logical` 설정 후 Debezium 소스 등록 → orders 테이블 INSERT 가 토픽에 나타나는지
- [ ] Schema Registry 를 추가하고 Avro 스키마를 등록한 뒤 호환되지 않는 변경(필드 타입 변경)이 거부되는지
- [ ] kafkajs 소비자로 5분 윈도우 집계를 직접 구현해 보고 Streams 의 상태 저장소가 왜 필요한지 체감
- [ ] Outbox EventRouter SMT 설정으로 outbox 행이 `order.created` 토픽으로 라우팅되는지
