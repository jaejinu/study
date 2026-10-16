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

## 실습 체크리스트

- [ ] `lsof -iTCP -sTCP:LISTEN` 으로 Redis·dev 서버·Docker 가 듣는 포트 확인 (실험실)
- [ ] `nc -zv` 로 열린/닫힌 포트 비교
- [ ] `nc -l 9999` 로 서버를 열고 다른 터미널에서 `nc 127.0.0.1 9999` 로 채팅, `netstat` 에서 ESTABLISHED 확인
- [ ] 연결을 끊고 TIME_WAIT 가 생겼다 사라지는 것 관찰
