---
title: "심화 — 프로토콜 관측과 디버깅: tcpdump · ss -ti · curl -w · qlog"
order: 7
level: 심화
summary: "느린 요청을 계층별로 쪼개는 순서(DNS → TCP → TLS → 첫 바이트 → 전송), curl -w 타이밍 변수, ss -ti 로 읽는 연결 내부(cwnd·rtt·retrans·pacing_rate·delivery_rate), tcpdump 필터와 Wireshark 의 TCP 분석(재전송·zero window·중복 ACK), TLS·QUIC 을 SSLKEYLOGFILE 로 복호화하는 법, qlog·qvis, nstat/netstat -s 의 카운터, eBPF 로 연결 수명·재전송을 추적하기, 컨테이너·쿠버네티스에서 nsenter 로 네트워크 네임스페이스에 들어가기"
tags: [tcpdump, Wireshark, ss, curl, qlog, SSLKEYLOGFILE, nstat, 재전송, nsenter, 디버깅]
experiments: []
---

## 느린 요청을 계층별로 쪼갠다

"API 가 느리다" 는 정보가 없는 말이다. 먼저 시간이 **어느 단계**에서 쓰였는지 나눈다.

```bash
curl -so /dev/null -w '
  dns        %{time_namelookup}
  tcp        %{time_connect}
  tls        %{time_appconnect}
  pretransfer %{time_pretransfer}
  ttfb       %{time_starttransfer}
  total      %{time_total}
  size       %{size_download}  speed %{speed_download} B/s
  http       %{http_version}  reused %{num_connects}
' https://example.com/api
```

| 구간 | 계산 | 길면 의심할 것 |
|---|---|---|
| DNS | `time_namelookup` | 리졸버, ndots·search 도메인([Linux 네트워크 03](/linux-network/notes/03-dns)) |
| TCP | `time_connect − time_namelookup` | RTT, SYN 큐·accept 큐 넘침, 방화벽 |
| TLS | `time_appconnect − time_connect` | RTT × 핸드셰이크 횟수, 인증서 체인, OCSP([노트 03](/network-protocols/notes/03-tls13-handshake)) |
| 서버 처리 | `time_starttransfer − time_pretransfer` | **앱** — 여기가 길면 네트워크 문제가 아니다 |
| 전송 | `time_total − time_starttransfer` | 크기 ÷ 처리량, 손실·cwnd([노트 05](/network-protocols/notes/05-loss-latency-throughput)) |

대부분의 "네트워크가 느리다" 는 서버 처리 구간이 길다. 이 표 하나로 네트워크 팀과 앱 팀의 논쟁이 끝난다.

## ss -ti — 연결 안을 들여다본다

```bash
ss -tin dst 10.0.0.5
# cubic wscale:7,7 rto:204 rtt:2.1/0.8 ato:40 mss:1448 pmtu:1500 rcvmss:536 advmss:1448
# cwnd:87 ssthresh:62 bytes_sent:1452832 bytes_retrans:28960 bytes_acked:1423872
# segs_out:1004 segs_in:512 send 479.9Mbps lastsnd:12 lastrcv:12 lastack:12
# pacing_rate 575.8Mbps delivery_rate 312.4Mbps busy:820ms unacked:12 retrans:0/20
# rcv_space:14480 rcv_ssthresh:64088 notsent:0 minrtt:1.9
```

| 필드 | 뜻 | 읽는 법 |
|---|---|---|
| `cubic` / `bbr` | 혼잡 제어 알고리즘 | [노트 04](/network-protocols/notes/04-congestion-control) |
| `rtt:2.1/0.8` | 평활 RTT / 편차 | 편차가 크면 큐잉·지터 |
| `cwnd` / `ssthresh` | 혼잡 윈도 / 슬로 스타트 임계 | cwnd 가 작게 머물면 손실이 잦음 |
| `retrans:0/20` | 현재 / 누적 재전송 | 누적이 크면 경로 손실 |
| `bytes_retrans` | 재전송 바이트 | 전체 대비 비율 = 실효 손실률 |
| `delivery_rate` | 실제 전달 속도 | 처리량 |
| `rwnd_limited`·`sndbuf_limited` | 무엇이 속도를 막았나(최근 커널) | 수신 버퍼·송신 버퍼 부족 |
| `notsent` | 소켓 버퍼에 쌓인 미전송 | 앱이 너무 많이 써 둠 |

