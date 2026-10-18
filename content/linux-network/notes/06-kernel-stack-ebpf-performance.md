---
title: 심화 — 커널 네트워크 스택, eBPF, 성능 분석
order: 6
level: 심화
summary: 패킷이 NIC 에서 소켓 버퍼까지 오는 경로(인터럽트·NAPI·softirq·sk_buff), 소켓 버퍼와 혼잡 제어(cubic/BBR) 튜닝, conntrack 과 iptables 비용, eBPF/XDP 가 커널 안에서 하는 일(Cilium·bpftrace·Falco), 지연·처리량 병목을 찾는 도구(ss -ti, perf, bpftrace, tcpdump 분석), 컨테이너 네트워크 오버헤드 수치
tags: [커널, NAPI, sk_buff, 혼잡제어, BBR, conntrack, eBPF, XDP, bpftrace, perf]
experiments: [net-ports-sockets, net-dns-http]
---

## 패킷의 수신 경로

![패킷 수신 경로 — NIC 에서 소켓까지](/diagrams/net-rx-path.svg)

```
NIC (DMA 로 링 버퍼에 패킷) → 하드웨어 인터럽트 → NAPI 폴링 (softirq, ksoftirqd)
→ 드라이버가 sk_buff 생성 → L2 (브리지/veth) → netfilter PREROUTING (conntrack, DNAT)
→ 라우팅 결정 → netfilter INPUT (필터) → L4 (TCP: 순서·ACK·윈도우) → 소켓 수신 버퍼
→ 앱의 read()/epoll 깨어남
```

- 초당 수백만 패킷이면 **인터럽트·softirq 가 CPU 를 먹는다**. RSS(큐 여러 개를 코어에 분산), RPS/RFS, `irqbalance`, NIC 오프로드(GRO/TSO/checksum). `cat /proc/interrupts`, `mpstat -P ALL` 의 `%soft`.
- `sk_buff` 복사를 줄이는 것이 성능의 핵심 — zero-copy(`sendfile`, `MSG_ZEROCOPY`), io_uring.
- 송신은 반대 경로. qdisc(`tc`)가 큐잉·셰이핑을 맡는다(`fq`, `fq_codel`, BBR 은 `fq` 와 궁합).

## 소켓 버퍼와 혼잡 제어

```bash
ss -tim                    # 연결별: rtt, cwnd, ssthresh, retrans, send/recv 버퍼, pacing_rate, delivery_rate
sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem     # min default max (자동 튜닝 범위)
sysctl net.core.rmem_max=134217728 net.core.wmem_max=134217728       # 고대역폭·고지연 링크(BDP 큰 경우)
sysctl net.ipv4.tcp_congestion_control=bbr ; modprobe tcp_bbr ; sysctl net.core.default_qdisc=fq
```
- **BDP**(대역폭×RTT) 만큼 윈도우가 필요하다. 1Gbps × 100ms = 12.5MB — 기본 버퍼 상한이 작으면 처리량이 RTT 에 반비례해 떨어진다.
- `cubic`(기본, 손실 기반) vs **BBR**(대역폭·RTT 모델 기반): 손실이 있는 링크(무선, 장거리)에서 BBR 이 훨씬 높은 처리량. 데이터센터 내부는 큰 차이 없음.
- `retrans` 가 늘면 손실·버퍼 부족. `tcp_notsent_lowat` 로 앱 측 버퍼링 지연 줄이기(HTTP/2 우선순위에 중요).

## conntrack 과 iptables 비용

- Docker 포트 매핑, Kubernetes Service, NAT 는 **conntrack** 테이블(연결 추적)을 쓴다. 가득 차면 `nf_conntrack: table full, dropping packet` — 연결이 조용히 실패한다.
  ```bash
  sysctl net.netfilter.nf_conntrack_max ; cat /proc/sys/net/netfilter/nf_conntrack_count
  sysctl net.netfilter.nf_conntrack_tcp_timeout_time_wait=30
  ```
- iptables 규칙은 **선형 평가**. Service 수천 개 × 규칙 수 = 패킷마다 수천 번 비교 → IPVS(해시) 또는 eBPF(Cilium) 로 대체 ([k8s 네트워크 노트](/kubernetes/notes/12-network-policy-mesh)).
- NAT 는 체크섬 재계산 + conntrack 조회. 컨테이너 네트워크 오버헤드의 대부분이 여기. veth 쌍도 패킷당 softirq 한 번 더.

