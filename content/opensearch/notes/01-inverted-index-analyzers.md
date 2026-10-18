---
title: "역색인과 분석기 — 검색 엔진은 문서를 어떻게 '찾을 수 있게' 만드는가"
order: 1
level: 기초
summary: "데이터베이스의 LIKE 가 검색이 될 수 없는 이유, 토큰 → 문서 목록의 역색인(포스팅 리스트·스킵·압축), 분석기 = 문자 필터 + 토크나이저 + 토큰 필터의 파이프라인, 표준 분석기가 한국어에서 실패하는 지점과 nori 형태소 분석, 세그먼트(불변 파일)와 삭제 마킹, _analyze 로 직접 확인하기. 이 사이트 노트 129편을 색인하는 실험"
tags: [역색인, 포스팅 리스트, 분석기, 토크나이저, nori, 세그먼트, Lucene, OpenSearch]
experiments: [search-index-notes]
---

## LIKE '%복제%' 는 왜 검색이 아닌가

PostgreSQL 에서 `where body like '%복제 지연%'` 을 치면 **모든 행을 처음부터 끝까지** 읽는다. 인덱스는 접두사(`'복제%'`)에만 쓸 수 있고, 어순이 바뀌거나("지연 복제"), 조사가 붙거나("복제본의"), 동의어("레플리카")면 못 찾는다. 결과에 **순위**도 없다 — 100건이 나오면 어느 것이 더 관련 있는지 알 길이 없다.

검색 엔진은 이 세 문제를 구조로 푼다.

| 문제 | DB `LIKE` | 검색 엔진 |
|---|---|---|
| 속도 | 전체 스캔 O(문서 수 × 길이) | 역색인 O(질의 텀 수 × 포스팅 길이) |
| 변형(조사·어미·대소문자·복수형) | 정확히 일치해야 | **분석기**가 색인·질의 양쪽을 같은 형태로 정규화 |
| 순위 | 없음 | **BM25** 로 관련도 점수 ([노트 03](/opensearch/notes/03-query-dsl-bm25)) |

PostgreSQL 도 `tsvector` + GIN 으로 전문 검색을 한다([PostgreSQL JSONB·전문검색·pgvector](/postgres/notes/08-jsonb-fulltext-pgvector)). 원리는 같다. 차이는 분석기의 풍부함, 분산 샤딩, 집계, 그리고 "검색이 본업" 인가다.

## 역색인 — 단어에서 문서로

보통 색인(정색인)은 **문서 → 단어들** 이다. 역색인은 뒤집어 **단어 → 그 단어가 나오는 문서들** 이다.

```
문서 1: "복제 지연 모니터링"
문서 2: "복제 슬롯 WAL"
문서 3: "지연 큐 메시징"

역색인 (텀 사전 → 포스팅 리스트)
  wal       → [2]
  모니터링   → [1]
  복제      → [1, 2]
  슬롯      → [2]
  지연      → [1, 3]
  큐        → [3]
  메시징     → [3]
```

질의 "복제 지연" 은 두 포스팅 리스트 `[1,2]` 와 `[1,3]` 을 가져와 합치면 끝이다. 문서가 1억 개여도 "복제" 가 들어간 문서가 10만 개면 10만 개의 정수 목록만 읽는다.

![역색인과 분석기 파이프라인](/diagrams/search-inverted-index.svg)

### 포스팅 리스트에 들어 있는 것

단순한 문서 ID 목록이 아니다. Lucene 의 포스팅은 텀마다:

| 항목 | 쓰임 |
|---|---|
| **문서 ID** (정렬됨) | 교집합·합집합을 병합 정렬로 빠르게 |
| **텀 빈도(tf)** | 그 문서에 텀이 몇 번 — BM25 점수 |
| **위치(position)** | 구문 검색(`"복제 지연"` 이 붙어 있는가), 근접 검색 |
| **오프셋** | 하이라이트(문서 안 몇 번째 글자) |
| **노름(norm)** | 문서 길이 — 긴 문서의 점수를 깎는 데 |

정렬된 정수 목록이라 **압축**이 잘 된다(델타 인코딩 + 비트 패킹, PForDelta). 그리고 긴 리스트를 건너뛰는 **스킵 리스트**가 있어 "문서 50,000 이후부터" 를 바로 찾는다. `AND` 질의는 짧은 포스팅을 따라가며 긴 포스팅에서 스킵한다 — 그래서 **드문 텀이 섞인 질의가 빠르다**.

### 텀 사전

텀이 수백만 개면 텀 자체를 찾는 것도 일이다. Lucene 은 텀 사전을 **FST**(finite state transducer, 접두사를 공유하는 압축 트라이)로 메모리에 올린다. 그래서 `prefix`·`wildcard`·`fuzzy` 질의가 가능하고, 반대로 `*복제` 같은 **앞 와일드카드**는 FST 를 못 쓰고 전체 텀을 훑어 느리다.

