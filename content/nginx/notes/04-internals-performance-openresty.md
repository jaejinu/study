---
title: 심화 — Nginx 내부 동작, 성능 튜닝, HTTP/3, OpenResty
order: 4
level: 심화
summary: 마스터·워커 프로세스 모델과 이벤트 루프, 요청 처리 11단계(phase)와 모듈 훅, 연결·버퍼·파일 디스크립터 튜닝 수치, keepalive 와 업스트림 커넥션 풀, HTTP/2·HTTP/3(QUIC) 설정, OpenResty/njs 로 로직 넣기, 성능 측정과 병목 찾기, 디버그 로그
tags: [워커, 이벤트루프, phase, 튜닝, keepalive, HTTP/3, QUIC, OpenResty, njs, 벤치마크]
experiments: [net-ports-sockets]
---

## 프로세스 모델

```
master (root): 설정 파싱, 포트 bind, 워커 생성, 신호 처리 (reload, reopen logs)
 └─ worker × N (worker_processes auto = CPU 수): 각자 epoll 루프, 연결 수천~수만
    cache manager / cache loader: proxy_cache 관리
```

- 워커는 **단일 스레드 이벤트 루프**. 블로킹 작업(디스크 읽기)은 `aio threads` 로 스레드 풀에 넘긴다. Redis 와 같은 철학 — 느린 블로킹 하나가 워커를 멈춘다 (동기 DNS 조회, 큰 파일 동기 읽기).
- 연결 수락: 커널이 워커들에 분배(`reuseport` 로 워커별 소켓, 락 경합 제거).
- `nginx -s reload`: 새 워커를 띄우고 옛 워커는 처리 중인 연결을 끝낸 뒤 종료 — 무중단. `-s reopen` 은 로그 파일 회전.

```bash
docker compose exec nginx sh -c 'ps -o pid,user,comm,etime'      # master + workers
docker compose exec nginx nginx -V 2>&1 | tr ' ' '\n' | grep -E "with-|module"   # 컴파일된 모듈
```

## 요청 처리 단계 (phase)

하나의 HTTP 요청은 11개 phase 를 거치고, 모듈은 특정 phase 에 훅을 건다. "왜 이 지시어가 저것보다 먼저 적용되나" 는 phase 순서로 설명된다.

```
POST_READ → SERVER_REWRITE (server 의 rewrite) → FIND_CONFIG (location 매칭) → REWRITE (location 의 rewrite)
→ POST_REWRITE (rewrite 로 location 바뀌면 FIND_CONFIG 로 재진입, 최대 10회)
→ PREACCESS (limit_req, limit_conn) → ACCESS (allow/deny, auth_basic, auth_request)
→ POST_ACCESS → PRECONTENT (try_files) → CONTENT (proxy_pass, static, return) → LOG (access_log)
```

예: `limit_req` 는 PREACCESS 라 `auth_request` 보다 먼저 거절한다. `return` 은 REWRITE 단계라 그 아래 `proxy_pass` 는 실행되지 않는다. `try_files` 는 CONTENT 직전에 파일 존재를 확인한다.

## 핵심 튜닝 수치

```nginx
worker_processes auto;
worker_rlimit_nofile 65535;                 # 워커당 fd 한도 (연결 1개 = fd 1~2개)
events { worker_connections 16384; multi_accept on; use epoll; }
http {
  keepalive_timeout 65s; keepalive_requests 10000;     # 클라이언트 keepalive (HTTP/1.1)
  client_body_buffer_size 128k; client_max_body_size 50m;
  client_header_timeout 15s; client_body_timeout 15s; send_timeout 30s;   # 느린 클라이언트 방어 (slowloris)
  reset_timedout_connection on;
  sendfile on; tcp_nopush on; tcp_nodelay on;          # 정적 파일 zero-copy, 헤더+본문 묶기
  aio threads; directio 4m;                            # 큰 파일은 스레드 풀 + 페이지 캐시 우회
  open_file_cache max=10000 inactive=60s; open_file_cache_valid 120s;
  proxy_buffers 8 16k; proxy_buffer_size 16k; proxy_busy_buffers_size 32k;   # 업스트림 응답 버퍼
  upstream app { server app:3000; keepalive 64; keepalive_requests 1000; keepalive_timeout 60s; }   # 업스트림 커넥션 풀
  server { listen 443 ssl reuseport; … }
}
```

- **업스트림 keepalive** 없으면 요청마다 앱에 TCP 연결 → TIME_WAIT 폭증, 지연 ↑. `proxy_http_version 1.1` + `Connection ""` 필수 ([리버스 프록시 노트](/nginx/notes/02-reverse-proxy-lb)).
- 최대 동시 연결 ≈ `worker_processes × worker_connections`. 프록시는 연결당 fd 2개(클라이언트+업스트림).
- OS: `net.core.somaxconn`, `net.ipv4.ip_local_port_range`, `fs.file-max` ([Linux 소켓 노트](/linux-network/notes/02-ip-ports-sockets)).
- 버퍼가 작으면 큰 응답이 임시 파일로 간다(`proxy_max_temp_file_size`) — 디스크 I/O. 로그에 "an upstream response is buffered to a temporary file" 가 보이면 `proxy_buffers` 조정.

## TLS 성능

