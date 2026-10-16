---
title: 계층 모델과 패킷의 여행
order: 1
level: 기초
summary: TCP/IP 4계층을 패킷 하나가 캡슐화되는 과정으로 이해하기, 이더넷·IP·TCP/UDP·애플리케이션의 책임, MTU 와 단편화
tags: [TCP/IP, OSI, 캡슐화, 이더넷, IP, MTU]
experiments: [net-dns-http]
---

## 4계층 (실무 관점)

| 계층 | 프로토콜 | 주소 | 책임 | 도구 |
|---|---|---|---|---|
| 응용 | HTTP, DNS, TLS, Redis RESP | URL, 호스트명 | 의미 있는 메시지 | curl, dig, redis-cli |
| 전송 | TCP, UDP | **포트** | 프로세스 간 전달, 신뢰성(TCP) | ss/lsof, nc |
| 인터넷 | IP, ICMP | **IP 주소** | 네트워크 간 라우팅 | ip, ping, traceroute |
| 링크 | 이더넷, Wi-Fi, ARP | **MAC 주소** | 같은 링크 안 전달 | ip link, arp |

OSI 7계층은 교육용 모델. 실제 스택은 4계층으로 생각하면 충분하고, "L4 로드밸런서(포트까지)", "L7(HTTP 내용까지)" 처럼 숫자만 빌려 쓴다.

## 캡슐화: 봉투 안의 봉투

```
[이더넷 헤더 | [IP 헤더 | [TCP 헤더 | [HTTP: GET / HTTP/1.1 ...]]] | 이더넷 트레일러]
  dst MAC        dst IP      dst port 80     애플리케이션 데이터
```

보낼 때 위에서 아래로 헤더를 씌우고, 받을 때 아래서 위로 벗긴다. 각 계층은 자기 헤더만 본다. 라우터는 IP 까지, 스위치는 이더넷까지, 로드밸런서/프록시는 TCP 또는 HTTP 까지.

## 한 요청의 여정: `curl http://example.com`

1. **DNS**: `example.com` → `93.184.216.34` (UDP 53, 리졸버 캐시 → 재귀 질의)
2. **라우팅 결정**: 목적지 IP 가 내 서브넷 밖 → 기본 게이트웨이로. `ip route get 93.184.216.34`
3. **ARP**: 게이트웨이 IP 의 MAC 을 찾음 (같은 링크). `arp -a`
4. **TCP 3-way 핸드셰이크**: SYN → SYN-ACK → ACK. 이제 소켓은 ESTABLISHED
5. **HTTP 요청** 전송, 응답 수신 (TCP 가 분할·순서·재전송 처리)
6. **종료**: FIN/ACK 교환, 한쪽은 TIME_WAIT 로 잠시 대기

각 단계의 시간을 `curl -w` 로 잴 수 있다 — 실험실 참고.

## IP

- IPv4 32비트 (`192.168.1.10`), IPv6 128비트 (`2001:db8::1`).
- **서브넷**: `192.168.1.0/24` = 앞 24비트가 네트워크, 256개 주소. 같은 서브넷이면 직접, 아니면 게이트웨이.
- 사설 대역: `10/8`, `172.16/12`, `192.168/16`. 인터넷으로 나갈 땐 **NAT** 가 공인 IP 로 바꾼다.
- `127.0.0.1` 루프백은 자기 자신. 컨테이너 안의 127.0.0.1 은 컨테이너 자신이다 (Docker 노트의 bind 문제).
- TTL(홉 제한), 단편화(MTU 1500 보다 큰 패킷은 쪼개짐 — VPN/터널에서 MTU 문제가 흔하다).

```bash
ifconfig | grep inet            # macOS (Linux: ip addr)
netstat -rn | head              # 라우팅 테이블 (Linux: ip route)
ping -c 3 1.1.1.1               # ICMP echo, RTT
traceroute 1.1.1.1              # 홉마다 TTL 만료 응답으로 경로 추적
```

## ICMP

에러·진단용. `ping`(echo), `traceroute`(TTL exceeded), "destination unreachable", "fragmentation needed"(PMTU). 방화벽이 ICMP 를 다 막으면 PMTU 발견이 깨져 큰 패킷만 안 가는 괴현상이 생긴다.

