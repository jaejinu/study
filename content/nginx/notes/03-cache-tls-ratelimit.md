---
title: 캐시, TLS, 레이트 리밋, 운영
order: 3
level: 중급
summary: proxy_cache 와 캐시 키·무효화, Let's Encrypt 와 TLS 설정, limit_req/limit_conn, 보안 헤더, 로그 포맷과 stub_status, 튜닝
tags: [proxy_cache, TLS, certbot, limit_req, 보안헤더, 로그, 튜닝]
experiments: []
---

## 프록시 캐시

```nginx
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=static:10m max_size=1g inactive=60m use_temp_path=off;

location /_next/static/ {
  proxy_pass http://app;
  proxy_cache static;
  proxy_cache_key $scheme$host$request_uri;
  proxy_cache_valid 200 302 10m;
  proxy_cache_valid 404 1m;
  proxy_cache_use_stale error timeout updating http_500 http_502;   # 업스트림 장애 시 오래된 것이라도
  proxy_cache_lock on;                                              # 동시 미스 시 한 요청만 업스트림으로 (stampede 방지)
  add_header X-Cache $upstream_cache_status;                        # HIT / MISS / EXPIRED / STALE
}
```

- 업스트림의 `Cache-Control: no-cache/private` 과 `Set-Cookie` 가 있으면 기본적으로 캐시하지 않는다 (`proxy_ignore_headers` 로 무시 가능, 주의).
- 무효화: 오픈소스엔 PURGE 가 없다. 키에 버전/해시를 넣거나(Next.js 의 `/_next/static/<hash>/`), 캐시 디렉터리를 지우거나, `proxy_cache_bypass $arg_nocache`.
- 이 프로젝트 설정은 `/_next/static/` 만 캐시한다. `curl -I` 두 번 해서 `X-Cache: MISS → HIT` 를 확인.

## TLS 종단

```nginx
server {
  listen 443 ssl http2;
  server_name study.example.com;
  ssl_certificate     /etc/letsencrypt/live/study.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/study.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;
  ssl_session_cache shared:SSL:10m;
  ssl_stapling on;
  add_header Strict-Transport-Security "max-age=63072000" always;
}
server { listen 80; return 301 https://$host$request_uri; }   # HTTP → HTTPS
```

- 인증서는 **certbot**(Let's Encrypt) 으로 자동 발급·갱신: `certbot --nginx -d study.example.com`. 갱신은 cron/systemd 타이머.
- Mozilla SSL Configuration Generator 의 "intermediate" 프로필을 쓰면 안전한 cipher 설정을 얻는다.
- 컨테이너 환경에선 Caddy/Traefik 이 ACME 를 내장해 더 편할 수 있다. Kubernetes 는 cert-manager.
- mTLS(클라이언트 인증서): `ssl_client_certificate` + `ssl_verify_client on`.

## 레이트 리밋

```nginx
limit_req_zone $binary_remote_addr zone=perip:10m rate=10r/s;     # IP 당 10 req/s
limit_req_zone $server_name zone=global:10m rate=1000r/s;
limit_conn_zone $binary_remote_addr zone=conn:10m;

location /api/ {
  limit_req zone=perip burst=20 nodelay;   # 20 까지 버스트 허용, 초과 503
  limit_req_status 429;
  limit_conn conn 20;                      # 동시 연결 20
}
```

leaky bucket. `nodelay` 가 없으면 버스트 요청을 rate 에 맞춰 지연시킨다. Redis 노트의 레이트 리미터와 비교해 보자 — Nginx 는 노드 단위라 여러 대면 합이 커진다.

## 보안 헤더와 기본 방어

```nginx
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header Content-Security-Policy "default-src 'self'" always;
server_tokens off;                        # 버전 숨기기
client_max_body_size 10m;
location ~ /\. { deny all; }              # .git, .env 노출 방지
```

`add_header` 는 **해당 블록에 하나라도 있으면 상위 것을 상속하지 않는다** — 함정.

## 로그

```nginx
log_format json escape=json '{"time":"$time_iso8601","ip":"$remote_addr","method":"$request_method",'
  '"uri":"$request_uri","status":$status,"bytes":$body_bytes_sent,"rt":$request_time,'
  '"urt":"$upstream_response_time","ua":"$http_user_agent","cache":"$upstream_cache_status"}';
access_log /var/log/nginx/access.json json;
```

`$request_time`(전체) 과 `$upstream_response_time`(앱) 의 차이가 크면 클라이언트 네트워크/버퍼 문제. JSON 로그는 Loki/ES 로 바로 들어간다. `stub_status` + nginx-prometheus-exporter 로 메트릭.

## 튜닝 체크리스트

- `worker_processes auto; worker_connections 4096;` + OS `ulimit -n`
- `keepalive_timeout 65; keepalive_requests 1000;` 클라이언트 측, `upstream keepalive` 서버 측
- `gzip on` + `gzip_types`, 또는 brotli 모듈. 이미 압축된 파일은 제외
- `sendfile on; tcp_nopush on; tcp_nodelay on;`
- `open_file_cache` 정적 파일 메타 캐시
- `reset_timedout_connection on;`

## 실습 체크리스트

- [ ] `/_next/static/` 자원을 두 번 받아 `X-Cache: HIT` 확인
- [ ] `ab -n 200 -c 50 http://localhost:18080/` 로 limit_req 503/429 발생 확인 (`brew install httpd` 로 ab)
- [ ] 로그 포맷을 JSON 으로 바꾸고 `docker compose logs nginx` 로 보기
- [ ] 로컬 자체 서명 인증서(`mkcert`)로 443 종단 구성
