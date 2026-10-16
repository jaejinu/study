---
title: "심화 — 분산·복제·운영: ReplicatedMergeTree, Keeper, Distributed, 뮤테이션, system 테이블"
order: 7
level: 심화
summary: "ClickHouse 를 한 대에서 클러스터로 키울 때: 샤드와 레플리카의 구분, ReplicatedMergeTree 가 Keeper(Raft) 로 파트 목록을 합의하는 방식, Distributed 테이블의 쓰기·읽기 경로와 샤딩 키, 레플리카 지연과 일관성, 뮤테이션(ALTER UPDATE/DELETE)이 비싼 이유와 경량 삭제, 쿼리 메모리·동시성 제한, system 테이블로 하는 관측(query_log·parts·merges·replication_queue), 백업, 장애 시나리오와 운영 체크리스트"
tags: [ReplicatedMergeTree, Keeper, Distributed, 샤딩, 복제, 뮤테이션, 경량 삭제, system 테이블, 운영]
experiments: []
---

## 한 대로 얼마나 가나

먼저 강조할 것: **ClickHouse 한 대는 생각보다 크다.** 압축 덕분에 수 TB 원본이 수백 GB 로 들어가고, 코어 수십 개로 수십억 행 집계를 초 단위로 한다. 클러스터는 운영 복잡도를 크게 늘리므로, 다음 중 하나가 있을 때 간다.

- 디스크 한 대에 데이터가 안 들어간다 → **샤딩**
- 노드 하나가 죽어도 서비스해야 한다 → **복제**
- 질의 동시성이 한 대의 CPU 를 넘는다 → 레플리카로 읽기 분산

## 샤드와 레플리카

```
             Distributed 테이블 (모든 노드에 있는 "논리 테이블")
            ┌────────────────────────────┬────────────────────────────┐
         shard 1                      shard 2
   ┌─────────┴─────────┐        ┌─────────┴─────────┐
 replica 1a        replica 1b  replica 2a        replica 2b
 (ReplicatedMergeTree, 같은 데이터)  (ReplicatedMergeTree, 같은 데이터)
          └──────────── Keeper (Raft, 3대) ────────────┘
```

- **샤드**: 데이터를 나눠 가진다. 행 하나는 한 샤드에만 있다.
- **레플리카**: 같은 샤드의 복사본. 서로 같은 파트 집합을 가지려고 한다.

## ReplicatedMergeTree — 파트 목록을 합의한다

```sql
CREATE TABLE logs ON CLUSTER main (...)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/logs', '{replica}')
PARTITION BY toDate(ts) ORDER BY (service, level, ts);
```

복제는 행 단위가 아니라 **파트 단위**다.

1. 레플리카 1a 에 INSERT → 새 파트 생성 → Keeper 의 **복제 로그**에 "파트 X 가 생겼다" 기록
2. 레플리카 1b 는 로그를 보고 1a 에서 **파트 파일을 내려받는다**(fetch)
3. 머지도 로그에 "파트 A+B+C → D 로 머지" 로 기록된다. 각 레플리카가 직접 머지하거나(같은 결과가 결정적으로 나옴), 이미 머지된 파트를 받아 온다

**Keeper** 는 ZooKeeper 호환 서비스로, ClickHouse 가 C++ 로 다시 만든 Raft 기반 구현이다([합의](/distributed-systems/notes/05-consensus)). 데이터 자체가 아니라 **메타데이터(파트 목록·복제 로그·DDL 큐)** 만 합의한다. 그래서 Keeper 가 느리거나 죽으면 INSERT·머지·DDL 이 멈춘다 — 운영에서 가장 중요한 의존성이다.

### 일관성

- 기본은 **비동기 복제**. INSERT 는 한 레플리카에 쓰이면 성공을 돌려준다. 다른 레플리카에서 바로 읽으면 안 보일 수 있다(레플리카 지연).
- `insert_quorum = 2` 면 두 레플리카에 쓰여야 성공 → 쓰기 지연이 늘고, 정족수 실패 시 INSERT 실패.
- `select_sequential_consistency = 1` 은 정족수 INSERT 를 본 레플리카에서만 읽게 한다.
- 분석 용도에선 대개 비동기로 충분하다. 몇 초 늦은 대시보드는 문제가 아니다.

### 중복 제거

같은 INSERT 블록이 재시도로 두 번 오면, Keeper 에 저장된 **블록 해시**로 두 번째를 무시한다(`replicated_deduplication_window`). 그래서 네트워크 오류 시 **같은 블록을 그대로 재전송**하는 것이 안전하다 — 블록을 다시 섞으면 해시가 달라져 중복이 생긴다.

