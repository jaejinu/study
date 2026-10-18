---
title: 심화 — 스케줄링, 자원 관리, 오토스케일링 전략
order: 14
level: 심화
summary: 스케줄러의 필터·점수 단계, affinity/anti-affinity 와 topology spread, taint/toleration, 우선순위와 선점, QoS 와 축출 순서, PDB, 리소스 right-sizing(VPA), 클러스터 오토스케일러·Karpenter, KEDA 이벤트 스케일, 배치 워크로드(Job·CronJob)
tags: [스케줄러, affinity, taint, PriorityClass, QoS, PDB, VPA, Karpenter, KEDA, Job]
experiments: [k8s-hpa-autoscale, k8s-scale]
---

## 스케줄러는 어떻게 노드를 고르나

```
Pending Pod → 1) 필터(Predicates): 자원(requests) 충분한가, nodeSelector/affinity 만족, taint 허용, 포트 충돌, 볼륨 존
            → 2) 점수(Priorities): 남는 자원 균형, 이미지 이미 있음, 분산(topology), affinity 선호
            → 3) 바인딩 → kubelet 이 실행
```

```bash
kubectl describe pod <pending-pod> | tail -n 5          # FailedScheduling: 0/3 nodes are available: 1 Insufficient cpu, 2 node(s) had untolerated taint
kubectl get events --field-selector reason=FailedScheduling -A
kubectl describe node <n> | grep -A 8 "Allocated resources"
```

**requests 가 곧 스케줄링의 화폐**다. limits 는 스케줄링에 쓰이지 않는다.

## 배치 제어

```yaml
spec:
  nodeSelector: { disktype: ssd }                            # 가장 단순
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:        # 필수 (스케줄 시점만 평가)
        nodeSelectorTerms: [{ matchExpressions: [{ key: topology.kubernetes.io/zone, operator: In, values: [ap-northeast-2a, ap-northeast-2c] }] }]
      preferredDuringSchedulingIgnoredDuringExecution:       # 선호 (점수)
        - { weight: 80, preference: { matchExpressions: [{ key: node.kubernetes.io/instance-type, operator: In, values: [m6i.large] }] } }
    podAntiAffinity:                                         # 같은 앱 Pod 을 다른 노드/존에
      requiredDuringSchedulingIgnoredDuringExecution:
        - { labelSelector: { matchLabels: { app: redis } }, topologyKey: kubernetes.io/hostname }
  topologySpreadConstraints:                                 # 존·노드에 고르게 (anti-affinity 보다 유연)
    - { maxSkew: 1, topologyKey: topology.kubernetes.io/zone, whenUnsatisfiable: DoNotSchedule, labelSelector: { matchLabels: { app: web } } }
  tolerations:                                               # taint 된 노드(GPU, 스팟)에 갈 수 있음
    - { key: workload, operator: Equal, value: batch, effect: NoSchedule }
```

```bash
kubectl taint nodes gpu-1 nvidia.com/gpu=present:NoSchedule     # 허용(toleration)한 Pod 만
kubectl taint nodes gpu-1 nvidia.com/gpu-                        # 제거
# effect: NoSchedule(새 Pod 금지) / PreferNoSchedule / NoExecute(기존 Pod 도 축출, tolerationSeconds 로 유예)
```

노드 장애 시 `node.kubernetes.io/not-ready:NoExecute` taint 가 자동으로 붙고 Pod 은 기본 300초 뒤 축출된다 (`tolerationSeconds` 로 조정).

