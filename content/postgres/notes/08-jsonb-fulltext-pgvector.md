---
title: 심화 — JSONB, 전문 검색, pgvector, 확장 생태계
order: 8
level: 심화
summary: JSONB 저장·인덱싱(GIN, jsonb_path_ops)·질의 연산자와 "언제 컬럼으로 뽑을까", tsvector/tsquery 전문 검색과 한국어 처리, pgvector 로 임베딩 저장·HNSW 인덱스·하이브리드 검색, LISTEN/NOTIFY, 행 수준 보안, 자주 쓰는 확장(PostGIS·TimescaleDB·pg_cron·pg_stat_statements)
tags: [JSONB, GIN, 전문검색, tsvector, pgvector, HNSW, LISTEN/NOTIFY, RLS, 확장]
experiments: [pg-index-explain, vector-search-redis]
---

## JSONB

```sql
CREATE TABLE products (id serial PRIMARY KEY, attrs jsonb NOT NULL DEFAULT '{}');
INSERT INTO products (attrs) VALUES ('{"brand":"keychron","switch":"brown","tags":["mechanical","wireless"],"specs":{"keys":87}}');

SELECT attrs->>'brand', attrs->'specs'->>'keys', attrs #>> '{specs,keys}' FROM products;
SELECT * FROM products WHERE attrs @> '{"switch":"brown"}';                 -- 포함 (GIN 사용)
SELECT * FROM products WHERE attrs ? 'tags' AND attrs->'tags' ? 'wireless';  -- 키 존재
SELECT * FROM products WHERE attrs @? '$.specs.keys ? (@ > 80)';            -- JSONPath
UPDATE products SET attrs = attrs || '{"color":"black"}' WHERE id = 1;        -- 병합
UPDATE products SET attrs = jsonb_set(attrs, '{specs,keys}', '104') WHERE id = 1;
SELECT jsonb_pretty(attrs), jsonb_array_elements_text(attrs->'tags') FROM products;
```

### 인덱스

```sql
CREATE INDEX ON products USING gin (attrs);                       -- 기본 ops: @>, ?, ?|, ?& 지원, 크다
CREATE INDEX ON products USING gin (attrs jsonb_path_ops);        -- @> 만, 더 작고 빠름
CREATE INDEX ON products ((attrs->>'brand'));                     -- 특정 키 B-tree (등호·정렬)
```
- `@>` 로 질의하면 GIN 을 탄다. `attrs->>'brand' = 'x'` 는 표현식 인덱스가 있어야 한다.
- GIN 은 쓰기가 느리다(`fastupdate`). 대량 적재 후 생성.

### 컬럼 vs JSONB

- 조회·정렬·조인·제약이 필요한 필드는 **컬럼**. JSONB 는 "스키마가 유동적인 나머지"(속성, 메타데이터).
- JSONB 는 TOAST 로 압축 저장 — 자주 갱신되는 큰 문서는 매번 전체 재작성. 자주 바뀌는 카운터를 JSONB 안에 두지 말 것.
- 통계가 약해 선택도 추정이 부정확 → 계획 오류. 핵심 필터는 컬럼으로.

## 전문 검색

```sql
ALTER TABLE articles ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title,'')), 'A') || setweight(to_tsvector('simple', coalesce(body,'')), 'B')) STORED;
CREATE INDEX ON articles USING gin (tsv);
SELECT title, ts_rank(tsv, q) AS rank FROM articles, to_tsquery('simple', 'redis & pipeline') q
WHERE tsv @@ q ORDER BY rank DESC LIMIT 10;
SELECT ts_headline('simple', body, to_tsquery('simple','pipeline'));     -- 하이라이트
SELECT websearch_to_tsquery('simple', '"cache stampede" -lock');          -- 검색엔진식 문법
```
- 언어 설정(`english`) 은 어간 추출·불용어. **한국어**는 내장 파서가 형태소를 모르므로 `simple` + 공백 분리 또는 pg_bigm(바이그램)/textsearch_ko(은전한닢) 확장. 소규모면 pg_trgm 로 LIKE 가속이 실용적.
- 관련도: `ts_rank`, `ts_rank_cd`. 가중치 A>B>C>D.
- 규모가 크거나 형태소·동의어·패싯이 필요하면 Elasticsearch/OpenSearch, Redis Search ([Redis 모듈](/redis/notes/15-redis8-modules)).

## pgvector

