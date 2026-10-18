---
title: "LSM 트리와 컴팩션 — 쓰기를 순차로 바꾸는 대가"
order: 3
level: 심화
summary: "B-tree 의 제자리 갱신이 쓰기에 불리한 이유, LSM 의 구조(WAL → memtable → 불변 SSTable), 읽기 경로와 블룸 필터·펜스 포인터·블록 캐시, 삭제는 톰스톤, 컴팩션 전략(레벨드·티어드·FIFO·유니버설)과 세 증폭의 트레이드오프, 쓰기 정체(stall), RocksDB·Cassandra·ScyllaDB·Kafka·Lucene 이 같은 아이디어를 어떻게 쓰는지, 언제 B-tree 대신 LSM 을 고르나"
tags: [LSM, memtable, SSTable, 컴팩션, 블룸 필터, 톰스톤, RocksDB, Cassandra, 쓰기 증폭, write stall]
experiments: [dbi-write-amplification]
---

## B-tree 의 쓰기는 왜 비싼가

[B-tree](/db-internals/notes/02-btree-pages-buffer-pool) 는 **제자리 갱신**이다. 행 하나를 바꾸려면 그 행이 사는 리프 페이지를 읽고, 고치고, 다시 쓴다(그리고 WAL 에도). 키가 무작위면 쓰기가 디스크 전체에 흩어진 **임의 I/O** 가 되고, 페이지 단위로 쓰니 쓰기 증폭이 크다. 쓰기가 압도적인 워크로드(시계열, 로그, 메시징, 이벤트, 메트릭)에서는 이게 병목이다.

LSM(Log-Structured Merge) 트리의 발상: **절대 제자리에서 고치지 말자. 전부 메모리에 모았다가 정렬해서 통째로 순차로 쓰자. 정리는 나중에 백그라운드로.**

## 구조

```
쓰기 ─► WAL(순차 추가, 내구성) 
     └► memtable (메모리, 정렬된 구조: 스킵 리스트/레드블랙)
           │ 가득 차면(예: 64MB) 불변으로 얼리고 새 memtable 시작
           ▼
        flush → L0 SSTable (정렬된 불변 파일)  ← 순차 쓰기 한 번
           │
           ▼ 컴팩션 (백그라운드 병합 정렬)
        L1  [SST][SST][SST]          레벨마다 크기 10배
        L2  [SST][SST][SST][SST]...
        L3  ...
```

![LSM 트리의 쓰기·읽기·컴팩션](/diagrams/dbi-lsm.svg)

**SSTable**(Sorted String Table): 키 순으로 정렬된 불변 파일. 내부는 데이터 블록(4~64KB, 압축) + 인덱스 블록(블록마다 첫 키 = 펜스 포인터) + 블룸 필터 + 메타.

쓰기 비용은 **WAL 추가(순차) + memtable 삽입(메모리)** 이 전부다. 디스크 임의 쓰기가 없다. 그래서 LSM 은 쓰기 처리량이 B-tree 의 몇 배다.

## 읽기 경로 — 대가를 치르는 곳

키 하나를 읽으려면 **가장 새로운 곳부터** 찾는다(같은 키가 여러 곳에 있을 수 있고 최신이 이긴다).

1. 활성 memtable → 얼린 memtable 들
2. L0 의 SSTable **전부**(L0 는 flush 순서대로 쌓여 키 범위가 겹친다)
3. L1, L2, ... 각 레벨에서 키 범위가 맞는 SSTable **하나**(L1 이상은 레벨 안에서 범위가 안 겹친다)

최악이면 파일 수십 개를 열어 봐야 한다 — **읽기 증폭**. 이것을 줄이는 장치들:

| 장치 | 하는 일 | 효과 |
|---|---|---|
| **블룸 필터** (SSTable 마다) | "이 키는 이 파일에 **확실히 없다**" 를 메모리에서 판단 | 키당 10비트면 오탐 ~1%. 없는 파일은 디스크를 안 읽음. 점 조회의 생명줄 |
| **펜스 포인터** | 데이터 블록별 첫 키 → 이진 탐색으로 블록 하나만 읽음 | 파일당 블록 읽기 1번 |
| **블록 캐시** | 자주 읽는 데이터 블록·인덱스·필터를 메모리에 | 뜨거운 키는 디스크 0번 |
| **프리픽스 블룸/범위 필터** | 접두사 단위 필터(Ribbon, SuRF) | 범위 질의의 파일 건너뛰기 |

