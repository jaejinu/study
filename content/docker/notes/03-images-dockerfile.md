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

## 레이어의 실체 — overlayfs

"레이어" 는 비유가 아니라 실제 디렉터리다. Docker 의 기본 저장 드라이버 `overlay2` 는 리눅스 **overlayfs** 로 여러 디렉터리를 겹쳐 하나처럼 보이게 한다.

```
lowerdir (읽기 전용, 이미지 레이어들, 아래 → 위)
   L1: alpine 기본 파일
   L2: + node 런타임
   L3: + /app/node_modules
upperdir (컨테이너 쓰기 레이어)
workdir  (overlayfs 내부 작업용)
merged   ← 컨테이너가 / 로 보는 것
```

```bash
docker inspect -f '{{json .GraphDriver.Data}}' study:dev | python3 -m json.tool
# "LowerDir": ".../l/ABC:.../l/DEF:...",  "UpperDir": ..., "MergedDir": ...
```

| 컨테이너에서 하는 일 | overlayfs 가 하는 일 | 비용 |
|---|---|---|
| 이미지 파일 읽기 | lowerdir 에서 바로 읽음 | 없음 |
| 이미지 파일 수정 | 파일 **전체**를 upperdir 로 복사(copy-up) 후 수정 | 큰 파일일수록 큼 |
| 파일 삭제 | upperdir 에 **whiteout** 표시 파일 생성 | 이미지 크기 그대로 |
| 새 파일 생성 | upperdir 에 생성 | 없음 |

그래서 **DB 데이터 파일을 컨테이너 레이어에 두면 안 된다**. 1GB 파일의 1바이트만 바꿔도 copy-up 이 일어나고, 컨테이너를 지우면 사라진다. 볼륨은 overlayfs 를 우회하는 일반 디렉터리 마운트다 → [볼륨과 네트워크](/docker/notes/04-volumes-networks). 커널 쪽 설명은 [파일시스템과 I/O](/os-internals/notes/04-filesystem-io).

## 빌드 캐시 규칙을 정확히

캐시 키는 명령마다 다르다. "왜 캐시가 깨졌는지" 를 설명하려면 이 표가 필요하다.

| 명령 | 캐시 키에 들어가는 것 | 캐시를 깨는 흔한 원인 |
|---|---|---|
| `FROM` | 이미지 다이제스트 | 베이스 태그가 새 다이제스트를 가리킴(`--pull`) |
| `RUN` | 명령 **문자열** + 부모 레이어 | 문자열 변경. ⚠ 외부 상태(`apt-get update`, `curl`)는 키에 없음 |
| `COPY`/`ADD` | 복사되는 파일들의 **내용 체크섬**(+ 권한) | 파일 내용 변경, `.dockerignore` 누락으로 엉뚱한 파일 포함 |
| `ENV`/`ARG` | 값 | `ARG BUILD_DATE` 같은 매번 바뀌는 값을 위쪽에 둠 |
| `WORKDIR`/`USER`/`EXPOSE` | 값 | 거의 없음 |

두 가지 함정:
1. **`RUN apt-get update` 는 캐시되면 영원히 옛 목록**이다. 명령 문자열이 같으니 3개월 전 레이어를 재사용한다. 그래서 `update` 와 `install` 을 같은 RUN 에 묶고, 주기적으로 `--no-cache` 또는 `--pull` 로 빌드한다.
2. **`ARG` 는 선언 위치부터 영향**을 준다. `ARG GIT_SHA` 를 맨 위에 두고 `LABEL` 에 쓰면, SHA 가 매번 바뀌어 그 아래 모든 레이어 캐시가 깨진다. 바뀌는 값은 **가장 아래**에 둔다.

```bash
# 어떤 단계가 캐시를 탔는지 보기
DOCKER_BUILDKIT=1 docker build --progress=plain -t study:dev . 2>&1 | grep -E "CACHED|^#[0-9]+ \["
# #7 [builder 3/6] COPY package.json pnpm-lock.yaml ./     CACHED
# #8 [builder 4/6] RUN pnpm install --frozen-lockfile       CACHED
# #9 [builder 5/6] COPY . .                                  (소스가 바뀌어 여기부터 다시)
```

