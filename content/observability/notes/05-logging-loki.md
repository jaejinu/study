---
title: 로그 — 구조화 로깅과 Loki·Alloy 파이프라인
order: 5
level: 중급
summary: 좋은 로그의 조건(구조화·상관관계·레벨·컨텍스트), 수집 경로(stdout → 수집기 → 저장소), Loki 의 라벨 모델과 LogQL, 이 프로젝트의 앱 로그가 Grafana 에 도달하기까지, 비용·보안·흔한 실수
tags: [로그, 구조화로깅, Loki, Alloy, LogQL, trace_id, 샘플링]
experiments: [loki-log-pipeline]
---

## 로그는 "무슨 일이 있었나" 의 증거

메트릭이 "에러율 2%" 라고 알려 주면, 로그는 **어떤 요청이 왜 실패했는지** 알려 준다. 그래서 로그는 양이 많고 비싸며, 설계 없이 쌓으면 아무도 못 읽는다.

좋은 로그 한 줄의 조건:

```json
{"ts":"2026-10-16T02:58:58.433Z","level":"info","msg":"note.view","service":"study-app",
 "trace_id":"ac85e4e3a2e1e748270ce252f37edaed","span_id":"ebcf53cdbfe6eeb7",
 "subject":"redis","slug":"06-pipelining"}
```

| 요소 | 왜 |
|---|---|
| **JSON 한 줄** | 기계가 파싱한다. 여러 줄 스택트레이스는 하나의 JSON 필드로 |
| `ts` ISO8601 (UTC) | 시간대 혼란 제거, 정렬 |
| `level` | 필터링·알림 기준 (debug/info/warn/error) |
| `msg` 는 **고정된 이벤트 이름** | `"note.view"` 처럼 검색 가능한 상수. "사용자 123 이 노트를 봤다" 같은 문장은 집계가 안 된다 |
| `service`, `env`, `version` | 어디서 난 로그인지 |
| **`trace_id`** | 같은 요청의 로그·트레이스를 한 줄로 꿰는 열쇠 |
| 맥락 필드 | user_id, order_id, 지연 ms, 에러 코드 — 사람이 디버깅할 때 바로 필요한 것 |

이 프로젝트의 `src/lib/log.ts` 가 이 형식으로 **stdout 과 `logs/app.jsonl`** 에 쓴다. `trace_id` 는 OpenTelemetry 의 현재 span 에서 가져온다. 서버 액션(실험 실행, 콘솔, 읽음 표시)과 노트 조회가 로그를 남긴다.

```ts
import { logger } from "@/lib/log";
logger.info("experiment.run", { subject: "redis", experiment: id, ok: r.ok, durationMs: r.durationMs });
logger.warn("console.exec", { cmd: "FLUSHALL", ok: false, error: "blocked" });
```

### 레벨 사용 규칙

- `error`: 사람이 봐야 하는 실패 (요청 실패, 외부 의존성 다운). 알림 대상.
- `warn`: 자동 복구됐지만 눈여겨볼 것 (재시도 성공, 느린 쿼리, 폴백).
- `info`: 비즈니스 이벤트 (주문 생성, 로그인, 실험 실행). 운영에서 기본 레벨.
- `debug`: 개발용. 운영에선 끄거나 샘플링.

`error` 를 남발하면 알림이 무의미해진다. "에러 로그 = 조치 필요" 를 지키자.

## 수집 경로

![LGTM 파이프라인](/diagrams/observability-pipeline.svg)

```
앱 ─ stdout ─▶ 컨테이너 런타임(json-file) ─▶ 수집기(Alloy/Promtail/Fluent Bit) ─▶ 저장소(Loki/Elasticsearch/CloudWatch) ─▶ Grafana
```

- **앱은 파일을 직접 관리하지 않는다.** 12-factor: stdout 으로만 쓰고, 수집·회전·전송은 플랫폼 몫.
- 컨테이너: Docker `json-file` 드라이버 → `/var/lib/docker/containers/*/*.log`. Kubernetes: kubelet 이 `/var/log/pods/` 에 둔다. 수집기 DaemonSet 이 이 디렉터리를 tail 한다.
- 호스트 프로세스(이 프로젝트의 `pnpm dev`)는 파일로 쓰고 수집기가 tail (`observability/config.alloy` 의 `loki.source.file`).

### Alloy 설정 읽기

