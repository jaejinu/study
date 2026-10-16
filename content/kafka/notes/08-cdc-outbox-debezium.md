---
title: "심화 — CDC 와 Outbox: Debezium 으로 DB 변경을 이벤트로"
order: 8
level: 심화
summary: "이중 쓰기 문제가 왜 생기는지, Outbox 패턴과 CDC(Change Data Capture)가 그것을 어떻게 트랜잭션 하나로 줄이는지, PostgreSQL 논리 복제(WAL·슬롯·publication)의 동작, Debezium 커넥터 설정과 EventRouter SMT, 스냅샷·스키마 변경·슬롯 지연 같은 운영 함정, 그리고 이 프로젝트의 cdc 프로파일로 직접 돌려 보는 실험"
tags: [CDC, Outbox, Debezium, Kafka Connect, 논리 복제, WAL, 복제 슬롯, pgoutput, SMT, at-least-once]
experiments: [cdc-outbox-debezium]
---

## 문제: 이중 쓰기(dual write)

주문 서비스가 "주문을 저장하고 `OrderCreated` 이벤트를 발행" 해야 한다. 순진한 코드:

```ts
await db.query("insert into orders ...");     // ① DB 커밋
await producer.send({ topic: "orders", ... });  // ② Kafka 발행
```

①과 ② 사이에 프로세스가 죽으면 **주문은 있는데 이벤트가 없다**. 순서를 바꾸면 **이벤트는 나갔는데 주문이 없다**. 두 시스템(DB, Kafka)에 걸친 원자적 트랜잭션은 없다(2PC 는 느리고 Kafka 가 지원하지 않는다). 재시도를 붙이면 중복 발행이, 발행 실패를 무시하면 유실이 생긴다. 이것이 **이중 쓰기 문제**다.

> 핵심 통찰: 두 시스템에 쓰지 말고 **하나에만 쓰고**, 다른 시스템은 그 하나를 **구독**하게 하라.

## 해법 1: Outbox 패턴

같은 DB 트랜잭션 안에 `outbox` 테이블에도 한 줄을 쓴다. 커밋되면 "주문 + 이벤트 의도" 가 원자적으로 저장된다.

```sql
create table outbox (
  id            uuid primary key,       -- 이벤트 ID (소비자 멱등 키)
  aggregatetype text not null,          -- 'order' → 토픽 라우팅
  aggregateid   text not null,          -- '42'    → Kafka 키 (순서 보장)
  type          text not null,          -- 'OrderCreated'
  payload       jsonb not null,
  created_at    timestamptz default now()
);

begin;
insert into orders (id, amount) values (42, 89000);
insert into outbox (id, aggregatetype, aggregateid, type, payload)
  values (gen_random_uuid(), 'order', '42', 'OrderCreated', '{"orderId":42,"amount":89000}');
commit;
```

이제 "outbox 의 행을 Kafka 로 옮기는 무언가" 가 필요하다. 두 가지 방식:

| 방식 | 동작 | 장단점 |
|---|---|---|
| **폴링 퍼블리셔** | 앱(또는 별도 워커)이 주기적으로 `select ... where published=false` → 발행 → 표시 | 구현 쉬움. 지연 = 폴링 주기, DB 에 부하, 다중 워커면 `for update skip locked` 필요 |
| **CDC(로그 테일링)** | DB 의 트랜잭션 로그(WAL)를 읽어 outbox INSERT 를 그대로 이벤트로 | 폴링 없음(ms 지연), DB 부하 거의 없음, 앱 코드 변경 없음. 인프라(Connect/Debezium) 필요 |

이 노트는 두 번째를 다룬다.

![Outbox + CDC](/diagrams/cdc-outbox.svg)

## 해법 2: CDC — 트랜잭션 로그를 구독한다

CDC(Change Data Capture)는 테이블의 INSERT/UPDATE/DELETE 를 **변경 순서대로 스트림**으로 내보내는 기법이다. 트리거나 타임스탬프 폴링으로도 하지만 **로그 기반 CDC** 가 정석이다. DB 는 어차피 내구성을 위해 모든 변경을 WAL 에 쓰고, 복제본도 그것을 받아서 따라간다. CDC 도구는 "또 하나의 복제본" 인 척하고 WAL 을 받아 Kafka 로 보낸다.

### PostgreSQL 논리 복제의 구성 요소

| 요소 | 역할 | 확인 |
|---|---|---|
| `wal_level = logical` | WAL 에 행 단위 변경(튜플 전체)을 기록. 재시작 필요 | `show wal_level` |
| **복제 슬롯**(replication slot) | 구독자가 읽은 위치(LSN)를 서버가 기억. 읽지 않은 WAL 은 **삭제하지 않는다** | `select * from pg_replication_slots` |
| **출력 플러그인** | WAL → 메시지 변환. `pgoutput` 은 PG 10+ 내장 | Debezium `plugin.name=pgoutput` |
| **publication** | 어떤 테이블의 어떤 연산을 내보낼지 | `create publication study_pub for table outbox` |
| `REPLICA IDENTITY` | UPDATE/DELETE 에서 "이전 값" 을 얼마나 기록할지(DEFAULT=PK만, FULL=전체 행) | `alter table t replica identity full` |

