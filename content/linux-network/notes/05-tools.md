---
title: 진단 도구 모음과 NAT·컨테이너 네트워킹
order: 5
level: 중급
summary: 증상별로 꺼내는 도구(ss/lsof, tcpdump, curl, dig, mtr), 패킷 캡처 읽기, NAT 와 iptables 기초, Docker/Kubernetes 네트워킹이 실제로 하는 일, 방화벽
tags: [tcpdump, ss, lsof, mtr, iptables, NAT, 컨테이너네트워킹, 방화벽]
experiments: [net-ports-sockets, net-dns-http]
---

## 증상 → 도구

| 증상 | 먼저 볼 것 |
|---|---|
| 연결 거부 (`ECONNREFUSED`) | 포트에 아무도 안 듣는다: `lsof -i :PORT` / `ss -tlnp`, bind 주소(127.0.0.1 vs 0.0.0.0) |
| 타임아웃 (응답 없음) | 방화벽/보안그룹이 SYN 을 버림: `nc -zv -w 3`, `traceroute`, 클라우드 SG 확인 |
| 이름 해석 실패 | `dig`, `/etc/resolv.conf` |
| 간헐적 느림 | `mtr`(경로별 손실·지연), `curl -w`, 서버 측 `ss -ti`(재전송), DNS |
| 연결은 되는데 데이터 안 옴 | 앱 문제 또는 MTU: `tcpdump` 로 핸드셰이크 후 멈추는지 |
| 포트 고갈 / 소켓 폭증 | `ss -s`, TIME_WAIT/CLOSE_WAIT 집계, `ulimit -n` |
| 502 from proxy | 업스트림 죽음/이름 해석: 프록시 error_log |

## 도구 요약

```bash
# 소켓
ss -tlnp                  # Linux: 듣는 TCP + 프로세스   (macOS: lsof -nP -iTCP -sTCP:LISTEN)
ss -tanp | grep 6379      # 연결 상태
ss -ti                    # 혼잡 윈도우, RTT, 재전송 (Linux)

# 연결 테스트
nc -zv host 443           # TCP 열림?
nc -u -zv host 53         # UDP (불확실)
telnet host 80            # 손으로 프로토콜 치기
curl -v --connect-timeout 3 URL

# 경로
ping -c 5 host ; traceroute host ; mtr -rwc 20 host   # mtr: traceroute + ping 통계

# 캡처
sudo tcpdump -i any -nn port 6379                     # Redis 트래픽
sudo tcpdump -i en0 -nn 'tcp[tcpflags] & (tcp-syn) != 0'   # SYN 만
sudo tcpdump -i any -nn -w cap.pcap host 1.2.3.4      # 파일로 → Wireshark
tcpdump -r cap.pcap -A | head                         # ASCII 페이로드

# 인터페이스·라우팅
ip addr ; ip route ; ip neigh         (macOS: ifconfig ; netstat -rn ; arp -a)
```

tcpdump 출력 읽기: `IP src.port > dst.port: Flags [S], seq ...` — `[S]` SYN, `[S.]` SYN-ACK, `[.]` ACK, `[P.]` 데이터, `[F.]` FIN, `[R]` RST(거부/강제 종료).

## NAT 와 iptables/nftables

- **SNAT/MASQUERADE**: 사설 IP → 공인 IP 로 바꿔 나감 (집 공유기, Docker 컨테이너가 인터넷 나갈 때).
- **DNAT**: 들어오는 패킷의 목적지를 바꿈 (포트 포워딩, Docker `-p`).
- 리눅스는 netfilter 로 구현. `iptables -t nat -L -n` 으로 Docker 가 만든 규칙을 볼 수 있다.

```bash
sudo iptables -t nat -L -n -v | head -30     # DOCKER 체인의 DNAT 규칙
sudo iptables -L -n -v                        # filter: INPUT/FORWARD/OUTPUT
sudo nft list ruleset                          # nftables
```

