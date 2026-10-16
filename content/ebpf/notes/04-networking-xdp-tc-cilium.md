---
title: "네트워크 — XDP, TC, 소켓 훅, 그리고 Cilium"
order: 4
level: 중급
summary: "패킷이 NIC 에서 소켓까지 오는 경로의 eBPF 훅 지점(XDP → TC ingress → netfilter → 소켓 → TC egress)과 각 지점에서 할 수 있는 것, XDP 의 동작(native·generic·offload, 반환 코드, 왜 초당 수천만 패킷인가)과 용도(DDoS 드롭·L4 로드밸런서 Katran), TC 프로그램으로 패킷 수정·리다이렉트, 소켓 훅(sockops·sk_msg·sockmap)으로 로컬 소켓 간 스택 우회, cgroup 훅으로 컨테이너별 connect 제어, Cilium 이 kube-proxy 와 iptables 를 대체하는 방식(eBPF 맵 기반 서비스·신원 기반 NetworkPolicy), Hubble 의 흐름 가시성, kind 에 Cilium 을 넣어 Calico 클러스터와 비교하는 실습"
tags: [XDP, TC, sockmap, cgroup, Cilium, Hubble, kube-proxy, iptables, NetworkPolicy, 로드밸런서]
experiments: [ebpf-tcp-latency]
---

## 패킷 경로의 훅 지점

```
NIC ─▶ [XDP] ─▶ 드라이버 ─▶ sk_buff 생성 ─▶ [TC ingress] ─▶ netfilter(iptables/nft) ─▶ 라우팅 ─▶ [socket filter / sockops]
송신: 소켓 ─▶ [sk_msg / sockops] ─▶ 스택 ─▶ netfilter ─▶ [TC egress] ─▶ 드라이버 ─▶ NIC
[cgroup/connect4, sendmsg …] 는 소켓 syscall 시점에
```

![eBPF 네트워크 훅](/diagrams/ebpf-hooks.svg)

| 훅 | 패킷 표현 | 할 수 있는 것 | 비용 |
|---|---|---|---|
| **XDP** | 원시 프레임(`xdp_md`), sk_buff **없음** | DROP·PASS·TX(되돌려 보냄)·REDIRECT(다른 NIC/CPU/AF_XDP 소켓) | 가장 낮음 — sk_buff 할당 전 |
| **TC** (ingress/egress) | `__sk_buff` | 수정·리다이렉트·분류·정책, 양방향 | 낮음 |
| **socket filter** | sk_buff | 소켓 수신 전 필터(tcpdump 의 원조) | — |
| **sockops / sk_msg** | 소켓 이벤트·메시지 | 소켓 간 직접 전달(sockmap), TCP 옵션 | 로컬 통신 가속 |
| **cgroup/{connect,bind,sendmsg}** | syscall 인자 | 허용/거부, 주소 바꿔치기 | 컨테이너 정책 |
| **LWT / seg6** | 라우트 | 터널·SRv6 | — |

[Linux 네트워크 06](/linux-network/notes/06-kernel-stack-ebpf-performance) 이 스택의 전체 그림을 그렸다면 이 노트는 각 훅의 쓰임이다.

## XDP — eXpress Data Path

**왜 빠른가**: 패킷이 `sk_buff`(메타데이터 수백 바이트의 구조체, 할당·초기화가 비용)로 바뀌기 **전**, 드라이버의 수신 루프 안에서 실행된다. 코어당 초당 1,000만~2,000만 패킷을 처리한다. 반환 코드:

| 코드 | 동작 | 용도 |
|---|---|---|
| `XDP_DROP` | 즉시 버림 | DDoS·스캔 차단(Cloudflare 는 초당 수천만 pps 드롭) |
| `XDP_PASS` | 정상 스택으로 | 기본 |
| `XDP_TX` | 들어온 NIC 로 되돌려 보냄 | L4 LB(DSR), 응답 캐시 |
| `XDP_REDIRECT` | 다른 NIC·CPU(cpumap)·AF_XDP 소켓 | 로드밸런서, 유저 공간 패킷 처리(DPDK 대안) |
| `XDP_ABORTED` | 오류(tracepoint 로 관측) | — |

세 모드: **native**(드라이버 지원, 진짜 빠름), **generic**(드라이버 미지원 시 스택 초입에서 흉내, 느림 — 가상 NIC·Docker Desktop 은 대개 이것), **offload**(SmartNIC 에서 실행).

