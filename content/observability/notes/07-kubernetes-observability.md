---
title: Kubernetes 에서의 관측 — 수집 아키텍처와 무엇을 볼 것인가
order: 7
level: 심화
summary: 클러스터 안 신호의 출처(kubelet·cAdvisor·kube-state-metrics·API 서버 감사·이벤트), DaemonSet 수집기와 Operator 패턴, 네임스페이스·워크로드 단위 대시보드 설계, 알림 계층, 비용. kube-prometheus-stack 설치는 Kubernetes 노트 10 과 짝
tags: [Kubernetes, kube-state-metrics, cAdvisor, DaemonSet, Operator, 이벤트, 알림계층]
experiments: []
---

## 신호의 출처

| 신호 | 출처 | 수집 방법 |
|---|---|---|
| 컨테이너 CPU·메모리·네트워크·FS | kubelet 내장 **cAdvisor** (`/metrics/cadvisor`) | Prometheus 가 kubelet 스크레이프 |
| 노드 OS 지표 | **node-exporter** DaemonSet | 스크레이프 |
| 오브젝트 상태 (Deployment 복제본, Pod phase, 재시작, PVC, HPA 목표) | **kube-state-metrics** (API 서버 watch) | 스크레이프 |
| 컨트롤 플레인 | apiserver, etcd, scheduler, controller-manager `/metrics` | 관리형 클러스터는 일부만 노출 |
| 앱 메트릭 | 앱 `/metrics` | ServiceMonitor / PodMonitor / 어노테이션 |
| 로그 | `/var/log/pods/<ns>_<pod>_<uid>/<container>/*.log` | Alloy/Promtail/Fluent Bit **DaemonSet** |
| 이벤트 | `kubectl get events` (1시간 보존) | kube-event-exporter → Loki |
| 트레이스 | 앱 OTel SDK | OTel Collector (DaemonSet 또는 Deployment) → Tempo |
| 감사 로그 | API 서버 audit policy | 파일/웹훅 → SIEM |

`kubectl top` 은 metrics-server(현재값만). 시계열·알림은 Prometheus. 둘은 다른 파이프라인이다.

## 수집 아키텍처

```
┌─ Node ──────────────────────────────┐
│ kubelet(cAdvisor)  node-exporter    │ ← Prometheus 가 노드마다 스크레이프
│ Alloy DaemonSet ──/var/log/pods──▶ Loki
│ OTel Collector (agent) ◀─ 앱 OTLP ──▶ Tempo / Prometheus(remote write)
└─────────────────────────────────────┘
kube-state-metrics (Deployment) ← API 서버 watch
Prometheus Operator ← ServiceMonitor/PodMonitor/PrometheusRule CRD → Prometheus StatefulSet 설정 생성
Grafana ← Prometheus · Loki · Tempo 데이터소스
```

**DaemonSet** 은 "노드마다 하나" — 로그·노드 지표 수집기에 쓴다. **Operator** 는 CRD 로 선언한 의도를 실제 설정으로 바꾸는 컨트롤러 — 앱 팀이 자기 네임스페이스에 ServiceMonitor 를 두면 끝이라 플랫폼 팀과 앱 팀의 책임이 깔끔히 나뉜다 ([Kubernetes 노트 10](/kubernetes/notes/10-monitoring-stack)).

### 어노테이션 방식 (Operator 없이)

```yaml
metadata:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "3000"
    prometheus.io/path: "/api/metrics"
```

`kubernetes_sd_configs` + relabel 로 어노테이션이 있는 Pod 만 수집. 간단하지만 CRD 방식보다 유연성이 떨어진다.

## 무엇을 볼 것인가 — 계층별

**1. 클러스터 용량** (플랫폼 팀)
```promql
sum(kube_pod_container_resource_requests{resource="cpu"}) / sum(kube_node_status_allocatable{resource="cpu"})   # requests 예약률
1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)                                        # 실제 메모리 사용률
count(kube_pod_status_phase{phase="Pending"} == 1)                                                               # 스케줄 못 한 Pod
```
예약률이 80% 를 넘으면 실제 사용률이 낮아도 새 Pod 이 Pending 된다 — requests 과다 설정을 찾아 줄인다(VPA 추천값 활용).

