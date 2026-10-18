---
title: minikube 와 애드온 — Ingress·metrics-server·HPA 실습
order: 9
level: 중급
summary: kind 와 다른 두 번째 로컬 클러스터. 애드온 한 줄로 Ingress 컨트롤러와 metrics-server 를 켜고, HPA 오토스케일링과 Ingress 라우팅을 실제로 돌려 본다
tags: [minikube, addons, ingress, metrics-server, HPA, kubectl top]
experiments: [k8s-hpa-autoscale, k8s-scale]
---

## kind 옆에 minikube 를 두는 이유

| | kind | minikube |
|---|---|---|
| 노드 | Docker 컨테이너 | Docker 컨테이너(driver=docker) 또는 VM |
| 시작 | 수십 초 | 1~2분 |
| 애드온 | 직접 설치 (매니페스트/Helm) | `minikube addons enable ingress` 한 줄 |
| LoadBalancer | 미지원(pending) | `minikube tunnel` 로 지원 |
| 대시보드 | 없음 | `minikube dashboard` |
| 용도 | CI, 빠른 반복 | 애드온 실습, 튜토리얼 따라하기 |

둘은 컨텍스트가 다르므로(`kind-study`, `study`) 공존한다. `kubectl config use-context` 로 전환하면 사이트의 Kubernetes 대시보드와 실험실이 그 클러스터를 본다.

```bash
pnpm k8s:minikube            # minikube start --profile study --driver=docker + addons(metrics-server, ingress)
kubectl config get-contexts  # kind-study, study
kubectl config use-context study
minikube status --profile study
minikube dashboard --profile study      # 웹 UI
pnpm k8s:minikube:down
```

> 메모리 주의: Docker Desktop 에 kind + minikube + Kafka + Postgres 를 모두 띄우면 수 GB 가 든다. 안 쓰는 것은 내린다.

## 애드온

```bash
minikube addons list --profile study
minikube addons enable metrics-server --profile study   # kubectl top, HPA
minikube addons enable ingress --profile study          # ingress-nginx 컨트롤러
minikube addons enable dashboard --profile study
minikube addons enable registry --profile study         # 로컬 이미지 레지스트리
```

kind 에서 같은 것을 하려면: metrics-server 는 `pnpm k8s:metrics`(이 프로젝트가 `--kubelet-insecure-tls` 패치를 포함), ingress-nginx 는 `kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml` (클러스터 생성 시 80/443 포트 매핑 필요).

## metrics-server 와 kubectl top

metrics-server 는 각 노드 kubelet 의 cAdvisor 에서 CPU·메모리를 모아 `metrics.k8s.io` API 로 제공한다. 15초 해상도의 "현재값" 만 있고 저장하지 않는다 — 시계열은 Prometheus 의 일이다.

```bash
kubectl top nodes
kubectl top pods -A --sort-by=cpu
kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes | jq
```

## HPA 실습

![HPA 조정 루프](/diagrams/hpa-loop.svg)

```bash
kubectl -n study create deployment hpa-demo --image=registry.k8s.io/hpa-example --port=80
kubectl -n study set resources deploy/hpa-demo --requests=cpu=100m --limits=cpu=300m   # requests 없으면 HPA 는 <unknown>
kubectl -n study expose deploy/hpa-demo --port=80
kubectl -n study autoscale deploy/hpa-demo --cpu-percent=50 --min=1 --max=5
kubectl -n study get hpa -w
# 다른 터미널: 부하
kubectl -n study run load --rm -it --image=busybox:1.36 --restart=Never -- /bin/sh -c "while true; do wget -q -O- http://hpa-demo; done"
```

관찰 포인트:
1. 처음 30~60초는 TARGETS 가 `<unknown>/50%` — metrics-server 가 샘플을 모으는 시간.
2. 부하 후 사용률이 200~300% 로 뛰면 REPLICAS 가 1 → 4~5 로 **한 번에** 뛴다 (계산식: ceil(1 × 250/50) = 5).
3. 부하를 끄면 사용률은 바로 떨어지지만 REPLICAS 는 **5분 안정화 창** 뒤에 줄어든다. `behavior.scaleDown.stabilizationWindowSeconds` 로 조정.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: hpa-demo }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: hpa-demo }
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 50 } }
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 60
      policies: [{ type: Percent, value: 50, periodSeconds: 30 }]   # 30초마다 최대 절반씩
    scaleUp:
      policies: [{ type: Pods, value: 2, periodSeconds: 15 }]       # 15초마다 최대 2개씩
```

실험실의 **HPA** 실험이 이 과정을 자동으로 돌리고 HPA 이벤트를 보여준다 (kind 는 `pnpm k8s:metrics` 선행).

### CPU 말고 다른 지표로

- 메모리: `resource: memory` — 단, 많은 런타임(JVM, Node)은 메모리를 반납하지 않아 스케일 인이 안 된다.
- 커스텀 메트릭(큐 길이, RPS): Prometheus Adapter 로 `custom.metrics.k8s.io` 제공, 또는 **KEDA**(이벤트 기반, Kafka LAG·Redis 리스트 길이·cron 등 60+ 스케일러, 0 으로 스케일 가능).

```yaml
# KEDA ScaledObject 예: Redis 리스트 길이로 워커 스케일
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
spec:
  scaleTargetRef: { name: worker }
  minReplicaCount: 0
  triggers:
    - type: redis
      metadata: { address: redis.study:6379, listName: jobs, listLength: "10" }
