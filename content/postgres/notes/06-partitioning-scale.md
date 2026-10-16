---
title: 심화 — 파티셔닝, 대용량 테이블, 확장
order: 6
level: 심화
summary: 선언적 파티셔닝(범위·리스트·해시)의 동작과 파티션 프루닝, 시계열 테이블 운영(파티션 생성·삭제 자동화), 대량 적재와 인덱스 전략, 읽기 복제·풀링·샤딩(Citus)·읽기 모델 분리까지 PostgreSQL 의 확장 경로, 커넥션·락·VACUUM 이 규모에서 어떻게 문제가 되는지
tags: [파티셔닝, 프루닝, 시계열, 대량적재, Citus, 확장, pg_partman]
experiments: [pg-index-explain, pg-partition-pruning]
---

## 언제 파티셔닝하나

테이블이 수억 행·수백 GB 가 되면: 인덱스가 메모리를 넘어 캐시 히트율 ↓, VACUUM 이 끝나지 않음, 오래된 데이터 삭제(`DELETE WHERE created < …`)가 몇 시간. **파티셔닝**은 테이블을 물리적으로 쪼개 조회는 필요한 조각만, 삭제는 `DROP PARTITION` 으로 즉시.

## 선언적 파티셔닝

```sql
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL,
  user_id bigint NOT NULL,
  payload jsonb,
  PRIMARY KEY (id, created_at)                    -- PK 에 파티션 키가 포함되어야 한다
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_10 PARTITION OF events FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE events_2026_11 PARTITION OF events FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE events_default PARTITION OF events DEFAULT;      -- 범위 밖 안전망 (운영에선 알림)

CREATE INDEX ON events (user_id, created_at);                -- 부모에 만들면 모든 파티션에 자동 생성
```

| 방식 | 키 | 용도 |
|---|---|---|
| RANGE | 날짜·ID 구간 | 시계열, 로그, 주문 (가장 흔함) |
| LIST | 열거 값 | 리전·테넌트·상태 |
| HASH | `hash(key) % N` | 균등 분산, 핫스팟 완화 (프루닝은 등호 조건만) |
| 복합 | RANGE 아래 HASH | 월별 + 테넌트 |

### 프루닝 확인

```sql
EXPLAIN SELECT count(*) FROM events WHERE created_at >= '2026-10-10' AND created_at < '2026-10-11';
-- Aggregate → Seq/Index Scan on events_2026_10  (다른 파티션은 계획에서 사라짐)
SET enable_partition_pruning = on;    -- 기본 on
```
프루닝은 **WHERE 에 파티션 키가 상수/파라미터로** 있어야 한다. `WHERE created_at > now() - interval '1 day'` 는 실행 시점 프루닝(runtime pruning)으로 가능. 함수로 감싼 키(`date_trunc(created_at)`)는 안 된다.

### 운영 자동화

- 파티션을 미리 만들어 두지 않으면 INSERT 가 DEFAULT 파티션으로 가거나 실패한다. **pg_partman** 확장이 월/일 단위 파티션을 자동 생성·보존 기간 지나면 detach/drop.
- 오래된 데이터 삭제: `ALTER TABLE events DETACH PARTITION events_2025_09 CONCURRENTLY; DROP TABLE events_2025_09;` — 수 ms, 잠금 최소, VACUUM 불필요.
- 파티션 수는 수백 개까지 무난, 수천 개면 계획 시간이 늘어난다.
- 유니크 제약·FK 는 파티션 키를 포함해야 한다 — 전역 유니크(이메일)는 파티션 테이블에 둘 수 없다 → 별도 테이블 또는 앱 레벨.

## 대량 적재

```sql
-- COPY 가 INSERT 보다 10배 이상 빠르다
COPY events (created_at, user_id, payload) FROM '/data/events.csv' CSV HEADER;
-- 앱에서: pg 의 COPY FROM STDIN (pg-copy-streams), 또는 다중 행 INSERT 1000개 단위 + 트랜잭션 묶기
-- 초기 적재 시: 인덱스·FK 를 나중에 만들고, synchronous_commit=off, maintenance_work_mem 크게
INSERT INTO target SELECT … FROM staging ON CONFLICT (id) DO UPDATE SET …;   -- upsert
```
- `UNLOGGED` 테이블은 WAL 을 쓰지 않아 빠르지만 크래시 시 비워진다 — 스테이징 전용.
- 적재 후 `ANALYZE`. 통계가 없으면 계획이 엉망.

## 읽기 확장 경로

