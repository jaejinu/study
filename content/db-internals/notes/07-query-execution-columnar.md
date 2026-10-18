---
title: "심화 — 쿼리 실행기와 열 저장: DuckDB·ClickHouse 는 왜 빠른가"
order: 7
level: 심화
summary: "SQL 이 실행되기까지(파싱→재작성→최적화→실행), 볼케이노(반복자) 모델의 함수 호출 비용, 벡터화 실행과 코드 생성(JIT), 행 저장 vs 열 저장(PAX·Parquet), 열 압축(사전·RLE·델타·비트 패킹)과 압축된 채로 계산, 존 맵·스킵 인덱스, 조인 알고리즘(중첩 루프·해시·병합)과 선택 기준, 집계·정렬의 메모리와 디스크 유출, 카디널리티 추정 오류, OLTP 와 OLAP 를 나누는 이유와 HTAP"
tags: [쿼리 실행기, 볼케이노, 벡터화, JIT, 열 저장, Parquet, 압축, 해시 조인, DuckDB, ClickHouse, OLAP]
experiments: [dbi-btree-pageinspect]
---

## SQL 이 실행되기까지

```
SELECT region, sum(amount) FROM orders o JOIN customers c ON o.cid = c.id
WHERE o.created > now() - interval '7 days' GROUP BY region;

1. 파싱        → 구문 트리
2. 분석·재작성 → 이름 해석, 뷰 펼치기, 규칙
3. 최적화      → 후보 계획들 생성, 비용 추정(통계: 행 수·분포·상관), 가장 싼 것 선택
                 조인 순서(테이블 n 개면 n! 순서), 조인 알고리즘, 인덱스 사용 여부, 집계 위치
4. 실행        → 연산자 트리를 돈다
```

최적화기는 **추정**으로 일한다. "created > 7일 전" 이 몇 행인지 히스토그램으로 추정하고, 그 수로 조인 알고리즘을 고른다. 추정이 100배 틀리면 계획도 100배 나빠진다 — [PostgreSQL 쿼리 최적화](/postgres/notes/07-query-optimization-deep)의 `EXPLAIN ANALYZE` 에서 `rows=` 추정과 실제를 비교하는 이유. 특히 **열 간 상관**(city 와 zip 은 독립이 아니다)을 모르면 AND 조건의 선택도를 곱해서 과소 추정한다 → `CREATE STATISTICS` (확장 통계).

## 볼케이노 모델 — 한 번에 한 행

전통적 실행기(PostgreSQL, MySQL)는 **반복자** 모델이다. 각 연산자가 `next()` 를 구현하고, 부모가 자식의 `next()` 를 불러 **행 하나씩** 끌어올린다.

```
HashAggregate.next()
  └─ HashJoin.next()
       ├─ SeqScan(orders).next()  → 한 행
       └─ (해시 테이블: customers)
```

장점: 단순하고, 파이프라인이라 메모리를 적게 쓰며, `LIMIT` 에서 일찍 멈춘다. OLTP(행 몇 개)에는 완벽하다.

문제는 수억 행을 훑는 분석 질의다. 행마다:

- 연산자마다 **가상 함수 호출**(`next()`, 조건 평가 트리의 노드마다 또 호출) → 분기 예측 실패, 인라인 불가.
- 행 하나를 처리하는 실제 일(덧셈 한 번)보다 **해석 오버헤드**가 수십 배.
- CPU 의 SIMD(한 명령으로 4~16개 값)를 못 쓴다.

현대 CPU 에서 1억 행 × 연산자 5개 × 수십 ns 오버헤드 = 수십 초. 일 자체는 1초면 끝난다.

## 벡터화 실행 — 한 번에 한 묶음

`next()` 가 행 하나 대신 **값 1,024~2,048개짜리 열 벡터 묶음**을 돌려준다(MonetDB/X100 → Vectorwise → DuckDB, ClickHouse, Velox, DataFusion).

```c
// 볼케이노: 행마다 함수 호출 + 분기
for each row: if (eval(pred, row)) emit(row)

// 벡터화: 묶음 하나에 단단한 루프 — 컴파일러가 SIMD 로 바꾼다
for (i = 0; i < 2048; i++) sel[n] = i, n += (amount[i] > 100);   // 분기 없는 선택 벡터
```

