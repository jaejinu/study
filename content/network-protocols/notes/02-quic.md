---
title: "QUIC — UDP 위에 다시 만든 전송 계층"
order: 2
level: 중급
summary: "QUIC 이 TCP 를 고치지 않고 UDP 위에 새로 만든 이유(커널·미들박스 경직), 1-RTT 연결 수립과 0-RTT 재연결, TLS 1.3 이 전송에 녹아든 구조, 스트림별 순서 보장으로 없앤 머리 막힘, 패킷 번호와 ACK 범위로 개선한 손실 복구, 연결 ID 와 연결 이전(와이파이→LTE), 유저 공간 구현의 장단점(CPU 비용·GSO), 방화벽·로드밸런서·관측(qlog)에서 생기는 운영 문제"
tags: [QUIC, HTTP/3, UDP, 0-RTT, 연결 이전, 연결 ID, 손실 복구, qlog, 머리 막힘]
experiments: [netp-h1-vs-h2]
---

## 왜 TCP 를 고치지 않았나

HTTP/2 의 머리 막힘([노트 01](/network-protocols/notes/01-http1-http2-http3))은 TCP 의 "바이트 순서 보장" 때문이다. 그럼 TCP 에 스트림을 넣으면 되지 않나? 현실은 이렇다.

- **TCP 는 커널에 있다.** 새 기능은 OS 업데이트를 기다려야 하고, 서버·클라이언트·모바일 기기가 모두 바뀌는 데 10년이 걸린다(TCP Fast Open 은 이 문제로 사실상 실패했다).
- **미들박스가 TCP 를 안다.** 방화벽·NAT·로드밸런서가 TCP 헤더를 읽고 고친다. 모르는 옵션이 붙은 패킷을 버리는 장비가 많다 — 이를 **프로토콜 경직(ossification)** 이라 한다.

QUIC 의 답: **UDP 위에, 유저 공간에, 거의 모든 헤더를 암호화해서** 만든다. UDP 는 미들박스가 그냥 통과시키고, 유저 공간이면 앱 업데이트로 배포되며, 암호화하면 미들박스가 읽고 고칠 수 없어 앞으로도 경직되지 않는다.

## 연결 수립 — 1 RTT, 재연결은 0 RTT

```
TCP + TLS 1.3:  SYN ─▶ ◀─ SYN/ACK   ClientHello ─▶ ◀─ ServerHello…Finished   요청 ─▶
                └──── 1 RTT ────┘   └────────────── 1 RTT ───────────────┘   (2 RTT 후 첫 바이트)

QUIC:           Initial(ClientHello) ─▶ ◀─ Initial+Handshake(ServerHello…)   요청 ─▶
                └──────────────────── 1 RTT ─────────────────────┘          (1 RTT 후 첫 바이트)

QUIC 재연결:    Initial + 0-RTT(요청 데이터 함께) ─▶                          (0 RTT)
```

TLS 1.3 핸드셰이크가 **전송 핸드셰이크와 합쳐져** 한 번에 끝난다([노트 03](/network-protocols/notes/03-tls13-handshake)). 지연 100ms 모바일에서 첫 바이트가 200ms 빨라진다 — 페이지 로딩에서 큰 차이다.

0-RTT 는 이전 연결에서 받은 세션 티켓으로 첫 패킷에 요청을 싣는다. 대가는 **재전송 공격(replay)**: 공격자가 0-RTT 패킷을 복사해 다시 보내면 서버가 요청을 두 번 처리할 수 있다. 그래서 0-RTT 에는 **멱등 요청(GET)만** 허용해야 한다.

## 스트림 — 순서는 스트림 안에서만

QUIC 연결 안에 여러 스트림이 있고, **각 스트림이 따로 순서를 보장**한다.

```
QUIC 패킷: [S1 프레임][S3 프레임]   [S5 프레임][S1 프레임]
손실:           ✗ (S3 를 실은 패킷)
수신 측: S1·S5 는 바로 앱에 전달, S3 만 재전송을 기다림
```

HTTP/3 에서 요청 하나 = 양방향 스트림 하나. 손실은 그 패킷에 실린 스트림만 세운다. 헤더 압축(QPACK)도 스트림 간 순서 의존을 줄이도록 설계를 바꿨다 — HPACK 은 동적 테이블 갱신이 순서대로 도착한다고 가정했기 때문이다.

