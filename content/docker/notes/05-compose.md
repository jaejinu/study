---
title: Docker Compose — 여러 컨테이너를 한 파일로
order: 5
level: 중급
summary: compose.yml 구조, 서비스·볼륨·네트워크 선언, 의존성과 헬스체크, 개발 환경 구성
tags: [compose, yaml, depends_on, healthcheck, profiles]
experiments: [docker-network]
---

## 왜 Compose 인가

`docker run` 옵션이 길어지고 컨테이너가 두 개 이상이면 명령으로 관리하기 어렵다. Compose 는 서비스·볼륨·네트워크를 **YAML 선언**으로 관리한다.

```bash
docker compose up -d           # 생성 + 시작 (백그라운드)
docker compose ps
docker compose logs -f redis
docker compose exec redis redis-cli ping
docker compose stop / start / restart
docker compose down            # 컨테이너·네트워크 삭제 (볼륨은 유지)
docker compose down -v         # 볼륨까지 삭제
docker compose pull            # 이미지 갱신
docker compose config          # 최종 해석된 설정 출력 (디버깅)
```

파일명은 `compose.yml` 또는 `docker-compose.yml`. `version:` 키는 더 이상 쓰지 않는다.

## 이 프로젝트의 compose 파일

```yaml
services:
  redis:
    image: redis:8-alpine
    container_name: study-redis
    command: ["redis-server", "/usr/local/etc/redis/redis.conf", "--dir", "/data", "--bind", "0.0.0.0", "--protected-mode", "no"]
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - ./redis/redis.conf:/usr/local/etc/redis/redis.conf:ro   # 바인드 (설정)
      - redis-data:/data                                        # 볼륨 (데이터)
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

volumes:
  redis-data:
```

```bash
pnpm redis:docker            # = docker compose up -d redis
docker compose ps            # STATUS 에 (healthy) 가 뜨면 준비 완료
pnpm dev                     # Redis Study 가 그대로 붙는다 (REDIS_URL 기본값 127.0.0.1:6379)
pnpm redis:docker:down
```

`command` 로 설정 파일을 지정하고 `--dir /data` 를 뒤에 덧붙여 RDB/AOF 경로를 볼륨으로 보낸다. 설정 파일에 `dir ./redis/data` 처럼 호스트 기준 상대 경로를 넣어 두면 컨테이너 안에는 그 경로가 없어 시작 자체가 실패한다 (처음 띄울 때 실제로 겪은 문제). 환경마다 다른 값은 명령줄 인자로 넘기는 편이 안전하다.

`--bind 0.0.0.0` 도 같은 이유다. 설정 파일의 `bind 127.0.0.1` 은 **컨테이너 안의** 루프백이라, 호스트에서 `-p 6379:6379` 로 들어온 연결(브리지 게이트웨이 IP 에서 옴)은 거부된다. 컨테이너 안에서 `redis-cli ping` 은 되는데 호스트에서는 "Connection reset by peer" 가 나면 이 문제다. 비밀번호 없는 Redis 는 **protected mode** 가 루프백 밖의 연결을 거부하므로 `--protected-mode no` 도 함께 준다. 대신 `ports` 를 `127.0.0.1:6379:6379` 로 적어 호스트 루프백에만 공개한다. 운영이라면 `requirepass`/ACL 을 쓴다.

## 서비스 간 의존성

```yaml
services:
  redis:
    image: redis:8-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
  web:
    build: .
    ports: ["3000:3000"]
    environment:
      REDIS_URL: redis://redis:6379      # 서비스 이름 = 호스트명
    depends_on:
      redis:
        condition: service_healthy       # 단순 시작이 아니라 healthy 까지 대기
```

- Compose 는 프로젝트마다 네트워크를 만들고 **서비스 이름으로 DNS** 를 제공한다.
- `depends_on` 만 쓰면 "컨테이너가 시작됨" 까지만 기다린다. DB 가 준비되기 전에 앱이 붙으려다 실패하는 흔한 문제 → `condition: service_healthy`.
- 그래도 앱 쪽에 재시도 로직은 있어야 한다 (운영에서는 DB 가 먼저 재시작될 수 있다).

## 환경 변수와 .env