```c
// 최소 XDP: UDP 포트 9999 로 오는 패킷 드롭
SEC("xdp")
int drop_udp_9999(struct xdp_md *ctx) {
    void *data = (void *)(long)ctx->data, *end = (void *)(long)ctx->data_end;
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > end) return XDP_PASS;             // 검증기가 요구하는 범위 검사
    if (eth->h_proto != bpf_htons(ETH_P_IP)) return XDP_PASS;
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > end || ip->protocol != IPPROTO_UDP) return XDP_PASS;
    struct udphdr *udp = (void *)ip + ip->ihl * 4;
    if ((void *)(udp + 1) > end) return XDP_PASS;
    return udp->dest == bpf_htons(9999) ? XDP_DROP : XDP_PASS;
}
```

`(void *)(eth + 1) > end` 같은 검사가 매 단계에 있는 이유는 [01](/ebpf/notes/01-what-is-ebpf) 의 검증기 때문이다 — 빠뜨리면 "invalid access to packet" 으로 로드가 거부된다([07](/ebpf/notes/07-writing-your-own)).

**Katran**(메타): XDP 로 만든 L4 LB 다. 백엔드 선택을 Maglev 해싱으로 맵에서 조회하고 IP-in-IP 로 캡슐화해 `XDP_TX` 한다. 상태(연결 테이블)는 LRU 맵. 서버 한 대가 수천만 pps 를 처리한다. [Nginx](/nginx/notes/02-reverse-proxy-lb) 같은 L7 프록시 **앞**에 서는 계층이다.

## TC — 유연한 데이터패스

TC(traffic control)의 분류기(`cls_bpf`)로 붙는다. XDP 와 달리 egress 도 있고 sk_buff 라 헬퍼가 풍부하다(`bpf_skb_store_bytes`, `bpf_redirect`, `bpf_clone_redirect`). Cilium 의 Pod 간 통신은 veth 의 TC 훅에서 **목적지 Pod 의 veth 로 직접 리다이렉트**해 브리지·iptables 를 건너뛴다.

```bash
tc qdisc add dev eth0 clsact
tc filter add dev eth0 ingress bpf da obj prog.o sec tc_ingress
tc filter show dev eth0 ingress
```

## 소켓 훅 — 스택 우회

같은 호스트의 두 소켓(프록시 ↔ 앱, 사이드카 ↔ 앱)이 통신할 때 데이터는 송신 스택 → 루프백 → 수신 스택을 다 탄다. **sockmap + sk_msg** 는 송신 소켓의 메시지를 수신 소켓 큐에 **직접** 넣는다 — 서비스 메시 사이드카 오버헤드의 상당 부분을 없앤다. `sockops` 는 연결 수립 시 소켓을 맵에 등록하고 TCP 옵션·버퍼를 조정한다.

## cgroup 훅 — 컨테이너 단위 정책

`cgroup/connect4` 에 붙은 프로그램은 그 cgroup(=컨테이너) 안 프로세스의 `connect()` 를 가로채 **거부하거나 목적지를 바꿀** 수 있다. 패킷을 보지 않고 syscall 에서 끝내므로 싸다. "이 Pod 는 169.254.169.254 로 못 간다" 를 NetworkPolicy 없이도 강제할 수 있다. Cilium 의 **소켓 기반 로드밸런싱**이 이것이다: ClusterIP 로 connect 하면 cgroup 훅이 **백엔드 Pod IP 로 바꿔치기** → 이후 패킷에 NAT 가 전혀 없다.

## Cilium — kube-proxy 와 iptables 를 대체

| 기능 | kube-proxy + iptables/IPVS | Cilium eBPF |
|---|---|---|
| Service(ClusterIP) | iptables 체인에 서비스·엔드포인트마다 규칙, O(n) 순회 | 소켓 훅에서 맵 조회 O(1), NAT 없음 |
| NetworkPolicy | CNI 가 iptables/ipset 으로(Calico 의 기본 모드) | TC 훅에서 **신원(identity)** 맵 조회 — IP 가 아니라 레이블 집합에 번호 |
| L7 정책 | 불가(메시 필요) | Envoy 로 투명 리다이렉트, HTTP 경로·메서드 정책 |
| 가시성 | 없음 | **Hubble**: 모든 흐름(5튜플·신원·정책 판정·L7) |
| 암호화 | — | WireGuard/IPsec 투명 |
| 규칙 수 증가 시 | 서비스 1만 개면 규칙 수만 개, 갱신 수 초 | 맵 갱신 µs |

