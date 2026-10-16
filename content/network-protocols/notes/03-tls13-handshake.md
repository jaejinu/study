---
title: "TLS 1.3 핸드셰이크와 지연 — 몇 RTT 를 쓰고, 어떻게 줄이나"
order: 3
level: 중급
summary: "TLS 1.2 의 2-RTT 핸드셰이크가 1.3 에서 1-RTT 가 된 이유(키 공유를 첫 메시지에), 핸드셰이크 메시지별 역할과 암호화 시작 지점, 세션 재개(PSK·세션 티켓)와 0-RTT 조기 데이터의 재전송 위험·완화, 인증서 체인 크기와 OCSP 스테이플링이 첫 바이트에 주는 영향, ECDSA vs RSA 비용, TCP + TLS 연결 수립 총비용을 측정하는 법(curl -w 의 time_connect·time_appconnect), 연결 재사용이 가장 큰 최적화인 이유"
tags: [TLS 1.3, 핸드셰이크, 세션 재개, 0-RTT, PSK, 세션 티켓, OCSP 스테이플링, ECDSA, 연결 재사용]
experiments: []
---

## 지연의 산수 — 첫 바이트까지 몇 번 왕복하나

새 HTTPS 연결에서 첫 응답 바이트까지:

| 단계 | TLS 1.2 | TLS 1.3 | TLS 1.3 재개(0-RTT) | QUIC(HTTP/3) |
|---|---|---|---|---|
| DNS | 1 RTT(캐시 없으면) | 1 | 1 | 1 |
| TCP 핸드셰이크 | 1 RTT | 1 | 1 | — |
| TLS 핸드셰이크 | **2 RTT** | **1 RTT** | 0 | 1 (전송과 합쳐짐) |
| HTTP 요청·응답 | 1 RTT | 1 | 1(요청은 0-RTT 에 실림) | 1 |
| **합계(DNS 제외)** | 4 RTT | 3 RTT | 2 RTT | 2 RTT |

RTT 100ms 모바일이면 TLS 1.2 → 1.3 만으로 100ms, QUIC 으로 200ms 를 아낀다. 서버가 아무리 빨라도 이 비용은 물리다([성능 01](/performance/notes/01-language-of-performance)의 지연 예산).

## TLS 1.2 는 왜 2 RTT 였나

```
C → S  ClientHello (지원 암호 스위트 목록)
S → C  ServerHello (스위트 선택) + Certificate + ServerKeyExchange + ServerHelloDone     ← 1 RTT
C → S  ClientKeyExchange + ChangeCipherSpec + Finished
S → C  ChangeCipherSpec + Finished                                                      ← 2 RTT
C → S  HTTP 요청 (이제야 암호화)
```

클라이언트는 서버가 **어떤 키 교환 방식을 고를지 모르니** 첫 메시지에 키를 보낼 수 없었다.

## TLS 1.3 — 키를 미리 보낸다

```
C → S  ClientHello + key_share(X25519 공개값을 미리 계산해 첨부) + 지원 그룹
S → C  ServerHello + key_share         ← 여기서 양쪽이 공유 비밀을 계산, 이후 전부 암호화
       {EncryptedExtensions}{Certificate}{CertificateVerify}{Finished}           ← 1 RTT
C → S  {Finished} + {HTTP 요청}
```

| 바뀐 점 | 효과 |
|---|---|
| 키 교환을 ClientHello 에 | 1 RTT 단축 |
| 정적 RSA 키 교환 제거 | 모든 연결이 **순방향 비밀성**(서버 키가 나중에 유출돼도 과거 트래픽 안전) |
| ServerHello 이후 전부 암호화 | **인증서도 암호화** — 엿보는 사람이 어느 사이트인지 인증서로 알 수 없음(SNI 는 여전히 평문, ECH 가 이를 암호화) |
| 암호 스위트 5개로 축소 | AES-GCM·ChaCha20-Poly1305 만, 약한 것 협상 불가 |
| 재협상·압축 제거 | 공격 표면 축소(CRIME 등) |

클라이언트가 추측한 그룹을 서버가 지원하지 않으면 HelloRetryRequest 로 1 RTT 가 더 든다. 그래서 클라이언트들은 X25519 를 기본으로 보낸다.

