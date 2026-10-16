---
title: "게이트웨이·인증·레이트리밋 — API 앞단에서 무엇을 막고 무엇을 넘기나"
order: 6
level: 심화
summary: "API 게이트웨이가 맡는 일(라우팅·인증·레이트리밋·변환·관측)과 맡으면 안 되는 일, mTLS·JWT·API 키로 호출자를 확인하는 방법과 검증 위치, 토큰 버킷·슬라이딩 윈도우 레이트리밋을 Redis 로 구현하는 법과 응답 헤더, gRPC-Web·HTTP/JSON 트랜스코딩, Nginx 의 grpc_pass 설정, 그리고 이 사이트의 AI 질문 API 에 레이트리밋을 거는 설계"
tags: [API 게이트웨이, 인증, JWT, mTLS, API 키, 레이트리밋, 토큰 버킷, Nginx, grpc_pass, 트랜스코딩]
experiments: [api-idempotency-key, api-grpc-deadline-cancel]
---

## 게이트웨이가 하는 일

서비스가 여러 개면 모든 서비스가 같은 일을 반복하게 된다. 인증, 레이트리밋, TLS 종단, 로깅. 이것을 앞단 한 곳으로 모은 것이 **API 게이트웨이**다.

```
클라이언트 ─TLS─→ [게이트웨이] ─→ 주문 서비스
                   │ 1. TLS 종단           ─→ 결제 서비스
                   │ 2. 인증 (JWT 검증)     ─→ 상품 서비스 (gRPC)
                   │ 3. 레이트리밋
                   │ 4. 라우팅·버전 분기
                   │ 5. 요청/응답 변환 (REST ↔ gRPC)
                   │ 6. 관측 (로그·메트릭·트레이스 시작)
```

| 맡기면 좋은 것 | 맡기면 안 되는 것 |
|---|---|
| TLS 종단, 인증서 관리 | 비즈니스 규칙 ("VIP 고객은 할인") |
| 토큰 서명 검증, 만료 확인 | **객체 수준 인가** ("이 주문이 이 사용자 것인가") |
| 전역·키별 레이트리밋 | 서비스 사이의 오케스트레이션 |
| 경로 기반 라우팅, 카나리 비율 | 데이터 집계 (그건 [BFF](/api-design/notes/05-graphql-comparison)) |
| 요청 ID·트레이스 ID 주입 | 상태를 가진 로직 |

게이트웨이에 비즈니스 로직이 쌓이면 모든 팀의 배포가 게이트웨이 팀을 거치는 병목이 된다. **얇게** 유지한다.

제품 선택지는 넓다. Nginx·Envoy·Kong(Nginx 기반)·Traefik 같은 프록시형, AWS API Gateway 같은 관리형, Kubernetes 의 Gateway API 구현체들. 이 프로젝트는 [Nginx](/nginx/notes/02-reverse-proxy-lb) 를 리버스 프록시로 쓴다.

## 호출자 확인 — 세 가지 방식

| 방식 | 무엇을 증명 | 어디에 | 장단점 |
|---|---|---|---|
| **API 키** | "이 키를 가진 자" | 서버 대 서버, 파트너 | 단순. 사용자 신원이 아님. 유출 시 회전 필요 |
| **JWT (Bearer)** | 발급자가 서명한 주장(사용자·권한·만료) | 사용자 요청 | 서명만 검증하면 되므로 빠름. 즉시 폐기가 어려움 |
| **mTLS** | TLS 클라이언트 인증서 = 워크로드 신원 | 내부 서비스 사이, 서비스 메시 | 강력. 인증서 발급·회전 인프라 필요 ([TLS 와 인증서](/security/notes/02-tls-certificates)) |

### JWT 검증은 게이트웨이에서, 인가는 서비스에서

```
1. 게이트웨이: 서명(JWKS 의 공개키) · iss · aud · exp · nbf 검증
               실패 → 401, 성공 → 검증된 클레임을 헤더로 (x-user-id, x-scopes)
2. 서비스:     "주문 42 의 owner_id == x-user-id 인가?"  → 아니면 404 (존재를 숨김)
```

두 층을 나누는 이유가 있다. 서명 검증은 모든 서비스에 같다. 반면 객체 수준 인가는 데이터를 봐야 알 수 있다. 게이트웨이가 서비스로 넘기는 헤더는 **게이트웨이만 붙일 수 있어야** 한다. 클라이언트가 보낸 같은 이름의 헤더는 반드시 지운다. 그러지 않으면 클라이언트가 `x-user-id: 1` 을 직접 보내 남이 될 수 있다.

JWT 자체의 함정은 [인증과 인가](/security/notes/03-authn-authz) 에 정리돼 있다. `alg: none`, 키 혼동, 긴 만료가 대표적이다.

## 레이트리밋 — 왜, 무엇을 기준으로

레이트리밋의 목적은 세 가지다.

