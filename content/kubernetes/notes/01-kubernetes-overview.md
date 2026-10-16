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

## 이 노트 시리즈의 실습

로컬에서 **kind**(Kubernetes in Docker) 로 1노드 클러스터를 만들고, 이 프로젝트의 Redis 를 배포하며 오브젝트를 하나씩 익힌다.

```bash
brew install kubectl kind      # Docker 가 실행 중이어야 한다
pnpm k8s:cluster               # kind create cluster --name study
kubectl get nodes
```

대시보드의 클러스터 점검 카드가 노드와 Pod 상태를 보여 준다.

> 이어서 읽기: [로컬 클러스터와 kubectl](/kubernetes/notes/02-local-cluster-kubectl) — 바로 다음: 로컬 클러스터와 kubectl · [Docker 란 무엇인가](/docker/notes/01-docker-overview) — 컨테이너 기초가 필요하면

