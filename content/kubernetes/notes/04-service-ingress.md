---
title: Service 와 Ingress
order: 4
level: 기초
summary: Pod 의 바뀌는 IP 를 감추는 Service 의 네 가지 타입, 클러스터 DNS, HTTP 라우팅을 맡는 Ingress
tags: [Service, ClusterIP, NodePort, LoadBalancer, DNS, Ingress]
experiments: [k8s-service-endpoints]
---

## 문제: Pod IP 는 계속 바뀐다

Deployment 가 Pod 을 재생성할 때마다 IP 가 달라진다. 다른 앱이 Redis Pod 의 IP 를 직접 알고 있으면 곧 깨진다.
**Service** 는 레이블 셀렉터로 Pod 집합을 고르고, 바뀌지 않는 **가상 IP(ClusterIP)와 DNS 이름**을 준다.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: study
spec:
  selector: { app: redis }     # 이 레이블을 가진 Ready 상태 Pod 들로
  ports:
    - port: 6379               # Service 포트
      targetPort: 6379         # 컨테이너 포트 (이름도 가능)
```

```bash
kubectl get svc -n study
kubectl get endpoints redis -n study      # 실제로 연결된 Pod IP 목록 (readiness 통과한 것만)
kubectl describe svc redis -n study
```

## 클러스터 DNS

같은 네임스페이스에선 `redis`, 다른 네임스페이스에선 `redis.study`, 완전한 이름은 `redis.study.svc.cluster.local`.
CoreDNS 가 Service 마다 레코드를 만든다.

```bash
kubectl run -it --rm dns-test --image=busybox:1.36 -n study -- nslookup redis
kubectl run -it --rm cli --image=redis:8-alpine -n study -- redis-cli -h redis ping
```

애플리케이션 설정에는 IP 가 아니라 `redis://redis.study:6379` 처럼 **DNS 이름**을 쓴다.

## Service 타입

| 타입 | 접근 범위 | 용도 |
|---|---|---|
| `ClusterIP` (기본) | 클러스터 내부만 | 내부 서비스 간 통신 (DB, 캐시, 백엔드) |
| `NodePort` | 모든 노드의 `<NodeIP>:30000-32767` | 간단한 외부 노출, 테스트 |
| `LoadBalancer` | 클라우드 LB 의 외부 IP | 운영에서 외부 노출 (AWS ELB, GCP LB) |
| `ExternalName` | DNS CNAME | 외부 서비스를 내부 이름으로 |

`LoadBalancer` 는 클라우드가 LB 를 만들어 준다. kind 같은 로컬에선 `EXTERNAL-IP` 가 `<pending>` 으로 남는다 (MetalLB 나 `cloud-provider-kind` 로 해결 가능).

**Headless Service** (`clusterIP: None`): 가상 IP 없이 DNS 가 Pod IP 들을 직접 돌려준다. StatefulSet 이 `redis-0.redis` 같은 Pod 별 이름을 갖기 위해 쓴다.

## 로컬에서 접근: port-forward

개발 중엔 NodePort 대신 포트 포워딩이 편하다.

```bash
pnpm k8s:port          # kubectl -n study port-forward svc/redis 6379:6379
redis-cli ping         # 다른 터미널에서. 6379 를 쓰는 다른 Redis 는 꺼 둘 것
```

이 상태에서 Redis Study 의 대시보드·실험실이 클러스터 안의 Redis 에 그대로 붙는다.

## Ingress

HTTP/HTTPS 를 **호스트·경로 기준으로 Service 에 라우팅**한다. Ingress 리소스는 규칙일 뿐이고, 실제 동작은 **Ingress Controller**(nginx, traefik, 클라우드 ALB)가 한다. 컨트롤러가 없으면 아무 일도 일어나지 않는다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
    - host: study.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: web, port: { number: 80 } }
  tls:
    - hosts: [study.local]
      secretName: study-tls
```

kind 에서 nginx ingress 를 쓰려면 클러스터 생성 시 80/443 포트를 노드에 매핑하는 설정이 필요하다 (kind 공식 문서 "Ingress" 항목).

**Gateway API** 가 Ingress 의 후속 표준으로 자리잡고 있다 (GatewayClass, Gateway, HTTPRoute). 새 프로젝트라면 살펴볼 것.

## 네트워크 모델 요약

- 모든 Pod 은 NAT 없이 서로 통신할 수 있는 고유 IP 를 가진다 (CNI 플러그인이 구현: kind 는 kindnet, 운영에선 Calico/Cilium).
- `kube-proxy` 가 각 노드에 Service → Pod 규칙(iptables/IPVS)을 설치한다.
- **NetworkPolicy** 로 Pod 간 트래픽을 제한할 수 있다 (CNI 가 지원해야 함). 기본은 전부 허용.

## 실습 체크리스트

- [ ] `kubectl get endpoints redis` 로 Service 가 가리키는 Pod IP 확인
- [ ] Pod 을 지우고 endpoints 가 새 IP 로 바뀌는 것 확인
- [ ] 임시 Pod 에서 `redis-cli -h redis ping`
- [ ] `pnpm k8s:port` 후 Redis 대시보드가 클러스터 Redis 를 보여 주는지 확인
