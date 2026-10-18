---
title: "Kubernetes 비용 — requests 는 예약이고, 노드가 청구서다"
order: 3
level: 중급
summary: "Kubernetes 에서 돈을 내는 단위는 Pod 가 아니라 노드이며 노드 수를 정하는 것은 실사용이 아니라 requests 라는 사실, 배분(max(요청, 사용))·효율·유휴 세 지표, BestEffort Pod 가 비용과 안정성을 동시에 해치는 이유, requests 재조정(VPA 권고·p95 기반)·빈 패킹·노드 오토스케일러·스팟 노드 풀, OpenCost/Kubecost 의 원리와 네임스페이스 쇼백, 이 프로젝트 kind 클러스터 실측(BestEffort 20/35, 효율 6~40%)"
tags: [Kubernetes, 비용, requests, limits, OpenCost, Kubecost, 빈 패킹, VPA, Karpenter, 쇼백]
experiments: [finops-k8s-requests-vs-usage]
---

## Pod 는 공짜다, 노드가 돈이다

관리형 Kubernetes 청구서에는 Pod 가 없다([클라우드 비용 모델](/finops/notes/01-cloud-cost-model)의 컴퓨트 항목). **노드 VM 시간**과 컨트롤 플레인 시간이 있을 뿐이다. 그렇다면 노드 수는 누가 정하나?

```
Pod 생성 ──▶ 스케줄러: "requests 합이 노드 allocatable 에 들어가는 노드?"
               │                  없으면
               ▼                     ▼
             배치             Pending ──▶ 클러스터 오토스케일러 / Karpenter: 노드 추가 (💸)
```

스케줄러는 **실사용을 보지 않는다**. 오직 requests 의 합으로 노드를 채운다. 그래서:

- requests 를 10배 부풀리면 실사용이 같아도 노드가 10배 필요하다.
- requests 가 0 이면 노드가 넘치도록 배치돼 메모리 압박·축출이 생긴다.

리소스 requests·limits 의 기본 동작은 [Kubernetes 배포·리소스](/kubernetes/notes/07-deploy-resources)에서, QoS 와 축출 순서는 [스케줄링·오토스케일 심화](/kubernetes/notes/14-scheduling-autoscaling-deep)에서 다뤘다. 이 노트는 그것을 **돈의 관점**으로 다시 본다.

## 세 가지 지표: 배분, 효율, 유휴

![Kubernetes 비용 배분](/diagrams/finops-k8s-allocation.svg)

| 지표 | 정의 | 무엇을 말하나 |
|---|---|---|
| **배분(allocation)** | 컨테이너별 `max(request, usage)` × 단가 | 이 팀·네임스페이스가 노드 비용 중 차지한 몫 |
| **효율(efficiency)** | usage ÷ request | 예약한 것 중 실제로 쓴 비율. 낮으면 과다 요청 |
| **유휴(idle)** | 노드 용량 − Σ 배분 | 아무에게도 배분되지 않은 비용. 노드를 줄일 여지 |

왜 `max` 인가?

- 요청만 하고 안 썼다 → 그 자리를 남이 못 쓰니 **내 비용**.
- 요청보다 더 썼다(limits 가 더 크거나 없음) → 남의 여유를 빌려 썼으니 그만큼도 **내 비용**.

OpenCost(CNCF)와 Kubecost 가 기본으로 쓰는 공식이 이것이다. 메모리도 같고, GPU·영구 볼륨·로드밸런서·네트워크는 별도 항목으로 더한다.

### 효율의 현실적인 목표

| CPU 효율 | 해석 |
|---|---|
| < 20% | 거의 확실히 과다 요청. 재조정 1순위 |
| 30~60% | 흔한 운영 수준. 버스트 여유를 둔 것 |
| 60~80% | 좋은 상태. 스파이크에 스로틀·지연 위험 점검 |
| > 100% | 요청보다 많이 씀. 이웃을 빌려 쓰는 중 — 혼잡하면 느려진다 |

메모리는 CPU 보다 보수적으로 잡는다. CPU 부족은 느려질 뿐이지만 메모리 부족은 **OOMKilled**다([cgroup 노트](/os-internals/notes/03-scheduler-cgroups)).

## BestEffort Pod: 비용과 안정성 둘 다의 적

requests 가 하나도 없는 Pod 는 QoS 가 **BestEffort** 다.

1. **비용 가시성 0** — 배분 공식에서 요청이 0 이라 실사용만 보인다. 노드를 실제로 늘리게 만든 장본인이 장부에서 빠진다.
2. **과밀 배치** — 스케줄러는 0 으로 보고 아무 노드에나 넣는다. 한 노드에 몰리면 서로의 CPU 를 뺏고 메모리 압박을 만든다.
3. **먼저 쫓겨난다** — 노드 메모리가 부족하면 kubelet 은 BestEffort 부터 축출한다.