**2. 워크로드 건강** (앱 팀)
```promql
kube_deployment_status_replicas_available / kube_deployment_spec_replicas < 1
increase(kube_pod_container_status_restarts_total[1h]) > 3
kube_pod_container_status_waiting_reason{reason=~"CrashLoopBackOff|ImagePullBackOff"} == 1
sum by (pod) (container_memory_working_set_bytes) / sum by (pod) (kube_pod_container_resource_limits{resource="memory"}) > 0.9   # OOM 임박
```

**3. 서비스 품질** (RED, 앱 메트릭 또는 span metrics)
```promql
sum by (service) (rate(http_server_request_duration_seconds_count{status=~"5.."}[5m])) / sum by (service) (rate(http_server_request_duration_seconds_count[5m]))
histogram_quantile(0.99, sum by (le, service) (rate(http_server_request_duration_seconds_bucket[5m])))
```

**4. 의존성** (Redis, DB, Kafka exporter) — 메모리, 커넥션, LAG, 복제 지연.

## 대시보드 구조 제안

- **Overview**: 클러스터 용량 4개 Stat + 네임스페이스별 CPU/메모리 Top10 + firing 알림 목록.
- **Namespace**: 변수 `$namespace`. 워크로드별 복제본/재시작/자원, 로그 패널(`{namespace="$namespace"} |= "error"`).
- **Service**: RED + 의존성 + 트레이스 링크(exemplar). 배포 시각을 annotation 으로 (ArgoCD/Flux 이벤트).
- kube-prometheus-stack 기본 대시보드를 먼저 쓰고, 부족한 것만 추가한다.

## 알림 계층

| 계층 | 예 | 받는 사람 |
|---|---|---|
| 사용자 영향 (page) | 서비스 에러율 > 2% 5분, p99 > SLO, 가용 복제본 0 | 온콜 |
| 조치 필요 (ticket) | 재시작 반복, PVC 85%, 인증서 14일 내 만료, 노드 NotReady | 담당 팀 채널 |
| 정보 (log only) | HPA 최대치 도달, 이미지 pull 느림 | 대시보드 |

`Watchdog` 알림이 항상 firing 인지로 **알림 파이프라인 자체**를 감시한다 (dead man's switch).

## 비용 제어

- 카디널리티: `container_*` 메트릭은 Pod 수 × 컨테이너 × 메트릭 종류. 불필요한 메트릭은 `metricRelabelings` 로 drop.
  ```yaml
  metricRelabelings:
    - sourceLabels: [__name__]
      regex: "container_(network_tcp_usage_total|tasks_state|memory_failures_total)"
      action: drop
  ```
- 스크레이프 간격 15~30초면 충분. 5초는 로컬 실습용.
- 로그는 네임스페이스별 쿼터와 보존. `kube-system` 로그는 짧게.
- 장기 보존은 Mimir/Thanos + 오브젝트 스토리지, 다운샘플링.

## 관리형 클러스터에서

EKS/GKE/AKS 는 컨트롤 플레인 메트릭을 제한적으로 노출하고, 클라우드 자체 모니터링(CloudWatch Container Insights, Cloud Monitoring)과 Prometheus 를 함께 쓰는 경우가 많다. **Managed Prometheus**(AMP, GMP) 로 운영 부담을 줄일 수 있다. 비용은 수집 샘플 수 기준이니 카디널리티 관리가 곧 비용 관리다.

## 실습 체크리스트

- [ ] `pnpm k8s:monitoring` 후 Grafana(13001) 의 "Kubernetes / Compute Resources / Cluster" 에서 requests 예약률 보기
- [ ] `kubectl -n study delete pod redis-0` 후 `kube_pod_container_status_restarts_total` 과 이벤트 변화 확인
- [ ] redis 의 `metricRelabelings` 로 불필요한 메트릭 하나를 drop 하고 시계열 수 변화 보기 (`prometheus_tsdb_head_series`)
- [ ] 알림 3계층을 PrometheusRule 로 작성해 보기
