---
title: "심화 — 쿼리 최적화: 조인·집계·CTE·윈도우·플래너"
order: 7
level: 심화
summary: 플래너가 비용을 계산하는 방식과 통계, 조인 알고리즘(Nested Loop·Hash·Merge) 선택 조건, 느린 쿼리 패턴 10가지와 고치는 법, CTE 의 materialize 여부, 윈도우 함수와 LATERAL, work_mem 과 디스크 정렬, EXPLAIN 의 숨은 신호(rows 추정 오차·Buffers·loops), 플래너 설정과 힌트
tags: [플래너, 조인, HashJoin, CTE, 윈도우함수, LATERAL, work_mem, 통계, 최적화]
experiments: [pg-index-explain]
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

## 실습 체크리스트

- [ ] 실험 테이블(10만 행)에 `OFFSET 90000 LIMIT 10` 과 keyset 페이지네이션 EXPLAIN 비교
- [ ] `SET enable_nestloop = off` 로 조인 계획이 바뀌는지, 실제 시간은 어느 쪽이 빠른지
- [ ] `work_mem` 을 1MB 로 낮춰 `ORDER BY` 가 external merge 가 되는 것을 보고 64MB 로 올려 비교
- [ ] `random_page_cost = 1.1` 전후로 인덱스 선택이 바뀌는 쿼리 찾기
- [ ] pg_trgm 으로 `LIKE '%keyboard%'` 를 인덱스 스캔으로 만들기
