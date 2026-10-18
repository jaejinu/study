---
title: "파티션·정렬 키 설계와 스킵 인덱스 — 설계의 절반은 ORDER BY"
order: 3
level: 중급
summary: "질의 패턴에서 정렬 키를 고르는 법(가장 자주 거르는 열을 앞에, 카디널리티 낮은 것부터), 파티션은 관리 단위이지 질의 가속 장치가 아니라는 원칙(TTL·DROP PARTITION·과도한 파티션의 비용), 정렬 키에 넣을 수 없는 열을 위한 스킵 인덱스(minmax·set·bloom_filter·tokenbf·ngrambf)와 그 함정, PREWHERE 로 먼저 거르기, 프로젝션으로 두 번째 정렬 순서 갖기, EXPLAIN 으로 검증하는 습관"
tags: [정렬 키, ORDER BY, 파티션, 스킵 인덱스, bloom_filter, minmax, PREWHERE, 프로젝션, TTL]
experiments: [ch-sort-key-skip-index]
---

## 정렬 키가 곧 인덱스다

[MergeTree](/clickhouse/notes/02-mergetree-engine) 에서 본 것처럼 기본 키 인덱스는 **정렬 키 앞부분**으로만 그래뉼을 건너뛴다. 그래서 ClickHouse 테이블 설계는 "어떤 열로, 어떤 순서로 정렬하나" 를 고르는 일이다.

실험 [ch-sort-key-skip-index](/clickhouse/lab/ch-sort-key-skip-index) 의 결과가 원칙을 그대로 보여 준다(같은 100만 행).

| 조건 | ORDER BY ts | ORDER BY (user_id, ts) |
|---|---|---|
| `user_id = 26979` | 1,000,000행 · 4.0MB | **8,192행** · 0.03MB |
| `ts` 1시간 범위 | **8,192행** · 0.03MB | 1,000,000행 · 4.0MB |
| `user_id = … AND ts` 1일 | 180,224행 | **8,192행** |

한 테이블은 한 가지 정렬 순서만 가진다. **가장 자주, 가장 강하게 거르는 조건**에 맞춰야 한다.

## 정렬 키를 고르는 순서

1. **질의 목록부터 쓴다.** 대시보드·알림·조사 질의의 WHERE 절을 모아 빈도순으로 정렬한다.
2. **거의 모든 질의에 들어가는 열을 앞에.** 로그라면 `service`(또는 tenant), 제품 분석이라면 `project_id`.
3. **카디널리티가 낮은 열부터 높은 열 순으로.** `(service, level, ts)` 는 좋고 `(ts, service)` 는 service 필터를 못 쓴다. 낮은 카디널리티를 앞에 두면 같은 값이 길게 이어져 **압축도 좋아진다**([06 코덱](/clickhouse/notes/06-compression-codecs)).
4. **시간은 대개 마지막(또는 그 근처).** 앞 열들로 좁힌 뒤 시간 범위로 자른다.
5. **열은 3~5개 정도.** 너무 길면 인덱스가 커지고 정렬 비용만 는다. 고카디널리티 ID(trace_id, uuid)는 정렬 키 앞쪽에 두지 않는다 — 뒤 열들의 정렬 효과를 없앤다.

```sql
-- 로그: 서비스별로 보고, 레벨로 거르고, 시간 범위를 본다
ORDER BY (service, level, toStartOfHour(ts), ts)

-- 제품 이벤트: 프로젝트 → 이벤트 이름 → 사용자 → 시간
ORDER BY (project_id, event, user_id, ts)

-- 멀티테넌트: 테넌트가 항상 맨 앞
ORDER BY (tenant_id, ...)
```

> **함정:** "시간으로 제일 많이 보니까 `ORDER BY ts`" 는 흔한 실수다. 시간 범위만 거르는 질의는 파티션(일 단위)만으로도 상당히 좁혀진다. 정렬 키 앞자리는 시간보다 더 선택적인 차원에 양보하는 편이 대개 낫다.

## 파티션 — 질의 가속이 아니라 데이터 관리 단위

`PARTITION BY` 는 파트를 묶는 상위 단위다. 서로 다른 파티션의 파트는 절대 머지되지 않는다.

| 쓰임 | 예 |
|---|---|
| 오래된 데이터 통째로 지우기 | `ALTER TABLE logs DROP PARTITION '2026-09-01'` — 파일 삭제라 즉시 |
| 보존 기간 | `TTL ts + INTERVAL 30 DAY` (파티션과 맞으면 파트 단위로 깔끔히 삭제) |
| 계층 저장 | 오래된 파티션을 느린 디스크·S3 로 `TTL … TO VOLUME 'cold'` |
| 파티션 단위 재적재 | 하루치를 다시 만들어 `REPLACE PARTITION` |

파티션 키의 min/max(`minmax_*.idx`)로 파티션을 통째로 건너뛰는 효과도 있지만, 그것이 목적이 되면 안 된다.