## 커널 카운터 — 시스템 전체의 증상

```bash
nstat -az | grep -E 'TcpRetransSegs|TcpExtTCPLostRetransmit|TcpExtListenOverflows|TcpExtTCPTimeouts|TcpExtTCPSynRetrans'
netstat -s | grep -i -E 'retrans|overflow|reset'
```

- `TcpRetransSegs` 증가율 = 시스템 전체 재전송률. 평소 0.1% 미만이 정상.
- `ListenOverflows` = accept 큐 넘침([Linux 네트워크 02](/linux-network/notes/02-ip-ports-sockets)). 앱이 accept 를 못 따라감.
- `TCPTimeouts` = RTO 발생. 단순 손실보다 나쁜 신호(꼬리 지연의 원인).

이 카운터들은 node_exporter 가 Prometheus 메트릭(`node_netstat_Tcp_RetransSegs`)으로 내보낸다 — 대시보드에 "재전송률" 패널 하나를 두면 네트워크 문제를 먼저 본다([관측성 03](/observability/notes/03-instrumentation-exporters)).

## tcpdump 와 Wireshark

```bash
tcpdump -i eth0 -nn -s 0 -w /tmp/c.pcap 'host 10.0.0.5 and port 443'
tcpdump -i any -nn 'tcp[tcpflags] & (tcp-syn|tcp-rst) != 0'      # SYN·RST 만 — 연결 실패 찾기
tcpdump -i eth0 -nn 'tcp port 80 and (tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x47455420)'   # "GET " 으로 시작하는 패킷
```

Wireshark 의 TCP 분석(`tcp.analysis.flags`)이 자동으로 표시하는 것:

| 표시 | 의미 |
|---|---|
| Retransmission / Fast Retransmission | 손실 → 재전송 |
| Duplicate ACK | 수신자가 순서 어긋남을 알림(빠른 재전송 신호) |
| **Zero Window** | 수신자 버퍼가 가득 참 — 수신 앱이 느리다 |
| Window Full | 송신자가 윈도만큼 다 보냄 — 윈도가 상한 |
| RST | 강제 종료 — 방화벽·타임아웃·앱 크래시 |

"Statistics → TCP Stream Graphs → Stevens" 그래프는 시간 대비 시퀀스 번호로 슬로 스타트·손실·정체를 한눈에 보여 준다.

## 암호화된 트래픽 보기 — SSLKEYLOGFILE

TLS·QUIC 은 페이로드가 암호화돼 있다. 클라이언트가 세션 키를 파일로 남기게 하면 Wireshark 가 복호화한다.

```bash
SSLKEYLOGFILE=/tmp/keys.log curl https://example.com/          # curl, 브라우저, Node(--tls-keylog)
node --tls-keylog=/tmp/keys.log app.js
# Wireshark: Preferences → Protocols → TLS → (Pre)-Master-Secret log filename = /tmp/keys.log
```

키 로그 파일은 그 세션의 모든 비밀을 푸는 열쇠다 — 운영에서 켜 두면 안 된다([보안 04](/security/notes/04-secrets-management)).

### QUIC 은 qlog

QUIC 은 전송 계층까지 암호화돼 tcpdump 로는 거의 아무것도 안 보인다. 대신 구현이 남기는 표준 이벤트 로그 **qlog**(JSON)를 쓴다: 패킷 송수신, 손실 감지, cwnd 변화, 스트림 상태. qvis 로 시각화하면 Stevens 그래프와 같은 그림을 얻는다([노트 02](/network-protocols/notes/02-quic)).

## eBPF 로 보기

