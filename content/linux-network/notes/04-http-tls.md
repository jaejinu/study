---
title: HTTP 와 TLS 의 실제 동작
order: 4
level: 중급
summary: HTTP/1.1 keep-alive 와 헤더, HTTP/2·3 의 차이, TLS 핸드셰이크와 인증서 체인, SNI, curl/openssl 로 관찰하기
tags: [HTTP, HTTP/2, HTTP/3, TLS, 인증서, SNI, keep-alive]
experiments: [net-dns-http]
---

## HTTP/1.1 — 텍스트 위의 요청/응답

```
GET /api/metrics HTTP/1.1
Host: localhost:3000
User-Agent: curl/8.7
Accept: */*

HTTP/1.1 200 OK
Content-Type: text/plain; version=0.0.4
Content-Length: 812
Connection: keep-alive
```

- **keep-alive**: 연결을 재사용해 핸드셰이크를 아낀다 (기본). 응답 길이를 알아야 다음 요청과 구분 → `Content-Length` 또는 `Transfer-Encoding: chunked`.
- **head-of-line blocking**: 한 연결에서 응답은 순서대로. 브라우저는 호스트당 6연결로 우회했다.
- 상태 코드: 2xx 성공, 3xx 리다이렉트(301 영구/302/307 메서드 유지/304 캐시 유효), 4xx 클라이언트(400/401 인증/403 권한/404/409 충돌/429 과다), 5xx 서버(500/502 게이트웨이/503 과부하/504 타임아웃).
- 캐시 헤더: `Cache-Control: max-age, no-cache(재검증), no-store, private`, `ETag`/`If-None-Match`, `Last-Modified`.

```bash
curl -v http://localhost:3000/api/metrics          # 요청(>)/응답(<) 헤더
curl -I https://example.com                        # HEAD
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' URL
curl --http1.1 / --http2 / --http3
nc localhost 3000                                  # 손으로 치기: GET / HTTP/1.1 ↵ Host: x ↵ ↵
```

## HTTP/2

- 하나의 TCP 연결 위에 **다중화된 스트림**(요청 여러 개 동시). 헤더 압축(HPACK), 바이너리 프레임, 서버 푸시(사실상 폐기).
- 응용 계층 HOL 은 풀었지만 TCP 패킷 하나 손실이 모든 스트림을 막는 **전송 계층 HOL** 은 남는다.
- 브라우저는 TLS 위에서만 h2 (ALPN 으로 협상).

## HTTP/3 (QUIC)

- **UDP** 위에 QUIC 이 신뢰성·암호화·스트림을 구현. 스트림마다 독립적 손실 복구 → HOL 해결.
- 0-RTT 재연결, 연결 마이그레이션(Wi-Fi ↔ LTE 전환 시 유지).
- 서버·CDN 지원은 넓어졌고, 프록시(Nginx 1.25+ `listen 443 quic`)도 지원.

## TLS 핸드셰이크 (1.3)

```
ClientHello (지원 버전·cipher, SNI=호스트명, ALPN=h2/http1.1, key share)
ServerHello + 인증서 + Finished  (1-RTT 에 키 합의 완료)
Finished → 암호화된 HTTP
```

- **SNI**: 한 IP 에서 여러 도메인의 인증서를 고를 수 있게 호스트명을 평문으로 보낸다 (ECH 가 이를 가린다).
- **인증서 체인**: 서버 인증서 ← 중간 CA ← 루트 CA(OS/브라우저 신뢰 저장소). 서버는 중간 인증서까지 보내야 한다 — 빠뜨리면 일부 클라이언트만 실패하는 흔한 사고.
- 검증: 도메인 일치(SAN), 유효 기간, 체인 서명, 폐기(OCSP/CRL).
- TLS 1.2 는 2-RTT, 1.3 은 1-RTT + 0-RTT 재개. 1.0/1.1 은 끄기.

```bash
openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
openssl s_client -connect example.com:443 -servername example.com -alpn h2 </dev/null 2>&1 | grep -E "Protocol|Cipher|ALPN"
curl -vI https://example.com 2>&1 | grep -E "SSL connection|subject|issuer|expire"
```

## 로컬 개발의 TLS

- `mkcert` 로 로컬 CA 를 만들어 브라우저가 신뢰하는 `localhost` 인증서 발급.
- 자체 서명 인증서는 `curl -k`, Node `NODE_TLS_REJECT_UNAUTHORIZED=0` 는 **개발에서만**.
- 내부 서비스 간엔 서비스 메시(mTLS) 또는 사설 CA.

## HTTP/1.1, 2, 3 를 한 표로

| | HTTP/1.1 | HTTP/2 | HTTP/3 |
|---|---|---|---|
| 전송 | TCP | TCP | QUIC(UDP) |
| 형식 | 텍스트 | 바이너리 프레임 | 바이너리 프레임 |
| 동시 요청 | 연결당 1개(파이프라이닝은 사실상 미사용) | 연결 하나에 스트림 다중화 | 스트림 다중화 |
| HOL 블로킹 | 응용·전송 둘 다 | 전송 계층만(패킷 손실 시 모든 스트림 대기) | 없음(스트림별 손실 복구) |
| 헤더 압축 | 없음 | HPACK | QPACK |
| 연결 수립 | TCP 1 + TLS 1~2 RTT | 같음 | 1 RTT(재개 시 0) |
| 연결 이동 | 불가(IP 바뀌면 끊김) | 불가 | 연결 ID 로 유지 |
| 관측 | tcpdump 로 평문 가능 | TLS 라 키 필요 | UDP+암호화, 중간 장비가 거의 못 봄 |