```sql
CREATE EXTENSION vector;                                     -- 이미지: pgvector/pgvector:pg16
CREATE TABLE chunks (id bigserial PRIMARY KEY, doc text, body text, embedding vector(1536));
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200);
SET hnsw.ef_search = 64;                                     -- 질의 시 정확도/속도
SELECT doc, body, 1 - (embedding <=> $1) AS similarity
FROM chunks WHERE doc LIKE 'redis/%'                          -- 메타 필터 (인덱스와 결합 시 성능 주의)
ORDER BY embedding <=> $1 LIMIT 5;
```
- 연산자: `<=>` 코사인 거리, `<->` L2, `<#>` 음의 내적. 인덱스 ops 클래스와 맞춰야 인덱스를 탄다.
- HNSW vs IVFFlat: HNSW 가 기본 선택(삽입 가능, recall 높음). IVFFlat 은 메모리 적고 학습 필요.
- 필터 + 벡터: `WHERE` 가 선택적이면 플래너가 인덱스를 버리고 전수 비교할 수 있다. 파티셔닝(테넌트별)이나 `pgvector 0.8+` 의 반복 스캔(iterative scan) 옵션.
- **하이브리드**: 전문 검색 점수와 벡터 유사도를 RRF 로 합치는 CTE — 한 SQL 로 가능한 것이 pgvector 의 장점.

```sql
WITH v AS (SELECT id, row_number() OVER (ORDER BY embedding <=> $1) AS r FROM chunks ORDER BY embedding <=> $1 LIMIT 20),
     t AS (SELECT id, row_number() OVER (ORDER BY ts_rank(tsv, q) DESC) AS r FROM chunks, to_tsquery('simple',$2) q WHERE tsv @@ q LIMIT 20)
SELECT c.id, c.doc, coalesce(1.0/(60+v.r),0) + coalesce(1.0/(60+t.r),0) AS rrf
FROM chunks c LEFT JOIN v ON v.id=c.id LEFT JOIN t ON t.id=c.id WHERE v.id IS NOT NULL OR t.id IS NOT NULL ORDER BY rrf DESC LIMIT 5;
```
Redis 벡터 검색과의 비교는 [임베딩 노트](/ai-systems/notes/02-embeddings-vector-search). 이미 PostgreSQL 에 데이터가 있고 트랜잭션·조인과 함께 쓰려면 pgvector, 지연·처리량이 극단적이면 Redis/전용.

## LISTEN / NOTIFY

```sql
-- 세션 A
LISTEN jobs;
-- 세션 B (트랜잭션 커밋 시 전달)
NOTIFY jobs, 'new';   -- 또는 SELECT pg_notify('jobs', json_build_object('id', 42)::text);
```
SKIP LOCKED 큐의 폴링을 깨우는 용도로 궁합이 좋다 ([잠금 노트](/postgres/notes/04-locks-deadlocks)). 페이로드 8KB 제한, 전달 보장 없음(연결 끊기면 유실) — 신호용으로만.

## 행 수준 보안 (RLS)

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders USING (tenant_id = current_setting('app.tenant_id')::bigint);
-- 앱: SET LOCAL app.tenant_id = '7'; 이후 모든 쿼리가 자동 필터
```
멀티테넌트에서 "WHERE tenant_id 를 빼먹는" 사고를 DB 가 막는다. 인덱스에 tenant_id 가 앞에 있어야 성능 유지.

## 자주 쓰는 확장

| 확장 | 용도 |
|---|---|
| `pg_stat_statements` | 쿼리별 통계 (필수) |
| `pg_trgm` | LIKE/유사도 검색 인덱스 |
| `pgvector` | 임베딩 |
| `PostGIS` | 공간 데이터·반경 검색 (Redis GEO 의 완전판) |
| `TimescaleDB` | 시계열 하이퍼테이블·연속 집계·압축 |
| `pg_cron` | DB 안 스케줄러 (파티션 생성, 집계) |
| `pg_partman` | 파티션 자동 관리 |
| `pgaudit` | 감사 로그 |
| `citus` | 분산 샤딩 |
| `pg_repack` | 온라인 bloat 제거 |

## 실습 체크리스트

- [ ] 실험 DB 에 JSONB 테이블을 만들고 `@>` 질의의 GIN 사용 여부를 EXPLAIN 으로 확인
- [ ] `pgvector/pgvector:pg16` 이미지로 교체(compose) 후 Redis 벡터 실험과 같은 해시 임베딩을 pgvector 에 넣고 KNN 비교
- [ ] 전문 검색 + 벡터 RRF 하이브리드 SQL 실행
- [ ] LISTEN/NOTIFY 로 SKIP LOCKED 워커 깨우기
- [ ] RLS 로 tenant 격리 후 다른 tenant 설정에서 조회가 비는지 확인
