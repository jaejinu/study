---
title: 로컬 클러스터와 kubectl
order: 2
level: 기초
summary: kind·minikube·Docker Desktop 비교, kubectl 의 기본 동사와 출력 형식, 컨텍스트·네임스페이스 다루기
tags: [kind, minikube, kubectl, context, namespace]
experiments: [k8s-scale]
---

## 로컬 클러스터 선택지

| 도구 | 방식 | 장점 | 단점 |
|---|---|---|---|
| **kind** | Docker 컨테이너를 노드로 | 가볍고 빠름, 멀티노드 가능, CI 친화 | LoadBalancer 타입 Service 는 추가 설정 |
| minikube | VM 또는 Docker 드라이버 | 애드온 풍부 (ingress, dashboard) | 상대적으로 무거움 |
| Docker Desktop | 설정에서 Kubernetes 켜기 | 설치 없음 | 1노드 고정, 리소스 많이 씀 |
| k3d | k3s 를 Docker 에 | 매우 가벼움 | k3s 차이점 존재 |

이 프로젝트는 **kind** 를 쓴다.

```bash
pnpm k8s:cluster                 # kind create cluster --name study --wait 120s
kind get clusters
kubectl cluster-info
kubectl get nodes -o wide
pnpm k8s:cluster:down            # 전부 삭제
```

kind 는 `kubectl` 의 kubeconfig(`~/.kube/config`)에 `kind-study` 컨텍스트를 자동으로 추가한다.

## kubectl 의 문법

```
kubectl <동사> <리소스> [이름] [옵션]
```

| 동사 | 설명 |
|---|---|
| `get` | 목록·요약 |
| `describe` | 상세 + **이벤트** (문제 진단의 출발점) |
| `apply -f` | 매니페스트를 선언적으로 적용 (생성·갱신) |
| `delete` | 삭제 |
| `logs` | 컨테이너 로그 |
| `exec` | 컨테이너 안에서 명령 실행 |
| `port-forward` | 로컬 포트 → Pod/Service |
| `rollout` | Deployment/StatefulSet 배포 상태·되돌리기 |
| `scale` | 복제본 수 변경 |
| `explain` | 필드 문서 (`kubectl explain deployment.spec.strategy`) |

```bash
kubectl get pods                         # 현재 네임스페이스
kubectl get pods -A                      # 모든 네임스페이스
kubectl get pods -n study -o wide        # 노드·IP 포함
kubectl get pod redis-0 -n study -o yaml # 전체 정의 (status 포함)
kubectl get all -n study                 # pod, svc, deploy, sts ...
kubectl get pods -l app=redis            # 레이블 선택
kubectl get pods -w                      # 변화 실시간 감시
kubectl describe pod redis-0 -n study    # 이벤트는 맨 아래
```

리소스 이름은 단수·복수·약어 모두 된다: `pods`, `pod`, `po`; `services`, `svc`; `deployments`, `deploy`; `statefulsets`, `sts`; `configmaps`, `cm`; `persistentvolumeclaims`, `pvc`; `namespaces`, `ns`.

## 출력 형식과 JSONPath

```bash
kubectl get nodes -o json | jq '.items[].status.nodeInfo.kubeletVersion'
kubectl get pod redis-0 -n study -o jsonpath='{.status.podIP}'
kubectl get pods -n study -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,NODE:.spec.nodeName
kubectl get pods -A --sort-by=.metadata.creationTimestamp
```

대시보드의 클러스터 카드는 `kubectl get nodes -o json`, `get pods -A -o json` 을 파싱해서 만든다.

## 컨텍스트와 네임스페이스

```bash
kubectl config get-contexts              # 어떤 클러스터·사용자·네임스페이스 조합인지
kubectl config current-context
kubectl config use-context kind-study
kubectl config set-context --current --namespace=study   # 기본 네임스페이스 변경
kubectl create namespace study
kubectl get ns
```

운영 클러스터 컨텍스트가 섞여 있으면 `kubectl delete` 사고가 난다. 프롬프트에 현재 컨텍스트를 표시하는 `kube-ps1` 이나 `kubectx`/`kubens` 를 쓰자.

```bash
brew install kubectx            # kubectx 로 컨텍스트, kubens 로 네임스페이스 전환
```

## 명령형 vs 선언형

```bash
# 명령형: 빠르게 실험할 때
kubectl run tmp --image=redis:8-alpine --rm -it -- redis-cli -h redis ping
kubectl create deployment web --image=nginx:1.27 --replicas=2
kubectl expose deployment web --port=80

# 선언형: 실제 작업은 항상 파일로 (git 에 남는다)
kubectl apply -f k8s/redis.yaml
kubectl diff -f k8s/redis.yaml          # 적용 전 변경점 미리보기
kubectl apply -k k8s                    # kustomize 디렉터리
kubectl delete -f k8s/redis.yaml
```

`--dry-run=client -o yaml` 은 명령형으로 매니페스트 초안을 뽑는 좋은 방법이다.

```bash
kubectl create deployment web --image=nginx:1.27 --dry-run=client -o yaml > web.yaml
```

## 실습 체크리스트

- [ ] `pnpm k8s:cluster` 후 `kubectl get nodes` 에서 Ready 확인
- [ ] `kubectl get pods -A` 로 시스템 Pod(kube-system) 둘러보기
- [ ] `kubectl explain pod.spec.containers` 로 필드 문서 읽기
- [ ] `kubectl run` 으로 임시 Pod 을 띄우고 `--rm` 으로 사라지는지 확인