손실이 없는 데이터센터 내부에서는 HTTP/2 로 충분하다. 손실·지연이 큰 모바일 망에서 HTTP/3 의 이득이 크다. 서비스 간 RPC 는 HTTP/2 위의 gRPC 가 표준이다 — [Protobuf 와 gRPC](/api-design/notes/03-protobuf-grpc).

### HTTP/2 의 함정 — 연결이 하나라서 생기는 일

- **L4 로드밸런서와 쏠림**: 클라이언트가 연결 하나로 모든 요청을 보내므로, 연결 단위로 분산하는 L4 LB 뒤에서는 한 백엔드에 몰린다. L7(요청 단위) 분산이나 클라이언트 측 분산이 필요하다.
- **흐름 제어 창**: 스트림·연결마다 수신 창이 있어 기본값(64KB)이 작으면 고지연 링크에서 처리량이 막힌다.
- **동시 스트림 상한**: `SETTINGS_MAX_CONCURRENT_STREAMS`(흔히 100) 을 넘는 요청은 대기한다.

## TLS 1.3 핸드셰이크를 시간으로 보기

```
t=0      ClientHello (key_share 포함)                       →
t=1 RTT  ← ServerHello, {EncryptedExtensions, Certificate, CertificateVerify, Finished}
t=1 RTT  {Finished}, {HTTP 요청}                            →   ← 요청이 1 RTT 만에 나감
t=2 RTT  ← {HTTP 응답}
```

| 비용 | 크기 | 줄이는 법 |
|---|---|---|
| RTT | 1(1.3) / 2(1.2) | TLS 1.3, 세션 재개(PSK), 0-RTT(재전송 공격 주의 — 멱등 요청만) |
| 인증서 체인 전송 | 수 KB(RSA 4096 체인이면 더 큼) | ECDSA 인증서, 불필요한 중간 인증서 빼기 |
| 서명 연산(CPU) | RSA 2048 서명은 ECDSA P-256 의 수 배 | ECDSA |
| OCSP 확인 | 클라이언트가 별도 질의하면 + RTT | OCSP stapling |

`curl -w` 의 `time_appconnect − time_connect` 가 TLS 비용이다. 같은 서버에 keepalive 로 두 번째 요청을 보내면 이 값이 0 이 된다 — 연결 재사용이 왜 중요한지 숫자로 보인다. 인증서·PKI 의 깊은 내용과 직접 CA 만들기는 [TLS 와 인증서](/security/notes/02-tls-certificates), 이 프로젝트의 Nginx TLS 종단은 실험 `sec-nginx-tls`.

## 캐시 헤더의 의미를 정확히

| 헤더 | 브라우저/CDN 동작 |
|---|---|
| `Cache-Control: max-age=3600` | 1시간은 서버에 묻지 않고 재사용 |
| `no-cache` | 저장은 하되 **매번 재검증**(If-None-Match) |
| `no-store` | 저장 자체 금지(민감 데이터) |
| `private` | 브라우저만, CDN 은 저장 금지(사용자별 응답) |
| `s-maxage` | CDN(공유 캐시)용 max-age |
| `stale-while-revalidate=60` | 만료 후 60초는 옛 응답을 주며 백그라운드 갱신 |
| `ETag` + `If-None-Match` | 바뀌지 않았으면 304(본문 없음) |

`no-cache` 를 "캐시 안 함" 으로 오해하는 경우가 많다. 캐시 계층 설계 전체는 [캐시 계층과 CDN](/architecture/notes/10-cache-layers-cdn).

## 예시로 보기 — 이 프로젝트의 HTTP 들

```bash
curl -sI http://localhost:3000/ | head -5                 # Next.js 개발 서버(HTTP/1.1, keep-alive)
curl -sI http://localhost:18080/health                    # Nginx 리버스 프록시
curl -sI --cacert nginx/tls/certs/ca.crt https://localhost:18444/health   # Nginx TLS 종단(HSTS 헤더 확인)
curl -sN -X POST localhost:3000/api/ask -H 'Content-Type: application/json' -d '{...}'   # SSE 스트리밍(text/event-stream)
```

마지막 줄의 SSE(Server-Sent Events)는 HTTP 응답을 끊지 않고 `data: ...\n\n` 을 계속 흘려 보내는 방식이다. "AI 에게 묻기" 패널이 토큰을 하나씩 보여 주는 원리이고, 중간 프록시가 응답을 버퍼링하면(`proxy_buffering on`) 스트리밍이 끝날 때 한꺼번에 도착하는 고장이 난다 — [캐시·TLS·레이트리밋](/nginx/notes/03-cache-tls-ratelimit).

## 운영·관측 포인트

- 프록시 로그에 `$ssl_protocol`, `$ssl_cipher`, `$request_time`, `$upstream_response_time` 을 남기면 TLS 버전 분포와 "프록시 vs 업스트림" 지연을 분리할 수 있다(이 프로젝트 `nginx-tls.conf` 의 `log_format tls`).
- 인증서 만료는 반드시 알림으로 — 만료 30일·7일 전. 실험 `sec-tls-inspect` 가 남은 일수를 계산한다.

## 실습 체크리스트

- [ ] `curl -v` 로 요청/응답 헤더 읽기, `Connection: keep-alive` 와 `Content-Length` 확인 (실험실)
- [ ] `curl --http2 -I https://example.com` 로 `HTTP/2 200` 확인, `--http1.1` 과 시간 비교
- [ ] `openssl s_client` 로 인증서 체인·만료일·ALPN 보기
- [ ] `nc localhost 3000` 에 손으로 HTTP 요청을 쳐서 응답 받기
- [ ] 같은 URL 에 keepalive 로 두 번 요청(`curl URL URL -w ...`)해 두 번째의 connect·TLS 시간이 0 인 것 확인
- [ ] `Cache-Control: no-cache` 응답을 두 번 요청해 304 재검증이 일어나는지 `curl -v` 로 확인
