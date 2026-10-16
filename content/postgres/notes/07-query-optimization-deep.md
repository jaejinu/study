---
title: "심화 — 쿼리 최적화: 조인·집계·CTE·윈도우·플래너"
order: 7
level: 심화
summary: 플래너가 비용을 계산하는 방식과 통계, 조인 알고리즘(Nested Loop·Hash·Merge) 선택 조건, 느린 쿼리 패턴 10가지와 고치는 법, CTE 의 materialize 여부, 윈도우 함수와 LATERAL, work_mem 과 디스크 정렬, EXPLAIN 의 숨은 신호(rows 추정 오차·Buffers·loops), 플래너 설정과 힌트
tags: [플래너, 조인, HashJoin, CTE, 윈도우함수, LATERAL, work_mem, 통계, 최적화]
experiments: [pg-index-explain, pg-keyset-pagination]
---

## 플래너는 통계로 비용을 추정한다

```sql
SELECT attname, n_distinct, most_common_vals, most_common_freqs, correlation FROM pg_stats WHERE tablename = 'orders';
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 1000;   -- 히스토그램 해상도 ↑ (기본 100)
CREATE STATISTICS orders_city_zip (dependencies) ON city, zip FROM customers;   -- 컬럼 상관 (확장 통계)
ANALYZE orders;
```
- `n_distinct`, 최빈값, 히스토그램으로 **선택도**를 추정 → 행 수 추정 → 조인 방식·순서 결정.
- 추정이 틀리는 대표 원인: 상관된 컬럼(`city` 와 `zip`) 을 독립으로 가정, 낡은 통계, 함수 적용, 파라미터화된 쿼리의 일반 계획.
- `EXPLAIN ANALYZE` 에서 **rows 추정 vs 실제가 10배 이상** 차이 나면 통계 문제부터.

## 조인 알고리즘

| 알고리즘 | 동작 | 적합 | 신호 |
|---|---|---|---|
| **Nested Loop** | 외부 행마다 내부 탐색 | 외부가 작고 내부에 인덱스 | `Index Scan … (loops=N)` |
| **Hash Join** | 작은 쪽을 해시 테이블로 | 큰 집합끼리 등호 조인 | `Hash Cond`, work_mem 넘으면 `Batches > 1`(디스크) |
| **Merge Join** | 양쪽 정렬 후 병합 | 이미 정렬된 입력, 범위 조인 | `Merge Cond`, 앞에 Sort |

Nested Loop 이 큰 테이블에 인덱스 없이 돌면 재앙(O(N×M)). 추정 행 수가 적다고 잘못 판단해 NL 을 고르는 경우가 흔하다 → 통계·`enable_nestloop=off` 로 비교.

## 느린 쿼리 패턴과 처방

| 패턴 | 왜 느린가 | 처방 |
|---|---|---|
| `SELECT *` | 불필요한 컬럼, TOAST 읽기, Index Only Scan 불가 | 필요한 컬럼만 |
| `WHERE lower(email) = …` | 함수로 인덱스 무시 | 함수 인덱스 |
| `WHERE id IN (서브쿼리 수만 개)` | 거대 IN 리스트 | JOIN 또는 `= ANY(array)` |
| `OFFSET 100000` 페이지네이션 | 앞 10만 행을 읽고 버림 | **keyset** (`WHERE (created_at, id) < ($1,$2) ORDER BY … LIMIT`) |
| `COUNT(*)` 큰 테이블 | 전체 스캔 (MVCC 라 인덱스로 못 셈) | 추정(`reltuples`), 집계 테이블, HLL |
| `LIKE '%abc%'` | B-tree 불가 | pg_trgm GIN 인덱스 |
| N+1 (앱) | 쿼리 수 | JOIN/`= ANY`, DataLoader |
| `OR` 조건 | 인덱스 결합 어려움 | `UNION ALL` 또는 Bitmap OR |
| 상관 서브쿼리 | 행마다 실행 | JOIN/LATERAL 로 재작성 |
| `DISTINCT` 로 중복 제거 | 정렬/해시 비용 | 조인 조건 고치기, `EXISTS` |
| 암시적 타입 변환 | 인덱스 무시 | 파라미터 타입 맞추기 |

