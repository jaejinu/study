---
title: 계측 — exporter 와 애플리케이션 메트릭
order: 3
level: 중급
summary: exporter 가 하는 일, 앱에 메트릭 심기(OpenTelemetry/prom-client), 무엇을 라벨로 둘지, 이 앱의 /api/metrics 해부
tags: [exporter, OpenTelemetry, prom-client, 계측, 라벨]
experiments: []
---

## Exporter

Prometheus 형식을 모르는 시스템(Redis, PostgreSQL, Nginx, 리눅스 호스트) 옆에 붙어 그 시스템의 상태를 **메트릭으로 번역**하는 작은 프로세스.

| 대상 | exporter | 주요 메트릭 |
|---|---|---|
| Redis | `redis_exporter` | `redis_commands_processed_total`, `redis_memory_used_bytes`, `redis_connected_clients`, `redis_keyspace_hits_total` |
| PostgreSQL | `postgres_exporter` | 커넥션, 트랜잭션, dead tuple, 복제 지연 |
| 호스트 | `node_exporter` | CPU, 메모리, 디스크, 네트워크 |
| Nginx | `nginx-prometheus-exporter` (stub_status) | 연결 수, 요청 수 |
| Kafka | `kafka_exporter` | 파티션 오프셋, 컨슈머 LAG |
| Kubernetes | `kube-state-metrics`, cAdvisor(kubelet) | Pod 상태, 컨테이너 자원 |

이 프로젝트: `redis_exporter` 가 `INFO` 를 긁어 `:9121/metrics` 로 노출 → Prometheus 가 5초마다 수집. Redis 의 **모니터** 페이지가 보여주던 것과 같은 정보가 시계열로 쌓인다.

## 앱 메트릭 심기

Node.js 라면 `prom-client`:

```ts
import client from "prom-client";
client.collectDefaultMetrics();                     // 프로세스 CPU/메모리/이벤트루프 지연
const httpDuration = new client.Histogram({
  name: "http_server_request_duration_seconds",
  help: "HTTP 요청 처리 시간",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});
// 미들웨어에서
const end = httpDuration.startTimer({ method, route });
res.on("finish", () => end({ status: String(res.statusCode) }));
// 노출
app.get("/metrics", async (_, res) => res.type(client.register.contentType).send(await client.register.metrics()));
```

**OpenTelemetry** 는 메트릭·로그·트레이스를 한 SDK 로 계측하고 OTLP 로 Collector 에 보내는 표준. 벤더 중립이라 새 프로젝트의 기본값으로 좋다. 자동 계측(HTTP, pg, ioredis, kafkajs)이 풍부하다.

## 이 앱의 `/api/metrics`

`src/app/api/metrics/route.ts` 는 의존성 없이 텍스트를 직접 만든다:

```
process_uptime_seconds            gauge
process_resident_memory_bytes     gauge
study_notes_total{subject="redis"} gauge   주제별 노트 수
study_redis_up                     gauge
study_progress_read_total{subject} gauge   읽은 노트 수 (Redis 의 progress:read 에서)
study_progress_lab_total{subject}  gauge   성공한 실험 수
```

비즈니스 지표("오늘 읽은 노트 수")도 메트릭이 될 수 있다는 예. Grafana 대시보드 아래 두 패널이 이 값을 그린다.

## 라벨 설계

- 좋은 라벨: `method`, `status`, `route`(템플릿 `/users/:id`), `service`, `env`.
- 나쁜 라벨: `user_id`, `url`(실제 경로), `request_id`, 자유 텍스트 → 카디널리티 폭발.
- 히스토그램 버킷은 **기대 지연 범위에 맞게** (ms 단위 서비스에 초 단위 버킷은 무의미).
- 메트릭 이름에 단위를 (`_seconds`, `_bytes`, `_total`).

## 로그와 트레이스 계측

- 로그: **구조화(JSON)** 로 쓰고 `trace_id`, `span_id`, `service` 필드를 넣는다. stdout 으로만 쓰면 컨테이너 런타임이 수집한다 (Promtail/Fluent Bit → Loki/ES).
- 트레이스: OpenTelemetry 자동 계측 + 컨텍스트 전파(W3C `traceparent` 헤더). 샘플링(1~10%)으로 비용 제어. 저장은 Tempo/Jaeger.
- Grafana 에서 로그의 trace_id 클릭 → 트레이스, 트레이스에서 → 관련 로그/메트릭으로 이동하도록 데이터소스를 연결한다.

## 실습 체크리스트

- [ ] http://localhost:3000/api/metrics 를 열어 형식 읽기
- [ ] Prometheus 에서 `redis_commands_total` 의 라벨(cmd)을 보고 Redis 콘솔에서 명령을 치면 어떤 라벨이 늘어나는지 확인
- [ ] `/api/metrics` 에 메트릭 하나(예: 실험 실행 횟수 counter) 추가해 Grafana 패널 만들기
- [ ] node_exporter 를 compose 에 추가하고 호스트 CPU 를 그려 보기

## 관련 노트

- [Prometheus 와 PromQL](/observability/notes/02-prometheus-promql)
- [Nginx 로그와 stub_status](/nginx/notes/03-cache-tls-ratelimit)
- [PostgreSQL 운영·모니터링](/postgres/notes/05-operations)
