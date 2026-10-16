---
title: Redis 8 내장 모듈 — JSON, Search, 확률적 구조, TimeSeries
order: 15
level: 심화
summary: 예전 Redis Stack 모듈이 Redis 8 에 내장되었다. 각 모듈이 어떤 문제를 풀고 기본 자료구조와 어떻게 다른지
tags: [Redis8, JSON, Search, Bloom, TimeSeries, 모듈]
experiments: [json-basics, search-basics, bloom-filter, timeseries-basics]
---

## 무엇이 바뀌었나

Redis 8 (2025) 부터 별도 모듈(Redis Stack)로 제공되던 기능이 **오픈소스 Redis 본체에 포함**됐다.

| 기능 | 명령 접두어 | 예전 이름 |
|---|---|---|
| JSON 문서 | `JSON.*` | RedisJSON |
| 2차 인덱스·전문 검색·벡터 검색 | `FT.*` | RediSearch |
| Bloom / Cuckoo / Count-Min / Top-K / t-digest | `BF.*`, `CF.*`, `CMS.*`, `TOPK.*`, `TDIGEST.*` | RedisBloom |
| 시계열 | `TS.*` | RedisTimeSeries |

```
MODULE LIST          # ReJSON, search, bf, timeseries 가 보이면 사용 가능
```

> 주의: Homebrew 로 빌드한 `redis-server` 에는 모듈이 없다. 공식 Docker 이미지(`redis:8`) 에는 들어 있다. 이 프로젝트에선 `pnpm redis:docker` 로 띄운 Redis 에서 모듈 실험이 동작한다.

## JSON

```
JSON.SET user:1 $ '{"name":"alice","tags":["a"],"address":{"city":"seoul"}}'
JSON.GET user:1 $.address.city        # ["seoul"]
JSON.NUMINCRBY user:1 $.age 1
JSON.ARRAPPEND user:1 $.tags '"b"'
JSON.SET user:1 $.address.zip '"04524"'
```

- **JSONPath** (`$` 루트, `$.a.b`, `$.arr[0]`, `$..name` 재귀, `$.arr[?(@.price>100)]` 필터)
- Hash 와 비교: Hash 는 평면 구조·메모리 효율, JSON 은 중첩·배열·부분 갱신. 문서 전체를 통째로 읽고 쓰는 게 대부분이면 String 에 JSON 문자열도 충분하다.
- 클라이언트는 대부분 `JSON.GET` 결과를 문자열로 주므로 파싱이 필요하다.

## Search (Redis Query Engine)

```
FT.CREATE idx:prod ON HASH PREFIX 1 prod: SCHEMA name TEXT price NUMERIC SORTABLE category TAG
FT.SEARCH idx:prod "keyboard @price:[0 100000] @category:{input}" SORTBY price ASC
FT.AGGREGATE idx:prod "*" GROUPBY 1 @category REDUCE COUNT 0 AS n
```

- 인덱스는 **접두어**로 대상 키를 고르고, 이후 쓰기는 자동 반영된다. 기존 키는 생성 시점에 백그라운드로 스캔한다.
- 필드 타입: `TEXT`(형태소·스테밍·전문), `NUMERIC`(범위), `TAG`(정확 일치, `{a|b}`), `GEO`, `VECTOR`(KNN).
- JSON 도 인덱싱 가능: `ON JSON SCHEMA $.name AS name TEXT`.
- **벡터 검색**: `VECTOR FLAT|HNSW 6 TYPE FLOAT32 DIM 1536 DISTANCE_METRIC COSINE` 로 선언하고 `FT.SEARCH idx "*=>[KNN 5 @vec $q]" PARAMS 2 q <bytes>`. RAG 의 벡터 저장소로 쓰는 방식이다.
- 인덱스는 메모리를 쓴다. `FT.INFO` 로 크기 확인.

## 확률적 자료구조

| 구조 | 질문 | 특징 |
|---|---|---|
| Bloom (`BF`) | 있나? | 거짓 양성 있음, 삭제 불가, 매우 작음 |
| Cuckoo (`CF`) | 있나? | 삭제 가능, 약간 더 큼 |
| Count-Min Sketch (`CMS`) | 몇 번 나왔나? | 과대 추정만 있음 (빈도 세기) |
| Top-K (`TOPK`) | 가장 많이 나온 K 개는? | 핫 키/인기 검색어 |
| t-digest (`TDIGEST`) | p99 가 얼마인가? | 분위수 근사 (지연 시간 분포) |

