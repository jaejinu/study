---
title: "인덱스 구조 — 질의의 모양이 인덱스를 고른다"
order: 5
level: 중급
summary: "B-tree 가 못 하는 것들과 그 답: 해시(점 조회), 비트맵(낮은 카디널리티·조합 조건), GIN(역색인: 배열·JSONB·전문 검색), GiST/SP-GiST(범위·기하·근접), BRIN(물리 순서와 상관된 큰 테이블), HNSW/IVF(벡터). 커버링·부분·표현식·복합 인덱스의 컬럼 순서, 인덱스의 비용(쓰기·공간·계획), 질의 → 인덱스 선택표"
tags: [인덱스, 해시 인덱스, 비트맵, GIN, GiST, BRIN, HNSW, 커버링 인덱스, 부분 인덱스, 복합 인덱스]
experiments: [dbi-btree-pageinspect]
---

## 질문부터: 이 질의는 무엇을 묻는가

인덱스는 "어떤 질의를 빠르게 할 것인가" 에 대한 답이다. 같은 데이터라도 질의 모양이 다르면 맞는 구조가 다르다.

| 질의 모양 | 예 | 맞는 구조 |
|---|---|---|
| 정확히 일치(점 조회) | `where id = 42` | B-tree, 해시 |
| 범위·정렬·접두사 | `where created > now() - '1d'`, `order by ... limit` | **B-tree** |
| 값 안에 포함 | `tags @> '{redis}'`, `doc @> '{"type":"order"}'`, 전문 검색 | **GIN**(역색인) |
| 겹침·근접·기하 | `tsrange && tsrange`, `point <-> point`, 지리 | **GiST / SP-GiST** |
| 거대 테이블의 시간 범위 | 수십억 행 로그 `where ts between ...` | **BRIN** |
| 낮은 카디널리티 조합 | `status='paid' and region='kr' and channel='app'` | 비트맵 (PG 는 실행 시 비트맵) |
| 의미적 유사도 | `order by embedding <=> $1 limit 10` | **HNSW / IVF** |

## B-tree — 기본값, 그리고 한계

[B-tree](/db-internals/notes/02-btree-pages-buffer-pool)는 정렬 순서가 있는 모든 것(=, <, >, between, 접두사 like, order by, min/max)을 처리한다. 못 하는 것:

- **값 안의 원소**: 배열 `{redis, kafka}` 에 `kafka` 가 있는가 — 값 전체를 정렬 키로 쓰니 내부를 못 본다.
- **다차원**: (위도, 경도) 근처 — 한 차원으로 정렬하면 다른 차원이 흩어진다.
- **접미사·중간 일치**: `like '%복제%'` — 정렬 순서와 무관.
- **선택도가 낮은 조건**: 전체의 30% 를 고르는 조건은 인덱스 → 힙 임의 접근이 순차 스캔보다 느리다([PG 인덱스](/postgres/notes/02-indexes-explain)).

## 해시 인덱스

키를 해시해 버킷으로. **`=` 만** 된다(범위·정렬 불가). B-tree 의 O(log N) 대신 O(1) 이지만, B-tree 도 높이 3~4 에 상위 노드가 캐시돼 있어 실제 차이는 작다.

- PostgreSQL 해시 인덱스는 10 이전엔 WAL 로깅이 안 돼 쓰지 말라는 것이 정설이었고, 지금은 안전하지만 여전히 드물다. 긴 키(URL, 긴 문자열)의 등호 조회에서 B-tree 보다 작다는 정도가 장점.
- 해시 인덱스의 진짜 무대는 **메모리** 다: Redis 의 딕셔너리([Redis 내부](/redis/notes/16-internals-deep-dive)), InnoDB 의 adaptive hash index(자주 쓰는 B-tree 경로를 메모리 해시로 바로가기), Bitcask 의 키 디렉터리.
- **점진적 리해싱**(Redis), **확장 해싱·선형 해싱**(디스크 해시가 버킷을 한꺼번에 재배치하지 않도록)이 해시 구조의 핵심 기법이다.

## 비트맵

값마다 비트 배열(행 수만큼)을 둔다. `status='paid'` 의 비트맵 AND `region='kr'` 의 비트맵 → 비트 연산 한 번으로 교집합.

```
status=paid  1 0 1 1 0 0 1 0
region=kr    1 1 0 1 0 1 1 0
AND          1 0 0 1 0 0 1 0   → 행 0, 3, 6
```

