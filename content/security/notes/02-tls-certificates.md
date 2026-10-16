---
title: TLS 와 인증서 — 핸드셰이크, PKI, mTLS, 자동 갱신
order: 2
level: 기초
summary: "TLS 가 보장하는 세 가지(기밀성·무결성·인증), TLS 1.3 핸드셰이크의 실제 순서와 왜 1-RTT 인지, 공개키·서명·인증서 체인·SAN·신뢰 저장소로 이뤄진 PKI, openssl 로 체인을 만들고 검증하고 실제 사이트를 읽는 법, mTLS 와 서비스 메시, Let's Encrypt/cert-manager 자동 갱신, 인증서 만료 모니터링과 흔한 사고"
tags: [TLS, 인증서, PKI, 핸드셰이크, SAN, mTLS, Let's Encrypt, cert-manager, openssl]
experiments: [sec-tls-inspect, sec-nginx-tls]
---

## TLS 가 주는 세 가지

| 보장 | 방법 | 없으면 |
|---|---|---|
| **기밀성** | 세션 키로 대칭 암호화(AES-GCM, ChaCha20) | 와이파이에서 패킷 캡처로 내용 노출 |
| **무결성** | AEAD 태그(GCM 의 인증 태그) | 중간자가 응답 변조(스크립트 삽입) |
| **인증** | 서버 인증서 + CA 서명 검증 | 중간자가 서버인 척(MITM) — 암호화돼 있어도 **공격자와** 암호화 |

세 번째가 핵심이다. 암호화만 하면 "누군가와 안전하게 통신" 할 뿐 "누구와" 를 모른다. 공격자가 DNS 를 바꾸거나 ARP 를 속여 자기 서버로 끌어오면, 암호화는 공격자와 이루어진다. 인증서가 "이 공개키는 github.com 의 것" 을 **신뢰하는 제3자(CA)** 가 보증하기 때문에 MITM 이 막힌다.

## 암호학 최소 지식 — 세 가지 도구

| 도구 | 하는 일 | 예 | TLS 에서의 역할 |
|---|---|---|---|
| **대칭 암호** | 같은 키로 암·복호화, 빠름 | AES-256-GCM, ChaCha20-Poly1305 | 핸드셰이크 뒤 **모든 데이터** |
| **비대칭(공개키)** | 공개키로 잠그면 개인키로만 염, 느림 | RSA, ECDSA(P-256), Ed25519 | **서명**(인증서, 핸드셰이크 증명) |
| **키 교환** | 둘이 공개 채널로 비밀 키를 합의 | (EC)DHE — X25519 | **세션 키** 생성, **전방 비밀성** |
| **해시 / HMAC / AEAD** | 지문, 무결성 | SHA-256, HMAC, GCM 태그 | 인증서 지문, 전사 해시, 데이터 무결성 |

**전방 비밀성**(forward secrecy): 세션 키를 매번 임시 DH 로 만들면, 나중에 서버 개인키가 털려도 **과거 트래픽은 복호화 못 한다**. TLS 1.3 은 이를 강제한다(RSA 키 교환 삭제).

## TLS 1.3 핸드셰이크 — 왜 1-RTT 인가

![TLS 1.3 핸드셰이크와 PKI 체인](/diagrams/sec-tls-handshake.svg)

```
클라이언트                                      서버
  │ ClientHello ──────────────────────────────▶ │  지원 버전·암호 스위트·SNI(host)·
  │   + key_share (X25519 공개값)               │  **키 교환 공개값을 미리 보냄**
  │                                             │
  │ ◀──────────────────────── ServerHello       │  선택한 스위트 + key_share
  │     {EncryptedExtensions}                   │  ← 여기부터 암호화됨 (핸드셰이크 키)
  │     {Certificate}                           │  서버 인증서 체인
  │     {CertificateVerify}                     │  개인키로 전사(transcript) 서명 → "나는 이 인증서의 주인"
  │     {Finished}                              │  전사 HMAC
  │                                             │
  │ 인증서 검증: 서명 체인 → 신뢰 루트, SAN == host, 유효 기간, (OCSP/CRL)
  │ {Finished} ───────────────────────────────▶ │
  │ [애플리케이션 데이터] ◀────────────────────▶ │  1-RTT 후 HTTP 시작
```

- TLS 1.2 는 ServerHello 뒤에 클라이언트가 키 교환을 보내므로 **2-RTT**. 1.3 은 ClientHello 에 `key_share` 를 실어 **1-RTT**. 재접속 땐 PSK 로 **0-RTT**(재전송 공격 위험이 있어 멱등 요청만).
- **SNI**(Server Name Indication): ClientHello 에 평문으로 호스트 이름 → 한 IP 에서 여러 인증서. 평문이라 어디에 접속하는지는 보인다(ECH 가 이를 암호화).
- **CertificateVerify** 가 "인증" 의 핵심: 인증서(공개키)를 가진 것만으로는 부족하고, **그 개인키로 이번 핸드셰이크를 서명**해야 한다. 인증서는 공개 정보라 누구나 복사할 수 있기 때문.
- 암호 스위트 예 `TLS_AES_256_GCM_SHA384`: AEAD 알고리즘 + 해시. 1.3 에선 키 교환·서명이 스위트에서 분리됐다.

## PKI — 신뢰는 어떻게 전파되나

**인증서** = (공개키 + 소유자 정보 + 유효 기간 + 확장) 에 **CA 의 서명**. X.509 형식.

```
[루트 CA]  ── 서명 ──▶ [중간 CA]  ── 서명 ──▶ [리프: github.com]
자기 서명, 오프라인 보관          온라인 발급                  서버가 내미는 것
브라우저/OS 신뢰 저장소에 내장     서버가 체인에 포함해 보냄
```

클라이언트의 검증:
1. **체인**: 리프의 서명을 중간 CA 공개키로, 중간의 서명을 루트 공개키로 검증. 루트는 **신뢰 저장소**(OS/브라우저에 내장된 ~150개)에 있어야 한다.
2. **이름**: 접속한 호스트가 **SAN**(Subject Alternative Name)에 있는가. CN 은 더 이상 안 본다. 와일드카드 `*.study.local` 은 한 단계만.
3. **기간**: `notBefore ≤ now ≤ notAfter`. 2020 년부터 공개 인증서는 **최대 398일**, 2029 년까지 47일로 줄어드는 로드맵 — 자동 갱신이 필수인 이유.
4. **폐기**: CRL(목록) 또는 OCSP(온라인 조회). 느려서 브라우저는 OCSP 스테이플링·CRLite 등으로 보완.
5. **용도**: `keyUsage`, `extendedKeyUsage=serverAuth`. CA 인증서는 `basicConstraints=CA:TRUE`.

실험 `sec-tls-inspect` 는 미니 PKI 를 만들어 1·2·3 을 각각 실패시켜 본다:

```bash
# 루트 CA (자기 서명)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
  -subj "/CN=Study Root CA" -keyout ca.key -out ca.crt
# 서버 키 + CSR (SAN 포함)
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=study.local" \
  -addext "subjectAltName=DNS:study.local,DNS:*.study.local" -keyout srv.key -out srv.csr
# CA 가 서명 → 리프 인증서
openssl x509 -req -in srv.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 90 -copy_extensions copy -out srv.crt

openssl verify -CAfile ca.crt srv.crt                                  # OK
openssl verify srv.crt                                                 # unable to get local issuer certificate
openssl verify -CAfile ca.crt -verify_hostname api.other.com srv.crt   # hostname mismatch
openssl x509 -in srv.crt -noout -text | less                           # 전부 읽어 보기
```

> 왜 `-copy_extensions copy` 인가: CSR 의 SAN 확장을 서명된 인증서에 복사하려면 필요하다(openssl 3). 빠뜨리면 SAN 없는 인증서가 나와 브라우저가 거부한다 — 흔한 실수.

### 공개 CA vs 사설 CA

| | 공개 CA (Let's Encrypt, DigiCert) | 사설 CA (회사 내부, cert-manager 의 CA issuer, Vault PKI) |
|---|---|---|
| 신뢰 | 모든 브라우저/OS 에 내장 | 우리 장비·컨테이너에 루트를 배포해야 |
| 용도 | 인터넷에 노출된 서비스 | 내부 서비스 간, mTLS, 개발 환경 |
| 검증 | 도메인 소유 증명(ACME HTTP-01/DNS-01) | 우리 마음대로(하지만 그래서 더 위험 — 루트 키 보관!) |
| 비용/기간 | 무료, 90일 | 자유 |

사설 루트를 개발자 노트북에 설치하면, 그 루트 키를 가진 사람은 **모든 사이트를 위장**할 수 있다. 사설 CA 의 루트 키는 HSM/오프라인에, 중간 CA 만 온라인에.

## 실제 사이트 읽기

```bash
openssl s_client -connect github.com:443 -servername github.com -showcerts </dev/null
#   Certificate chain: 0 s:CN=github.com  i:... (리프) / 1 s:... (중간)
#   Protocol: TLSv1.3, Cipher: TLS_AES_128_GCM_SHA256
#   Verify return code: 0 (ok)
openssl s_client -connect github.com:443 -servername github.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
curl -vI https://github.com 2>&1 | grep -E "SSL connection|issuer|expire"
```

`-servername` 이 없으면 SNI 를 안 보내 기본 인증서(또는 에러)가 온다. Nginx 로컬 실습은 [Nginx 노트 03](/nginx/notes/03-cache-tls-ratelimit) 의 TLS 설정으로.

## mTLS — 클라이언트도 인증서를 낸다

보통 TLS 는 **서버만** 인증한다. mTLS(mutual TLS)는 클라이언트도 인증서를 내고 서버가 검증한다 → 네트워크 수준에서 **서비스 신원**이 생긴다.

```nginx
# Nginx 에서 클라이언트 인증서 요구
ssl_client_certificate /etc/nginx/ca.crt;   # 클라이언트 인증서를 서명한 CA
ssl_verify_client on;
# $ssl_client_s_dn 으로 누구인지 앱에 전달
proxy_set_header X-Client-DN $ssl_client_s_dn;
```

- **서비스 메시**(Istio, Linkerd)의 핵심 기능: 사이드카가 자동으로 mTLS 를 맺고 SPIFFE ID(`spiffe://cluster/ns/study/sa/web`)로 서비스를 식별, 인증서를 24시간마다 자동 회전. 앱 코드는 평문 HTTP 를 쓴다 — [Kubernetes 노트 12](/kubernetes/notes/12-network-policy-mesh).
- 데이터베이스도 가능: PostgreSQL `hostssl ... cert` 인증, Kafka `ssl.client.auth=required`, Redis `tls-auth-clients yes` — [07 노트](/security/notes/07-datastore-hardening).
- 토큰(JWT)과의 차이: mTLS 는 **연결**을 인증, 토큰은 **요청/사용자**를 인증. 둘을 같이 쓴다(서비스 신원 = mTLS, 최종 사용자 = 토큰 전달).

## 자동 갱신 — 수동 갱신은 반드시 잊는다

| 방법 | 어디서 | 동작 |
|---|---|---|
| **certbot** | VM/Nginx | ACME HTTP-01: `/.well-known/acme-challenge/` 에 토큰 놓기 → LE 가 확인 → 발급. cron 으로 갱신 |
| **Caddy / Traefik** | 내장 | 설정 한 줄로 자동 |
| **cert-manager** | Kubernetes | `Certificate` CRD → `Issuer`(ACME/CA/Vault) 가 Secret 에 키·인증서 저장, 만료 전 자동 갱신, Ingress 어노테이션 한 줄 |
| **DNS-01** | 와일드카드·내부 서비스 | DNS TXT 레코드로 소유 증명 — 80 포트가 없어도 됨 |

```yaml
# cert-manager
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: web-tls, namespace: study }
spec:
  secretName: web-tls
  dnsNames: [study.example.com]
  issuerRef: { name: letsencrypt-prod, kind: ClusterIssuer }
  duration: 2160h      # 90d
  renewBefore: 360h    # 15d 전 갱신
```

## 모니터링 — 만료는 예고된 장애

인증서 만료는 매년 대형 서비스를 멈추게 한다(Microsoft Teams 2020, Spotify 2020, Cisco·Ericsson 장비). 전부 "누군가 갱신을 잊어서".

```yaml
# blackbox_exporter 로 TLS 프로브 → Prometheus
- alert: CertExpiringSoon
  expr: (probe_ssl_earliest_cert_expiry - time()) / 86400 < 14
  for: 1h
  labels: { severity: warning }
  annotations: { summary: "{{ $labels.instance }} 인증서 {{ $value | humanize }}일 후 만료" }
```

이 프로젝트의 [알림 파이프라인](/observability/notes/09-alerting-pipeline) 에 이 규칙을 넣고, blackbox 로 `https://github.com` 을 프로브하면 바로 동작을 볼 수 있다. 내부 사설 CA 인증서도 같은 방식으로 — 사설이라 더 잘 잊는다.

## 흔한 실수와 사고

| 실수 | 결과 | 대처 |
|---|---|---|
| `NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k`, `verify=False` 를 코드에 박음 | MITM 무방비. "개발용" 이 운영까지 | 사설 CA 를 신뢰 저장소에 추가(`NODE_EXTRA_CA_CERTS`), 절대 검증 끄지 않기 |
| SAN 없이 CN 만 | 최신 브라우저·Go·Node 가 거부 | 항상 SAN |
| 개인키를 git/이미지/로그에 | 인증서 자체가 무의미 | Secret·Vault, 권한 0600, 유출 시 즉시 폐기·재발급 |
| 중간 CA 를 체인에서 빠뜨림 | 브라우저는 AIA 로 받아 되지만 curl/Node 는 실패 | `fullchain.pem` 사용 |
| 오래된 TLS 1.0/1.1, RSA 키 교환, CBC 스위트 허용 | BEAST/POODLE/ROBOT 류 | `ssl_protocols TLSv1.2 TLSv1.3`, Mozilla SSL config 생성기 |
| HSTS 없음 | 첫 접속 http → SSL strip | `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` |
| 내부는 평문 | 사이드카·내부자·클라우드 네트워크 스니핑 | mTLS 또는 메시 |

## 예시로 보기 — 이 프로젝트에서

- `pnpm nginx:up` 의 Nginx 는 18080 평문이다. `pnpm nginx:tls` 는 `nginx/tls/gen-certs.sh` 로 사설 CA + `localhost` 인증서(SAN: localhost, study.local, 127.0.0.1)를 만들고 `nginx/nginx-tls.conf`(TLS 1.2+, HSTS, 80→443 리다이렉트, 보안 헤더)로 **https://localhost:18444** 를 띄운다. 실험 `sec-nginx-tls` 가 `curl` 없이/`--cacert`/`-k` 의 차이, TLS 1.3 협상, TLS 1.1 거부, SAN 불일치 거부를 한 번에 보여 준다. 브라우저에서 경고 없이 보려면 `nginx/tls/certs/ca.crt` 를 키체인에 신뢰로 추가하면 된다 — 그게 바로 '신뢰 저장소에 CA 를 넣는' 일이다. 직접 겪은 함정 하나: Nginx 는 `location` 안에 `add_header` 가 하나라도 있으면 `server` 의 `add_header`(HSTS 등)를 **상속하지 않는다**. `/health` 에 `add_header Content-Type` 을 썼다가 HSTS 가 빠진 채 응답했다 — 보안 헤더는 반드시 응답으로 확인하라(`curl -I`).
- Redis 는 `tls-port 6380 --tls-cert-file ... --tls-ca-cert-file ...` 로 TLS 를 켤 수 있다. ioredis 는 `tls: { ca }` 옵션. 벤치마크로 평문 대비 지연 차이를 재 보자(핸드셰이크 비용은 연결당 한 번, 데이터 암호화는 AES-NI 로 수 % 수준).
- 앱 → Anthropic API 는 당연히 HTTPS. `NODE_EXTRA_CA_CERTS` 를 잘못 잡으면 Node 가 모든 외부 호출을 거부하는 식의 장애가 난다 — 로그에 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 가 보이면 여기.

> 함께 읽기: [보안 사고방식과 위협 모델링](/security/notes/01-security-mindset-threat-modeling)

## 실습 체크리스트

- [ ] 실험 `sec-tls-inspect` 를 돌리고 세 가지 실패(CA 없음·이름 불일치·만료)를 각각 설명해 보기
- [ ] `openssl s_client -connect <내가 쓰는 사이트>:443` 로 체인 길이·프로토콜·암호 스위트 읽기
- [ ] `openssl x509 -text` 출력에서 SAN, keyUsage, basicConstraints, AIA, CRL 위치 찾기
- [ ] `pnpm nginx:tls` 로 TLS 를 켜고 실험 `sec-nginx-tls` 를 돌린 뒤, `curl --cacert` 와 `curl -k` 의 차이를 말로 설명하기
- [ ] blackbox_exporter + `CertExpiringSoon` 규칙을 관측 스택에 추가해 Grafana 에서 남은 일수 보기