1. **인덱스·쿼리 최적화** ([노트 07](/postgres/notes/07-query-optimization-deep)) — 10배는 여기서 나온다.
2. **캐시** (Redis) — 반복 조회 제거.
3. **커넥션 풀** (PgBouncer) — 커넥션 폭증 방지.
4. **읽기 레플리카** — 스트리밍 복제, 앱에서 읽기/쓰기 라우팅. 복제 지연(수십 ms~초) 허용 여부를 기능별로 ([아키텍처: 확장성](/architecture/notes/02-scalability-patterns)).
5. **읽기 모델 분리** — 집계·검색은 Elasticsearch/ClickHouse 로 CDC ([CQRS](/architecture/notes/05-data-modeling-cqrs-event-sourcing)).

## 쓰기 확장 — 샤딩

단일 리더의 쓰기 한계(보통 수만 TPS, 디스크·WAL 이 병목)를 넘으면:
- **Citus**(확장): 분산 테이블을 샤드 키로 여러 노드에. SQL 그대로, 코디네이터가 라우팅. 멀티테넌트 SaaS(테넌트 ID 샤드 키)와 시계열에 강하다.
- 앱 레벨 샤딩: 샤드 키 → DB 매핑, 샤드 간 조인 포기, 리샤딩 도구 직접.
- 대안: 쓰기 부하의 성격을 보고 Kafka 로 버퍼링해 배치 적재, 또는 핫 데이터를 Redis 로 ([Redis 레시피](/redis/notes/18-design-recipes)).

## 규모에서 터지는 것들

| 문제 | 증상 | 대응 |
|---|---|---|
| VACUUM 못 따라감 | dead tuple 수억, bloat, xid age ↑ | 테이블별 autovacuum 공격적으로, 파티셔닝, pg_repack |
| 긴 트랜잭션 | VACUUM 막힘, 잠금 큐 | `idle_in_transaction_session_timeout`, 배치 작업 분할 |
| 인덱스 bloat | 크기 ↑, 캐시 ↓ | `REINDEX CONCURRENTLY` |
| 커넥션 폭증 | too many connections, 메모리 | PgBouncer transaction 모드 |
| 시퀀스/ID 핫스팟 | 단일 B-tree 오른쪽 끝 경합 | 보통 괜찮음; 극단적이면 UUIDv7/ULID (시간 순, 인덱스 지역성 유지) |
| 큰 JSONB 갱신 | 전체 튜플 재작성, TOAST | 자주 바뀌는 필드는 컬럼으로 분리 |
| 통계 낡음 | 계획 급변 | `ANALYZE` 빈도, `default_statistics_target` ↑ |

## 파티션 프루닝은 두 번 일어난다

| 시점 | 무엇을 보고 | EXPLAIN 에서 |
|---|---|---|
| 플래닝 시 | 상수 조건 `WHERE created_at >= '2026-10-01'` | 계획에 해당 파티션만 나타남 |
| 실행 시(초기화) | 매개변수 `$1`, `now()`, 서브쿼리 결과 | `Subplans Removed: N` |
| 실행 중 | 조인 키(중첩 루프의 바깥 값) | 내부 Append 의 `(never executed)` 노드 |

```sql
EXPLAIN (ANALYZE, COSTS OFF)
SELECT count(*) FROM events WHERE created_at >= now() - interval '7 days';
-- Aggregate
--   ->  Append
--         Subplans Removed: 11                 ← 실행 시 프루닝(now() 는 플래닝 때 모름)
--         ->  Seq Scan on events_2026_10 ...
```

프루닝이 안 되는 대표 실수: 파티션 키에 **함수를 씌운 조건**(`WHERE date(created_at) = ...`), 키와 **다른 타입**의 비교, 파티션 키가 아닌 컬럼으로만 거르기. 실험 `pg-partition-pruning` 이 상수·매개변수·함수 조건을 비교해 어떤 경우에 몇 개 파티션을 읽는지 보여 준다.

## 파티셔닝이 늦어지게 만드는 것들

파티셔닝은 공짜가 아니다.

| 비용 | 원인 | 완화 |
|---|---|---|
| 플래닝 시간 증가 | 파티션 수 × 인덱스 수만큼 카탈로그 조회 | 파티션 수 수백 이하, 프루닝 가능한 조건 |
| 전역 유니크 불가 | 유니크 인덱스는 파티션 키를 포함해야 함 | PK 를 `(id, created_at)` 로 |
| 파티션 간 이동 UPDATE | 파티션 키 값을 바꾸면 DELETE+INSERT | 키를 불변 컬럼으로 |
| 너무 작은 파티션 | 파티션마다 인덱스·메타데이터 | 시계열은 보통 일~월 단위 |
| 기본(DEFAULT) 파티션 | 새 파티션 생성 시 DEFAULT 를 스캔해 검증(잠금) | DEFAULT 를 비워 두거나 두지 않기 |

