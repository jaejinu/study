---
title: "매핑·샤드·복제본 — 인덱스를 설계한다는 것"
order: 2
level: 기초
summary: "동적 매핑이 만드는 조용한 사고(문자열 → text+keyword 멀티필드, 숫자 추정), text 와 keyword 의 역할 분담, 날짜·숫자·객체·nested 타입, 매핑은 바꿀 수 없다는 사실과 별칭 리인덱스, 샤드(라우팅·수 결정·단일 노드의 함정), 복제본(가용성·읽기 분산·쓰기 비용), refresh 와 near-real-time, translog. 샤드 1 vs 3 과 refresh_interval 을 실측하는 실험"
tags: [매핑, text, keyword, 샤드, 복제본, 라우팅, refresh, translog, 동적 매핑]
experiments: [search-shards-refresh]
---

## 매핑 = 스키마, 단 한 번만 정한다

매핑은 필드마다 "어떤 타입이고 어떻게 색인하나" 다. 관계형 DB 의 스키마와 두 가지가 다르다. 첫째, **없으면 추측해서 만든다**(동적 매핑). 둘째, **한 번 정해진 필드 타입은 바꿀 수 없다** — 바꾸려면 새 인덱스를 만들어 리인덱스해야 한다. 둘 다 사고의 원인이다.

### 동적 매핑이 하는 추측

```json
POST /orders/_doc
{ "id": "A-1001", "amount": 89000, "status": "paid", "note": "빠른 배송", "created": "2026-10-16" }
```

| 값 | 추측된 타입 | 문제 |
|---|---|---|
| `"A-1001"`, `"paid"`, `"빠른 배송"` | `text` + `.keyword` 멀티필드 | 모든 문자열이 분석기를 타고 역색인에 들어간다(상태값·ID 까지). 색인 크기 ↑, 집계는 `.keyword` 로만 |
| `89000` | `long` | 나중에 `89000.5` 가 오면 색인 실패 |
| `"2026-10-16"` | `date` | 다음 문서에 `"어제"` 가 오면 색인 실패 |
| `"12345"` (문자열 숫자) | `text` | 범위 질의 불가 |
| 새 필드 아무거나 | 자동 추가 | 로그처럼 키가 폭발하는 데이터는 **매핑 폭발**(필드 1,000개 제한에 걸림) |

운영 인덱스는 **명시적 매핑 + `dynamic: strict`**(모르는 필드는 거부) 또는 `dynamic: false`(저장은 하되 색인 안 함)가 정석이다. 로그처럼 키가 유동적이면 `flattened` 타입이나 `dynamic_templates` 로 규칙을 준다.

```json
PUT /orders
{
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "id":      { "type": "keyword" },
      "status":  { "type": "keyword" },
      "amount":  { "type": "scaled_float", "scaling_factor": 100 },
      "note":    { "type": "text", "analyzer": "korean" },
      "created": { "type": "date", "format": "strict_date_optional_time||epoch_millis" },
      "customer": {
        "properties": { "id": { "type": "keyword" }, "tier": { "type": "keyword" } }
      },
      "items": {
        "type": "nested",
        "properties": { "sku": { "type": "keyword" }, "qty": { "type": "integer" } }
      }
    }
  }
}
```

## text vs keyword — 가장 중요한 결정

| | `text` | `keyword` |
|---|---|---|
| 분석 | 분석기로 토큰화 | 통째로 하나의 텀 |
| 용도 | 전문 검색(match), 하이라이트, 점수 | 정확 일치(term), 필터, 집계, 정렬 |
| 저장 구조 | 역색인(포스팅 + 위치 + 노름) | 역색인 + **doc values**(열 저장, 집계·정렬용) |
| `"빠른 배송"` 검색 | `match: 빠른` 으로 찾음 | `term: "빠른 배송"` 으로만 |
| 집계 | 기본 불가(fielddata 켜야, 메모리 폭발) | 가능 |

제목·본문은 `text`, ID·상태·태그·카테고리·이메일은 `keyword`. 둘 다 필요한 필드(상품명으로 검색도 하고 정확 일치 집계도 하는)는 **멀티필드**:

```json
"name": { "type": "text", "analyzer": "korean", "fields": { "raw": { "type": "keyword", "ignore_above": 256 } } }
```

`name` 으로 match, `name.raw` 로 term/집계. 동적 매핑이 모든 문자열에 이걸 해 주는 건 "친절" 이지만 ID·상태처럼 검색이 필요 없는 필드까지 `text` 로 색인해 공간을 낭비한다.

### 객체와 nested