```sql
-- 슬롯 상태: active 가 true 면 누군가 읽는 중, confirmed_flush_lsn 이 "여기까지 처리했다"
select slot_name, plugin, active, confirmed_flush_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) as lag
from pg_replication_slots;
```

> **복제 슬롯은 양날의 검.** 구독자가 죽어도 WAL 을 보존해 주니 유실이 없지만, 구독자가 **영영** 안 돌아오면 WAL 이 디스크를 다 채워 DB 가 멈춘다. `max_slot_wal_keep_size` 로 상한을 두고, `lag` 를 반드시 알림에 건다 ([PostgreSQL 운영](/postgres/notes/05-operations)).

## Debezium — Kafka Connect 위의 CDC 커넥터

Debezium 은 Kafka Connect **소스 커넥터**다. Connect 워커가 커넥터를 실행하고, 오프셋(여기서는 LSN)을 Kafka 내부 토픽에 저장해 워커가 재시작해도 이어서 읽는다.

```bash
curl -X POST localhost:18083/connectors -H 'Content-Type: application/json' -d '{
  "name": "study-outbox",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres", "database.port": "5432",
    "database.user": "study", "database.password": "study", "database.dbname": "study",
    "topic.prefix": "pg",                       # 기본 토픽 이름: pg.public.outbox
    "plugin.name": "pgoutput",
    "slot.name": "study_outbox",                # 복제 슬롯 (커넥터가 만든다)
    "publication.name": "study_pub",
    "publication.autocreate.mode": "filtered",  # include 된 테이블만 publication 에
    "table.include.list": "public.outbox",
    "tombstones.on.delete": "false",

    "transforms": "outbox",
    "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.key": "aggregateid",
    "transforms.outbox.route.topic.replacement": "outbox.${routedByValue}",   # outbox.order

    "key.converter": "org.apache.kafka.connect.storage.StringConverter",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false"
  }}'
curl localhost:18083/connectors/study-outbox/status   # connector.state / tasks[0].state 가 RUNNING
```

### Debezium 의 원래 이벤트 형태 (SMT 없이)

```json
{
  "before": null,
  "after":  { "id": "…", "aggregatetype": "order", "aggregateid": "42", "type": "OrderCreated", "payload": "{…}" },
  "source": { "connector": "postgresql", "ts_ms": 1760596000000, "db": "study", "schema": "public", "table": "outbox", "lsn": 24641672, "txId": 745 },
  "op": "c",          // c=create, u=update, d=delete, r=read(스냅샷)
  "ts_ms": 1760596000123
}
```

`before/after/op/source` 봉투(envelope)는 **일반 CDC**(테이블 미러링, 검색 인덱스 동기화, 캐시 무효화)에 유용하다. 하지만 **도메인 이벤트**를 보낼 때는 봉투가 거추장스럽고, 토픽이 `pg.public.outbox` 하나로 몰린다.

### EventRouter SMT — outbox 행을 도메인 이벤트로

SMT(Single Message Transform)는 커넥터와 Kafka 사이에서 메시지를 하나씩 바꾸는 플러그인이다. `EventRouter` 는 outbox 전용:

| outbox 컬럼 | 쓰임 |
|---|---|
| `aggregatetype` | 토픽 이름 (`route.topic.replacement` 의 `${routedByValue}`) |
| `aggregateid` | Kafka **메시지 키** → 같은 주문의 이벤트는 같은 파티션 → **순서 보장** |
| `payload` | 메시지 값 (JSON 그대로) |
| `id` | 헤더 `id` → 소비자의 멱등 키 |
| `type` | 헤더 `eventType` (설정으로 값에 넣을 수도) |

UPDATE/DELETE 는 무시된다(outbox 는 append-only 가 전제). 그래서 outbox 테이블은 **주기적으로 지워도 안전**하다. Debezium 은 삭제를 보지 않으니, `delete from outbox where created_at < now() - interval '1 day'` 를 cron 으로.

> 팁: outbox 행을 넣자마자 같은 트랜잭션에서 지워도 된다(INSERT 후 DELETE). WAL 에는 INSERT 가 남으므로 Debezium 이 읽는다. 테이블은 항상 비어 있고 청소 작업이 필요 없다. 다만 디버깅이 어려워진다.

## 전달 보장과 소비자 설계