## 분석기 — 텍스트를 토큰으로

역색인의 키는 **토큰**이다. 어떤 토큰을 만들지가 분석기(analyzer)의 일이고, 분석기는 세 단계의 파이프라인이다.

```
원문  →  [문자 필터]  →  [토크나이저]  →  [토큰 필터 × N]  →  토큰
         HTML 제거       단어 경계 분리     소문자, 불용어, 어간, 동의어
```

| 단계 | 예 | 한다 |
|---|---|---|
| 문자 필터 | `html_strip`, `mapping` | `<b>복제</b>` → `복제`, `&` → `and` |
| 토크나이저 | `standard`, `whitespace`, `nori_tokenizer`, `ngram`, `keyword` | 문자열을 토큰 단위로 자른다. **하나만** |
| 토큰 필터 | `lowercase`, `stop`, `stemmer`, `synonym`, `nori_part_of_speech`, `edge_ngram` | 토큰을 바꾸거나 버리거나 늘린다. 여러 개, 순서 중요 |

```json
PUT /notes
{
  "settings": {
    "analysis": {
      "analyzer": {
        "korean": {
          "type": "custom",
          "char_filter": ["html_strip"],
          "tokenizer": "nori_tokenizer",
          "filter": ["nori_readingform", "lowercase", "nori_part_of_speech"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "body": { "type": "text", "analyzer": "korean", "search_analyzer": "korean" }
    }
  }
}
```

**색인 시 분석기와 검색 시 분석기는 같아야 한다**(기본값이 같음). 색인은 nori 로 하고 검색은 standard 로 하면 "복제" 를 넣어도 "복제본의" 토큰과 안 맞는다. 일부러 다르게 쓰는 경우는 자동완성(색인은 `edge_ngram`, 검색은 그대로)뿐이다.

## 표준 분석기는 한국어에서 어디서 실패하나

`standard` 토크나이저는 유니코드 단어 경계(공백·기호)로 자른다. 영어는 이걸로 충분하다("replication", "Replication" → lowercase 로 같아짐). 한국어는 **교착어**라 조사·어미가 단어에 붙는다.

```
"복제본의 지연을 모니터링한다"
standard →  복제본의 | 지연을 | 모니터링한다
nori     →  복제 | 본 | 지연 | 모니터링 | 하     (조사 의·을, 어미 ㄴ다 는 품사 필터로 제거)
```

표준 분석기로 색인하면 "복제" 라는 질의는 "복제본의" 토큰과 **다른 텀**이라 못 찾는다. 실험 `search-index-notes` 가 이 사이트 노트 129편으로 측정한 결과: 질의 "복제 지연" 이 표준 필드에서 65건, nori 필드에서 88건을 찾았다. 23건은 조사가 붙은 변형("복제를", "지연이") 때문에 표준 분석기가 놓친 것이다.

### nori — 형태소 분석

`nori` 는 Lucene 에 내장된 한국어 형태소 분석기(mecab-ko-dic 사전 기반)다. 세 부품:

| 부품 | 역할 | 설정 |
|---|---|---|
| `nori_tokenizer` | 형태소로 자르고 품사 태그를 붙인다 | `decompound_mode`: `none`(복합어 그대로) / `discard`(쪼갠 것만) / `mixed`(둘 다) · `user_dictionary` |
| `nori_part_of_speech` | 품사로 토큰을 버린다 | `stoptags`: 조사(J), 어미(E), 기호(S*), 접미사(XS*) … |
| `nori_readingform` | 한자를 한글 읽기로 | 牛 → 우 |

`decompound_mode: mixed` 는 "파이프라인" 을 `파이프라인`, `파이프`, `라인` 세 토큰으로 낸다 — 복합어 검색과 부분 검색을 둘 다 잡는 대신 색인이 커진다.

**사전이 전부다.** 실험에서 기본 사전의 nori 는 "복제본" 을 `복 + 제본`(책 제본!)으로 잘라 "복제" 를 아예 만들지 못했다. `user_dictionary_rules: ["복제본 복제 본"]` 한 줄을 주자 `복제본, 복제, 본` 이 나왔다. 도메인 용어(레이트리밋, 핫키, 컨슈머)는 반드시 사용자 사전에 넣어야 하고, 사전을 바꾸면 **리인덱스**가 필요하다([노트 07](/opensearch/notes/07-korean-and-ranking)).

## 세그먼트 — 불변 파일의 집합

Lucene 인덱스는 하나의 큰 파일이 아니라 **세그먼트**(작은 역색인) 여러 개다. 문서를 추가하면 메모리 버퍼에 쌓였다가 **refresh** 때 새 세그먼트로 써진다. 세그먼트는 **불변**이다:

- 쓰기가 단순하다(추가만). 읽기는 락이 없다. OS 페이지 캐시에 그대로 올라간다.
- **삭제**는 실제로 지우지 않고 `.liv` 비트맵에 "죽음" 표시만 한다. 검색 결과에서 걸러진다.
- **갱신** = 삭제 + 새 문서 추가. 그래서 문서를 자주 바꾸는 워크로드는 죽은 문서가 쌓인다.
- 세그먼트가 많아지면 검색이 모든 세그먼트를 돌아야 해 느려진다 → 백그라운드 **머지**가 작은 세그먼트들을 큰 것 하나로 합치며 죽은 문서를 그때 버린다.

이 구조는 [LSM 트리](/db-internals/notes/03-lsm-tree-compaction)와 똑같다. memtable = 색인 버퍼, SSTable = 세그먼트, 컴팩션 = 머지. 검색 엔진이 "쓰기는 빠르고 삭제가 비싸고 머지가 I/O 를 먹는" 이유가 여기 있다.

```bash
curl localhost:19200/lab-notes/_stats/segments | jq '.indices["lab-notes"].primaries.segments.count'
curl localhost:19200/_cat/segments/lab-notes?v     # 세그먼트별 문서 수, 삭제 수, 크기
curl -X POST localhost:19200/lab-notes/_forcemerge?max_num_segments=1   # 읽기 전용 인덱스에만
```

## _analyze 로 직접 확인하기

분석기 설정을 바꿀 때마다 반드시 `_analyze` 로 토큰을 본다. 추측하지 말 것.

```bash
curl -X POST localhost:19200/lab-notes/_analyze -H 'Content-Type: application/json' -d '{
  "analyzer": "korean",
  "text": "복제본의 지연을 모니터링한다"
}' | jq '[.tokens[] | {token, position, type}]'
```

```json
[{"token":"복제","position":0},{"token":"본","position":1},{"token":"지연","position":2},
 {"token":"모니터링","position":3},{"token":"하","position":4}]
```

`explain: true` 를 주면 각 단계(토크나이저 → 필터)마다 토큰이 어떻게 변했는지 보여 준다. 품사 태그(`leftPOS`)도 나오므로 `stoptags` 를 조정할 근거가 된다.

## 예시로 보기 — 이 프로젝트에서

`pnpm search:up` 이 OpenSearch 2.19(단일 노드, 보안 플러그인 끔, 19200) 를 띄운다. 실험 `search-index-notes` 는:

1. nori 플러그인이 없으면 `opensearch-plugin install analysis-nori` 후 컨테이너를 재시작한다(1~2분).
2. `lab-notes` 인덱스를 **두 분석기**로 만든다 — `body`(nori + 사용자 사전) 와 `body.std`(standard) 멀티필드.
3. 이 사이트 노트 전편(129편, 약 350K자)을 `_bulk` 로 색인한다 — 1초 안에 끝나고 저장소는 1.2MB(원문보다 작다: 압축 + 불용어 제거).
4. 같은 문장을 세 분석기(standard / nori 기본 사전 / nori + 사용자 사전)에 넣어 토큰을 나란히 보여 준다.
5. "복제 지연" 을 두 필드에 검색해 건수와 상위 3건, 그리고 `_explain` 으로 BM25 점수가 텀별로 어떻게 합산됐는지 보여 준다.

인덱스는 실험 후에도 남는다. 터미널에서 계속 만져 보자:

```bash
curl -s 'localhost:19200/lab-notes/_search?q=body:파이프라인&size=3' | jq '.hits.hits[] | {score:._score, title:._source.title}'
curl -s localhost:19200/_cat/indices?v
```

## 흔한 실수

- **색인 분석기 ≠ 검색 분석기**: 매핑에 `analyzer` 만 주면 검색도 같은 것을 쓴다. `search_analyzer` 를 따로 줄 때는 이유가 있어야 한다.
- **`keyword` 가 필요한 곳에 `text`**: 주제 id, 태그, 상태값은 분석하면 안 된다(정확 일치·집계·정렬). [노트 02](/opensearch/notes/02-mapping-shards-replicas).
- **분석기 변경 후 리인덱스 생략**: 이미 색인된 토큰은 안 바뀐다. 별칭으로 무중단 리인덱스([노트 06](/opensearch/notes/06-operations)).
- **앞 와일드카드·정규식 질의**: 텀 사전 전체 스캔. 자동완성은 `edge_ngram` 으로 색인 시점에 풀어라.
- **nori 기본 사전만 믿기**: 도메인 용어는 반드시 `_analyze` 로 확인하고 사용자 사전에.

## 실전에서는 어디에 쓰이나 — OpenSearch 지도

