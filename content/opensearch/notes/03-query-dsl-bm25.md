---
title: "쿼리 DSL 과 BM25 — 점수는 어떻게 계산되고, 어떤 절이 점수를 바꾸는가"
order: 3
level: 중급
summary: "query context 와 filter context 의 차이(점수·캐시), match·multi_match·term·range·bool(must/should/filter/must_not)의 의미, 구문·근접 검색, TF-IDF 에서 BM25 로(포화·길이 정규화·k1·b), explain 으로 점수를 읽는 법, 부스팅과 function_score, 페이지네이션(from/size 의 깊은 페이지 문제, search_after, PIT). explain 으로 실제 점수를 읽는 실험"
tags: [쿼리 DSL, BM25, match, term, bool, filter, explain, boost, search_after, 페이지네이션]
experiments: [search-index-notes]
---

## 두 가지 문맥 — 점수를 내느냐, 거르느냐

같은 절이라도 어디에 놓이느냐에 따라 **관련도 점수를 계산**하거나(query context) **참/거짓만 판단**한다(filter context).

| | query context | filter context |
|---|---|---|
| 질문 | 이 문서가 얼마나 잘 맞나? | 이 문서가 조건에 맞나? |
| 결과 | `_score` 기여 | 점수 없음(또는 0) |
| 캐시 | 안 됨 | **비트셋으로 캐시**(자주 쓰는 필터는 거의 공짜) |
| 자리 | `query`, `bool.must`, `bool.should` | `bool.filter`, `bool.must_not`, `post_filter` |

규칙: **점수가 필요 없는 조건은 전부 `filter` 로.** 상태·날짜·카테고리·테넌트 ID 는 점수에 기여할 이유가 없다. `must` 에 넣으면 BM25 를 계산하느라 느리고 캐시도 안 되고, 점수가 왜곡된다(모든 문서가 `status:paid` 로 같은 점수를 더 받으니 의미 없음).

```json
POST /lab-notes/_search
{
  "query": {
    "bool": {
      "must":     [{ "match": { "body": "복제 지연" } }],          // 점수
      "should":   [{ "match": { "title": "복제" } }],              // 맞으면 점수 ↑ (선택)
      "filter":   [{ "term": { "subject": "kafka" } },            // 거르기만
                   { "range": { "order": { "lte": 5 } } }],
      "must_not": [{ "term": { "level": "기초" } }]               // 제외, 점수 없음
    }
  }
}
```

`should` 는 `must` 나 `filter` 가 있으면 "선택 사항(맞으면 가산)", 없으면 "하나 이상은 맞아야"(`minimum_should_match` 기본 1) 로 동작이 바뀐다. 헷갈리면 `minimum_should_match` 를 명시하라.

## 질의 종류 — 분석되느냐가 기준

| 질의 | 입력 분석 | 대상 | 용도 |
|---|---|---|---|
| `match` | ○ (필드의 분석기) | text | 전문 검색의 기본. 토큰들을 OR(`operator: and` 로 바꿀 수 있음) |
| `match_phrase` | ○ | text | 토큰 순서·인접 유지. `slop` 으로 거리 허용 |
| `multi_match` | ○ | 여러 text | `fields: ["title^3", "body"]`, `type: best_fields/most_fields/cross_fields` |
| `term` | ✕ | keyword/숫자/날짜 | 정확 일치. **text 필드에 쓰면 거의 항상 실패**(분석된 토큰과 안 맞음) |
| `terms` | ✕ | keyword | IN (...) |
| `range` | ✕ | 숫자/날짜 | `gte/lte`, 날짜 수식 `now-7d/d` |
| `exists` | ✕ | 아무 | 필드가 있는 문서 |
| `prefix`/`wildcard`/`regexp` | ✕ | keyword | 텀 사전 순회. 앞 와일드카드 금지 |
| `fuzzy` / `match` + `fuzziness` | ○ | text | 편집 거리 1~2 (오타) |
| `knn` | — | knn_vector | 벡터 최근접 ([노트 05](/opensearch/notes/05-hybrid-search-rag)) |

가장 흔한 버그: `term: { "title": "복제 지연" }`. `title` 이 `text` 라 색인에는 `복제`, `지연` 이 따로 있고 `"복제 지연"` 이라는 텀은 없다 → 0건. `term` 은 `keyword` 필드(`title.raw`)에, `text` 에는 `match`.

### 구문과 근접

```json
{ "match_phrase": { "body": { "query": "복제 지연", "slop": 2 } } }
```

