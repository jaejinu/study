---
title: 심화 — 네트워크 정책, Gateway API, 서비스 메시
order: 12
level: 심화
summary: CNI 가 Pod 네트워크를 만드는 방식, kube-proxy 의 Service 구현(iptables/IPVS/eBPF), NetworkPolicy 로 기본 거부 모델 만들기, Ingress 의 후속인 Gateway API, 서비스 메시(Istio/Linkerd)가 주는 mTLS·재시도·트래픽 분할과 그 비용, DNS·네트워크 디버깅
tags: [CNI, NetworkPolicy, kube-proxy, Gateway API, 서비스메시, Istio, Linkerd, mTLS]
experiments: [k8s-service-endpoints]
---

## Pod 네트워크는 누가 만드나 — CNI

kubelet 이 Pod 을 만들 때 **CNI 플러그인**을 호출해 veth 와 IP 를 붙인다. 요구 모델: 모든 Pod 은 NAT 없이 서로 통신 가능한 고유 IP.

| CNI | 특징 |
|---|---|
| kindnet (kind 기본) | 단순 브리지 + 라우팅. NetworkPolicy 미지원 |
| Calico | BGP/VXLAN, NetworkPolicy, eBPF 모드 |
| **Cilium** | eBPF 기반, kube-proxy 대체, L7 정책, Hubble 관측 |
| Flannel | 가장 단순(VXLAN), 정책 없음 |
| 클라우드 CNI (AWS VPC CNI) | Pod 이 VPC IP 를 직접 받음 |

```bash
kubectl -n kube-system get pods | grep -E "kindnet|calico|cilium"
kubectl get pod -o wide -n study            # Pod IP 대역 (kind: 10.244.x.x)
```

## Service 는 어떻게 동작하나 — kube-proxy

ClusterIP 는 인터페이스에 없는 **가상 IP** 다. kube-proxy 가 각 노드에 "ClusterIP:port → Pod IP 들 중 하나" 규칙을 설치한다.

| 모드 | 구현 | 특징 |
|---|---|---|
| iptables (기본) | DNAT 규칙 체인, 확률로 분산 | Service 수천 개면 규칙 평가 느려짐 |
| IPVS | 커널 L4 LB, 해시 테이블 | 대규모에 유리, 알고리즘 선택(rr, lc) |
| eBPF (Cilium) | kube-proxy 없이 소켓 레벨 | 가장 빠름, DSR |

```bash
# kind 노드 안에서 (docker exec -it study-control-plane bash)
iptables -t nat -L KUBE-SERVICES -n | grep redis
iptables -t nat -L KUBE-SVC-XXXX -n           # 확률 분산 규칙
```
[Service endpoints 실험](/kubernetes/lab/k8s-service-endpoints)에서 endpoints 가 바뀌면 이 규칙이 갱신된다. Headless Service 는 규칙 없이 DNS 만.

## NetworkPolicy — 기본 거부

기본은 **모든 Pod 이 모든 Pod 과 통신 가능**. 운영에선 네임스페이스마다 기본 거부 후 필요한 경로만 연다. kind 기본 CNI(kindnet)는 정책을 **무시**하므로 Calico/Cilium 이 필요하다.

```yaml
# 1) 네임스페이스 기본 거부 (ingress + egress)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: study }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# 2) web → redis 만 허용
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-web-to-redis, namespace: study }
spec:
  podSelector: { matchLabels: { app: redis } }
  policyTypes: [Ingress]
  ingress:
    - from: [{ podSelector: { matchLabels: { app: web } } }]
      ports: [{ protocol: TCP, port: 6379 }]
---
# 3) DNS 와 외부 HTTPS 는 egress 허용 (기본 거부 시 DNS 를 꼭 열어야 한다!)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-egress-dns-https, namespace: study }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } } }]
      ports: [{ protocol: UDP, port: 53 }]
    - to: [{ ipBlock: { cidr: 0.0.0.0/0, except: [10.0.0.0/8] } }]
      ports: [{ protocol: TCP, port: 443 }]
```

- 정책은 **허용 목록의 합집합**. 거부 규칙은 없다(기본 거부 + 허용).
- 정책이 L3/L4 뿐. "GET /api 만" 같은 L7 은 Cilium 정책이나 메시.
- 테스트: `kubectl run -it --rm t --image=busybox -- nc -zv redis 6379` 를 허용/비허용 Pod 레이블로 각각.

```bash
# kind 에 Calico 설치해 정책 실험
kind create cluster --name netpol --config - <<'Y'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking: { disableDefaultCNI: true, podSubnet: "192.168.0.0/16" }
Y
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.29.1/manifests/tigera-operator.yaml
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.29.1/manifests/custom-resources.yaml
```

## Gateway API — Ingress 의 후속

Ingress 는 어노테이션 지옥(컨트롤러마다 다름)과 역할 분리 부재가 문제였다. **Gateway API** 는 표준 리소스로 역할을 나눈다.

```
GatewayClass (인프라 제공자: nginx, istio, cloud LB)
  └─ Gateway (플랫폼 팀: 리스너 80/443, TLS 인증서, 어느 네임스페이스가 붙을 수 있나)
       └─ HTTPRoute / GRPCRoute / TCPRoute (앱 팀: 호스트·경로·헤더 매칭 → Service, 가중치, 헤더 수정, 리다이렉트)
```

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: study, namespace: study }
spec:
  parentRefs: [{ name: shared-gateway, namespace: infra }]
  hostnames: [study.local]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /redis } }]
      backendRefs: [{ name: web, port: 3000, weight: 90 }, { name: web-canary, port: 3000, weight: 10 }]   # 카나리
    - matches: [{ headers: [{ name: x-beta, value: "1" }] }]
      backendRefs: [{ name: web-beta, port: 3000 }]
