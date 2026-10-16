---
title: "운영 — 수명 주기, 무중단 리인덱스, 메모리·성능, 슬로우 로그, 스냅샷"
order: 6
level: 중급
summary: "클러스터 상태(green·yellow·red)와 샤드 할당 진단, 시계열 인덱스의 롤오버와 ISM(핫·웜·삭제), 별칭으로 하는 무중단 리인덱스 절차, JVM 힙과 OS 페이지 캐시의 역할 분담(힙 50%·32GB 규칙), 색인·검색 성능 튜닝 표, 슬로우 로그와 프로파일 API, 서킷 브레이커, 스냅샷·복구, 모니터링해야 할 지표와 알림"
tags: [운영, ISM, 롤오버, 리인덱스, 별칭, JVM 힙, 슬로우 로그, 스냅샷, 서킷 브레이커]
experiments: [search-shards-refresh]
---

## 클러스터 상태부터 읽는다

```bash
curl -s localhost:19200/_cluster/health?pretty
curl -s 'localhost:19200/_cat/indices?v&s=store.size:desc'
curl -s 'localhost:19200/_cat/shards?v&h=index,shard,prirep,state,unassigned.reason,node'
curl -s localhost:19200/_cluster/allocation/explain?pretty     # 할당 안 된 샤드가 왜 안 되는지
```

| 상태 | 의미 | 흔한 원인 |
|---|---|---|
| **green** | 모든 프라이머리·복제본 샤드 할당됨 | — |
| **yellow** | 프라이머리는 전부 OK, 일부 복제본 미할당 | 단일 노드에 replicas ≥ 1 (로컬의 정상 상태), 노드 하나 다운 직후 |
| **red** | 일부 **프라이머리** 미할당 → 그 샤드의 데이터는 검색·색인 불가 | 노드 다운 + 복제본 없음, 디스크 워터마크 초과, 손상 |

`allocation/explain` 이 거의 모든 답을 준다. 가장 흔한 것은 **디스크 워터마크**: 디스크 사용 85%(low)면 새 샤드 할당 중단, 90%(high)면 샤드를 다른 노드로 옮기기 시작, 95%(flood stage)면 인덱스를 **읽기 전용**으로 막는다. 로그 인덱스가 갑자기 색인을 거부하면 여기부터 본다.

## 시계열 인덱스와 수명 주기

로그·이벤트를 인덱스 하나에 계속 넣으면 샤드가 끝없이 커지고, 오래된 데이터를 지우려면 `delete_by_query`(느리고 세그먼트를 더럽힘)를 해야 한다. 정답은 **시간으로 쪼갠 인덱스 + 롤오버 + 수명 주기**.

```
logs (쓰기 별칭) → logs-000001   (현재 쓰기 대상)
                   logs-000002   (롤오버: 크기 30GB 또는 1일 지나면 새 인덱스)
                   ...
삭제 = 인덱스 통째로 DELETE (즉시, 공짜)
```

OpenSearch 는 **ISM**(Index State Management), Elasticsearch 는 ILM 이라 부른다.

```json
PUT _plugins/_ism/policies/logs-policy
{
  "policy": {
    "default_state": "hot",
    "states": [
      { "name": "hot",
        "actions": [{ "rollover": { "min_primary_shard_size": "30gb", "min_index_age": "1d" } }],
        "transitions": [{ "state_name": "warm", "conditions": { "min_index_age": "3d" } }] },
      { "name": "warm",
        "actions": [{ "replica_count": { "number_of_replicas": 0 } }, { "force_merge": { "max_num_segments": 1 } }, { "read_only": {} }],
        "transitions": [{ "state_name": "delete", "conditions": { "min_index_age": "30d" } }] },
      { "name": "delete", "actions": [{ "delete": {} }] }
    ],
    "ism_template": { "index_patterns": ["logs-*"], "priority": 100 }
  }
}
```

- **hot**: 쓰기 중, 빠른 노드(SSD).
- **warm**: 읽기 전용, `force_merge` 로 세그먼트 1개(검색 빠름·공간 절약), 복제본 줄이기, 느린 노드로 이동.
- **delete**: 보존 기간 끝.
- 비용 관점은 [용량 계획](/performance/notes/07-capacity-planning)과 같은 질문이다: "30일 전 로그를 몇 번 보나?"

## 무중단 리인덱스 — 별칭 교체

매핑·분석기를 바꾸면 새 인덱스가 필요하다([노트 02](/opensearch/notes/02-mapping-shards-replicas)). 애플리케이션이 별칭 `notes` 를 쓰고 있다면:

```bash
# 1. 새 매핑으로 v2 생성 (대량 색인 모드: replicas 0, refresh -1)
PUT /notes-v2  { "settings": { "number_of_replicas": 0, "refresh_interval": "-1", ... }, "mappings": { ... } }

# 2. 복사 (비동기, 태스크로 진행률 확인). 슬라이스로 병렬
POST /_reindex?wait_for_completion=false&slices=auto
{ "source": { "index": "notes-v1" }, "dest": { "index": "notes-v2" } }
GET /_tasks/<task_id>

# 3. 복사 중 들어온 변경 따라잡기: 앱이 v1·v2 양쪽에 쓰는 '이중 쓰기' 구간을 두거나,
#    updated_at > 시작시각 으로 한 번 더 reindex

# 4. 원래 설정으로 + refresh
PUT /notes-v2/_settings { "number_of_replicas": 1, "refresh_interval": "1s" }
POST /notes-v2/_refresh

# 5. 원자적 교체 (한 요청 안의 remove+add 는 원자적)
POST /_aliases
{ "actions": [ { "remove": { "index": "notes-v1", "alias": "notes" } },
               { "add":    { "index": "notes-v2", "alias": "notes", "is_write_index": true } } ] }

# 6. 검증 후 v1 삭제 (며칠 두면 롤백이 쉽다 — 별칭만 되돌리면 됨)
```

[Kafka CDC](/kafka/notes/08-cdc-outbox-debezium) 로 원천 DB → 검색 인덱스를 동기화하고 있다면 3단계가 쉬워진다: 새 인덱스에 대해 커넥터 오프셋을 처음부터 다시 재생하면 된다.

## 메모리 — 힙과 페이지 캐시의 분담

OpenSearch 는 JVM 이지만 **메모리의 절반 이상은 OS 페이지 캐시 몫**이어야 한다.

| 영역 | 담는 것 | 규칙 |
|---|---|---|
| JVM 힙 | 클러스터 상태, 필드 데이터, 질의·집계 버퍼, 색인 버퍼, 쿼리 캐시 | 물리 메모리의 **50% 이하**, **31GB 이하**(압축 OOP 유지 — 32GB 를 넘으면 포인터가 8바이트가 돼 오히려 손해) |
| OS 페이지 캐시 | 세그먼트 파일(역색인, doc values, 저장 필드) | 나머지 전부. 검색 속도의 본체 |
| 오프힙 | kNN 그래프(faiss/nmslib), 네티 버퍼 | 벡터 검색 시 별도 계산 |

이 compose 는 `-Xms512m -Xmx512m` 이다(로컬 실험용). 힙이 모자라면 GC 가 길어지고, 서킷 브레이커가 요청을 거부한다.

### 서킷 브레이커

거대한 집계 하나가 힙을 다 먹어 노드가 OOM 으로 죽는 것을 막기 위해, 요청이 쓸 메모리를 **미리 추정**해 한도를 넘으면 `429 / circuit_breaking_exception` 으로 거부한다.

```bash
curl -s localhost:19200/_nodes/stats/breaker?pretty | jq '.nodes[].breakers | map_values({limit: .limit_size, est: .estimated_size, tripped})'
```

`parent`, `fielddata`, `request`, `in_flight_requests` 브레이커가 있다. `tripped` 가 늘고 있으면 질의를 고치거나(고카디널리티 terms, 큰 `size`) 힙을 늘린다. 브레이커가 트립되는 것은 **노드가 죽는 대신 요청 하나가 실패한 것**이니 정상 동작이다 — [부하 차단](/performance/notes/08-tail-latency-at-scale)의 한 형태.

## 성능 튜닝 표

### 색인

| 손잡이 | 효과 |
|---|---|
| `_bulk` 크기 5~15MB, 동시 요청 몇 개 | 요청당 오버헤드 제거. 너무 크면 메모리 압박 |
| `refresh_interval: 30s` 또는 `-1` (백필) | 세그먼트 생성·머지 감소 |
| `number_of_replicas: 0` (백필 중) | 쓰기 1회로 |
| `translog.durability: async` | fsync 를 5초마다 — 유실 창과 교환 ([WAL 노트](/db-internals/notes/04-wal-checkpoint-recovery)) |
| 불필요한 필드 `index: false`, `_source` 일부 제외 | 색인·저장 감소 |
| 자동 생성 `_id` | 기존 문서 확인(get) 생략 → 빠름. 멱등이 필요하면 자연 키 |

### 검색

| 손잡이 | 효과 |
|---|---|
| 점수 불필요 조건은 `filter` | 캐시 + 계산 생략 ([노트 03](/opensearch/notes/03-query-dsl-bm25)) |
| `_source` 필터링, `size` 작게 | fetch 단계 비용 ↓ |
| 앞 와일드카드·정규식·스크립트 금지 | 텀 사전 스캔·문서별 스크립트 실행 |
| 읽기 전용 인덱스 `force_merge` 1 세그먼트 | 세그먼트 순회 ↓ |
| 자주 쓰는 집계는 사전 계산(transform/rollup) | 매번 전수 집계 ↓ |
| 라우팅 | 샤드 하나만 검색 |
| `preference=_local` / 세션 고정 | 같은 사용자 질의를 같은 복제본으로 → 캐시 적중 |

## 슬로우 로그와 프로파일

```bash
PUT /lab-notes/_settings
{ "index.search.slowlog.threshold.query.warn": "500ms",
  "index.search.slowlog.threshold.query.info": "100ms",
  "index.search.slowlog.threshold.fetch.warn": "200ms",
  "index.indexing.slowlog.threshold.index.warn": "1s" }
```