- 함수 호출 오버헤드가 묶음당 1번으로 2,000분의 1.
- 루프가 단순해 **SIMD**, 루프 언롤링, 프리페치가 적용된다.
- 묶음 크기는 **L1/L2 캐시에 들어가게** 정한다(너무 크면 캐시 미스).

### 코드 생성(JIT)

다른 길: 질의마다 **전용 기계어**를 만든다(HyPer/Umbra, Spark Tungsten, PostgreSQL 의 `jit = on`). 연산자 경계를 녹여 한 루프로 융합하고, 값은 레지스터에 둔 채로 파이프라인 끝까지 간다. 컴파일 시간(수~수십 ms)이 드니 짧은 질의엔 손해 — PG 의 JIT 은 비용이 큰 질의에만 켜진다(`jit_above_cost`). 벡터화와 JIT 은 둘 다 "해석 오버헤드를 없앤다" 의 다른 답이고, 최신 엔진은 섞어 쓴다.

## 행 저장 vs 열 저장

| | 행 저장 (NSM) | 열 저장 (DSM) |
|---|---|---|
| 페이지 안 | 행 단위로 모든 열이 붙어 있음 | 한 열의 값들만 연속 |
| `select * where id = 42` | 페이지 1개 | 열 개수만큼 다른 위치 |
| `select avg(amount)` (열 50개 중 1개) | 50개 열을 다 읽음 | **그 열만** 읽음 (1/50 I/O) |
| 압축 | 다른 타입이 섞여 약함 | 같은 타입·비슷한 값이 연속 → 5~20배 |
| INSERT 한 행 | 페이지 하나 | 열마다 따로 → 느림, 그래서 배치·버퍼 |
| 맞는 곳 | **OLTP** | **OLAP** |

**PAX**(Partition Attributes Across)·**Parquet/ORC** 는 절충이다: 행들을 **row group**(수만~수백만 행)으로 묶고, 그 안에서 열별로 저장. 한 row group 을 읽으면 한 행의 모든 열이 가까이 있고, 열 단위 압축·스킵도 된다.

## 열 압축 — 그리고 압축된 채로 계산

같은 열의 값은 비슷하다. 그래서:

| 기법 | 원리 | 잘 맞는 열 |
|---|---|---|
| **사전(dictionary)** | 고유 값 목록 + 정수 코드 | 국가, 상태, 카테고리(저카디널리티 문자열) |
| **RLE**(run-length) | (값, 반복 수) | 정렬된 열, 상태 연속 |
| **델타 / 델타-오브-델타** | 앞 값과의 차이만 | 타임스탬프, 증가 ID |
| **비트 패킹 / FOR** | 최소값 기준 오프셋을 필요한 비트만 | 작은 범위 정수 |
| **Gorilla** (XOR) | 앞 부동소수와 XOR, 앞뒤 0 비트 생략 | 메트릭 값(Prometheus 의 TSDB 도 이 계열) |
| 범용(LZ4, ZSTD) | 위 결과에 한 번 더 | 전부 |

진짜 이득은 **압축을 풀지 않고 계산**하는 것이다. `where country = 'KR'` 은 사전에서 'KR' 의 코드(3)를 찾은 뒤 정수 열에서 3 을 찾는다 — 문자열 비교가 정수 비교가 되고 SIMD 로 간다. RLE 열의 `count(*)` 는 반복 수를 더하기만 한다.

## 존 맵과 스킵 인덱스

열 저장은 블록(또는 row group)마다 **min/max·null 수·(선택) 블룸 필터**를 기록한다. `where created > '2026-10-10'` 에서 max < 그 값인 블록은 **읽지 않는다**. [BRIN](/db-internals/notes/05-index-structures)과 같은 원리(존 맵)이고, 데이터가 그 열로 **정렬**돼 있을수록 강력하다 — 그래서 ClickHouse 는 테이블마다 `ORDER BY` 키(정렬 키)를 설계의 핵심으로 삼는다.

```sql
-- ClickHouse
CREATE TABLE events (ts DateTime, service LowCardinality(String), level LowCardinality(String), latency_ms UInt32)
ENGINE = MergeTree ORDER BY (service, ts)
-- sparse primary index: 8192 행(granule)마다 정렬 키 하나 → 메모리에 다 올라감
-- LowCardinality = 사전 인코딩
-- MergeTree = 정렬된 파트를 백그라운드 머지 (LSM 과 같은 구조)
```

## 조인 알고리즘

