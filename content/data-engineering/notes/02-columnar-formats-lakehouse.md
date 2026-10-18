---
title: "열 파일 포맷과 레이크하우스 — Parquet 의 속, Iceberg 의 약속"
order: 2
level: 중급
summary: "Parquet 파일의 구조(행 그룹·열 청크·페이지·footer 통계), 압축 코덱과 인코딩(사전·RLE), 열 선택(projection)과 조건 건너뛰기(predicate pushdown)가 동작하는 원리와 '정렬해서 써야 건너뛴다' 는 함정, 작은 파일 문제, 데이터 레이크가 '파일 더미' 에서 테이블이 되려면 필요한 것(원자적 커밋·스키마 진화·스냅샷·삭제) — Iceberg 의 메타데이터 계층·스냅샷·타임 트래블·숨은 파티셔닝, Delta·Hudi 와 비교, 실측(CSV 40.6MB vs Parquet ZSTD 9.0MB)"
tags: [Parquet, 열 포맷, 행 그룹, predicate pushdown, Iceberg, 레이크하우스, 스냅샷, 타임 트래블, 스키마 진화, DuckDB]
experiments: [de-parquet-duckdb, de-cdc-to-lake]
---

## 왜 파일 포맷이 중요한가

데이터 레이크는 결국 **객체 저장소(S3)에 놓인 파일들**이다. 질의 엔진(DuckDB, Spark, Trino, ClickHouse)은 그 파일을 읽는다. 파일을 어떻게 썼느냐가 읽는 비용을 정한다.

실험 [de-parquet-duckdb](/data-engineering/lab/de-parquet-duckdb) 의 같은 100만 행:

| 파일 | 크기 | 'event 별 avg(amount)' 집계 |
|---|---|---|
| CSV | 40.6MB | 42ms |
| Parquet 무압축 | 20.6MB | 1.4ms |
| Parquet Snappy | 15.5MB | 1.6ms |
| Parquet ZSTD | **9.0MB** | 1.7ms |

CSV 는 텍스트라 숫자를 매번 파싱해야 하고, 열 두 개만 필요해도 모든 열을 읽는다. Parquet 은 이진 열 포맷이라 필요한 열만, 이미 타입이 정해진 값으로 읽는다. 크기는 1/4, 집계는 25배 빠르다.

## Parquet 파일의 속

![Parquet 파일 구조 — 행 그룹, 열 청크, footer 통계](/diagrams/de-parquet-layout.svg)

```
파일
├── 행 그룹 0 (예: 10만 행)
│   ├── 열 청크 ts       → 페이지들 (압축된 값)
│   ├── 열 청크 user_id  → 페이지들
│   ├── 열 청크 event    → 사전 페이지 + 데이터 페이지(코드)
│   └── 열 청크 amount
├── 행 그룹 1
│   └── …
└── footer (파일 끝)
    ├── 스키마
    └── 행 그룹마다, 열마다: 위치·크기·인코딩·통계(min, max, null 수)
```

- **행 그룹(row group)**: 행을 수평으로 자른 덩어리. 병렬 처리와 건너뛰기의 단위.
- **열 청크**: 행 그룹 안의 한 열. 열마다 따로 압축되어 필요한 열만 읽을 수 있다.
- **페이지**: 열 청크 안의 작은 단위(대개 1MB 안팎). 페이지에도 통계가 붙을 수 있다.
- **footer**: 파일 끝에 메타데이터. 엔진은 먼저 footer 만 읽고 무엇을 읽을지 계획한다.

### 인코딩

| 인코딩 | 동작 | 효과 |
|---|---|---|
| 사전(dictionary) | 값 목록 + 코드 | 반복 문자열(국가·상태)이 1~2바이트 |
| RLE | 같은 값 연속을 (값, 횟수) 로 | 정렬된 저카디널리티 열 |
| Delta | 이전 값과의 차이 | 증가하는 시간·ID |
| 비트 패킹 | 실제 필요한 비트만 | 작은 정수 |

