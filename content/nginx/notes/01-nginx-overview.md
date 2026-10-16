---
title: Nginx 가 요청을 처리하는 방식
order: 1
level: 기초
summary: 이벤트 기반 워커 모델, 설정 파일 구조(main/events/http/server/location), server·location 매칭 규칙, 기본 명령
tags: [개요, worker, 설정, server_name, location]
experiments: []
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

## 이 프로젝트의 프록시

```bash
pnpm nginx:up                  # localhost:18080 → host.docker.internal:3000 (pnpm dev)
curl -I http://localhost:18080/            # X-Served-By: nginx
curl http://localhost:18080/health         # ok (업스트림 안 거침)
curl http://localhost:18080/nginx_status   # Active connections ...
```

대시보드의 환경 카드가 `/health`, `/`(프록시), `/nginx_status` 를 확인한다.

## 실습 체크리스트

- [ ] `nginx -T` 로 최종 설정을 읽고 location 우선순위를 손으로 따라가 보기
- [ ] `location = /health` 를 지우면 `/health` 가 어디로 가는지 확인 (업스트림 404)
- [ ] `server_name` 을 바꾸고 `curl -H 'Host: other'` 로 default_server 동작 확인
- [ ] 설정을 일부러 틀리게 하고 `nginx -t` 메시지 읽기
