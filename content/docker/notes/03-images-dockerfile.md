---
title: 이미지와 Dockerfile
order: 3
level: 기초
summary: 레이어 구조와 빌드 캐시, Dockerfile 명령어, 멀티스테이지 빌드로 작고 안전한 이미지 만들기
tags: [Dockerfile, 레이어, 캐시, 멀티스테이지, build]
experiments: [docker-image-layers]
---

## 이미지는 레이어의 스택

Dockerfile 의 각 명령(`RUN`, `COPY`, `ADD`)은 **읽기 전용 레이어**를 하나 만든다. 레이어는 내용 해시로 식별되고, 여러 이미지가 같은 레이어를 공유한다.

```bash
docker image history redis:8-alpine     # 레이어별 크기와 생성 명령
docker image inspect redis:8-alpine
docker images                           # 로컬 이미지 목록
```

컨테이너를 실행하면 맨 위에 **쓰기 가능한 컨테이너 레이어**가 얹힌다 (copy-on-write). 컨테이너를 지우면 이 레이어만 사라진다.

![레이어와 컨테이너](/diagrams/docker-layers.svg)

### 예시로 보기: 같은 Dockerfile, 다른 결과

| Dockerfile 조각 | 이미지 크기 | 이유 |
|---|---|---|
| `RUN apt-get update && apt-get install -y curl` | +60MB | apt 캐시(`/var/lib/apt/lists`)가 레이어에 남음 |
| `RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*` | +25MB | 같은 RUN 에서 지워 레이어에 없음 |
| 위 두 줄을 별도 RUN 으로 | +60MB | 다음 레이어의 삭제는 whiteout 일 뿐 |

실험실의 **이미지 레이어** 실험이 5MB 파일로 같은 현상을 재현하고 레이어 크기를 막대로 보여준다. [BuildKit 심화](/docker/notes/09-buildkit-multiplatform)에서 캐시 마운트로 더 줄인다.

## Dockerfile 핵심 명령

```dockerfile
FROM node:22-alpine            # 베이스 이미지. 항상 태그를 고정
WORKDIR /app                   # 이후 명령의 작업 디렉터리 (없으면 생성)
COPY package.json pnpm-lock.yaml ./     # 호스트 → 이미지
RUN corepack enable && pnpm install --frozen-lockfile   # 빌드 시 실행 (레이어 생성)
COPY . .
ENV NODE_ENV=production        # 환경 변수 (빌드·런타임 모두)
ARG VERSION=dev                # 빌드 시에만 쓰는 변수 (--build-arg)
EXPOSE 3000                    # 문서용. 실제 포트 개방은 -p
USER node                      # 루트 대신 일반 사용자로 실행
CMD ["node", "server.js"]      # 컨테이너 시작 시 기본 명령 (exec 형식)
```

- `RUN` 은 빌드 시, `CMD`/`ENTRYPOINT` 는 실행 시.
- `ENTRYPOINT ["redis-server"]` + `CMD ["/etc/redis.conf"]` 조합: `docker run img other.conf` 처럼 인자만 바꿀 수 있다.
- `COPY` 를 쓰고 `ADD` 는 URL/자동 압축 해제가 필요할 때만.
- `.dockerignore` 에 `node_modules`, `.git`, `.next` 를 꼭 넣는다. 빌드 컨텍스트 크기와 캐시 무효화에 직접 영향.

## 빌드 캐시 — 순서가 성능이다

각 명령은 "이전 레이어 + 이 명령 + 입력 파일" 이 같으면 캐시를 재사용한다. **한 레이어가 무효화되면 그 아래 모든 레이어가 다시 빌드**된다.

```dockerfile
# 나쁨: 소스 한 줄만 바뀌어도 pnpm install 이 다시 돈다
COPY . .
RUN pnpm install

# 좋음: 의존성 파일만 먼저 복사 → lock 이 안 바뀌면 install 캐시 적중
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
```

`RUN` 여러 개를 `&&` 로 묶으면 레이어 수가 줄고, 같은 레이어에서 임시 파일을 지워야 실제로 크기가 준다.

```dockerfile
RUN apk add --no-cache curl \
 && curl -o /tmp/x.tgz https://... \
 && tar xzf /tmp/x.tgz -C /opt \
 && rm /tmp/x.tgz          # 다른 RUN 에서 지우면 이전 레이어에 그대로 남는다
```

## 멀티스테이지 빌드

빌드 도구(컴파일러, devDependencies)를 최종 이미지에서 제외한다.

```dockerfile
# ---- 1단계: 빌드 ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- 2단계: 실행 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

`--from=builder` 로 앞 단계의 산출물만 가져온다. Next.js 는 `output: "standalone"` 설정으로 필요한 node_modules 만 모아 준다.

## 실습: 이 프로젝트 이미지 만들기

프로젝트 루트의 `Dockerfile` 이 바로 이 구조다 (`next.config.ts` 에 `output: "standalone"` 설정됨).

```bash
# 참고: 실제 Dockerfile 요약
cat <<'DF'
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production REDIS_URL=redis://redis:6379
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/content ./content
USER node
EXPOSE 3000
CMD ["node", "server.js"]
DF

# 빌드 (태그 붙이기)
pnpm docker:build                  # = docker build -t study:dev .
docker build -t study:dev --progress=plain --no-cache .   # 캐시 없이, 로그 전부

# 3. 크기와 레이어 확인
docker images study
docker image history study:dev

# 실행: 호스트의 Redis 에 붙이기
pnpm docker:run                    # = docker run -p 3200:3000 -e REDIS_URL=redis://host.docker.internal:6379 study:dev
# 또는 Redis 와 함께 Compose 로
docker compose --profile app up -d --build
```

## 태그 전략

- `latest` 는 "가장 최근에 latest 로 푸시된 것" 일 뿐 최신 버전이라는 보장이 없다. 운영에서는 쓰지 말 것.
- 버전 + git SHA: `api:1.4.2`, `api:1.4.2-a1b2c3d`.
- 재현성이 중요하면 `FROM node:22-alpine@sha256:...` 처럼 다이제스트 고정.

```bash
docker tag study:dev ghcr.io/jaejinu/study:0.1.0
docker push ghcr.io/jaejinu/study:0.1.0
docker pull redis:8-alpine
docker rmi study:dev                 # 이미지 삭제
docker image prune                   # dangling(<none>) 이미지 정리
```
