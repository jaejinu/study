---
title: 포트·소켓·TCP 상태
order: 2
level: 기초
summary: 소켓 4-tuple, LISTEN 과 accept, TCP 핸드셰이크·종료와 상태 머신, TIME_WAIT 와 포트 고갈, UDP, 커널 파라미터
tags: [소켓, 포트, TCP, 핸드셰이크, TIME_WAIT, UDP, backlog]
experiments: [net-ports-sockets]
---

## 소켓

통신 끝점. 연결은 `(프로토콜, 로컬IP:포트, 원격IP:포트)` 4-tuple 로 유일하게 식별된다. 그래서 서버 포트 하나(80)로 수만 연결을 동시에 받을 수 있다 — 원격 IP:포트가 다르니까.

```
서버: socket() → bind(0.0.0.0:6379) → listen(backlog) → accept() → 연결 소켓 → read/write
클라이언트: socket() → connect(host:6379) (커널이 임시 포트 49152-65535 중 하나를 배정) → write/read
```

- `bind 0.0.0.0` 모든 인터페이스, `127.0.0.1` 루프백만. 0~1023 은 특권 포트(root 또는 CAP_NET_BIND_SERVICE).
- `backlog`: 핸드셰이크를 마쳤지만 아직 accept 안 된 연결 큐. 넘치면 SYN 이 버려진다 (`somaxconn`, 앱의 listen 인자).

## 핸드셰이크와 상태

```
클라이언트            서버
CLOSED               LISTEN
SYN_SENT  ──SYN──▶   SYN_RECV
          ◀SYN-ACK─
ESTABLISHED ─ACK─▶   ESTABLISHED
   ... 데이터 ...
FIN_WAIT_1 ─FIN──▶   CLOSE_WAIT   (앱이 close() 호출할 때까지 머묾)
FIN_WAIT_2 ◀─ACK─
           ◀─FIN──   LAST_ACK
TIME_WAIT  ──ACK─▶   CLOSED
(2×MSL, 보통 60초 뒤 CLOSED)
```

- **CLOSE_WAIT 가 쌓인다** = 상대가 끊었는데 내 앱이 소켓을 안 닫음 → 코드 버그(fd 누수).
- **TIME_WAIT 가 많다** = 내가 먼저 끊는 쪽(클라이언트, 프록시)에서 짧은 연결을 많이 만듦. 정상이지만 임시 포트 고갈 가능 → **keepalive 로 연결 재사용**이 답.
- `SYN_RECV` 폭주 = SYN flood 또는 backlog 부족.

```bash
netstat -an | awk '/tcp/ {print $6}' | sort | uniq -c       # 상태별 집계 (macOS)
ss -s ; ss -tan state time-wait | wc -l                       # Linux
lsof -nP -iTCP -sTCP:LISTEN                                   # 듣는 소켓과 프로세스
lsof -nP -i :6379
```

![TCP 연결의 일생](/diagrams/tcp-handshake.svg)

### 예시로 보기: 왜 keepalive 가 중요한가

```
연결마다 새로 맺으면:  핸드셰이크 1 RTT + TLS 1~2 RTT + 요청 1 RTT = 서울↔도쿄(35ms) 기준 100~140ms
keepalive 재사용:      요청 1 RTT = 35ms
```
Nginx 업스트림 `keepalive`, ioredis 의 단일 장수 커넥션, HTTP/2 다중화가 모두 같은 이유다. 실험실의 **DNS·HTTP** 실험이 `curl -w` 로 연결·TLS·TTFB 시간을 나눠 보여준다.

## 신뢰성과 흐름 제어 (TCP)

- 시퀀스 번호·ACK·재전송으로 순서와 무손실 보장.
- **윈도우**로 수신 측 버퍼 초과 방지, **혼잡 제어**(cubic, BBR)로 네트워크 과부하 방지. RTT 가 큰 링크에서 처리량이 낮은 건 윈도우 때문 (bandwidth-delay product).
- **Nagle**(작은 패킷 모음)과 **delayed ACK** 가 겹치면 40ms 지연 → 지연 민감 서비스는 `TCP_NODELAY`. Redis·Nginx 는 기본으로 켠다.
- **keepalive**: 유휴 연결 생존 확인 (`net.ipv4.tcp_keepalive_time`, 기본 2시간 — 로드밸런서 idle timeout 보다 짧게).