1. **보호**: 버그 난 클라이언트나 공격자 하나가 전체를 쓰러뜨리지 못하게
2. **공정성**: 한 테넌트가 자원을 독점하지 못하게 ([노이지 네이버](/architecture/notes/08-multitenancy-saas))
3. **비용**: LLM 호출처럼 요청당 돈이 드는 API 의 지출 상한

기준(키)을 무엇으로 잡느냐가 설계의 대부분이다.

| 키 | 장점 | 함정 |
|---|---|---|
| IP | 인증 전에도 적용 | NAT·회사망 뒤 수천 명이 한 IP. IPv6 는 주소가 무한 |
| API 키·사용자 ID | 정확 | 인증 이후에만 가능 |
| 테넌트 | 공정성 | 큰 테넌트 안의 한 사용자가 나머지를 굶길 수 있음 |
| 엔드포인트 × 사용자 | 비싼 API 만 따로 | 규칙이 늘어남 |
| 비용 점수 | GraphQL 복잡도, LLM 토큰처럼 요청마다 비용이 다를 때 | 비용을 미리 추정해야 함 |

### 알고리즘

| 알고리즘 | 동작 | 버스트 | 구현 |
|---|---|---|---|
| 고정 윈도우 | 1분마다 카운터 리셋 | 경계에서 2배 허용 | `INCR` + `EXPIRE` |
| 슬라이딩 윈도우 로그 | 최근 N초의 요청 시각 전부 저장 | 정확 | `ZADD` + `ZREMRANGEBYSCORE` (메모리 큼) |
| 슬라이딩 윈도우 카운터 | 이전·현재 윈도우 가중 합 | 근사 | 키 2개 |
| **토큰 버킷** | 초당 r 개씩 채워지는 최대 b 개 버킷에서 꺼냄 | b 만큼 허용 | 토큰 수 + 마지막 시각 |
| 누수 버킷 | 일정 속도로만 내보냄 | 없음(평탄화) | 큐 |

API 에는 **토큰 버킷**이 가장 흔하다. 평균 속도(r)와 순간 버스트(b)를 따로 정할 수 있기 때문이다. Redis 에서는 원자성을 위해 Lua 스크립트 하나로 구현한다.

```lua
-- KEYS[1]=버킷 키, ARGV: rate(개/초), burst, now(ms), cost
local rate, burst, now, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local b = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(b[1]) or burst
local ts = tonumber(b[2]) or now
tokens = math.min(burst, tokens + (now - ts) / 1000 * rate)       -- 지난 시간만큼 채운다
local allowed = tokens >= cost
if allowed then tokens = tokens - cost end
redis.call("HSET", KEYS[1], "tokens", tokens, "ts", now)
redis.call("PEXPIRE", KEYS[1], math.ceil(burst / rate * 1000) + 1000)
return { allowed and 1 or 0, math.floor(tokens), math.ceil((cost - tokens) / rate * 1000) }   -- 허용, 남은 토큰, 재시도까지 ms
```

Redis 노트의 [레이트 리미팅](/redis/notes/10-rate-limiting) 실험이 고정·슬라이딩·토큰 버킷을 실제로 비교한다.

### 응답으로 알려 주기

거절할 때는 클라이언트가 **언제 다시 해도 되는지** 알려 준다.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 3
RateLimit-Policy: "burst";q=20;w=1, "daily";q=1000;w=86400
RateLimit: "burst";r=0;t=3
Content-Type: application/problem+json

{ "type": "https://api.example.com/problems/rate-limited", "title": "요청이 너무 많습니다", "status": 429 }
```

`RateLimit`·`RateLimit-Policy` 는 IETF 표준화 중인 헤더다. 아직은 `X-RateLimit-Remaining` 같은 관례도 많이 쓴다. gRPC 는 `RESOURCE_EXHAUSTED` + `RetryInfo` 상세로 같은 정보를 준다.

### 분산 환경에서

게이트웨이 인스턴스가 여러 대면 카운터를 공유해야 한다. 선택지는 이렇다.

- **중앙 Redis**: 정확하지만 요청마다 왕복 1번이 추가된다. Redis 장애 시 정책이 필요하다. 보통 **실패 시 허용(fail-open)** 으로 둔다. 레이트리밋이 전체 서비스를 멈추게 하지 않기 위해서다.
- **로컬 + 주기 동기화**: 인스턴스마다 한도의 1/N 을 갖는다. 빠르지만 부정확하다.
- **둘 다**: 로컬로 거친 폭주를 막고, 중앙으로 정밀한 일·월 쿼터를 센다.

## 프로토콜 변환 — REST 로 들어와 gRPC 로

내부는 [gRPC](/api-design/notes/03-protobuf-grpc), 외부는 REST 로 내고 싶을 때 쓰는 방법이다. `.proto` 에 HTTP 매핑을 적는다.

```protobuf
import "google/api/annotations.proto";

