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
