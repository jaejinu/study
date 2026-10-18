---
title: 심화 — JSONB, 전문 검색, pgvector, 확장 생태계
order: 8
level: 심화
summary: JSONB 저장·인덱싱(GIN, jsonb_path_ops)·질의 연산자와 "언제 컬럼으로 뽑을까", tsvector/tsquery 전문 검색과 한국어 처리, pgvector 로 임베딩 저장·HNSW 인덱스·하이브리드 검색, LISTEN/NOTIFY, 행 수준 보안, 자주 쓰는 확장(PostGIS·TimescaleDB·pg_cron·pg_stat_statements)
tags: [JSONB, GIN, 전문검색, tsvector, pgvector, HNSW, LISTEN/NOTIFY, RLS, 확장]
experiments: [pg-index-explain, pg-vector-search, vector-search-redis]
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

## GIN 은 역색인이다

JSONB·배열·전문 검색에 쓰는 GIN(Generalized Inverted Index)은 검색 엔진의 **역색인**과 같은 구조다: "키(단어·JSON 경로·배열 원소) → 그 키를 가진 행들의 목록(posting list)".

| | B-tree | GIN |
|---|---|---|
| 항목 | 행 하나당 키 하나 | 행 하나당 키 **여러 개**(문서의 모든 단어) |
| 강한 질의 | `=`, 범위, 정렬 | 포함 `@>`, 겹침 `&&`, 전문 검색 `@@` |
| 쓰기 비용 | 행당 1항목 | 행당 수십~수백 항목 → **fastupdate**(pending list)로 모아서 반영 |
| 크기 | 작음 | 큼(특히 `jsonb_ops`) |

`fastupdate=on`(기본)이면 INSERT 는 pending list 에 쌓이고 VACUUM 이나 목록이 `gin_pending_list_limit` 를 넘을 때 본 인덱스로 합쳐진다. 그래서 대량 INSERT 직후 검색이 느려질 수 있다(pending list 를 순차로 훑기 때문). 역색인 원리와 BM25 랭킹은 [역색인과 분석기](/opensearch/notes/01-inverted-index-analyzers), 인덱스 구조 비교는 [인덱스 구조](/db-internals/notes/05-index-structures).

## PostgreSQL 전문 검색 vs 검색 엔진

| | PostgreSQL FTS | OpenSearch |
|---|---|---|
| 데이터 일관성 | 같은 트랜잭션 — 항상 최신 | 별도 색인, 수 초 지연(refresh) |
| 랭킹 | `ts_rank`(단순 빈도) | BM25, 필드 가중치, 함수 점수 |
| 한국어 | 기본 사전 없음(`simple` 또는 확장) | nori 형태소 분석기 |
| 집계·패싯 | SQL 로 가능하나 대량엔 느림 | 집계에 최적화 |
| 운영 | 추가 시스템 없음 | 클러스터 운영 |

수만~수십만 문서, 단순 랭킹이면 PostgreSQL FTS 로 충분하다. 한국어 품질·대규모·패싯이 중요하면 검색 엔진을 붙이고 CDC 로 동기화한다. 실험 `search-index-notes` 가 이 사이트 노트를 OpenSearch 에 색인해 분석기 차이를 보여 준다.

## pgvector 의 HNSW — 정확도와 속도의 손잡이

```sql
CREATE INDEX ON notes USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
SET hnsw.ef_search = 40;     -- 질의 시 탐색 폭
SELECT id, 1 - (embedding <=> $1) AS similarity FROM notes ORDER BY embedding <=> $1 LIMIT 5;
```

| 파라미터 | 올리면 | 내리면 |
|---|---|---|
| `m`(이웃 수) | 재현율↑, 인덱스 크기·빌드 시간↑ | 작고 빠름, 재현율↓ |
| `ef_construction` | 그래프 품질↑, 빌드 느림 | 빌드 빠름 |
| `hnsw.ef_search` | 재현율↑, 질의 느림 | 빠름, 놓치는 이웃↑ |

HNSW 는 **근사** 검색이다. `ef_search` 를 바꿔 가며 정확 검색(인덱스 없이 Seq Scan)과 결과를 비교해 재현율(recall@k)을 재는 것이 튜닝의 기본이다. 또 하나의 함정: 필터와 함께 쓰면(`WHERE subject = 'kafka' ORDER BY embedding <=> $1 LIMIT 5`) 인덱스가 먼저 가까운 이웃을 찾은 뒤 필터로 걸러 **5개보다 적게** 나올 수 있다(pgvector 0.8 의 iterative scan 이 완화). 작은 테이블에서는 플래너가 Seq Scan 을 고르므로 실험 `pg-vector-search` 는 `enable_seqscan=off` 로 HNSW 경로를 강제로 보여 준다.

| 거리 연산자 | 의미 | 인덱스 ops |
|---|---|---|
| `<->` | L2(유클리드) | `vector_l2_ops` |
| `<=>` | 코사인 거리 | `vector_cosine_ops` |
| `<#>` | 음의 내적 | `vector_ip_ops` |

임베딩이 정규화돼 있으면 세 거리의 순위가 같다. 하이브리드 검색(BM25 + 벡터, RRF)과 RAG 연결은 [하이브리드 검색과 RAG](/opensearch/notes/05-hybrid-search-rag), [RAG 파이프라인](/ai-systems/notes/03-rag-design).

## LISTEN/NOTIFY 의 한계