## 컨테이너 네트워킹이 하는 일

Docker 가 `docker run -p 8080:80` 을 처리할 때:
1. 컨테이너용 **네트워크 네임스페이스** 생성 (자기만의 인터페이스·라우팅·iptables).
2. **veth 쌍**: 한쪽은 컨테이너 안 `eth0`, 다른 쪽은 호스트의 `docker0` 브리지에.
3. 컨테이너 IP(172.17.x.x) 할당, 기본 게이트웨이 = 브리지.
4. 나가는 트래픽은 MASQUERADE, 들어오는 8080 은 DNAT 로 컨테이너 80 으로. (Docker Desktop 은 VM 안에서 이 일을 하고 호스트엔 vpnkit/gVisor 프록시가 포트를 연다.)

Kubernetes 는 CNI 플러그인이 Pod 마다 같은 일을 하고, kube-proxy 가 Service ClusterIP 를 iptables/IPVS DNAT 규칙으로 Pod IP 들에 분산한다. `kubectl exec` 로 Pod 에 들어가 `ip addr`, `cat /etc/resolv.conf`, `nc -zv redis 6379` 를 해 보면 보인다.

## 방화벽과 보안 그룹

- 호스트: `ufw`, `firewalld`, macOS 는 시스템 설정의 방화벽/`pfctl`.
- 클라우드: 보안 그룹(인스턴스 단위, stateful), NACL(서브넷, stateless). "타임아웃" 의 80% 는 여기다.
- 원칙: 기본 거부, 필요한 포트만, 관리 포트(22, 6379, 5432)는 사설망/VPN 에서만. **Redis 를 0.0.0.0 에 비밀번호 없이 공개하면 분 단위로 털린다.**

## 성능 측정

```bash
iperf3 -s   /   iperf3 -c host          # 대역폭
ab -n 1000 -c 50 URL ; wrk -t4 -c100 -d10s URL   # HTTP 부하
redis-benchmark -h host                  # 이 프로젝트의 벤치마크 페이지
```

## 더 공부할 것

- "TCP/IP Illustrated, Vol.1" (Stevens) — 고전
- Julia Evans 의 네트워킹 zine (tcpdump, DNS)
- Cloudflare 블로그 (QUIC, 네트워크 디버깅 사례)
- Wireshark 로 pcap 을 열어 핸드셰이크·TLS 를 눈으로 따라가기
- eBPF 도구 (bcc/bpftrace) 로 커널 수준 관찰

## tcpdump 로 문제를 "보는" 패턴

증상별로 캡처에서 찾을 모양이 정해져 있다.

| 증상 | 캡처에서 보이는 것 | 해석 |
|---|---|---|
| `ECONNREFUSED` | `[S]` → `[R.]` | 포트에 리스너 없음(또는 방화벽 REJECT) |
| 연결 타임아웃 | `[S]` 재전송만 1s, 3s, 7s… | SYN 이 버려짐(방화벽 DROP, 라우팅) |
| 연결 후 멈춤 | 핸드셰이크 OK, 큰 데이터 세그먼트 재전송 반복 | MTU/PMTU 문제 |
| 간헐적 reset | 유휴 후 첫 요청에 `[R]` | 중간 장비 idle timeout |
| 느린 응답 | 요청 `[P.]` 후 응답까지 긴 공백 | 서버 처리 지연(네트워크 아님) |
| 처리량 낮음 | `win 0`(zero window) | 수신 측이 못 읽음 |

```bash
# Redis 요청과 응답 사이의 서버 처리 시간 보기 (상대 타임스탬프)
sudo tcpdump -i lo0 -nn -ttt 'port 6379' -c 20
#  00:00:00.000000 IP 127.0.0.1.52344 > 127.0.0.1.6379: Flags [P.], length 31   ← 요청
#  00:00:00.000081 IP 127.0.0.1.6379 > 127.0.0.1.52344: Flags [P.], length 7    ← 81µs 뒤 응답
```