**파티션을 너무 잘게 나누지 말 것.** 시간 단위·사용자 단위 파티션은 파트 수를 폭증시켜 머지를 막고 `Too many parts` 를 부른다. 경험칙: 파티션당 수십 GB 이상, 전체 파티션 수는 수천 개 이하. 대부분의 로그·이벤트 테이블은 `toDate(ts)` 또는 `toYYYYMM(ts)` 면 충분하다.

## 스킵 인덱스 — 정렬 키에 못 넣는 열

`trace_id` 로 로그 한 줄을 찾고 싶다. trace_id 는 무작위 고카디널리티라 정렬 키에 넣을 수 없다. **스킵 인덱스(data skipping index)** 는 그래뉼 묶음마다 요약 정보를 저장해 "이 묶음엔 없다" 를 판정한다.

```sql
ALTER TABLE ev ADD INDEX idx_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE ev MATERIALIZE INDEX idx_trace;   -- 기존 파트에 구축 (뮤테이션)
```

실험 결과:

| | 읽은 행 | 읽은 양 | EXPLAIN |
|---|---|---|---|
| 인덱스 없음 | 1,000,000 | 41MB | Granules 123/123 |
| bloom_filter | **576** | 0.02MB | Skip idx_trace Granules **1/123** |
| 인덱스 크기 | | 1.2MiB | |

### 종류

| 타입 | 저장하는 것 | 잘 맞는 조건 |
|---|---|---|
| `minmax` | 묶음의 min/max | 정렬 키와 상관이 있는 열의 범위 (`duration_ms > 1000`) |
| `set(N)` | 묶음의 값 집합(최대 N개) | 묶음마다 값 종류가 적은 열의 `=`·`IN` |
| `bloom_filter(fpr)` | 블룸 필터 | 고카디널리티 열의 `=`·`IN` (trace_id, user_id) |
| `tokenbf_v1` | 단어 토큰의 블룸 필터 | 로그 본문의 단어 검색 (`hasToken(msg, 'timeout')`) |
| `ngrambf_v1` | n-gram 블룸 필터 | 부분 문자열 `LIKE '%xyz%'` |
| `text`(실험적) | 역색인 | 전문 검색 — 그래도 진지한 검색은 [OpenSearch](/opensearch/notes/01-inverted-index-analyzers) |

### 스킵 인덱스의 함정

- **"없다" 만 확실히 말한다.** 값이 거의 모든 그래뉼에 흩어져 있으면 아무것도 못 건너뛰고, 인덱스 확인 비용과 쓰기 비용만 늘어난다. `event IN ('view','click')` 같은 흔한 값에 bloom_filter 는 무의미하다.
- **GRANULARITY** 는 몇 그래뉼을 한 묶음으로 요약할지다. 1 이면 정밀하지만 인덱스가 크고, 4~8 이면 작지만 덜 건너뛴다.
- 추가한 뒤 `MATERIALIZE INDEX` 를 하지 않으면 **새로 쓰는 파트에만** 적용된다.
- 항상 `EXPLAIN indexes = 1` 로 `Skip` 섹션이 실제로 그래뉼을 줄이는지 확인한다. 줄지 않으면 지운다.

## PREWHERE — 싼 열로 먼저 거르기

ClickHouse 는 WHERE 조건 중 일부를 **PREWHERE** 로 옮겨, 그 열만 먼저 읽고 통과한 행에 대해서만 나머지 열을 읽는다. 대개 자동으로 해 주지만(`optimize_move_to_prewhere`), 직접 쓸 수도 있다.

```sql
SELECT trace_id, msg, duration_ms
FROM logs
PREWHERE level = 'error'            -- LowCardinality 열 하나만 먼저 읽는다
WHERE ts > now() - INTERVAL 1 DAY;  -- 통과한 그래뉼에서만 msg(무거운 열)를 읽는다
```

무거운 열(`msg`, `stack`)을 SELECT 하는 질의에서 효과가 크다.

## 두 번째 정렬 순서가 필요하면 — 프로젝션

어떤 질의는 `user_id` 로, 어떤 질의는 `ts` 로 강하게 거른다. 테이블을 둘로 복제하는 대신 **프로젝션**을 쓴다. 같은 테이블 안에 다른 정렬(또는 사전 집계)로 저장된 숨은 복사본이다.

```sql
ALTER TABLE ev ADD PROJECTION by_user (SELECT * ORDER BY user_id, ts);
ALTER TABLE ev MATERIALIZE PROJECTION by_user;
-- 이제 user_id 조건은 옵티마이저가 프로젝션을 골라 읽는다
EXPLAIN SELECT count() FROM ev WHERE user_id = 26979;   -- ReadFromMergeTree (by_user)
```

대가: 저장 공간이 늘고(전체 복사면 2배), INSERT 가 그만큼 느려진다. 집계 프로젝션(`SELECT user_id, count() GROUP BY user_id`)은 작아서 부담이 적다 — [04 머티리얼라이즈드 뷰](/clickhouse/notes/04-materialized-views-aggregation) 와 비교해서 고른다.