그 위에 Snappy·ZSTD·LZ4 같은 범용 압축을 건다 — [ClickHouse 코덱](/clickhouse/notes/06-compression-codecs) 과 같은 2단 구조다.

## 두 가지 건너뛰기

**1. 열 건너뛰기 (projection pushdown)** — `SELECT event, avg(amount)` 는 `event`·`amount` 열 청크만 읽는다. footer 에 위치가 있으니 객체 저장소에서도 **범위 요청(range GET)** 으로 그 바이트만 받는다.

**2. 행 그룹 건너뛰기 (predicate pushdown)** — `WHERE ts BETWEEN '10-05 00:00' AND '10-05 01:00'` 이면 footer 의 `ts` min/max 를 보고 범위가 겹치지 않는 행 그룹은 아예 안 읽는다.

### 함정: 정렬해야 건너뛴다

실험 결과(행 그룹 10개, 1시간 범위 조건):

| 파일 | 행 그룹 ts min~max (예) | 후보 행 그룹 |
|---|---|---|
| 시간순으로 씀 | 10-01 00:00 ~ 10-02 03:52, 10-02 03:52 ~ … | **1 / 10** |
| 섞어서 씀 | 10-01 00:00 ~ 10-12 13:46 (모든 그룹이 전 구간) | **10 / 10** |

데이터가 섞여 있으면 모든 행 그룹의 min/max 가 전체 범위를 덮어 통계가 아무것도 걸러 내지 못한다. 그래서 레이크하우스 테이블은 **쓰기 전에 자주 거르는 열로 정렬(또는 클러스터링·Z-order)** 한다. ClickHouse 의 [정렬 키](/clickhouse/notes/03-partition-sortkey-skip-index) 와 같은 원리다.

## 작은 파일 문제

스트리밍·마이크로배치로 계속 쓰면 몇 KB 짜리 파일이 수십만 개 생긴다.

- 파일마다 footer 를 읽어야 하고, 객체 저장소 요청은 개당 지연(수십 ms)과 비용이 있다
- 행 그룹이 작아 압축·건너뛰기 효율이 떨어진다

해결은 **압축(compaction)**: 주기적으로 작은 파일들을 128MB~1GB 파일로 다시 쓴다. Iceberg `rewrite_data_files`, Delta `OPTIMIZE` 가 이 일을 한다 — [LSM 컴팩션](/db-internals/notes/03-lsm-tree-compaction) 과 같은 이야기가 파일 수준에서 반복된다.

## 파일 더미에서 테이블로 — 레이크하우스

S3 에 Parquet 를 쌓는 것만으로는 "테이블" 이 아니다. 문제들:

| 문제 | 예 |
|---|---|
| 원자성 없음 | 파일 10개 중 6개 쓰다가 죽으면, 읽는 쪽이 반쪽 데이터를 본다 |
| 동시 쓰기 충돌 | 두 작업이 같은 경로에 쓰고 서로 덮어씀 |
| 스키마 변경 | 열 이름을 바꾸면 옛 파일과 새 파일이 맞지 않음 |
| 삭제·갱신 | 한 행을 지우려면 그 행이 든 파일을 찾아 다시 써야 함 |
| 목록 비용 | 수십만 파일을 `LIST` 하는 것 자체가 느림 |

**테이블 포맷**(Apache Iceberg, Delta Lake, Apache Hudi)은 파일 위에 **메타데이터 계층**을 얹어 이 문제를 푼다. 데이터 파일은 그대로 Parquet 이다.

### Iceberg 의 구조

```
카탈로그 (REST·Glue·Nessie·JDBC)
  └─ 테이블 → 현재 메타데이터 파일 포인터   ← 커밋 = 이 포인터를 원자적으로 교체
       metadata.json (스키마·파티션 명세·스냅샷 목록)
         └─ 스냅샷 S3 → 매니페스트 리스트
               └─ 매니페스트 파일들 (데이터 파일 목록 + 파일별 열 통계)
                     └─ data/*.parquet
```