## Distributed 테이블

```sql
CREATE TABLE logs_all ON CLUSTER main AS logs
ENGINE = Distributed(main, default, logs, cityHash64(trace_id));
--                    클러스터  DB     로컬 테이블  샤딩 키
```

**읽기**: `SELECT … FROM logs_all` 을 받은 노드가 각 샤드(의 레플리카 하나)로 질의를 보내고, 부분 결과(집계 중간 상태)를 받아 최종 병합한다. GROUP BY 의 무거운 부분은 샤드에서 병렬로 끝난다.

**쓰기**: Distributed 에 INSERT 하면 샤딩 키로 행을 나눠 각 샤드로 보낸다(기본 비동기 — 로컬 디스크에 임시 저장 후 전송). 운영에선 **애플리케이션이 로컬 테이블에 직접 나눠 쓰는** 경우도 많다(중간 홉 제거).

### 샤딩 키 고르기

| 샤딩 키 | 장점 | 단점 |
|---|---|---|
| `rand()` | 완전히 고르게 분산 | 같은 키의 데이터가 흩어져 조인·uniq 가 비쌈 |
| `cityHash64(user_id)` | 같은 사용자 데이터가 한 샤드 → 사용자 단위 질의를 한 샤드로 | 거대 사용자가 있으면 쏠림 |
| `cityHash64(tenant_id)` | 테넌트 격리·삭제가 쉬움 | 큰 테넌트 쏠림 |

`optimize_skip_unused_shards = 1` 이면 `WHERE user_id = 42` 질의를 해당 샤드로만 보낸다.

> 샤드를 나중에 늘리는 것(리샤딩)은 ClickHouse 에서 쉽지 않다. 기존 데이터는 그대로 두고 새 샤드에 가중치를 더 줘 새 데이터를 몰아주는 방식이 흔하다. 처음부터 **조금 넉넉하게** 샤드를 잡는다.

## 뮤테이션 — 왜 비싼가

```sql
ALTER TABLE logs DELETE WHERE user_id = 42;            -- GDPR 삭제
ALTER TABLE logs UPDATE level = 'warn' WHERE msg = 'x';
```

파트는 불변이므로, 조건에 맞는 행이 **하나라도 있는 파트는 통째로 다시 쓴다.** 1TB 테이블에서 사용자 하나를 지워도 그 사용자의 행이 모든 파트에 흩어져 있으면 1TB 를 다시 쓴다. 비동기로 백그라운드에서 돌고, `system.mutations` 에서 진행을 본다.

| 대안 | 동작 | 언제 |
|---|---|---|
| **경량 삭제** `DELETE FROM t WHERE …` | 숨은 `_row_exists` 마스크만 갱신, 실제 제거는 머지 때 | 소량 삭제. 질의 즉시 반영 |
| **파티션 삭제** `DROP PARTITION` | 디렉터리 삭제, 즉시 | 날짜 단위 보존 |
| **TTL** | 머지 때 만료 행 제거 | 정기 보존 |
| **ReplacingMergeTree** | 새 버전 INSERT | 잦은 갱신 |
| **삭제 테이블 + 조인/필터** | 삭제 대상 목록을 따로 두고 질의에서 제외 | 대량·즉시 반영이 필요할 때 |

> GDPR 같은 삭제 요구가 예상되면 **설계 단계**에서 정한다: 사용자 데이터를 tenant/user 로 샤딩·파티셔닝하거나, 개인 정보를 별도 테이블로 빼 두는 식.

## 쿼리 자원 제한

넓게 읽는 질의 하나가 서버를 잡아먹을 수 있다. 사용자·프로필 단위로 막는다.

```sql
-- settings profile
max_memory_usage = 10000000000          -- 질의당 10GB
max_execution_time = 60
max_threads = 8
max_bytes_before_external_group_by = 5000000000   -- 넘으면 디스크로 유출
max_concurrent_queries_for_user = 10
readonly = 1                              -- 대시보드 계정
```

`max_bytes_before_external_group_by`·`external_sort` 는 메모리를 넘는 GROUP BY·ORDER BY 를 디스크로 흘려 OOM 대신 느려지게 한다([해시 조인과 유출](/db-internals/notes/07-query-execution-columnar)).

## system 테이블로 하는 관측

ClickHouse 는 자기 상태를 거의 모두 SQL 로 보여 준다. 운영의 절반이 이 질의들이다.