```yaml
services:
  web:
    env_file: .env                 # 파일에서 로드
    environment:
      - NODE_ENV=production
      - REDIS_URL=${REDIS_URL:-redis://redis:6379}   # 셸/.env 변수 치환, 기본값
```

Compose 는 같은 디렉터리의 `.env` 를 자동으로 읽어 `${VAR}` 치환에 쓴다 (컨테이너 환경에 자동 주입되지는 않는다).

## 개발 환경 패턴

```yaml
services:
  web:
    build:
      context: .
      target: builder               # 멀티스테이지 중 특정 단계
    command: pnpm dev
    volumes:
      - .:/app                      # 소스 핫리로드
      - /app/node_modules           # 익명 볼륨으로 호스트 node_modules 덮어쓰기 방지
    ports: ["3000:3000"]
```

`docker compose watch` (Compose 2.22+) 는 파일 변경 시 동기화·재빌드를 자동화한다.

## 프로파일과 오버라이드

```yaml
services:
  redis-insight:
    image: redis/redisinsight
    ports: ["5540:5540"]
    profiles: ["tools"]            # 기본 up 에서 제외
```
```bash
docker compose --profile tools up -d
docker compose -f compose.yml -f compose.prod.yml up -d   # 여러 파일 병합
```

## Compose 가 실제로 만드는 것들

`docker compose up` 은 YAML 을 해석해 Docker API 호출 여러 개로 바꾼다. 무엇이 생기는지 이름 규칙을 알면 정리·디버깅이 쉽다.

| 자원 | 이름 규칙 | 예(프로젝트 `study`) |
|---|---|---|
| 네트워크 | `<project>_default` | `study_default` |
| 볼륨 | `<project>_<volume>` | `study_redis-data` |
| 컨테이너 | `<project>-<service>-<n>` (또는 `container_name`) | `study-redis` |
| 레이블 | `com.docker.compose.project/service/config-hash` | 재생성 판단에 사용 |

**프로젝트 이름**은 기본적으로 compose 파일이 있는 **디렉터리 이름**이다. 같은 compose 를 다른 폴더(예: git worktree)에서 실행하면 프로젝트 이름이 달라져 **네트워크와 볼륨이 따로** 만들어지고, `container_name` 이 같으면 충돌한다. 그래서 이 저장소의 스크립트는 `docker compose -p study ...` 처럼 프로젝트 이름을 고정한다.

### 언제 컨테이너를 다시 만드나

Compose 는 서비스 설정의 해시(`config-hash` 레이블)를 저장해 두고, `up` 할 때 바뀐 서비스만 **재생성**한다.

```bash
docker compose up -d                # 설정이 그대로면 "Running" — 아무것도 안 함
docker compose up -d --force-recreate redis   # 강제 재생성
docker compose up -d --no-deps web            # 의존 서비스는 건드리지 않고 web 만
docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' study-redis
```

- 이미지 태그는 같은데 레지스트리에서 새 버전이 나왔다면 `pull` 후 `up` 해야 재생성된다.
- 바인드한 설정 파일 **내용**이 바뀌어도 해시는 그대로다 → `restart` 로 다시 읽게 한다(Redis 는 `CONFIG REWRITE` 와 다르니 주의).

## healthcheck 를 제대로

```yaml
healthcheck:
  test: ["CMD", "redis-cli", "ping"]   # exit 0 = healthy
  interval: 5s       # 검사 주기
  timeout: 3s        # 이보다 오래 걸리면 실패 1회
  retries: 5         # 연속 실패 N회면 unhealthy
  start_period: 20s  # 이 기간의 실패는 retries 에 안 셈(부팅 시간)
```

| 형식 | 실행 방식 | 주의 |
|---|---|---|
| `["CMD", "redis-cli", "ping"]` | 직접 실행 | 바이너리가 이미지에 있어야 함 |
| `["CMD-SHELL", "pg_isready -U study || exit 1"]` | `/bin/sh -c` | 셸 필요, 파이프·`||` 가능 |
| `["NONE"]` | 상속된 헬스체크 끄기 | — |