**신원(identity)**: Pod 의 레이블 집합마다 정수 ID 를 부여하고 패킷에 그 ID 를 싣는다(VXLAN 헤더 또는 소켓 메타). 정책 판정은 `(src_id, dst_id, port)` 맵 조회다. Pod IP 가 바뀌어도 정책이 안 바뀐다 — IP 기반 ipset 과의 근본 차이다.

**Hubble**: Cilium 이 TC 훅에서 흐름 이벤트를 링버퍼로 내보내고 Hubble 이 모은다. `hubble observe --namespace netpol-lab --verdict DROPPED` 로 **NetworkPolicy 가 무엇을 막았는지** 즉시 본다. [보안 06](/security/notes/06-kubernetes-security) 의 Calico 실험에서는 "연결 실패" 만 보였던 것이 여기서는 "정책 X 가 거부" 로 보인다. Prometheus 메트릭(`hubble_flows_processed_total`, `hubble_drop_total`)으로 [관측 스택](/observability/notes/07-kubernetes-observability)에 연결한다.

### kind 에 Cilium

```bash
cat > /tmp/kind-cilium.yaml <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: study-cilium
networking: { disableDefaultCNI: true, kubeProxyMode: none }
nodes: [{ role: control-plane }]
YAML
kind create cluster --config /tmp/kind-cilium.yaml
helm repo add cilium https://helm.cilium.io
helm install cilium cilium/cilium -n kube-system --version 1.17.0 \
  --set kubeProxyReplacement=true --set k8sServiceHost=study-cilium-control-plane --set k8sServicePort=6443 \
  --set hubble.relay.enabled=true --set hubble.ui.enabled=true
cilium status --wait
kubectl apply -f k8s/security/netpol/        # study-netpol(Calico) 과 같은 매니페스트
hubble observe -n netpol-lab --verdict DROPPED
```

`kubeProxyMode: none` + `kubeProxyReplacement=true` 가 "kube-proxy 없이 eBPF 로 Service" 다. Docker Desktop 에서 Cilium 은 generic XDP·TC 로 돈다(가상 NIC).

## 예시로 보기 — 이 프로젝트에서

- 실험 `ebpf-tcp-latency` 가 보는 `inet_sock_set_state` 는 Hubble 이 흐름을 만드는 지점의 **관측 버전**이다. 연결(ESTABLISHED)·종료(CLOSE)·수명을 세는 것이 흐름 로그의 최소 단위다.
- study-netpol(Calico) 과 Cilium 을 같은 매니페스트로 비교하면: 정책 적용 지연(iptables 재생성 vs 맵 갱신), 거부 가시성(없음 vs Hubble), Service 경로(iptables DNAT vs 소켓 LB)가 보인다.
- Nginx 앞의 DDoS 방어를 생각하면: [레이트리밋](/nginx/notes/03-cache-tls-ratelimit)은 L7(연결이 이미 맺어진 뒤), XDP 드롭은 L2/3(SYN 조차 스택에 안 들어옴)이다. 계층이 다르다.
- 보안 측면의 eBPF(Tetragon 의 네트워크 정책 강제)는 [05](/ebpf/notes/05-security-falco-tetragon).

## 실습 체크리스트

- [ ] 위 XDP 프로그램을 `clang -O2 -target bpf -c` 로 컴파일하고 `ip link set dev eth0 xdpgeneric obj prog.o sec xdp` 로 특권 컨테이너의 veth 에 붙여 `nc -u` 로 9999 가 드롭되는지 확인(07 의 작성 환경)
- [ ] kind 에 Cilium 을 설치하고 `k8s/security/netpol/` 매니페스트를 적용, `hubble observe --verdict DROPPED` 로 거부 흐름 보기
- [ ] `cilium service list` 로 ClusterIP 가 맵에 어떻게 들어 있는지 보고 kind-study 의 `iptables -t nat -L KUBE-SERVICES` 와 비교
- [ ] Hubble 메트릭을 kps Prometheus 가 긁게 하고 드롭 수 패널 만들기
- [ ] 소켓 LB 확인: Cilium 클러스터의 Pod 에서 ClusterIP 로 connect 한 뒤 `ss -tnp` 의 피어 주소가 Pod IP 인지