슬로우 로그는 질의 본문 전체를 남기므로 원인 질의를 바로 찾는다(그리고 개인 정보가 찍힐 수 있다 — [보안](/security/notes/08-web-api-llm-security)). 특정 질의가 왜 느린지는 **Profile API**:

```json
POST /lab-notes/_search
{ "profile": true, "query": { "match": { "body": "복제 지연" } } }
```

샤드별로 질의 트리의 각 노드(TermQuery, BooleanQuery)가 `create_weight`, `next_doc`, `score`, `advance` 에 몇 ns 를 썼는지 나온다. `next_doc` 이 크면 포스팅이 길다(흔한 텀), `score` 가 크면 점수 계산이 비싸다(필터로 옮길 것).

## 스냅샷과 복구

복제본은 **백업이 아니다**(실수로 인덱스를 지우면 복제본도 같이 지워진다). 스냅샷은 세그먼트 파일을 리포지토리(S3, GCS, 공유 파일시스템)에 **증분**으로 복사한다 — 세그먼트가 불변이라 이미 올린 세그먼트는 다시 안 올린다.

```bash
PUT /_snapshot/backup { "type": "fs", "settings": { "location": "/mnt/snapshots" } }   # path.repo 설정 필요
PUT /_snapshot/backup/snap-2026-10-16?wait_for_completion=false
POST /_snapshot/backup/snap-2026-10-16/_restore { "indices": "notes-v2", "rename_pattern": "(.+)", "rename_replacement": "restored-$1" }
```

ISM 에 스냅샷 단계를 넣어 "삭제 전 콜드 스토리지에 스냅샷" 도 흔하다. **복구 연습**을 안 해 봤다면 백업이 없는 것과 같다([장애 실험실의 원칙](/chaos/notes/01-chaos-principles)).

## 모니터링할 것

| 지표 | 경고 기준 예 | 의미 |
|---|---|---|
| 클러스터 상태 | red 즉시, yellow 10분 지속 | 데이터 접근 불가 / 복원력 상실 |
| JVM 힙 사용률(GC 후) | > 75% 지속 | 메모리 압박, 곧 브레이커·긴 GC |
| GC 시간(old) | 초 단위 | 노드가 응답 없음 → 클러스터에서 빠짐 |
| 검색 지연 p99, 색인 지연 | SLO 기준 | 사용자 체감 |
| 스레드 풀 거부(`search`, `write` rejected) | > 0 증가 | 큐가 찼다, 과부하 |
| 디스크 사용률 | > 80% | 워터마크 접근 |
| 미할당 샤드 수 | > 0 | 할당 문제 |
| 세그먼트 수, 머지 시간 | 급증 | refresh 너무 잦음 |

Prometheus 로는 `opensearch-exporter` 또는 내장 Prometheus 플러그인으로 수집해 [Grafana](/observability/notes/04-grafana-alerting) 와 [알림 파이프라인](/observability/notes/09-alerting-pipeline)에 연결한다.

## 예시로 보기 — 이 프로젝트에서

실험 `search-shards-refresh` 가 운영 손잡이 두 개(샤드 수, refresh_interval)를 실측한다. 실험 후 직접 해 볼 운영 작업:

```bash
# 별칭 만들기 + 원자 교체 연습
curl -s -X POST localhost:19200/_aliases -H 'Content-Type: application/json' -d '{"actions":[{"add":{"index":"lab-notes","alias":"notes"}}]}'
curl -s 'localhost:19200/_cat/aliases?v'

# 슬로우 로그 켜고 아무 질의나 → 컨테이너 로그에서 확인
curl -s -X PUT localhost:19200/lab-notes/_settings -H 'Content-Type: application/json' -d '{"index.search.slowlog.threshold.query.info":"0ms"}'
curl -s 'localhost:19200/lab-notes/_search?q=body:복제' >/dev/null
docker logs study-opensearch 2>&1 | grep -i slowlog | tail -2

# 힙·브레이커
curl -s localhost:19200/_nodes/stats/jvm,breaker | jq '.nodes[] | {heap: .jvm.mem.heap_used_percent, breakers: (.breakers | map_values(.tripped))}'
```

## 실습 체크리스트

- [ ] `_cluster/allocation/explain` 을 `number_of_replicas: 1` 인 인덱스에 대해 돌려 yellow 의 이유를 읽기
- [ ] `logs-000001` + 쓰기 별칭 + ISM 정책(min_doc_count 100 으로 롤오버)을 만들고 문서를 넣어 롤오버를 확인
- [ ] `lab-notes` 를 매핑이 다른 `lab-notes-v2` 로 `_reindex` 하고 별칭을 원자 교체하기
- [ ] Profile API 로 `match` 와 `match_phrase` 의 시간 분해를 비교하기
- [ ] 슬로우 로그 임계값을 0ms 로 두고 로그에 무엇이 찍히는지, 개인 정보 위험은 무엇인지 적기
