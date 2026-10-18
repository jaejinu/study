---
title: "HTTP/1.1 → 2 → 3 — 머리 막힘을 한 층씩 내려가며 없앤 역사"
order: 1
level: 기초
summary: "HTTP/1.1 의 요청-응답 직렬화와 연결 6개 우회, 파이프라이닝이 실패한 이유, HTTP/2 의 이진 프레이밍·스트림 다중화·HPACK 헤더 압축·흐름 제어·우선순위, 그런데도 남은 TCP 머리 막힘, HTTP/3 이 QUIC 으로 그걸 전송 계층에서 없앤 방법, Alt-Svc 와 HTTPS 레코드로 버전을 협상하는 과정, 실험에서 잰 1KB×50: HTTP/1.1×1 2659ms · ×6 576ms · HTTP/2 304ms 와 20KB×50 에서의 역전·손실 시 흔들림"
tags: [HTTP/1.1, HTTP/2, HTTP/3, 머리 막힘, 다중화, HPACK, QPACK, Alt-Svc, h2c]
experiments: [netp-h1-vs-h2]
---

## HTTP/1.1 — 한 연결, 한 번에 하나

HTTP/1.1 은 텍스트 프로토콜이고 한 TCP 연결에서 **요청을 보내고 응답이 끝날 때까지** 다음 요청을 보내지 않는다.

```
연결 1: GET /a ──────▶ ◀────── 200 (a)  GET /b ──────▶ ◀────── 200 (b)  …
         └─ 1 RTT ─────────────┘          └─ 1 RTT ─────────────┘
```

리소스 50개면 50 RTT 다. 지연 50ms 링크에서 2.5초. 그래서 생긴 우회들:

| 우회 | 방법 | 대가 |
|---|---|---|
| **연결 여러 개** | 브라우저가 출처당 6개 연결 | 연결마다 TCP·TLS 핸드셰이크, 혼잡 윈도가 각자 처음부터 |
| 도메인 샤딩 | img1.example.com, img2… 로 연결 수를 더 늘림 | DNS 조회 증가, HTTP/2 에선 역효과 |
| 스프라이트·번들링 | 이미지·JS 를 하나로 합쳐 요청 수 줄이기 | 캐시 효율 저하(하나 바뀌면 전체 재다운로드) |
| 인라인 | 작은 CSS·이미지를 HTML 에 base64 로 | 캐시 불가, 크기 33% 증가 |
| **파이프라이닝** | 응답을 기다리지 않고 요청을 연달아 보냄 | 응답은 **순서대로** 와야 해서 앞 응답이 느리면 뒤가 다 막힘(HOL) + 중간 프록시 버그 → 사실상 사용 안 됨 |

여기서 **머리 막힘(Head-of-Line blocking)** 이라는 말이 처음 나온다: 줄 맨 앞의 느린 것 하나가 뒤를 전부 세운다.

## HTTP/2 — 한 연결에 여러 스트림

HTTP/2 는 의미(메서드·헤더·상태 코드)는 그대로 두고 **전송 형식**을 바꿨다.

```
TCP 연결 하나
 ├─ 스트림 1: HEADERS(GET /a) ─────────── DATA … DATA(END)
 ├─ 스트림 3: HEADERS(GET /b) ── DATA(END)
 ├─ 스트림 5: HEADERS(GET /c) ─────── DATA … 
 └─ 프레임이 섞여(interleave) 흐른다: [H1][H3][D3][D1][H5][D1][D5]…
```

| 기능 | 무엇 | 효과 |
|---|---|---|
| 이진 프레이밍 | 텍스트 대신 길이가 정해진 프레임(HEADERS, DATA, SETTINGS, WINDOW_UPDATE, RST_STREAM…) | 파싱이 빠르고 모호함 없음 |
| **스트림 다중화** | 요청마다 스트림 ID, 프레임을 섞어 보냄 | HTTP 수준 HOL 해소, 연결 1개로 충분 |
| **HPACK** | 헤더를 정적·동적 테이블 인덱스로 | 반복 헤더(쿠키·user-agent)를 수 바이트로 |
| 흐름 제어 | 스트림·연결별 수신 윈도(WINDOW_UPDATE) | 느린 수신자가 버퍼 폭주를 막음 |
| 우선순위 | 스트림 간 가중치·의존성 (RFC 9218 의 간단한 `priority` 헤더로 대체) | CSS 를 이미지보다 먼저 |
| 서버 푸시 | 요청 전에 리소스를 밀어 줌 | 효과가 적어 브라우저들이 제거함 |
| RST_STREAM | 스트림 하나만 취소 | 연결을 끊지 않고 요청 취소 |

HTTP/2 는 브라우저에서는 사실상 TLS(ALPN `h2`)와 함께만 쓴다. 평문 HTTP/2(**h2c**)는 서버 간·gRPC 내부 통신이나 이 실험처럼 "prior knowledge" 로 쓴다.