- `ssl_session_cache shared:SSL:50m; ssl_session_timeout 1d; ssl_session_tickets off;`(티켓은 키 회전 필요) — 핸드셰이크 재사용.
- TLS 1.3 기본, OCSP stapling 으로 클라이언트 OCSP 조회 제거.
- `ssl_buffer_size 4k` 로 TTFB 개선 (기본 16k 는 첫 바이트 지연).
- 인증서 ECDSA(P-256) 가 RSA-2048 보다 핸드셰이크 빠르고 작다. 둘 다 올려 협상 가능.
- 하드웨어: TLS 종단은 CPU 집약 — 코어 수와 `worker_processes`.

## HTTP/2 와 HTTP/3

```nginx
server {
  listen 443 ssl;
  listen 443 quic reuseport;             # HTTP/3 (nginx 1.25+, QUIC 모듈)
  http2 on;
  http3 on;
  add_header Alt-Svc 'h3=":443"; ma=86400';   # 클라이언트에 h3 지원 광고
  ssl_early_data on;                         # 0-RTT (재전송 공격 고려, GET 만)
  quic_retry on;
}
```
- HTTP/2 는 한 연결에 다중화 → `keepalive_requests` 와 `http2_max_concurrent_streams`(기본 128) 로 제어. 업스트림으로는 보통 HTTP/1.1(gRPC 는 `grpc_pass`).
- HTTP/3 은 UDP 443 을 열어야 하고(방화벽!), 커널 UDP 버퍼(`net.core.rmem_max`) 를 키운다. 손실 많은 모바일 환경에서 효과 ([HTTP/TLS 노트](/linux-network/notes/04-http-tls)).

## OpenResty / njs — 로직 넣기

설정만으로 안 되는 것(동적 라우팅, 인증 토큰 검증, A/B 분기, 요청 변환)은 스크립트로.

```nginx
# OpenResty (LuaJIT). Redis 와 궁합이 좋다 — lua-resty-redis 로 워커 안에서 비동기 호출
location /api/ {
  access_by_lua_block {
    local redis = require "resty.redis"; local r = redis:new(); r:set_timeout(50)
    local ok = r:connect("redis", 6379); if not ok then return end               -- fail-open
    local key = "rl:" .. ngx.var.remote_addr
    local n = r:incr(key); if n == 1 then r:expire(key, 1) end
    if n > 20 then return ngx.exit(429) end                                      -- Redis 기반 전역 레이트 리밋
  }
  proxy_pass http://app;
}
# njs (JavaScript, nginx 공식)
js_import auth from /etc/nginx/auth.js;
location /secure/ { auth_request /_auth; proxy_pass http://app; }
location = /_auth { internal; js_content auth.verify; }    # JWT 검증 등
```
- 매 요청 phase 에서 코드가 돌므로 **논블로킹 API(cosocket)** 만 써야 워커가 안 멈춘다.
- Kong, APISIX 같은 API 게이트웨이가 OpenResty 위에 만들어졌다. 플러그인(인증, 레이트리밋, 변환)을 설정으로.
- 이 프로젝트의 Nginx 는 `limit_req`(노드 로컬)지만, 위 Lua 로 바꾸면 Redis 노트의 전역 레이트 리미터가 된다.

## 측정과 병목 찾기

```bash
wrk -t4 -c200 -d30s --latency http://localhost:18080/           # 처리량·지연 분포 (brew install wrk)
ab -k -n 20000 -c 100 http://localhost:18080/health              # keepalive 유무 비교
curl -s http://localhost:18080/nginx_status                      # Active connections, accepts/handled/requests, Reading/Writing/Waiting
# 로그에서 rt(전체) 와 urt(업스트림) 비교 — 차이가 크면 Nginx/네트워크/클라이언트 쪽
docker compose logs nginx | awk '{for(i=1;i<=NF;i++) if($i ~ /^rt=/) print $i}' | sort | uniq -c | sort -rn | head
error_log /dev/stderr debug;                                     # 특정 IP 만: debug_connection 127.0.0.1;
```
- `Waiting`(keepalive 유휴) 이 많고 `Reading/Writing` 이 적으면 정상. `Reading` 이 많으면 느린 클라이언트.
- 워커 CPU 100% 면 TLS/압축/Lua. 업스트림 대기면 앱. 둘 다 아닌데 느리면 OS 소켓(backlog, conntrack).
- `limit_req` 503 이 의도대로 나오는지 부하 테스트로 확인 ([캐시·TLS·레이트리밋 노트](/nginx/notes/03-cache-tls-ratelimit)).

## 실습 체크리스트

- [ ] `nginx -V` 로 컴파일 모듈 확인, `ps` 로 master/worker 확인 후 `-s reload` 중 연결이 끊기지 않는지 `wrk` 로 검증
- [ ] 업스트림 `keepalive` 를 빼고 `wrk` 를 돌려 TIME_WAIT 수(`netstat -an | grep -c TIME_WAIT`)와 지연 비교
- [ ] `proxy_buffers` 를 아주 작게 해 "buffered to a temporary file" 경고 재현
- [ ] OpenResty 이미지(`openresty/openresty:alpine`)로 바꿔 위 Lua 레이트 리밋을 Redis 와 연결
- [ ] `listen 443 quic` 로 HTTP/3 를 켜고 `curl --http3`(지원 빌드) 또는 브라우저 devtools 의 프로토콜 열 확인