- 카디널리티가 낮은 열(성별, 상태, 국가)에서 공간 효율 최고(압축: RLE, **Roaring bitmap**).
- 여러 조건의 AND/OR 조합이 거의 공짜 → 분석·OLAP·검색 엔진 필터 캐시([OpenSearch filter](/opensearch/notes/03-query-dsl-bm25)).
- 단점: 갱신이 비싸다(행 하나 바꾸면 비트맵 여러 개, 압축 재계산). OLTP 에는 부적합.
- PostgreSQL 은 저장된 비트맵 인덱스가 없지만 **Bitmap Index Scan** 으로 실행 시 B-tree 결과를 비트맵으로 만들어 AND/OR 하고, 힙을 **페이지 순서대로** 읽는다(임의 I/O 를 순차에 가깝게). `EXPLAIN` 에 `BitmapAnd` 가 보이면 이것이다.

## GIN — 데이터베이스 안의 역색인

**G**eneralized **In**verted index. [검색 엔진의 역색인](/opensearch/notes/01-inverted-index-analyzers)과 같은 구조: **원소 → 그 원소를 가진 행 목록(포스팅)**.

```sql
CREATE INDEX ON notes USING gin (tags);                       -- 배열
CREATE INDEX ON events USING gin (payload jsonb_path_ops);     -- JSONB 포함 질의
CREATE INDEX ON notes USING gin (to_tsvector('simple', body)); -- 전문 검색
CREATE INDEX ON users USING gin (email gin_trgm_ops);          -- pg_trgm: like '%abc%' 를 3-gram 으로
```

| 연산 | 예 |
|---|---|
| 배열 포함·겹침 | `tags @> '{redis}'`, `tags && '{redis,kafka}'` |
| JSONB 포함 | `payload @> '{"type": "order"}'` |
| 전문 검색 | `tsv @@ to_tsquery('복제 & 지연')` |
| 중간 일치 | `email like '%gmail%'` (pg_trgm) |

비용: 행 하나에 원소가 많으면 포스팅 여러 개를 갱신해야 해 **쓰기가 느리다**. 그래서 GIN 은 **pending list**(fastupdate) 에 새 항목을 모았다가 VACUUM·임계값에서 한꺼번에 병합한다 — [LSM](/db-internals/notes/03-lsm-tree-compaction)의 memtable 과 같은 아이디어. 대신 pending list 가 크면 검색이 그것을 순차로 훑어야 해 느려진다(`gin_pending_list_limit`).

## GiST 와 SP-GiST

**G**eneralized **Se**arch **T**ree — "균형 트리인데, 각 노드가 자식들을 **감싸는 영역**(바운딩 박스, 범위, 술어)을 갖는" 틀. R-tree 가 대표다.

```
루트: [전체 영역]
 ├─ 노드A: [서울 근방 박스]  → 자식 박스들 → 실제 점들
 └─ 노드B: [부산 근방 박스]
"이 점에서 5km 이내" → 겹치는 박스만 내려간다 (형제끼리 겹칠 수 있어 여러 경로를 탈 수 있음)
```

- 기하(PostGIS), 범위 타입 겹침(`tsrange && tsrange` — 예약 시스템의 **배제 제약** `EXCLUDE USING gist (room with =, during with &&)` 로 이중 예약을 DB 가 막는다), 최근접(`ORDER BY location <-> point LIMIT 5`, KNN-GiST).
- **SP-GiST**(space-partitioned): 쿼드트리·k-d 트리·트라이처럼 **겹치지 않게** 공간을 나눈다. 분포가 고르지 않은 데이터, 접두사(전화번호·IP) 검색.

## BRIN — 아주 작은 인덱스

**B**lock **R**ange **IN**dex. 연속된 페이지 묶음(기본 128페이지 = 1MB)마다 **최솟값·최댓값만** 저장한다.

```
블록 0~127:     ts 2026-10-01 00:00 ~ 2026-10-01 02:13
블록 128~255:   ts 2026-10-01 02:13 ~ 2026-10-01 04:30
...
where ts between '2026-10-01 03:00' and '03:10' → 두 번째 묶음만 읽음
```

- 1억 행 테이블의 B-tree 가 2GB 일 때 BRIN 은 **수십 KB**.
- 조건: 값이 **물리적 저장 순서와 상관**돼 있어야 한다(추가 전용 로그·시계열의 시간 열). 무작위로 섞인 열이면 모든 묶음의 범위가 전체를 덮어 쓸모없다.
- 정확한 행이 아니라 "볼 가치가 있는 블록" 을 알려 주는 **손실** 인덱스 → 그 블록들은 재검사.
- 이것은 [파티셔닝](/postgres/notes/06-partitioning-scale)의 파티션 프루닝, Parquet 의 row group 통계, ClickHouse 의 sparse index·skip index 와 같은 원리(zone map)다.