좋은 헬스체크는 **"프로세스가 떠 있다" 가 아니라 "요청을 받을 수 있다"** 를 검사한다. 그러나 너무 많은 것(DB, 외부 API)을 검사하면 의존성 하나 장애로 앱 전체가 unhealthy → 재시작 연쇄가 난다. 의존성 상태는 readiness 에, 자기 자신은 liveness 에 — Kubernetes 의 [프로브 구분](/kubernetes/notes/03-pod-deployment) 과 같은 원리다.

주의: 헬스체크 명령도 컨테이너 **안에서 실행되는 프로세스**다. 5초마다 `pg_isready` 가 도는 것이 Falco 의 "민감 파일 읽기" 규칙에 잡히는 것도 그래서다 — [Falco 런타임 탐지](/security/notes/05-container-supply-chain).

## depends_on 의 세 조건

| 조건 | 기다리는 것 | 쓰임 |
|---|---|---|
| `service_started`(기본) | 컨테이너 시작 | 순서만 필요할 때 |
| `service_healthy` | healthcheck 통과 | DB·브로커 의존 |
| `service_completed_successfully` | 컨테이너가 0 으로 종료 | 마이그레이션·초기화 잡 |

```yaml
services:
  migrate:
    image: study:dev
    command: ["node", "scripts/migrate.js"]
    depends_on: { postgres: { condition: service_healthy } }
  web:
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
```

## 여러 파일·확장·변수의 우선순위

```bash
docker compose -f compose.yml -f compose.override.yml config   # 병합 결과 확인
```

- `compose.override.yml` 은 **자동으로** 병합된다(개발용 덮어쓰기에 쓰기 좋다).
- 병합 규칙: 스칼라는 뒤 파일이 이김, `ports`·`volumes` 같은 목록은 합쳐짐(중복 주의), `environment` 는 키별 병합.
- `extends` 로 서비스 정의를 상속하거나, YAML 앵커(`x-common: &common`)로 반복을 줄인다.
- 변수 우선순위(높은 순): 셸 환경 > `--env-file` > `.env` > 기본값 `${VAR:-x}`.

## 예시로 보기 — 이 프로젝트의 프로파일 지도

이 저장소의 `docker-compose.yml` 은 한 파일에 학습 주제별 인프라를 **프로파일**로 나눠 둔다. 아무 프로파일 없이 `up` 하면 `redis` 만 뜬다.

| 프로파일 | 서비스 | 호스트 포트 | 스크립트 |
|---|---|---|---|
| (기본) | redis | 6379 | `pnpm redis:docker` |
| app | web(이 사이트) | 3200 | `docker compose --profile app up -d --build` |
| kafka / cdc | kafka, connect(Debezium) | 19092, 18083 | `pnpm kafka:up`, `pnpm cdc:up` |
| postgres | postgres(pgvector) | 15432 | `pnpm pg:up` |
| observability | prometheus, alertmanager, loki, alloy, tempo, grafana, redis-exporter | 19090, 19093, 13100, 13200, 13000 | `pnpm obs:up` |
| search | opensearch | 19200 | `pnpm search:up` |
| mq | rabbitmq, nats | 5673/15674, 14222/18222 | `pnpm mq:up` |
| mlflow / clickhouse / lake | mlflow, clickhouse, minio | 15000, 18123, 19100 | `pnpm mlflow:up` 등 |
| nginx / nginx-tls | nginx | 18080, 18444 | `pnpm nginx:up`, `pnpm nginx:tls` |

설계 원칙 세 가지가 보인다.
1. **모든 포트를 `127.0.0.1:` 에만** 공개 — 비밀번호 없는 개발용 서비스가 LAN 에 노출되지 않게.
2. **기본 포트를 비켜 잡음**(5432 → 15432, 9092 → 19092) — 같은 맥에서 다른 프로젝트 컨테이너가 기본 포트를 쓰고 있어도 충돌하지 않게.
3. **헬스체크 + `service_healthy`** — `web` 은 Redis 가 PONG 을 돌려줄 때까지 기다린다. Connect 는 Kafka·Postgres 가 healthy 여야 시작한다.

```bash
docker compose -p study --profile observability --profile kafka ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
docker compose -p study config --profiles     # 정의된 프로파일 목록
```

## 운영·관측 포인트

