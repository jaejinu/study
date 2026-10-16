---
title: 분산 트레이싱 — OpenTelemetry 와 Tempo
order: 6
level: 중급
summary: span·trace·컨텍스트 전파의 원리, OpenTelemetry SDK·자동 계측·Collector, 이 앱의 Next.js 계측 코드 해부, TraceQL, 트레이스에서 메트릭 만들기(span metrics), 샘플링 전략
tags: [트레이싱, OpenTelemetry, span, 컨텍스트전파, Tempo, TraceQL, 샘플링]
experiments: []
---

## 왜 트레이스인가

마이크로서비스에서 "결제 API 가 느리다" 는 메트릭은 **어느 서비스의 어느 호출** 때문인지 말해 주지 않는다. 트레이스는 요청 하나가 거쳐 간 모든 작업을 **시간 순·계층 구조**로 보여준다.

![트레이스 해부](/diagrams/trace-anatomy.svg)

- **Trace**: 요청 하나의 전체 여정. 16바이트 `trace_id`.
- **Span**: 작업 하나(HTTP 핸들러, DB 쿼리, 외부 호출). `span_id`, 부모 `span_id`, 시작/종료 시각, 속성(attributes), 이벤트, 상태.
- **컨텍스트 전파**: 서비스 간 호출 시 `traceparent` 헤더(W3C)로 trace_id 를 넘겨 span 이 이어진다. 메시지 큐에서는 메시지 헤더에.

```
traceparent: 00-ac85e4e3a2e1e748270ce252f37edaed-ebcf53cdbfe6eeb7-01
             ver-trace_id-----------------------------parent_span_id---flags(샘플링)
```

## OpenTelemetry (OTel)

벤더 중립 표준. **API**(코드에서 쓰는 인터페이스) + **SDK**(수집·배치·내보내기) + **자동 계측**(HTTP, ioredis, pg, kafkajs 등 라이브러리 후킹) + **OTLP**(전송 프로토콜) + **Collector**(수신·가공·라우팅 프로세스).

```
앱(SDK + 자동 계측) ──OTLP──▶ Collector(선택) ──▶ Tempo / Jaeger / Datadog / Honeycomb
```

Collector 를 두면 앱 설정 변경 없이 백엔드를 바꾸고, 샘플링·필터·배치를 중앙에서 한다. 이 프로젝트는 단순하게 앱 → Tempo 직접 전송.

## 이 앱의 계측 코드

`src/instrumentation.ts` — Next.js 가 서버 시작 시 호출한다.

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerOTel, OTLPHttpJsonTraceExporter } = await import("@vercel/otel");
  const { IORedisInstrumentation } = await import("@opentelemetry/instrumentation-ioredis");
  const { PgInstrumentation } = await import("@opentelemetry/instrumentation-pg");
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;      // http://localhost:14318
  registerOTel({
    serviceName: "study-app",
    traceExporter: endpoint ? new OTLPHttpJsonTraceExporter({ url: `${endpoint}/v1/traces` }) : undefined,
    instrumentations: [new IORedisInstrumentation(), new PgInstrumentation()],
  });
}
```

- `@vercel/otel` 이 Next.js 의 라우팅·렌더링 span(`GET /[subject]/notes/[slug]`, `render route`, `resolve page components`) 을 만든다.
- `IORedisInstrumentation` 이 모든 Redis 명령을 자식 span 으로 (`smembers`, `hgetall` …), `PgInstrumentation` 이 SQL 을.
- 로거는 `trace.getActiveSpan()` 으로 현재 span 의 id 를 로그에 넣는다 (`src/lib/log.ts`).

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm dev     # Tempo 로 내보내기
curl -s localhost:3000/redis/notes/06-pipelining > /dev/null
curl -s -G http://127.0.0.1:13200/api/search --data-urlencode 'q={ resource.service.name="study-app" }' | jq '.traces[0]'
```

### 수동 span 추가

자동 계측이 못 보는 비즈니스 로직은 직접 감싼다.

```ts
import { trace, SpanStatusCode } from "@opentelemetry/api";
const tracer = trace.getTracer("study");
await tracer.startActiveSpan("experiment.run", { attributes: { "study.experiment": id } }, async (span) => {
  try {
    return await runExperiment(id);
  } catch (e) {
    span.recordException(e as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw e;
  } finally {
    span.end();
  }
});
```

속성 이름은 **시맨틱 컨벤션**(`http.request.method`, `db.system`, `messaging.system`)을 따르면 백엔드가 자동으로 이해한다. 자체 속성은 접두어(`study.*`)로.

## Tempo 와 TraceQL

Tempo 는 트레이스를 오브젝트 스토리지(로컬 디스크)에 저장하고 **trace_id 조회**와 **TraceQL** 검색을 제공한다. 인덱스가 작아 저렴하다.