## 세션 재개와 0-RTT

첫 핸드셰이크 끝에 서버는 **세션 티켓**(재개용 키를 서버 비밀로 암호화한 것)을 준다. 다음 연결에서 클라이언트가 티켓을 내밀면 인증서 검증·전체 키 교환 없이 재개한다(PSK 모드, 여전히 1 RTT 지만 계산이 가볍다).

**0-RTT(조기 데이터)**: 티켓으로 만든 키로 **첫 메시지에 요청을 실어** 보낸다.

```
C → S  ClientHello + pre_shared_key + early_data + {GET /}   ← 요청이 0 RTT 에 도착
```

| 위험 | 이유 | 완화 |
|---|---|---|
| **재전송(replay)** | 0-RTT 데이터는 서버의 새 난수와 무관해서, 공격자가 복사해 다시 보내도 유효 | 멱등 요청만 허용, 서버의 단기 재전송 캐시, `Early-Data: 1` 헤더로 앱이 판단 |
| 순방향 비밀성 약화 | 0-RTT 데이터는 티켓 키로만 보호 | 티켓 키 자주 회전 |

```nginx
ssl_early_data on;                                    # 0-RTT 허용
proxy_set_header Early-Data $ssl_early_data;          # 업스트림 앱에 알림 → 비멱등이면 425 Too Early
```

결제 API 에 0-RTT 를 켜면 같은 결제가 두 번 처리될 수 있다. 멱등 키([API 설계 01](/api-design/notes/01-rest-principles))가 있어도 0-RTT 는 GET 류에만 쓰는 것이 원칙이다.

## 핸드셰이크 비용 — 바이트와 CPU

| 요인 | 영향 | 개선 |
|---|---|---|
| 인증서 체인 크기 | 체인이 크면 초기 혼잡 윈도(≈14KB)를 넘어 **RTT 가 하나 더** | 중간 인증서만 보내기(루트 제외), ECDSA 인증서(작다) |
| RSA 2048 서명 | 서버 CPU 비용 큼 | ECDSA P-256 이 수 배 빠름 |
| OCSP 확인 | 클라이언트가 CA 에 따로 물으면 추가 왕복 | **OCSP 스테이플링** — 서버가 응답을 붙여 줌 |
| 인증서 검증 | 클라이언트 CPU | 짧은 체인 |

초기 혼잡 윈도 이야기는 [혼잡 제어](/network-protocols/notes/04-congestion-control)의 슬로 스타트와 같은 원리다: 첫 RTT 에 보낼 수 있는 바이트는 약 14KB 다.

## 측정 — curl 이 쪼개 보여 준다

```bash
curl -so /dev/null -w 'dns %{time_namelookup}  tcp %{time_connect}  tls %{time_appconnect}  ttfb %{time_starttransfer}  total %{time_total}\n' https://github.com/
# dns 0.004  tcp 0.041  tls 0.083  ttfb 0.151  total 0.152
#            └ TCP 1 RTT ┘└ TLS 1 RTT ┘└ 요청·응답 ┘
curl --tlsv1.2 --tls-max 1.2 -so /dev/null -w 'tls1.2 %{time_appconnect}\n' https://github.com/   # 비교
openssl s_client -connect github.com:443 -tls1_3 -brief </dev/null    # 협상 결과·그룹·스위트
```

`time_appconnect - time_connect` 가 TLS 핸드셰이크 시간이다. RTT 와 비교하면 1.3 은 약 1 RTT, 1.2 는 약 2 RTT 로 나온다.

## 가장 큰 최적화 — 연결을 다시 쓴다

핸드셰이크를 빠르게 하는 것보다 **핸드셰이크를 안 하는 것**이 낫다.

- HTTP keep-alive·HTTP/2 의 연결 하나 재사용 — 수천 요청에 핸드셰이크 1번.
- 서버 간 호출에서 커넥션 풀(Node `http.Agent({ keepAlive: true })`, 이 사이트의 ioredis·pg 풀).
- 프록시 업스트림 keepalive(Nginx `keepalive 16`, [Nginx 02](/nginx/notes/02-reverse-proxy-lb)).
- 서비스 메시의 프록시 간 mTLS 연결 재사용([서비스 메시 03](/service-mesh/notes/03-mtls-identity)) — 앱이 연결을 매번 새로 열어도 프록시 사이 TLS 연결은 유지된다.