포스팅의 **위치** 정보를 써서 "복제" 바로 뒤(또는 slop 만큼 떨어진 곳)에 "지연" 이 오는 문서만. 비싸다(위치를 읽고 비교). 일반 `match` 로 후보를 좁힌 뒤 `should` 의 `match_phrase` 로 **부스트**하는 패턴이 흔하다 — 구문이 정확히 맞는 문서를 위로.

## 점수 — TF-IDF 에서 BM25 로

관련도의 고전 직관 세 가지:

1. **TF**(term frequency): 문서에 텀이 많이 나올수록 관련 있다.
2. **IDF**(inverse document frequency): 모든 문서에 나오는 텀("의", "하다")보다 드문 텀("Debezium")이 더 말해 준다.
3. **길이 정규화**: 긴 문서는 아무 단어나 많이 나오니 깎는다.

TF-IDF 는 `tf × idf` 를 그대로 곱한다. 문제는 tf 가 **선형**이라 "복제" 가 100번 나오는 문서가 10번 나오는 문서보다 10배 관련 있다고 본다. BM25 는 tf 를 **포화**시킨다.

```
score(q, d) = Σ_{t ∈ q}  IDF(t) · ( tf(t,d) · (k1 + 1) ) / ( tf(t,d) + k1 · (1 − b + b · |d| / avgdl) )

IDF(t) = ln( 1 + (N − n(t) + 0.5) / (n(t) + 0.5) )
  N = 전체 문서 수, n(t) = t 를 포함한 문서 수
  k1 = 1.2 (tf 포화 속도), b = 0.75 (길이 정규화 강도), avgdl = 평균 문서 길이
```

| 파라미터 | 작게 | 크게 |
|---|---|---|
| `k1` | tf 가 금방 포화(한 번이나 열 번이나 비슷) | tf 가 더 오래 선형에 가깝게 |
| `b` | 0 = 길이 무시 | 1 = 길이에 완전 비례해 깎음 |

tf 부분은 `tf / (tf + k1·...)` 꼴이라 tf → ∞ 여도 `k1 + 1` 을 넘지 못한다. **한 문서 안에서 같은 단어를 반복해 순위를 조작하는 것이 통하지 않는** 이유다. 짧은 제목 필드는 `b` 를 낮게, 긴 본문은 기본값 — 필드별 `similarity` 설정으로 조정한다.

```json
PUT /lab-notes/_settings  { "index": { "similarity": { "title_sim": { "type": "BM25", "k1": 1.2, "b": 0.3 } } } }
```

## explain — 점수를 읽는 법

실험 `search-index-notes` 가 "복제 지연" 의 1위 문서에 `_explain` 을 건 결과(요약):

```
total 2.848  = 복제 1.748 + 지연 1.101
  복제:  idf 0.833 (129편 중 다수에 등장 → 낮음)  ×  tf-부분 0.953 (여러 번 등장, 포화 근처)  × boost 2.2
  지연:  idf 0.626                               ×  tf-부분 0.799
```

- 문서 점수 = **질의 텀별 점수의 합**. 텀이 많이 겹칠수록 높다(`match` 의 OR).
- `idf` 가 큰 텀 = 드문 텀. 이 코퍼스에서는 "복제" 가 "지연" 보다 드물어 한 번 등장이 더 가치 있다.
- `tf` 부분이 1 에 가까우면 포화. 더 많이 나와도 점수는 거의 안 오른다.
- `boost 2.2` 는 Lucene 의 `k1 + 1` 상수.

점수는 **인덱스(샤드)마다 상대적**이다. 샤드가 여러 개면 각 샤드의 N, n(t), avgdl 이 달라 같은 문서가 다른 점수를 받을 수 있다(`search_type=dfs_query_then_fetch` 로 전역 통계를 쓰면 정확하지만 느림). 점수를 **절대 임계값**으로 쓰지 말 것 — "score > 5 면 관련 있음" 은 코퍼스가 바뀌면 깨진다.

```bash
curl -s -X POST 'localhost:19200/lab-notes/_explain/kafka%2F05-internals-storage-replication' \
  -H 'Content-Type: application/json' -d '{"query":{"match":{"body":"복제 지연"}}}' | jq '.explanation | {value, details: [.details[] | {value, description}]}'
```

## 부스팅과 function_score

점수를 비즈니스 신호로 조정한다.

```json
{
  "query": {
    "function_score": {
      "query": { "multi_match": { "query": "복제", "fields": ["title^3", "summary^2", "body"] } },
      "functions": [
        { "filter": { "term": { "level": "심화" } }, "weight": 1.5 },
        { "gauss": { "updated": { "origin": "now", "scale": "30d", "decay": 0.5 } } },
        { "field_value_factor": { "field": "views", "modifier": "log1p", "factor": 0.1 } }
      ],
      "score_mode": "multiply",
      "boost_mode": "multiply"
    }
  }
}
```