![빌드 캐시 무효화 흐름](/diagrams/docker-build-cache.svg)

## ENTRYPOINT 와 CMD 의 조합

| Dockerfile | `docker run img` | `docker run img foo` |
|---|---|---|
| `CMD ["redis-server"]` | `redis-server` | `foo` (CMD 대체) |
| `ENTRYPOINT ["redis-server"]` | `redis-server` | `redis-server foo` (인자로 추가) |
| `ENTRYPOINT ["redis-server"]` + `CMD ["/etc/r.conf"]` | `redis-server /etc/r.conf` | `redis-server foo` |
| 셸 형식 `CMD redis-server` | `/bin/sh -c "redis-server"` | `foo` |

공식 이미지 대부분은 `ENTRYPOINT ["docker-entrypoint.sh"]` + `CMD ["redis-server"]` 구조다. 엔트리포인트 스크립트가 권한 조정·초기화를 하고 마지막에 `exec "$@"` 로 CMD 를 **PID 1 로 교체 실행**한다. `exec` 를 빼먹으면 스크립트 셸이 PID 1 로 남아 SIGTERM 을 앱에 전달하지 않는다 → [첫 컨테이너](/docker/notes/02-first-container)의 graceful shutdown.

## 베이스 이미지 선택

| 베이스 | 크기(대략) | 장점 | 주의 |
|---|---|---|---|
| `node:22` (Debian) | ~1GB | 도구 다 있음, glibc | 무겁고 CVE 많음 |
| `node:22-slim` | ~200MB | glibc, 적당한 크기 | 빌드 도구 없음 |
| `node:22-alpine` | ~130MB | 작음 | **musl libc** — 네이티브 모듈(sharp, bcrypt) 빌드·DNS 동작 차이 |
| `gcr.io/distroless/nodejs22` | ~120MB | 셸·패키지 매니저 없음 → 공격면 최소 | 디버깅 어려움 |
| `scratch` | 0 | 정적 바이너리(Go) 전용 | CA 인증서·tzdata 직접 복사 |

alpine 의 musl 은 DNS 해석에서 `search`/`ndots` 처리와 TCP 폴백이 glibc 와 달라 Kubernetes 에서 간헐적 DNS 실패의 원인이 되기도 한다. 크기만 보고 고르지 말고 **네이티브 의존성·디버깅 필요성**을 함께 본다. 보안 관점 비교는 [이미지 최적화와 보안](/docker/notes/06-optimization-security), [컨테이너·공급망 보안](/security/notes/05-container-supply-chain).

## 예시로 보기 — 이 프로젝트의 Dockerfile 해부

| 줄 | 왜 그렇게 썼나 |
|---|---|
| `FROM node:22-alpine AS builder` | 빌드 단계. 태그 고정, 결과물만 다음 단계로 |
| `COPY package.json pnpm-lock.yaml ./` → `RUN pnpm install --frozen-lockfile` | 락파일이 안 바뀌면 install 캐시 적중. `--frozen-lockfile` 로 락파일과 다른 설치 거부 |
| `COPY . .` → `RUN pnpm build` | 소스가 바뀌면 여기부터 다시 |
| 2단계 `FROM node:22-alpine` | devDependencies·소스·캐시가 최종 이미지에 없음 |
| `COPY --from=builder /app/.next/standalone ./` | Next.js 가 추린 최소 node_modules + server.js |
| `COPY --from=builder /app/content ./content` | 노트는 런타임에 파일로 읽으므로 함께 |
| `USER node` | root 로 실행하지 않음(UID 1000) |
| `HEALTHCHECK ... wget -qO- http://127.0.0.1:3000/` | `docker ps` 에 healthy/unhealthy 표시, compose `service_healthy` 조건에 사용 |
| `CMD ["node", "server.js"]` | exec 형식 → node 가 PID 1 로 SIGTERM 수신 |

