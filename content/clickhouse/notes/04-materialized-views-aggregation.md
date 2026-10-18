---
title: "머티리얼라이즈드 뷰와 사전 집계 — 질의할 때가 아니라 쓸 때 계산한다"
order: 4
level: 심화
summary: "ClickHouse 의 머티리얼라이즈드 뷰가 'INSERT 트리거' 라는 사실(원본 테이블을 다시 읽지 않는다), SummingMergeTree 로 카운터를, AggregatingMergeTree 와 -State/-Merge 조합자로 uniq·quantile 같은 비가산 집계를 사전 집계하는 법, 대시보드 질의가 수백 배 빨라지는 구조, 기존 데이터 백필, 뷰 체인, Refreshable MV, 프로젝션과의 선택, 흔한 실수(SELECT * 로 집계 테이블 읽기, 머지 전 중복)"
tags: [머티리얼라이즈드 뷰, 사전 집계, AggregatingMergeTree, SummingMergeTree, State, Merge, 롤업, 백필]
experiments: []
---

## 왜 사전 집계인가

대시보드 패널 하나가 "최근 7일, 서비스별, 1분 단위 요청 수와 p95" 를 그린다고 하자. 원본 로그가 하루 10억 줄이면 패널을 열 때마다 70억 줄을 읽는다. 30초마다 새로 고침하는 패널 20개면 감당이 안 된다.

해법은 **쓸 때 미리 줄여 두는 것** 이다. 1분·서비스 단위로 묶으면 10억 줄이 하루 1,440 × 서비스 수 행이 된다. Prometheus 의 [레코딩 룰](/observability/notes/11-slo-dashboard-burn-rate) 과 같은 아이디어를 SQL 로 한다.

## ClickHouse 의 머티리얼라이즈드 뷰 = INSERT 트리거

다른 DB 의 머티리얼라이즈드 뷰는 "원본을 주기적으로 다시 계산해 저장" 하는 경우가 많다. ClickHouse 의 (기본) MV 는 다르다.

> **원본 테이블에 INSERT 되는 블록마다, 그 블록에만 SELECT 를 실행해 결과를 대상 테이블에 INSERT 한다.**

- 원본 테이블 전체를 다시 읽지 않는다. 그래서 싸다.
- 블록 단위로 계산하므로, 같은 키의 결과가 **여러 블록에 나뉘어** 대상 테이블에 들어간다. 이를 합치는 것은 대상 테이블 엔진(Summing/AggregatingMergeTree)의 머지와, 질의 때의 재집계가 맡는다.
- MV 를 만들기 **전** 에 있던 데이터는 자동으로 들어가지 않는다(백필 필요).

```
INSERT INTO logs ─┬─▶ logs (원본 MergeTree)
                  └─▶ [MV: SELECT … GROUP BY …] ─▶ logs_1m (Aggregating/SummingMergeTree)
```

![원본 테이블 → 머티리얼라이즈드 뷰 → 집계 테이블](/diagrams/ch-mv-pipeline.svg)

## 가산 집계: SummingMergeTree

count·sum 처럼 **나눠서 더해도 같은** 집계는 SummingMergeTree 로 충분하다.

```sql
CREATE TABLE req_1m (
  minute DateTime, service LowCardinality(String), status UInt16,
  requests UInt64, bytes UInt64
) ENGINE = SummingMergeTree
ORDER BY (service, status, minute);

CREATE MATERIALIZED VIEW req_1m_mv TO req_1m AS
SELECT toStartOfMinute(ts) minute, service, status, count() requests, sum(bytes) bytes
FROM logs GROUP BY minute, service, status;
```

머지 때 같은 `(service, status, minute)` 의 행이 합쳐진다. 하지만 **머지 전에는 중복 행이 남아 있으므로** 질의는 항상 다시 합친다.

```sql
SELECT minute, sum(requests) FROM req_1m
WHERE service = 'study-app' AND minute > now() - INTERVAL 1 DAY
GROUP BY minute ORDER BY minute;
```

## 비가산 집계: AggregatingMergeTree 와 -State / -Merge

p95, 고유 사용자 수(uniq)는 나눠서 더할 수 없다. 1분 p95 60개를 평균내도 1시간 p95 가 아니다. ClickHouse 는 집계의 **중간 상태**를 저장하는 방법을 준다.

- `quantileState(0.95)(x)` — 분위수 계산에 필요한 요약(t-digest 류)을 바이너리 상태로
- `uniqState(user_id)` — HyperLogLog 류 상태
- 질의 때 `quantileMerge(0.95)(state)` / `uniqMerge(state)` 로 상태들을 병합해 최종값

