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

## 요청이 Pod 에 닿기까지

![Ingress → Service → EndpointSlice → Pod](/diagrams/k8s-request-path.svg)

Service 는 **L4** 다. 가상 IP 로 온 연결을 각 노드의 kube-proxy 규칙(iptables/IPVS)이 Ready 인 Pod IP 하나로 바꿔 줄 뿐, HTTP 재시도·타임아웃·캐시는 하지 않는다. 그런 L7 일은 Ingress controller(ingress-nginx 는 [Nginx](/nginx/notes/01-nginx-overview) 그 자체다)나 서비스 메시, 앱이 한다 — [Nginx 의 업스트림 장애 전환 실험](/nginx/notes/02-reverse-proxy-lb)이 그 L7 재시도를 보여 준다. 서비스 이름 해석은 CoreDNS 가 한다([Linux 네트워크: DNS](/linux-network/notes/03-dns)). kube-proxy 를 eBPF 로 대체하면 무엇이 바뀌는지는 [eBPF 노트 04](/ebpf/notes/04-networking-xdp-tc-cilium)에 있다.

## 네트워크 모델 요약

- 모든 Pod 은 NAT 없이 서로 통신할 수 있는 고유 IP 를 가진다 (CNI 플러그인이 구현: kind 는 kindnet, 운영에선 Calico/Cilium).
- `kube-proxy` 가 각 노드에 Service → Pod 규칙(iptables/IPVS)을 설치한다.
- **NetworkPolicy** 로 Pod 간 트래픽을 제한할 수 있다 (CNI 가 지원해야 함). 기본은 전부 허용.

## 실전에서는 어디에 쓰이나

> Pod IP 는 계속 바뀌므로 서비스 간 호출과 외부 노출은 전부 Service·Ingress 를 거친다. "접속이 안 된다" 장애의 상당수가 이 계층(셀렉터·endpoints·DNS·Ingress 규칙)에서 난다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 마이크로서비스 커머스 | 주문 서비스가 재고 서비스를 IP 없이 호출 | `http://inventory.shop:8080` 같은 Service DNS, ClusterIP | 별도 서비스 레지스트리(Consul 등) |
| 멀티 도메인 SaaS | `api.`·`app.`·`admin.` 을 LB 하나로 | Ingress Controller 하나 + 호스트·경로 규칙, TLS Secret | 서비스마다 LoadBalancer — LB 비용이 서비스 수만큼 |
| 공공·사내 시스템 | 클러스터 밖 레거시 DB 를 내부 이름으로 | ExternalName Service | 앱 설정에 외부 주소 하드코딩 |
| Redis Sentinel·Kafka 같은 상태 있는 클러스터 | 클라이언트가 특정 노드(Pod)를 직접 지목 | Headless Service 로 Pod 별 DNS | 일반 ClusterIP — 아무 Pod 에나 붙는다 |

**이럴 땐 안 맞는다**
- Service 에 재시도·타임아웃을 기대 → L4 라서 하지 않는다. Ingress Controller·서비스 메시·앱 라이브러리에서 한다.
- 오래 유지되는 gRPC(HTTP/2) 연결의 부하 분산 → Service 는 연결 단위로 나눠서 한 Pod 에 요청이 몰린다. L7 프록시(Envoy·메시)나 클라이언트 측 분산을 쓴다.

**누가 매일 만나나** — 백엔드는 접속 실패 시 `kubectl get endpoints` 로 셀렉터·readiness 부터 확인한다. 플랫폼 팀은 Ingress Controller 운영, 인증서, Gateway API 전환을 맡는다.

**면접·실무 단골 질문**
- Q. Service 는 있는데 접속이 안 된다면? → endpoints 가 비었는지(셀렉터 불일치·readiness 실패) → DNS 이름 → 포트·targetPort → NetworkPolicy 순으로 좁힌다.

## 실습 체크리스트

- [ ] `kubectl get endpoints redis` 로 Service 가 가리키는 Pod IP 확인
- [ ] Pod 을 지우고 endpoints 가 새 IP 로 바뀌는 것 확인
- [ ] 임시 Pod 에서 `redis-cli -h redis ping`
- [ ] `pnpm k8s:port` 후 Redis 대시보드가 클러스터 Redis 를 보여 주는지 확인