```

구현: nginx-gateway-fabric, Istio, Envoy Gateway, Cilium, 클라우드 LB. 새 프로젝트는 Gateway API 로 시작하는 추세.

## 서비스 메시

각 Pod 에 **사이드카 프록시**(Envoy) 또는 노드 레벨 프록시(Istio ambient, Linkerd 의 경량 프록시)를 두고 모든 서비스 간 트래픽을 가로채 기능을 더한다.

| 기능 | 효과 |
|---|---|
| **mTLS** 자동 | 서비스 간 암호화·신원(SPIFFE), 제로 트러스트 |
| 트래픽 관리 | 재시도·타임아웃·서킷브레이커를 코드 변경 없이, 카나리 가중치, 미러링 |
| 관측 | 모든 호출의 RED 메트릭·트레이스 헤더 전파·서비스 그래프 (앱 계측 없이) |
| 정책 | L7 인가("A 는 B 의 GET /api 만") |

비용: 사이드카마다 메모리·CPU(50~100MB), 지연 +1~2ms, 디버깅 복잡도, 업그레이드 운영. **서비스가 수십 개 이상이고 보안·관측 요구가 명확할 때** 도입. 작은 시스템은 라이브러리(복원력 패턴)와 OTel 로 충분하다 ([복원력 노트](/architecture/notes/04-resilience)).

```bash
# Linkerd 맛보기 (가벼움)
curl -sL https://run.linkerd.io/install | sh ; linkerd check --pre ; linkerd install --crds | kubectl apply -f - ; linkerd install | kubectl apply -f -
kubectl -n study get deploy web -o yaml | linkerd inject - | kubectl apply -f -     # 사이드카 주입
linkerd viz install | kubectl apply -f - ; linkerd viz dashboard
```

## 네트워크 디버깅 순서

1. DNS: `kubectl run -it --rm d --image=busybox -- nslookup redis.study.svc.cluster.local`
2. Service → endpoints: `kubectl get endpoints redis -n study` (비어 있으면 selector/readiness)
3. Pod 간 직접: `nc -zv <pod-ip> 6379` (되는데 Service 로 안 되면 kube-proxy)
4. 정책: NetworkPolicy 가 막는지 — 정책을 임시 삭제해 확인, Cilium 은 `hubble observe`
5. 노드 간: CNI 터널(VXLAN 4789/UDP) 방화벽
6. 외부 → Ingress/Gateway: 컨트롤러 로그, `curl -H Host:`

[Linux 네트워크 도구 노트](/linux-network/notes/05-tools) 의 `tcpdump` 를 Pod 에서(`kubectl debug … --image=nicolaka/netshoot`) 쓸 수 있다.

## 실전에서는 어디에 쓰이나

> 클러스터 안 통신을 막고(NetworkPolicy), 밖으로 노출하고(Gateway API), 서비스 간 호출에 암호화·재시도를 얹는(서비스 메시) 계층이다. 보안 감사, 대규모 마이크로서비스, 카나리 배포에서 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 결제 시스템 | "카드 데이터 서비스는 지정된 서비스만 접근" 감사 요구 | 네임스페이스 default-deny + 필요한 경로만 허용 | 클라우드 보안 그룹 — Pod 단위 제어가 어렵다 |
| 대규모 마이크로서비스 | 서비스 간 mTLS·신원, 코드 수정 없는 재시도·타임아웃 | Istio·Linkerd | 언어별 복원력 라이브러리 + 앱 TLS |
| 여러 팀이 쓰는 공용 진입점 | 플랫폼 팀은 리스너·인증서, 앱 팀은 라우트 | Gateway API(Gateway + HTTPRoute) 역할 분리 | Ingress + 컨트롤러별 어노테이션 |
| 신규 버전 카나리 | 트래픽 10% 만 새 버전 | HTTPRoute `backendRefs` weight | Argo Rollouts 복제본 비율 |
| Service 가 수천 개인 대형 클러스터 | iptables 규칙 평가 지연 | IPVS 모드 또는 Cilium eBPF 로 kube-proxy 대체 | 클러스터 분할 |

**이럴 땐 안 맞는다**
- 서비스 몇 개짜리 시스템에 메시 → 사이드카 메모리·지연·업그레이드 부담이 이득보다 크다. 라이브러리 + OTel 로 충분하다.
- kindnet·Flannel 위에 NetworkPolicy 작성 → 정책이 조용히 무시된다. Calico·Cilium 처럼 정책을 지원하는 CNI 가 필요하다.

**누가 매일 만나나** — 보안·플랫폼 엔지니어는 정책·mTLS·Gateway 를 설계한다. 백엔드는 "기본 거부 적용 후 모든 호출이 타임아웃" 같은 증상으로 처음 만난다.

**면접·실무 단골 질문**
- Q. default-deny 적용 후 전부 실패한다면? → egress 에서 DNS(UDP 53) 허용을 빠뜨린 경우가 가장 흔하다.

## 실습 체크리스트

- [ ] kind 노드에서 `iptables -t nat -L` 로 redis Service 의 DNAT 규칙 찾기
- [ ] Calico kind 클러스터를 만들고 default-deny 후 web→redis 만 허용, DNS 를 안 열었을 때 증상 확인
- [ ] Gateway API CRD 와 nginx-gateway-fabric 을 설치해 HTTPRoute 가중치 카나리 만들기
- [ ] (선택) Linkerd 를 설치해 web 에 주입하고 viz 에서 RED 메트릭·mTLS 확인