tcpdump 는 패킷을, eBPF 는 **커널 이벤트**를 본다. 패킷을 다 저장하지 않고도 연결 수명·재전송·RTT 를 요약할 수 있다([eBPF 03](/ebpf/notes/03-bcc-libbpf-tools)).

```bash
tcplife          # 연결별 시작·종료·바이트·지속 시간
tcpretrans       # 재전송이 일어난 연결과 상태
tcprtt -i 1      # RTT 히스토그램
tcpconnlat       # connect 지연
```

실험실의 `ebpf-tcp-latency` 가 앱 → Redis 연결 수명을 bpftrace 로 관측한다.

## 컨테이너·쿠버네티스에서

컨테이너 이미지에는 tcpdump·ss 가 없는 경우가 많다. 호스트(또는 노드)에서 그 컨테이너의 **네트워크 네임스페이스**로 들어간다.

```bash
PID=$(docker inspect -f '{{.State.Pid}}' study-redis)
nsenter -t $PID -n ss -tin                  # 컨테이너의 소켓을 호스트 도구로
nsenter -t $PID -n tcpdump -i eth0 -nn port 6379
kubectl debug -it pod/web-xxx --image=nicolaka/netshoot --target=web   # 쿠버네티스: 임시 디버그 컨테이너
```

`kubectl debug --target` 은 같은 네트워크·PID 네임스페이스를 공유하는 에페메럴 컨테이너를 붙인다. 셸 없는(distroless) 이미지를 디버깅하는 표준 방법이다([운영체제 07](/os-internals/notes/07-containers-are-processes)).

## 예시로 보기 — 이 프로젝트에서

이 주제의 실험들이 쓰는 도구가 그대로 디버깅 도구다.

| 실험 | 쓰는 도구 | 디버깅에서의 쓰임 |
|---|---|---|
| `netp-loss-throughput` | `iperf3 -J`(재전송·RTT), `tc netem` | 경로 처리량 기준선, 장애 재현 |
| `netp-h1-vs-h2` | `curl -w '%{http_version} %{num_connects}'` | 버전 협상·연결 재사용 확인 |
| `netp-congestion-control` | `/proc/sys/net/ipv4/tcp_available_congestion_control`, `ping` | 알고리즘 확인, 버퍼블로트 감지 |

실험을 만들며 겪은 디버깅 하나: 얕은 큐(`netem limit 20`)인데도 RTT 가 342ms 로 나왔다. `ethtool -k eth0` 으로 TSO/GSO 가 켜져 있는 것을 보고, 큐의 "패킷" 이 64KB 묶음이었다는 것을 알았다. **도구가 보여 주는 단위가 무엇인지**(패킷인가, 세그먼트인가, 바이트인가) 확인하는 습관이 디버깅의 절반이다.

## 증상 → 의심 → 도구

| 증상 | 의심 | 첫 도구 |
|---|---|---|
| 첫 요청만 느리고 이후 빠름 | DNS, TCP·TLS 핸드셰이크 | `curl -w` 구간 분해 |
| 큰 응답만 느림 | 처리량 — 손실·cwnd·버퍼 | `ss -ti`, `iperf3`, 재전송 카운터 |
| 간헐적으로 수 초씩 멈춤 | RTO(타임아웃 재전송), 프로토콜 감지 지연 | `nstat TCPTimeouts`, tcpdump 의 재전송 간격 |
| 연결 실패(connection refused) | 서버가 안 떠 있음, 포트 오타 | `ss -lnt`, RST 패킷 |
| 연결 실패(timeout) | 방화벽·보안 그룹이 SYN 을 버림 | tcpdump 로 SYN 재전송만 보이는지 |
| 연결이 중간에 끊김 | 유휴 타임아웃(LB·NAT), keepalive 부족 | RST 를 보낸 쪽 IP, 끊기는 간격 |
| 부하 시 지연 급증 | 큐잉(accept 큐·버퍼블로트·앱 스레드) | `ListenOverflows`, ping 지연, 앱 지표 |
| HTTPS 만 실패 | 인증서·SNI·TLS 버전 | `openssl s_client -servername` |

## 기록을 남기는 습관

