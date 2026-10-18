---
title: Nginx 가 요청을 처리하는 방식
order: 1
level: 기초
summary: 이벤트 기반 워커 모델, 설정 파일 구조(main/events/http/server/location), server·location 매칭 규칙, 기본 명령
tags: [개요, worker, 설정, server_name, location]
experiments: [nginx-rate-limit-burst, nginx-proxy-cache, nginx-upstream-failover]
---

## 왜 Nginx 인가

웹 서버이자 **리버스 프록시·로드밸런서·캐시·TLS 종단**. 앱 서버(Node, Python) 앞에 두고 정적 파일 서빙, 압축, 연결 관리, 보안 헤더, 레이트 리밋을 맡긴다. Apache 의 프로세스/스레드당 연결 모델과 달리 **이벤트 루프**로 적은 메모리로 수만 연결을 다룬다 (Redis 와 같은 철학).

```
master (설정 읽기, 워커 관리, 권한)
 ├─ worker ×N (CPU 코어 수, 각각 epoll/kqueue 이벤트 루프로 수천 연결)
 └─ cache manager/loader
```

## 설정 파일 구조

```nginx
worker_processes auto;                 # main 컨텍스트
events { worker_connections 1024; }    # 워커당 동시 연결

http {                                 # HTTP 전체
  include mime.types;
  log_format ...; access_log ...;
  gzip on;
  upstream app { server host.docker.internal:3000; }

  server {                             # 가상 호스트 하나
    listen 80;
    server_name study.local;
    location / { proxy_pass http://app; }       # 경로별 처리
    location /static/ { root /var/www; }
  }
}
```

지시어는 **안쪽이 바깥을 덮어쓴다** (http → server → location). 이 프로젝트의 `nginx/nginx.conf` 가 위 구조 그대로다.

## server 선택

1. `listen` 포트/IP 가 맞는 server 들 중
2. `Host` 헤더와 `server_name` 매칭: 정확 → 가장 긴 `*.` 와일드카드 → 가장 긴 `.*` → 정규식(순서대로)
3. 아무것도 안 맞으면 그 포트의 **default_server** (명시 없으면 첫 번째)

```nginx
server { listen 80 default_server; return 444; }   # 모르는 호스트는 연결 끊기
```

## location 매칭

```nginx
location = /health { }        # 정확히 일치 (최우선)
location ^~ /static/ { }      # 접두어, 정규식 검사 생략
location ~ \.php$ { }         # 정규식 (대소문자 구분), 파일에 나온 순서대로 첫 매치
location ~* \.(png|jpg)$ { }  # 정규식 (무시)
location /api/ { }            # 접두어 (가장 긴 것)
location / { }                # 모든 것
```

우선순위: `=` → `^~` → 정규식(순서) → 가장 긴 접두어. 헷갈리면 `curl -I` 와 `add_header X-Loc` 로 어느 블록에 걸렸는지 확인한다.

## root vs alias

```nginx
location /static/ { root /var/www; }     # /static/a.png → /var/www/static/a.png
location /static/ { alias /var/www/s/; } # /static/a.png → /var/www/s/a.png
```

## 기본 명령

```bash
nginx -t                       # 설정 검증 (반드시 reload 전에)
nginx -s reload                # 무중단 재로드 (워커를 새 설정으로 교체)
nginx -T                       # 전체 설정 덤프 (include 펼쳐서)
docker compose exec nginx nginx -t
docker compose exec nginx nginx -s reload
docker compose logs -f nginx
```

## 요청 하나의 여정 — 단계(phase)

설정 파일의 지시어는 **쓴 순서대로 실행되지 않는다**. Nginx 는 요청을 정해진 단계로 흘려보내고, 각 지시어는 자기가 속한 단계에서만 돈다. 그래서 `location` 안에서 `limit_req` 를 `return` 아래에 써도 아무 소용이 없다 — `return` 은 rewrite 단계에서 응답을 끝내 버리고, `limit_req` 는 그 다음인 preaccess 단계에 있기 때문이다.

![Nginx 요청 처리 단계](/diagrams/nginx-request-flow.svg)

| 단계 | 대표 지시어 | 여기서 끝날 수 있나 |
|---|---|---|
| server 선택·location 매칭 | `listen`, `server_name`, `location` | 아니오 (다음 단계로) |
| rewrite | `rewrite`, `set`, **`return`** | 예 — `return` 이면 즉시 응답 |
| preaccess | `limit_req`, `limit_conn` | 예 — 503/429 |
| access | `allow`/`deny`, `auth_request` | 예 — 403/401 |
| content | `proxy_pass`, 정적 파일, `fastcgi_pass` | 응답 생성 |
| log | `access_log` | 항상 (응답 후) |

실험실의 [레이트리밋 실험](/nginx/lab/nginx-rate-limit-burst)은 처음에 `return 200` 으로 짰다가 30개 요청이 전부 통과했다. 이 표가 그 이유다. 단계가 깊어질수록 [프로세스 모델과 성능](/nginx/notes/04-internals-performance-openresty)에서 더 자세히 다룬다.

## 이 프로젝트의 프록시

```bash
pnpm nginx:up                  # localhost:18080 → host.docker.internal:3000 (pnpm dev)
curl -I http://localhost:18080/            # X-Served-By: nginx
curl http://localhost:18080/health         # ok (업스트림 안 거침)
curl http://localhost:18080/nginx_status   # Active connections ...
```

대시보드의 환경 카드가 `/health`, `/`(프록시), `/nginx_status` 를 확인한다.

