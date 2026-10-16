---
title: 리버스 프록시와 로드밸런싱
order: 2
level: 기초
summary: proxy_pass 의 경로 규칙, 전달해야 할 헤더, upstream 과 밸런싱 알고리즘, 헬스체크·재시도, keepalive, WebSocket
tags: [proxy_pass, upstream, 로드밸런싱, X-Forwarded-For, keepalive, WebSocket]
experiments: [nginx-upstream-failover]
---

## proxy_pass

```nginx
location /api/ { proxy_pass http://backend/; }    # /api/users → /users  (URI 치환)
location /api/ { proxy_pass http://backend; }     # /api/users → /api/users (그대로)
```

끝 슬래시 유무가 경로를 바꾼다 — 가장 흔한 실수.

## 반드시 전달할 헤더

```nginx
proxy_set_header Host $host;                                 # 앱이 가상 호스트를 알도록
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; # 클라이언트 IP 체인
proxy_set_header X-Forwarded-Proto $scheme;                  # https 종단 시 앱이 알도록
proxy_http_version 1.1;
proxy_set_header Connection "";                              # 업스트림 keepalive 에 필요
```

앱(Express `trust proxy`, Next.js) 은 이 헤더로 실제 클라이언트 IP·프로토콜을 판단한다. 신뢰할 수 없는 프록시가 끼면 위조 가능하니 `real_ip_module` 로 신뢰 범위를 정한다.

## upstream 과 알고리즘

```nginx
upstream app {
  least_conn;                              # 기본은 round-robin
  server app1:3000 weight=3;
  server app2:3000;
  server app3:3000 backup;                 # 나머지가 다 죽으면
  server app4:3000 max_fails=3 fail_timeout=30s;   # 수동적 헬스체크
  keepalive 32;                            # 업스트림 연결 재사용 풀
}
```

| 방식 | 설명 |
|---|---|
| round-robin | 순서대로 (기본) |
| `least_conn` | 연결 수 적은 곳 |
| `ip_hash` | 클라이언트 IP 별 고정 (세션 고정, 비추천) |
| `hash $request_uri consistent` | 키 기반 일관 해싱 (캐시 노드 분산) |
| `random two least_conn` | 두 개 뽑아 적은 쪽 |

능동적 헬스체크(`health_check`)는 Nginx Plus. 오픈소스는 `max_fails/fail_timeout` 의 수동 판정 또는 외부 도구.

## 재시도와 타임아웃

```nginx
proxy_connect_timeout 5s;
proxy_read_timeout 60s;            # 응답 대기 (스트리밍/SSE 는 길게)
proxy_next_upstream error timeout http_502 http_503;   # 다음 서버로 재시도 조건
proxy_next_upstream_tries 2;
```

**POST 재시도 주의**: 멱등하지 않은 요청이 두 번 갈 수 있다. 기본은 `non_idempotent` 재시도 안 함.

## 버퍼링

Nginx 는 업스트림 응답을 버퍼에 받아 클라이언트에 보낸다 (느린 클라이언트가 앱을 잡아 두지 않게). SSE/스트리밍은 `proxy_buffering off` 또는 응답 헤더 `X-Accel-Buffering: no`.
요청 본문도 `client_max_body_size`(기본 1MB!) 를 넘으면 413 — 파일 업로드 시 꼭 올린다.

## WebSocket

```nginx
location /ws/ {
  proxy_pass http://app;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s;
}
```

## Docker 환경에서 업스트림 이름

- 같은 compose 네트워크의 서비스 이름(`web:3000`)은 Nginx 기동 시 한 번 해석된다. 컨테이너가 재생성되어 IP 가 바뀌면 502 → `resolver 127.0.0.11 valid=10s;` + 변수로 `proxy_pass http://$upstream;` 패턴.
- 호스트 프로세스는 `host.docker.internal` (이 프로젝트).

## 예시로 보기 — 실험으로 보는 장애 전환

실험 [nginx-upstream-failover](/nginx/lab/nginx-upstream-failover)는 업스트림 A·B 컨테이너 앞에 로드밸런서를 두고 B 를 `docker stop` 한다. `proxy_connect_timeout 1s`, `max_fails=1 fail_timeout=5s` 기준 순차 10요청의 실측:

| 상황 | 성공 | 응답한 서버 | 실패 | 800ms 이상 |
|---|---|---|---|---|
| 둘 다 정상 | 10/10 | A 5 · B 5 | 0 | 0 |
| B 정지 · `proxy_next_upstream error timeout` · `max_fails=1` | 10/10 | A 10 | 0 | 1 (1.0s) |
| B 정지 · `proxy_next_upstream off` · `max_fails=0` | 5/10 | A 5 | 5 | 5 (각 1.0s) |
| B 복구 후(fail_timeout 경과) | 10/10 | A 6 · B 4 | 0 | 0 |

읽는 법:
- **재시도는 실패를 지연으로 바꾼다.** B 를 처음 만난 요청 하나만 connect timeout(1s) 을 맞고 A 로 넘어갔다. 사용자는 실패를 보지 못했다.
- **`max_fails`·`fail_timeout` 이 죽은 서버를 잠시 뺀다.** 그 뒤 9개는 B 를 건너뛰어 1ms 대로 끝났다. 수동 헬스 체크라 "실제 요청이 실패해야" 알아차린다.
- **둘 다 끄면** 라운드 로빈 몫의 절반이 그대로 실패하고, 실패마다 1초씩 매달린다. 기본 `proxy_connect_timeout 60s` 였다면 60초다.
- 복구 후 `fail_timeout` 이 지나면 B 가 다시 후보가 된다 — 별도 조치가 필요 없다.

재시도는 **멱등 요청에만** 안전하다. 기본값은 이미 업스트림에 보낸 POST 를 재시도하지 않는다(`non_idempotent` 를 켜야 한다). 결제처럼 중복이 치명적인 경로는 [멱등 키](/api-design/notes/01-rest-principles)로 서버가 막아야 한다. 재시도 폭풍과 서킷 브레이커는 [장애 실험실 노트 03](/chaos/notes/03-resilience-patterns-verified)에서 실측한다.

## 실습 체크리스트

- [ ] `proxy_pass` 끝 슬래시를 바꿔 `/api/` 경로 변화 확인
- [ ] 앱에서 `X-Forwarded-For` 를 로그로 찍어 프록시 경유 시 값 확인
- [ ] `pnpm dev` 를 끄고 접속해 502 와 `error_log` 메시지 보기
- [ ] 업스트림을 두 개(3000, 3001)로 두고 `least_conn` 으로 분산되는지 로그로 확인

## 관련 노트

- [Nginx 개요와 location 매칭](/nginx/notes/01-nginx-overview)
- [Kubernetes Service 와 Ingress](/kubernetes/notes/04-service-ingress) — Ingress Controller 가 곧 Nginx
- [Docker 볼륨과 네트워크](/docker/notes/04-volumes-networks) — host.docker.internal