## 설계 체크 순서

```
1. 질의 목록 → WHERE 빈도표
2. ORDER BY = (항상 쓰는 저카디널리티 → … → 시간)
3. PARTITION BY = 보존·삭제 단위 (대개 일/월)
4. 남은 고선택 조건 → 스킵 인덱스 후보 → EXPLAIN 으로 검증
5. 두 번째로 중요한 정렬 → 프로젝션
6. TTL 로 보존 기간
```

## 예시로 보기 — 이 프로젝트에서

이 사이트 로그를 ClickHouse 로 옮긴다면 질문은 대략 이렇다.

| 질문 | WHERE |
|---|---|
| 서비스별 오류 추이 | service, level, ts |
| 느린 요청 상위 | service, ts, duration_ms |
| 특정 요청 추적 | trace_id |
| 노트별 조회수 | msg='note.view', ts |

```sql
CREATE TABLE app_logs (
  ts DateTime64(3),
  service LowCardinality(String),
  level LowCardinality(String),
  msg LowCardinality(String),
  route String,
  duration_ms UInt32,
  trace_id String,
  attrs Map(String, String),
  INDEX idx_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_dur duration_ms TYPE minmax GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (service, level, msg, ts)
TTL toDateTime(ts) + INTERVAL 30 DAY;
```

`msg` 는 이 앱에서 `note.view`·`assistant.chat` 처럼 종류가 수십 개뿐인 이벤트 이름이라 LowCardinality 로 정렬 키에 넣었다. `trace_id` 는 bloom_filter, `duration_ms` 는 minmax(정렬과 상관이 약해 효과는 제한적이므로 EXPLAIN 으로 확인).

## 실전에서는 어디에 쓰이나

> 정렬 키 설계는 새 분석 테이블을 만들 때와 "이 대시보드만 유독 느리다" 를 조사할 때 등장한다. 같은 하드웨어에서 읽는 양을 수백 배 바꾸는 결정이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 멀티테넌트 SaaS 분석 | 고객사 대시보드가 남의 데이터까지 스캔 | `ORDER BY (tenant_id, event, ts)` 로 테넌트를 맨 앞에 | 테넌트별 테이블 — 테넌트가 많으면 관리 불가 |
| 장애 조사 도구(trace_id 검색) | 고카디널리티 ID 로 로그 한 줄 찾기 | `bloom_filter` 스킵 인덱스 + `EXPLAIN indexes = 1` 로 검증 | OpenSearch 에 따로 색인 |
| 로그 플랫폼 보존 정책 | 30일 지난 데이터 삭제·차가운 디스크로 이동 | `PARTITION BY toDate(ts)` + `TTL … TO VOLUME`·`DROP PARTITION` | 행 단위 DELETE — 뮤테이션이라 비싸다 |
| 모바일 게임 운영 분석 | 유저 단위 조회와 시간대별 집계를 둘 다 빠르게 | 주 정렬은 집계 쪽, `user_id` 정렬은 프로젝션 | 테이블 두 벌 + MV 로 복제 |

**이럴 땐 안 맞는다**
- 질문이 매번 달라지는 탐색 분석 → 한 정렬 키로 다 맞출 수 없다. 기간을 줄여 원본을 스캔하거나 DuckDB 로 뽑아 본다.
- 시간·사용자 단위로 파티션을 잘게 쪼개 가속하려는 시도 → 파트 폭증. 파티션은 일·월 단위 관리용으로.

**누가 매일 만나나** — 데이터 엔지니어가 테이블 DDL 리뷰에서 ORDER BY 를 따질 때, 분석가·백엔드가 느린 질의의 `read_rows` 를 들여다볼 때.

**면접·실무 단골 질문**
- Q. 시간으로 가장 많이 거르는데 `ORDER BY ts` 가 왜 나쁜가? → 시간 범위는 파티션이 이미 좁힌다. 앞자리는 더 선택적인 저카디널리티 차원에 주면 압축도 좋아진다.
- Q. 스킵 인덱스가 소용없는 경우는? → 값이 거의 모든 그래뉼에 흩어진 흔한 값. EXPLAIN 에서 Granules 가 안 줄면 지운다.

## 실습 체크리스트

- [ ] 실험 `ch-sort-key-skip-index` 결과에서 "user_id AND 1일" 조건이 ts 정렬에서 18만 행을 읽은 이유를 설명하기
- [ ] 우리 서비스 질의 5개로 WHERE 빈도표를 만들고 ORDER BY 를 설계해 보기
- [ ] `event` 처럼 흔한 값 열에 bloom_filter 를 걸고 EXPLAIN 에서 Granules 가 줄지 않는 것 확인하기
- [ ] `PREWHERE` 를 명시했을 때와 안 했을 때 `msg` 를 SELECT 하는 질의의 read_bytes 비교
- [ ] 프로젝션을 추가하고 `system.parts` 의 크기 변화와 INSERT 시간 변화 재기
