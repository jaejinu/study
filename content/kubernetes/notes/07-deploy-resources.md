---
title: 배포 전략과 리소스 관리
order: 7
level: 중급
summary: Helm 과 Kustomize 로 환경별 매니페스트 관리, requests/limits 와 QoS, HPA 오토스케일링, 네임스페이스 쿼터
tags: [Helm, Kustomize, requests, limits, HPA, QoS, 배포전략]
experiments: [k8s-rolling-update, k8s-scale]
---

## 매니페스트를 환경별로 관리하기

같은 앱을 dev/staging/prod 에 배포하면 복제본 수, 이미지 태그, 리소스가 다르다. YAML 을 복사해 두면 금방 어긋난다.

### Kustomize (kubectl 내장)

base 를 두고 overlay 로 **패치**한다. 템플릿 문법이 없어 YAML 이 그대로 YAML.

```
k8s/
  base/            kustomization.yaml, redis.yaml, service.yaml
  overlays/
    dev/           kustomization.yaml  (replicas: 1, 작은 리소스)
    prod/          kustomization.yaml  (replicas: 3, 이미지 태그 고정)
```

```yaml
# overlays/prod/kustomization.yaml
resources: [../../base]
namespace: study-prod
images:
  - name: redis
    newTag: 8.2.1
patches:
  - target: { kind: StatefulSet, name: redis }
    patch: |
      - op: replace
        path: /spec/replicas
        value: 3
```

```bash
kubectl kustomize overlays/prod | less
kubectl apply -k overlays/prod
```

이 프로젝트의 `k8s/` 는 단일 kustomization 이지만, configMapGenerator 의 해시 기능을 쓴다.

### Helm

**패키지 매니저**. 차트(템플릿 + values)를 설치·업그레이드·롤백하고, 공개 차트(bitnami, ingress-nginx, prometheus)를 가져다 쓴다.

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm search repo redis
helm show values bitnami/redis > redis-values.yaml     # 설정 가능한 값 전체
helm install my-redis bitnami/redis -n study --set architecture=standalone --set auth.enabled=false
helm list -n study
helm upgrade my-redis bitnami/redis -n study -f redis-values.yaml
helm rollback my-redis 1 -n study
helm uninstall my-redis -n study
helm template my-redis bitnami/redis            # 렌더링 결과만 보기
```

언제 무엇을: 남이 만든 복잡한 소프트웨어(DB, 모니터링) → **Helm**. 우리 앱의 환경별 차이 → **Kustomize** (또는 둘 다: Helm 렌더 결과를 Kustomize 로 패치).

### GitOps

매니페스트를 git 에 두고 **ArgoCD** 나 **Flux** 가 클러스터를 git 상태와 동기화한다. `kubectl apply` 를 사람이 치지 않는다. 변경 이력·리뷰·롤백이 git 으로 통일된다.

## 리소스 requests 와 limits

```yaml
resources:
  requests: { cpu: 100m, memory: 128Mi }   # 스케줄링 기준. 노드에 이만큼 여유가 있어야 배치
  limits:   { cpu: 500m, memory: 256Mi }   # 상한. CPU 는 throttle, 메모리는 OOMKill
```

- `100m` = 0.1 CPU 코어. `Mi` = 메비바이트.
- **requests 없이 배포하면** 스케줄러가 부하를 모르고 한 노드에 몰아넣는다. 꼭 설정하자.
- 메모리 limit 은 OOMKill 을 부르므로 실제 사용량 + 여유. CPU limit 은 지연을 유발할 수 있어 아예 두지 않는 쪽을 택하는 팀도 많다.

### QoS 클래스

| 클래스 | 조건 | 노드 메모리 부족 시 |
|---|---|---|
| Guaranteed | requests == limits (모든 컨테이너) | 가장 늦게 쫓겨남 |
| Burstable | requests < limits | 중간 |
| BestEffort | 둘 다 없음 | 가장 먼저 쫓겨남 |

```bash
kubectl get pod redis-0 -n study -o jsonpath='{.status.qosClass}'
kubectl top pods -n study          # metrics-server 필요 (kind 에는 기본 없음)
kubectl describe node | grep -A 8 "Allocated resources"
```

## 오토스케일링

```bash
kubectl autoscale deploy web --min=2 --max=10 --cpu-percent=70
kubectl get hpa
```

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: web }
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
```

HPA 는 **requests 대비** 사용률을 본다 (requests 가 없으면 동작 안 함). 메트릭 서버가 필요하다. 커스텀 메트릭(큐 길이, RPS)은 KEDA 나 Prometheus Adapter.
VPA(Vertical)는 requests 값을 추천·자동 조정, Cluster Autoscaler 는 노드 수를 조정.

