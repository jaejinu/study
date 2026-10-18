---
title: 인덱스와 실행 계획
order: 2
level: 기초
summary: B-tree 가 동작하는 방식, EXPLAIN ANALYZE 읽는 법, 복합·부분·커버링 인덱스, 인덱스가 안 타는 이유
tags: [인덱스, B-tree, EXPLAIN, 실행계획, 통계]
experiments: [pg-index-explain]
---

## EXPLAIN 읽기

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM users WHERE email = 'a@ex.com';
```

```
Index Scan using users_email_idx on users  (cost=0.42..8.44 rows=1 width=52) (actual time=0.031..0.033 rows=1 loops=1)
  Index Cond: (email = 'a@ex.com'::text)
  Buffers: shared hit=4
Planning Time: 0.1 ms
Execution Time: 0.05 ms
```

- `cost=시작..전체` : 옵티마이저의 **추정 비용**(페이지 읽기 단위). 절대값보다 계획 간 비교용.
- `rows=추정` vs `actual rows=실제` : 크게 다르면 통계가 낡았다 → `ANALYZE`.
- `Buffers: shared hit/read` : 캐시에서 읽음/디스크에서 읽음.
- 트리는 **안쪽(들여쓰기 깊은 곳)부터** 실행된다.

주요 노드:

| 노드 | 의미 |
|---|---|
| Seq Scan | 테이블 전체 읽기 |
| Index Scan | 인덱스로 위치를 찾고 힙에서 행을 가져옴 |
| Index Only Scan | 인덱스만으로 답함 (visibility map 이 깨끗해야) |
| Bitmap Heap Scan | 인덱스로 후보 페이지 비트맵을 만든 뒤 한 번에 읽기 (중간 선택도) |
| Nested Loop / Hash Join / Merge Join | 조인 방식 |
| Sort / HashAggregate | 정렬·집계 (`work_mem` 넘으면 디스크) |

## B-tree

기본 인덱스. 정렬된 키를 균형 트리로 유지해 `=`, `<`, `>`, `BETWEEN`, `ORDER BY`, 접두어 `LIKE 'abc%'` 에 쓰인다.
`LIKE '%abc'` 는 못 쓴다 (앞이 와일드카드). 함수 적용 `WHERE lower(email) = ...` 도 못 쓴다 → **함수 인덱스** `CREATE INDEX ON users (lower(email))`.

## 인덱스 종류

```sql
CREATE INDEX ON users (email);                          -- B-tree
CREATE INDEX ON users (tenant_id, created_at DESC);     -- 복합: 왼쪽 접두어부터 쓰임
CREATE INDEX ON orders (user_id) WHERE status = 'open'; -- 부분: 작고 빠름
CREATE INDEX ON orders (user_id) INCLUDE (total);       -- 커버링: Index Only Scan 유도
CREATE INDEX ON docs USING gin (body_tsv);              -- GIN: 전문 검색, jsonb, 배열
CREATE INDEX ON places USING gist (geom);               -- GiST: 공간, 범위
CREATE INDEX ON events USING brin (created_at);         -- BRIN: 시계열처럼 물리 순서와 상관있는 큰 테이블
CREATE UNIQUE INDEX ... ; CREATE INDEX CONCURRENTLY ... -- 운영 중엔 CONCURRENTLY (잠금 최소)
```

복합 인덱스 `(a, b)` 는 `WHERE a=?`, `WHERE a=? AND b=?` 에 쓰이지만 `WHERE b=?` 만으론 안 쓰인다. **등호 조건 컬럼을 앞에, 범위 조건을 뒤에**.

## 인덱스가 있는데 안 타는 이유

1. **선택도가 낮다**: 결과가 테이블의 수 % 이상이면 Seq Scan 이 싸다 (랜덤 I/O 비용).
2. 통계가 낡았다 → `ANALYZE`.
3. 타입 불일치: `WHERE id = '123'` (text vs int) 는 캐스팅으로 인덱스 무시될 수 있음.
4. 함수/연산 적용: `WHERE created_at + interval '1 day' > now()`.
5. 테이블이 너무 작다 (몇 페이지면 Seq Scan 이 빠름).
6. `OR` 조건, `NOT IN`, 앞 와일드카드.

강제로 확인: `SET enable_seqscan = off;` 로 비교해 보면 실제로 느린지 알 수 있다.

## 인덱스 비용

- 쓰기마다 모든 인덱스 갱신 → INSERT/UPDATE 느려짐.
- 디스크·캐시 차지. 안 쓰는 인덱스는 지운다:
  ```sql
  SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE idx_scan = 0;
  ```
- 부풀음(bloat): `REINDEX CONCURRENTLY`.

## 플래너는 어떻게 "비싸다" 를 계산하나

`cost` 는 시간 단위가 아니라 **임의 단위**다. 기준은 "순차로 페이지 1개 읽기 = 1.0" 이다.

| 파라미터 | 기본값 | 의미 |
|---|---|---|
| `seq_page_cost` | 1.0 | 순차 페이지 읽기 |
| `random_page_cost` | 4.0 | 임의 페이지 읽기(HDD 가정) |
| `cpu_tuple_cost` | 0.01 | 행 하나 처리 |
| `cpu_index_tuple_cost` | 0.005 | 인덱스 항목 하나 처리 |
| `cpu_operator_cost` | 0.0025 | 연산자·함수 1회 |

Seq Scan 의 비용은 대략 `페이지 수 × seq_page_cost + 행 수 × cpu_tuple_cost` 다.

```sql
SELECT relpages, reltuples FROM pg_class WHERE relname = 'users';   -- 예: 1,250 페이지, 100,000 행
-- Seq Scan 비용 ≈ 1250 × 1.0 + 100000 × 0.01 = 2250  → EXPLAIN 의 cost=0.00..2250.00 과 일치
```

인덱스 스캔은 "인덱스 페이지 몇 개 + 힙 페이지 몇 개(임의)" 로 계산하고, 이 **힙 임의 읽기 수**가 선택도에 비례한다. 결과 행이 많아지면 `random_page_cost` 4.0 이 곱해진 힙 접근이 Seq Scan 을 넘어서는 지점이 온다 — 그게 "선택도가 낮으면 인덱스를 안 탄다" 의 계산식이다.

### SSD 에서는 random_page_cost 를 낮춘다

`random_page_cost=4` 는 회전 디스크 시절 값이다. SSD·클라우드 디스크에서는 1.1~1.5 로 낮추는 것이 일반적이다. 그러면 인덱스 스캔이 더 자주 선택된다. 단, 데이터가 거의 다 메모리에 있다면 이 값보다 `effective_cache_size` 가 계획에 더 영향을 준다.

## 행 수 추정 — 계획이 틀리는 가장 흔한 이유

플래너는 `ANALYZE` 가 모은 **통계**로 "조건에 맞는 행이 몇 개일까" 를 추정한다.

```sql
SELECT attname, n_distinct, most_common_vals, most_common_freqs, correlation
FROM pg_stats WHERE tablename = 'users' AND attname IN ('status', 'created_at');
```

| 통계 | 쓰임 |
|---|---|
| `most_common_vals/freqs` | `status = 'active'` 처럼 흔한 값의 비율 |
| 히스토그램(`histogram_bounds`) | 범위 조건 `created_at > ...` 의 비율 |
| `n_distinct` | 고유값 수 → `=` 조건의 기본 선택도, GROUP BY 결과 수 |
| `correlation` | 물리 순서와 값 순서의 상관(1 에 가까우면 인덱스 범위 스캔이 순차 읽기에 가까움 → 싸짐) |

추정이 틀리는 대표 상황:
1. **상관된 컬럼**: `city='서울' AND district='강남구'` 를 독립으로 보고 비율을 곱해 과소 추정 → `CREATE STATISTICS s (dependencies) ON city, district FROM addr;`
2. **통계가 낡음**: 대량 적재 직후. autovacuum 의 analyze 를 기다리지 말고 `ANALYZE` 를 직접.
3. **함수·표현식 조건**: `WHERE lower(email) = ...` 는 통계가 없음 → 표현식 인덱스를 만들면 그 표현식 통계도 생긴다.
4. **매개변수 쿼리의 generic 계획**: 값에 따라 비율이 크게 다를 때.

`EXPLAIN ANALYZE` 에서 `rows=10` 추정인데 `actual rows=50000` 처럼 **수십 배 이상 차이 나는 노드**를 찾는 것이 튜닝의 첫걸음이다. 그 위의 조인 방식(Nested Loop 선택)이 대개 그 오추정 때문이다 — [쿼리 최적화 심화](/postgres/notes/07-query-optimization-deep).

## 스캔 방식을 고르는 구간 — 실측 감각

10만 행 테이블에서 `WHERE age > :x` 의 결과 비율에 따라 선택되는 계획은 대략 이렇게 바뀐다(실험 `pg-index-explain` 으로 재현).

| 결과 비율 | 계획 | 이유 |
|---|---|---|
| < 1% | Index Scan | 힙 임의 읽기 몇 개 |
| 1~10% | Bitmap Index Scan → Bitmap Heap Scan | 후보 페이지를 모아 페이지 순서로 읽어 임의 I/O 를 줄임 |
| > 10~20% | Seq Scan | 어차피 대부분의 페이지를 읽음 |
| 인덱스 컬럼만 조회 + VM 깨끗 | Index Only Scan | 힙 방문 생략 |

Bitmap 스캔은 Index Scan 과 Seq Scan 사이의 절충이다. 페이지 비트맵이 `work_mem` 을 넘으면 페이지 단위로 뭉개져(lossy) `Recheck Cond` 로 다시 거른다 — EXPLAIN 에 `Heap Blocks: exact=… lossy=…` 로 보인다.

## B-tree 의 실제 모양

```
              [루트: 키 구분자]                 ← 1 페이지
           /         |          \
   [내부 페이지]  [내부 페이지]  [내부 페이지]   ← 팬아웃 수백
      /  |  \
 [리프: (키, ctid) 정렬] ⇄ [리프] ⇄ [리프]     ← 양방향 링크(범위 스캔)