```sql
CREATE TABLE lat_1m (
  minute DateTime, service LowCardinality(String), route LowCardinality(String),
  requests AggregateFunction(count),
  p95      AggregateFunction(quantile(0.95), UInt32),
  users    AggregateFunction(uniq, UInt64)
) ENGINE = AggregatingMergeTree
ORDER BY (service, route, minute);

CREATE MATERIALIZED VIEW lat_1m_mv TO lat_1m AS
SELECT toStartOfMinute(ts) minute, service, route,
       countState() requests,
       quantileState(0.95)(duration_ms) p95,
       uniqState(user_id) users
FROM logs GROUP BY minute, service, route;

-- 1시간 단위로 다시 묶어 보기: 상태를 병합하므로 정확한(근사 범위 안의) 1시간 p95 가 나온다
SELECT toStartOfHour(minute) hour, service,
       countMerge(requests) requests,
       quantileMerge(0.95)(p95) p95,
       uniqMerge(users) users
FROM lat_1m
WHERE minute > now() - INTERVAL 7 DAY
GROUP BY hour, service ORDER BY hour;
```

| 조합자 | 의미 |
|---|---|
| `xxxState` | 집계 중간 상태를 만든다 (MV 의 SELECT 에서) |
| `xxxMerge` | 상태들을 병합해 최종값 (질의에서) |
| `xxxMergeState` | 상태들을 병합해 다시 상태로 (롤업 체인에서) |
| `SimpleAggregateFunction(max, T)` | min·max·sum·any 처럼 상태가 값 자체인 경우 — 저장이 가볍다 |

> **흔한 실수:** `SELECT * FROM lat_1m` 을 하면 p95 열이 깨진 바이너리로 보인다. 집계 테이블은 반드시 `-Merge` 로 읽는다.

## 효과는 얼마나?

원본 10억 행/일 → 1분 집계는 하루 1,440 × (서비스 10 × 경로 50) = 72만 행. 7일 대시보드는 70억 행 대신 500만 행을 읽는다. 읽는 열도 상태 몇 개뿐이다. 수백~수천 배 차이가 나는 것이 보통이다.

## 롤업 체인 — 1분 → 1시간 → 1일

오래된 데이터는 거칠게 보관하면 된다. MV 를 체인으로 잇는다.

```sql
CREATE MATERIALIZED VIEW lat_1h_mv TO lat_1h AS
SELECT toStartOfHour(minute) hour, service, route,
       countMergeState(requests) requests,       -- 상태 → 상태
       quantileMergeState(0.95)(p95) p95,
       uniqMergeState(users) users
FROM lat_1m GROUP BY hour, service, route;
```

그리고 TTL 로 단계별 보존을 다르게 둔다: 원본 7일, 1분 집계 30일, 1시간 집계 1년. 저장 비용이 극적으로 준다 — [관측 데이터 비용](/finops/notes/04-data-observability-cost) 의 다운샘플링과 같은 전략이다.

## 백필 — MV 이전 데이터

MV 는 생성 이후 INSERT 만 본다. 기존 데이터는 대상 테이블에 직접 넣는다.

```sql
-- 1) MV 를 먼저 만들어 새 데이터부터 받기 시작
-- 2) 생성 시점 이전 데이터를 같은 SELECT 로 직접 적재 (경계 시각을 정확히)
INSERT INTO lat_1m
SELECT toStartOfMinute(ts), service, route, countState(), quantileState(0.95)(duration_ms), uniqState(user_id)
FROM logs WHERE ts < '2026-10-17 00:00:00'
GROUP BY 1, 2, 3;
```

경계에서 중복·누락이 없도록 MV 생성 시각과 백필 범위를 맞춘다. 큰 테이블은 파티션(하루)씩 나눠 백필한다.

## Refreshable MV — 주기적 전체 재계산

조인이 많거나, 늦게 도착한 데이터로 결과가 바뀌는 집계는 INSERT 트리거 방식이 어렵다. ClickHouse 는 일정 간격으로 SELECT 전체를 다시 실행해 결과를 교체하는 **Refreshable MV** 도 지원한다.

```sql
CREATE MATERIALIZED VIEW daily_top_routes
REFRESH EVERY 10 MINUTE
ENGINE = MergeTree ORDER BY (day, n)
AS SELECT toDate(ts) day, route, count() n FROM logs WHERE ts > now() - INTERVAL 7 DAY GROUP BY day, route;
```

원본을 매번 읽으므로 비싸지만, 결과가 항상 원본과 일치한다. [dbt 의 증분 모델](/data-engineering/notes/04-transformation-dbt) 과 비슷한 자리다.

## MV vs 프로젝션 vs 원본 질의