## eBPF — 커널 안에서 안전하게 코드 실행

커널 모듈 없이 검증된 작은 프로그램을 **커널 훅**(시스템 콜, 함수 진입, 네트워크 경로)에 붙인다. 관측·네트워킹·보안 도구의 기반.

| 훅 | 용도 | 도구 |
|---|---|---|
| **XDP** (드라이버 수신 직후) | 패킷 드롭/리다이렉트를 sk_buff 생성 전에 — DDoS 방어, L4 LB (Katran) | Cilium, Cloudflare |
| TC (qdisc) | 패킷 분류·리다이렉트, Service 구현 | Cilium (kube-proxy 대체) |
| socket / sockops | 소켓 레벨 리다이렉트 (같은 노드 Pod 간 TCP 우회) | Cilium |
| kprobe / tracepoint | 커널 함수 호출 추적 — 지연 히스토그램, 파일 I/O, 스케줄링 | bpftrace, bcc |
| LSM | 보안 정책 | Falco (syscall 감시), Tetragon |

```bash
# bpftrace 원라이너 (Linux)
bpftrace -e 'tracepoint:syscalls:sys_enter_connect { @[comm] = count(); }'            # 누가 connect() 를 많이 부르나
bpftrace -e 'kprobe:tcp_retransmit_skb { @retrans[pid, comm] = count(); }'             # 재전송을 유발하는 프로세스
bpftrace -e 'tracepoint:syscalls:sys_exit_read /comm=="redis-server"/ { @bytes = hist(args->ret); }'   # Redis read 크기 분포
# bcc 도구
tcpconnect, tcpaccept, tcpretrans, tcplife (연결 수명·바이트), tcprtt, biolatency, execsnoop, opensnoop
```
macOS 에선 eBPF 가 없다 — Docker Desktop VM 안이나 리눅스 호스트에서. Cilium 의 **Hubble** 은 Pod 간 흐름(L3~L7)을 eBPF 로 관측해 "누가 누구에게, 거부됐는지" 를 보여준다.

## 성능 분석 순서

1. **증상 숫자**: 지연 p99? 처리량? 손실? (`ss -ti` 의 rtt/retrans, 앱 메트릭)
2. **CPU 가 어디에**: `top` 의 `%si`(softirq)·`%sy`, `perf top` — 커널 네트워크 함수가 상위면 패킷 처리 한계.
3. **큐·버퍼**: `ss -tlnp` 의 Recv-Q(accept 안 된 연결), `nstat -az | grep -i drop`, NIC 링 버퍼 `ethtool -S eth0 | grep drop`.
4. **conntrack/iptables**: 테이블 크기, 규칙 수.
5. **애플리케이션**: 이벤트 루프 블로킹, 커넥션 재생성(keepalive 없음), Nagle/delayed ACK (`TCP_NODELAY`).
6. **경로**: `mtr`, MTU/단편화(`ping -D -s`), 중간 장비.

```bash
perf record -g -p $(pgrep redis-server) -- sleep 10 ; perf report      # 플레임그래프 재료
nstat -az TcpExtListenDrops TcpExtTCPTimeouts TcpRetransSegs
ethtool -g eth0 ; ethtool -k eth0 | grep -E "offload|gro|tso"
```

## 컨테이너 네트워크 오버헤드 (대략)

| 경로 | 추가 지연 | 처리량 영향 |
|---|---|---|
| 호스트 네트워크 (`--network host`) | 0 | 0 |
| 브리지 + veth (NAT 없음, Pod 간) | +10~30µs | −5~10% |
| 브리지 + DNAT 포트 매핑 (`-p`) | +30~60µs | −10~20% |
| VXLAN 오버레이 (노드 간) | +50~100µs, MTU 50B 감소 | −10~30% (오프로드 없으면 더) |
| Docker Desktop (macOS, VM + vpnkit) | +수백 µs~ms | 크게 감소 — 벤치마크 페이지의 30k vs 450k |
| eBPF 데이터패스 (Cilium) | veth 수준 또는 그 이하 | kube-proxy 대비 개선 |

지연에 민감한 Redis·DB 는 호스트 네트워크 또는 같은 노드 배치, 오버레이 대신 라우팅 모드(Calico BGP, VPC CNI)를 고려한다.

