---
title: Kubernetes 관측 — kube-prometheus-stack, ServiceMonitor, 로그
order: 10
level: 심화
summary: Prometheus Operator 가 CRD 로 수집 설정을 관리하는 방식, kube-state-metrics·node-exporter·cAdvisor 가 주는 지표, Grafana 기본 대시보드, 알림, 로그 수집(Loki) 까지 — 이 프로젝트의 kind 클러스터에 실제로 설치한다
tags: [kube-prometheus-stack, Prometheus Operator, ServiceMonitor, kube-state-metrics, Grafana, Loki, 알림]
experiments: []
---

## 무엇을 설치하나

**kube-prometheus-stack** Helm 차트 하나가 다음을 설치한다.

| 컴포넌트 | 역할 |
|---|---|
| **Prometheus Operator** | `Prometheus`, `ServiceMonitor`, `PodMonitor`, `PrometheusRule`, `Alertmanager` CRD 를 보고 실제 설정을 생성·재로드 |
| Prometheus | 수집·저장·질의 (StatefulSet, PVC) |
| Alertmanager | 알림 라우팅·그룹화·억제 |
| **kube-state-metrics** | API 서버의 오브젝트 상태를 메트릭으로 (Deployment 복제본 수, Pod 상태, 재시작 횟수, PVC 용량…) |
| **node-exporter** | 노드 OS 지표 (CPU, 메모리, 디스크, 네트워크) — DaemonSet |
| cAdvisor (kubelet 내장) | 컨테이너별 CPU·메모리·네트워크 (`container_*`) |
| Grafana + 기본 대시보드 수십 개 | 클러스터/노드/네임스페이스/Pod 별 자원, API 서버, etcd 등 |
| 기본 알림 규칙 | KubePodCrashLooping, KubeDeploymentReplicasMismatch, NodeMemoryPressure 등 100+ |

```bash
pnpm k8s:monitoring          # helm upgrade --install kps ... -n monitoring (처음엔 수 분, 이미지 ~1GB)
kubectl -n monitoring get pods
pnpm k8s:grafana:port        # http://localhost:13001  (admin / study)
pnpm k8s:prom:port           # http://localhost:19091
pnpm k8s:monitoring:down
```

`k8s/monitoring/values.yaml` 은 로컬용으로 가볍게 잡았고(보존 2일, kind 에 없는 컴포넌트 스크레이프 끔), `serviceMonitorSelectorNilUsesHelmValues: false` 로 **모든 네임스페이스의 ServiceMonitor** 를 받는다.

## 어떻게 수집 대상을 추가하나 — ServiceMonitor

예전엔 `prometheus.yml` 을 직접 고쳤다. Operator 방식은 **애플리케이션 옆에 CRD 를 두면** 자동으로 스크레이프 설정이 생긴다. 앱 팀이 자기 네임스페이스에 ServiceMonitor 를 커밋하면 된다.

```yaml
# k8s/monitoring/redis-servicemonitor.yaml 요약
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: redis
  namespace: study
  labels: { release: kps }           # 차트가 기본으로 보는 셀렉터 (values 로 전체 허용으로 바꿈)
spec:
  selector:
    matchLabels: { app: redis-exporter }   # 이 레이블의 Service 를
  endpoints:
    - port: metrics                        # Service 의 포트 '이름'
      interval: 15s
```

같은 파일에 **redis_exporter Deployment + Service**, 앱(web) 의 `/api/metrics` ServiceMonitor, 그리고 `PrometheusRule`(Redis 다운·메모리 80% 알림) 이 들어 있다. 적용 후 Prometheus UI → Status → Targets 에서 `serviceMonitor/study/redis/0` 이 UP 인지 본다.

PodMonitor 는 Service 없이 Pod 레이블로 직접 잡을 때 (사이드카, Job). `ScrapeConfig` CRD 로 외부 타깃(static)도 가능.

## 꼭 알아야 할 메트릭