```alloy
discovery.docker "containers" { host = "unix:///var/run/docker.sock" }     // 컨테이너 목록 발견
discovery.relabel "containers" {                                            // 라벨 가공
  rule { source_labels = ["__meta_docker_container_label_com_docker_compose_project"], regex = "study", action = "keep" }
  rule { source_labels = ["__meta_docker_container_name"], regex = "/(.*)", target_label = "container" }
}
loki.source.docker "containers" { targets = discovery.relabel.containers.output, forward_to = [loki.write.default.receiver] }

local.file_match "app" { path_targets = [{ __path__ = "/app-logs/*.jsonl", service = "study-app" }] }
loki.source.file "app" { targets = local.file_match.app.targets, forward_to = [loki.process.app.receiver] }
loki.process "app" {
  stage.json { expressions = { level = "level", trace_id = "trace_id" } }
  stage.labels { values = { level = "" } }                      // 라벨로 승격 (값이 적음)
  stage.structured_metadata { values = { trace_id = "" } }     // 고카디널리티는 구조화 메타데이터로
  forward_to = [loki.write.default.receiver]
}
loki.write "default" { endpoint { url = "http://loki:3100/loki/api/v1/push" } }
```

Alloy 는 Prometheus·Loki·Tempo 수집을 하나의 파이프라인 언어로 쓰는 범용 수집기다 (Promtail, Grafana Agent 의 후속). `http://localhost:12346` 에서 컴포넌트 그래프와 상태를 볼 수 있다.

## Loki 의 데이터 모델 — 라벨은 적게

Elasticsearch 는 모든 필드를 인덱싱하고(비싸고 강력), Loki 는 **라벨만 인덱싱**하고 본문은 압축해 둔다(싸고 grep). 그래서 Loki 에서 라벨 설계가 전부다.

- 좋은 라벨: `service`, `container`, `namespace`, `level`, `env` — 값이 수십 개 이하.
- 나쁜 라벨: `trace_id`, `user_id`, `request_path` — 스트림이 폭발해 쓰기·질의 모두 느려진다.
- 고카디널리티 값은 본문에 두고 질의 시 파싱(`| json`)하거나, Loki 3 의 **구조화 메타데이터**(인덱스 없이 필터 가능)로 붙인다.

```
{service="study-app", level="info"}   ← 스트림 (라벨 집합)
  → 청크 (압축된 로그 줄들, 시간 순)
```

## LogQL

```logql
{service="study-app"}                                   # 스트림 선택
{service="study-app"} |= "experiment.run"               # 문자열 포함 (grep)
{service="study-app"} | json | ok = "false"             # JSON 파싱 후 필드 필터
{service="study-app"} | json | durationMs > 1000        # 숫자 비교
{service="study-app"} | json | line_format "{{.subject}}/{{.experiment}} {{.durationMs}}ms"   # 표시 형식
{container=~"study-.*"} != "health"                      # 정규식 선택, 제외
{service="study-app"} | trace_id = "ac85e4e3a2e1e748270ce252f37edaed"   # 구조화 메타데이터 필터

# 메트릭 질의 — 로그에서 숫자를 뽑는다
sum by (level) (rate({service="study-app"}[1m]))                        # 레벨별 로그 속도
count_over_time({service="study-app"} | json | msg="experiment.run" [5m])
quantile_over_time(0.95, {service="study-app"} | json | unwrap durationMs [5m]) by (subject)   # 로그로 p95
```

마지막 두 줄이 중요하다: 메트릭을 따로 심지 않았어도 로그에서 **RED 지표를 뽑을 수 있다.** 단, 메트릭보다 느리고 비싸니 자주 보는 것은 메트릭으로 승격(레코딩 규칙 또는 코드 계측).

## 로그 ↔ 트레이스 연결

Grafana 데이터소스 설정(`observability/grafana/provisioning/datasources/prometheus.yml`):
- Loki `derivedFields`: 로그 줄의 `"trace_id":"…"` 를 정규식으로 찾아 **Tempo 링크** 버튼을 만든다.
- Tempo `tracesToLogsV2`: span 에서 "Logs for this span" → 같은 `service` 와 시간대의 Loki 로그로.

![트레이스와 로그](/diagrams/trace-anatomy.svg)

실습: Grafana Explore → Loki → `{service="study-app"} | json` → 아무 줄 펼치기 → trace_id 옆 **Tempo** 버튼 → 그 요청의 span 트리가 열린다.

## 비용과 보존

- 로그는 GB 당 과금이 보통이다. **샘플링**(debug 1%, 성공 요청 10%, 에러 100%)과 **보존 기간**(7~30일, 감사 로그는 별도 장기 보관)을 정한다.
- 접근 로그(Nginx) 는 양이 가장 많다. 상태코드 2xx 는 집계만 하고 원본은 짧게.
- 로그 양 자체를 메트릭으로 감시: `sum(rate({service=~".+"}[5m]))` 가 갑자기 뛰면 루프 버그.

## 보안과 PII

- 비밀번호·토큰·카드번호·주민번호는 **절대** 로그에 남기지 않는다. 로거 레벨에서 마스킹 (`authorization: ***`).
- 이메일·IP 같은 개인정보는 필요할 때만, 보존 짧게. 법적 요구(GDPR 삭제권)를 염두.
- 로그 저장소 접근 권한은 코드 접근과 별도로 관리.

## 흔한 실수