- **원자적 커밋**: 새 데이터 파일을 다 쓴 뒤 카탈로그의 포인터를 compare-and-swap 으로 바꾼다. 바꾸기 전엔 아무도 새 파일을 보지 않는다. 동시 커밋은 낙관적 동시성으로 한쪽이 재시도.
- **스냅샷과 타임 트래블**: 커밋마다 스냅샷이 남는다. `SELECT … FOR SYSTEM_TIME AS OF '2026-10-16 12:00'` 으로 과거 상태를 질의하고, 잘못된 적재는 이전 스냅샷으로 롤백한다.
- **스키마 진화**: 열을 이름이 아니라 **ID** 로 추적한다. 열 이름을 바꾸거나 순서를 바꿔도 옛 파일을 다시 쓸 필요가 없다.
- **숨은 파티셔닝**: `PARTITIONED BY day(ts)` 로 정의하면 사용자는 `WHERE ts > …` 만 써도 엔진이 파티션을 잘라낸다. 파티션 열을 따로 만들고 질의에 넣을 필요가 없다. 파티션 방식을 나중에 바꿔도(일 → 시간) 옛 데이터는 옛 방식 그대로 읽힌다.
- **목록 없는 계획**: 매니페스트에 파일 목록과 열 통계가 있으니 `LIST` 없이, 통계로 파일을 걸러 질의를 계획한다.
- **행 수준 삭제**: copy-on-write(파일 다시 쓰기) 또는 merge-on-read(삭제 파일을 따로 쓰고 읽을 때 반영) 중 선택.

### Iceberg · Delta · Hudi

| | Iceberg | Delta Lake | Hudi |
|---|---|---|---|
| 출발 | Netflix | Databricks | Uber |
| 강점 | 엔진 중립(Spark·Trino·Flink·DuckDB·ClickHouse·Snowflake), 숨은 파티셔닝 | Spark·Databricks 통합, 단순한 트랜잭션 로그 | 스트리밍 upsert·증분 처리 |
| 메타데이터 | 매니페스트 트리 | `_delta_log/` JSON + 체크포인트 | 타임라인 |
| 요즘 | 사실상 표준으로 수렴 중 | Uniform 으로 Iceberg 호환 | 특정 스트리밍 용도 |

> **정리:** Parquet 는 "파일 하나를 잘 쓰는 법", Iceberg 는 "파일 수천 개를 하나의 테이블처럼 다루는 법" 이다.

## DuckDB — 노트북 위의 레이크하우스 엔진

DuckDB 는 프로세스 안에서 도는 분석 엔진이다. 서버 없이 Parquet·CSV·JSON 을, 로컬이든 S3 든 바로 질의한다.

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET lake (TYPE s3, KEY_ID 'study', SECRET 'study-secret',
                    ENDPOINT '127.0.0.1:19102', URL_STYLE 'path', USE_SSL false);

SELECT event, count(*) FROM read_parquet('s3://lake/events/*/*.parquet') GROUP BY event;

-- footer 통계 들여다보기
SELECT row_group_id, path_in_schema, stats_min, stats_max, compression
FROM parquet_metadata('ev.parquet') WHERE path_in_schema = 'ts';