## 우선순위와 선점

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata: { name: critical }
value: 1000000
preemptionPolicy: PreemptLowerPriority        # 자리 없으면 낮은 우선순위 Pod 을 쫓아낸다
---
spec: { priorityClassName: critical }
```
결제 API 는 critical, 배치는 낮게. 과부하 시 중요한 것이 남는다. system-cluster-critical 은 시스템 컴포넌트용.

## QoS 와 축출 순서

노드 메모리가 부족하면 kubelet 이 Pod 을 축출한다(OOM 과 다름).

| QoS | 조건 | 축출 순서 |
|---|---|---|
| BestEffort | requests/limits 없음 | 1순위 |
| Burstable | requests < limits | 2순위 (requests 초과 사용량 큰 것부터) |
| Guaranteed | requests == limits | 마지막 |

DB·캐시는 Guaranteed 로. 메모리 limit 초과는 컨테이너 OOMKill(exit 137), 노드 압박은 Pod 축출(Evicted) — `kubectl get pod` 의 상태로 구분.

## PodDisruptionBudget

노드 drain·업그레이드(자발적 중단) 중 최소 가용을 보장한다.
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: web, namespace: study }
spec: { minAvailable: 1, selector: { matchLabels: { app: web } } }      # 또는 maxUnavailable: 25%
```
복제본 1 + minAvailable 1 은 drain 을 영원히 막는다 — 복제본을 2 이상으로. 클러스터 오토스케일러의 스케일 인도 PDB 를 존중한다.

## Right-sizing — VPA

requests 를 추측하지 말고 측정한다.
```bash
helm install vpa fairwinds-stable/vpa -n vpa --create-namespace
cat <<'Y' | kubectl apply -f -
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata: { name: web, namespace: study }
spec:
  targetRef: { apiVersion: apps/v1, kind: Deployment, name: web }
  updatePolicy: { updateMode: "Off" }          # 추천만 (Auto 는 Pod 재시작으로 적용)
Y
kubectl describe vpa web -n study | grep -A 12 Recommendation     # target, lowerBound, upperBound
```
HPA(CPU) 와 VPA(CPU) 를 같은 리소스에 함께 쓰면 충돌 — VPA 는 추천 모드나 메모리만.

## 클러스터 오토스케일링

- **Cluster Autoscaler**: Pending Pod 이 생기면 노드 그룹을 늘리고, 유휴 노드(사용률 < 50%, PDB 존중)를 줄인다. 노드 그룹 단위라 느리다(수 분).
- **Karpenter**(AWS 중심, 범용화 중): Pending Pod 의 요구(자원·존·아키텍처·스팟)를 보고 **딱 맞는 인스턴스**를 직접 띄운다. 빠르고(1분 내) 비용 효율. NodePool 로 제약 선언, 통합(consolidation)으로 자동 압축.
- 스팟 인스턴스: taint + toleration 으로 배치·무상태만. 중단 2분 전 신호를 받아 graceful 종료.

## KEDA — 이벤트 기반 스케일

