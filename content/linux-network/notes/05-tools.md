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