> OpenSearch 같은 검색 엔진은 "단어로 찾고, 관련도 순으로 줄 세우고, 아무 필드로나 빠르게 거르고 세는" 일을 맡는다. 원천 데이터는 DB 에 두고, 찾기 위한 사본(역색인)을 따로 만드는 것이 기본 구도다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 커머스 상품 검색에서 "운동화를" 로도 "운동화" 를 찾기 | 역색인, 분석기, nori 형태소 분석 | 이 노트 |
| 상품·주문·티켓을 검색 인덱스로 옮길 때 스키마 설계 | text/keyword 매핑, 샤드·복제본, refresh | [매핑·샤드·복제본](/opensearch/notes/02-mapping-shards-replicas) |
| 검색 결과 순위 조정, 필터·페이지네이션 | 쿼리 DSL, BM25, filter context, search_after | [쿼리 DSL 과 BM25](/opensearch/notes/03-query-dsl-bm25) |
| 보안 이벤트·감사 로그를 아무 필드로나 조사(SIEM) | 집계, doc values, Loki 와의 선택 | [집계와 로그 분석](/opensearch/notes/04-aggregations-log-analysis) |
| 사내 문서 기반 AI 챗봇(RAG)의 검색기 | kNN 벡터, BM25 와 RRF 하이브리드, 리랭킹 | [하이브리드 검색과 RAG](/opensearch/notes/05-hybrid-search-rag) |
| 로그 인덱스가 디스크를 채우고 색인이 멈추는 운영 장애 | ISM 롤오버, 무중단 리인덱스, 힙·페이지 캐시, 스냅샷 | [운영](/opensearch/notes/06-operations) |
| 한국어 서비스의 오타·초성·동의어 검색과 랭킹 개선 | 사용자 사전, synonym_graph, 자모 분해, LTR, nDCG | [한국어 검색과 랭킹](/opensearch/notes/07-korean-and-ranking) |

**회사 규모에 따라**
- 스타트업: 먼저 PostgreSQL 전문 검색·pgvector 로 버티고, 검색이 핵심 기능이 되면 관리형 OpenSearch 단일 클러스터 하나를 쓴다.
- 성장기: CDC 로 DB → 검색 인덱스를 동기화하고, 별칭 리인덱스·ISM·사용자 사전을 운영 절차로 만든다. 로그용과 서비스 검색용 클러스터를 분리한다.
- 대규모 조직: 검색 품질 전담 팀이 평가 세트(nDCG)·A/B·LTR 로 랭킹을 개선하고, 인프라 팀은 핫·웜 계층과 멀티 클러스터를 운영한다.

**이럴 땐 안 맞는다**
- 원천 데이터 저장소(정합성이 필요한 주문·잔액) — near-real-time 이고 트랜잭션이 없다. DB 를 원천으로 두고 검색 엔진은 사본으로 쓴다.
- 데이터가 작고 검색이 부가 기능 — DB 의 `tsvector`+GIN 이나 `pg_trgm` 이 운영 부담 없이 충분하다.
- 대량 애플리케이션 로그를 싸게 오래 보관 — 전 필드 색인 비용이 크다. 라벨만 색인하는 Loki 류가 맞다.

**누가 매일 만나나** — 백엔드 개발자는 검색 API 와 매핑을 만들 때, 데이터·검색 엔지니어는 분석기·랭킹을 조정할 때, SRE 는 클러스터 red/yellow·디스크 워터마크 알림을 받을 때, ML 엔지니어는 RAG 검색기를 만들 때 만난다.

**면접·실무 단골 질문**
- Q. `LIKE '%키워드%'` 와 검색 엔진의 차이는? → 전체 스캔 vs 역색인, 정확 일치 vs 분석기 정규화, 순위 없음 vs BM25 점수.
- Q. 문서 삭제가 비싼 이유는? → 세그먼트가 불변이라 삭제 표시만 하고 머지 때 실제로 버린다. LSM 트리와 같은 구조다.

## 실습 체크리스트

- [ ] `pnpm search:up` 후 실험 `search-index-notes` 를 돌리고, 세 분석기의 토큰 표에서 "복제본" 이 어떻게 잘리는지 확인하기
- [ ] `_analyze` 에 `"explain": true` 를 주고 `nori_part_of_speech` 가 어떤 품사를 버렸는지 읽기
- [ ] `user_dictionary_rules` 에 자기 도메인 용어 3개를 추가해 토큰이 바뀌는지 보기 (인덱스를 다시 만들어야 한다)
- [ ] `_cat/segments` 로 세그먼트 수를 본 뒤 문서 몇 개를 삭제·갱신하고 `docs.deleted` 가 느는지 확인하기
- [ ] 같은 질의를 PostgreSQL `to_tsvector('simple', body) @@ to_tsquery('복제')` 로 돌려 보고 nori 와의 차이를 적어 보기
