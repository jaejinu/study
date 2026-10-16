---
title: "집계와 로그 분석 — 검색 엔진이 분석 엔진이 되는 순간, 그리고 Loki 와의 선택"
order: 4
level: 중급
summary: "doc values(열 저장)가 집계를 가능하게 하는 원리, 버킷 집계(terms·date_histogram·range·filters·composite)와 메트릭 집계(avg·percentiles·cardinality), 파이프라인 집계, terms 집계의 근사 오차와 shard_size, cardinality 의 HyperLogLog, 로그 분석에서 OpenSearch 와 Loki 의 비용·질의 모델 비교와 선택 기준"
tags: [집계, aggregation, doc values, terms, date_histogram, percentiles, cardinality, HyperLogLog, Loki, 로그]
experiments: [search-index-notes]
---

## 역색인으로는 집계를 못 한다

역색인은 **텀 → 문서** 다. "subject 별 노트 수" 를 세려면 반대 방향, **문서 → 값** 이 필요하다. 문서 1억 개의 subject 를 하나씩 `_source` 에서 꺼내 파싱하면 끝나지 않는다.

그래서 `keyword`·숫자·날짜 필드는 색인할 때 **doc values** 를 함께 만든다: 필드별로 문서 순서대로 값을 늘어놓은 **열 저장** 파일. [열 저장 엔진](/db-internals/notes/07-query-execution-columnar)과 같은 구조라 압축이 잘 되고, 집계·정렬은 이 열을 순차로 훑는다.

```
역색인 (subject)          doc values (subject)
  kafka    → [3, 7, 9]      doc0: redis
  postgres → [1, 4]         doc1: postgres
  redis    → [0, 2, 5]      doc2: redis
                            doc3: kafka  ...
"kafka 문서는?" 에 강함      "문서 3 의 subject 는?" / "전부 세기" 에 강함
```

`text` 필드는 doc values 가 없다(토큰이 여러 개라 "값" 이 정해지지 않음). `text` 로 집계하려면 `fielddata: true` 로 역색인을 메모리에서 뒤집어야 하는데, 힙을 폭발시키는 대표 원인이다. **집계할 필드는 keyword** — [매핑 노트](/opensearch/notes/02-mapping-shards-replicas)의 규칙이 여기서 나온다.

## 집계의 세 가족

```json
POST /lab-notes/_search
{
  "size": 0,
  "query": { "match": { "body": "장애" } },
  "aggs": {
    "by_subject": {
      "terms": { "field": "subject", "size": 5 },
      "aggs": {
        "by_level": { "terms": { "field": "level" } }
      }
    },
    "levels": { "terms": { "field": "level" } }
  }
}
```

`size: 0` 이면 문서는 안 돌려주고 집계만. 집계는 **질의 결과 집합** 위에서 돈다 — "장애" 를 언급하는 노트 중 주제별 분포.

| 가족 | 하는 일 | 예 |
|---|---|---|
| **버킷** | 문서를 그룹으로 나눈다(SQL 의 GROUP BY) | `terms`, `date_histogram`, `histogram`, `range`, `filters`, `composite`, `significant_terms` |
| **메트릭** | 그룹 안의 값을 계산 | `avg`, `sum`, `min/max`, `stats`, `percentiles`, `cardinality`, `top_hits` |
| **파이프라인** | 다른 집계의 결과를 입력으로 | `derivative`, `moving_avg`, `cumulative_sum`, `bucket_sort`, `bucket_selector` |

버킷 안에 버킷·메트릭을 중첩할 수 있다(subject → level → 평균 길이).

### 로그에서 자주 쓰는 조합

```json
{
  "size": 0,
  "query": { "bool": { "filter": [{ "range": { "@timestamp": { "gte": "now-1h" } } }] } },
  "aggs": {
    "per_minute": {
      "date_histogram": { "field": "@timestamp", "fixed_interval": "1m" },
      "aggs": {
        "errors": { "filter": { "term": { "level": "error" } } },
        "p95": { "percentiles": { "field": "duration_ms", "percents": [95, 99] } },
        "users": { "cardinality": { "field": "user_id" } }
      }
    },
    "top_routes": { "terms": { "field": "route", "size": 10, "order": { "_count": "desc" } } }
  }
}
```

