---
title: "메시 관측 — 골든 시그널은 공짜, 트레이스는 반쯤 공짜"
order: 5
level: 중급
summary: "프록시가 모든 요청에서 자동으로 만드는 골든 시그널(성공률·RPS·지연 분포)과 메트릭의 레이블 구조(direction·tls·client_id·route), Prometheus·Grafana 로 모으는 방법과 카디널리티 비용, 서비스 간 의존 그래프(edges)·실시간 요청 보기(tap), 분산 트레이싱에서 프록시가 해 주는 것과 앱이 반드시 해야 하는 헤더 전파의 한계, SLO 와 번레이트 알림을 메시 메트릭으로 만드는 법"
tags: [골든 시그널, 프록시 메트릭, Prometheus, 분산 트레이싱, 헤더 전파, 카디널리티, SLO, linkerd-viz]
experiments: [mesh-retry-budget]
---

## 모든 요청이 지나는 곳에서 잰다

메시의 관측 가치는 단순하다: **모든 서비스 간 요청이 프록시를 지나므로, 앱이 계측하지 않아도 같은 형식의 메트릭이 나온다.** 언어가 다르고 팀이 달라도 성공률·지연의 정의가 같다.

| 골든 시그널 | 프록시 메트릭 | PromQL 예 |
|---|---|---|
| 요청량(RPS) | `request_total` | `sum(rate(request_total{direction="outbound"}[1m])) by (dst_service)` |
| 성공률 | `response_total{classification="success"}` | `sum(rate(response_total{classification="success"}[5m])) / sum(rate(response_total[5m]))` |
| 지연 | `response_latency_ms_bucket` | `histogram_quantile(0.99, sum(rate(response_latency_ms_bucket[5m])) by (le, dst_service))` |
| 연결 | `tcp_open_connections`, `tcp_open_total` | 연결 폭증·누수 감지 |

`classification` 은 프록시가 매긴다: HTTP 5xx·gRPC 오류 상태는 `failure`. 앱이 200 으로 감싼 오류는 성공으로 잡힌다 — 오류를 상태 코드로 표현하는 API 설계([API 설계 01](/api-design/notes/01-rest-principles))가 메시 관측의 전제다.

## 레이블 — 같은 메트릭, 두 시점

```
request_total{direction="inbound",  target_port="80", tls="true", client_id="client-meshed.…"} 10
request_total{direction="outbound", dst_service="web", tls="true", …} 60
```

- **outbound**(클라이언트 프록시): "내가 web 을 몇 번 불렀고 몇 번 성공했나" — 호출자 관점. **재시도 후의 최종 결과**가 잡힌다.
- **inbound**(서버 프록시): "누가 나를 불렀나" — 서버 관점, 재시도 하나하나가 따로 잡힌다.

그래서 재시도를 켜면 두 숫자가 갈린다. 실험 `mesh-retry-budget` 에서 클라이언트는 60/60 성공을 봤지만, 고장 Pod 의 서버 프록시는 수십 번의 503 을 기록했다. **사용자 경험은 outbound 성공률, 서버 건강은 inbound 성공률**로 본다. 둘의 차이가 곧 "재시도가 숨기고 있는 고장" 이다.

## 의존 그래프와 실시간 요청

`linkerd-viz` 확장(Prometheus + 대시보드)을 깔면:

```bash
linkerd viz install | kubectl apply -f -
linkerd viz stat deploy -n mesh-lab-retry          # 성공률·RPS·p50/p95/p99 표
linkerd viz edges deploy -n mesh-lab-mtls          # 누가 누구를 mTLS 로 부르나 (SRC → DST, SECURED)
linkerd viz tap deploy/web -n mesh-lab-retry       # 지나가는 요청을 실시간으로 (경로·상태·지연)
linkerd viz top deploy/web                          # 경로별 상위 요청
```

`tap` 은 디버깅에 강력하지만 **요청 경로·헤더가 보이는** 기능이라 RBAC 로 막아야 한다([보안 06](/security/notes/06-kubernetes-security)).

이 클러스터에는 viz 를 깔지 않았다. 이미 kube-prometheus-stack(`kps`)이 있으므로, 프록시의 `:4191/metrics` 를 그 Prometheus 가 긁도록 `PodMonitor` 하나를 두는 편이 자원이 적다([쿠버네티스 10](/kubernetes/notes/10-monitoring-stack)). 실험에서는 대신 `linkerd diagnostics proxy-metrics` 로 프록시 메트릭을 직접 읽었다.

## 카디널리티 — 메시 메트릭의 비용

프록시 메트릭은 레이블이 많다: 출발·목적지 서비스, Pod, 경로, 상태 코드, tls, client_id… Pod 1000개의 메시라면 활성 시계열이 수십만이 된다.

| 줄이는 법 | 예 |
|---|---|
| 필요 없는 레이블 드롭 | `metric_relabel_configs` 로 `target_addr`·`target_ip` 제거 |
| 사전 집계 | 레코딩 룰로 서비스 단위 성공률만 남기기([관측성 11](/observability/notes/11-slo-dashboard-burn-rate)) |
| 짧은 보존 | 원시는 수 시간, 집계는 길게 |
| 경로 레이블 제한 | HTTPRoute 이름 단위로, 원시 URL 금지 |

비용 모델은 [FinOps 04](/finops/notes/04-data-observability-cost)의 "활성 시계열 × 보존" 이 그대로 적용된다.

## 분산 트레이싱 — 프록시가 못 하는 것

프록시는 요청마다 스팬을 만들 수 있다(Linkerd 는 `proxy.tracing` 설정, Istio 는 Envoy 트레이싱). 하지만 **트레이스를 잇는 일**은 프록시가 할 수 없다.