- `docker compose events` 로 생성·시작·헬스 변화 이벤트를 실시간으로 본다. 크래시 루프를 잡을 때 유용하다.
- `docker compose logs --since 10m -f web redis` 로 여러 서비스 로그를 시간순으로 섞어 본다.
- Compose 는 **단일 호스트** 도구다. 여러 노드·롤링 배포·자동 복구가 필요해지면 Kubernetes 로 간다. 같은 구성을 쿠버네티스로 옮긴 것이 `k8s/` 디렉터리다 — [Kubernetes 로 넘어가기](/kubernetes/notes/01-kubernetes-overview).

## 실전에서는 어디에 쓰이나

> Compose 는 "여러 컨테이너로 이루어진 환경을 한 파일로 재현" 해야 할 때 등장한다. 주 무대는 로컬 개발·CI 통합 테스트·단일 호스트 운영이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 백엔드 팀의 로컬 개발 | 앱·DB·캐시·브로커를 모두 같은 버전으로 | 서비스·볼륨을 YAML 로 선언, `compose up` 한 번 | 각자 설치 — 버전이 어긋난다 |
| CI 통합 테스트 | 테스트 전에 DB 가 정말 준비됐는지 보장 | healthcheck + `depends_on: service_healthy`, 마이그레이션은 `service_completed_successfully` | Testcontainers 로 테스트 코드에서 띄우기 |
| 데이터·관측 학습 환경 | 필요한 스택만 골라 띄우기 | 프로파일로 묶음 분리(`--profile observability`) | 스택마다 compose 파일 분리 |
| 사내 도구·소규모 서비스 단일 VM 운영 | 오케스트레이터 없이 몇 개 서비스 운영 | `restart: unless-stopped`, 운영용 override 파일 병합 | PaaS, 경량 Kubernetes |
| 공공·온프레미스 납품 | 고객 서버에 설치 절차를 단순화 | compose 파일과 `.env` 만 전달 | 설치 스크립트, Helm 차트 |

**이럴 땐 안 맞는다**
- 여러 노드·롤링 배포·자동 재배치가 필요한 운영 — Compose 는 단일 호스트 도구다. Kubernetes 같은 오케스트레이터로 간다.
- `depends_on` 만 믿고 앱의 재연결 로직을 빼는 것 — 운영에서는 DB 가 먼저 재시작될 수 있다. 앱에 재시도를 둔다.

**누가 매일 만나나** — 백엔드 개발자는 아침에 `compose up` 으로 하루를 시작하고, 플랫폼 엔지니어는 worktree·CI 에서 프로젝트 이름이 달라 볼륨이 따로 생기는 문제를 만난다.

**면접·실무 단골 질문**
- Q. `depends_on` 으로 순서를 줬는데 앱이 DB 연결에 실패한다 → 기본은 "시작됨" 만 기다린다. healthcheck 와 `service_healthy` 를 쓰고 앱에도 재시도를 둔다.
- Q. 설정 파일을 고쳤는데 `up -d` 가 반영하지 않는다 → 바인드한 파일 내용은 config-hash 에 없다. `restart` 로 다시 읽게 한다.

## 실습 체크리스트

- [ ] `pnpm redis:docker` 로 Redis 를 띄우고 Redis 대시보드에 연결되는지 확인
- [ ] `docker compose ps` 에서 healthy 상태 확인
- [ ] `docker compose down` 후 `up` 해도 데이터가 남는지, `down -v` 후엔 사라지는지 확인
- [ ] `docker compose --profile app up -d --build` 로 앱(`web`)까지 띄우고 http://localhost:3200 접속 — `depends_on: condition: service_healthy` 로 Redis 가 healthy 된 뒤 앱이 뜬다
- [ ] 같은 compose 를 `-p` 없이 다른 디렉터리에서 `config` 해 프로젝트·네트워크 이름이 달라지는 것 확인
- [ ] `depends_on: condition: service_completed_successfully` 로 초기화 잡 → 앱 순서 만들어 보기
- [ ] `docker compose events` 를 켜 두고 `restart redis` 해서 health_status 이벤트 관찰

## 관련 노트

- [Kubernetes 란 무엇인가](/kubernetes/notes/01-kubernetes-overview) — Compose 다음 단계
- [Kafka 개요](/kafka/notes/01-kafka-overview), [PostgreSQL 개요](/postgres/notes/01-postgres-overview) — 같은 compose 의 프로파일
