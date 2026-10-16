---
title: "로그·트레이스 분석 — 스키마 설계, Loki·OpenSearch 와의 비교, OTel ClickHouse"
order: 5
level: 중급
summary: "관측 데이터를 ClickHouse 에 넣을 때의 스키마 설계(고정 열 + Map 속성, LowCardinality, 시간 정렬, TTL), 구조화 로그와 트레이스 스팬 테이블, 같은 질문에 대한 Loki·OpenSearch·ClickHouse 의 저장·질의 모델 비교(실험 실측 포함), OpenTelemetry Collector 의 ClickHouse exporter 와 Grafana 연동, 적재 파이프라인(Kafka 엔진·배치), 언제 무엇을 고를지"
tags: [로그 분석, 트레이스, 관측, Loki, OpenSearch, OpenTelemetry, Map, LowCardinality, 스키마]
experiments: [ch-log-analytics]
---

## 관측 데이터는 OLAP 데이터다

로그·트레이스·이벤트는 [OLAP](/clickhouse/notes/01-olap-columnar) 의 전형이다. 추가만 되고, 거의 안 고치고, 질문은 "넓게 읽고 몇 열만 집계" 다. 그래서 최근 많은 관측 백엔드(SigNoz, HyperDX, Uptrace, ClickStack, 사내 플랫폼)가 ClickHouse 위에 만들어진다.

## 세 저장소의 모델

| | Loki | OpenSearch | ClickHouse |
|---|---|---|---|
| 무엇을 인덱싱 | **레이블만** (service, level 등 몇 개) | **모든 단어** (역색인) | **정렬 키**(희소) + 선택적 스킵 인덱스 |
| 본문 저장 | 압축 청크(원문) | 원문 + 역색인 + doc values | 열별 압축 |
| 질의 방식 | 레이블로 스트림 선택 → 청크를 풀어 줄마다 필터·파싱 | 역색인으로 문서 집합 → 집계 | 필요한 열만 읽어 벡터화 집계 |
| 강점 | 저장 비용 최저, 운영 단순 | 전문 검색·관련도·하이라이트 | 대규모 집계, 저장 효율, SQL |
| 약점 | 넓은 범위 집계·본문 질의가 무거움 | 인덱스가 커서 저장·메모리 비용 큼 | 스키마·적재 파이프라인 필요, 전문 검색은 약함 |
| 이 사이트 | [로그 노트](/observability/notes/05-logging-loki) | [OpenSearch 집계](/opensearch/notes/04-aggregations-log-analysis) | 이 주제 |

### 실측 — 같은 질문, 두 저장소

실험 [ch-log-analytics](/clickhouse/lab/ch-log-analytics) 는 같은 합성 로그 2만 줄을 Loki 와 ClickHouse 에 넣고(ClickHouse 에는 추가로 50만 줄) 세 가지 질문을 던진다.

| 질문 | 어디서 | 시간 | 읽은 행/줄 | 읽은 양 |
|---|---|---|---|---|
| 레벨별 건수 | ClickHouse (52만 행) | 3ms | 520,085 | 0.52MB |
| | Loki (2만 줄) | 30ms | 20,000 | 2.67MB |
| 상위 경로 5개 | ClickHouse (52만) | 3ms | 520,085 | 0.52MB |
| | Loki (2만) | 16ms | 20,000 | 2.67MB |
| p95 지연 | ClickHouse (52만) | 4ms | 487,317 | 2.44MB |
| | Loki (2만) | 19ms | 20,000 | 2.67MB |

두 저장소의 p95 는 같은 표본에서 131ms 로 일치했다. 차이는 **처리량의 모양**이다. Loki 는 표본 원문(2.7MB) 전체를 풀어 JSON 을 파싱했고, 데이터가 늘면 그만큼 선형으로 늘어난다. ClickHouse 는 행이 26배 많아도 `level` 열 하나(0.5MB)만 읽었다. 반면 Loki 는 스키마 없이 아무 로그나 받고, 레이블만 인덱싱하니 저장이 훨씬 싸고 운영이 쉽다.

> **선택 기준:** 로그를 "가끔 grep 하듯 본다" 면 Loki. "단어로 찾고 관련도로 정렬" 이면 OpenSearch. "매일 넓게 집계하고 대시보드를 그린다" 면 ClickHouse. 셋을 함께 쓰는 조직도 흔하다(최근 7일은 Loki, 장기 분석은 ClickHouse).

## 로그 테이블 스키마

로그 줄마다 붙는 속성은 서비스마다 다르다. 모든 속성을 열로 만들 수는 없다. 흔한 패턴은 **자주 쓰는 것은 고정 열, 나머지는 Map**.