```

## Ingress 실습 (minikube)

```bash
kubectl config use-context study
kubectl -n study create deployment web-a --image=nginx:1.27-alpine --port=80
kubectl -n study create deployment web-b --image=httpd:2.4-alpine --port=80
kubectl -n study expose deploy/web-a --port=80 ; kubectl -n study expose deploy/web-b --port=80
cat <<'YAML' | kubectl -n study apply -f -
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo
  annotations: { nginx.ingress.kubernetes.io/rewrite-target: / }
spec:
  ingressClassName: nginx
  rules:
    - host: study.local
      http:
        paths:
          - { path: /a, pathType: Prefix, backend: { service: { name: web-a, port: { number: 80 } } } }
          - { path: /b, pathType: Prefix, backend: { service: { name: web-b, port: { number: 80 } } } }
YAML
kubectl -n study get ingress demo          # ADDRESS 가 뜰 때까지 수십 초
minikube ip --profile study                # 예 192.168.49.2  (docker 드라이버 + macOS 는 tunnel 필요)
minikube tunnel --profile study            # macOS: 별도 터미널, sudo 요청. 127.0.0.1 로 80/443 노출
curl -H 'Host: study.local' http://127.0.0.1/a     # nginx 환영 페이지
curl -H 'Host: study.local' http://127.0.0.1/b     # "It works!"
```

Ingress 컨트롤러는 사실 **Nginx** 다 ([Nginx 노트](/nginx/notes/02-reverse-proxy-lb)). `kubectl -n ingress-nginx exec deploy/ingress-nginx-controller -- cat /etc/nginx/nginx.conf` 로 생성된 설정을 볼 수 있다 — Ingress 리소스가 server/location 블록으로 번역되어 있다.

## minikube 의 다른 유용한 기능

```bash
minikube image load study:dev --profile study     # 로컬 이미지 넣기 (kind load 와 같음)
eval $(minikube docker-env --profile study)        # 이 셸의 docker 명령을 minikube 안 데몬으로 → build 하면 바로 사용 가능
minikube service web -n study --profile study      # NodePort/LB 서비스를 브라우저로
minikube ssh --profile study                       # 노드 안으로
minikube logs --profile study
minikube node add --profile study                  # 멀티노드
```

## 실전에서는 어디에 쓰이나

> 이 실습의 애드온(Ingress Controller, metrics-server)은 운영 클러스터라면 거의 반드시 깔려 있는 기본 부품이다. 실무에서는 "HPA 가 왜 안 늘어나지", "Ingress 경로가 왜 안 맞지" 라는 질문으로 다시 만난다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 신규 서비스 오토스케일 설정 | HPA 가 `<unknown>` 으로 멈춤 | metrics-server 동작과 requests 설정 확인 | 고정 복제본 |
| 미디어 인코딩 같은 비동기 워커 | 일이 없으면 0, 쌓이면 N | KEDA ScaledObject(Redis 리스트·Kafka LAG), `minReplicaCount: 0` | CPU HPA — 큐 적체를 못 본다 |
| 트래픽이 짧게 출렁이는 API | 늘었다 줄었다 반복(flapping) | `behavior` 의 안정화 창·스케일 정책 | 최소 복제본을 넉넉히 |
| 사내 교육·핸즈온 | 애드온이 갖춰진 실습 환경을 빠르게 | `minikube addons enable ingress metrics-server dashboard` | kind + 직접 설치 |

**이럴 땐 안 맞는다**
- `kubectl top` 으로 지난 추세 보기 → metrics-server 는 현재값만 있고 저장하지 않는다. 추세는 Prometheus.
- minikube 를 CI 클러스터로 → 상대적으로 무겁고 느리다. CI 는 kind.

**누가 매일 만나나** — 백엔드는 부하 테스트 중 HPA 가 반응하지 않을 때, 플랫폼 팀은 클러스터 기본 애드온 구성과 KEDA 도입을 정할 때 만난다.

**면접·실무 단골 질문**
- Q. HPA 는 복제본 수를 어떻게 정하나? → ceil(현재 복제본 × 현재 사용률 ÷ 목표 사용률). 사용률은 requests 대비이고, 스케일 다운은 안정화 창(기본 5분) 뒤에 한다.

## 실습 체크리스트

- [ ] `pnpm k8s:minikube` 후 두 컨텍스트 사이를 전환하며 대시보드 카드가 바뀌는지 확인
- [ ] `kubectl top pods -A` 에서 가장 CPU 를 쓰는 Pod 찾기
- [ ] HPA 실험을 돌리고 부하 종료 후 5분 뒤 복제본이 줄어드는지 `get hpa -w` 로 보기
- [ ] `behavior.scaleDown.stabilizationWindowSeconds: 30` 으로 바꿔 빨라지는지 확인
- [ ] Ingress 로 /a, /b 라우팅 후 컨트롤러의 nginx.conf 읽기