**범위 질의**는 블룸 필터가 도움이 안 된다. 모든 레벨의 반복자를 열어 **병합**해야 한다(k-way merge). 그래서 LSM 은 점 조회 < 범위 스캔 순으로 B-tree 대비 불리하다. [Redis 의 블룸 필터](/redis/notes/13-probabilistic)와 같은 자료구조가 여기서 핵심 부품이다.

## 삭제는 톰스톤

불변 파일에서 지울 수 없으니 삭제는 **톰스톤**(이 키는 죽었음) 레코드를 **쓰는 것**이다. 읽기가 톰스톤을 만나면 "없음". 진짜로 공간이 회수되는 것은 컴팩션이 톰스톤과 그 아래의 옛 값들을 함께 **가장 아래 레벨까지 내려가며** 버릴 때다.

문제들:

- **톰스톤 누적**: 큐처럼 쓰고 지우는 패턴(앞에서 지우고 뒤에 추가)은 범위 스캔이 수많은 톰스톤을 밟고 지나간다. Cassandra 의 악명 높은 `TombstoneOverwhelmingException`.
- **부활**: 분산 복제(Cassandra)에서 톰스톤이 `gc_grace_seconds` 전에 컴팩션으로 사라지고, 그때 오프라인이던 복제본이 돌아와 옛 값을 퍼뜨리면 **지운 데이터가 살아난다**. 그래서 repair 주기 < gc_grace 가 운영 규칙이다.
- **범위 삭제**: RocksDB 의 `DeleteRange` 는 범위 톰스톤 하나로 수백만 키를 지운다.

[OpenSearch 의 삭제 마킹](/opensearch/notes/01-inverted-index-analyzers)(`.liv` 비트맵)과 [PostgreSQL 의 죽은 튜플](/db-internals/notes/06-mvcc-gc-comparison)도 같은 질문 — "불변/추가 전용 구조에서 삭제를 어떻게 회수하나" — 의 다른 답이다.

## 컴팩션 — 모든 트레이드오프가 모이는 곳

컴팩션은 여러 SSTable 을 읽어 병합 정렬하고, 같은 키의 옛 버전과 톰스톤을 버리고, 새 SSTable 로 쓴다. **언제 무엇을 병합하나** 가 전략이다.

### 레벨드 (Leveled, RocksDB 기본·LevelDB)

```
L1: 총 256MB, 파일들 키 범위 안 겹침
L2: 2.56GB  (×10)
L3: 25.6GB  (×10)
Ln 이 목표 크기를 넘으면 → Ln 의 파일 하나 + 키 범위가 겹치는 Ln+1 파일들(~10개) 을 병합 → Ln+1 에 기록
```

- **읽기 증폭 낮음**: 레벨당 파일 하나.
- **공간 증폭 낮음**: ~1.1배(대부분 데이터가 마지막 레벨에 있고 중복이 적다).
- **쓰기 증폭 높음**: 데이터 하나가 레벨마다 ~10배씩 다시 써진다 → 총 **10~30배**.

### 티어드 (Tiered / Size-tiered, Cassandra STCS·ScyllaDB)

```
크기가 비슷한 SSTable 이 N 개(예: 4) 모이면 → 그 N 개를 합쳐 더 큰 하나로
작은 것 4개 → 중간 1개, 중간 4개 → 큰 1개 ...
```

- **쓰기 증폭 낮음**: 데이터가 티어마다 한 번씩만 다시 써진다 → 수 배.
- **읽기 증폭 높음**: 같은 티어에 범위가 겹치는 파일이 여럿.
- **공간 증폭 높음**: 병합 중 입력과 출력이 동시에 존재 → 최악 **2배**의 디스크가 일시적으로 필요. 디스크 50% 가 넘으면 큰 컴팩션을 못 할 수 있다.

### 그 외

| 전략 | 방식 | 맞는 곳 |
|---|---|---|
| FIFO | 오래된 파일을 통째로 삭제, 병합 없음 | TTL 시계열·캐시 (쓰기 증폭 ≈ 1) |
| Time-window (Cassandra TWCS) | 시간 창별로 티어드, 창이 닫히면 그 창은 끝 | 시계열 + TTL |
| Universal (RocksDB) | 티어드 계열, 공간 증폭 상한으로 전체 병합 | 쓰기 많은 워크로드 |
| 하이브리드 | L0~L1 티어드 + 아래 레벨드 | 많은 최신 엔진의 기본 |

### 세 증폭 비교

