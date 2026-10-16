---
title: "MergeTree 엔진 — 파트, 머지, 희소 인덱스, 그래뉼"
order: 2
level: 중급
summary: "ClickHouse 의 핵심 테이블 엔진 MergeTree 가 데이터를 어떻게 저장하는지: INSERT 마다 생기는 불변 파트, 백그라운드 머지(LSM 과 같은 계열), 정렬 키 순으로 정렬된 열 파일, 8,192행 단위 그래뉼과 마크 파일, 그래뉼마다 키 하나만 두는 희소 기본 키 인덱스, 질의가 읽을 그래뉼을 고르는 과정(EXPLAIN indexes=1), 작은 INSERT 가 위험한 이유(Too many parts), ReplacingMergeTree·CollapsingMergeTree 로 갱신·삭제를 흉내 내는 법"
tags: [MergeTree, 파트, 머지, 그래뉼, 희소 인덱스, 마크, 정렬 키, ReplacingMergeTree, Too many parts]
experiments: [ch-sort-key-skip-index]
---

## 한 문장 요약

MergeTree 는 **INSERT 를 받을 때마다 정렬된 불변 파일 묶음(파트)을 만들고, 백그라운드에서 작은 파트들을 큰 파트로 병합(머지)하는** 엔진이다. [LSM 트리](/db-internals/notes/03-lsm-tree-compaction) 와 같은 계열이지만, 메모리 테이블(memtable)과 WAL 없이 INSERT 가 곧장 디스크 파트가 된다는 점이 다르다.

![MergeTree — 파트, 그래뉼, 희소 인덱스](/diagrams/ch-mergetree.svg)

## 파트(part) — INSERT 한 번 = 파트 하나

```sql
INSERT INTO logs VALUES (...), (...), ...;   -- 1만 행
```

이 INSERT 는 디스크에 디렉터리 하나를 만든다.

```
/var/lib/clickhouse/data/lab_ch/logs/
  20261016_1_1_0/        ← 파티션ID_최소블록_최대블록_레벨
    columns.txt
    count.txt            1만
    primary.idx          희소 기본 키 인덱스
    ts.bin  ts.cmrk2     열 데이터(압축) + 마크(그래뉼 → 파일 위치)
    level.bin level.cmrk2
    ...
    minmax_ts.idx        파티션 키 열의 min/max
    checksums.txt
```

- 파트 안의 행은 **정렬 키(ORDER BY) 순서로 정렬**돼 있다.
- 파트는 **불변**이다. 갱신은 "새 파트를 쓰고 옛 파트를 버리는" 방식으로만 일어난다.
- `system.parts` 에서 활성 파트를 볼 수 있다.

```sql
SELECT partition, name, rows, marks, formatReadableSize(data_compressed_bytes) size, level
FROM system.parts WHERE database = 'lab_ch' AND table = 'logs' AND active;
```

## 머지 — 작은 파트를 큰 파트로

백그라운드 스레드가 같은 파티션의 파트 몇 개를 골라 **정렬 병합**(merge sort)으로 하나로 합친다. 이름의 마지막 숫자(레벨)가 올라간다.

```
20261016_1_1_0  + 20261016_2_2_0  + 20261016_3_3_0
            ↓ 머지
20261016_1_3_1
```

- 머지는 이미 정렬된 파트를 합치므로 싸다(순차 읽기 + 순차 쓰기).
- 머지 도중에도 질의는 옛 파트를 읽는다. 머지가 끝나면 원자적으로 교체된다.
- 같은 파티션끼리만 합쳐진다. 그래서 **파티션이 너무 잘게 쪼개지면** 머지가 일을 못 하고 파트가 쌓인다.
- `OPTIMIZE TABLE t FINAL` 은 파티션당 파트를 하나로 강제 병합한다. 실험에서는 측정을 정확하게 하려고 쓰지만, 운영에서 습관적으로 쓰면 대용량 테이블 전체를 다시 쓰는 셈이라 비싸다.

### Too many parts — 작은 INSERT 의 함정

INSERT 를 행 하나씩, 초당 수백 번 보내면 파트가 머지 속도보다 빨리 생긴다. 파티션당 활성 파트가 일정 수(기본 300 근처)를 넘으면 ClickHouse 는 INSERT 를 늦추고(`parts_to_delay_insert`), 더 넘으면 **거부**한다(`Too many parts`).