`-ttt` 는 직전 패킷과의 시간 차를 보여 준다. 요청과 응답 사이 간격이 서버 처리 시간, 응답과 다음 요청 사이가 클라이언트(앱) 시간이다. "네트워크가 느리다" 는 주장을 검증하는 가장 빠른 방법이다.

### 캡처 필터 vs 표시 필터

- **캡처 필터**(BPF, tcpdump 인자): 커널에서 거른다. 가볍다. `'tcp port 6379 and host 10.0.0.5'`.
- **표시 필터**(Wireshark): 캡처한 것을 보며 거른다. 풍부하다. `tcp.analysis.retransmission`, `http.response.code == 502`.

tcpdump 의 필터 문법이 곧 BPF 프로그램으로 컴파일되어 커널에 붙는다. eBPF 의 조상이 이것이다 — [eBPF 란](/ebpf/notes/01-what-is-ebpf).

## netfilter 훅과 패킷 경로

iptables 규칙이 "어디서" 적용되는지 알아야 Docker·Kubernetes 의 NAT 를 디버깅할 수 있다.

```
들어오는 패킷 → PREROUTING(nat: DNAT) → 라우팅 결정 ┬→ INPUT(filter) → 로컬 프로세스
                                                     └→ FORWARD(filter) → POSTROUTING(nat: SNAT/MASQUERADE) → 나감
로컬 프로세스가 보내는 패킷 → OUTPUT(nat, filter) → POSTROUTING → 나감
```

| 장면 | 체인 |
|---|---|
| Docker `-p 8080:80` | nat PREROUTING → DOCKER 체인 DNAT |
| 컨테이너 → 인터넷 | nat POSTROUTING MASQUERADE |
| 컨테이너 ↔ 컨테이너(다른 브리지) | filter FORWARD(DOCKER-ISOLATION) |
| Kubernetes Service(ClusterIP) | nat PREROUTING/OUTPUT → KUBE-SERVICES → KUBE-SEP DNAT(확률 분산) |

```bash
sudo iptables -t nat -L KUBE-SERVICES -n | head            # (kind 노드 안에서) Service 별 규칙
sudo conntrack -L -p tcp --dport 6379 | head                 # NAT 된 연결의 원래/변환 주소
```

conntrack 은 NAT 된 연결의 "원래 주소 ↔ 바뀐 주소" 를 기억한다. 응답 패킷이 돌아올 때 이 표로 역변환한다. 그래서 conntrack 테이블이 가득 차면 NAT 를 거치는 새 연결이 조용히 버려진다 — [커널 네트워크 스택](/linux-network/notes/06-kernel-stack-ebpf-performance).

## 컨테이너 네트워크 디버깅 레시피

```bash
# 1) 컨테이너의 네트워크 네임스페이스로 들어가 도구 사용 (이미지에 도구가 없어도 됨)
docker run --rm -it --network container:study-redis nicolaka/netshoot
#   ss -tlnp ; ip addr ; ip route ; dig kafka ; tcpdump -i eth0 port 6379
# 2) kind Pod 이라면
kubectl debug -it pod/web-xxx --image=nicolaka/netshoot --target=web -n study
# 3) Docker Desktop VM 자체로 들어가기 (브리지·iptables 보기)
docker run --rm -it --privileged --pid=host alpine nsenter -t 1 -m -u -n -i sh
```

`--network container:X` 는 Kubernetes Pod 안 사이드카가 같은 네트워크를 공유하는 원리와 같다 — [Docker 내부](/docker/notes/08-internals-namespaces-cgroups).

## 예시로 보기 — 이 프로젝트에서 실제로 쓴 진단