```sql
CREATE TABLE logs (
  ts            DateTime64(3) CODEC(Delta, ZSTD(1)),
  service       LowCardinality(String),
  level         LowCardinality(String),
  msg           LowCardinality(String),        -- 이벤트 이름 (종류가 적을 때)
  body          String CODEC(ZSTD(3)),          -- 사람이 읽는 메시지 원문
  trace_id      String,
  span_id       String,
  duration_ms   UInt32,
  status        UInt16,
  attrs         Map(LowCardinality(String), String),  -- 나머지 속성
  INDEX idx_trace trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_body  body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (service, level, msg, ts)
TTL toDateTime(ts) + INTERVAL 30 DAY;
```

- **LowCardinality** — service·level·msg 처럼 종류가 수천 이하인 문자열. 사전 인코딩으로 저장·필터가 몇 배 싸다([06 코덱](/clickhouse/notes/06-compression-codecs)).
- **Map** — `attrs['user_id']`, `attrs['http.route']` 로 읽는다. Map 의 값 하나를 읽어도 Map 전체 열을 읽으므로, 자주 쓰는 키는 고정 열이나 `MATERIALIZED` 열로 승격한다.

```sql
ALTER TABLE logs ADD COLUMN http_route LowCardinality(String) MATERIALIZED attrs['http.route'];
```

- **JSON 타입** — 최신 ClickHouse 의 `JSON` 타입은 경로마다 동적으로 열을 만들어 Map 보다 질의가 빠르다. 스키마가 자주 변하는 로그에 고려할 만하다.
- **TTL** — 원본은 30일, 집계는 [머티리얼라이즈드 뷰](/clickhouse/notes/04-materialized-views-aggregation) 로 1년.

## 트레이스 스팬 테이블

```sql
CREATE TABLE spans (
  ts           DateTime64(9),
  trace_id     String,
  span_id      String,
  parent_span_id String,
  service      LowCardinality(String),
  name         LowCardinality(String),
  kind         LowCardinality(String),
  duration_ns  UInt64,
  status_code  LowCardinality(String),
  attrs        Map(LowCardinality(String), String),
  INDEX idx_trace trace_id TYPE bloom_filter(0.001) GRANULARITY 1
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (service, name, toUnixTimestamp(ts), trace_id);

-- 엔드포인트별 지연 분포 (Tempo 로는 어려운 넓은 집계)
SELECT name, quantiles(0.5, 0.95, 0.99)(duration_ns / 1e6) ms, count()
FROM spans WHERE service = 'study-app' AND ts > now() - INTERVAL 1 DAY
GROUP BY name ORDER BY count() DESC LIMIT 20;

-- 트레이스 하나 펼치기 (trace_id 는 bloom_filter 로)
SELECT span_id, parent_span_id, name, duration_ns / 1e6 ms FROM spans WHERE trace_id = '…' ORDER BY ts;
```

[Tempo](/observability/notes/06-tracing-otel) 는 trace_id 로 한 트레이스를 찾는 데 최적화돼 있고 저장이 싸다. "모든 스팬에 대한 집계" 는 ClickHouse 가 강하다. 그래서 Tempo 의 metrics-generator 나 ClickHouse 같은 분석 저장소가 함께 쓰인다.

## OpenTelemetry Collector → ClickHouse

OTel Collector(contrib)에는 **clickhouseexporter** 가 있다. 로그·트레이스·메트릭 테이블을 자동으로 만들고 배치로 넣는다.

```yaml
exporters:
  clickhouse:
    endpoint: tcp://clickhouse:9000?dial_timeout=10s
    database: otel
    username: study
    password: study
    ttl: 720h
    logs_table_name: otel_logs
    traces_table_name: otel_traces
    create_schema: true
    timeout: 5s
    sending_queue: { queue_size: 1000 }
    retry_on_failure: { enabled: true }
service:
  pipelines:
    logs:   { receivers: [otlp], processors: [batch], exporters: [clickhouse] }
    traces: { receivers: [otlp], processors: [batch], exporters: [clickhouse] }
```

Grafana 에는 공식 ClickHouse 데이터 소스가 있고, 로그·트레이스 뷰(Explore)를 지원한다. 이 프로젝트의 Alloy(OTel 호환)에도 같은 exporter 를 붙일 수 있다.

## 적재 파이프라인

