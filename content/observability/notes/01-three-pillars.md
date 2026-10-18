---
title: 관측성의 세 기둥 — 메트릭·로그·트레이스
order: 1
level: 기초
summary: 모니터링과 관측성의 차이, 메트릭/로그/트레이스의 역할과 비용, RED·USE·골든 시그널, 이 프로젝트의 스택
tags: [관측성, 메트릭, 로그, 트레이스, 골든시그널]
experiments: []
---

## 모니터링 vs 관측성

- **모니터링**: 미리 정한 지표를 보고 임계값을 넘으면 알린다 ("CPU 90%").
- **관측성**: 시스템이 내보내는 데이터만으로 **예상 못 한 질문**에 답할 수 있는 성질 ("왜 특정 사용자만 느린가?").

세 종류의 신호를 조합해야 질문에 답할 수 있다.

| 신호 | 무엇 | 장점 | 비용 |
|---|---|---|---|
| **메트릭** | 숫자 시계열 (요청 수, 지연 p99, 메모리) | 싸다, 집계·알림에 최적 | 고카디널리티(사용자 ID 라벨)에 취약 |
| **로그** | 이벤트 텍스트/JSON | 상세 맥락 | 양이 많고 비싸다, 검색 느림 |
| **트레이스** | 요청 하나가 거친 서비스·함수의 span 트리 | 분산 시스템의 "어디서 느린가" | 샘플링 필요, 계측 노력 |

연결 고리: 트레이스 ID 를 로그에 넣고, 메트릭 exemplar 에 트레이스 ID 를 달면 세 신호를 오갈 수 있다.

## 무엇을 재야 하나

**골든 시그널** (Google SRE): Latency, Traffic, Errors, Saturation.
**RED** (요청 처리 서비스): Rate, Errors, Duration.
**USE** (자원): Utilization, Saturation, Errors — CPU, 메모리, 디스크, 네트워크, 커넥션 풀.

"평균 지연" 은 쓸모가 적다. **p50/p95/p99** 를 본다. 1% 의 느린 요청이 사용자의 불만 대부분을 만든다.

## 카디널리티

메트릭 라벨의 고유 조합 수 = 시계열 수. `user_id`, `request_id`, 전체 URL 을 라벨로 넣으면 시계열이 폭발해 Prometheus 가 죽는다. 라벨은 **유한하고 작은 집합**(status, method, route 템플릿)만. 개별 식별자는 로그/트레이스로.

## 이 프로젝트의 스택

```
Redis ──▶ redis_exporter ──┐
                           ├──▶ Prometheus (수집·저장·PromQL·알림 규칙) ──▶ Grafana (대시보드)
Study 앱 /api/metrics ─────┘
```

```bash
pnpm obs:up               # Prometheus :19090, Grafana :13000 (익명 Admin), redis_exporter
open http://localhost:19090/targets
open http://localhost:13000/d/study-redis
pnpm obs:down
```

```
Redis ──▶ redis_exporter ──┐
                           ├──▶ Prometheus (메트릭) ─┐
Study 앱 /api/metrics ─────┘                        │
Study 앱 logs/app.jsonl ──▶ Alloy ──▶ Loki (로그) ───┼──▶ Grafana (:13000)
컨테이너 stdout ──────────▶ Alloy ──┘                │
Study 앱 OTel SDK ──OTLP──▶ Tempo (트레이스) ────────┘
```

![LGTM 파이프라인](/diagrams/observability-pipeline.svg)

세 신호 모두 로컬에서 돈다. 앱 트레이스는 `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm dev` 로 켠다. [로그 노트](/observability/notes/05-logging-loki), [트레이싱 노트](/observability/notes/06-tracing-otel) 참고.

## 설계 원칙

1. 대시보드보다 **알림**을 먼저 설계한다. 알림은 "사용자가 아픈 증상"(에러율, 지연)에, 원인(CPU)은 대시보드에.
2. 모든 서비스가 같은 라벨 규칙(`service`, `env`, `version`)을 쓴다.
3. 메트릭 이름은 `<namespace>_<subsystem>_<name>_<unit>` 예 `http_server_request_duration_seconds`.
4. 계측은 라이브러리로 자동화(OpenTelemetry), 비즈니스 지표만 수동.

## 실전에서는 어디에 쓰이나 — 관측성 지도

