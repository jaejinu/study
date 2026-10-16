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

## 실습 체크리스트

- [ ] `curl -v` 로 요청/응답 헤더 읽기, `Connection: keep-alive` 와 `Content-Length` 확인 (실험실)
- [ ] `curl --http2 -I https://example.com` 로 `HTTP/2 200` 확인, `--http1.1` 과 시간 비교
- [ ] `openssl s_client` 로 인증서 체인·만료일·ALPN 보기
- [ ] `nc localhost 3000` 에 손으로 HTTP 요청을 쳐서 응답 받기