## UDP

연결·순서·재전송 없음. 작고 빠르다. DNS, QUIC(HTTP/3), 영상·게임, 메트릭(statsd). 패킷 손실·중복·순서 바뀜을 앱이 감당한다. `nc -u`, `dig` 가 UDP.

## 커널 파라미터 (Linux, 서버 튜닝)

```bash
sysctl net.core.somaxconn=4096             # accept 큐
sysctl net.ipv4.ip_local_port_range="10240 65535"
sysctl net.ipv4.tcp_tw_reuse=1             # TIME_WAIT 소켓 재사용 (클라이언트 측)
sysctl net.ipv4.tcp_fin_timeout=15
sysctl fs.file-max ; ulimit -n            # fd 한도 — 연결 하나 = fd 하나
```

컨테이너는 호스트 커널을 공유하므로 일부는 호스트에서, 일부(`net.*` 네임스페이스 값)는 `--sysctl` 로.

## listen 소켓의 두 큐

`listen(fd, backlog)` 를 하면 커널은 소켓마다 큐 두 개를 둔다.

```
클라이언트 SYN ──▶ [SYN 큐: SYN_RECV 상태들]  ──(3-way 완료)──▶ [accept 큐: 완료된 연결들] ──accept()──▶ 앱
                    크기: tcp_max_syn_backlog            크기: min(backlog, somaxconn)
```

| 큐가 넘치면 | 결과 | 확인 |
|---|---|---|
| SYN 큐 | SYN 버림(또는 SYN cookie) | `nstat -az TcpExtTCPReqQFullDrop`, `TcpExtSyncookiesSent` |
| accept 큐 | 완료된 연결의 ACK 를 버림 → 클라이언트는 연결됐다고 생각하는데 서버는 모름 → 재전송·지연 | `ss -tln` 의 Recv-Q(현재)/Send-Q(최대), `nstat -az TcpExtListenOverflows` |

```bash
ss -tln 'sport = :6379'
# State   Recv-Q  Send-Q  Local Address:Port
# LISTEN  0       511     0.0.0.0:6379        ← Send-Q=511 이 accept 큐 크기(Redis tcp-backlog)
```

Recv-Q 가 Send-Q 에 붙어 있으면 **앱이 accept 를 못 따라가는 중**이다(이벤트 루프가 막혔거나 워커가 부족). Redis 의 `tcp-backlog 511` 이 실제로는 `somaxconn` 이하로 잘린다는 경고(`WARNING: The TCP backlog setting of 511 cannot be enforced...`)가 그래서 나온다.

## 임시 포트 고갈 계산

클라이언트가 같은 서버 `IP:포트` 로 연결할 때 바꿀 수 있는 것은 **자기 임시 포트**뿐이다.

```
임시 포트 범위:  net.ipv4.ip_local_port_range = 32768–60999  → 약 28,000 개
TIME_WAIT 유지:  60 초
→ 같은 목적지로 초당 약 28000 / 60 ≈ 470 개 이상 새 연결을 만들면 포트가 고갈된다
```

증상은 `connect: Cannot assign requested address`(EADDRNOTAVAIL). 처방 순서:
1. **연결 재사용**(keepalive·풀) — 근본 해결.
2. 목적지를 늘림(서버 IP·포트가 다르면 4-tuple 이 달라 포트를 재사용 가능).
3. `tcp_tw_reuse=1`(클라이언트 측 TIME_WAIT 재사용), 포트 범위 확대.

`tcp_tw_recycle` 은 NAT 뒤 클라이언트를 깨뜨려 리눅스 4.12 에서 제거됐다. 오래된 블로그 글의 튜닝을 그대로 따르지 말 것.

## 소켓 버퍼와 Recv-Q / Send-Q (연결 소켓)

ESTABLISHED 소켓에서 `ss` 의 두 숫자는 의미가 다르다.

| | 의미 | 계속 크면 |
|---|---|---|
| Recv-Q | 커널이 받았지만 **앱이 아직 read 안 한** 바이트 | 수신 앱이 느림(이벤트 루프 블로킹, 처리 지연) |
| Send-Q | 앱이 보냈지만 **상대가 아직 ACK 안 한** 바이트 | 상대가 느림·네트워크 혼잡·윈도우 0 |