```nginx
server { listen 80; http2 on; }            # h2c — 클라이언트가 처음부터 HTTP/2 로 말해야 함
server { listen 443 ssl; http2 on; … }     # h2 — ALPN 으로 협상
```

```bash
curl --http2-prior-knowledge http://lab-netp-srv/          # h2c
curl --http2 https://example.com/ -w '%{http_version}\n'   # ALPN 으로 2 협상
```

### 그런데 HOL 이 아래층으로 내려갔을 뿐

HTTP/2 의 모든 스트림은 **TCP 바이트 스트림 하나**를 공유한다. TCP 는 순서를 보장해야 하므로, 패킷 하나가 손실되면 그 뒤에 도착한 패킷이 **다른 스트림의 데이터**여도 재전송이 올 때까지 앱에 넘기지 않는다.

```
보낸 순서:  [S1-a][S3-a][S5-a][S1-b][S3-b]
손실:            ✗ (S3-a)
수신 측 TCP:  [S1-a]  …재전송 대기…  [S5-a][S1-b][S3-b] 는 받았지만 앱에 못 줌
```

HTTP/1.1×6 에서는 손실이 6개 연결 중 하나만 세운다. HTTP/2×1 에서는 전부 선다. **손실이 많은 네트워크(모바일·와이파이)에서 HTTP/2 가 HTTP/1.1 보다 느려질 수 있는 이유**다.

## HTTP/3 — 전송 계층에서 HOL 을 없앴다

HTTP/3 은 HTTP/2 의 의미를 **QUIC** 위에 올렸다. QUIC 은 UDP 위에서 동작하는 전송 프로토콜로, **스트림마다 독립적으로 순서를 보장**한다([다음 노트](/network-protocols/notes/02-quic)).

| 항목 | HTTP/1.1 | HTTP/2 | HTTP/3 |
|---|---|---|---|
| 전송 | TCP | TCP | QUIC(UDP) |
| 암호화 | 선택(TLS) | 사실상 필수(TLS 1.2+) | 필수(TLS 1.3 내장) |
| 다중화 | 없음(연결 여러 개) | 스트림 | 스트림 |
| HOL | HTTP 수준 | **TCP 수준** | 없음(스트림 독립) |
| 헤더 압축 | 없음 | HPACK | QPACK(순서 없는 전송에 맞춤) |
| 연결 수립 | TCP 1 RTT + TLS 1~2 RTT | 같음 | 1 RTT (재연결 0-RTT) |
| 연결 이전 | 불가(IP 바뀌면 끊김) | 불가 | 연결 ID 로 가능 |

### 버전은 어떻게 고르나

브라우저는 처음엔 TCP 로 접속하고, 서버가 "HTTP/3 도 된다" 고 알려 주면 다음부터 QUIC 을 쓴다.

```
HTTP/2 응답 헤더:   alt-svc: h3=":443"; ma=86400
DNS HTTPS 레코드:   example.com. HTTPS 1 . alpn="h3,h2"     # 첫 접속부터 h3 시도 가능
```

UDP 가 막힌 네트워크(일부 기업 방화벽)에서는 QUIC 이 실패하고 TCP 로 돌아간다 — 그래서 HTTP/3 서버는 **항상 HTTP/2 와 함께** 운영한다.

```nginx
server {
  listen 443 quic reuseport;       # HTTP/3 (UDP)
  listen 443 ssl;                  # HTTP/1.1·2 (TCP)
  http2 on;
  ssl_protocols TLSv1.3;           # QUIC 은 TLS 1.3 만
  add_header Alt-Svc 'h3=":443"; ma=86400';
}
```

## 실험 — 무엇이 언제 이기나

실험 `netp-h1-vs-h2` 는 nginx(h2c)에서 파일 50개를 `curl --parallel` 로 받았다. 3회 중앙값, ms(docker exec 오버헤드 ~50ms 포함).

**1KB × 50 — 요청 왕복이 지배**

| 방식 | 0ms | 50ms | 50ms + 손실 2% |
|---|---|---|---|
| HTTP/1.1 · 연결 1개 | 57 | 2659 | 3277 |
| HTTP/1.1 · 연결 6개 | 49 | 576 | 773 |
| HTTP/2 · 다중화 1연결 | 48 | **304** | **312** |

- 연결 1개: 50 요청 × 50ms ≈ 2.5초 — 정확히 직렬화 비용.
- 연결 6개: 50/6 ≈ 9 왕복 → 약 0.5초.
- HTTP/2: 연결 수립 + 요청 전부를 한 번에 → 약 4~5 왕복(TCP 핸드셰이크·SETTINGS 교환·요청·응답). 작은 리소스가 많은 페이지에서 HTTP/2 가 이기는 전형.