- 알림은 **커밋 시점에** 전달되고, 받는 쪽이 연결돼 있지 않으면 사라진다(영속 아님).
- 페이로드 8000바이트 상한, 큐가 가득 차면(기본 8GB) NOTIFY 하는 트랜잭션이 커밋 실패.
- PgBouncer transaction 모드에서는 LISTEN 이 동작하지 않는다(세션 상태).

그래서 "작업 큐를 깨우는 신호" 로만 쓰고 실제 작업은 테이블(SKIP LOCKED)에 둔다 — [잠금과 데드락](/postgres/notes/04-locks-deadlocks).

## 예시로 보기 — 이 프로젝트에서

| 무엇 | 어디서 |
|---|---|
| pgvector 이미지 | compose `postgres` 서비스(`pgvector/pgvector:pg16`) |
| 벡터 검색 실험 | `pg-vector-search` (PostgreSQL), `vector-search-redis` (Redis Search) — 같은 문제를 두 저장소로 |
| 전문 검색 비교 | `search-index-notes`, `search-hybrid-rrf` (OpenSearch) |
| 행 수준 보안 | [데이터 저장소 하드닝](/security/notes/07-datastore-hardening) 의 RLS 예시 |

## 운영·관측 포인트

- GIN 인덱스 크기와 pending list 크기(`pgstatginindex`)를 본다. 쓰기 많은 테이블은 `gin_pending_list_limit` 를 조정하거나 `fastupdate=off`.
- HNSW 빌드는 메모리를 많이 쓴다(`maintenance_work_mem`). 빌드 중 디스크로 넘치면 매우 느려진다.
- JSONB 컬럼이 크게 자라면 TOAST 압축·분리 때문에 부분 갱신도 전체 재기록이 된다. 자주 바뀌는 필드는 일반 컬럼으로 뽑는다.

## 실전에서는 어디에 쓰이나

> "검색 엔진·벡터 DB·문서 DB 를 따로 붙여야 하나?" 를 고민할 때 이 노트가 등장한다. PostgreSQL 확장으로 충분한 범위와 전용 시스템이 필요한 경계를 가르는 것이 실무 판단의 핵심이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| AI 서비스 사내 문서 RAG | 청크 임베딩 검색 + 권한·메타 필터 | pgvector HNSW 와 전문 검색을 RRF 로 합치는 하이브리드 SQL | 규모·지연이 극단적이면 전용 벡터 DB, Redis 벡터 검색 |
| 커머스 상품 속성 | 카테고리마다 다른 스펙 | 공통 필드는 컬럼, 나머지는 JSONB + GIN `@>` | EAV 테이블은 조인 폭증 |
| 멀티테넌트 B2B SaaS | `WHERE tenant_id` 누락으로 데이터 노출 | RLS 정책 + `SET LOCAL app.tenant_id` | 테넌트별 스키마·DB 분리 |
| 블로그·사내 위키 검색 | 수만 문서 수준의 키워드 검색 | `tsvector` 생성 컬럼 + GIN, 가중치 | 한국어 품질·패싯이 필요하면 OpenSearch(nori) + CDC |
| 배달·지도 서비스 | 반경 내 가게 찾기 | PostGIS + GiST | 단순 반경만이면 Redis GEO |

**이럴 땐 안 맞는다**
- 수억 벡터·높은 QPS 의 추천/검색 → 단일 노드 메모리와 HNSW 빌드 비용이 한계다. 전용 벡터 DB 나 검색 엔진으로.
- 자주 바뀌는 카운터·핵심 필터를 JSONB 안에 → 매번 전체 재작성, 통계 부정확. 일반 컬럼으로 뽑는다.
- LISTEN/NOTIFY 를 이벤트 전달 수단으로 → 연결이 끊기면 유실된다. 신호용으로만 쓰고 데이터는 테이블에.

**누가 매일 만나나** — ML 엔지니어·백엔드가 RAG 프로토타입의 벡터 저장소를 고를 때, 백엔드가 "검색 기능 추가" 티켓을 받고 FTS 로 될지 검색 엔진이 필요한지 판단할 때.

**면접·실무 단골 질문**
- Q. pgvector 와 전용 벡터 DB 의 선택 기준은? → 데이터가 이미 PostgreSQL 에 있고 트랜잭션·조인·필터와 함께 쓰면 pgvector, 규모·지연이 극단적이면 전용.
- Q. HNSW 튜닝의 기준은? → `ef_search` 를 바꿔 정확 검색 대비 recall@k 를 재고, 지연과 맞바꾼다.

## 실습 체크리스트

- [ ] 실험 DB 에 JSONB 테이블을 만들고 `@>` 질의의 GIN 사용 여부를 EXPLAIN 으로 확인
- [ ] `pgvector/pgvector:pg16` 이미지로 교체(compose) 후 Redis 벡터 실험과 같은 해시 임베딩을 pgvector 에 넣고 KNN 비교
- [ ] 전문 검색 + 벡터 RRF 하이브리드 SQL 실행
- [ ] LISTEN/NOTIFY 로 SKIP LOCKED 워커 깨우기
- [ ] RLS 로 tenant 격리 후 다른 tenant 설정에서 조회가 비는지 확인
- [ ] `hnsw.ef_search` 를 10/40/200 으로 바꿔 정확 검색 대비 recall@5 측정
- [ ] PostgreSQL FTS(`simple` 사전)로 한국어 노트 제목을 검색해 OpenSearch nori 결과와 비교