> **팁:** 네임스페이스에 **LimitRange** 로 기본 requests 를 주면 매니페스트에 빠뜨려도 BestEffort 가 되지 않는다. 정책 엔진(Kyverno·Gatekeeper)으로 "requests 없는 Pod 거부" 를 강제할 수도 있다([Kubernetes 보안](/security/notes/06-kubernetes-security)).

```yaml
apiVersion: v1
kind: LimitRange
metadata: { name: defaults, namespace: study }
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 50m, memory: 64Mi }   # requests 를 안 쓰면 이 값
      default:        { memory: 256Mi }            # limits 기본값 (CPU limit 은 일부러 비움)
```

## 비용을 줄이는 네 가지 레버

### 1. requests 재조정 (right-sizing)

가장 효과가 크고 위험이 낮다.

```promql
# 컨테이너별 지난 7일 CPU 사용량 p95 (코어)
quantile_over_time(0.95,
  sum by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!=""}[5m]))[7d:5m])

# 권장 request ≈ p95 × 1.2 (여유), 메모리는 max_over_time(working_set[7d]) × 1.2
```

- **VPA(Vertical Pod Autoscaler)** 를 `updateMode: "Off"` 로 두면 권고만 계산한다. 그 권고를 사람이 PR 로 반영하는 것이 안전한 시작이다.
- HPA(CPU 기준)와 VPA(CPU 자동 조정)를 같은 Pod 에 동시에 쓰면 서로 싸운다. HPA 는 requests 대비 사용률을 보기 때문이다.

### 2. 빈 패킹 (bin packing)

배분이 맞아도 노드에 **조각난 빈자리**가 남는다. 2 vCPU 씩 남는 노드 5대보다 꽉 찬 노드 4대가 싸다.

- 스케줄러 점수 전략 `MostAllocated`(빈 패킹) vs 기본 `LeastAllocated`(분산). 가용성과 비용의 트레이드오프다.
- **Karpenter** 같은 노드 프로비저너는 대기 Pod 에 딱 맞는 인스턴스 타입을 고르고, 비어 가는 노드를 합쳐(consolidation) 없앤다.

### 3. 노드 오토스케일 + 스팟 노드 풀

| 노드 풀 | 대상 Pod | 비고 |
|---|---|---|
| 온디맨드(약정) | 시스템, DB, 상태 있는 것 | 바닥 용량 |
| 스팟 | 무상태 웹, 워커, 배치, CI | `nodeSelector`/`tolerations` 로 유도, PDB 필수 |

### 4. 상시 가동 줄이기

- 개발·스테이징 네임스페이스를 업무 시간에만 (`kube-downscaler`, CronJob 으로 replicas 0).
- KEDA 로 큐가 비면 워커 0 으로(스케일 투 제로).
- 사용하지 않는 PVC·로드밸런서 Service 정리 — Pod 가 없어도 비용이 나간다.

## OpenCost 로 쇼백하기

OpenCost 는 Prometheus 의 kube-state-metrics·cAdvisor 메트릭에 클라우드 단가(또는 커스텀 단가)를 곱해 네임스페이스·레이블·컨트롤러별 비용을 계산한다.

```bash
# kube-prometheus-stack 이 있는 클러스터에 (이 프로젝트 기준 예시)
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm install opencost opencost/opencost -n opencost --create-namespace \
  --set opencost.prometheus.internal.serviceName=kps-kube-prometheus-stack-prometheus \
  --set opencost.prometheus.internal.namespaceName=monitoring \
  --set opencost.customPricing.enabled=true \
  --set opencost.customPricing.costModel.CPU=0.0316 \
  --set opencost.customPricing.costModel.RAM=0.0042
kubectl -n opencost port-forward svc/opencost 9003:9003 &   # 9003 = API, 9090 = UI
curl -s 'localhost:9003/allocation/compute?window=1d&aggregate=namespace' | jq '.data[0] | map_values(.totalCost)'
```

> **주의:** 로컬 kind 노드는 Mac 전체 CPU·메모리를 노드 용량으로 보고하므로 유휴 비용이 비현실적으로 크게 나온다. 로컬에선 **배분과 효율**만 의미 있게 읽자.

쇼백 보고서에 들어갈 것:

1. 네임스페이스(팀)별 배분 비용과 지난달 대비 변화.
2. 효율 하위 5개 워크로드 — 재조정 후보.
3. BestEffort Pod 수 — 0 이 목표.
4. 유휴 비용 — 플랫폼팀의 KPI(빈 패킹·노드 축소).

## 예시로 보기 — 이 프로젝트에서

실험 `finops-k8s-requests-vs-usage` 를 이 Mac 의 kind-study 에서 돌린 결과(가정 단가):

| 네임스페이스 | Pod | BestEffort | CPU 요청 | CPU 사용 | 효율 | 배분/월 |
|---|---|---|---|---|---|---|
| kube-system | 9 | 1 | 1,050m | ~60m | 6% | $29 |
| study | 8 | 4 | 270m | ~20m | 7~10% | $7.8 |
| monitoring | 6 | 4 | 100m | ~35m | 31~40% | $6.4 |
| falco | 3 | 2 | 100m | ~30m | 30% | $4.0 |
| argocd | 7 | 7 | 0 | ~12m | 요청 없음 | $1.5 |

