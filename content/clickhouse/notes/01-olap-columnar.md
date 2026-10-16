---
title: "OLAP 와 열 지향 DB — ClickHouse 는 어떤 문제를 푸는가"
order: 1
level: 기초
summary: "OLTP 와 OLAP 가 왜 다른 저장 구조를 원하는지(행 저장 vs 열 저장), 분석 질의의 전형적인 모양(넓게 읽고 몇 열만 집계), 열 저장이 빠른 네 가지 이유(필요한 열만·압축·벡터화·병렬), ClickHouse 의 위치(DuckDB·BigQuery·Druid·Loki·OpenSearch 와 비교), 쓰지 말아야 할 때(점 갱신·트랜잭션·작은 데이터), 이 주제의 학습 경로와 실험"
tags: [OLAP, OLTP, 열 저장, ClickHouse, 분석 DB, 벡터화, DuckDB, 로그 분석]
experiments: [ch-log-analytics, ch-codecs-compression]
---

## 두 종류의 질문

같은 "주문" 데이터에 던지는 질문은 두 종류로 갈린다.

| | OLTP (트랜잭션 처리) | OLAP (분석 처리) |
|---|---|---|
| 예시 질문 | "주문 #4242 를 결제 완료로 바꿔라" | "지난 30일 국가별·시간대별 매출과 p95 결제 시간은?" |
| 한 번에 건드리는 행 | 1~수십 행 | 수백만~수십억 행 |
| 건드리는 열 | 그 행의 거의 모든 열 | 수십 개 열 중 2~5개 |
| 쓰기 | 작은 갱신이 초당 수천 번 | 큰 묶음 적재(배치·스트림) |
| 정합성 | 트랜잭션·잠금·격리가 핵심 | 대개 추가만(append), 약간 늦어도 됨 |
| 대표 | PostgreSQL, MySQL | ClickHouse, BigQuery, Snowflake, DuckDB |

[PostgreSQL](/postgres/notes/01-postgres-overview) 은 OLTP 를 위해 설계됐다. 행 하나의 모든 열이 한 페이지에 붙어 있어서(행 저장) "주문 #4242 를 통째로 읽고 고쳐 쓰기" 가 싸다. 같은 구조로 "10억 행에서 `amount` 한 열의 합" 을 구하면, 쓰지도 않을 나머지 열까지 전부 디스크에서 읽어야 한다.

## 행 저장 vs 열 저장

```
행 저장 (PostgreSQL 힙 페이지)
| id=1 ts=10:00 user=7  country=KR amount=12.5 status=paid  ua="Mozilla/..." |
| id=2 ts=10:00 user=9  country=JP amount=3.0  status=placed ua="curl/8..."   |
| id=3 ts=10:01 user=7  country=KR amount=99.0 status=paid  ua="Mozilla/..." |

열 저장 (ClickHouse 파트의 열 파일들)
id.bin      : 1, 2, 3, ...
ts.bin      : 10:00, 10:00, 10:01, ...
country.bin : KR, JP, KR, ...
amount.bin  : 12.5, 3.0, 99.0, ...
ua.bin      : "Mozilla/...", "curl/8...", ...
```

`SELECT country, sum(amount) FROM orders GROUP BY country` 는 열 저장에서 `country.bin` 과 `amount.bin` **두 파일만** 읽는다. `ua` 처럼 길고 무거운 열은 한 바이트도 안 읽는다. 이것이 열 저장의 첫 번째이자 가장 큰 이득이다. 내부 원리는 [쿼리 실행기와 열 저장](/db-internals/notes/07-query-execution-columnar) 에서 깊게 다뤘다.

## 열 저장이 빠른 네 가지 이유

1. **필요한 열만 읽는다 (projection)** — 열 30개 중 3개를 쓰면 I/O 가 1/10.
2. **압축이 잘 된다** — 같은 종류의 값이 붙어 있다. 시간은 거의 일정하게 증가하고(Delta 로 거의 0), 국가 코드는 몇 종류뿐이다(사전 압축). 실험 [ch-codecs-compression](/clickhouse/lab/ch-codecs-compression) 에서 1초 간격 타임스탬프 100만 개가 4MB → 5KB 로 줄어드는 것을 볼 수 있다. 압축은 디스크뿐 아니라 **메모리 대역폭**도 아낀다.
3. **벡터화 실행** — 행을 하나씩 처리하지 않고 값 수천 개 묶음(블록)을 한 번에 처리해 함수 호출 비용을 없애고 CPU 의 SIMD 명령을 쓴다.
4. **병렬화가 쉽다** — 데이터가 파트·그래뉼로 잘게 나뉘어 있어 코어마다 다른 조각을 맡긴다.