| | 머티리얼라이즈드 뷰 | 집계 프로젝션 | 원본 질의 |
|---|---|---|---|
| 저장 위치 | 별도 테이블 | 같은 테이블 안 | — |
| 질의에서 | 집계 테이블을 명시해 읽음 | 옵티마이저가 자동 선택 | — |
| 유연성 | 다른 엔진·TTL·다른 DB 로도 | 원본과 같은 TTL·파티션 | 무한 |
| 복잡한 변환·조인 | 가능 | 단순 GROUP BY 만 | — |
| 운영 | 뷰 정의 변경이 번거로움 | ALTER 로 관리 | — |

질의가 몇 개로 정해져 있고 빠름이 최우선이면 MV, 질의 코드를 바꾸지 않고 가속하고 싶으면 프로젝션, 탐색적 분석이면 원본을 그대로 질의한다.

## 예시로 보기 — 이 프로젝트에서

이 사이트의 Grafana 대시보드는 Prometheus 메트릭으로 RED(요청률·오류·지연)를 그린다. 같은 것을 로그에서 그리고 싶다면, [ch-log-analytics](/clickhouse/lab/ch-log-analytics) 실험이 만드는 `lab_ch.logs` 와 같은 구조에 다음 MV 를 붙이면 된다.

```sql
CREATE TABLE lab_ch.red_1m (
  minute DateTime, service LowCardinality(String), route LowCardinality(String),
  requests AggregateFunction(count),
  errors   SimpleAggregateFunction(sum, UInt64),
  p95      AggregateFunction(quantile(0.95), UInt32)
) ENGINE = AggregatingMergeTree ORDER BY (service, route, minute);

CREATE MATERIALIZED VIEW lab_ch.red_1m_mv TO lab_ch.red_1m AS
SELECT toStartOfMinute(ts) minute, service, route,
       countState() requests, sum(level = 'error') errors, quantileState(0.95)(duration_ms) p95
FROM lab_ch.logs GROUP BY minute, service, route;
```

실험 테이블에 행을 더 넣은 뒤 `SELECT route, countMerge(requests), sum(errors), quantileMerge(0.95)(p95) FROM lab_ch.red_1m GROUP BY route` 로 원본 질의 결과와 비교해 보자. 같은 숫자가 훨씬 적은 행을 읽고 나온다.

## 실전에서는 어디에 쓰이나

> 사전 집계는 "대시보드를 열 때마다 원본 수십억 행을 읽는다" 는 문제를 만났을 때 등장한다. 질의 시간의 계산을 쓰기 시간으로 옮기는 기술이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 실시간 매출 대시보드 | 30초마다 새로 고침되는 패널 수십 개 | SummingMergeTree 대상 MV 로 분 단위 매출·주문 수 | 원본 질의 + Redis 결과 캐시 — 신선도 손해 |
| API 플랫폼 지연 SLO | 엔드포인트별 p95 를 시간·일 단위로 | AggregatingMergeTree + `quantileState`/`quantileMerge` | Prometheus 히스토그램 + 레코딩 룰 |
| 미디어·스트리밍 시청 통계 | 콘텐츠별 고유 시청자 수 장기 보관 | `uniqState` 1분 → 1시간 롤업 체인 + 단계별 TTL | dbt 일 배치로 일 단위 테이블 |
| 광고 리포트(늦게 도착하는 전환) | 조인·지연 도착으로 값이 바뀌는 집계 | Refreshable MV 로 주기적 재계산 | 웨어하우스 배치 ETL |

**이럴 땐 안 맞는다**
- 질문이 매번 바뀌는 탐색 분석 → 미리 정한 차원 밖은 답하지 못한다. 원본을 질의한다.
- 원본이 자주 정정·삭제됨 → INSERT 트리거 MV 는 정정을 따라가지 않는다. Refreshable MV 나 배치 재계산으로.

**누가 매일 만나나** — 데이터 엔지니어가 대시보드 요구를 받아 집계 테이블을 설계할 때, SRE 가 로그 기반 RED 대시보드를 만들 때.

**면접·실무 단골 질문**
- Q. 1분 p95 60개를 평균내면 1시간 p95 인가? → 아니다. 중간 상태(`-State`)를 저장하고 `-Merge` 로 병합해야 한다.
- Q. MV 를 만들었는데 과거 데이터가 안 보인다 → INSERT 트리거라 생성 이전 데이터는 백필해야 한다.

## 실습 체크리스트

- [ ] SummingMergeTree 대상 MV 를 만들고, 머지 전 `SELECT *` 와 `sum()` 재집계 결과가 다른 것 확인하기
- [ ] `quantileState` → `quantileMerge` 로 1분 집계에서 1시간 p95 를 구하고, 원본에서 직접 구한 1시간 p95 와 비교하기
- [ ] 1분 p95 60개의 평균이 1시간 p95 와 다르다는 것을 숫자로 보이기
- [ ] MV 생성 전 데이터가 집계에 빠지는 것을 확인하고, 백필 INSERT 로 채우기
- [ ] `system.query_log` 로 원본 질의와 집계 테이블 질의의 read_rows 비교