## 헤더를 직접 세어 보기 — 오버헤드와 MTU

1500바이트 이더넷 프레임 하나에 실제 데이터가 얼마나 실리나.

| 층 | 헤더 크기 | 누적 |
|---|---|---|
| 이더넷(헤더 14 + FCS 4) | 18 (+ 프리앰블·간격 20, 회선상) | — |
| IPv4 | 20 (옵션 없음) | 20 |
| TCP | 20 + 옵션(타임스탬프 12) = 32 | 52 |
| **페이로드(MSS)** | 1500 − 52 = **1448** | |

- MSS(Maximum Segment Size)는 핸드셰이크 때 서로 알려 준다. `ss -ti` 의 `mss:1448` 로 확인.
- VPN·오버레이(VXLAN 50바이트, WireGuard 60바이트)를 지나면 MTU 가 줄어든다. 이걸 모르고 1500 으로 보내면 **큰 패킷만** 사라진다: 핸드셰이크는 되는데(작은 패킷) 응답 본문이 안 오는 증상. PMTU 발견이 ICMP "fragmentation needed" 에 의존하는데 방화벽이 ICMP 를 막으면 깨진다. 해결은 MSS clamping(`iptables ... TCPMSS --clamp-mss-to-pmtu`) 또는 MTU 조정.
- 작은 요청(예: Redis `GET` 수십 바이트)에서는 헤더가 데이터보다 크다. 패킷당 비용(시스템 콜·인터럽트·헤더)이 지배하므로 **요청을 묶는 것(파이프라인·배치)** 이 처리량을 크게 올린다 — [Redis 파이프라이닝](/redis/notes/06-pipelining).

## 각 계층의 "주소" 가 바뀌는 지점

같은 요청이라도 홉마다 바뀌는 것과 끝까지 유지되는 것이 있다.

```
노트북(192.168.0.10, MAC aa) ──▶ 공유기(192.168.0.1 / 공인 203.0.113.5, MAC bb) ──▶ … ──▶ 서버(93.184.216.34)
홉 1:  src MAC aa → dst MAC bb   | src IP 192.168.0.10 → dst IP 93.184.216.34 | src port 51234 → 443
홉 2:  src MAC (공유기 WAN) → 다음 라우터 | src IP 203.0.113.5(NAT 로 바뀜) → 93.184.216.34 | src port 6xxxx(NAT 로 바뀔 수 있음)
```

| 필드 | 홉마다 | NAT 에서 |
|---|---|---|
| MAC 주소 | **매 홉 바뀜**(같은 링크 안에서만 의미) | — |
| IP 주소 | 유지 | 출발지(SNAT) 또는 목적지(DNAT) 바뀜 |
| 포트 | 유지 | NAT 가 출발 포트를 바꾸기도 함 |
| TTL | 홉마다 1 감소 | — |

그래서 서버 로그의 클라이언트 IP 는 NAT 뒤의 공인 IP 이고, 프록시 뒤라면 프록시 IP 다. 원래 클라이언트 IP 를 알려면 `X-Forwarded-For` 나 PROXY 프로토콜이 필요하다 — [리버스 프록시](/nginx/notes/02-reverse-proxy-lb).

## 커널 안에서의 계층 — 소켓 API 에서 NIC 까지

애플리케이션이 `write()` 를 부르면 계층 모델이 실제 코드 경로가 된다.

```
앱: write(fd, buf)                       ← 유저 공간
 ── 시스템 콜 경계 ─────────────────────
소켓 송신 버퍼(sk_wmem)에 복사            ← L4 TCP: 세그먼트로 자르기, 시퀀스 번호
TCP 송신 → IP 출력(라우팅 결정, netfilter OUTPUT/POSTROUTING)   ← L3
neighbour(ARP) 로 다음 홉 MAC 결정 → qdisc 큐 → 드라이버 → NIC DMA  ← L2
```