반대로 **행 하나를 고치는 것은 비싸다.** 열 파일 30개를 각각 열어 한 값씩 바꿔야 하고, 압축된 블록은 통째로 다시 써야 한다. 그래서 열 저장 DB 는 "갱신" 대신 "추가 후 나중에 병합" 을 기본으로 한다([02 MergeTree](/clickhouse/notes/02-mergetree-engine)).

## ClickHouse 한 장 요약

- **오픈소스 열 지향 분석 DB.** Yandex 의 웹 분석(Metrica)에서 시작해 지금은 로그·트레이스·메트릭·제품 분석의 백엔드로 널리 쓰인다.
- **단일 바이너리 서버.** 이 프로젝트에선 `pnpm clickhouse:up` 으로 HTTP 18123 포트에 뜬다.
- **SQL 방언.** 표준 SQL 에 배열·맵·근사 집계(`uniq`, `quantile`)·윈도우 함수·`-If`·`-State` 같은 조합자가 붙어 있다.
- **테이블 엔진.** 데이터를 어떻게 저장할지 테이블마다 고른다. 거의 언제나 **MergeTree 계열**이다.
- **쓰기 모델.** 큰 묶음 INSERT 를 권한다(초당 1회, 수천~수십만 행). 작은 INSERT 를 많이 하면 파트가 폭증한다.

```sql
-- 이 프로젝트 ClickHouse 에 붙어 보기
curl 'http://127.0.0.1:18123/?user=study&password=study' --data-binary 'SELECT version()'

CREATE TABLE logs (
  ts       DateTime64(3),
  level    LowCardinality(String),
  service  LowCardinality(String),
  route    LowCardinality(String),
  duration_ms UInt32,
  trace_id String,
  msg      String
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (service, level, ts);

SELECT level, count() FROM logs GROUP BY level;
SELECT quantile(0.95)(duration_ms) FROM logs WHERE ts > now() - INTERVAL 1 HOUR;
```

## 비슷한 도구들과의 위치

| 도구 | 성격 | ClickHouse 대비 |
|---|---|---|
| **DuckDB** | 프로세스 안에 들어가는 분석 엔진(SQLite 의 OLAP 판) | 서버가 없다. 노트북·배치에서 파일(Parquet)을 바로 질의할 때 최고. 여러 사용자의 상시 질의는 ClickHouse. → [데이터 엔지니어링](/data-engineering/notes/02-columnar-formats-lakehouse) |
| **BigQuery·Snowflake** | 관리형 클라우드 데이터 웨어하우스 | 운영 부담이 없고 스캔량 과금. 초 단위 대시보드·고빈도 질의는 ClickHouse 가 싸고 빠른 경우가 많다 |
| **Druid·Pinot** | 실시간 OLAP | 스트림 적재·사전 집계에 특화. SQL·조인 유연성은 ClickHouse 가 낫다 |
| **Loki** | 레이블만 인덱싱하는 로그 저장소 | 저장은 아주 싸지만 본문 질의가 무겁다. 넓은 집계는 ClickHouse → [05 로그·트레이스 분석](/clickhouse/notes/05-log-trace-analytics) |
| **OpenSearch** | 역색인 검색 엔진 | 전문 검색·관련도 순위는 OpenSearch. 수치 집계·저장 효율은 ClickHouse → [OpenSearch 집계](/opensearch/notes/04-aggregations-log-analysis) |
| **PostgreSQL** | OLTP | 수천만 행까지의 분석은 PG 로도 충분. 그 이상, 또는 초 단위 대시보드면 분리 |

## 언제 쓰고, 언제 쓰지 말까

**쓰기 좋은 곳**
- 로그·트레이스·이벤트처럼 **추가만 되고 거의 안 고치는** 대용량 데이터
- 대시보드·내부 분석처럼 **넓게 읽고 몇 열을 집계**하는 질의가 많은 곳
- 제품 분석(퍼널·코호트·리텐션), 광고·과금 집계, 관측 데이터의 장기 보관