## 지연을 단계별로 쪼개는 감각

같은 데이터센터 안 요청 하나(작은 RPC)의 지연 예산(대략):

| 구간 | 시간 | 비고 |
|---|---|---|
| 시스템 콜 + 소켓 버퍼 복사 | 1~5µs | 작은 메시지 |
| 커널 스택 송신(TCP/IP, qdisc) | 수 µs | |
| NIC·스위치·케이블 | 수~수십 µs | 같은 랙이면 매우 작음 |
| 수신 인터럽트 → softirq → 소켓 | 수~수십 µs | 인터럽트 병합(coalescing)으로 늘어남 |
| 앱 깨어나기(epoll → 스케줄링) | 수~수백 µs | CPU 경합·전원 절약 상태면 커짐 |
| 앱 처리 | 수 µs~ms | Redis GET 은 수 µs |

결론: 데이터센터 안에서 **네트워크 자체는 대개 수십 µs**이고, p99 를 키우는 것은 스케줄링 지연·GC·큐잉이다. 그래서 "네트워크가 느리다" 는 보고의 상당수는 실제로는 수신 측 CPU 문제다. 꼬리 지연의 일반론은 [꼬리 지연과 대규모](/performance/notes/08-tail-latency-at-scale).

## softirq 와 CPU — 측정하는 법

```bash
# Docker Desktop VM 안에서
cat /proc/softirqs | grep -E "NET_RX|NET_TX"      # CPU 별 누적 횟수
mpstat -P ALL 1 3 | awk '/Average/'                # %soft 가 높은 코어
cat /proc/net/softnet_stat                          # 열 2: 백로그 드롭, 열 3: time_squeeze(예산 소진)
```

`time_squeeze` 가 계속 늘면 softirq 가 한 번에 처리할 예산(`net.core.netdev_budget`)을 다 써서 다음 차례로 미룬 것이다. 패킷이 많은 서버에서 `ksoftirqd` 가 CPU 를 많이 쓰면 이 상황이다. eBPF 로 softirq 지연 분포를 재는 방법은 [BCC/libbpf 도구](/ebpf/notes/03-bcc-libbpf-tools)의 `softirqs`, `runqlat`.

## epoll 과 이벤트 루프의 연결

소켓 수신 버퍼에 데이터가 들어오면 커널은 그 소켓을 **기다리는 epoll 인스턴스의 준비 목록**에 올리고 대기 중인 스레드를 깨운다. Redis·Nginx·Node 가 연결 수만 개를 스레드 하나로 처리하는 비결이다.

| 모델 | 연결 1만 개일 때 | 대표 |
|---|---|---|
| 연결당 스레드/프로세스 | 스레드 1만 개(스택 메모리·문맥 교환) | 전통 Apache prefork, PostgreSQL 백엔드 |
| 이벤트 루프(epoll) | 스레드 1개 + 준비된 소켓만 처리 | Redis, Nginx 워커, Node.js |
| io_uring | 제출·완료 링, 시스템 콜 감소 | 최신 고성능 서버 |

이벤트 루프의 약점은 **한 핸들러가 오래 걸리면 모든 연결이 기다린다**는 것이다(Redis 의 `KEYS *`, Node 의 동기 JSON 파싱). 레벨/엣지 트리거 차이와 io_uring 은 [시스템 콜과 인터럽트](/os-internals/notes/05-syscalls-interrupts), Redis 의 이벤트 루프는 [Redis 내부 심화](/redis/notes/16-internals-deep-dive).

## 예시로 보기 — 이 프로젝트의 커널 네트워크 실험들

| 실험 | 커널 네트워크의 어디를 보나 |
|---|---|
| `ebpf-tcp-latency` | kprobe 로 앱 → Redis 연결 수명·RTT, keepalive 유무에 따른 연결 수 차이 |
| `ebpf-bpftrace-syscalls` | Redis 의 read/write/epoll_wait 시스템 콜 분포 |
| `os-context-switch` | 파이프라인 크기에 따른 Redis 의 voluntary 문맥 교환 감소 |
| `sec-k8s-networkpolicy` | Calico 가 netfilter/eBPF 로 정책을 강제하는 모습 |