"분당 에러 수, p95/p99 지연, 고유 사용자 수, 상위 라우트" — [관측성의 RED](/observability/notes/02-prometheus-promql) 를 로그에서 직접 계산한 것이다.

## 근사라는 사실을 알고 써라

분산 집계는 **정확하지 않을 수 있다.** 두 가지를 반드시 알아야 한다.

### terms 집계의 오차

`terms: size 10` 은 각 샤드에서 상위 `shard_size`(기본 `size × 1.5 + 10`) 개를 가져와 합친다. 어떤 값이 샤드 A 에서 11위, 샤드 B 에서 11위라 둘 다 잘리면, 전체에선 3위여도 결과에서 빠진다.

```json
"doc_count_error_upper_bound": 12,     // 이 버킷 개수의 최대 오차
"sum_other_doc_count": 4810            // 결과에 안 들어간 나머지 합
```

`doc_count_error_upper_bound` 가 0 이 아니면 순위가 틀렸을 수 있다. 대처: `shard_size` 를 키우거나, 샤드 1 개 인덱스를 쓰거나(로컬은 이미 정확), 전수가 필요하면 `composite` 집계로 페이지를 넘기며 전부 가져온다.

### cardinality 는 HyperLogLog

고유 값 개수를 정확히 세려면 모든 값을 기억해야 한다(메모리 O(n)). `cardinality` 는 **HyperLogLog++** 로 고정 메모리(`precision_threshold`, 기본 3,000 → 약 24KB) 안에서 오차 1~2% 의 근사를 낸다. 임계값 아래면 거의 정확, 위로 갈수록 근사. [Redis 의 PFCOUNT](/redis/notes/13-probabilistic) 와 같은 자료구조다.

### percentiles 는 t-digest

p99 를 정확히 내려면 전체 정렬이 필요하다. `percentiles` 는 **t-digest**(꼬리 쪽에 해상도를 몰아준 클러스터 요약)로 근사한다. 꼬리일수록 정확하게 설계됐지만 샤드별 digest 를 합치는 과정의 오차가 있다. 그리고 **평균의 평균처럼 백분위의 평균은 의미가 없다** — 분 단위 p99 를 시간 단위로 평균 내지 말 것([성능의 언어](/performance/notes/01-language-of-performance)).

## 로그 분석: OpenSearch 인가 Loki 인가

이 프로젝트는 로그를 [Loki](/observability/notes/05-logging-loki) 로 보낸다. 같은 로그를 OpenSearch 에 넣을 수도 있다. 둘은 설계 철학이 정반대다.

| | OpenSearch (ELK/EFK) | Loki |
|---|---|---|
| 색인 | **전 필드 역색인** + doc values | **라벨만** 색인, 본문은 압축 청크 |
| 저장 비용 | 원문의 1~1.5배(색인 오버헤드) | 원문의 0.1~0.2배(gzip/snappy 청크) |
| 쓰기 비용 | 높음(분석·색인·머지) | 낮음(추가만) |
| 임의 필드 검색 | 빠름(어떤 텀이든 역색인) | 라벨로 스트림을 고른 뒤 **grep 식 스캔** |
| 집계 | 풍부(terms·percentiles·cardinality·중첩) | LogQL 메트릭 질의(`rate`, `quantile_over_time`), 라벨 기준 |
| 고카디널리티 필드(user_id, trace_id) | 문제없음(keyword) | **라벨로 쓰면 폭발**, 본문에 두고 질의 시 파싱 |
| 운영 | JVM 힙·샤드·매핑·ILM 관리 | 객체 스토리지 + 상태 없는 컴포넌트 |
| 장점이 사는 곳 | 보안 분석(SIEM), 감사 로그 검색, 비즈니스 이벤트 분석, "어떤 필드로든 바로" | 대량 애플리케이션 로그, 비용 민감, 메트릭·트레이스와 라벨 공유 |

### 선택 기준