**쓰지 말아야 할 곳**
- 행 단위 갱신·삭제가 잦은 업무 데이터 (주문 상태 변경 등) → PostgreSQL
- 다중 행 트랜잭션·강한 정합성이 필요한 곳 (ClickHouse 는 트랜잭션이 실험적 수준)
- 수백만 행 이하 — PG 의 인덱스와 적절한 집계로 충분하다. 시스템 하나를 더 운영하는 비용이 더 크다
- 키로 한 행을 찾는 조회가 주된 패턴 → Redis·PG

> **흔한 구성:** 업무 데이터는 PostgreSQL 에 두고 [CDC](/kafka/notes/08-cdc-outbox-debezium) 로 변경을 Kafka 에 흘린 뒤, ClickHouse 가 Kafka 엔진으로 받아 분석용으로 쌓는다. 원천은 하나, 질의 모델에 따라 저장소가 둘.

## 예시로 보기 — 이 프로젝트에서

이 사이트의 앱은 모든 요청·노트 조회·실험 실행을 `logs/app.jsonl` 에 구조화 로그로 남기고, Alloy 가 그것을 Loki 로 보낸다([로그 노트](/observability/notes/05-logging-loki)). 실험 [ch-log-analytics](/clickhouse/lab/ch-log-analytics) 는 같은 로그(와 합성 로그 50만 줄)를 ClickHouse 에 넣고 세 가지 질문을 두 저장소에 던진다.

| 질문 | ClickHouse (52만 행) | Loki (표본 2만 줄) |
|---|---|---|
| 레벨별 건수 | 3ms, 읽은 양 0.5MB | 30ms, 처리 2.7MB |
| 상위 경로 5개 | 3ms, 0.5MB | 16ms, 2.7MB |
| p95 지연 | 4ms, 2.4MB | 19ms, 2.7MB |

ClickHouse 는 행이 26배 많은데도 읽은 바이트가 더 적다. `level` 열 하나는 52만 행이어도 압축된 채 0.5MB 이기 때문이다. Loki 는 2만 줄 원문 전체를 풀어 JSON 을 파싱했다. 이 차이가 데이터가 TB 단위로 커질 때 비용과 대기 시간 차이가 된다. 대신 ClickHouse 는 **스키마를 미리 정해야** 하고 적재 파이프라인이 필요하다 — 공짜 점심은 없다.

## 이 주제의 순서

| 노트 | 내용 | 실험 |
|---|---|---|
| 01 (이 노트) | OLAP 와 열 저장 | ch-log-analytics |
| [02 MergeTree](/clickhouse/notes/02-mergetree-engine) | 파트·머지·희소 인덱스·그래뉼 | ch-sort-key-skip-index |
| [03 정렬 키·스킵 인덱스](/clickhouse/notes/03-partition-sortkey-skip-index) | 설계의 절반은 ORDER BY | ch-sort-key-skip-index |
| [04 머티리얼라이즈드 뷰](/clickhouse/notes/04-materialized-views-aggregation) | 사전 집계 | — |
| [05 로그·트레이스 분석](/clickhouse/notes/05-log-trace-analytics) | 스키마·비교·OTel | ch-log-analytics |
| [06 압축·코덱](/clickhouse/notes/06-compression-codecs) | 열마다 다른 압축 | ch-codecs-compression |
| [07 분산·복제·운영](/clickhouse/notes/07-distributed-replication-ops) | 클러스터와 관측 | — |

## 실습 체크리스트

- [ ] `pnpm clickhouse:up` 후 `curl 'http://127.0.0.1:18123/?user=study&password=study' --data-binary 'SELECT version()'` 로 접속 확인
- [ ] 실험 `ch-log-analytics` 를 돌리고, ClickHouse 와 Loki 의 "읽은 양" 차이를 한 문장으로 설명해 보기
- [ ] 우리 서비스의 질문 중 OLTP 질문 3개, OLAP 질문 3개를 적고 각각 어느 저장소에 맞는지 고르기
- [ ] "수백만 행이면 PG 로 충분" 이 맞는지, 우리 데이터 규모로 근거를 들어 판단해 보기