## 실전에서는 어디에 쓰이나 — Nginx 지도

> Nginx 는 대부분의 웹 서비스에서 "인터넷과 앱 사이의 첫 관문" 이다. 앱 코드를 고치지 않고 라우팅·TLS·캐시·속도 제한·장애 우회를 맡기는 자리이고, Kubernetes 에서는 ingress-nginx 라는 이름으로 같은 역할을 한다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 한 도메인 아래 웹·API·관리자 화면을 여러 앱으로 나눠 운영 | `server_name`·`location` 매칭으로 경로별 라우팅 | 이 노트 (server 선택·location 매칭) |
| 앱 서버 여러 대 앞에서 무중단 배포·장애 전환 | `upstream`, `max_fails`, `proxy_next_upstream` | [리버스 프록시와 로드밸런싱](/nginx/notes/02-reverse-proxy-lb) |
| 실시간 채팅·알림(WebSocket·SSE) | Upgrade 헤더, `proxy_buffering off`, 긴 `proxy_read_timeout` | [리버스 프록시와 로드밸런싱](/nginx/notes/02-reverse-proxy-lb) |
| 커머스·미디어의 정적 자원·이미지 서빙 | `proxy_cache`, `proxy_cache_lock`, `use_stale` | [캐시, TLS, 레이트 리밋, 운영](/nginx/notes/03-cache-tls-ratelimit) |
| 로그인·공개 API 남용 방어, HTTPS 종단 | `limit_req`·`limit_conn`, `ssl_*`·certbot | [캐시, TLS, 레이트 리밋, 운영](/nginx/notes/03-cache-tls-ratelimit) |
| 대규모 이벤트 트래픽 입구·업스트림 커넥션 풀 | 워커·fd 한도, upstream `keepalive`, HTTP/2·3 | [심화 — 내부 동작과 성능 튜닝](/nginx/notes/04-internals-performance-openresty) |
| API 게이트웨이(인증·전역 레이트 리밋·요청 변환) | OpenResty/njs 로 phase 에 로직 삽입 — Kong·APISIX 의 기반 | [심화 — OpenResty](/nginx/notes/04-internals-performance-openresty) |
| Kubernetes 클러스터 입구 | ingress-nginx 컨트롤러가 Ingress 를 nginx 설정으로 바꿔 적용 | [Kubernetes Service 와 Ingress](/kubernetes/notes/04-service-ingress) |

**회사 규모에 따라**
- 스타트업: VM 한 대에 Nginx + certbot 으로 TLS·정적 파일·리버스 프록시를 한 번에 해결한다. 설정 파일 하나가 곧 인프라다.
- 성장기: 클라우드 로드밸런서 뒤에 Nginx 나 ingress-nginx 를 두고, 캐시·레이트 리밋·JSON 접근 로그를 관측 스택(Prometheus·Loki)과 잇는다.
- 대규모 조직: CDN 이 엣지를 맡고, Nginx 계열은 내부 API 게이트웨이(OpenResty 기반)나 팀별 프록시로 나뉜다. 설정은 사람이 아니라 컨트롤러·GitOps 가 만든다.

**이럴 땐 안 맞는다**
- 여러 대에 걸친 정확한 전역 레이트 리밋: `limit_req` 는 노드 로컬이라 대수만큼 한도가 커진다 → Redis 기반 리미터나 API 게이트웨이.
- 수백 개 서비스 사이의 mTLS·재시도·트래픽 분할을 일관되게: 손으로 쓴 설정으로는 감당이 안 된다 → 서비스 메시(Envoy 기반 Istio 등).
- 컨테이너 레이블만으로 라우팅과 인증서를 자동으로 붙이고 싶을 때: ACME 를 내장한 Caddy·Traefik 이 더 간단하다.

**누가 매일 만나나** — 백엔드 개발자는 "업로드가 413", "API 가 502" 를 볼 때 `client_max_body_size`·`proxy_pass` 를 열어 본다. SRE·플랫폼 엔지니어는 Ingress annotation·`nginx -T`·`stub_status` 로 트래픽 입구를 운영한다.

## 실습 체크리스트

- [ ] `nginx -T` 로 최종 설정을 읽고 location 우선순위를 손으로 따라가 보기
- [ ] `location = /health` 를 지우면 `/health` 가 어디로 가는지 확인 (업스트림 404)
- [ ] `server_name` 을 바꾸고 `curl -H 'Host: other'` 로 default_server 동작 확인
- [ ] 설정을 일부러 틀리게 하고 `nginx -t` 메시지 읽기
- [ ] 실험실의 세 실험(레이트리밋·프록시 캐시·장애 전환)을 돌리고, 각 실험이 위 단계 표의 어느 단계를 건드리는지 말해 보기

## 관련 노트

- [리버스 프록시와 로드밸런싱](/nginx/notes/02-reverse-proxy-lb)
- [Linux: 포트·소켓·TCP 상태](/linux-network/notes/02-ip-ports-sockets) — 이벤트 모델이 다루는 소켓
- [Redis 란 무엇인가](/redis/notes/01-redis-overview) — 같은 이벤트 루프 철학
- [Kubernetes Service 와 Ingress](/kubernetes/notes/04-service-ingress) — ingress-nginx 는 이 Nginx 를 Pod 로 띄운 것
- [운영체제: 시스템 콜과 epoll](/os-internals/notes/05-syscalls-interrupts) — 워커 하나가 수만 연결을 다루는 원리