```

8KB 페이지에 키가 수백 개 들어가므로 **높이 3~4 로 수억 행**을 담는다. 그래서 인덱스 조회는 "페이지 3~4개 + 힙 1개" 다. 리프는 키 순서로 연결돼 있어 `ORDER BY ... LIMIT 10` 이 정렬 없이 앞 10개만 읽고 끝난다. 페이지 분할·채움률은 실험 `dbi-btree-pageinspect` 로 직접 본다 — [B-tree 와 버퍼 풀](/db-internals/notes/02-btree-pages-buffer-pool), 다른 인덱스 구조는 [인덱스 구조](/db-internals/notes/05-index-structures).

## 예시로 보기 — 실험 결과를 EXPLAIN 으로 읽기

```sql
-- 실험 pg-index-explain 이 만드는 테이블과 비슷하게
CREATE TABLE lab_users AS
SELECT g AS id, 'u' || g || '@ex.com' AS email, (random()*80)::int AS age, now() - g * interval '1 min' AS created_at
FROM generate_series(1, 100000) g;
ANALYZE lab_users;

EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM lab_users WHERE email = 'u500@ex.com';
-- Seq Scan on lab_users  (cost=0.00..2084.00 rows=1 …) (actual … rows=1 …)  Buffers: shared hit=834
CREATE INDEX ON lab_users (email);
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM lab_users WHERE email = 'u500@ex.com';
-- Index Scan using lab_users_email_idx …  Buffers: shared hit=4            ← 834 → 4 페이지
```

`Buffers` 의 페이지 수가 가장 정직한 비용이다. 시간은 캐시 상태에 따라 흔들리지만 읽은 페이지 수는 계획의 본질을 보여 준다.

## 운영·관측 포인트

- `pg_stat_user_indexes.idx_scan = 0` 인 인덱스는 쓰기 비용만 내는 중이다. 단, 복제본에서만 쓰이는 인덱스일 수 있으니 모든 노드를 본다.
- `pg_stat_user_tables.seq_scan` 이 큰 테이블에서 계속 늘면 빠진 인덱스 후보다(`seq_tup_read / seq_scan` 이 크면 더 의심).
- 계획 회귀 감지: `pg_stat_statements` 의 평균 시간이 배포 후 튀면 `auto_explain` 로그에서 계획을 비교한다.

## 실전에서는 어디에 쓰이나

> 느린 API 를 추적하면 상당수가 "인덱스가 없거나, 있는데 안 탄다" 로 끝난다. EXPLAIN (ANALYZE, BUFFERS) 는 그 원인을 추측이 아니라 읽은 페이지 수로 확인하는 도구다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 "내 주문 내역" | 사용자별 최근 주문 조회가 느려짐 | `(user_id, created_at DESC)` 복합 인덱스 + LIMIT 로 정렬 없이 앞부분만 | 결과 캐시는 빠르지만 무효화 부담 |
| B2B SaaS 대시보드 | 테넌트별 조회가 테이블 전체를 훑음 | `tenant_id` 를 맨 앞에 둔 복합 인덱스(등호 앞, 범위 뒤) | 테넌트별 파티션은 테넌트가 많으면 부담 |
| 핀테크 미처리 거래 조회 | 대부분 완료된 큰 테이블에서 소수 상태만 찾기 | 부분 인덱스 `WHERE status = 'pending'` 로 작게 | 상태별 테이블 분리는 이동 비용 |
| 회원 로그인 | 대소문자 무시 이메일 검색이 Seq Scan | `lower(email)` 표현식 인덱스 | `citext` 타입 |
| 배포 후 느려진 쿼리 | 계획 회귀 원인 찾기 | rows 추정 vs 실제 비교, `ANALYZE`, `auto_explain` 로그 | 힌트 확장은 최후 수단 |

**이럴 땐 안 맞는다**
- 결과가 테이블의 큰 비율인 조건(활성 여부 같은 두세 값 컬럼)에 단독 B-tree → 플래너가 어차피 Seq Scan 을 고른다. 부분 인덱스나 다른 조건과 묶은 복합 인덱스로.
- 적재 위주 로그 테이블에 인덱스 여러 개 → 쓰기마다 모든 인덱스를 갱신한다. 물리 순서와 상관있는 시계열이면 BRIN 이나 최소 인덱스로.

**누가 매일 만나나** — 백엔드 개발자가 APM 에서 느린 엔드포인트의 SQL 을 EXPLAIN 에 넣는 순간, DBA 가 `idx_scan = 0` 인 인덱스를 정리하며 쓰기 비용을 줄일 때.

**면접·실무 단골 질문**
- Q. 인덱스가 있는데 왜 Seq Scan 을 하나? → 선택도가 낮으면 힙 임의 읽기 비용이 순차 읽기보다 커진다. 통계 낡음·타입 불일치·함수 적용도 확인.
- Q. 복합 인덱스 컬럼 순서는? → 등호 조건 컬럼을 앞, 범위·정렬 컬럼을 뒤에. 왼쪽 접두어부터 쓰인다.

## 실습 체크리스트

- [ ] 10만 행 테이블에서 EXPLAIN ANALYZE 전후 비교 (실험실)
- [ ] `age > 10` 처럼 선택도 낮은 조건이 인덱스를 안 타는 것 확인
- [ ] `(tenant_id, created_at)` 복합 인덱스에서 `created_at` 만으로 조회해 Seq Scan 인지 보기
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` 로 shared hit/read 읽기
- [ ] `pg_class.relpages/reltuples` 로 Seq Scan 비용을 손으로 계산해 EXPLAIN 과 비교
- [ ] `random_page_cost` 를 4 → 1.1 로 바꿔 같은 쿼리의 계획이 바뀌는 경계 찾기
- [ ] 상관된 두 컬럼에 `CREATE STATISTICS` 전후로 추정 행 수 비교