| 계층 | 커널에서 보는 법 |
|---|---|
| 소켓 버퍼 | `ss -tm`(skmem), `ss -ti` |
| TCP | `nstat -az Tcp*`, `ss -ti`(cwnd, rtt, retrans) |
| IP·라우팅 | `ip route get <IP>` |
| netfilter | `iptables -t nat -L -n -v`, conntrack |
| ARP/neighbour | `ip neigh` |
| qdisc·드라이버 | `tc -s qdisc`, `ethtool -S` |

수신 경로(NIC → softirq → 소켓)와 성능 분석은 [커널 네트워크 스택](/linux-network/notes/06-kernel-stack-ebpf-performance), 시스템 콜·인터럽트 자체는 [시스템 콜과 인터럽트](/os-internals/notes/05-syscalls-interrupts).

## curl -w 로 계층별 시간 나누기

```bash
curl -s -o /dev/null -w 'dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' https://example.com
# dns=0.012 tcp=0.045 tls=0.098 ttfb=0.152 total=0.153
```

| 구간 | 계산 | 이 구간이 크면 |
|---|---|---|
| DNS | `namelookup` | 리졸버·캐시 미스 → [DNS](/linux-network/notes/03-dns) |
| TCP 연결 | `connect − namelookup` ≈ 1 RTT | 거리·경로 |
| TLS | `appconnect − connect` ≈ 1 RTT(1.3) | TLS 버전·인증서 체인·OCSP |
| 서버 처리 | `starttransfer − appconnect` − 1 RTT | 앱·DB |
| 전송 | `total − starttransfer` | 응답 크기·대역폭·혼잡 윈도우 |

실험 `net-dns-http` 가 이 분해를 자동으로 표로 만든다. 같은 요청을 두 번 보내면 두 번째의 DNS 가 0 에 가까워지는 것(캐시)도 확인할 수 있다.

## 예시로 보기 — 이 프로젝트의 계층들

| 요청 | 계층별 경로 |
|---|---|
| 브라우저 → `localhost:3000` | 루프백(`lo`) 인터페이스: L2 없음, 커널 안에서 바로 소켓으로 |
| 앱 → `127.0.0.1:6379`(Docker Redis) | 맥 루프백 → Docker Desktop 포트 포워더 → VM → 브리지 → veth → 컨테이너 |
| Nginx(18080) → 앱(3000) | 컨테이너 → `host.docker.internal` → VM 게이트웨이 → 맥 |
| kind Pod → Pod | 노드 컨테이너 안의 veth + kindnet 라우팅(같은 노드면 브리지 없이 라우팅) |

맥에서 Redis 벤치마크가 리눅스보다 훨씬 낮게 나오는 이유가 두 번째 줄이다. 계층 하나(VM 경계)가 더 있는 셈이다.

## 운영·관측 포인트

- MTU 문제는 "작은 요청은 되고 큰 응답만 실패" 로 나타난다. `ping -D -s <크기>`(macOS) / `ping -M do -s`(Linux)로 경계를 찾는다.
- 계층별 오류 카운터(`nstat` 의 `IpInDiscards`, `TcpRetransSegs`, `ethtool -S` 의 drop)를 메트릭으로 수집하면 "네트워크가 느리다" 를 어느 층의 문제인지로 바꿀 수 있다 — [시스템 수준 성능](/performance/notes/06-system-level).

## 실습 체크리스트

- [ ] `traceroute example.com` 으로 홉 수와 RTT 증가 보기
- [ ] `netstat -rn` 에서 default 게이트웨이와 내 서브넷 확인
- [ ] `curl -w` 로 DNS/connect/TTFB 시간 분리 (실험실)
- [ ] `ping -s 1472 -D 1.1.1.1` (DF 설정) 로 MTU 경계 실험 (1473 부터 실패하는지)
- [ ] `ss -ti` 로 내 연결의 mss 값 확인, 1500 − 헤더 계산과 비교
- [ ] `ip route get 1.1.1.1`(Linux) / `route get 1.1.1.1`(macOS)로 나가는 인터페이스·게이트웨이 확인

## 관련 노트

- [포트·소켓·TCP 상태](/linux-network/notes/02-ip-ports-sockets)
- [Docker 볼륨과 네트워크](/docker/notes/04-volumes-networks) — 컨테이너의 네트워크 네임스페이스