-- Iceberg 테이블도 (iceberg 확장)
INSTALL iceberg; LOAD iceberg;
SELECT count(*) FROM iceberg_scan('s3://lake/warehouse/db/orders');
```

## 예시로 보기 — 이 프로젝트에서

실험 [de-cdc-to-lake](/data-engineering/lab/de-cdc-to-lake) 는 S3 에 이런 경로로 쓴다.

```
s3://lake/orders_cdc/batch=0001/part.parquet   (스냅샷 200건)
s3://lake/orders_cdc/batch=0002/part.parquet   (변경 83건)
```

이것은 **테이블 포맷 없는** 레이크다. 그래서 실험은 Iceberg 가 해 줄 일을 손으로 한다: 파일 전체를 읽어 키별 최신 이벤트만 남기는 병합(merge-on-read). 배치가 수천 개가 되면 이 방식은 무너진다 — 작은 파일 문제, 병합 비용, 원자성 없음. 그 지점에서 Iceberg 가 필요해진다. [07 작은 레이크하우스 설계](/data-engineering/notes/07-tiny-lakehouse-design) 에서 이 사이트 규모에 맞는 다음 단계를 정리한다.

## 실전에서는 어디에 쓰이나

> 로그·이벤트·CDC 데이터를 객체 저장소에 싸게 오래 두면서도 빠르게 질의해야 할 때, 그리고 여러 엔진이 같은 파일을 하나의 테이블처럼 읽어야 할 때 Parquet 와 테이블 포맷이 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 클릭스트림 레이크 | 대량 이벤트를 싸게 보관·집계 | S3 에 Parquet ZSTD, 일 파티션 + 시간 정렬로 행 그룹 건너뛰기 | CSV·JSON 원본(크기·파싱 비용이 수 배) |
| 여러 엔진을 쓰는 데이터 플랫폼 | Spark 로 쓰고 Trino·Flink·DuckDB 로 읽기 | Iceberg 테이블 + 카탈로그로 원자적 커밋·스키마 진화 | 엔진 하나에 묶인 웨어하우스 |
| 금융·공공 감사 대응 | 특정 시점 데이터 재현, 잘못된 적재 롤백 | Iceberg 스냅샷 타임 트래블 | 날짜별 전체 사본(저장 비용) |
| 개인정보 삭제 요청 | 레이크 안 특정 사용자 행 삭제 | 테이블 포맷의 행 수준 삭제(copy-on-write·merge-on-read) | 파일을 찾아 손으로 다시 쓰기 |
| 스트리밍 적재 파이프라인 | 작은 파일 수십만 개로 질의가 느려짐 | 주기적 compaction(`rewrite_data_files`, `OPTIMIZE`) | 마이크로배치 주기 늘리기(신선도 손해) |

**이럴 땐 안 맞는다**
- 행 단위로 자주 갱신·삭제되는 OLTP 데이터 — 불변 파일은 갱신이 비싸다. 원천 RDBMS 에 두고 CDC 로 내린다.
- 한 엔진·한 작업만 쓰는 작은 데이터 — Iceberg 카탈로그 운영이 과하다. Parquet 파일 + 일 단위 덮어쓰기로 충분하다([07](/data-engineering/notes/07-tiny-lakehouse-design)).

**누가 매일 만나나** — 데이터 엔지니어가 테이블의 파티션·정렬 열·파일 크기를 정하고 compaction 작업을 돌릴 때, 분석가가 "같은 쿼리가 왜 이 테이블에선 느린가" 를 물을 때.

**면접·실무 단골 질문**
- Q. Parquet 의 predicate pushdown 이 안 먹는 흔한 이유는? → 그 열로 정렬돼 있지 않아 모든 행 그룹의 min/max 가 전 구간을 덮는다.
- Q. 데이터 레이크와 레이크하우스의 차이? → 파일 더미 위에 원자적 커밋·스냅샷·스키마 진화·행 삭제를 주는 테이블 포맷 메타데이터 계층이 있느냐.

## 실습 체크리스트

- [ ] 실험 `de-parquet-duckdb` 를 돌리고 `parquet_metadata()` 로 행 그룹 통계를 직접 읽어 보기
- [ ] `ROW_GROUP_SIZE` 를 1만과 100만으로 바꿔 파일 크기와 1시간 범위 질의의 후보 행 그룹 수 비교
- [ ] 같은 데이터를 `ORDER BY user_id` 로 써서 `user_id = …` 조건의 건너뛰기 효과 확인
- [ ] 1행짜리 Parquet 파일 1,000개와 1,000행 파일 1개의 질의 시간을 비교해 작은 파일 문제 재현
- [ ] Iceberg 의 "열을 ID 로 추적" 이 왜 열 이름 변경을 공짜로 만드는지 설명하기
