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

## 실습 체크리스트

- [ ] `traceroute example.com` 으로 홉 수와 RTT 증가 보기
- [ ] `netstat -rn` 에서 default 게이트웨이와 내 서브넷 확인
- [ ] `curl -w` 로 DNS/connect/TTFB 시간 분리 (실험실)
- [ ] `ping -s 1472 -D 1.1.1.1` (DF 설정) 로 MTU 경계 실험 (1473 부터 실패하는지)

## 관련 노트

- [포트·소켓·TCP 상태](/linux-network/notes/02-ip-ports-sockets)
- [Docker 볼륨과 네트워크](/docker/notes/04-volumes-networks) — 컨테이너의 네트워크 네임스페이스