HPA 는 CPU/메모리/커스텀 메트릭. KEDA 는 **외부 이벤트 소스** 60+ (Kafka LAG, Redis 리스트/스트림 길이, SQS, Prometheus 질의, cron) 로 스케일하고 **0 으로 줄일 수 있다**.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: order-worker, namespace: study }
spec:
  scaleTargetRef: { name: order-worker }
  minReplicaCount: 0
  maxReplicaCount: 20
  cooldownPeriod: 60
  triggers:
    - type: kafka
      metadata: { bootstrapServers: kafka:9092, consumerGroup: order-workers, topic: orders, lagThreshold: "100" }
    - type: prometheus
      metadata: { serverAddress: http://kps-kube-prometheus-stack-prometheus.monitoring:9090, query: sum(rate(http_requests_total{service="web"}[1m])), threshold: "50" }
```
[Kafka 컨슈머 그룹](/kafka/notes/03-consumer-groups) 의 LAG 이 곧 스케일 신호 — 파티션 수가 상한.

## 배치 워크로드

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: reindex }
spec:
  parallelism: 4            # 동시 Pod
  completions: 16           # 총 성공 수 (인덱스 작업은 completionMode: Indexed 로 0..15 를 각 Pod 에)
  backoffLimit: 3
  ttlSecondsAfterFinished: 3600
  template: { spec: { restartPolicy: OnFailure, containers: [{ name: job, image: study:dev, command: [node, reindex.js] }] } }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly-report }
spec:
  schedule: "0 3 * * *"
  timeZone: Asia/Seoul
  concurrencyPolicy: Forbid           # 이전 실행이 안 끝났으면 건너뜀
  startingDeadlineSeconds: 600
  jobTemplate: { spec: { … } }
```
Job 은 멱등해야 한다(재시도·중복 실행). 큐 소비형 워커는 Deployment + KEDA 가 더 맞다.

> 이어서 읽기: [Kubernetes 비용 — requests 는 예약이고, 노드가 청구서다](/finops/notes/03-kubernetes-cost) — 빈 패킹·right-sizing 의 비용 효과 · [CPU 스케줄러와 cgroup — 누가 언제 CPU 를 얻고, 컨테이너 제한은 어떻게 동작하나](/os-internals/notes/03-scheduler-cgroups) — CFS/EEVDF 와 cgroup 대역폭 제어

## 실전에서는 어디에 쓰이나

> "왜 Pending 인가", "왜 이 Pod 이 쫓겨났나", "노드가 왜 이렇게 많나" 의 답이 여기 있다. 가용성(분산 배치)과 비용(빈 패킹·스팟)이 같은 설정에서 동시에 걸린다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 결제 API | 존 하나가 죽어도 서비스 유지, 과부하 때 먼저 살아남기 | 존 topologySpread + PDB + PriorityClass | 리전 이중화 — 비용 2배 |
| AI 서비스 학습·추론 | 비싼 GPU 노드에 GPU 워크로드만 | GPU 노드 taint + toleration, nodeAffinity | GPU 전용 클러스터 분리 |
| 데이터 팀 야간 배치 | 리포트·재색인을 겹치지 않게 | CronJob(`timeZone`, `concurrencyPolicy: Forbid`), Indexed Job | 외부 워크플로 엔진(Airflow) |
| 비용 압박이 큰 SaaS | 노드 낭비 줄이기 | Karpenter consolidation, 무상태·배치는 스팟 노드로 | Cluster Autoscaler 노드 그룹 |
| 커머스 주문 이벤트 워커 | Kafka LAG 에 따라 0↔N | KEDA kafka 트리거(파티션 수가 상한) | 상시 N개 — 유휴 비용 |

**이럴 땐 안 맞는다**
- HPA(CPU) 와 VPA(CPU) 를 같은 워크로드에 → 서로 싸운다. VPA 는 추천 모드나 메모리만.
- 복제본 1 + PDB `minAvailable: 1` → drain 을 영원히 막는다. 복제본을 2 이상으로.
- 상태 있는 DB 를 스팟 노드에 → 짧은 중단 예고로는 안전한 이전이 어렵다. 온디맨드 노드에 둔다.

**누가 매일 만나나** — 플랫폼·SRE 는 FailedScheduling 이벤트와 노드 풀 구성을, ML 엔지니어는 GPU 스케줄링을, FinOps 담당은 requests 대비 실사용률(right-sizing)을 본다.

**면접·실무 단골 질문**
- Q. OOMKilled 와 Evicted 의 차이는? → 컨테이너가 자기 메모리 limit 을 넘음(exit 137) vs 노드 메모리 압박으로 kubelet 이 QoS 순서대로 Pod 을 축출.

## 실습 체크리스트

- [ ] `requests.cpu: "100"` 처럼 불가능한 값으로 배포해 FailedScheduling 메시지 읽기
- [ ] kind 노드에 taint 를 걸고 toleration 없는 Pod 이 Pending 되는 것 확인, toleration 추가
- [ ] PDB minAvailable 1 + 복제본 1 로 `kubectl drain` 이 막히는 것 보기 (`--ignore-daemonsets`)
- [ ] VPA 추천 모드로 web 의 requests 추천값 보기
- [ ] KEDA 를 설치하고 Redis 리스트 길이로 워커를 0↔N 스케일 (`type: redis`)
- [ ] Indexed Job 으로 16개 작업을 4개 Pod 이 나눠 처리