JSON 객체 필드는 기본적으로 **평탄화**된다. `items: [{sku:"A", qty:1}, {sku:"B", qty:5}]` 는 `items.sku: [A, B]`, `items.qty: [1, 5]` 로 저장돼 "sku 가 A 이고 qty 가 5 인 항목" 이라는 질의가 **거짓 양성**을 낸다(A 와 5 가 서로 다른 항목인데 둘 다 있으니 매치). 배열 원소 안의 조건을 묶어야 하면 `nested` 타입(원소마다 숨은 하위 문서)과 `nested` 질의를 쓴다. 비용: 원소 수만큼 문서가 늘고 갱신이 비싸다. 부모-자식 관계가 자주 바뀌면 `join` 타입 — 더 비싸다. 가능하면 **비정규화해서 평탄하게** 넣는 것이 검색 엔진의 문법이다.

## 매핑은 바꿀 수 없다 — 그래서 별칭

`text` 를 `keyword` 로, 분석기를 바꾸는 것, 타입 변경은 전부 **불가**. 필드 추가만 된다. 그래서 처음부터 애플리케이션은 **별칭**(alias)으로 인덱스를 가리킨다:

```
notes (alias) → notes-v1
새 매핑으로 notes-v2 생성 → _reindex notes-v1 → notes-v2 → 별칭을 v2 로 원자적 교체 → v1 삭제
```

[노트 06](/opensearch/notes/06-operations) 에서 무중단 절차를 다룬다. 교훈: **인덱스 이름을 코드에 박지 말 것.**

## 샤드 — 인덱스를 나누는 단위

인덱스는 **프라이머리 샤드** N 개로 나뉘고, 각 샤드는 독립된 Lucene 인덱스다. 문서는 `hash(_routing ?? _id) % N` 번 샤드로 간다. 샤드가 노드에 분산되므로 **인덱스 하나가 노드 하나보다 커질 수 있고**, 쓰기·검색이 병렬화된다.

```
검색 요청 → 코디네이터 노드
  ├─ 샤드 0 에 질의 → 상위 k 의 (id, score)
  ├─ 샤드 1 에 질의 → 상위 k
  └─ 샤드 2 에 질의 → 상위 k
  → 코디네이터가 3k 를 병합해 상위 k 선정 (query phase) → 그 k 개의 _source 를 가져옴 (fetch phase)
```

### 샤드 수 결정

| 기준 | 지침 |
|---|---|
| 샤드 크기 | 10~50GB. 너무 크면 복구·재배치가 느리고, 너무 작으면 오버헤드 |
| 샤드 수 ≤ 노드 수 × 코어 | 그 이상은 병렬 이득 없이 병합 비용만 |
| 노드당 샤드 수 | 힙 1GB 당 20개 이하 (각 샤드가 메모리·파일 핸들을 먹는다) |
| 시계열(로그) | 일/주 단위 인덱스 + ILM 롤오버로 크기 맞추기 ([노트 06](/opensearch/notes/06-operations)) |
| **프라이머리 샤드 수는 생성 후 못 바꾼다** | `_split`/`_shrink` 또는 리인덱스. 처음에 계획 |

**단일 노드 로컬에서는 샤드 1 이 가장 빠르다.** 실험 `search-shards-refresh` 가 3,000건으로 샤드 1 vs 3 을 비교하면 색인·검색 시간이 같거나 3 이 더 느리다 — 병렬화할 CPU 가 같은 노드에 있고, 병합 단계가 추가되기 때문이다. "샤드를 늘리면 빨라진다" 는 노드가 여러 개일 때만 참이다.

### 라우팅

`_routing` 을 고객 ID 로 주면 같은 고객의 문서가 한 샤드에 모여, 질의에 `routing=고객ID` 를 주면 **샤드 하나만** 검색한다(멀티테넌트 SaaS 의 흔한 최적화). 대신 큰 고객이 핫 샤드를 만든다 — [파티셔닝의 핫스팟](/distributed-systems/notes/07-partitioning) 과 같은 문제.

## 복제본 — 가용성과 읽기 확장

각 프라이머리 샤드에 **복제본 샤드** R 개. 쓰기는 프라이머리 → 복제본 동기 전파(모든 in-sync 복제본이 확인해야 응답), 읽기는 프라이머리·복제본 중 아무 데서나. 노드가 죽으면 복제본이 프라이머리로 승격된다.

| 복제본 수 | 효과 |
|---|---|
| 0 | 노드 하나 죽으면 데이터 유실·인덱스 red. 대량 색인 중·로컬 실험에만 |
| 1 | 기본값. 노드 1대 장애 허용, 읽기 처리량 2배, 저장 2배, 쓰기 지연 ↑ |
| 2+ | 읽기 많은 워크로드. 저장 3배 |

쓰기 비용에 주의: 복제본 R 이면 모든 색인 작업이 R+1 번 일어난다(복제본은 세그먼트를 복사하는 게 아니라 **문서를 다시 색인**한다). 대량 백필은 `replicas: 0` 으로 넣고 끝나면 올리는 것이 표준이다.