- Debezium → Kafka 는 **at-least-once**. Connect 가 오프셋을 커밋하기 전에 죽으면 같은 이벤트가 다시 나간다. (Connect 에 exactly-once 소스 지원이 있지만 커넥터·설정 의존.)
- 따라서 소비자는 **멱등**해야 한다. 헤더 `id`(outbox.id) 를 `processed_events` 테이블에 기록하고 중복이면 건너뛴다 — [전달 보장](/kafka/notes/04-delivery-guarantees) 의 "멱등 소비자".
- 순서: 같은 `aggregateid` 안에서는 WAL 순서 = 커밋 순서 = 파티션 내 순서. **다른 집합 사이의 순서는 보장되지 않는다**(파티션이 다름). 설계가 그걸 요구하면 집합 경계를 다시 생각할 것.
- 지연: 보통 수십~수백 ms. 폴링 퍼블리셔의 "초 단위" 보다 빠르고 DB 부하도 없다.

## 운영 함정 체크

| 함정 | 증상 | 대처 |
|---|---|---|
| 슬롯 고아 | Connect 가 지워졌는데 슬롯이 남아 WAL 폭증 | 커넥터 삭제 시 `slot.drop.on.stop`(테스트용) 또는 수동 `pg_drop_replication_slot`. `lag` 알림 |
| 초기 스냅샷 | 큰 테이블을 처음 등록하면 전체 읽기(`op: r`) 로 수 시간 | `snapshot.mode=no_data`(outbox 는 과거 행 불필요) 또는 incremental snapshot |
| 스키마 변경 | outbox 에 컬럼 추가 시 커넥터가 멈추거나 이벤트 형식 변함 | Schema Registry + 호환성 모드, 변경 전 소비자 먼저 배포 |
| 페일오버 | PG 프라이머리가 바뀌면 슬롯이 새 프라이머리에 없다(PG 17 부터 슬롯 동기화 가능) | 재생성 절차 문서화, 중복 허용(멱등) 전제 |
| 큰 트랜잭션 | 한 트랜잭션에 100만 행 → Debezium 메모리·지연 급증 | 배치 작업은 쪼개기, `max.queue.size` 튜닝 |
| 토픽 자동 생성 | 새 `aggregatetype` 이 나오면 토픽이 브로커 기본값(파티션 1)으로 생김 | `topic.creation.*` 설정으로 파티션·보존 지정 |
| 비밀번호 평문 | 커넥터 설정에 DB 비밀번호가 REST 로 보인다 | Connect `config.providers`(파일/Vault) 로 외부화 |

## 예시로 보기 — 이 프로젝트에서

`pnpm cdc:up` 은 Kafka(19092) + PostgreSQL(`wal_level=logical`, 15432) + **Kafka Connect(Debezium 3.0, 18083)** 를 띄운다. 실험 `cdc-outbox-debezium` 은:

1. 커넥터를 REST 로 등록하고 `RUNNING` 을 기다린다.
2. `pg_replication_slots` 에서 슬롯이 `active` 인지 확인한다.
3. 한 트랜잭션에 `orders` 1건 + `outbox` 2건(`OrderCreated`, `OrderPaid`) 을 넣는다.
4. `outbox.order` 토픽에서 **키 = aggregateid** 인 메시지 2개가 **순서대로** 오는 것을 확인한다(보통 1초 안).
5. 슬롯의 LSN 지연을 출력하고 커넥터·슬롯·publication 을 정리한다.

앱 코드 어디에도 `producer.send` 가 없다는 점을 확인하자. 그게 이 패턴의 전부다.

```bash
# 직접 보기
docker exec -it study-postgres psql -U study -c "select slot_name, active, confirmed_flush_lsn from pg_replication_slots"
docker exec -it study-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic outbox.order --from-beginning --property print.key=true
```

## CDC 의 다른 용도

- **캐시 무효화**: `products` 테이블 변경 → Redis 키 삭제 ([캐시 패턴](/redis/notes/08-caching-patterns)). 앱이 캐시를 잊어도 DB 가 진실.
- **검색 인덱스 동기화**: PG → Elasticsearch/OpenSearch 싱크.
- **데이터 레이크 적재**: 모든 변경을 S3/Iceberg 로. "언제 무엇이 바뀌었나" 의 완전한 이력.
- **마이크로서비스 분리(strangler)**: 모놀리스 DB 의 테이블 변경을 이벤트로 흘려 새 서비스가 구독.
- **감사 로그**: `before/after` 가 그대로 변경 이력.

## 실습 체크리스트

- [ ] `pnpm cdc:up` 후 `curl localhost:18083/connector-plugins` 에서 PostgresConnector 확인
- [ ] 실험 `cdc-outbox-debezium` 실행, 수신 이벤트의 키가 aggregateid 인지 확인
- [ ] 커넥터를 일시정지(`PUT /connectors/study-outbox/pause`)하고 outbox 에 행을 넣은 뒤 슬롯 `lag` 가 자라는 것 보기, 재개 후 이벤트가 도착하는지
- [ ] `snapshot.mode` 를 바꿔 기존 outbox 행이 재전송되는지/안 되는지 비교
- [ ] 소비자에 `processed_events` 테이블로 멱등 처리를 넣고 커넥터를 재시작해 중복이 흡수되는지 확인