```
BF.RESERVE seen 0.01 1000000     # 오차율, 예상 개수 → 크기 자동 계산
BF.ADD seen url1 ; BF.EXISTS seen url1
TOPK.RESERVE hot 10 ; TOPK.ADD hot k1 k2 k1 ; TOPK.LIST hot
TDIGEST.CREATE lat ; TDIGEST.ADD lat 12 15 200 ; TDIGEST.QUANTILE lat 0.99
```

HyperLogLog(`PF*`) 는 모듈이 아니라 원래 코어에 있다 ([확률적 자료구조 노트](/redis/notes/13-probabilistic)).

## TimeSeries

```
TS.CREATE temp:room1 RETENTION 86400000 LABELS sensor temp room 1
TS.ADD temp:room1 * 21.5                      # * = 현재 시각
TS.RANGE temp:room1 - + AGGREGATION avg 60000 # 1분 평균
TS.MRANGE - + FILTER sensor=temp              # 라벨로 여러 시계열
TS.CREATERULE temp:room1 temp:room1:1h AGGREGATION avg 3600000   # 자동 다운샘플링
```

- 샘플은 압축되어 평균 1~2 바이트 수준. `RETENTION` 으로 오래된 샘플 자동 삭제.
- Prometheus 같은 전용 TSDB 를 대체하진 않지만, 이미 Redis 를 쓰는 앱의 소규모 메트릭·센서 데이터엔 간편하다.

## 언제 쓰고 언제 안 쓰나

- 기본 자료구조로 충분한지 먼저 본다. Hash + ZSet 으로 되는 걸 Search 로 풀면 운영 복잡도만 는다.
- 관리형 서비스(ElastiCache 등)는 모듈 지원 여부가 다르다. 배포 환경을 먼저 확인.
- 모듈 명령은 클라이언트 라이브러리가 타입을 모를 수 있다 → ioredis 는 `redis.call("JSON.GET", ...)` 로 호출한다 (이 프로젝트의 실험이 그렇게 한다).

## 모듈을 쓸지 고르는 기준

| 하고 싶은 것 | 기본 자료구조로 | 모듈로 | 판단 |
|---|---|---|---|
| 상품을 가격 범위로 조회 | ZSet(score=가격) 인덱스를 직접 유지 | `FT.SEARCH @price:[a b]` | 조건이 1~2개면 ZSet, 조합이 많으면 Search |
| 중첩 문서 부분 갱신 | Hash 평탄화 또는 JSON 문자열 통째 | `JSON.SET $.a.b` | 중첩·배열이 핵심이면 JSON |
| 전문 검색(한국어) | 불가 | `FT` TEXT(형태소 제한적) | 품질이 중요하면 OpenSearch([검색 주제](/opensearch/notes/01-inverted-index-analyzers)) |
| 벡터 유사도 | 불가 | `VECTOR HNSW` | 이미 Redis 가 있고 수백만 건 이하면 좋은 선택 |
| 센서 시계열 | ZSet/Stream | `TS.*` 압축·다운샘플 | 장기 보관·대규모면 Prometheus·ClickHouse |

## Search 인덱스는 어떻게 동작하나

1. `FT.CREATE … PREFIX 1 prod:` 가 접두어에 맞는 키를 감시 대상으로 등록한다.
2. 이후 `HSET prod:42 …` 가 일어나면 **같은 명령 안에서 동기적으로** 인덱스가 갱신된다 — 쓰기 직후 검색에 보인다(OpenSearch 의 refresh 지연과 대조).
3. 기존 키는 생성 직후 백그라운드 스캔으로 색인된다(`FT.INFO` 의 `percent_indexed`).
4. TEXT 필드는 역색인(term → 문서 목록), NUMERIC 은 범위 트리, TAG 는 정확 일치 역색인, VECTOR 는 HNSW 그래프.

```
127.0.0.1:6379> FT.INFO idx:prod
 num_docs 1200
 inverted_sz_mb 0.41
 vector_index_sz_mb 4.8
 percent_indexed 1
```

