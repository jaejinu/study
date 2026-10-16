---
title: Docker Compose — 여러 컨테이너를 한 파일로
order: 5
level: 중급
summary: compose.yml 구조, 서비스·볼륨·네트워크 선언, 의존성과 헬스체크, 개발 환경 구성
tags: [compose, yaml, depends_on, healthcheck, profiles]
experiments: []
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

## 실습 체크리스트

- [ ] `pnpm redis:docker` 로 Redis 를 띄우고 Redis 대시보드에 연결되는지 확인
- [ ] `docker compose ps` 에서 healthy 상태 확인
- [ ] `docker compose down` 후 `up` 해도 데이터가 남는지, `down -v` 후엔 사라지는지 확인
- [ ] Redis Study 앱을 `web` 서비스로 추가해 `depends_on` + healthcheck 로 묶어 보기