**20KB × 50 (총 1MB) — 데이터량이 지배**

| 방식 | 0ms | 50ms | 50ms + 손실 2% |
|---|---|---|---|
| HTTP/1.1 · 연결 1개 | 53 | 2719 | 5600 |
| HTTP/1.1 · 연결 6개 | 49 | **624** | **722** |
| HTTP/2 · 다중화 1연결 | 52 | 713 | 1230 |

- 역전됐다. HTTP/2 는 요청 왕복은 아꼈지만, **연결 하나의 혼잡 윈도**가 초기 10 세그먼트(≈14KB)에서 슬로 스타트로 1MB 를 보낼 만큼 커지는 데 여러 RTT 가 걸린다. 연결 6개는 처음부터 윈도가 6배다([혼잡 제어](/network-protocols/notes/04-congestion-control)).
- 손실 2% 를 넣으면 HTTP/2 는 **1.73배**, HTTP/1.1×6 은 **1.16배** 느려졌다. 손실 하나가 50개 스트림을 모두 세우는 TCP 머리 막힘이 숫자로 보인다.

결론: HTTP/2 는 "요청이 많고 작을 때" 크게 이기고, "데이터가 크고 손실이 있을 때" 연결 하나라는 구조적 한계를 드러낸다. HTTP/3 은 바로 그 한계를 노린다.

이 실험의 이미지에서 nginx 는 `http_v3_module` 을 갖고 있지만 alpine 의 curl 에 HTTP/3 지원이 없어 HTTP/3 은 재지 못했다. 직접 재려면 HTTP/3 지원 curl(ngtcp2/quiche 빌드)이 든 이미지를 쓰고, nginx 에 TLS 인증서와 `listen 443 quic` 을 준다.

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 Next.js 개발 서버는 HTTP/1.1 이다. 앞단 Nginx(`pnpm nginx:tls`, [Nginx 03](/nginx/notes/03-cache-tls-ratelimit))를 두면 브라우저와는 HTTP/2 로, 업스트림과는 HTTP/1.1 keepalive 로 말한다 — 프록시가 버전을 갈아 끼우는 지점이다.
- gRPC([API 설계 03](/api-design/notes/03-protobuf-grpc))는 HTTP/2 위에서만 동작한다. 실험 `api-grpc-unary-vs-stream` 의 "동시 unary 1000개가 연결 하나로" 가 바로 스트림 다중화다.
- 서비스 메시 프록시([서비스 메시 04](/service-mesh/notes/04-traffic-policy))는 HTTP/1.1 요청도 프록시 사이에서 HTTP/2 로 묶어(upgrade) 보낸다 — 연결 수를 줄이고 다중화를 얻는다.

![계층별 머리 막힘](/diagrams/netp-hol.svg)

## 흔한 오해

| 오해 | 실제 |
|---|---|
| "HTTP/2 는 항상 빠르다" | 요청이 많고 작을 때 빠르다. 큰 데이터·손실 많은 경로에서는 연결 하나의 한계가 드러난다(위 실험의 20KB 행) |
| "HTTP/2 로 바꾸면 번들링이 필요 없다" | 요청 수 비용은 줄지만 압축 효율·캐시 단위의 트레이드오프는 남는다. 아주 많은 작은 파일은 여전히 느리다 |
| "HTTP/3 은 UDP 라 신뢰성이 없다" | 신뢰성(재전송·순서)은 QUIC 이 유저 공간에서 구현한다. 스트림 안의 순서는 보장된다 |
| "서버만 HTTP/2 를 켜면 된다" | 중간 프록시·LB 가 HTTP/1.1 로 내리면 그 구간은 HTTP/1.1 이다. 경로 전체를 확인한다 |
| "HTTP/2 서버 푸시로 미리 보내면 빠르다" | 클라이언트 캐시에 이미 있는 것도 보내 낭비가 컸다. 주요 브라우저가 지원을 제거했고, 대신 `103 Early Hints` 를 쓴다 |

## 버전별 감각

| 상황 | 유리한 버전 | 이유 |
|---|---|---|
| 작은 리소스 수백 개(웹 페이지) | HTTP/2·3 | 요청 왕복 절약 |
| 큰 파일 하나 다운로드, 손실 거의 없음 | 차이 작음 | 처리량은 혼잡 제어가 정함 |
| 손실 많은 모바일 | HTTP/3 | 스트림 독립, 빠른 손실 복구 |
| 네트워크 전환이 잦음 | HTTP/3 | 연결 이전 |
| 서버 간 RPC | HTTP/2(gRPC) | 다중화·헤더 압축, 장기 연결 |
| UDP 가 막힌 환경 | HTTP/2 | HTTP/3 은 폴백됨 |