1. 재현 조건(시각, 출발지, 목적지, 크기)을 적는다.
2. 각 계층 숫자(DNS·TCP·TLS·TTFB·전송)를 표로 남긴다 — 다음 장애 때 기준선이 된다.
3. 가설 하나를 바꾸고 다시 잰다(netem 으로 조건 재현이 가능하면 가장 좋다).
4. 결론을 포스트모템 형식으로([SRE 05](/sre/notes/05-incident-postmortem)).

> 이어서 읽기: [HTTP/1.1 → 2 → 3](/network-protocols/notes/01-http1-http2-http3) · [손실·지연과 처리량](/network-protocols/notes/05-loss-latency-throughput) · [Linux 네트워크 05 — 도구](/linux-network/notes/05-tools) · [서비스 메시 05 — 메시 관측](/service-mesh/notes/05-observability)

## 실전에서는 어디에 쓰이나

> 장애 대응과 성능 튜닝에서 "네트워크가 느리다" 를 구간·계층별 숫자로 바꿔야 하는 순간에 이 도구들이 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 온콜 장애 대응 | 앱 문제인지 네트워크 문제인지 가르기 | `curl -w` 로 DNS·TCP·TLS·TTFB·전송 분해 | 감으로 추측 — 팀 간 논쟁만 길어짐 |
| 쿠버네티스 distroless Pod | 셸·도구 없는 컨테이너의 네트워크 확인 | `kubectl debug --target`, 노드에서 `nsenter -n` | 디버그 이미지로 재배포 — 재현 조건이 사라짐 |
| 인프라 모니터링 대시보드 | 네트워크 이상을 앱 지연보다 먼저 감지 | node_exporter 의 재전송·`ListenOverflows` 패널 | 앱 지연 지표만 — 원인 계층을 모름 |
| 핀테크 외부 기관 연동 | 간헐적 끊김·RST 를 보낸 쪽 찾기 | tcpdump SYN·RST 필터, Wireshark TCP 분석 | 앱 로그만 — 연결 수준 사건이 안 보임 |
| 대규모 서비스 상시 관측 | 패킷 저장 없이 재전송·RTT 추적 | eBPF `tcpretrans`·`tcprtt`·`tcplife` | tcpdump 상시 수집 — 저장·CPU 부담 |

**이럴 땐 안 맞는다**
- 운영 환경에 `SSLKEYLOGFILE` 을 켜 두는 것 — 세션 비밀이 그대로 남는다. 재현 환경에서만 쓴다.
- 처음부터 tcpdump 를 여는 것 — 대부분 서버 처리 구간이 원인이다. `curl -w` 로 범위를 먼저 좁힌다.

**누가 매일 만나나** — SRE·온콜 엔지니어가 장애 티켓의 첫 30분에, 백엔드가 "우리 서버는 빨랐다" 를 숫자로 증명할 때, 모니터링 담당이 재전송률 알림을 설계할 때.

**면접·실무 단골 질문**
- Q. "API 가 느리다" 는 신고를 받으면 무엇부터? → DNS → TCP → TLS → 서버 처리 → 전송 순서로 구간을 나눠 가장 긴 구간을 찾는다.
- Q. connection refused 와 connection timeout 의 차이는? → refused 는 리스너가 없어 RST 가 온 것, timeout 은 방화벽 등이 SYN 을 버려 응답이 없는 것.

## 실습 체크리스트

- [ ] 느린 API 하나를 `curl -w` 로 5구간으로 쪼개고, 가장 긴 구간의 원인을 추론
- [ ] `ss -tin` 으로 Redis 연결의 `rtt`·`cwnd`·`retrans` 를 읽기 (`nsenter` 사용)
- [ ] `SSLKEYLOGFILE` 로 curl 의 HTTPS 요청을 Wireshark 에서 복호화
- [ ] `nstat` 의 `TcpRetransSegs` 를 1분 간격으로 두 번 읽어 재전송률 계산
- [ ] `kubectl debug --target` 으로 셸 없는 Pod 에서 `ss`·`dig` 실행