> 관측성은 "사용자보다 먼저 장애를 알고(알림), 어디가 아픈지 좁히고(메트릭·트레이스), 왜 그런지 증거를 찾는(로그·프로파일)" 일을 위한 도구 체계다. 실제 장애 대응은 신호를 이 순서로 오간다: 알림 → 대시보드 → 트레이스 → 로그 → 프로파일.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 새벽에 "결제 에러율 3%" 알림이 울렸다 | 증상 기반 규칙, Alertmanager 라우팅·억제, 런북 | [알림 파이프라인](/observability/notes/09-alerting-pipeline) |
| "지금 괜찮은가, 얼마나 빨리 나빠지나" 를 한 화면에 | SLI 레코딩 룰, 에러 버짓, 다중 윈도우 번레이트 | [SLO 대시보드](/observability/notes/11-slo-dashboard-burn-rate) |
| 에러율·p99 가 언제부터 튀었나 | counter 의 `rate()`, `histogram_quantile` | [Prometheus 와 PromQL](/observability/notes/02-prometheus-promql) |
| "특정 주문만 결제가 안 된다" 는 고객 문의 | JSON 로그의 order_id·trace_id, LogQL `\| json` 필터 | [로그와 Loki](/observability/notes/05-logging-loki) |
| 마이크로서비스에서 "어느 서비스 때문에 느린가" | span 폭포수, TraceQL, span metrics | [분산 트레이싱](/observability/notes/06-tracing-otel) |
| 배포 뒤 에러는 없는데 CPU 만 올랐다 | flame graph, 배포 전후 diff flame graph | [연속 프로파일링](/observability/notes/10-continuous-profiling) |
| Pod 재시작·OOM·Pending 이 쌓인다 | kube-state-metrics, cAdvisor, 이벤트 수집 | [Kubernetes 관측](/observability/notes/07-kubernetes-observability) |
| LLM 챗봇 비용 급증·답변 품질 하락 | 토큰·TTFT·비용 메트릭, GenAI span, 평가 루프 | [LLM 관측](/observability/notes/08-llm-observability) |

**회사 규모에 따라**
- 스타트업: 관리형 관측 SaaS 하나 또는 Prometheus + Grafana 단일 구성으로 시작한다. 가용성·에러율 알림 몇 개와 JSON 로그가 우선이다.
- 성장기: OpenTelemetry 로 계측을 표준화하고, 로그·트레이스 백엔드(Loki·Tempo 등)를 붙이고, SLO 와 온콜 로테이션을 도입한다. 이때부터 관측 비용이 청구서에서 눈에 띈다.
- 대규모 조직: 관측 플랫폼 팀이 수집 파이프라인(Collector·샘플링·카디널리티 제한)과 멀티 클러스터 장기 저장을 운영하고, 팀별 SLO 와 관측 비용 배분까지 관리한다.

**이럴 땐 안 맞는다**
- "일단 다 모아 두면 언젠가 쓴다" → 볼륨·보존·카디널리티가 곧 비용이다. 알림·SLO 같은 질문부터 정하고 필요한 신호만 모은다 ([관측 비용](/finops/notes/04-data-observability-cost)).
- 대시보드만 많고 알림·런북이 없다 → 아무도 안 보는 화면이 된다. 증상 기반 알림 몇 개가 대시보드 수십 개보다 장애를 빨리 잡는다.

**누가 매일 만나나** — 온콜 SRE 는 알림을 받아 대시보드 → 트레이스 → 로그 순으로 원인을 좁힌다. 백엔드 개발자는 배포 직후 RED 지표를 확인하고 코드에 메트릭·로그 필드를 심는다. 플랫폼 팀은 수집 파이프라인과 비용을, ML 엔지니어는 LLM 토큰·품질 지표를 본다.

## 관련 노트

- [Redis 메모리와 성능 진단](/redis/notes/12-memory-performance) — INFO·SLOWLOG 가 exporter 메트릭의 원천
- [Kubernetes 운영과 디버깅](/kubernetes/notes/08-ops-debugging) — 관측 스택을 어디에 두는가
- [Linux 네트워크 진단 도구](/linux-network/notes/05-tools)

> 네 번째 신호: [연속 프로파일링](/observability/notes/10-continuous-profiling)