| 상황 | 쓴 도구 | 결론 |
|---|---|---|
| 호스트에서 Docker Redis 연결 reset | `docker exec netstat -tln` | `bind 127.0.0.1` 이 컨테이너 루프백만 들음 |
| 포트 충돌(다른 프로젝트 컨테이너) | `lsof -nP -iTCP:6390` | 기본 포트를 비켜 잡기(19092, 15432 …) |
| NetworkPolicy 적용 후 이름 해석 실패 | `nslookup` in Pod | egress 기본 거부가 DNS(53)까지 막음 |
| Kafka 가 호스트에서 메타데이터 실패 | `kafka-broker-api-versions` | advertised listener 분리 |
| 3300 포트를 다른 Next 서버가 점유 | `lsof -iTCP:3300 -sTCP:LISTEN` | 다른 포트(3310)로 우회 |

## 운영·관측 포인트

- 진단 도구 컨테이너(netshoot 등)를 미리 레지스트리에 준비해 두면, 장애 중 외부 인터넷 없이도 쓸 수 있다.
- 패킷 캡처는 민감 정보(평문 비밀번호, 토큰)를 담을 수 있다. pcap 파일은 보관·공유 정책을 정한다.

## 실전에서는 어디에 쓰이나

> 장애 대응 중 "연결이 안 된다" 를 거부·타임아웃·해석 실패·MTU 로 가르고, 컨테이너·쿠버네티스 안의 NAT 와 방화벽을 들여다볼 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 온콜 장애 대응 | 증상에서 원인 계층으로 좁히기 | 증상 → 도구 표, `nc -zv`, `ss -tlnp` | 앱 재시작부터 — 원인 증거 소실 |
| 컨테이너 Redis·DB 접속 실패 | bind 주소·포트 매핑 확인 | `--network container:X` 로 netshoot 붙이기, iptables DOCKER 체인 | 이미지에 도구 설치 후 재배포 |
| 클라우드 VM 신규 서비스 | 타임아웃이 보안 그룹 때문인지 확인 | tcpdump 로 SYN 재전송만 보이는지, SG·NACL 점검 | 앱 로그만 보기 |
| 쿠버네티스 Service 장애 | ClusterIP DNAT·conntrack 확인 | `iptables -t nat -L KUBE-SERVICES`, `conntrack -L` | Pod 재생성 반복 |
| "네트워크가 느리다" 신고 | 서버 처리 시간과 네트워크 구분 | `tcpdump -ttt` 로 요청-응답 간격 측정 | 감으로 판단 |

**이럴 땐 안 맞는다**
- 운영 트래픽 pcap 을 아무 데나 공유하는 것 — 토큰·비밀번호가 평문으로 담길 수 있다. 보관·공유 정책을 둔다.
- Redis·DB 같은 관리 포트를 방화벽에서 공개하는 것 — 사설망·VPN 에서만 연다.

**누가 매일 만나나** — SRE·온콜이 장애 첫 대응에서, 백엔드가 로컬·스테이징의 컨테이너 연결 문제를 풀 때, 보안 담당이 방화벽과 노출 포트를 점검할 때.

**면접·실무 단골 질문**
- Q. 연결 거부와 연결 타임아웃은 tcpdump 에서 어떻게 다르게 보이나? → `[S]` 뒤에 `[R.]` 이 오면 거부, `[S]` 재전송만 1·3·7초 간격으로 보이면 SYN 이 버려지는 것.
- Q. `docker run -p 8080:80` 은 커널에서 무엇을 하나? → nat PREROUTING 에서 DNAT, 나갈 때 MASQUERADE, conntrack 이 응답을 역변환한다.

## 실습 체크리스트

- [ ] `tcpdump -ttt port 6379` 로 Redis 요청·응답 간격(서버 처리 시간) 측정
- [ ] `docker run --network container:study-redis nicolaka/netshoot` 로 들어가 `ss -tlnp` 와 `ip route` 확인

## 관련 노트

- [Docker 운영과 디버깅](/docker/notes/07-ops-debugging)
- [Kubernetes Service 와 Ingress](/kubernetes/notes/04-service-ingress) — kube-proxy 의 DNAT
- [Redis 운영 명령 — 보안 기본](/redis/notes/14-ops-commands)
