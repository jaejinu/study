---
title: Kubernetes 란 무엇인가
order: 1
level: 기초
summary: 컨테이너 오케스트레이션이 필요한 이유, 클러스터 아키텍처(컨트롤 플레인·노드), 선언적 모델과 컨트롤러 루프
tags: [개요, 아키텍처, 컨트롤플레인, kubelet, 선언적]
experiments: [k8s-self-healing]
---

## Docker 다음에 필요한 것

Docker 로 컨테이너 하나를 띄우는 건 쉽다. 그런데 운영에서는:

- 컨테이너가 죽으면 **자동으로 다시** 띄워야 한다
- 트래픽이 늘면 **여러 개**로 늘리고, 그 앞에 로드밸런서를 둬야 한다
- 새 버전을 **무중단**으로 배포하고, 문제가 있으면 되돌려야 한다
- 서버 여러 대에 컨테이너를 **어디에 둘지** 정해야 한다
- 설정·비밀값·스토리지를 컨테이너와 분리해 관리해야 한다

이걸 사람이 손으로 하지 않도록 만든 것이 **오케스트레이터**고, 사실상의 표준이 Kubernetes(k8s) 다.

## 핵심 아이디어: 선언과 조정 루프

Kubernetes 에게는 "이렇게 해라" 가 아니라 **"이런 상태여야 한다"** 를 알려 준다.

```yaml
# "nginx 1.27 컨테이너가 3개 떠 있어야 한다"
kind: Deployment
spec:
  replicas: 3
  template:
    spec:
      containers:
        - image: nginx:1.27
```

**컨트롤러**들이 끊임없이 "현재 상태 ≠ 원하는 상태?" 를 확인하고 차이를 메운다 (reconciliation loop). Pod 하나가 죽으면 3개가 아니니 하나를 더 만든다. 이것이 자가 치유(self-healing)의 원리다.

## 클러스터 아키텍처

```
┌─────────────── Control Plane ───────────────┐
│ kube-apiserver   모든 요청의 관문 (REST, 인증/인가) │
│ etcd             클러스터 상태 저장소 (key-value) │
│ kube-scheduler   새 Pod 을 어느 노드에 둘지 결정  │
│ controller-manager  Deployment·Node 등 컨트롤러 │
└──────────────────────┬──────────────────────┘
                       │ (kubelet 이 API 서버를 watch)
     ┌─────────────────┼─────────────────┐
┌────┴──── Node ────┐ ┌─┴──── Node ─────┐ ...
│ kubelet   Pod 실행·상태 보고             │
│ kube-proxy  Service 네트워킹 (iptables/ipvs) │
│ container runtime (containerd)         │
│   [Pod] [Pod] [Pod]                    │
└────────────────────┘
```

- `kubectl` 은 API 서버에 HTTP 요청을 보내는 클라이언트일 뿐이다. 모든 것이 API 오브젝트다.
- **etcd** 가 유일한 진실의 원천. 백업 대상은 etcd 다.
- 노드에서 실제 컨테이너를 돌리는 건 **containerd** (Docker 데몬이 아니다. Docker 로 빌드한 이미지는 OCI 표준이라 그대로 쓴다).

## 오브젝트 한눈에

| 오브젝트 | 역할 |
|---|---|
| **Pod** | 배포 최소 단위. 컨테이너 1개 이상 + 공유 네트워크·스토리지 |
| **Deployment** | 무상태 앱의 복제본 수·롤링 업데이트 관리 (ReplicaSet 을 거느림) |
| **StatefulSet** | 안정적 이름·스토리지가 필요한 앱 (DB, Redis) |
| **DaemonSet** | 모든 노드에 하나씩 (로그 수집기, 모니터링 에이전트) |
| **Job / CronJob** | 한 번 또는 주기적으로 끝나는 작업 |
| **Service** | Pod 집합에 대한 고정 주소·로드밸런싱 |
| **Ingress** | HTTP(S) 라우팅 (호스트·경로 → Service) |
| **ConfigMap / Secret** | 설정과 비밀값 |
| **PersistentVolume(Claim)** | 스토리지 |
| **Namespace** | 오브젝트를 묶는 가상 클러스터 |

## 매니페스트의 공통 구조

```yaml
apiVersion: apps/v1        # API 그룹/버전
kind: Deployment           # 오브젝트 종류
metadata:
  name: web
  namespace: study
  labels: { app: web }     # 선택(selector)의 기준
spec:                      # 원하는 상태 (내가 쓴다)
  ...
status:                    # 현재 상태 (시스템이 쓴다)
  ...
```