`.dockerignore` 는 `node_modules`, `.next`, `.git`, `*.md`(단 `!content/**/*.md` 는 포함)를 뺀다. `*.md` 를 빼면서 노트는 다시 포함하는 예외 문법에 주목하자. 이게 없으면 빌드 컨텍스트에 `.git` 수백 MB 가 실리고, README 한 줄 수정에도 `COPY . .` 캐시가 깨진다.

## 운영·관측 포인트

- 이미지 크기는 `docker images` 의 SIZE(압축 해제 기준)와 레지스트리의 압축 크기가 다르다. 풀 시간에 영향을 주는 건 압축 크기다.
- `docker image history --no-trunc` 로 누가 어떤 명령으로 몇 MB 를 더했는지 본다. 예상보다 큰 레이어는 대개 캐시 디렉터리(`~/.npm`, `/var/cache/apk`)다.
- 빌드 재현성: 같은 커밋이 다른 이미지를 만든다면 `apt-get update`, `latest` 베이스, 시간 의존 스크립트를 의심한다.

## 실전에서는 어디에 쓰이나

> 레이어·빌드 캐시·멀티스테이지는 "빌드가 왜 느린가, 이미지가 왜 큰가, 어제와 같은 이미지인가" 를 따질 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 모노레포 CI | 소스 한 줄 수정에 의존성 설치가 매번 다시 돈다 | 락파일만 먼저 `COPY` → install → 소스 `COPY` 순서 | BuildKit 캐시 마운트, 원격 캐시 |
| 컴파일 언어 API 서버 | 컴파일러·devDependencies 가 운영 이미지에 남음 | 멀티스테이지로 산출물만 최종 단계에 복사 | 빌드 서버에서 바이너리만 만들어 얇은 이미지에 복사 |
| 핀테크 배포 승인 | 승인받은 이미지와 운영 이미지가 같음을 보장 | 버전+git SHA 태그, 배포는 `@sha256` 다이제스트로 고정 | `latest` 태그 — 재현성이 없어 쓰지 않는다 |
| 오토스케일되는 웹 서비스 | 새 노드에서 이미지 풀이 느려 확장이 늦음 | 작은 베이스·레이어 공유로 압축 크기 줄이기 | 노드에 이미지 미리 받기(pre-pull) |
| 네이티브 모듈 쓰는 Node 서비스 | alpine(musl) 에서 빌드·DNS 차이로 오동작 | glibc 기반 `-slim` 베이스로 교체 | distroless, 정적 바이너리 + `scratch` |

**이럴 땐 안 맞는다**
- DB 데이터 파일을 컨테이너 레이어에 두는 것 — copy-up 비용이 크고 컨테이너 삭제 시 사라진다. 볼륨을 쓴다.
- `RUN apt-get update` 를 별도 레이어로 캐시해 두는 것 — 오래된 패키지 목록이 계속 재사용된다. install 과 같은 RUN 에 묶는다.

**누가 매일 만나나** — 백엔드 개발자는 Dockerfile 을 고칠 때, 플랫폼 엔지니어는 CI 빌드 시간이 늘었을 때 `--progress=plain` 의 CACHED 줄을 보며 원인을 찾는다.

**면접·실무 단골 질문**
- Q. 다른 RUN 에서 파일을 지웠는데 이미지가 안 줄어든다 → 이전 레이어에 그대로 남고 whiteout 만 생긴다. 같은 RUN 에서 지운다.
- Q. ENTRYPOINT 와 CMD 차이 → ENTRYPOINT 는 고정 실행 파일, CMD 는 기본 인자. 엔트리포인트 스크립트는 `exec "$@"` 로 끝낸다.

## 실습 체크리스트

- [ ] `docker inspect -f '{{json .GraphDriver.Data}}'` 로 LowerDir/UpperDir 확인, 컨테이너에서 파일 수정 후 `docker diff` 와 비교
- [ ] `ARG` 를 맨 위에 두었을 때와 맨 아래에 두었을 때 `--progress=plain` 로 CACHED 줄 수 비교
- [ ] 같은 앱을 `node:22`, `node:22-slim`, `node:22-alpine` 베이스로 빌드해 크기 표 만들기