| 해결 | 방법 |
|---|---|
| 클라이언트 배치 | 1초 또는 수만 행마다 묶어서 INSERT (가장 좋다) |
| 비동기 INSERT | `async_insert=1, wait_for_async_insert=1` — 서버가 버퍼에 모아 한 번에 쓴다 |
| 버퍼 경유 | Kafka 엔진·Buffer 테이블로 받아서 묶어 쓰기 |
| 파티션 축소 | `PARTITION BY toDate(ts)` 이상으로 거칠게 (시간 단위 파티션은 대개 과하다) |

> **규칙:** ClickHouse 에는 "초당 INSERT 횟수는 적게, 한 번에 행은 많이" 를 보낸다. 초당 1회 × 수만 행이 이상적이다.

## 그래뉼과 마크 — 읽기의 최소 단위

파트 안의 행은 **8,192행(index_granularity)씩 그래뉼**로 나뉜다. 질의는 행 단위가 아니라 **그래뉼 단위로** 읽을지 말지를 정한다.

- **마크 파일(`*.cmrk2`)** 은 "그래뉼 N 은 열 파일의 몇 번째 압축 블록, 그 블록 안 몇 번째 바이트부터" 를 적어 둔다. 그래서 필요한 그래뉼만 골라 읽을 수 있다.
- 그래뉼은 8,192행 또는 `index_granularity_bytes`(기본 10MB) 중 먼저 차는 쪽에서 끊긴다(적응형 그래뉼). 큰 문자열 열이 있으면 그래뉼이 작아진다.

실험 [ch-sort-key-skip-index](/clickhouse/lab/ch-sort-key-skip-index) 의 100만 행 테이블은 그래뉼(마크) 124개다. 1,000,000 ÷ 8,192 ≈ 122 + 끝자리.

## 희소 기본 키 인덱스

PostgreSQL 의 [B-tree](/db-internals/notes/02-btree-pages-buffer-pool) 는 **행마다** 항목이 하나 있다(조밀 인덱스). MergeTree 의 `primary.idx` 는 **그래뉼마다 첫 행의 정렬 키 값 하나**만 저장한다(희소 인덱스).

```
primary.idx (ORDER BY (user_id, ts))
그래뉼 0 : (1,     2026-10-01 00:00:03)
그래뉼 1 : (412,   2026-10-01 00:10:20)
그래뉼 2 : (819,   2026-10-01 03:22:51)
...
그래뉼 123: (49880, 2026-10-12 02:11:09)
```

- 100만 행에 항목이 124개뿐이라 **항상 메모리에 올라간다.** 10억 행이어도 12만 개.
- `WHERE user_id = 4242` 는 이 배열을 이진 탐색해 "4242 가 있을 수 있는 그래뉼" 범위만 고른다. 그 그래뉼 안의 8,192행은 전부 읽어서 거른다.
- 그래서 점 조회(한 행 찾기)에는 B-tree 보다 비효율적이지만(최소 8,192행 읽기), 범위·집계 질의에는 압도적으로 작고 빠르다.

```sql
EXPLAIN indexes = 1
SELECT count() FROM ev_by_user WHERE user_id = 26979;
-- PrimaryKey
--   Keys: user_id
--   Condition: (user_id in [26979, 26979])
--   Parts: 1/1
--   Granules: 1/123          ← 123개 중 1개만 읽는다
```

실험 결과(같은 100만 행):

| 조건 | ORDER BY ts | ORDER BY (user_id, ts) |
|---|---|---|
| `user_id = …` | 1,000,000행 읽음 | 8,192행 |
| 시간 범위 1시간 | 8,192행 | 1,000,000행 |

정렬 키의 **첫 열**이 조건에 있어야 이진 탐색이 효과를 낸다. 두 번째 열만으로 거르면 대개 전수 스캔이 된다(첫 열의 카디널리티가 낮으면 일부 건너뛰는 "generic exclusion search" 가 동작하기도 한다). 설계 원칙은 [03 정렬 키·스킵 인덱스](/clickhouse/notes/03-partition-sortkey-skip-index) 에서 다룬다.

### PRIMARY KEY 와 ORDER BY

보통 `ORDER BY` 만 쓰면 기본 키 = 정렬 키다. 정렬은 길게, 인덱스는 짧게 두고 싶을 때만 따로 쓴다.

```sql
ENGINE = MergeTree
ORDER BY (service, level, route, ts)
PRIMARY KEY (service, level)        -- 인덱스는 앞 두 열만 (메모리 절약)
```

PRIMARY KEY 는 **유일성을 보장하지 않는다.** 같은 키의 행이 몇 개든 들어간다. 이게 OLTP DB 와 가장 헷갈리는 지점이다.

## 갱신과 삭제는 어떻게?

불변 파트에 갱신은 없다. 세 가지 방법이 있다.