| | 쓰기 증폭 | 읽기 증폭 | 공간 증폭 |
|---|---|---|---|
| B-tree | 중~높음(페이지 단위 제자리, 무작위 키면 ↑) | **낮음** | 중(채움률 70~90%) |
| LSM 레벨드 | 높음(10~30×) | 낮음~중 | **낮음**(1.1×) |
| LSM 티어드 | **낮음** | 높음 | 높음(최대 2×) |

[디스크 노트](/db-internals/notes/01-disk-memory-hierarchy)의 RUM 추측 그대로다 — 하나를 얻으면 다른 것을 낸다.

## 쓰기 정체 (write stall)

컴팩션이 flush 속도를 못 따라가면 L0 파일이 쌓인다. L0 는 범위가 겹쳐 읽기가 L0 파일 수에 비례해 느려지므로, 엔진은 L0 파일이 임계값을 넘으면 **쓰기를 늦추고(slowdown) 결국 멈춘다(stop)**.

```
RocksDB:
  level0_slowdown_writes_trigger = 20   → 쓰기 지연 주입
  level0_stop_writes_trigger     = 36   → 쓰기 정지
  max_background_compactions / max_subcompactions → 컴팩션 병렬도
  soft/hard_pending_compaction_bytes_limit
```

증상: 평소 1ms 쓰기가 주기적으로 수백 ms ~ 초 단위로 튄다. LSM 기반 시스템(Cassandra, CockroachDB, TiKV, Kafka Streams 상태 저장소)의 p99 스파이크 원인 1순위다. 대처: 컴팩션 스레드·I/O 대역폭 늘리기, 버스트 쓰기 평탄화, 디스크 처리량 확보. 이것은 [꼬리 지연](/performance/notes/08-tail-latency-at-scale)과 [백프레셔](/performance/notes/08-tail-latency-at-scale)의 저장 엔진 버전이다.

## 같은 아이디어, 여러 시스템

| 시스템 | LSM 의 어디를 닮았나 |
|---|---|
| **RocksDB** | 교과서 구현. MyRocks, CockroachDB(Pebble 는 Go 재구현), TiKV, Kafka Streams 상태 저장소([Kafka Streams](/kafka/notes/06-streams-connect-schema)), Flink 상태 백엔드 |
| **Cassandra / ScyllaDB** | 분산 LSM. 파티션 키로 노드 분배, 노드 안은 LSM. 컴팩션 전략을 테이블마다 선택 |
| **Lucene / OpenSearch** | 세그먼트 = SSTable, refresh = flush, 머지 = 컴팩션, `.liv` = 톰스톤([역색인 노트](/opensearch/notes/01-inverted-index-analyzers)) |
| **Kafka** | memtable 없이 **로그 자체가 데이터**. 세그먼트 파일 + 보존 기간 삭제(FIFO) + 로그 컴팩션(키별 최신만 남기기)([Kafka 내부](/kafka/notes/05-internals-storage-replication)) |
| **Redis AOF** | 추가 전용 로그 + `BGREWRITEAOF`(현재 상태로 다시 쓰기 = 전체 컴팩션)([Redis 영속성](/redis/notes/04-persistence)) |
| **Bitcask** (Riak) | 추가 전용 로그 + 메모리 해시 인덱스(키 → 오프셋) + 병합. 키가 메모리에 다 들어가야 함 |

## 언제 LSM 을 고르나

| 상황 | 선택 |
|---|---|
| 쓰기 ≫ 읽기, 시계열·이벤트·로그·메트릭 | LSM |
| 쓰기 처리량이 디스크 임의 IOPS 를 넘는다 | LSM |
| 압축률이 중요(블록 단위 압축, 정렬돼 유사 데이터 인접) | LSM (B-tree 보다 공간 효율 좋은 경우 많음) |
| 점 조회·범위 조회가 지배, 지연 예측 가능성이 중요 | B-tree |
| 트랜잭션·복잡한 질의·조인 | B-tree 기반 RDBMS (MyRocks 같은 예외 있음) |
| SSD 수명이 걱정(쓰기 증폭) | 티어드 LSM 또는 B-tree — 레벨드 LSM 은 쓰기 증폭이 큼 |

## 예시로 보기 — 이 프로젝트에서

이 프로젝트에 RocksDB 를 직접 띄우지는 않았지만, LSM 의 거의 모든 개념을 이미 다루는 시스템이 셋 있다:

- **OpenSearch**(`pnpm search:up`): 실험 `search-shards-refresh` 의 refresh = flush, `_stats/segments` 의 세그먼트 수 = SSTable 수, `_forcemerge` = 전체 컴팩션.
- **Kafka**(`pnpm kafka:up`): `docker exec study-kafka ls /var/lib/kafka/data/<topic>-0` 로 세그먼트 파일(`.log`, `.index`, `.timeindex`)을 볼 수 있다. 보존 기간이 FIFO 컴팩션이다.
- **Redis AOF**: 실험 `dbi-wal-vs-aof` 가 AOF 를 켠다. `INFO persistence` 의 `aof_current_size` 와 `aof_base_size` 를 보고 `BGREWRITEAOF` 후 줄어드는 것을 확인하자.

실험 `dbi-write-amplification` 의 **배치 커밋 = 1.1배 vs 단일 행 커밋 = 40배** 대비는 LSM 의 memtable 이 하는 일 — "작은 쓰기를 메모리에 모아 한 번에 순차로" — 의 효과를 그대로 보여 준다.

## 실전에서는 어디에 쓰이나

> 쓰기량이 디스크 임의 IOPS 를 넘는 시계열·이벤트·메시지 저장, 그리고 "평소엔 빠른데 주기적으로 p99 가 튄다" 는 장애에서 LSM 과 컴팩션이 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 메신저·채팅 메시지 저장 | 대량 쓰기 + 채널별 최근 메시지 조회 | Cassandra·ScyllaDB 같은 분산 LSM, 채널을 파티션 키로 | 샤딩한 RDBMS(쓰기 확장에 운영 부담) |
| IoT·메트릭 시계열 | TTL 이 있는 대량 적재 | 시간 창 컴팩션(TWCS)·FIFO 로 오래된 파일을 통째 삭제 | RDBMS + 시간 파티션 드롭 |
| 스트림 처리 상태 저장 | 키별 상태를 로컬 디스크에 빠르게 | Kafka Streams·Flink 의 RocksDB 상태 저장소 | 힙 메모리 상태(크기 한계) |
| 분산 SQL 의 저장 계층 | 트랜잭션 DB 아래의 확장 가능한 키-값 | CockroachDB(Pebble)·TiKV(RocksDB) 가 Raft 아래에 LSM | 단일 노드 B-tree |
| 쓰고 곧 지우는 작업 테이블 | 처리 후 삭제 | 톰스톤 누적을 고려해 범위 삭제·TTL 로 설계 | 큐는 Kafka·전용 큐로 |

**이럴 땐 안 맞는다**
- 점 조회·범위 스캔이 지배하고 지연 예측성이 중요한 OLTP — 읽기 증폭과 컴팩션 스파이크가 부담이다. B-tree RDBMS 가 맞다.
- 큐처럼 앞에서 지우고 뒤에 추가하는 패턴 — 범위 스캔이 톰스톤을 밟고 지나간다. 메시지 큐를 쓴다.

**누가 매일 만나나** — Cassandra·Kafka Streams·분산 DB 를 운영하는 SRE·데이터 플랫폼 엔지니어가 쓰기 정체 경보, 디스크 50% 경고, 톰스톤 경고를 받을 때.

**면접·실무 단골 질문**
- Q. LSM 이 쓰기에 강하고 읽기에 약한 이유? → 쓰기는 WAL 추가 + memtable 로 끝나고, 읽기는 여러 레벨·파일을 뒤져야 해 블룸 필터·블록 캐시로 보완한다.
- Q. 레벨드와 티어드 컴팩션의 트레이드오프? → 레벨드는 읽기·공간 증폭이 낮고 쓰기 증폭이 높다. 티어드는 그 반대이고 공간이 일시적으로 최대 2배 필요하다.

## 실습 체크리스트

- [ ] 레벨드와 티어드에서 "100GB 데이터가 최종 레벨까지 가는 동안 디스크에 몇 GB 를 쓰는가" 를 레벨 비율 10, 티어 4 로 계산해 보기
- [ ] OpenSearch 인덱스에 문서를 넣고 지우기를 반복하며 `_cat/segments` 의 `docs.deleted` 와 세그먼트 수 변화를 관찰, `_forcemerge` 후와 비교
- [ ] Kafka 토픽의 세그먼트 파일을 나열하고 `segment.bytes` 를 작게 해 세그먼트가 굴러가는 것 보기
- [ ] Redis `BGREWRITEAOF` 전후의 `aof_current_size` 를 기록하고, AOF 재작성이 LSM 컴팩션과 어디가 같고 어디가 다른지 적기
- [ ] "블룸 필터 오탐 1%, SSTable 20개" 일 때 없는 키 조회의 기대 디스크 읽기 수를 계산하기