- **"무엇을 찾을지 모른다"** (보안 조사, 임의 필드 검색, 사용자 행동 분석) → OpenSearch. 역색인이 비용을 정당화한다.
- **"보통은 최근 것을 본다, 볼 때는 서비스·레벨로 좁힌다"** (운영 로그) → Loki. 저장비가 10배 차이 난다.
- **둘 다**: 앱 로그는 Loki, 감사·보안·Falco 이벤트([보안 노트 05](/security/notes/05-container-supply-chain))는 OpenSearch. 흔한 하이브리드다.

```
LogQL:   sum by (route) (rate({service="study-app"} | json | level="error" [5m]))
OpenSearch: date_histogram(1m) + filter(level=error) + terms(route)
→ 결과는 같다. 차이는 "어디에 돈을 쓰는가": Loki 는 질의 시(스캔), OpenSearch 는 색인 시(역색인)
```

[관측성 실험 `loki-log-pipeline`](/observability/lab) 이 LogQL 로 p95 를 계산한다. 같은 것을 OpenSearch 로 하면 `percentiles` 한 줄이다. 대신 그 로그를 OpenSearch 에 넣는 순간 색인 비용과 매핑 관리가 생긴다.

## 대시보드 쪽에서

- **OpenSearch Dashboards**(Kibana 포크): Discover(검색), Visualize(집계 차트), 알림 플러그인.
- **Grafana** 도 OpenSearch 데이터소스를 지원한다. 이 프로젝트처럼 Grafana 를 쓰면 Prometheus·Loki·Tempo·OpenSearch 를 한 화면에.
- 대시보드가 느리면 원인은 대개 **넓은 시간 범위 × 고카디널리티 terms × 작은 interval**. 사전 집계(롤업·transform)로 1분 단위 요약 인덱스를 만들어 두는 것이 정석이다.

## 예시로 보기 — 이 프로젝트에서

실험 `search-index-notes` 가 남겨 둔 `lab-notes` 인덱스로 바로 집계를 해 볼 수 있다.

```bash
# 주제별 노트 수와 레벨 분포
curl -s -X POST localhost:19200/lab-notes/_search -H 'Content-Type: application/json' -d '{
  "size": 0,
  "aggs": { "by_subject": { "terms": { "field": "subject", "size": 30 },
            "aggs": { "levels": { "terms": { "field": "level" } } } } }
}' | jq '.aggregations.by_subject.buckets[] | {subject: .key, n: .doc_count, levels: [.levels.buckets[] | "\(.key)=\(.doc_count)"]}'

# "장애" 를 언급하는 노트에서 유독 많이 나오는 주제 (significant_terms: 전체 대비 특이하게 많은)
curl -s -X POST localhost:19200/lab-notes/_search -H 'Content-Type: application/json' -d '{
  "size": 0, "query": { "match": { "body": "장애" } },
  "aggs": { "sig": { "significant_terms": { "field": "subject" } } }
}' | jq '.aggregations.sig.buckets[] | {key, doc_count, bg_count, score}'

# 태그 카디널리티
curl -s -X POST localhost:19200/lab-notes/_search -H 'Content-Type: application/json' -d '{
  "size": 0, "aggs": { "tags": { "cardinality": { "field": "tags" } } } }' | jq .aggregations
```

`significant_terms` 는 "전체에서 kafka 가 6% 인데 '장애' 결과 안에서는 15%" 처럼 **배경 대비 과대표**된 값을 찾는다 — 로그에서 "에러가 날 때만 유독 많이 보이는 호스트/버전" 을 찾는 데 강력하다.

## 실습 체크리스트

- [ ] `lab-notes` 에 `text` 필드(`title`)로 `terms` 집계를 시도해 에러를 보고, 왜 `keyword` 가 필요한지 설명하기
- [ ] 주제별 → 레벨별 중첩 집계를 만들고 `bucket_sort` 파이프라인으로 심화 노트가 많은 순으로 정렬하기
- [ ] `cardinality` 의 `precision_threshold` 를 10 과 3000 으로 바꿔 태그 수가 얼마나 달라지는지 보기
- [ ] `significant_terms` 로 "보안" 질의에서 과대표되는 주제를 찾기
- [ ] 이 앱의 `logs/app.jsonl` 을 OpenSearch 에 bulk 로 넣고, Loki 에서 같은 집계(레벨별 분당 건수)를 LogQL 로 만들어 저장 크기와 질의 시간을 비교하기