| 방법 | 동작 | 언제 |
|---|---|---|
| **ReplacingMergeTree(ver)** | 같은 정렬 키의 행 중 머지 때 최신 ver 하나만 남김 | CDC 로 들어오는 "행의 최신 상태" |
| **CollapsingMergeTree(sign)** | +1 행과 -1 행이 머지 때 상쇄 | 상태 변화를 차감 방식으로 |
| **경량 삭제·뮤테이션** | `DELETE FROM t WHERE …`, `ALTER TABLE t UPDATE …` | 드문 정정, GDPR 삭제 |

```sql
CREATE TABLE orders_latest (
  id UInt64, status LowCardinality(String), amount Decimal(12,2), updated_at DateTime64(3)
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

-- 머지는 언제 일어날지 모른다 → 질의 때 중복을 접어야 한다
SELECT * FROM orders_latest FINAL WHERE id = 42;
-- 또는
SELECT id, argMax(status, updated_at) status FROM orders_latest GROUP BY id;
```

> **주의:** ReplacingMergeTree 는 "결국" 중복이 사라진다. 질의 시점에는 중복이 남아 있을 수 있으므로 `FINAL` 이나 `argMax` 로 접어야 정확하다. 이 "병합은 나중에, 질의는 접어서" 는 [CDC → 레이크](/data-engineering/notes/07-tiny-lakehouse-design) 에서 같은 모양으로 다시 나온다.

뮤테이션(`ALTER TABLE … UPDATE/DELETE`)은 영향받는 파트를 **통째로 다시 쓴다.** 1TB 테이블에서 한 행을 지워도 그 행이 있는 파트 전체를 다시 쓸 수 있다. 비용은 [07 운영](/clickhouse/notes/07-distributed-replication-ops) 참고.

## MergeTree 계열 한눈에

| 엔진 | 머지 때 하는 일 | 대표 용도 |
|---|---|---|
| MergeTree | 정렬 병합만 | 로그·이벤트 원본 |
| ReplacingMergeTree | 같은 키의 최신 행만 남김 | CDC 최신 상태 |
| SummingMergeTree | 같은 키의 숫자 열을 합침 | 카운터 사전 집계 |
| AggregatingMergeTree | 같은 키의 집계 상태를 병합 | 머티리얼라이즈드 뷰 대상 → [04](/clickhouse/notes/04-materialized-views-aggregation) |
| CollapsingMergeTree | +1/-1 상쇄 | 상태 변화 |
| Replicated* | 위 + 복제 | 운영 클러스터 → [07](/clickhouse/notes/07-distributed-replication-ops) |

## 예시로 보기 — 이 프로젝트에서

실험 [ch-sort-key-skip-index](/clickhouse/lab/ch-sort-key-skip-index) 를 돌린 뒤 같은 테이블을 직접 만들어 파트와 그래뉼을 들여다보자.

```sql
-- 1) 1만 행씩 10번 INSERT → 파트 10개
CREATE TABLE lab_ch.t (ts DateTime, user_id UInt32) ENGINE = MergeTree ORDER BY ts;
INSERT INTO lab_ch.t SELECT now() + number, rand() % 1000 FROM numbers(10000);  -- 10번 반복
SELECT name, rows, marks, level FROM system.parts WHERE table = 't' AND active;

-- 2) 잠시 뒤(또는 OPTIMIZE) 파트가 합쳐진다
OPTIMIZE TABLE lab_ch.t FINAL;
SELECT name, rows, marks, level FROM system.parts WHERE table = 't' AND active;

-- 3) 머지 이력
SELECT event_type, part_name, rows, duration_ms FROM system.part_log
WHERE table = 't' ORDER BY event_time DESC LIMIT 10;
```

`system.part_log` 의 `NewPart` 와 `MergeParts` 이벤트가 이 노트의 그림을 그대로 보여 준다.

## 실습 체크리스트

- [ ] 작은 INSERT 를 10번 해서 파트 10개를 만들고 `system.parts` 로 확인, `OPTIMIZE … FINAL` 후 다시 확인
- [ ] `EXPLAIN indexes = 1` 로 정렬 키 첫 열 조건과 두 번째 열 조건의 `Granules: x/y` 차이 보기
- [ ] PRIMARY KEY 가 유일성을 보장하지 않음을 같은 키 두 번 INSERT 로 확인
- [ ] ReplacingMergeTree 에 같은 id 를 버전만 바꿔 세 번 넣고 `FINAL` 유무에 따른 결과 차이 보기
- [ ] 1행짜리 INSERT 를 반복하는 스크립트를 짜면 어떤 경고가 나오는지(`system.asynchronous_metrics` 의 MaxPartCountForPartition) 관찰하기
