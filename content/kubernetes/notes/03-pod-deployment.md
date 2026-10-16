---
title: Pod, ReplicaSet, Deployment
order: 3
level: 기초
summary: Pod 의 구조와 생명주기, 왜 Pod 을 직접 만들지 않는지, Deployment 의 롤링 업데이트와 롤백
tags: [Pod, ReplicaSet, Deployment, rollout, probe]
experiments: [k8s-self-healing, k8s-scale, k8s-rolling-update, k8s-broken-image]
---

## Pod

하나 이상의 컨테이너가 **같은 네트워크 네임스페이스(IP·포트 공유)와 볼륨**을 공유하는 단위.
대부분 Pod 하나 = 컨테이너 하나. 로그 수집기나 프록시를 붙이는 **사이드카** 패턴일 때 둘 이상.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: redis-test
  labels: { app: redis }
spec:
  containers:
    - name: redis
      image: redis:8-alpine
      ports: [{ containerPort: 6379 }]
      resources:
        requests: { cpu: 50m, memory: 64Mi }
        limits: { memory: 256Mi }
  restartPolicy: Always
```

```bash
kubectl apply -f pod.yaml
kubectl get pod redis-test -o wide
kubectl logs redis-test
kubectl exec -it redis-test -- redis-cli ping
kubectl delete pod redis-test
```

### Pod 생명주기

`Pending` (스케줄·이미지 pull) → `Running` → `Succeeded` / `Failed`. 자주 보는 중간 상태:

| 상태 | 의미 |
|---|---|
| `ContainerCreating` | 이미지 pull, 볼륨 마운트 중 |
| `ImagePullBackOff` | 이미지 이름/태그 오류 또는 레지스트리 인증 실패 |
| `CrashLoopBackOff` | 컨테이너가 계속 죽어서 재시작 간격을 늘리는 중 → `logs --previous` |
| `Pending` 지속 | 리소스 부족, PVC 바인딩 실패, 노드 셀렉터 불일치 → `describe` |
| `OOMKilled` | 메모리 limit 초과 |

**Pod 은 일회용**이다. 죽으면 새 IP 로 새 Pod 이 만들어진다. 그래서 Pod 을 직접 만들지 않고 컨트롤러에 맡긴다.

## ReplicaSet

"레이블이 X 인 Pod 이 N 개 있어야 한다" 를 유지한다. 직접 쓰는 일은 거의 없고 Deployment 가 만든다.

## Deployment

무상태 애플리케이션의 표준. ReplicaSet 을 버전별로 만들어 **롤링 업데이트**와 **롤백**을 제공한다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels: { app: web }
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1            # 업데이트 중 최대 초과 Pod 수
      maxUnavailable: 0      # 업데이트 중 최소 가용 보장
  template:                  # ← 여기가 Pod 템플릿
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports: [{ containerPort: 80 }]
          readinessProbe:
            httpGet: { path: /, port: 80 }
            periodSeconds: 5
```

```bash
kubectl apply -f web.yaml
kubectl get deploy,rs,pods -l app=web
kubectl scale deploy web --replicas=5
kubectl set image deploy/web web=nginx:1.28       # 롤링 업데이트 시작
kubectl rollout status deploy/web
kubectl rollout history deploy/web
kubectl rollout undo deploy/web                     # 이전 버전으로
kubectl rollout undo deploy/web --to-revision=1
kubectl rollout restart deploy/web                  # 같은 이미지로 재시작 (ConfigMap 변경 반영 등)
```

롤링 업데이트는 새 ReplicaSet 을 만들어 Pod 을 하나씩 늘리고 옛 ReplicaSet 을 줄인다. `readinessProbe` 가 있어야 "준비된" Pod 에만 트래픽이 가고 무중단이 된다.

## Probe 세 가지

| Probe | 실패하면 | 용도 |
|---|---|---|
| `startupProbe` | 성공할 때까지 다른 probe 를 미룸 | 느리게 뜨는 앱 |
| `readinessProbe` | Service 엔드포인트에서 제외 (재시작 안 함) | 트래픽 받을 준비 여부 |
| `livenessProbe` | 컨테이너 재시작 | 데드락 등 회복 불가 상태 |

```yaml
livenessProbe:
  exec: { command: [redis-cli, ping] }
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  tcpSocket: { port: 6379 }
```

liveness 를 너무 공격적으로 두면 일시적 부하에도 재시작 폭풍이 난다. readiness 를 먼저, liveness 는 보수적으로.

## 실습: Pod 이 죽어도 살아나는지

```bash
kubectl create deployment web --image=nginx:1.27 --replicas=2 -n study
kubectl get pods -n study -l app=web -w          # 다른 터미널에서 감시
kubectl delete pod -n study -l app=web --wait=false   # 전부 지워 보기
# → 곧바로 새 Pod 2개가 생긴다 (ReplicaSet 이 조정)
kubectl set image deploy/web nginx=nginx:1.28 -n study
kubectl rollout status deploy/web -n study
kubectl rollout undo deploy/web -n study
kubectl delete deploy web -n study
```

## 실습 체크리스트

- [ ] Pod 을 직접 만들고 지우면 다시 안 생기는 것 확인
- [ ] Deployment 의 Pod 을 지우면 다시 생기는 것 확인
- [ ] 이미지 태그를 바꿔 롤링 업데이트 → `rollout history` → `undo`
- [ ] 일부러 잘못된 이미지 태그를 넣어 `ImagePullBackOff` 를 보고 `describe` 로 원인 읽기