## HNSW 와 IVF — 벡터

정확한 최근접 이웃은 차원이 높으면 전수 비교밖에 없다(차원의 저주). 그래서 **근사**(ANN)를 쓴다.

| | HNSW | IVF(+PQ) |
|---|---|---|
| 구조 | 계층적 근접 그래프: 위층은 듬성(고속도로), 아래층은 촘촘 | k-means 로 공간을 `nlist` 개 클러스터로, 질의는 가까운 `nprobe` 개 클러스터만 |
| 질의 | 최상층 진입점에서 탐욕적으로 가까운 이웃으로 이동, 층을 내려가며 | 클러스터 중심과 비교 → 해당 클러스터 안 전수 비교 |
| 손잡이 | `m`(이웃 수), `ef_construction`, `ef_search` | `nlist`, `nprobe`, PQ 코드 크기 |
| 장점 | 재현율·지연 최고, 점진 삽입 쉬움 | 메모리 작음(PQ 압축), 빌드 빠름 |
| 단점 | 메모리 큼, 삭제 어려움 | 데이터 분포가 바뀌면 재학습, 재현율 손잡이 민감 |
| 예 | pgvector `hnsw`, OpenSearch lucene, Redis Search | pgvector `ivfflat`, faiss IVF-PQ |

공통: **필터와 함께 쓰기가 어렵다**(그래프 탐색 중 필터에 안 맞는 노드를 건너뛰면 연결이 끊긴다). [하이브리드 검색 노트](/opensearch/notes/05-hybrid-search-rag)의 사전/사후 필터 문제, [PG 의 pgvector](/postgres/notes/08-jsonb-fulltext-pgvector) 실험에서 작은 테이블이 HNSW 대신 Seq Scan 을 고른 이유(플래너는 정확 전수 비교가 더 싸다고 판단)와 이어진다.

## B-tree 를 더 잘 쓰는 법

### 복합 인덱스의 컬럼 순서

`(a, b, c)` 인덱스는 a 로 정렬, 같은 a 안에서 b, 그 안에서 c. 그래서:

| 조건 | 쓸 수 있나 |
|---|---|
| `a = 1` | ✓ |
| `a = 1 and b = 2` | ✓ |
| `a = 1 and b > 2 order by b` | ✓ (범위 + 정렬) |
| `b = 2` | ✗ (선두 열 없음. PG 는 skip scan 이 18 부터 일부) |
| `a > 1 and b = 2` | a 범위까지만, b 는 필터 |
| `a = 1 order by c` | 정렬에 못 씀(b 가 끼어 있음) |

규칙: **등호 조건 열을 앞에, 범위 열을 마지막에, 정렬 열을 범위 대신 마지막에**. 그리고 선택도가 높은 열이 앞이 좋다는 것은 반만 맞다 — 질의 패턴(어떤 조합이 오는가)이 먼저다.

### 커버링, 부분, 표현식

```sql
-- 커버링: 리프에 추가 열을 실어 힙 방문 없이(Index Only Scan)
CREATE INDEX ON orders (customer_id, created_at DESC) INCLUDE (status, amount);

-- 부분: 관심 있는 행만 (작고 빠름). 질의 조건이 인덱스 조건을 함의해야 사용됨
CREATE INDEX ON orders (created_at) WHERE status = 'pending';

-- 표현식: 함수 결과로
CREATE INDEX ON users (lower(email));          -- where lower(email) = ...
CREATE INDEX ON events ((payload->>'type'));    -- JSONB 키 하나만 B-tree 로
```

부분 인덱스는 "큐 테이블에서 미처리 건만" 같은 패턴에 특히 강하다: 처리된 수억 행은 인덱스에 없고 미처리 수백 행만 있다.

## 인덱스의 비용

| 비용 | 내용 |
|---|---|
| 쓰기 | INSERT 마다 모든 인덱스 갱신. 인덱스 10개면 쓰기가 ~10배. UPDATE 가 인덱스 열을 건드리면 PG 의 HOT 불가 |
| 공간 | 테이블보다 큰 인덱스 합계는 흔하다. 버퍼 풀을 나눠 먹는다 |
| 계획 | 인덱스가 많으면 플래너 후보가 늘고, 잘못된 통계로 나쁜 선택 |
| 유지 | 블로트, REINDEX, 통계 |

```sql
-- 한 번도 안 쓴 인덱스 찾기
SELECT relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes WHERE idx_scan = 0 ORDER BY pg_relation_size(indexrelid) DESC;
```