```sql
-- 느린 질의 상위 (최근 1시간)
SELECT query_duration_ms, read_rows, formatReadableSize(read_bytes) rb, formatReadableSize(memory_usage) mem,
       user, substring(query, 1, 120) q
FROM system.query_log
WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 1 HOUR
ORDER BY query_duration_ms DESC LIMIT 10;

-- 파티션별 파트 수 (Too many parts 경보)
SELECT database, table, partition, count() parts FROM system.parts WHERE active
GROUP BY database, table, partition ORDER BY parts DESC LIMIT 10;

-- 진행 중 머지·뮤테이션
SELECT table, elapsed, progress, num_parts, formatReadableSize(total_size_bytes_compressed) FROM system.merges;
SELECT table, command, parts_to_do, is_done, latest_fail_reason FROM system.mutations WHERE NOT is_done;

-- 복제 지연·큐
SELECT database, table, absolute_delay, queue_size, inserts_in_queue, merges_in_queue FROM system.replicas;
SELECT type, create_time, last_exception FROM system.replication_queue WHERE last_exception != '' LIMIT 10;

-- 실시간 지표
SELECT metric, value FROM system.metrics WHERE metric IN ('Query', 'Merge', 'ReplicatedFetch');
```

이 숫자들은 Prometheus 엔드포인트(`<prometheus>` 설정)로도 내보낼 수 있어 이 사이트의 [알림 파이프라인](/observability/notes/09-alerting-pipeline) 에 붙인다. 알릴 것: 파티션당 파트 수, 복제 지연, 실패 뮤테이션, Keeper 세션 끊김, 디스크 여유, 질의 실패율.

## 백업

```sql
BACKUP TABLE logs TO S3('https://…/backups/logs_2026-10-17', 'key', 'secret');
RESTORE TABLE logs FROM S3('…');
```

파트가 불변이라 백업이 단순하다(하드링크 스냅샷 → 업로드). 증분 백업은 이전 백업을 `base_backup` 으로 지정한다. 복제는 백업이 아니다 — 실수로 `DROP` 하면 모든 레플리카에서 사라진다.

## 장애 시나리오

| 상황 | 증상 | 대응 |
|---|---|---|
| Keeper 과반 다운 | INSERT·DDL·머지 멈춤, 읽기는 됨 | Keeper 3·5대, 별도 노드, 디스크 지연 감시 |
| 레플리카 하나 다운 | 읽기는 다른 레플리카, 복구 후 자동 따라잡기 | `absolute_delay` 감시 |
| Too many parts | INSERT 지연·거부 | 배치 크기 키우기, async_insert, 파티션 축소 |
| 뮤테이션이 안 끝남 | `system.mutations` 에 쌓임, 디스크 증가 | 실패 원인 확인, `KILL MUTATION`, 설계 재검토 |
| 디스크 가득 | 머지 실패 → 파트 폭증 → INSERT 거부 | TTL·계층 저장, 디스크 여유 30% 이상 유지 |
| 거대 질의 | 메모리 OOM, 다른 질의 지연 | 프로필 제한, 외부 GROUP BY |

## 예시로 보기 — 이 프로젝트에서

이 사이트의 ClickHouse 는 한 대(`pnpm clickhouse:up`)다. 그래도 운영 질의는 그대로 쓸 수 있다. 실험 [ch-log-analytics](/clickhouse/lab/ch-log-analytics) 를 돌린 직후 다음을 실행해 보자.

```sql
SELECT query_duration_ms, read_rows, formatReadableSize(read_bytes), substring(query, 1, 80)
FROM system.query_log WHERE type = 'QueryFinish' AND query LIKE '%lab_ch.logs%'
ORDER BY event_time DESC LIMIT 10;
```

실험의 측정값(읽은 행·바이트)이 바로 이 테이블에서 왔다. 클러스터를 직접 띄워 보려면 공식 예제(`clickhouse/examples` 의 2샤드 2레플리카 + Keeper 3대 compose)를 쓰면 되지만, 노트북 메모리로는 빠듯하다.

## 실습 체크리스트

- [ ] `system.query_log` 로 지난 1시간 가장 느린 질의 5개와 각각의 read_bytes 를 뽑기
- [ ] `ALTER TABLE … DELETE` 와 `DELETE FROM` 을 각각 실행하고 `system.mutations`·`system.parts` 변화 비교
- [ ] 1행 INSERT 를 1,000번 해서 파트 수가 늘어나는 것과 `async_insert=1` 로 바꿨을 때의 차이 보기
- [ ] 우리 데이터의 샤딩 키 후보 2개를 골라 쏠림(상위 1% 키가 차지하는 비율)을 계산해 보기
- [ ] 알림 규칙 3개(파트 수, 복제 지연, 실패 뮤테이션)를 PromQL 또는 SQL 로 써 보기