| 알고리즘 | 동작 | 비용 | 언제 |
|---|---|---|---|
| **중첩 루프** | 바깥 행마다 안쪽을 훑음 | O(N×M) | 한쪽이 아주 작거나, 안쪽에 **인덱스**가 있을 때(인덱스 중첩 루프 = OLTP 조인의 주력) |
| **해시 조인** | 작은 쪽으로 해시 테이블(빌드) → 큰 쪽을 훑으며 탐색(프로브) | O(N+M), 메모리 = 작은 쪽 | 큰 테이블끼리 등호 조인, 분석 질의의 주력 |
| **병합 조인** | 양쪽을 조인 키로 정렬 후 지퍼처럼 | O(N log N + M log M), 이미 정렬돼 있으면 O(N+M) | 양쪽이 이미 정렬(인덱스 순서), 범위 조인 |

해시 조인의 함정: 빌드 쪽이 메모리(`work_mem`)를 넘으면 **파티션으로 나눠 디스크에 쓰고(grace hash join)** 나눠서 처리 — 디스크 유출로 수십 배 느려진다. 그리고 추정이 틀려 **큰 쪽을 빌드로** 고르면 같은 일이 생긴다. `EXPLAIN ANALYZE` 의 `Batches: 16` 이 그 신호다.

분산 엔진은 여기에 **어디서** 조인할지가 더해진다: 작은 테이블을 모든 노드에 **브로드캐스트**하거나, 양쪽을 조인 키로 **재분배(셔플)**하거나 — 네트워크가 비용의 대부분이 된다.

## 집계와 정렬의 메모리

- **해시 집계**: 그룹 키 → 누적값 해시 테이블. 그룹 수(카디널리티)가 메모리를 정한다. `GROUP BY user_id` 처럼 그룹이 수억이면 유출.
- **정렬**: 메모리 안이면 퀵소트, 넘으면 **외부 병합 정렬**(정렬된 런을 디스크에 쓰고 k-way 병합). `ORDER BY ... LIMIT 10` 은 **top-N 힙**으로 메모리 O(10).
- **근사 집계**: `count(distinct)` → HyperLogLog, 분위수 → t-digest. 정확도를 조금 버리고 메모리를 상수로([OpenSearch 집계](/opensearch/notes/04-aggregations-log-analysis), [Redis 확률 자료구조](/redis/notes/13-probabilistic)).

## OLTP 와 OLAP 를 나누는 이유

| | OLTP (PostgreSQL, MySQL) | OLAP (ClickHouse, DuckDB, BigQuery, Snowflake) |
|---|---|---|
| 질의 | 행 몇 개, 인덱스 점 조회, 짧은 트랜잭션 | 수억 행 스캔·집계, 몇 개 열 |
| 저장 | 행, B-tree, 제자리 갱신 + WAL | 열, 정렬 + 존 맵, 추가 + 머지 |
| 실행 | 볼케이노, 인덱스 중첩 루프 | 벡터화/JIT, 해시 조인·집계, 병렬 |
| 쓰기 | 행 하나씩, 트랜잭션 | 배치 적재, 갱신·삭제는 비쌈(뮤테이션) |
| 동시성 | 수천 짧은 질의 | 수십 큰 질의 |

같은 데이터를 두 구조로 두는 것이 표준 아키텍처다: OLTP DB → [CDC](/kafka/notes/08-cdc-outbox-debezium) → 분석 저장소. **HTAP**(TiDB+TiFlash, SingleStore, PG 의 열 저장 확장 Hydra/pg_duckdb, AlloyDB 의 열 캐시)는 한 시스템에서 둘을 하려는 시도로, 내부적으로는 대개 **행 복제본 + 열 복제본**을 따로 유지한다.

**DuckDB 가 빠른 이유** 요약: 임베디드(네트워크·직렬화 없음) + 벡터화 실행 + 열 저장·압축 + 존 맵 + 모든 코어 병렬(morsel-driven) + Parquet 를 직접 읽음. 노트북에서 수억 행 분석이 초 단위다.

## 예시로 보기 — 이 프로젝트에서

이 저장소의 실험에서 볼 수 있는 것:

- **실행 계획과 추정**: PG 실험 `pg-index-explain`, `pg-partition-pruning`(파티션 프루닝 = 존 맵의 거친 버전).
- **볼케이노 vs 벡터화 체감**: PG 에 200만 행 집계를 돌려 보고, 같은 데이터를 DuckDB(CLI 또는 `npx duckdb`)로 돌려 비교하기.