짧은 연결을 반복하면 핸드셰이크 CPU 와 TIME_WAIT·임시 포트 고갈([Linux 네트워크 02](/linux-network/notes/02-ip-ports-sockets))이 함께 온다.

## 예시로 보기 — 이 프로젝트에서

- `pnpm nginx:tls` 의 `nginx/nginx-tls.conf` 는 `ssl_protocols TLSv1.2 TLSv1.3;` 이다. 실험 `sec-nginx-tls`([보안 02](/security/notes/02-tls-certificates))에서 `openssl s_client -brief` 로 `TLSv1.3` 협상을 확인했다.
- `ssl_session_cache shared:SSL:10m;` 은 TLS 1.2 세션 ID 재개용, `ssl_session_tickets off;` 는 티켓 키 관리를 피하려는 선택이다. 여러 Nginx 인스턴스가 티켓을 쓰려면 **티켓 키를 공유·회전**해야 한다 — 안 그러면 다른 인스턴스로 간 재접속은 재개되지 않는다.
- 이 사이트의 `/api/ask` 가 OpenAI 를 부를 때 SDK 가 연결을 재사용하므로 질문마다 TLS 핸드셰이크를 하지 않는다.

## 인증서 체인 크기를 재는 법

```bash
openssl s_client -connect example.com:443 -servername example.com -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERT/,/END CERT/' | wc -c          # PEM 크기 (DER 은 약 3/4)
openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null \
  | grep -E 'Server public key|Peer signature type'  # 키 종류 — ECDSA 면 작다
```

RSA 2048 인증서 + 중간 인증서 2개는 쉽게 4~5KB 가 된다. 여기에 OCSP 응답·SCT(Certificate Transparency)가 붙으면 초기 혼잡 윈도 14KB 에 가까워진다.

## 핸드셰이크 관련 흔한 장애

| 증상 | 원인 | 확인 |
|---|---|---|
| 일부 클라이언트만 실패 | 중간 인증서를 안 보냄(브라우저는 캐시로 넘어가고 curl·앱은 실패) | `openssl s_client -showcerts` 에 체인이 다 있나 |
| 갑자기 전체 실패 | 인증서 만료 | 만료 30일 전 알림([관측성 09](/observability/notes/09-alerting-pipeline)) |
| 특정 도메인만 엉뚱한 인증서 | SNI 를 안 보내는 클라이언트 → 기본 인증서 | `-servername` 빼고 재현 |
| 핸드셰이크가 느림 | RSA 4096 서명 CPU, OCSP 동기 확인 | 서버 CPU 프로파일, OCSP 스테이플링 |
| 재접속도 매번 느림 | 세션 재개 실패(티켓 키 미공유, 캐시 없음) | `openssl s_client -reconnect` 의 `Reused` |
| 시계 어긋난 기기 | 인증서 "아직 유효하지 않음" | 클라이언트 NTP |

> 이어서 읽기: [L4/L7 로드밸런싱 — TLS 종단 위치](/network-protocols/notes/06-load-balancing-cdn) · [QUIC — 핸드셰이크가 전송과 합쳐진 모습](/network-protocols/notes/02-quic) · [서비스 메시 03 — 자동 mTLS](/service-mesh/notes/03-mtls-identity)

## 실습 체크리스트

- [ ] `curl -w` 로 TLS 1.2 와 1.3 의 `time_appconnect - time_connect` 를 비교
- [ ] `openssl s_client -sess_out`/`-sess_in` 으로 세션 재개가 되는지 확인
- [ ] 결제 API 에 0-RTT 를 허용하면 생기는 문제와 `425 Too Early` 의 역할 설명
- [ ] 우리 서비스 인증서 체인 크기를 재고 14KB 를 넘는지 확인
- [ ] keep-alive 를 끈 클라이언트로 1000 요청을 보내 핸드셰이크 비용을 체감