**레이블(label)** 이 모든 연결의 접착제다. Service 는 `selector: {app: web}` 로 Pod 을 찾고, Deployment 도 같은 방식으로 자기 Pod 을 관리한다.

## 실전에서는 어디에 쓰이나 — Kubernetes 지도

> Kubernetes 는 "컨테이너를 어디에, 몇 개, 어떤 설정으로 띄우고, 죽으면 되살린다" 를 선언으로 맡기는 플랫폼 계층이다. 실무에서는 앱 팀이 매니페스트를 내고, 플랫폼 팀이 클러스터와 그 위의 공통 도구(배포·관측·보안)를 운영하는 분업으로 나타난다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 커머스 API 서버 수십 개를 무중단 배포 | Deployment 롤링 업데이트·readinessProbe·롤백 | [Pod, ReplicaSet, Deployment](/kubernetes/notes/03-pod-deployment) |
| 마이크로서비스 간 호출과 외부 도메인 노출 | Service DNS, Ingress·Gateway API | [Service 와 Ingress](/kubernetes/notes/04-service-ingress) |
| 같은 이미지를 dev/stage/prod 에 다른 설정으로 | ConfigMap·Secret, Kustomize overlay | [ConfigMap 과 Secret](/kubernetes/notes/05-configmap-secret) |
| 사내 플랫폼에서 Postgres·Redis 를 셀프서비스로 | StatefulSet·PVC, Operator | [CRD 와 Operator](/kubernetes/notes/11-operators-crds) |
| 세일·이벤트 때 트래픽 급증 | requests 기반 HPA, KEDA, 노드 오토스케일 | [스케줄링·오토스케일링](/kubernetes/notes/14-scheduling-autoscaling-deep) |
| 장애 대응 중 "Pod 이 왜 안 뜨지" | describe → events → logs --previous 순서 | [운영과 디버깅](/kubernetes/notes/08-ops-debugging) |
| 클러스터·워크로드 모니터링과 알림 | kube-prometheus-stack, ServiceMonitor, Loki | [Kubernetes 관측](/kubernetes/notes/10-monitoring-stack) |
| 여러 팀·여러 클러스터 배포를 git 으로 통제 | ArgoCD, Argo Rollouts 카나리 | [GitOps 와 점진적 배포](/kubernetes/notes/13-gitops-progressive-delivery) |

**회사 규모에 따라**
- 스타트업: 클러스터를 직접 만들지 않고 관리형(EKS·GKE·AKS)을 쓰거나, 서비스가 몇 개뿐이면 Kubernetes 없이 PaaS·서버리스로 간다.
- 성장기: 관리형 클러스터 하나에 Helm/Kustomize, kube-prometheus-stack, ArgoCD 를 얹고 네임스페이스로 팀·환경을 나눈다.
- 대규모 조직: 플랫폼 팀이 리전·환경별 클러스터 여러 개를 운영하고, CRD·Operator 로 "서비스 하나 = 리소스 하나" 같은 내부 플랫폼을 만들어 앱 팀에 제공한다.

**이럴 땐 안 맞는다**
- 서비스 1~3개에 전담 운영 인력이 없다 → 클러스터 업그레이드·네트워크·보안 부담이 이득보다 크다. 관리형 컨테이너 서비스(ECS·Cloud Run)나 PaaS 가 낫다.
- 가끔 튀는 이벤트 처리 몇 개뿐이다 → 서버리스 함수가 더 싸고 단순하다.

**누가 매일 만나나** — 백엔드 개발자는 배포가 실패할 때 `kubectl describe`·`logs` 를 친다. 플랫폼·SRE 엔지니어는 클러스터 업그레이드, 노드 풀, 배포·관측 도구를 운영한다. ML 엔지니어는 GPU 노드에 학습·추론 워크로드를 올릴 때 만난다.

## 이 노트 시리즈의 실습

로컬에서 **kind**(Kubernetes in Docker) 로 1노드 클러스터를 만들고, 이 프로젝트의 Redis 를 배포하며 오브젝트를 하나씩 익힌다.

```bash
brew install kubectl kind      # Docker 가 실행 중이어야 한다
pnpm k8s:cluster               # kind create cluster --name study
kubectl get nodes
```

대시보드의 클러스터 점검 카드가 노드와 Pod 상태를 보여 준다.

> 이어서 읽기: [로컬 클러스터와 kubectl](/kubernetes/notes/02-local-cluster-kubectl) — 바로 다음: 로컬 클러스터와 kubectl · [Docker 란 무엇인가](/docker/notes/01-docker-overview) — 컨테이너 기초가 필요하면