## 손실 복구 — TCP 의 모호함을 없앴다

| 항목 | TCP | QUIC |
|---|---|---|
| 번호 | 바이트 시퀀스 번호 — 재전송도 같은 번호 | 패킷 번호 — **재전송은 새 번호** |
| RTT 측정 | 재전송된 세그먼트의 ACK 가 원본 건지 재전송 건지 모름(Karn 알고리즘으로 회피) | 패킷 번호가 달라 모호함 없음 |
| ACK | 누적 ACK + SACK 블록(최대 3~4개) | ACK 범위 최대 수백 개 |
| ACK 지연 | 추정 | ACK 프레임에 지연 시간을 명시 |
| 혼잡 제어 | 커널 구현(CUBIC 등) | 앱 안 구현 — 알고리즘을 앱 업데이트로 바꿀 수 있음 |

결과적으로 손실 감지가 더 빠르고 정확하다. 혼잡 제어 자체는 TCP 와 같은 계열(NewReno·CUBIC·BBR)을 쓴다([노트 04](/network-protocols/notes/04-congestion-control)).

## 연결 ID 와 연결 이전

TCP 연결은 4-튜플(출발 IP·포트, 목적 IP·포트)로 식별된다. 휴대폰이 와이파이에서 LTE 로 바뀌면 출발 IP 가 바뀌어 **모든 연결이 끊긴다**.

QUIC 연결은 **연결 ID** 로 식별된다. IP 가 바뀌어도 같은 연결 ID 로 패킷을 보내면 서버가 같은 연결로 알아본다(경로 검증 후). 다운로드·화상 통화가 네트워크 전환에도 이어진다.

운영 관점의 함정: **로드밸런서**가 4-튜플로 백엔드를 고르면 IP 가 바뀐 패킷이 다른 서버로 간다. QUIC 을 이해하는 LB 는 연결 ID 에 서버 식별자를 넣어(QUIC-LB) 같은 서버로 보낸다([노트 06](/network-protocols/notes/06-load-balancing-cdn)).

## 유저 공간의 대가

| 장점 | 단점 |
|---|---|
| 빠른 진화(브라우저 업데이트로 배포) | **CPU 비용**: 커널 TCP 는 오프로드(TSO/GRO)·제로 카피가 성숙, QUIC 은 패킷마다 유저↔커널 전환과 암호화 |
| 알고리즘을 앱별로 선택 | 구현마다 동작이 다름(상호 운용성 테스트 필요) |
| 미들박스 간섭 없음 | 미들박스가 볼 수 없어 **네트워크 운영자의 디버깅이 어려움** |

CPU 비용을 줄이려고 리눅스는 UDP GSO/GRO(여러 UDP 패킷을 한 번의 시스템 콜로)를 지원한다. 큰 서비스들은 QUIC 처리량이 같은 CPU 에서 TCP+TLS 의 절반쯤이던 시기를 거쳐 지금은 격차를 많이 줄였다. 시스템 콜 비용 자체는 [운영체제 05](/os-internals/notes/05-syscalls-interrupts)에서 다룬다.

## 운영에서 부딪히는 것

- **UDP 443 이 막힌 네트워크**: 클라이언트는 TCP 로 폴백한다. 그래서 서버는 항상 HTTP/2 를 함께 연다.
- **UDP 트래픽 제한**: 일부 방화벽·DDoS 장비가 UDP 를 의심해 속도 제한을 건다.
- **관측**: tcpdump 로는 암호화된 페이로드밖에 안 보인다. 대신 **qlog**(QUIC 이벤트 로그 표준)와 qvis 같은 시각화 도구를 쓴다. 키 로그(`SSLKEYLOGFILE`)가 있으면 Wireshark 가 복호화한다([노트 07](/network-protocols/notes/07-observing-debugging)).
- **MTU**: QUIC 은 IP 단편화를 금지하고 최소 1200 바이트 데이터그램을 요구한다. 경로 MTU 가 작으면 연결이 실패한다.

## 예시로 보기 — 이 프로젝트에서

이 실험실의 이미지(`study-netp:2`, nginx 1.27-alpine)는 `nginx -V` 에 `http_v3_module` 이 있다. 즉 서버 쪽은 준비돼 있다. 측정이 막힌 곳은 클라이언트였다: alpine 의 curl 8.12 는 `curl -V` 의 기능 목록에 `HTTP3` 이 없다. HTTP/3 실험을 하려면:

```bash
# 서버: TLS 인증서(사설 CA, nginx/tls/gen-certs.sh) + quic 리스너
listen 443 quic reuseport;  listen 443 ssl;  ssl_protocols TLSv1.3;
# 클라이언트: HTTP/3 지원 curl (ngtcp2 또는 quiche 로 빌드된 이미지)
curl --http3-only -k https://lab-netp-srv/ -w '%{http_version}\n'   # 3
# 그리고 netem 으로 손실 2% 를 넣어 HTTP/2 와 비교 — 머리 막힘이 사라지는지
```

예측: 실험 `netp-h1-vs-h2` 의 "20KB × 50 + 손실 2%" 에서 HTTP/2 가 1.73배 느려진 만큼을 HTTP/3 은 덜 겪어야 한다. 스트림이 독립이기 때문이다.

## QUIC 패킷을 대충 보면

```
UDP 헤더 (평문: 출발·목적 포트)
└─ QUIC 헤더
   ├─ 긴 헤더 (핸드셰이크 중): 버전, 목적 연결 ID, 출발 연결 ID, 패킷 종류(Initial/Handshake/0-RTT)
   └─ 짧은 헤더 (이후):      목적 연결 ID, 패킷 번호(암호화됨)
   └─ 페이로드 (전부 암호화): 프레임들 — STREAM, ACK, CRYPTO, MAX_DATA, NEW_CONNECTION_ID, PING …
```

- 평문으로 보이는 것은 거의 연결 ID 와 몇 비트뿐이다. 미들박스가 "이 패킷은 ACK 다" 같은 판단을 할 수 없게 일부러 감췄다.
- 한 UDP 데이터그램에 여러 QUIC 패킷(서로 다른 암호화 수준)을 이어 붙일 수 있다(coalescing) — 핸드셰이크 왕복을 줄이는 기법.
- **스핀 비트**: 운영자가 RTT 를 수동 관측할 수 있게 남겨 둔 1비트. 프라이버시 때문에 끌 수 있다.

## TCP 와의 기능 대응

| TCP | QUIC |
|---|---|
| SYN / SYN-ACK | Initial 패킷(+ TLS ClientHello/ServerHello) |
| 시퀀스 번호(바이트) | 패킷 번호 + 스트림별 오프셋 |
| SACK | ACK 프레임(범위 수백 개) |
| 수신 윈도 | MAX_DATA(연결) · MAX_STREAM_DATA(스트림) |
| FIN / RST | STREAM 의 FIN 비트 / RESET_STREAM, CONNECTION_CLOSE |
| keepalive | PING 프레임 |
| 4-튜플 식별 | 연결 ID |

## 실습 아이디어

- **0-RTT 확인**: 같은 사이트에 두 번 접속하며 qlog 에서 두 번째 연결의 `0RTT` 패킷을 찾는다.
- **연결 이전**: 큰 파일을 HTTP/3 으로 받는 중 와이파이를 끄고 LTE 로 바꿔 끊기지 않는지 본다. 같은 실험을 HTTP/2 로 하면 끊긴다.
- **손실 내성**: netem 손실 2% 에서 HTTP/2 와 HTTP/3 의 50개 파일 다운로드 시간을 비교한다(실험 `netp-h1-vs-h2` 의 확장).

> 이어서 읽기: [관측과 디버깅 — qlog 로 QUIC 보기](/network-protocols/notes/07-observing-debugging) · [TLS 1.3 핸드셰이크](/network-protocols/notes/03-tls13-handshake) · [L4/L7 로드밸런싱 — QUIC 과 LB](/network-protocols/notes/06-load-balancing-cdn)

## 실습 체크리스트

- [ ] 브라우저 개발자 도구에서 `h3` 로 받은 리소스를 찾고, 첫 접속과 재접속의 연결 시간을 비교
- [ ] `chrome://net-export` 나 qlog 로 QUIC 연결 하나의 이벤트 흐름 보기
- [ ] 0-RTT 에 POST 를 허용하면 안 되는 이유를 재전송 공격으로 설명
- [ ] 와이파이 → 휴대폰 핫스팟 전환 중 HTTP/3 다운로드가 이어지는지 확인
- [ ] 회사 네트워크에서 UDP 443 이 막혔을 때 브라우저가 어떻게 폴백하는지 관찰