## 예시로 보기 — 이 프로젝트에서

- **B-tree 내부**: 실험 `dbi-btree-pageinspect` 로 리프·루트·채움률을 직접 본다.
- **GIN·전문 검색·HNSW**: [PostgreSQL 노트 08](/postgres/notes/08-jsonb-fulltext-pgvector)과 PG 실험 `pg-vector-search`(pgvector HNSW, `enable_seqscan=off` 로 인덱스 경로 강제).
- **역색인의 원형**: [OpenSearch 실험](/opensearch/lab) `search-index-notes`.
- **비트맵**: 아래로 PG 의 실행 시 비트맵을 본다.

```sql
CREATE TABLE lab_orders AS SELECT g id, (array['paid','pending','failed'])[1 + g % 3] status,
  (array['kr','jp','us','de'])[1 + g % 4] region, now() - (g || 's')::interval created FROM generate_series(1, 200000) g;
CREATE INDEX ON lab_orders (status); CREATE INDEX ON lab_orders (region); ANALYZE lab_orders;
EXPLAIN SELECT * FROM lab_orders WHERE status = 'failed' AND region = 'kr';   -- BitmapAnd ?
CREATE INDEX lab_orders_brin ON lab_orders USING brin (created);
SELECT pg_size_pretty(pg_relation_size('lab_orders_brin'));                   -- 수십 KB
```

## 실전에서는 어디에 쓰이나

> 기능이 "검색", "근처 찾기", "비슷한 것 추천", "최근 N 일 로그" 처럼 바뀔 때마다 질의 모양이 달라지고, 그에 맞는 인덱스 구조를 고르는 순간에 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 숙박·회의실 예약 | 이중 예약 방지 | GiST 배제 제약 `EXCLUDE USING gist (room with =, during with &&)` | 앱 레벨 확인 후 삽입(경합 조건) |
| 배달·모빌리티 위치 검색 | 반경 안 최근접 | PostGIS GiST + KNN `<->` | 지오해시 + B-tree, Redis GEO |
| 커머스 상품 속성 필터 | 배열·JSONB 포함 질의 | GIN(`jsonb_path_ops`) | 검색 엔진(OpenSearch)으로 분리 |
| AI 서비스 RAG | 임베딩이 가까운 문서 상위 k | pgvector HNSW, 필터는 사전·사후 전략 선택 | 전용 벡터 DB, OpenSearch k-NN |
| 사내 감사 로그·이벤트 테이블 | 수십억 행의 시간 범위 조회 | 추가 순서와 상관된 시간 열에 BRIN | B-tree(크기가 GB 단위), 파티셔닝 |

**이럴 땐 안 맞는다**
- 쓰기가 많은 테이블에 "혹시 몰라" 인덱스 추가 — INSERT 마다 모든 인덱스가 갱신된다. `idx_scan = 0` 인덱스부터 정리한다.
- 형태소 분석·랭킹·하이라이트가 핵심인 전문 검색을 GIN 만으로 — 검색 엔진이 맞다.

**누가 매일 만나나** — 백엔드 개발자가 새 기능 쿼리를 만들며 `EXPLAIN` 을 볼 때, ML 엔지니어가 RAG 벡터 검색의 재현율·지연 손잡이(`ef_search`, `nprobe`)를 조정할 때.

**면접·실무 단골 질문**
- Q. 복합 인덱스 컬럼 순서는 어떻게 정하나? → 등호 조건 열을 앞에, 범위·정렬 열을 뒤에. 실제로 오는 질의 조합이 먼저다.
- Q. 인덱스를 탔는데 왜 느린가? → 선택도가 낮으면 인덱스 → 힙 임의 접근이 순차 스캔보다 비싸다.

## 실습 체크리스트

- [ ] 위 SQL 로 `BitmapAnd` 계획을 만들고, 조건 하나를 더 선택적으로 바꿨을 때 플래너가 단일 Index Scan 으로 바꾸는지 보기
- [ ] 같은 `created` 열에 B-tree 와 BRIN 을 만들어 크기와 시간 범위 질의 시간을 비교, 행을 무작위로 섞은 테이블에서 BRIN 이 무력해지는 것 확인
- [ ] `tags text[]` 열에 GIN 을 만들고 `@>` 질의의 `EXPLAIN` 을 B-tree 시도와 비교
- [ ] `(customer_id, created_at)` 복합 인덱스로 표의 여섯 조건을 각각 `EXPLAIN` 해 쓰이는지 확인
- [ ] 큐 테이블 패턴에 부분 인덱스(`where processed = false`)를 만들어 전체 인덱스 대비 크기를 비교하기