```sql
-- keyset 페이지네이션
SELECT id, created_at, title FROM posts
WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 20;   -- 인덱스 (created_at DESC, id DESC)
-- pg_trgm
CREATE EXTENSION pg_trgm; CREATE INDEX ON users USING gin (email gin_trgm_ops);
```

## CTE 와 materialize

```sql
WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval '1 day')
SELECT * FROM recent WHERE user_id = 42;
```
PG 12+ 는 한 번 참조되는 CTE 를 **인라인**해 외부 조건(user_id)을 안으로 밀어 넣는다(predicate pushdown). 두 번 이상 참조되거나 `MATERIALIZED` 를 쓰면 중간 결과를 만든다. 예전 버전의 "CTE 는 최적화 장벽" 지식은 낡았다. 재귀 CTE(`WITH RECURSIVE`)는 트리·그래프 탐색에.

## 윈도우 함수와 LATERAL

```sql
-- 사용자별 최근 주문 1건: DISTINCT ON (PG 특유, 빠름)
SELECT DISTINCT ON (user_id) * FROM orders ORDER BY user_id, created_at DESC;
-- 순위·누적·이동 평균
SELECT user_id, amount, sum(amount) OVER (PARTITION BY user_id ORDER BY created_at) AS running,
       rank() OVER (PARTITION BY user_id ORDER BY amount DESC) AS rnk FROM orders;
-- 각 사용자의 최근 3건: LATERAL (상관 서브쿼리를 조인으로)
SELECT u.id, o.* FROM users u
CROSS JOIN LATERAL (SELECT * FROM orders o WHERE o.user_id = u.id ORDER BY created_at DESC LIMIT 3) o;
```
윈도우 함수는 한 번의 스캔으로 집계와 상세를 같이 — 자기 조인·서브쿼리 여러 개보다 빠르다.

## 메모리와 디스크 정렬

- `work_mem`(기본 4MB) 은 **정렬·해시 작업마다** 할당. 쿼리 하나가 여러 개 쓸 수 있고 커넥션 수만큼 곱해진다. 세션 단위로 올리는 것이 안전: `SET LOCAL work_mem = '256MB'` (리포트 쿼리).
- `EXPLAIN ANALYZE` 의 `Sort Method: external merge Disk: 120MB` 또는 `Batches: 8` 이 보이면 work_mem 부족.
- `effective_cache_size` 는 메모리 할당이 아니라 플래너 힌트(OS 캐시 크기). 낮으면 인덱스 스캔을 꺼린다.
- `random_page_cost`: SSD 면 4 → 1.1 로 낮춰야 인덱스 스캔을 더 선호한다. 가장 효과 큰 설정 하나.