```bash
ss -tnp state established '( dport = :6379 or sport = :6379 )'
```

상대의 수신 버퍼가 꽉 차면 **zero window** 를 광고하고 송신 측은 멈춘다. Redis 에서 느린 구독자(Pub/Sub)나 큰 응답을 못 읽는 클라이언트가 이 상태가 되면, 서버의 클라이언트 출력 버퍼가 커지다가 `client-output-buffer-limit` 에 걸려 끊긴다 — [Redis 메모리와 성능](/redis/notes/12-memory-performance).

## RST 가 오는 경우들

| 상황 | 누가 RST | 클라이언트가 보는 에러 |
|---|---|---|
| 아무도 안 듣는 포트로 SYN | 커널 | `ECONNREFUSED` |
| 앱이 읽지 않은 데이터를 남긴 채 close | 커널 | `ECONNRESET`(상대 쪽) |
| `SO_LINGER` 0 으로 close | 커널 | `ECONNRESET` |
| 방화벽·LB 가 idle 연결 정리 후 패킷 도착 | 중간 장비 | `ECONNRESET`, 간헐적 |
| 서버 프로세스 크래시 | 커널 | `ECONNRESET` |

"간헐적 ECONNRESET" 은 대개 **idle timeout 불일치**다: 클라우드 LB 가 350초 idle 연결을 조용히 끊는데 클라이언트 풀은 그 연결을 재사용하려 한다. 풀의 idle timeout 을 LB 보다 짧게, 또는 TCP keepalive 를 짧게 둔다.

## 예시로 보기 — 이 프로젝트에서 소켓 보기

```bash
# 이 프로젝트가 듣는 포트 (macOS)
lsof -nP -iTCP -sTCP:LISTEN | awk 'NR==1 || /node|com.docke|redis|ollama/'
# Redis 로 열린 연결 상태별 집계 — 앱(ioredis)은 장수 연결 몇 개만 유지해야 정상
netstat -an -p tcp | awk '$4 ~ /\.6379$/ || $5 ~ /\.6379$/ {print $6}' | sort | uniq -c
```

실험 `net-ports-sockets` 는 이 프로젝트에서 실제로 LISTEN 중인 포트를 표로 만들고, `nc` 로 연결해 상태 변화를 보여 준다. 장애 실험 `chaos-redis-hang` 은 연결은 ESTABLISHED 로 살아 있는데 상대가 응답하지 않는(Send-Q 가 쌓이는) 상황을 만든다 — 그때 타임아웃이 없으면 클라이언트가 영원히 기다린다.

## 운영·관측 포인트

| 지표 | 출처 | 의미 |
|---|---|---|
| ListenOverflows / ListenDrops | `nstat` | accept 큐 넘침 → 앱이 못 따라감 |
| TIME_WAIT 수 | `ss -s` | 짧은 연결 남발 |
| CLOSE_WAIT 수 | `ss -tan state close-wait` | 앱의 소켓 누수 |
| 재전송 비율 | `TcpRetransSegs / TcpOutSegs` | 손실·혼잡 |
| 소켓 수 / fd 한도 | `/proc/<pid>/fd` 수 vs `ulimit -n` | `EMFILE` 직전 |

## 실습 체크리스트

- [ ] `lsof -iTCP -sTCP:LISTEN` 으로 Redis·dev 서버·Docker 가 듣는 포트 확인 (실험실)
- [ ] `nc -zv` 로 열린/닫힌 포트 비교
- [ ] `nc -l 9999` 로 서버를 열고 다른 터미널에서 `nc 127.0.0.1 9999` 로 채팅, `netstat` 에서 ESTABLISHED 확인
- [ ] 연결을 끊고 TIME_WAIT 가 생겼다 사라지는 것 관찰
- [ ] `ss -tln` 으로 Redis LISTEN 소켓의 Send-Q(accept 큐 크기) 확인
- [ ] 짧은 연결을 반복 생성하는 루프로 TIME_WAIT 증가를 관찰하고 keepalive 클라이언트와 비교