## 파티션을 떼는 것이 진짜 이득

시계열 데이터의 보존 기간 관리는 `DELETE` 대신 **파티션 DETACH + DROP** 이다.

| 방법 | 비용 | 부작용 |
|---|---|---|
| `DELETE FROM events WHERE created_at < …` | 수천만 행 삭제 = WAL·dead tuple 폭증 | VACUUM 부담, 복제 지연 |
| `ALTER TABLE events DETACH PARTITION events_2026_07 CONCURRENTLY` + `DROP` | 메타데이터 변경 + 파일 삭제 | 거의 없음(잠금 짧음) |

실험 `pg-partition-pruning` 도 마지막에 `DETACH ... CONCURRENTLY` 로 옛 파티션을 떼어 낸다. 이 패턴은 OLAP 의 파티션 관리와 같은 발상이다 — [쿼리 실행기와 열 저장](/db-internals/notes/07-query-execution-columnar).

## 대량 적재 — 숫자로 보는 차이

100만 행을 넣는 방법별 대략적 처리량(로컬 Docker, 인덱스 1개):

| 방법 | 처리량(행/초) | 왜 |
|---|---|---|
| 한 행씩 INSERT + 자동 커밋 | 2~5천 | 행마다 왕복 + fsync |
| 한 행씩 INSERT, 하나의 트랜잭션 | 1~3만 | fsync 1회, 왕복은 그대로 |
| 다중 VALUES(1000행씩) | 10~20만 | 왕복 1/1000 |
| `COPY FROM STDIN` | 30~100만 | 파싱·프로토콜 최소 |
| `COPY` + 인덱스 나중에 생성 | 더 빠름 | 인덱스 정렬을 한 번에 |

왕복(RTT)과 커밋(fsync) 두 비용을 줄이는 것이 전부다. Redis 파이프라인이 RTT 를 줄이는 것과 같은 원리다 — [파이프라이닝](/redis/notes/06-pipelining). 적재 후에는 반드시 `ANALYZE` 를 돌려 통계를 갱신한다.

## 예시로 보기 — 이 프로젝트의 확장 경로 설계

이 사이트의 데이터는 작지만, 같은 구조가 커진다고 가정하고 PostgreSQL 확장 경로를 그려 보자.

| 데이터 | 성장 패턴 | 전략 |
|---|---|---|
| 학습 기록(퀴즈 응답·학습 시간) | 시간순 append, 최근만 자주 조회 | 월 단위 범위 파티션 + 오래된 파티션 DETACH → 객체 저장소로 아카이브 |
| 사용자·설정 | 작고 자주 읽음 | 파티션 불필요, 캐시(Redis) |
| 이벤트(outbox) | 쓰기 많고 곧 삭제 | 일 단위 파티션 + 처리 후 DROP, CDC 로 Kafka 에 |
| 벡터(노트 임베딩) | 노트 수에 비례, 읽기 위주 | HNSW 인덱스, 읽기 복제본 |

## 운영·관측 포인트

- 파티션 생성은 자동화(pg_partman, cron)하고 **미래 파티션이 N개 이상 있는지**를 알림으로 둔다. 파티션이 없으면 INSERT 가 실패하거나 DEFAULT 로 몰린다.
- 파티션별 크기·행 수를 대시보드로(`pg_partition_tree` + `pg_total_relation_size`).
- 샤딩(Citus 등)으로 가기 전에 **읽기 복제본 + 캐시 + 파티셔닝 + 쿼리 개선**을 먼저 소진한다. 샤딩은 트랜잭션·조인 제약이 크게 바뀐다 — [파티셔닝과 라우팅](/distributed-systems/notes/07-partitioning).

## 실습 체크리스트

- [ ] 위 `events` 파티션 테이블을 만들고 100만 행 적재 후 `EXPLAIN` 으로 프루닝 확인
- [ ] 파티션 키 없는 조건(`WHERE user_id = 1`)의 계획과 비교 (모든 파티션 스캔)
- [ ] `DETACH PARTITION … CONCURRENTLY` 후 `DROP` 의 소요 시간을 `DELETE` 와 비교
- [ ] `COPY` 와 단건 INSERT 10만 행의 시간 비교
- [ ] `UNLOGGED` 테이블 적재 속도 비교 후 `ALTER TABLE … SET LOGGED`
- [ ] `now()` 조건으로 실행 시 프루닝(`Subplans Removed`) 확인, `date(created_at)` 로 바꿔 프루닝이 깨지는 것 확인
- [ ] 100만 행을 다중 VALUES 와 COPY 로 넣어 처리량 비교