노드 1대인 로컬은 복제본을 둘 곳이 없어 인덱스가 영원히 **yellow** 다. 그래서 compose 의 실험 인덱스는 전부 `number_of_replicas: 0` 이다.

## refresh — "색인했는데 안 보여요"

문서를 색인하면 두 곳에 쓴다: 메모리의 **색인 버퍼**와 디스크의 **translog**(내구성). 검색은 **세그먼트**만 보는데, 버퍼가 세그먼트가 되는 것이 **refresh** 다. 기본 1초마다. 그래서 OpenSearch 는 **near-real-time** — 색인 직후 검색하면 없다.

```
색인 요청 ─► 색인 버퍼(메모리) + translog(디스크, fsync)  ─ refresh(1s) ─► 새 세그먼트 (검색 가능, 아직 fsync 안 됨)
                                                             ─ flush(30분 or translog 512MB) ─► 세그먼트 fsync + translog 비움
```

| 설정 | 의미 | 언제 |
|---|---|---|
| `refresh_interval: 1s` | 기본 | 일반 |
| `30s` | 색인 처리량 ↑(세그먼트 수 ↓), 가시성 지연 | 로그·대량 적재 |
| `-1` | 자동 refresh 끔, 수동 `_refresh` | 리인덱스·백필 |
| 요청에 `?refresh=true` | 즉시 refresh. 세그먼트가 작아져 비싸다 | 테스트에만 |
| `?refresh=wait_for` | 다음 refresh 를 기다렸다 응답 | "저장 직후 목록에 보여야" 하는 쓰기 경로 |

실험이 재는 것: `refresh_interval: 5s` 인덱스에 문서를 넣고 `_count` 하면 **0**, 평균 2.5초 뒤 1. `?refresh=wait_for` 는 응답이 돌아왔을 때 이미 보인다. `-1` 로 바꾸면 수동 `_refresh` 전까지 영원히 안 보인다.

내구성은 translog 가 담당한다(기본 요청마다 fsync, `index.translog.durability: async` 면 5초마다). refresh 와 내구성은 **별개**다 — refresh 안 된 문서도 노드가 죽으면 translog 로 복구된다.

## 예시로 보기 — 이 프로젝트에서

실험 `search-shards-refresh`(약 12초):

| 실험 | 결과(로컬 단일 노드) | 교훈 |
|---|---|---|
| 3,000건 bulk, 샤드 1 vs 3 | 색인 시간 비슷, 검색 p50 샤드 3 이 같거나 느림, 세그먼트 수 3배 | 단일 노드에선 샤드 1 |
| refresh_interval 5s + `_doc` 색인 | 즉시 `_count` = 0 → 2~5초 후 1 | near-real-time |
| `?refresh=wait_for` | 응답 시 이미 보임, 대기 시간 = 다음 refresh 까지 | 쓰기 경로의 정답 |
| `refresh_interval: -1` | 1.5초 후에도 0, `_refresh` 후 보임 | 백필 시 쓰고 되돌릴 것 |

실험 `search-index-notes` 의 `lab-notes` 매핑을 보자: `subject/slug/level/tags` 는 `keyword`(필터·집계), `title/body` 는 `text` + `.std` 멀티필드. 이것이 "검색할 것은 text, 거를 것은 keyword" 의 실례다.

```bash
curl -s localhost:19200/lab-notes/_mapping | jq '.["lab-notes"].mappings.properties | map_values(.type)'
curl -s 'localhost:19200/_cat/shards/lab-notes?v'
curl -s localhost:19200/lab-notes/_settings | jq '.[].settings.index | {number_of_shards, number_of_replicas, refresh_interval}'
```

## 실습 체크리스트

- [ ] 동적 매핑으로 문서 하나를 넣고 `_mapping` 을 읽어 모든 문자열이 `text` + `keyword` 가 된 것 확인, 그 다음 `dynamic: strict` 인덱스에 모르는 필드를 넣어 거부되는 것 보기
- [ ] `items` 배열을 object 로 넣고 거짓 양성 질의(sku=A AND qty=5)를 재현한 뒤 `nested` 로 바꿔 고치기
- [ ] 실험 `search-shards-refresh` 를 돌리고 샤드 3 의 세그먼트 수·검색 지연을 샤드 1 과 비교하기
- [ ] 별칭 `notes` 를 만들어 `lab-notes` 를 가리키게 하고, 새 인덱스로 `_aliases` 원자 교체를 해 보기
- [ ] `index.translog.durability: async` 로 바꾸고 bulk 처리량이 얼마나 달라지는지, 무엇을 잃는지 적기