- `title^3`: 제목 매치는 본문의 3배. 사용자는 제목에 있는 단어를 찾는 경우가 많다.
- `gauss` 감쇠: 최근 문서 우대(뉴스·로그). 30일 지나면 반으로.
- `field_value_factor`: 조회수·평점 같은 인기 신호. `log1p` 로 폭주를 막는다.
- 더 나아가면 **리랭킹**(상위 100개를 ML 모델로 다시 정렬) — [노트 07](/opensearch/notes/07-korean-and-ranking).

`should` + `match_phrase` + `boost` 조합이 "정확히 그 구문이 있는 문서를 위로" 의 가장 싼 방법이다.

## 페이지네이션 — from/size 의 함정

`from: 10000, size: 10` 은 **각 샤드에서 10,010개**를 뽑아 코디네이터가 병합한 뒤 10개를 버리고 돌려 준다. 샤드 5개면 50,050개 정렬. 그래서 `index.max_result_window` 기본 10,000 에서 막힌다. [PostgreSQL 키셋 페이지네이션](/postgres/notes/07-query-optimization-deep)과 똑같은 이유다.

| 방법 | 동작 | 용도 |
|---|---|---|
| `from`/`size` | 오프셋 | 처음 몇 페이지 |
| `search_after` + `sort` | 마지막 문서의 정렬 값 이후부터 (정렬 키는 유일해야: `[score, _id]`) | 무한 스크롤, 깊은 페이지 |
| PIT(point in time) + `search_after` | 특정 시점 스냅샷에 고정해 refresh 로 순서가 흔들리지 않게 | 일관된 내보내기 |
| `scroll` | 구식 스냅샷 커서 | 전체 덤프(리인덱스 내부). 사용자 대면 금지 |

```json
POST /lab-notes/_search
{ "size": 10, "sort": [{ "_score": "desc" }, { "slug": "asc" }], "search_after": [2.31, "kafka/05-internals-storage-replication"], "query": { ... } }
```

## 예시로 보기 — 이 프로젝트에서

실험 `search-index-notes` 의 뒷부분이 이 노트의 실습이다: `bool{must: match "장애 복구", filter: subject=kafka}` + `highlight`. 결과에서 확인할 것:

- 필터로 kafka 노트만 남지만 점수는 `match` 만으로 계산된다.
- `highlight.body` 가 매치된 텀을 `<em>` 으로 감싼 조각을 준다 — 포스팅의 **오프셋** 덕분이다.
- `took` 이 한 자릿수 ms — 역색인 + 필터 캐시.

AI 도우미의 `search_notes` 툴([AI 시스템](/ai-systems/notes/04-agents-tools-workflows))은 현재 단순 문자열 매칭이다. 이 인덱스로 바꾸면 조사 변형·순위·하이라이트가 공짜로 생긴다 — 이 노트 뒤의 [하이브리드](/opensearch/notes/05-hybrid-search-rag)가 그 설계다.

## 흔한 실수

- `term` 을 `text` 필드에 → 0건. `match` 또는 `.raw` 에 `term`.
- 필터를 `must` 에 → 느리고 점수 왜곡.
- `match` 기본 OR 를 모른 채 "둘 다 포함" 을 기대 → `operator: and` 또는 `minimum_should_match: "75%"`.
- 점수 절대값으로 임계값 → 코퍼스·샤드에 따라 흔들린다. 순위·상대 비교·RRF 를 써라.
- `from: 100000` → 메모리 폭발. `search_after`.
- 와일드카드·정규식으로 자동완성 → `edge_ngram` 또는 `completion` 타입.

## 실습 체크리스트

- [ ] `lab-notes` 에 `term: {title: "복제"}` 와 `match: {title: "복제"}` 를 각각 날려 결과 차이를 설명하기
- [ ] 같은 질의를 `must` 에 필터를 넣은 버전과 `filter` 에 넣은 버전으로 10번씩 돌려 `took` 비교, `_score` 차이 보기
- [ ] `_explain` 으로 상위 2개 문서의 점수를 텀별로 분해하고, 왜 1위가 1위인지 한 문장으로
- [ ] `similarity` 의 `b` 를 0 으로 바꾼 인덱스를 만들어 긴 노트와 짧은 노트의 순위가 어떻게 바뀌는지 보기
- [ ] `search_after` 로 전체 노트를 10개씩 끝까지 넘겨 보고, 중간에 문서를 추가했을 때 PIT 유무로 결과가 어떻게 다른지 확인