> 이어서 읽기: [L4/L7 로드밸런싱 — HTTP/2 의 연결 쏠림](/network-protocols/notes/06-load-balancing-cdn) · [관측과 디버깅 — 버전과 연결 재사용 확인](/network-protocols/notes/07-observing-debugging) · [Linux 네트워크 04 — HTTP 와 TLS 기초](/linux-network/notes/04-http-tls)

## 실전에서는 어디에 쓰이나 — 네트워크 프로토콜 지도

> 웹·앱의 체감 속도, 서버 간 RPC 의 효율, 장거리 전송의 처리량은 대부분 "어느 프로토콜이 몇 RTT 를 쓰고 손실에 어떻게 반응하나" 로 정해진다. 이 주제는 그 원인을 계층별로 짚는 지도다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 작은 리소스 수백 개를 받는 웹 페이지 | HTTP/2 다중화로 요청 왕복 절약, 큰 데이터에선 연결 하나의 한계 | [HTTP/1.1 → 2 → 3](/network-protocols/notes/01-http1-http2-http3) |
| 이동 중에 쓰는 모바일 앱·영상 통화 | QUIC 의 스트림 독립과 연결 이전 | [QUIC](/network-protocols/notes/02-quic) |
| 로그인·결제 화면의 첫 바이트 지연 | TLS 1.3 1-RTT, 세션 재개, 0-RTT 재전송 위험 | [TLS 1.3 핸드셰이크](/network-protocols/notes/03-tls13-handshake) |
| 대륙 간 영상·대용량 다운로드 | 슬로 스타트, CUBIC·BBR 선택 | [혼잡 제어](/network-protocols/notes/04-congestion-control) |
| 리전 간 백업·복제가 회선보다 훨씬 느림 | BDP·소켓 버퍼·Mathis 상한, 버퍼블로트 | [손실·지연·대역폭](/network-protocols/notes/05-loss-latency-throughput) |
| 쿠버네티스 gRPC 서비스에서 Pod 하나만 과열 | L4 연결 단위 분산의 쏠림과 L7 요청 단위 분산 | [L4/L7 로드밸런싱 · CDN](/network-protocols/notes/06-load-balancing-cdn) |
| 전 세계 사용자 대상 정적 자원·API | 애니캐스트, CDN 엣지, 엣지-원본 연결 재사용 | [L4/L7 로드밸런싱 · CDN](/network-protocols/notes/06-load-balancing-cdn) |
| "API 가 느리다" 장애 대응 | `curl -w` 구간 분해, `ss -ti`, tcpdump, qlog | [관측과 디버깅](/network-protocols/notes/07-observing-debugging) |

**회사 규모에 따라**
- 스타트업: 매니지드 LB·CDN 이 HTTP/2·3 과 TLS 1.3 을 기본으로 켜 준다. 직접 할 일은 연결 재사용과 `curl -w` 로 구간을 나눠 보는 습관 정도다.
- 성장기: 쿠버네티스·gRPC 를 들이면서 HTTP/2 연결 쏠림, 배포 중 드레이닝, 리전 간 복제 처리량 같은 문제를 처음 만난다.
- 대규모 조직: 자체 L4 LB(XDP·Maglev 계열), 혼잡 제어 알고리즘 선택, QUIC 직접 운영처럼 프로토콜 자체를 다루는 전담 네트워크·플랫폼 팀이 생긴다.

**이럴 땐 안 맞는다**
- 느린 원인이 서버 처리(TTFB)인데 프로토콜 버전부터 바꾸는 것 — 먼저 `curl -w` 로 구간을 나눈다. 대부분은 앱·DB 쪽이다.
- UDP 가 막힌 사내망·폐쇄망 대상 서비스에서 HTTP/3 만 믿는 것 — HTTP/2 폴백을 항상 함께 연다.

**누가 매일 만나나** — 백엔드는 커넥션 풀·keep-alive·타임아웃을 정할 때, SRE·플랫폼 엔지니어는 LB·Ingress·CDN 설정과 "어느 구간이 느린가" 를 가리는 장애 분석에서 이 주제를 만난다.

## 실습 체크리스트

- [ ] 실험 `netp-h1-vs-h2` 를 돌리고 1KB 와 20KB 에서 승자가 바뀌는 이유를 설명
- [ ] `curl -w '%{http_version} %{num_connects}'` 로 버전과 새 연결 수를 확인
- [ ] 브라우저 개발자 도구의 Protocol 열에서 `h2`·`h3` 를 찾고, `alt-svc` 헤더를 확인
- [ ] HTTP/2 에서 도메인 샤딩·스프라이트가 왜 역효과인지 적기
- [ ] 손실이 많은 네트워크에서 HTTP/2 가 HTTP/1.1 보다 느려질 수 있는 이유를 TCP 관점으로 설명