## EXPLAIN 을 끝까지 읽기

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT TEXT) …
```
- `actual time=첫행..마지막행 rows=N loops=M`: 총 시간 = 시간 × loops. NL 안의 Index Scan 이 `loops=100000` 이면 그게 범인.
- `Buffers: shared hit=… read=… written=…`: read 가 크면 캐시 밖, 디스크 I/O.
- `Rows Removed by Filter: 990000`: 인덱스로 가져온 뒤 대부분 버림 → 인덱스 조건이 느슨.
- `Heap Fetches: N` (Index Only Scan): visibility map 이 더러워 힙을 봄 → VACUUM.
- `SETTINGS` 는 기본값과 다른 플래너 설정을 보여준다.
- 시각화: explain.dalibo.com, pgMustard.

## 플래너 제어

- 힌트는 없다(의도적). 대신 `enable_seqscan`, `enable_nestloop` 등을 **세션에서 꺼 보며** 대안 계획의 실제 시간을 비교 → 통계·인덱스·쿼리 재작성으로 해결. `pg_hint_plan` 확장이 힌트를 추가한다(최후 수단).
- `plan_cache_mode`: prepared statement 가 5회 후 일반 계획으로 바뀌어 파라미터별 최적화가 사라지는 문제 → `force_custom_plan`.
- `join_collapse_limit`/`from_collapse_limit`(8): 조인이 더 많으면 순서 탐색을 포기(GEQO). 큰 조인은 쿼리를 나눈다.
- 병렬 쿼리: `max_parallel_workers_per_gather`. 큰 스캔·집계에 `Gather` 노드가 보이면 동작 중.

## 조인 선택을 숫자로 이해하기

같은 조인이라도 **바깥 행 수**와 **안쪽 접근 방법**에 따라 플래너가 다른 알고리즘을 고른다.

| 상황 | 선택 | 비용 감각 |
|---|---|---|
| 바깥 10행, 안쪽 키에 인덱스 | Nested Loop + Index Scan | 10 × 인덱스 조회(페이지 3~4) |
| 양쪽 수십만 행, 등호 조인 | Hash Join | 작은 쪽으로 해시 테이블 1회 + 큰 쪽 1회 스캔 |
| 양쪽이 이미 키 순으로 정렬(인덱스) | Merge Join | 두 정렬 스트림을 한 번씩 |
| 바깥 추정 10행인데 실제 10만 행 | (잘못된) Nested Loop | 10만 × 인덱스 조회 → 느림의 대표 원인 |

마지막 줄이 실무에서 가장 흔하다. **행 수 오추정 → Nested Loop 선택 → 실제로는 수만 번 반복**. EXPLAIN ANALYZE 에서 `loops=48213` 같은 큰 숫자를 찾고, 그 바깥 노드의 `rows` 추정과 실제를 비교하면 원인이 보인다.

Hash Join 의 해시 테이블이 `work_mem` 을 넘으면 **배치(batch)** 로 나눠 디스크에 쓴다(`Batches: 8` 표시). 그때 `work_mem` 을 그 쿼리 세션에서만 올리는 것(`SET LOCAL work_mem = '256MB'`)이 전역 변경보다 안전하다. 조인 알고리즘의 일반 원리는 [쿼리 실행기와 열 저장](/db-internals/notes/07-query-execution-columnar).

## 키셋 페이지네이션 — OFFSET 의 비용

```sql
-- OFFSET: 앞의 100,000 행을 읽고 버린 뒤 20개
SELECT * FROM posts ORDER BY created_at DESC, id DESC OFFSET 100000 LIMIT 20;
-- 키셋: 마지막으로 본 (created_at, id) 이후 20개 → 인덱스에서 바로 시작점
SELECT * FROM posts WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 20;
CREATE INDEX ON posts (created_at DESC, id DESC);
```

| 페이지 깊이 | OFFSET 읽은 행 | 키셋 읽은 행 |
|---|---|---|
| 1 | 20 | 20 |
| 100 | 2,000 | 20 |
| 5,000 | 100,000 | 20 |

**행 값 비교 `(a, b) < (x, y)`** 가 복합 인덱스와 정확히 맞물리는 것이 핵심이다. `a < x OR (a = x AND b < y)` 로 풀어 쓰면 플래너가 인덱스 범위로 못 바꾸는 경우가 있다. 실험 `pg-keyset-pagination` 이 깊은 페이지에서 두 방식의 Buffers·시간을 비교한다. API 설계 관점(커서를 불투명 문자열로 노출)은 [REST 설계 원칙](/api-design/notes/01-rest-principles).

## EXPLAIN 실전 판독 순서

1. **가장 시간이 큰 노드**를 찾는다(`actual time` 의 끝값 × `loops`).
2. 그 노드와 자식의 **rows 추정 vs 실제** 비율을 본다(10배 이상이면 통계 문제).
3. **Buffers: read** 가 크면 디스크, **hit** 만 크면 CPU·메모리에서 많이 읽음(필요 이상 스캔).
4. `Rows Removed by Filter` 가 크면 인덱스가 조건을 못 쓰는 중이다.
5. `Sort Method: external merge Disk: …` 면 `work_mem` 부족.
6. `Heap Fetches: N`(Index Only Scan)이 크면 visibility map 이 깨끗하지 않음 → VACUUM.

```
Nested Loop  (cost=… rows=12 …) (actual time=0.04..1820.33 rows=48213 loops=1)    ← 추정 12 vs 실제 48213
  ->  Seq Scan on orders o  (… rows=12 …) (actual … rows=48213 loops=1)
        Filter: ((status = 'open') AND (region = 'kr'))                            ← 두 컬럼 상관 → 과소 추정
        Rows Removed by Filter: 951787
  ->  Index Scan using users_pkey on users u  (actual time=0.03..0.03 rows=1 loops=48213)