```bash
docker exec -it study-postgres psql -U study -c "
  create table if not exists lab_olap as select g id, (g % 1000) cid, (random()*1000)::int amount, now() - (g || 's')::interval created
  from generate_series(1, 2000000) g;
  explain (analyze, buffers) select cid % 10 as region, sum(amount) from lab_olap where created > now() - interval '7 days' group by 1;"

# 같은 질의를 PG 의 JIT 끄고/켜고
docker exec -it study-postgres psql -U study -c "set jit = off; explain analyze select sum(amount) from lab_olap;"
docker exec -it study-postgres psql -U study -c "set jit = on; set jit_above_cost = 0; explain analyze select sum(amount) from lab_olap;"
```

`EXPLAIN (ANALYZE)` 출력의 `JIT: Functions: N, Timing: Generation/Optimization/Emission` 이 코드 생성 비용이다. 짧은 질의에서는 JIT 을 켜는 쪽이 오히려 느려지는 것을 직접 볼 수 있다.

## 실전에서는 어디에 쓰이나

> 운영 DB 에서 대시보드·리포트가 느릴 때, "같은 집계가 DuckDB 에선 초, PostgreSQL 에선 분" 인 이유를 설명하고 OLTP 와 OLAP 를 나눌지 정할 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 매출 대시보드 | 수억 행 집계를 초 단위로 | CDC 로 열 저장 OLAP(ClickHouse 등)에 적재, 정렬 키로 존 맵 활용 | 운영 DB 복제본 집계(행 단위 실행이라 느림) |
| 관측 플랫폼 로그 분석 | 서비스·시간 조건 대량 스캔 | MergeTree `ORDER BY (service, ts)`, LowCardinality 사전 인코딩 | 검색 엔진 기반 로그 저장소 |
| 분석가·ML 피처 탐색 | 노트북에서 Parquet 바로 분석 | DuckDB 임베디드 + 벡터화 실행 | Spark 클러스터 띄우기 |
| OLTP 서비스의 느린 조인 | 해시 조인이 디스크로 유출 | `EXPLAIN ANALYZE` 로 rows 추정 vs 실제, `Batches`, 확장 통계 | `work_mem` 만 키우기(근본 원인이 남는다) |
| 핀테크 실시간 리스크 집계 | 트랜잭션과 분석을 한 시스템에서 | HTAP(행 복제본 + 열 복제본) | OLTP + CDC + OLAP 분리 |

**이럴 땐 안 맞는다**
- 행 몇 개를 자주 갱신하는 OLTP 를 열 저장에 — 단건 INSERT·UPDATE 가 비싸다(뮤테이션). 행 저장 RDBMS 가 맞다.
- 짧은 OLTP 쿼리에 JIT — 컴파일 시간이 실행보다 길다. `jit_above_cost` 를 높게 둔다.

**누가 매일 만나나** — 데이터·분석 엔지니어가 웨어하우스 테이블의 정렬 키·파티션을 설계할 때, 백엔드 개발자가 느린 쿼리의 실행 계획을 읽을 때.

**면접·실무 단골 질문**
- Q. 열 저장이 분석에 빠른 이유? → 필요한 열만 읽고, 같은 타입이 연속이라 압축이 잘 되며, 벡터화와 존 맵으로 블록을 건너뛴다.
- Q. 해시 조인과 중첩 루프는 언제 고르나? → 큰 테이블끼리 등호 조인은 해시, 한쪽이 작거나 안쪽에 인덱스가 있으면 인덱스 중첩 루프.

## 실습 체크리스트

- [ ] `lab_olap` 에 `cid` 와 `amount` 의 확장 통계(`CREATE STATISTICS`)를 만들기 전후로 AND 조건의 `rows=` 추정이 어떻게 바뀌는지 보기
- [ ] `work_mem` 을 64kB 와 64MB 로 바꿔 해시 집계·정렬의 `Disk:` / `Batches:` 표시가 어떻게 달라지는지 확인
- [ ] PG 의 JIT on/off 로 큰 집계와 작은 질의의 시간을 각각 비교해 JIT 이 언제 이득인지 적기
- [ ] 같은 200만 행을 CSV 로 내보내 DuckDB 로 같은 GROUP BY 를 실행하고 시간 비교, 차이를 벡터화·열 저장으로 설명하기
- [ ] 행 저장과 열 저장에서 `select * from t where id = 42` 와 `select avg(amount) from t` 의 페이지 읽기 수를 각각 추정해 보기