**비용**: 쓰기마다 인덱스 갱신이 더해진다(단일 스레드 위에서). 인덱스가 많은 키 공간에 대량 쓰기를 하면 쓰기 처리량이 눈에 띄게 줄어든다. 인덱스 메모리도 데이터와 같은 maxmemory 안에서 경쟁한다.

## 벡터 검색 예 — 노트 유사도

```
FT.CREATE idx:notes ON HASH PREFIX 1 note: SCHEMA
  title TEXT  subject TAG
  vec VECTOR HNSW 6 TYPE FLOAT32 DIM 384 DISTANCE_METRIC COSINE

HSET note:redis/06 title "파이프라인" subject redis vec <384×4 바이트>
FT.SEARCH idx:notes "(@subject:{redis})=>[KNN 5 @vec $q AS dist]"
  PARAMS 2 q <질의 벡터> SORTBY dist RETURN 2 title dist DIALECT 2
```

| HNSW 파라미터 | 의미 | 트레이드오프 |
|---|---|---|
| `M` | 노드당 연결 수 | 크면 정확·메모리↑ |
| `EF_CONSTRUCTION` | 색인 시 탐색 폭 | 크면 색인 느림·품질↑ |
| `EF_RUNTIME` | 질의 시 탐색 폭 | 크면 질의 느림·재현율↑ |

PostgreSQL pgvector, OpenSearch kNN 과의 비교는 PostgreSQL 주제의 `pg-vector-search` 실험과 [검색 — 하이브리드 검색](/opensearch/notes/05-hybrid-search-rag)에서 이어진다. AI 시스템 주제의 RAG 실험은 바로 이 Redis 벡터 검색을 쓴다.

## 확률 구조를 운영 지표에 — 예

```
# 엔드포인트별 지연 분포를 t-digest 로
TDIGEST.CREATE lat:/api/ask COMPRESSION 100
TDIGEST.ADD lat:/api/ask 230 410 1800 95
TDIGEST.QUANTILE lat:/api/ask 0.5 0.95 0.99
# 가장 많이 호출된 키(핫 키 후보)
TOPK.RESERVE hotkeys 20 2000 7 0.925
TOPK.INCRBY hotkeys progress:read 1
TOPK.LIST hotkeys WITHCOUNT
```

Prometheus 히스토그램은 버킷 경계를 미리 정해야 하지만 t-digest 는 경계 없이 임의 분위수를 묻는다. 대신 여러 인스턴스를 합칠 때 `TDIGEST.MERGE` 를 써야 한다.

## 운영 체크

| 항목 | 확인 |
|---|---|
| 배포 환경이 모듈을 지원하나 | 관리형 서비스마다 다름. 로컬 brew 빌드는 없음(`MODULE LIST` 빈 결과) |
| 레플리카·백업 | 모듈 데이터도 RDB/AOF 에 포함 — 같은 버전 모듈이 있어야 로드 가능 |
| 인덱스 재생성 비용 | 키 수백만 개면 수 분, 그동안 결과 불완전 |
| 메모리 | `FT.INFO` 의 인덱스 크기 + JSON 의 오버헤드(문자열보다 큼) |

## 예시로 보기 — 이 프로젝트에서

- `pnpm redis:docker` 의 `study-redis`(redis:8-alpine)는 모듈이 내장돼 있다. brew `redis-server` 로 띄우면 실험실의 JSON·Search·Bloom·TimeSeries 실험이 "모듈 없음" 으로 건너뛰어진다. 환경 점검 카드가 이를 알려 준다.
- AI 시스템 주제의 벡터 검색 실험과 AI 도우미의 노트 검색은 지금은 단순 키워드 점수(사이트 검색)를 쓰지만, 노트 수가 늘면 위 `idx:notes` 같은 벡터 인덱스로 옮기는 것이 자연스러운 다음 단계다.

## 실습 체크리스트

- [ ] `MODULE LIST` 로 내 Redis 에 어떤 모듈이 있는지 확인하기
- [ ] `FT.CREATE` 로 Hash 인덱스를 만들고 `HSET` 직후 검색에 바로 보이는지 확인하기
- [ ] `FT.INFO` 로 인덱스 메모리 크기 확인하기
- [ ] `TDIGEST` 로 지연 값 몇 개를 넣고 p99 구하기
- [ ] 실험실의 JSON·Search·Bloom·TimeSeries 실험을 Docker Redis 로 돌리기