| 방법 | 특징 |
|---|---|
| OTel Collector exporter | 관측 데이터 표준 경로. 배치·재시도 내장 |
| Kafka 테이블 엔진 + MV | ClickHouse 가 Kafka 토픽을 직접 소비. `ENGINE = Kafka` 테이블 → MV → MergeTree |
| Vector·Fluent Bit | 파일·stdout 수집기에서 바로 |
| 클라이언트 배치 | 앱이 직접 1초 단위로 묶어 INSERT (async_insert 도 가능) |

```sql
CREATE TABLE logs_queue (line String)
ENGINE = Kafka SETTINGS kafka_broker_list = 'kafka:9092', kafka_topic_list = 'app-logs',
  kafka_group_name = 'ch-logs', kafka_format = 'JSONAsString';

CREATE MATERIALIZED VIEW logs_from_kafka TO logs AS
SELECT parseDateTime64BestEffort(JSONExtractString(line, 'ts')) ts,
       JSONExtractString(line, 'service') service,
       JSONExtractString(line, 'level') level,
       JSONExtractString(line, 'msg') msg, line body, …
FROM logs_queue;
```

Kafka 를 사이에 두면 ClickHouse 가 잠깐 멈춰도 데이터가 쌓여 기다린다([Kafka 개요](/kafka/notes/01-kafka-overview)).

## 자주 쓰는 질의 모음

```sql
-- 오류율 추이 (1분)
SELECT toStartOfMinute(ts) m, countIf(level = 'error') / count() err_rate
FROM logs WHERE service = 'study-app' AND ts > now() - INTERVAL 6 HOUR GROUP BY m ORDER BY m;

-- 새로 등장한 오류 메시지 (어제는 없고 오늘 있는)
SELECT msg, count() FROM logs WHERE level = 'error' AND toDate(ts) = today()
  AND msg NOT IN (SELECT DISTINCT msg FROM logs WHERE level = 'error' AND toDate(ts) = yesterday())
GROUP BY msg ORDER BY count() DESC;

-- 본문 단어 검색 (tokenbf 스킵 인덱스)
SELECT ts, service, body FROM logs WHERE hasToken(body, 'timeout') AND ts > now() - INTERVAL 1 HOUR LIMIT 50;

-- 로그 → 트레이스 조인
SELECT l.ts, l.body, s.name, s.duration_ns / 1e6 ms
FROM logs l INNER JOIN spans s ON l.trace_id = s.trace_id AND l.span_id = s.span_id
WHERE l.level = 'error' AND l.ts > now() - INTERVAL 15 MINUTE;
```

## 예시로 보기 — 이 프로젝트에서

이 앱의 `logs/app.jsonl` 한 줄은 이렇게 생겼다.

```json
{"subject":"redis","slug":"01-redis-overview","noteLevel":"기초","ts":"2026-10-16T16:46:50.721Z",
 "level":"info","msg":"note.view","service":"study-app","trace_id":"fb7e6e…","span_id":"3d0c50…"}
```

`msg` 가 이벤트 이름이고 `subject`·`slug` 같은 속성이 이벤트마다 달라진다. 위 스키마에 넣으면 `msg` 는 LowCardinality 열, `subject`·`slug` 는 `attrs` Map 이 된다. "주제별 노트 조회수 상위" 는 다음 한 줄이다.

```sql
SELECT attrs['subject'] subject, count() views FROM logs
WHERE msg = 'note.view' AND ts > now() - INTERVAL 7 DAY GROUP BY subject ORDER BY views DESC;
```

Loki 에서 같은 질문은 `sum by (subject) (count_over_time({service="study-app"} | json | msg="note.view" [7d]))` — 7일치 원문을 모두 풀어 파싱한다. 지금 규모(하루 수천 줄)에선 둘 다 순식간이지만, 로그가 하루 수억 줄이 되면 결과는 실험 표처럼 갈린다.

## 실습 체크리스트

- [ ] 실험 `ch-log-analytics` 를 돌리고 Grafana Explore 에서 `{source="ch-lab"}` 로 같은 LogQL 을 직접 실행해 보기
- [ ] 위 로그 스키마로 `logs/app.jsonl` 을 적재(`INSERT … FORMAT JSONEachRow`)하고 주제별 조회수 질의 실행
- [ ] `attrs` Map 의 키 하나를 MATERIALIZED 열로 승격하고 read_bytes 차이 재기
- [ ] Loki·OpenSearch·ClickHouse 중 우리 팀 로그에 맞는 것을 "질문 유형 · 데이터량 · 운영 인력" 기준으로 골라 보기
- [ ] OTel Collector 설정에 clickhouse exporter 를 붙이는 구성을 그려 보기 (Alloy 와 어디서 갈라지나)