## 네임스페이스 단위 제한

```yaml
apiVersion: v1
kind: ResourceQuota
metadata: { name: study-quota, namespace: study }
spec:
  hard: { requests.cpu: "2", requests.memory: 4Gi, pods: "20" }
---
apiVersion: v1
kind: LimitRange              # requests/limits 를 안 적은 Pod 에 기본값 주입
metadata: { name: defaults, namespace: study }
spec:
  limits:
    - type: Container
      default: { memory: 256Mi }
      defaultRequest: { cpu: 50m, memory: 64Mi }
```

## 배포 전략 요약

| 전략 | 방법 | 특징 |
|---|---|---|
| Rolling (기본) | Deployment 가 점진 교체 | 두 버전 공존 시간 있음 |
| Recreate | 전부 내리고 새로 | 다운타임, 단일 인스턴스 앱 |
| Blue/Green | 새 버전을 통째로 띄우고 Service selector 전환 | 즉시 전환·롤백, 리소스 2배 |
| Canary | 일부 트래픽만 새 버전 | Ingress 가중치 / Argo Rollouts / 서비스 메시 |

`PodDisruptionBudget` 으로 노드 점검 중에도 최소 가용 Pod 수를 보장한다.

> 이어서 읽기: [Kubernetes 비용 — requests 는 예약이고, 노드가 청구서다](/finops/notes/03-kubernetes-cost) — requests 가 곧 비용 — 배분과 유휴 비용 · [CPU 스케줄러와 cgroup — 누가 언제 CPU 를 얻고, 컨테이너 제한은 어떻게 동작하나](/os-internals/notes/03-scheduler-cgroups) — limits 의 실체: cgroup cpu.max 와 스로틀링

## 실전에서는 어디에 쓰이나

> 매니페스트를 환경별로 관리하고, 자원을 얼마나 예약하고, 언제 늘릴지를 정하는 노트다. 실무에서는 배포 도구 선택, OOMKill·CPU 스로틀링, 그리고 클라우드 비용 문제로 나타난다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 대형 커머스 세일 | 트래픽 급증에 자동 증설 | HPA(requests 대비 CPU 70%) + 노드 오토스케일 | 최대치로 미리 띄우기 — 평소 비용 낭비 |
| SaaS 멀티 환경 | dev/prod 차이를 YAML 복사 없이 | Kustomize base + overlay(복제본·태그·리소스) | 환경별 Helm values 파일 |
| 플랫폼 팀의 오픈소스 설치 | Prometheus·ingress-nginx 를 검증된 설정으로 | 공개 Helm 차트 + values 오버라이드 | 매니페스트 직접 작성·유지 |
| 여러 팀이 쓰는 사내 클러스터 | 한 팀의 자원 독식 방지 | 네임스페이스 ResourceQuota + LimitRange 기본값 | 팀마다 클러스터 — 격리는 강하나 비용·운영 부담 |
| 지연에 민감한 API | CPU limit 스로틀링으로 p99 가 튐 | CPU 는 requests 만 두고 limit 제거, 메모리 limit 은 유지 | requests == limits 로 Guaranteed |

**이럴 땐 안 맞는다**
- 큐 적체에 반응해야 하는 워커를 CPU HPA 로 → 대기 중엔 CPU 가 낮아 늘지 않는다. KEDA 나 커스텀 메트릭을 쓴다.
- JVM·Node 앱을 메모리 기준 HPA 로 → 메모리를 반납하지 않아 줄지 않는다.

**누가 매일 만나나** — 백엔드는 OOMKilled 를 보고 메모리 limit 을 조정한다. 플랫폼 팀은 requests 가 실사용과 맞는지 보고 쿼터를 정한다 — requests 가 곧 노드 비용이라 [FinOps](/finops/notes/03-kubernetes-cost) 와 바로 연결된다.

**면접·실무 단골 질문**
- Q. requests 와 limits 의 차이는? → requests 는 스케줄링·예약 기준(HPA 사용률의 분모), limits 는 상한(CPU 는 스로틀, 메모리는 OOMKill).
- Q. Helm 과 Kustomize 는 언제? → 남이 만든 복잡한 소프트웨어는 Helm, 우리 앱의 환경 차이는 Kustomize.

## 실습 체크리스트

- [ ] `kubectl kustomize k8s` 로 렌더링 결과와 ConfigMap 해시 이름 확인
- [ ] `helm template` 으로 bitnami/redis 가 만드는 오브젝트 훑어보기
- [ ] redis-0 의 QoS 클래스 확인, limits 를 requests 와 같게 바꿔 Guaranteed 로 만들어 보기
- [ ] 메모리 limit 을 `maxmemory` 보다 작게 줘서 OOMKilled 를 일부러 경험해 보기