```promql
# 워크로드 상태 (kube-state-metrics)
kube_deployment_status_replicas_available{namespace="study"}
kube_pod_container_status_restarts_total > 0
kube_pod_status_phase{phase="Pending"} == 1
kube_persistentvolumeclaim_resource_requests_storage_bytes

# 컨테이너 자원 (cAdvisor) — HPA 가 보는 것과 같은 원천
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="study", container!=""}[5m]))
sum by (pod) (container_memory_working_set_bytes{namespace="study", container!=""})
# requests 대비 사용률
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="study"}[5m]))
  / sum by (pod) (kube_pod_container_resource_requests{namespace="study", resource="cpu"})

# 노드 (node-exporter)
1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes
node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}

# 우리 앱
redis_memory_used_bytes
study_progress_read_total
```

Grafana 의 "Kubernetes / Compute Resources / Namespace (Pods)" 대시보드가 이 질의들을 이미 그려 준다. 네임스페이스를 `study` 로 바꿔 보자.

## 알림 — PrometheusRule 과 Alertmanager

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata: { name: study-rules, namespace: study, labels: { release: kps } }
spec:
  groups:
    - name: study
      rules:
        - alert: StudyWebDown
          expr: kube_deployment_status_replicas_available{namespace="study", deployment="web"} < 1
          for: 2m
          labels: { severity: critical }
          annotations:
            summary: "web Deployment 가용 복제본 0"
            runbook_url: "https://github.com/jaejinu/study/blob/main/content/kubernetes/notes/08-ops-debugging.md"
```

Alertmanager 라우팅(values 의 `alertmanager.config`):

```yaml
route:
  receiver: slack-warn
  group_by: [alertname, namespace]
  routes:
    - matchers: [severity="critical"]
      receiver: pagerduty
receivers:
  - name: slack-warn
    slack_configs: [{ api_url: <webhook>, channel: "#alerts" }]
  - name: pagerduty
    pagerduty_configs: [{ routing_key: <key> }]
inhibit_rules:
  - source_matchers: [severity="critical"]
    target_matchers: [severity="warning"]
    equal: [namespace]          # critical 이 떠 있으면 같은 네임스페이스의 warning 은 억제
```

기본 규칙 중 로컬에서 자주 보이는 것: `Watchdog`(항상 firing, 파이프라인 생존 확인용), `KubeControllerManagerDown`(kind 에서 스크레이프 끈 경우 — values 에서 비활성화함).

## 로그 수집 — Loki

메트릭은 Prometheus, 로그는 **Loki** + 수집기(**Alloy** 또는 Promtail, DaemonSet). 모든 Pod 의 stdout 을 노드의 `/var/log/pods` 에서 읽어 `namespace, pod, container` 라벨로 보낸다.

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm upgrade --install loki grafana/loki -n monitoring \
  --set deploymentMode=SingleBinary --set loki.commonConfig.replication_factor=1 \
  --set loki.storage.type=filesystem --set singleBinary.replicas=1 \
  --set loki.auth_enabled=false --set 'loki.schemaConfig.configs[0].from=2024-01-01' \
  --set 'loki.schemaConfig.configs[0].store=tsdb' --set 'loki.schemaConfig.configs[0].object_store=filesystem' \
  --set 'loki.schemaConfig.configs[0].schema=v13' --set 'loki.schemaConfig.configs[0].index.prefix=index_' \
  --set 'loki.schemaConfig.configs[0].index.period=24h'
helm upgrade --install alloy grafana/alloy -n monitoring -f k8s/monitoring/alloy-values.yaml   # 로그 수집 설정 포함
```

Grafana 에 Loki 데이터소스를 추가하면 Explore 에서:

```logql
{namespace="study", container="web"} |= "error"
sum by (pod) (rate({namespace="study"}[1m]))                     # Pod 별 로그 속도
{namespace="study"} | json | status >= 500                        # JSON 로그 파싱 후 필터
```

로그 설계 원칙은 [관측성 노트 05](/observability/notes/05-logging-loki) 에서 다룬다. 핵심: **JSON 으로 stdout 에**, `trace_id` 포함, 라벨은 적게(네임스페이스·앱 수준), 본문은 grep.

## 운영 팁

