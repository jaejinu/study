---
title: 운영과 디버깅
order: 8
level: 심화
summary: 문제가 생겼을 때 보는 순서(describe·events·logs), 임시 디버그 컨테이너, RBAC 기본, 자주 겪는 장애와 해법
tags: [describe, events, logs, debug, RBAC, 트러블슈팅]
experiments: []
---

## 디버깅 순서

```bash
kubectl get pods -n study                         # 1. 상태 (Running? Ready 1/1?)
kubectl describe pod redis-0 -n study             # 2. 이벤트 (맨 아래): 스케줄 실패, pull 실패, probe 실패
kubectl get events -n study --sort-by=.lastTimestamp   # 3. 네임스페이스 전체 이벤트
kubectl logs redis-0 -n study                     # 4. 현재 컨테이너 로그
kubectl logs redis-0 -n study --previous          #    죽기 전 컨테이너 로그 (CrashLoopBackOff 필수)
kubectl logs -n study -l app=redis --all-containers -f --tail=100
kubectl exec -it redis-0 -n study -- sh           # 5. 안에서 확인
```

## 증상별 원인

| 증상 | 흔한 원인 | 확인 |
|---|---|---|
| `Pending` | 리소스 부족, PVC 미바인딩, nodeSelector/taint 불일치 | `describe pod` 의 FailedScheduling 메시지 |
| `ImagePullBackOff` | 태그 오타, 사설 레지스트리 인증 없음 | 이미지 이름, `imagePullSecrets` |
| `CrashLoopBackOff` | 앱 시작 실패, 설정 오류, 잘못된 command | `logs --previous`, `describe` 의 Last State |
| `OOMKilled` | 메모리 limit 초과 | `describe` 의 Last State: Reason, limit 상향 |
| Running 인데 `0/1` Ready | readinessProbe 실패 | probe 경로/포트, 앱 시작 시간 → `startupProbe` |
| Service 로 접속 안 됨 | selector 불일치, Pod 이 Ready 아님, 포트 번호 | `get endpoints`, 레이블 비교 |
| 재시작 반복 (Running) | livenessProbe 너무 공격적 | `describe` 의 Liveness 실패 이벤트 |
| `Terminating` 에서 안 지워짐 | finalizer, 노드 다운 | `describe`, 최후엔 `--force --grace-period=0` |
| ConfigMap 바꿨는데 반영 안 됨 | 환경 변수는 재시작 필요, subPath 마운트 | `rollout restart` |

## 디버그 컨테이너

셸이 없는 distroless 이미지나 이미 죽은 컨테이너를 들여다볼 때:

```bash
# 실행 중인 Pod 에 디버그 컨테이너를 붙인다 (프로세스 네임스페이스 공유)
kubectl debug -it redis-0 -n study --image=nicolaka/netshoot --target=redis
# 죽은 Pod 을 복제해 command 를 바꿔 띄운다
kubectl debug redis-0 -n study --copy-to=redis-debug --container=redis -- sh
# 노드 자체를 조사
kubectl debug node/study-control-plane -it --image=ubuntu
```

```bash
kubectl cp study/redis-0:/data/dump.rdb ./dump.rdb        # 파일 꺼내기
kubectl port-forward pod/redis-0 6380:6379 -n study
kubectl top pod -n study                                  # metrics-server 필요
```

## 노드 관리

```bash
kubectl get nodes -o wide
kubectl describe node study-control-plane      # 조건(MemoryPressure, DiskPressure), 할당량, 올라간 Pod
kubectl cordon <node>                           # 새 Pod 스케줄 금지
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data   # Pod 을 다른 노드로 (점검 전)
kubectl uncordon <node>
```

**Taint/Toleration** 으로 특정 노드(GPU, 스팟)에 특정 Pod 만, **nodeAffinity/podAntiAffinity** 로 배치 규칙(같은 앱을 다른 노드에 분산).

## RBAC 기본

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role                          # 네임스페이스 범위 (ClusterRole 은 전체)
metadata: { name: pod-reader, namespace: study }
rules:
  - apiGroups: [""]
    resources: [pods, pods/log]
    verbs: [get, list, watch]
---
kind: RoleBinding
metadata: { name: dev-pod-reader, namespace: study }
subjects:
  - kind: User
    name: dev@example.com
roleRef: { kind: Role, name: pod-reader, apiGroup: rbac.authorization.k8s.io }
```

```bash
kubectl auth can-i delete pods -n study
kubectl auth can-i --list -n study
kubectl auth can-i get secrets --as=dev@example.com -n study
```

Pod 이 API 를 호출해야 하면 **ServiceAccount** 에 Role 을 바인딩한다. 기본 ServiceAccount 에 권한을 주지 말 것.

## 관측 가능성 스택

- 메트릭: **metrics-server**(HPA/top 용) → **Prometheus** + Grafana (kube-prometheus-stack 차트)
- 로그: 컨테이너 stdout → Fluent Bit/Promtail → Loki/Elasticsearch
- 트레이싱: OpenTelemetry Collector → Tempo/Jaeger
- 대시보드/CLI: **k9s** (터미널 UI, 강력 추천), Lens, Headlamp

```bash
brew install k9s && k9s -n study
```

## 안전한 운영 습관

- `kubectl diff` 로 적용 전 변경점 확인. `--dry-run=server` 로 검증.
- 운영 컨텍스트에서는 `delete` 전에 `get` 으로 범위 확인. 레이블 셀렉터 삭제는 특히 조심.
- 모든 워크로드에 requests/limits, readinessProbe, PodDisruptionBudget.
- 이미지 태그 `latest` 금지. `imagePullPolicy: IfNotPresent` 와 조합하면 노드마다 다른 버전이 돈다.
- 네임스페이스로 환경·팀을 나누고 ResourceQuota 를 건다.

## 더 공부할 것

- 공식 문서 "Concepts" 와 "Tasks" (가장 정확하다)
- CKA/CKAD 커리큘럼 — 실습 중심 로드맵으로 좋다
- "Kubernetes in Action" (Marko Lukša)
- Operator 패턴과 CRD — 자신의 리소스 타입 정의하기
- 서비스 메시(Istio, Linkerd), Gateway API, Cilium

## 실습 체크리스트

- [ ] 일부러 `image: redis:nope` 로 바꿔 ImagePullBackOff 를 만들고 `describe` → 고치기
- [ ] readinessProbe 포트를 틀리게 바꿔 `0/1` 상태와 endpoints 비는 것 확인
- [ ] `kubectl debug` 로 netshoot 을 붙여 `nc -zv redis 6379`
- [ ] `k9s` 로 네임스페이스 둘러보기