| 실수 | 결과 | 대신 |
|---|---|---|
| `console.log("user " + id + " did X")` | 파싱 불가, 집계 불가 | 이벤트 이름 + 필드 |
| 모든 요청을 info 로 전부 | 비용 폭발, 신호 묻힘 | 접근 로그는 Nginx/프록시에, 앱은 비즈니스 이벤트만 |
| trace_id 없음 | 요청 추적 불가 | OTel 컨텍스트에서 자동 주입 |
| 예외를 삼키고 로그만 | 알림 없음 | error 레벨 + 메트릭 카운터 |
| 다중 줄 스택트레이스 | 줄마다 다른 로그로 깨짐 | `stack` 필드에 문자열로 |
| 라벨에 user_id | Loki 스트림 폭발 | 본문/구조화 메타데이터 |

> 이어서 읽기: [데이터·관측 비용 — 볼륨 × 보존 × 카디널리티](/finops/notes/04-data-observability-cost) — 로그 볼륨·카디널리티가 곧 비용 · [집계와 로그 분석 — 검색 엔진이 분석 엔진이 되는 순간, 그리고 Loki 와의 선택](/opensearch/notes/04-aggregations-log-analysis) — 같은 로그를 OpenSearch 집계로 · [ClickHouse · OLAP](/clickhouse) — ClickHouse 로 로그 분석

## 실전에서는 어디에 쓰이나

> 메트릭이 "에러율 2%" 라고 알려 주면 로그는 "어떤 요청이 왜" 를 알려 준다. 장애 조사에서 결정적 증거가 나오는 곳이지만, 관측 신호 중 비용이 가장 빨리 커지는 곳이기도 하다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 "결제가 안 돼요" 특정 고객 문의 | 그 주문 요청에 무슨 일이 있었나 | `{service="payment"} \| json \| order_id="…"` → 줄의 trace_id 로 트레이스 열기 | 서버 ssh + grep — 로그가 여러 Pod 에 흩어져 있다 |
| SaaS 배포 직후 에러율 상승 | 새로 생긴 에러가 무엇인가 | `sum by (msg) (count_over_time({service="api", level="error"} \| json [5m]))` 로 이벤트별 집계 | 에러 로그를 위에서부터 읽기 |
| 핀테크 외부 PG 연동 지연 | 어느 외부 호출이 느려졌나 | `\| json \| durationMs > 3000` 필터, `unwrap durationMs` 로 p95 | 의존성별 메트릭이 있다면 그게 더 빠르다 |
| 로그 비용 급증 | 어느 서비스가 갑자기 많이 찍나(루프 버그) | `sum by (service) (rate({service=~".+"}[5m]))` 급증 알림 | 월말 청구서로 발견 |
| 금융·공공 개인정보 감사 | 토큰·주민번호가 로그에 남지 않게 | 로거 단계 마스킹, 저장소 접근 권한 분리, 짧은 보존 | 저장 후 사후 삭제 — 이미 복제됐을 수 있다 |

**이럴 땐 안 맞는다**
- 자주 보는 지표(요청 수·p95)를 매번 로그에서 계산 → 느리고 비싸다. 메트릭으로 승격한다.
- 필드 전문 검색·복잡한 집계가 핵심인 로그 분석 → Loki 는 라벨만 인덱싱한다. OpenSearch·Elasticsearch, 대용량 분석은 ClickHouse 가 맞다.
- trace_id·user_id 를 Loki 라벨로 → 스트림이 폭발한다. 본문이나 구조화 메타데이터로 둔다.

**누가 매일 만나나** — 백엔드는 이벤트 이름과 필드를 정해 로그를 남기고, 장애 때 LogQL 로 증거를 찾는다. 플랫폼 팀은 수집기 DaemonSet 과 보존·비용을, 보안 팀은 PII 마스킹과 접근 권한을 본다.

**면접·실무 단골 질문**
- Q. 로그 레벨을 어떻게 나누나? → error 는 사람이 조치해야 하는 실패(알림 대상), warn 은 자동 복구됐지만 주의, info 는 비즈니스 이벤트.
- Q. Loki 와 Elasticsearch 의 차이는? → 라벨만 인덱싱하고 본문은 grep(싸다) vs 모든 필드 인덱싱(비싸지만 검색이 강력).

## 실습 체크리스트

- [ ] `pnpm obs:up` 후 Grafana Explore → Loki → `{service="study-app"} | json` 에서 노트 조회·실험 실행 로그 보기
- [ ] `quantile_over_time(0.95, {service="study-app"} | json | unwrap durationMs [5m]) by (subject)` 로 실험 p95 그리기
- [ ] 로그 줄의 trace_id 로 Tempo 트레이스 열기
- [ ] `{container="study-redis"}` 로 Redis 컨테이너 로그 보기, `|= "Ready to accept"` 필터
- [ ] `src/lib/log.ts` 에 마스킹(예: `password` 필드 제거)을 추가해 보기