```traceql
{ resource.service.name = "study-app" }                                  # 서비스
{ resource.service.name = "study-app" && duration > 200ms }              # 느린 요청
{ span.db.system = "redis" && duration > 5ms }                           # 느린 Redis 호출
{ name =~ "GET .*" && status = error }                                   # 실패한 요청
{ resource.service.name = "study-app" } >> { span.db.statement =~ ".*SMEMBERS.*" }   # 구조: 자손에 SMEMBERS 가 있는 트레이스
{ span.http.response.status_code >= 500 } | count() > 0
```

Grafana Explore → Tempo → Search 탭에서 같은 조건을 UI 로 조합할 수 있다.

## 트레이스에서 메트릭 뽑기 — span metrics

`observability/tempo.yaml` 의 `metrics_generator` 가 모든 span 을 집계해 Prometheus 로 **remote write** 한다.

```promql
sum by (span_name) (rate(traces_spanmetrics_calls_total{service="study-app", span_kind="SPAN_KIND_SERVER"}[5m]))        # 라우트별 RPS
histogram_quantile(0.95, sum by (le, span_name) (rate(traces_spanmetrics_latency_bucket{service="study-app"}[5m])))    # 라우트별 p95
sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[5m])) / sum(rate(traces_spanmetrics_calls_total[5m]))
traces_service_graph_request_total                                                                                          # 서비스 그래프 (A→B 호출 수)
```

계측 코드를 한 줄도 더 쓰지 않고 **RED 대시보드와 서비스 맵**을 얻는다. Grafana 대시보드 아래 두 패널이 이 값을 그린다. Prometheus 는 `--web.enable-remote-write-receiver` 로 띄워야 한다 (compose 에 설정됨).

**Exemplar**: 히스토그램 버킷에 "이 샘플의 trace_id" 를 붙인다. Grafana 에서 p99 그래프의 점을 클릭해 그 느린 요청의 트레이스로 바로 간다 (`--enable-feature=exemplar-storage`).

## 샘플링

전체 트레이스를 저장하면 트래픽이 큰 서비스에선 감당이 안 된다.

| 방식 | 어디서 | 장단점 |
|---|---|---|
| Head 샘플링 (확률) | SDK, 요청 시작 시 | 단순. 에러·느린 요청이 버려질 수 있음 |
| Tail 샘플링 | Collector, 트레이스 완료 후 | 에러/느린 것 100%, 정상 1% 같은 정책. Collector 메모리 필요 |
| 레이트 리밋 | SDK/Collector | 초당 N 트레이스 |

보통 개발은 100%, 운영은 tail 샘플링(에러·p99 전부 + 정상 5~10%). span metrics 는 샘플링 **전** 데이터로 만들면 정확하다 (Collector 의 spanmetrics connector).

## 트레이싱이 밝히는 전형적 문제

- **N+1**: 한 요청에 같은 DB span 이 100개 — 트레이스에서 한눈에 보인다.
- **직렬 대기**: 독립적인 외부 호출을 순차로 — 폭포수 모양. `Promise.all` 로.
- **재시도 폭풍**: 같은 span 이 백오프 없이 반복.
- **느린 의존성**: 전체 지연의 대부분이 한 자식 span.
- **컨텍스트 끊김**: 큐 소비자에서 새 trace 가 시작 — 메시지 헤더로 전파 필요 (kafkajs 는 `headers.traceparent`).

## 더 보기

- OTel 자동 계측 목록: `@opentelemetry/auto-instrumentations-node` (HTTP, Express, gRPC, MySQL, MongoDB, kafkajs, AWS SDK…)
- Collector 파이프라인: receivers(otlp) → processors(batch, tail_sampling, attributes) → exporters(tempo, prometheus, loki)
- Jaeger (오픈소스 트레이스 백엔드), Zipkin (원조), 상용: Datadog APM, Honeycomb, Lightstep
- "Distributed Tracing in Practice" (Parker 외)

## 실습 체크리스트

- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm dev` 로 띄우고 노트 페이지를 연 뒤 Grafana → Tempo 에서 트레이스 열기
- [ ] 트레이스 안의 ioredis span 을 찾아 어떤 명령이 몇 ms 걸렸는지 읽기
- [ ] Redis 실험실에서 "Pipeline" 실험을 돌리고 그 요청 트레이스에서 1000개 SET 이 어떻게 보이는지 보기 (span 수!)
- [ ] `{ span.db.system = "redis" && duration > 2ms }` TraceQL 실행
- [ ] 대시보드의 span-metrics 패널(p95, RPS)이 트래픽에 따라 움직이는지 확인
- [ ] 서버 액션 하나에 수동 span 과 속성을 추가해 보기