```

처방: `CREATE STATISTICS ... (dependencies) ON status, region FROM orders; ANALYZE orders;` → Hash Join 으로 바뀌는지 확인.

## 예시로 보기 — 이 사이트의 쿼리였다면

이 사이트는 노트를 파일에서 읽지만, 학습 기록을 PostgreSQL 에 둔다고 하면 자주 나올 쿼리와 처방은 이렇다.

| 화면 | 쿼리 형태 | 처방 |
|---|---|---|
| 첫 화면 "이어서 학습" | 사용자별 최근 N개 | `(user_id, viewed_at DESC)` 인덱스 + LIMIT |
| 주제별 진행률 | 사용자 × 주제 GROUP BY | 부분 집계 테이블(머티리얼라이즈드 뷰), 또는 Redis 카운터 |
| 퀴즈 복습 대상 | `due <= now()` 인 카드 | `(user_id, due)` 인덱스, 부분 인덱스 `WHERE due IS NOT NULL` |
| 주간 학습 시간 | 날짜 범위 합계 | 날짜 파티션 + 일별 집계 |

실제 이 사이트는 이 데이터들을 Redis(Set·Hash·Sorted Set)로 처리한다. 같은 요구를 두 저장소로 풀어 보면 "인덱스가 하는 일을 Redis 에선 자료구조가 한다" 는 대응이 보인다 — [Redis 자료구조](/redis/notes/02-data-types).

## 운영·관측 포인트

- `auto_explain.log_min_duration = '500ms'` + `log_analyze = on`(오버헤드 주의, 샘플링 `sample_rate`)으로 느린 쿼리의 실제 계획을 로그에 남긴다.
- 계획 변화 감지: 같은 `queryid` 의 평균 시간이 갑자기 뛰면 통계 변화·데이터 분포 변화로 계획이 바뀐 것이다.

## 실습 체크리스트

- [ ] 실험 테이블(10만 행)에 `OFFSET 90000 LIMIT 10` 과 keyset 페이지네이션 EXPLAIN 비교
- [ ] `SET enable_nestloop = off` 로 조인 계획이 바뀌는지, 실제 시간은 어느 쪽이 빠른지
- [ ] `work_mem` 을 1MB 로 낮춰 `ORDER BY` 가 external merge 가 되는 것을 보고 64MB 로 올려 비교
- [ ] `random_page_cost = 1.1` 전후로 인덱스 선택이 바뀌는 쿼리 찾기
- [ ] pg_trgm 으로 `LIKE '%keyboard%'` 를 인덱스 스캔으로 만들기
- [ ] 깊은 페이지(OFFSET 100000)와 키셋의 `EXPLAIN (ANALYZE, BUFFERS)` 비교
- [ ] `loops` 가 큰 Nested Loop 를 만들고 `CREATE STATISTICS` 로 Hash Join 으로 바꿔 보기
