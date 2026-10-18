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

## 실전에서는 어디에 쓰이나

> 관측은 계측된 만큼만 보인다. 장애가 났는데 "그 지표가 없다" 를 막는 것이 exporter 와 앱 계측이고, 라벨을 잘못 설계하면 관측 시스템이 먼저 장애가 난다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 백오피스 DB 지연 | 커넥션 고갈인지 복제 지연인지 | postgres_exporter 의 커넥션 수·복제 지연·dead tuple | DB 콘솔에서 수동 조회 |
| Kafka 기반 주문 파이프라인 | 컨슈머가 밀리고 있나 | kafka_exporter 의 컨슈머 LAG 알림 | "주문 확인이 늦다" 는 고객 문의로 인지 |
| Node.js API 전체 지연 | 이벤트 루프가 막혔나 | prom-client `collectDefaultMetrics` 의 이벤트 루프 지연 | 일이 터진 뒤 프로파일러 붙이기 |
| 커머스 결제 퍼널 | 기술 지표는 정상인데 주문이 줄었다 | `checkout_completed_total` 같은 비즈니스 counter 를 대시보드에 | BI 리포트 — 하루 늦게 안다 |
| 신규 서비스 계측 | 언어·벤더가 바뀌어도 계측 코드 유지 | OpenTelemetry SDK 자동 계측 + OTLP | 벤더 전용 에이전트 — 교체 비용 |

**이럴 땐 안 맞는다**
- 요청마다 값이 다른 것(user_id, 실제 URL, request_id)을 라벨로 → 시계열이 폭발해 Prometheus 메모리가 터진다. 라벨은 route 템플릿까지, 식별자는 로그·트레이스로.
- 몇 초 만에 끝나는 배치 작업을 pull 로 → 스크레이프 전에 사라진다. Pushgateway 나 OTLP push 를 쓴다.

**누가 매일 만나나** — 백엔드는 새 엔드포인트와 비즈니스 이벤트에 메트릭을 심는다. 플랫폼 팀은 DB·캐시·메시지 큐 exporter 를 표준 배포 단위로 깔아 둔다.

**면접·실무 단골 질문**
- Q. 라벨에 무엇을 넣으면 안 되나? → 값의 종류가 무한한 것. 라벨 조합 수 = 시계열 수 = 메모리와 비용.

## 실습 체크리스트

- [ ] http://localhost:3000/api/metrics 를 열어 형식 읽기
- [ ] Prometheus 에서 `redis_commands_total` 의 라벨(cmd)을 보고 Redis 콘솔에서 명령을 치면 어떤 라벨이 늘어나는지 확인
- [ ] `/api/metrics` 에 메트릭 하나(예: 실험 실행 횟수 counter) 추가해 Grafana 패널 만들기
- [ ] node_exporter 를 compose 에 추가하고 호스트 CPU 를 그려 보기

## 관련 노트

- [Prometheus 와 PromQL](/observability/notes/02-prometheus-promql)
- [Nginx 로그와 stub_status](/nginx/notes/03-cache-tls-ratelimit)
- [PostgreSQL 운영·모니터링](/postgres/notes/05-operations)