```
요청 → [프록시 A 스팬] → 앱 A ──(새 요청: 어떤 들어온 요청 때문인지 프록시는 모른다)──▶ [프록시 A 스팬] → B
```

프록시 입장에서 앱 A 가 내보내는 요청은 **새 연결의 새 요청**이다. 들어온 요청과 나가는 요청을 연결하려면 앱이 `traceparent` 헤더를 읽어 나가는 요청에 다시 붙여야 한다. 그래서:

- 앱에 OpenTelemetry SDK(자동 계측)를 넣어 헤더를 전파한다([관측성 06](/observability/notes/06-tracing-otel)). 이 사이트는 `@vercel/otel` 로 이미 하고 있다.
- 메시는 그 위에 **프록시 구간의 시간**(TLS·대기·재시도)을 스팬으로 더해 준다.

"메시를 깔면 트레이싱이 공짜" 는 반만 맞다: 골든 시그널은 공짜, 트레이스는 앱 계측이 있어야 한다.

## 메시 메트릭으로 SLO 만들기

메시 메트릭은 서비스마다 같은 형식이라 SLO 를 템플릿으로 찍어낼 수 있다([SRE 02](/sre/notes/02-sli-slo-error-budget)).

```yaml
# 레코딩 룰: 서비스별 5분 성공률 (outbound = 사용자 관점)
- record: service:mesh_success:ratio_rate5m
  expr: |
    sum by (dst_service) (rate(response_total{direction="outbound", classification="success"}[5m]))
    /
    sum by (dst_service) (rate(response_total{direction="outbound"}[5m]))
# 번레이트 알림: 99.9% SLO 의 1시간 창 14.4배 소진
- alert: MeshServiceBurnRateHigh
  expr: (1 - service:mesh_success:ratio_rate1h) / 0.001 > 14.4
```

그리고 같은 지표로 카나리를 자동 판정한다 — [노트 06](/service-mesh/notes/06-canary-traffic-split)·[SRE 07](/sre/notes/07-slo-driven-automation).

## 예시로 보기 — 이 프로젝트에서

실험 `mesh-retry-budget` 의 "정책 없음" 단계에서, 클라이언트가 본 실패는 20/60(33%) 이었다. 재시도를 켜면 클라이언트 실패는 0 이 되지만, 같은 시간 고장 Pod 의 서버 프록시는 503 을 계속 기록한다. 이 차이를 대시보드에 나란히 두면 "사용자는 괜찮지만 Pod 하나가 고장" 이라는 상태를 알림 없이도 볼 수 있다. 알림은 사용자 관점(outbound)으로, 원인 파악은 서버 관점(inbound)으로.

## 대시보드 레이아웃 제안

서비스 하나의 메시 대시보드를 위에서 아래로 읽게 만든다.

| 행 | 패널 | 질문 |
|---|---|---|
| 1 | 성공률(outbound) · RPS · p99 | 사용자는 괜찮은가 |
| 2 | 성공률(inbound, Pod 별) | 어느 Pod 가 아픈가 — 재시도가 숨긴 고장 |
| 3 | 지연 분포 히트맵 | 꼬리가 늘었나, 전체가 늘었나 |
| 4 | 상위 호출자(client_id) · 상위 목적지(dst_service) | 누가 부르고, 누구를 부르나 |
| 5 | TLS 비율(tls="true") | 메시 밖 호출이 남아 있나 |
| 6 | 연결 수 · 재시도 수 | 연결 폭증, 재시도 폭풍 |

## 장애 때 읽는 순서

1. **outbound 성공률이 떨어졌나?** 아니면 사용자 영향은 없다 — 원인 조사는 급하지 않다.
2. **어느 목적지가?** `dst_service` 별로 나눠 범인을 좁힌다.
3. **그 목적지의 어느 Pod 가?** inbound 성공률을 Pod 별로. 특정 Pod 만이면 노드·배포 문제.
4. **지연인가 오류인가?** 지연이 먼저 오르고 오류가 뒤따르면 포화(큐잉), 오류만이면 버그·의존성.
5. **언제부터?** 배포·설정 변경 시각과 겹치는지([SRE 06](/sre/notes/06-capacity-release-change)).

## 로그와 트레이스로 이어 가기

메시 메트릭으로 "어느 서비스·Pod·시각" 을 찾았다면, 그다음은 앱 로그와 트레이스다. 프록시 로그에는 요청 단위 정보가 거의 없으므로(기본 warn 레벨), **같은 시간 범위의 앱 로그를 trace_id 로** 찾는다([관측성 05](/observability/notes/05-logging-loki)). 메시는 "어디서" 를, 앱 계측은 "왜" 를 알려 준다.

> 이어서 읽기: [카나리와 트래픽 분할 — 메트릭으로 자동 판정](/service-mesh/notes/06-canary-traffic-split) · [메시 비교와 운영 — 장애 모드](/service-mesh/notes/07-mesh-comparison-ops)

## 실습 체크리스트

- [ ] `linkerd diagnostics proxy-metrics` 출력에서 inbound/outbound 의 `request_total` 을 각각 찾기
- [ ] 재시도를 켠 상태에서 outbound 성공률과 고장 Pod 의 inbound 실패 수를 비교
- [ ] kps Prometheus 가 프록시 메트릭을 긁도록 PodMonitor 를 설계(포트 `linkerd-admin`, 경로 `/metrics`)
- [ ] 메시 Pod 1000개일 때 `response_latency_ms_bucket` 의 시계열 수를 대략 계산
- [ ] 이 사이트의 OTel 트레이스에서 앱이 헤더를 전파하는 지점을 찾아보기