`ebpf-tcp-latency` 의 실측에서 keepalive 없이 요청마다 연결하면 같은 작업에 연결이 수천 개 생기고, keepalive 를 켜면 수십 개로 줄었다. TIME_WAIT 와 포트 고갈 이야기([포트·소켓·TCP 상태](/linux-network/notes/02-ip-ports-sockets))가 커널 이벤트로 그대로 보인다.

## 운영·관측 포인트

- node_exporter 의 `node_netstat_*`, `node_softnet_*`, `node_network_*_drop_total` 을 수집해 "드롭이 어느 층에서" 를 대시보드로.
- 커널 파라미터 변경은 sysctl 파일로 버전 관리하고, 변경 전후 벤치마크(같은 부하)를 남긴다. 튜닝 값을 복사해 오는 것은 측정 없이는 의미가 없다.

## 실전에서는 어디에 쓰이나

> 패킷·연결·Service 가 많은 서버에서 CPU·드롭·지연이 커널 네트워크 경로에서 생길 때, 그리고 eBPF 로 관측하거나 데이터패스를 바꿀 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 대규모 쿠버네티스 클러스터 | Service 수천 개의 iptables 선형 평가 비용 | IPVS 또는 eBPF 데이터패스(Cilium) | kube-proxy iptables 유지 |
| NAT·포트 매핑이 많은 노드 | conntrack 포화로 새 연결이 조용히 버려짐 | `nf_conntrack_count` 알림, `nf_conntrack_max`·타임아웃 조정 | 증상만 보고 노드 교체 |
| DDoS 방어·L4 로드밸런서 | sk_buff 생성 전에 패킷 처리 | XDP 로 조기 드롭·리다이렉트 | iptables·유저 공간 필터 — CPU 소모 |
| 지연 민감 Redis·DB 서비스 | 컨테이너 네트워크 오버헤드 축소 | 호스트 네트워크, 같은 노드 배치, 라우팅 모드 CNI | VXLAN 오버레이 기본값 |
| 운영 관측 | 패킷 저장 없이 연결·재전송 추적 | bcc `tcplife`·`tcpretrans`, bpftrace | tcpdump 상시 캡처 — 저장·CPU 부담 |

**이럴 땐 안 맞는다**
- 측정 없이 sysctl 값을 바꾸는 것 — 증상 숫자 → CPU 위치 → 큐·버퍼 순서로 좁힌 뒤 하나씩 바꾸고 전후를 잰다.
- macOS 에서 eBPF 도구를 찾는 것 — 없다. 리눅스 호스트나 Docker Desktop VM 안에서 쓴다.

**누가 매일 만나나** — SRE·플랫폼·네트워크 엔지니어가 노드 성능과 패킷 드롭을 분석할 때, 보안 담당이 eBPF 기반 런타임 감시(Falco·Tetragon)를 운영할 때.

**면접·실무 단골 질문**
- Q. Service 가 많아지면 kube-proxy(iptables)가 느려지는 이유는? → 규칙을 선형으로 평가하기 때문. IPVS(해시)나 eBPF 로 바꾼다.
- Q. "네트워크가 느리다" 가 실제로는 수신 측 CPU 문제인 경우가 많은 이유는? → 데이터센터 안 네트워크 자체는 수십 µs 이고, p99 를 키우는 것은 softirq·스케줄링·GC·큐잉이다.

## 실습 체크리스트

- [ ] Docker Desktop VM 에 들어가(`docker run --privileged --pid=host -it alpine nsenter -t 1 -m -u -n -i sh`) `ss -ti`, `nstat`, `/proc/interrupts` 보기
- [ ] 같은 VM 에서 `sysctl net.ipv4.tcp_congestion_control` 확인
- [ ] 컨테이너 Redis 를 `--network host`(리눅스 호스트에서) 와 브리지로 각각 벤치마크해 차이 측정
- [ ] (리눅스) bcc 의 `tcpconnect`/`tcpretrans` 를 띄워 두고 Redis 실험을 돌리며 연결·재전송 관찰
- [ ] `nf_conntrack_count` 를 지켜보며 짧은 연결 1만 개를 만들어 증가·만료 확인
- [ ] `/proc/net/softnet_stat` 의 열 2·3 을 부하 전후로 비교
- [ ] `ebpf-tcp-latency` 실험 결과에서 keepalive 유무에 따른 연결 수 차이 해석