읽는 법:

- **BestEffort 가 35개 중 20개**다. ArgoCD 는 전부, kube-prometheus-stack 의 상당수도 requests 가 없다. Helm 차트 기본값이 requests 를 비워 두는 경우가 많다 — 차트를 설치할 때 values 로 넣어 주는 게 운영의 기본이다.
- kube-system 의 효율 6% 는 kind 의 컨트롤 플레인 컴포넌트가 고정 requests(예: kube-apiserver 250m)를 갖기 때문이다. 관리형 클러스터에선 이 부분이 컨트롤 플레인 요금으로 따로 나간다.
- `study` 의 web·redis 는 requests 가 실사용의 10배 이상이다. 학습용이라 괜찮지만 운영이라면 재조정 1순위다.
- monitoring 은 메모리 실사용(~1.1 GiB)이 요청(456 MiB)의 2배 이상이다 — **메모리 요청이 너무 작다**는 반대 방향의 문제다. Prometheus 가 메모리를 더 쓰면 노드 압박 때 축출 위험이 있다.

> 이어서 읽기: [minikube 애드온](/kubernetes/notes/09-minikube-addons) — `kubectl top` 과 실사용 측정에 필요한 metrics-server 를 켜는 가장 빠른 길

## 실전에서는 어디에 쓰이나

> 관리형 Kubernetes 청구서는 노드 시간이고, 노드 수는 실사용이 아니라 requests 가 정한다. 그래서 클러스터 비용 절감은 대부분 코드가 아니라 requests·빈 패킹·노드 풀 구성 조정으로 이뤄진다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| SaaS 성장기 클러스터 | 사용률은 낮은데 노드가 계속 늘어남 | 효율 하위 워크로드를 p95 × 1.2 로 재조정, VPA 권고(`Off` 모드) | 노드 타입만 큰 것으로 |
| 여러 팀이 쓰는 사내 플랫폼 | 팀별 비용 보여 주기 | OpenCost 로 네임스페이스·레이블별 `max(요청, 사용)` 배분 쇼백 | 노드 비용을 Pod 수로 균등 분배 |
| 커머스 무상태 웹·배치 | 컴퓨트 단가 낮추기 | 스팟 노드 풀 + toleration + PDB, Karpenter consolidation | 전부 온디맨드 |
| 개발·스테이징 환경 | 밤·주말 유휴 비용 | kube-downscaler·CronJob 으로 replicas 0, KEDA 스케일 투 제로 | 상시 가동 |
| Helm 으로 오픈소스 설치 | BestEffort Pod 가 장부에서 빠지고 먼저 축출됨 | values 로 requests 지정, LimitRange 기본값, 정책 엔진으로 강제 | 차트 기본값 그대로 |

**이럴 땐 안 맞는다**
- 지연에 민감한 서비스에 CPU 효율 80% 이상을 목표로 → 버스트 때 스로틀과 지연이 온다. 여유를 남긴다.
- DB·Kafka 브로커 같은 상태 있는 워크로드를 스팟·빈 패킹 대상으로 → 회수·축출이 곧 장애다. 온디맨드 노드에 분산 배치한다.

**누가 매일 만나나** — 플랫폼 팀은 유휴 비용과 노드 풀 구성을 KPI 로 보고, 앱 팀은 쇼백 리포트에서 자기 네임스페이스의 효율 하위 워크로드를 고친다.

**면접·실무 단골 질문**
- Q. 배분 비용을 왜 `max(요청, 사용)` 으로 계산하나? → 요청하고 안 쓴 자리는 남이 못 쓰고, 요청보다 더 쓴 몫은 남의 여유를 빌린 것이라 둘 다 그 워크로드의 비용이다.

## 실습 체크리스트

- [ ] 실험 `finops-k8s-requests-vs-usage` 를 돌리고 효율이 가장 낮은 네임스페이스와 BestEffort Pod 목록을 확인하기
- [ ] `study` 네임스페이스에 LimitRange 를 적용하고 requests 를 뺀 Pod 를 만들어 기본값이 들어가는지 확인하기
- [ ] web Deployment 의 CPU 요청을 p95 × 1.2 로 바꾸면 배분 비용이 얼마가 되는지 계산하기
- [ ] VPA 를 `updateMode: "Off"` 로 설치해 권고값과 현재 requests 를 비교하기 (선택)
- [ ] OpenCost 를 설치해 실험 결과와 OpenCost 의 네임스페이스 비용이 같은 방향인지 비교하기 (선택)
- [ ] 이 클러스터를 클라우드로 옮긴다면 어떤 Pod 를 스팟 노드 풀에 둘 수 있는지 분류하기