service Catalog {
  rpc GetItem(GetItemRequest) returns (Item) {
    option (google.api.http) = { get: "/v1/items/{id}" };
  }
  rpc CreateItem(CreateItemRequest) returns (Item) {
    option (google.api.http) = { post: "/v1/items" body: "item" };
  }
}
```

Envoy 의 gRPC-JSON transcoder, grpc-gateway(Go), Connect 같은 도구가 이 어노테이션을 읽어 `GET /v1/items/812` 를 `GetItem({id: 812})` 로 바꾼다. 계약은 `.proto` 하나로 유지된다.

## Nginx 로 gRPC 프록시하기

Nginx 는 HTTP/2 위의 gRPC 를 `grpc_pass` 로 프록시한다.

```nginx
upstream catalog_grpc {
  server catalog-1:50051;
  server catalog-2:50051;
  keepalive 32;                     # gRPC 는 긴 연결 — 업스트림 연결 재사용
}

server {
  listen 443 ssl;
  http2 on;                          # gRPC 는 HTTP/2 필수
  ssl_certificate     /etc/nginx/tls/server.crt;
  ssl_certificate_key /etc/nginx/tls/server.key;

  location /study.catalog.v1.Catalog/ {
    limit_req zone=perkey burst=50 nodelay;
    grpc_set_header x-request-id $request_id;
    grpc_read_timeout 30s;           # 스트리밍이면 길게
    grpc_pass grpc://catalog_grpc;   # 업스트림이 TLS 면 grpcs://
    error_page 502 = /error502grpc;
  }
  location = /error502grpc {
    internal;
    default_type application/grpc;
    add_header grpc-status 14;       # UNAVAILABLE — HTTP 502 가 아니라 gRPC 상태로
    add_header grpc-message "upstream unavailable";
    return 204;
  }
}
```

마지막 블록이 중요하다. 업스트림이 죽었을 때 Nginx 기본 응답은 HTML 502 다. gRPC 클라이언트는 그것을 해석하지 못해 `UNKNOWN` 이나 `INTERNAL` 로 본다. `grpc-status: 14` 로 바꿔 주면 클라이언트의 재시도 정책이 `UNAVAILABLE` 을 보고 올바르게 재시도한다. 이 프로젝트의 TLS 설정은 `nginx/nginx-tls.conf` 와 [캐시·TLS·레이트리밋](/nginx/notes/03-cache-tls-ratelimit) 노트에 있다.

L4 로드밸런서 뒤의 gRPC 는 연결 단위로 분산돼 한 서버로 쏠린다. Nginx 같은 L7 프록시는 **요청(스트림) 단위**로 분산하므로 이 문제가 없다.

## 예시로 보기 — 이 사이트의 `/api/ask` 에 레이트리밋 걸기

이 사이트의 "AI 에게 묻기" 는 `POST /api/ask` 다. 호출마다 LLM 비용이 들고, 지금은 아무 제한이 없다. 설계해 보자.

| 결정 | 선택 | 이유 |
|---|---|---|
| 키 | 로그인이 없으므로 IP (+ 나중에 사용자) | 개인 사이트 |
| 알고리즘 | 토큰 버킷 rate=0.2/s, burst=5 | 연달아 몇 번은 묻게, 평균은 분당 12회 |
| 비용 기준 | 요청 수 대신 **예상 토큰** (질문 길이 + 노트 컨텍스트) | 긴 노트를 붙인 질문이 더 비싸다 |
| 일 예산 | 사용 토큰 합계로 일 상한, 넘으면 429 + 내일 시각 | 지출 상한 |
| 저장 | Redis (이미 진행률을 저장 중) | 추가 인프라 없음 |
| 실패 정책 | Redis 장애 시 허용 | 학습 사이트의 가용성 우선 |
| 관측 | `study_llm_tokens_total` 에 이미 있음 + 거절 카운터 추가 | Grafana 에서 예산 소진 추이 |

같은 질문을 실수로 두 번 보내는 경우는 어떨까. [멱등 키](/api-design/notes/01-rest-principles) 를 붙이면 두 번째는 첫 답을 재생해 비용이 들지 않는다. 실험 `api-idempotency-key` 의 구조를 그대로 쓸 수 있다.

## 실습 체크리스트

- [ ] 위 Lua 토큰 버킷을 `redis-cli --eval` 로 돌려 burst 5 를 다 쓴 뒤 몇 초 후에 다시 허용되는지 확인하기
- [ ] 게이트웨이가 클라이언트의 `x-user-id` 헤더를 지우지 않으면 어떤 공격이 되는지 한 문장으로 쓰기
- [ ] IP 기준 레이트리밋이 회사 NAT 뒤 사용자들에게 어떤 문제를 일으키는지, 대안을 적기
- [ ] Nginx `grpc_pass` 설정에서 502 를 `grpc-status 14` 로 바꾸지 않으면 클라이언트 재시도가 어떻게 달라지는지 설명하기
- [ ] 이 사이트 `/api/ask` 의 토큰 버킷 설계를 실제 코드로 옮긴다면 어디(라우트 핸들러 vs Nginx)에 둘지 정하기
