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

## 실습 체크리스트

- [ ] 10만 행 테이블에서 EXPLAIN ANALYZE 전후 비교 (실험실)
- [ ] `age > 10` 처럼 선택도 낮은 조건이 인덱스를 안 타는 것 확인
- [ ] `(tenant_id, created_at)` 복합 인덱스에서 `created_at` 만으로 조회해 Seq Scan 인지 보기
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` 로 shared hit/read 읽기