- Prometheus 는 메모리를 많이 쓴다(시계열 수에 비례). `kube_pod_labels` 같은 고카디널리티 메트릭은 relabel 로 드롭.
- 보존·장기 저장: Thanos sidecar 또는 Mimir 로 오브젝트 스토리지에.
- 여러 클러스터: 각 클러스터 Prometheus → 중앙 Mimir/Thanos, Grafana 는 중앙 하나.
- 대시보드는 ConfigMap(`grafana_dashboard: "1"` 레이블)으로 사이드카가 자동 로드 — 코드로 관리.
- 알림은 증상 기반, 런북 링크 필수 ([Grafana 와 알림 노트](/observability/notes/04-grafana-alerting)).

> 이어서 읽기: [Kubernetes 에서의 관측 — 수집 아키텍처와 무엇을 볼 것인가](/observability/notes/07-kubernetes-observability) — 쿠버네티스 관측의 전체 그림

> 이어서 읽기: [minikube 와 애드온 — Ingress·metrics-server·HPA 실습](/kubernetes/notes/09-minikube-addons) — metrics-server·ingress 애드온으로 빠르게 켜기

## 실전에서는 어디에 쓰이나

> Kubernetes 를 운영한다는 건 사실상 이 스택(kube-prometheus-stack + 로그 수집)을 함께 운영한다는 뜻이다. 장애를 먼저 아는 쪽이 사용자가 아니라 알림이 되게 만드는 곳이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 수십 개 앱 팀을 지원하는 플랫폼 팀 | 앱 팀이 스스로 수집 대상 추가 | 각 네임스페이스에 ServiceMonitor·PrometheusRule 커밋 | 중앙 `prometheus.yml` PR — 플랫폼 팀이 병목 |
| 커머스 배포 직후 | 재시작 급증·복제본 부족을 사용자보다 먼저 | `kube_pod_container_status_restarts_total`, 기본 규칙 KubeDeploymentReplicasMismatch | 고객 문의로 인지 |
| 로그 폭주로 노드 디스크가 차는 상황 | DiskPressure 축출 전에 경고 | node-exporter `node_filesystem_avail_bytes` 비율 알림 | 클라우드 콘솔 지표 |
| 메모리 누수 의심 Pod | 언제부터 얼마나 늘었나 | cAdvisor `container_memory_working_set_bytes` 추세를 limit 과 비교 | `kubectl top` — 현재값뿐 |
| 리전별 클러스터를 둔 SaaS | 여러 클러스터를 한 화면에 | 클러스터별 Prometheus → 중앙 Mimir·Thanos, Grafana 하나 | 관리형 관측 SaaS — 데이터량 비례 비용 |

**이럴 땐 안 맞는다**
- 작은 팀이 기본 규칙 100+ 개를 그대로 켜기 → 알림 피로로 진짜 알림을 놓친다. 증상 기반으로 추리고 나머지는 대시보드로.
- `kube_pod_labels` 같은 고카디널리티 메트릭을 그대로 수집 → Prometheus 메모리가 터진다. relabel 로 드롭한다.

**누가 매일 만나나** — SRE 는 Alertmanager 라우팅·억제와 규칙 튜닝, 앱 팀은 ServiceMonitor 커밋, 온콜은 알림이 오면 Grafana 네임스페이스 대시보드부터 연다.

**면접·실무 단골 질문**
- Q. ServiceMonitor 를 만들었는데 Targets 에 안 보인다면? → Prometheus 의 serviceMonitorSelector 레이블, Service 셀렉터, endpoints 의 포트 '이름' 불일치 순으로 본다.

## 실습 체크리스트

- [ ] `pnpm k8s:monitoring` 후 Prometheus Targets 에서 `study/redis`, `study/web` 이 UP 인지 확인
- [ ] Grafana "Kubernetes / Compute Resources / Namespace (Pods)" 에서 study 네임스페이스 보기
- [ ] Redis 벤치마크를 돌리고 `rate(redis_commands_processed_total[1m])` 그래프 확인
- [ ] `kubectl -n study scale deploy/web --replicas=0` 으로 StudyWebDown 알림이 Alertmanager 에 뜨는지 (2분 후) 확인하고 되돌리기
- [ ] Loki 를 설치하고 `{namespace="study"}` 로 web 로그 보기
