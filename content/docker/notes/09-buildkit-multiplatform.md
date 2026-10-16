---
title: 심화 — BuildKit, buildx, 멀티플랫폼, 캐시 전략
order: 9
level: 심화
summary: BuildKit 의 병렬 DAG 빌드와 캐시 마운트, Dockerfile 고급 문법(heredoc·bind/cache/secret 마운트·ARG 범위), buildx 로 arm64/amd64 동시 빌드와 매니페스트 리스트, 레지스트리·GHA 캐시 내보내기, 재현 가능한 빌드·SBOM·서명, 빌드 시간 분석
tags: [BuildKit, buildx, 멀티플랫폼, 캐시, Dockerfile, SBOM, 재현가능빌드]
experiments: [docker-image-layers]
---

## BuildKit

Docker 23+ 의 기본 빌더. 예전 빌더와 달리:
- Dockerfile 을 **DAG** 로 분석해 독립적인 스테이지를 **병렬** 빌드하고 쓰이지 않는 스테이지는 건너뛴다.
- 캐시가 레이어 순서가 아니라 **명령 입력 해시** 기반. `RUN --mount=type=cache` 로 패키지 캐시를 빌드 간 유지.
- 비밀·SSH 마운트, 다른 스테이지 파일의 바인드 마운트.
- `--progress=plain` 으로 단계별 시간과 CACHED 를 본다.

```bash
docker buildx build --progress=plain .    # 단계별 시간
docker buildx du                          # 빌드 캐시 사용량
docker buildx prune
```

## Dockerfile 고급 문법

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# 패키지 매니저 캐시를 빌드 간 유지 (레이어에 남지 않음)
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    corepack enable && pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# 사설 레지스트리 토큰 — 레이어·히스토리에 남지 않는다
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
# heredoc 으로 여러 줄 스크립트 (구분자는 자유)
RUN <<SETUP
set -e
addgroup -S app && adduser -S app -G app
mkdir -p /app/logs && chown app:app /app/logs
SETUP
# 다른 스테이지를 복사 없이 바인드 마운트 (빌드 중에만)
RUN --mount=type=bind,from=build,source=/app/.next/standalone,target=/src cp -r /src/. /app/
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
CMD ["node", "server.js"]
```

- `ARG` 는 선언한 스테이지에서만 보인다. 전역 `ARG` 는 `FROM` 앞에, 스테이지 안에서 `ARG NAME` 으로 다시 가져온다.
- `COPY --link` 는 레이어를 독립적으로 만들어 앞 레이어가 바뀌어도 재사용.
- `.dockerignore` 는 **컨텍스트 전송량**과 `COPY . .` 캐시 적중을 좌우한다.

## 캐시 전략

| 캐시 | 위치 | 용도 |
|---|---|---|
| 로컬 빌더 캐시 | 빌더 인스턴스 | 개발 머신 |
| `--cache-to type=registry,ref=…:cache,mode=max` | 레지스트리 | CI 간 공유, 멀티플랫폼 |
| `type=gha` | GitHub Actions 캐시 | 이 저장소의 CI (10GB 한도) |
| `type=local,dest=/tmp/cache` | 디렉터리 | 자체 CI |
| `RUN --mount=type=cache` | 빌더 볼륨 | 패키지 매니저·컴파일 캐시 |

`mode=max` 는 중간 스테이지까지 내보내 멀티스테이지에서 효과가 크다. 캐시 키는 **명령 + 입력 파일 해시** 이므로 `COPY` 순서가 여전히 중요하다 ([Dockerfile 노트](/docker/notes/03-images-dockerfile)).

## 멀티플랫폼 (arm64 + amd64)

Apple Silicon 에서 빌드한 이미지는 arm64. x86 서버에 배포하려면 amd64 도 필요하다.

```bash
docker buildx create --name multi --use --driver docker-container
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/jaejinu/study:1.0 --push .
docker buildx imagetools inspect ghcr.io/jaejinu/study:1.0        # 매니페스트 리스트 (플랫폼별 다이제스트)
```

- 결과는 **매니페스트 리스트**: 태그 하나에 플랫폼별 이미지. pull 하는 쪽이 자기 플랫폼을 고른다.
- 에뮬레이션(QEMU)은 네이티브보다 5~10배 느리다. CI 에서 arm64 러너(또는 원격 빌더)를 쓰거나 **크로스 컴파일**: `FROM --platform=$BUILDPLATFORM golang AS build` + `GOARCH=$TARGETARCH`, 산출물만 타깃 스테이지로.

## 재현 가능한 빌드와 공급망

- 베이스 다이제스트 고정 `FROM node:22-alpine@sha256:…`, lock 파일 `--frozen-lockfile`.
- `SOURCE_DATE_EPOCH` 로 타임스탬프 고정 → 같은 입력이면 같은 다이제스트.
- **SBOM** 과 **provenance**: `docker buildx build --sbom=true --provenance=true`, `docker scout sbom`.
- 서명 `cosign sign …@sha256:…`, 배포 시 검증(Kyverno/Sigstore policy-controller).
- 스캔 `docker scout cves`, `trivy image`. 베이스 갱신 자동화(Dependabot/Renovate).

## 빌드 시간 줄이기 체크리스트

- [ ] `--progress=plain` 으로 느린 단계 측정
- [ ] 의존성 설치 레이어가 소스 변경에 무효화되지 않는가
- [ ] `RUN --mount=type=cache` 로 패키지 캐시
- [ ] `.dockerignore` 에 node_modules, .git, 빌드 산출물
- [ ] CI 에 `cache-from/to` (이 저장소: gha)
- [ ] 멀티플랫폼은 네이티브 러너 또는 크로스 컴파일
- [ ] 최종 이미지 크기 `docker image history` 로 확인

## 실습 체크리스트

- [ ] 이 프로젝트 Dockerfile 에 `RUN --mount=type=cache` 를 추가하고 두 번째 빌드 시간 비교
- [ ] `--platform linux/amd64,linux/arm64` 로 빌드해 `imagetools inspect` 로 매니페스트 보기
- [ ] `--sbom=true` 로 빌드하고 SBOM 에서 의존성 하나 찾아보기
- [ ] `--progress=plain` 출력에서 CACHED 가 아닌 단계만 골라내기
