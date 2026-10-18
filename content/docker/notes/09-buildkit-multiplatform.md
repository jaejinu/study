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

## BuildKit 은 빌드를 그래프로 본다

예전 빌더는 Dockerfile 을 위에서 아래로 한 줄씩 실행했다. BuildKit 은 먼저 전체를 **LLB(Low-Level Build) 그래프**로 바꾼 뒤, 필요한 노드만 병렬로 실행한다.

```dockerfile
FROM node:22-alpine AS deps        # A
FROM golang:1.23 AS tools          # B  ← 최종 결과에서 안 쓰면 아예 실행 안 함
FROM deps AS build                 # C (A 에 의존)
FROM node:22-alpine AS runtime     # D (A·C 와 병렬로 베이스 pull 가능)
COPY --from=build ...              # D 는 C 결과를 기다림
```

```
     A(deps) ──▶ C(build) ──┐
                            ├──▶ D(runtime)  ← 타깃
     D 의 FROM pull ────────┘
     B(tools): 타깃에 연결 안 됨 → 건너뜀
```

`docker build --target build .` 처럼 타깃을 바꾸면 그래프에서 필요한 부분만 다시 계산한다. 그래서 CI 에서 `--target test` 스테이지로 테스트를 돌리고, 같은 캐시로 `--target runtime` 이미지를 만드는 패턴이 싸다.

## 캐시 마운트 vs 레이어 캐시

둘은 다른 문제를 푼다.

| | 레이어 캐시 | `RUN --mount=type=cache` |
|---|---|---|
| 무엇을 재사용 | 명령 결과 레이어 전체 | 명령 **안에서** 쓰는 디렉터리(패키지 저장소) |
| 언제 효과 | 입력이 **완전히 같을 때** | 입력이 **조금 바뀌었을 때**(lock 에 패키지 1개 추가) |
| 이미지에 남나 | 남음 | 안 남음 |
| CI 에서 | `cache-to` 로 내보낼 수 있음 | 빌더 인스턴스 로컬(임시 러너면 사라짐) |

락파일에 패키지 하나를 추가하면 레이어 캐시는 깨지지만, 캐시 마운트가 있으면 이미 받은 수백 개 패키지는 저장소에서 바로 링크되어 설치가 수 초로 끝난다.

```dockerfile
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile
```

`sharing=locked` 는 동시에 도는 빌드가 같은 캐시를 쓸 때 충돌을 막는다(`shared`(기본)·`private`·`locked`).

## 측정: 이 프로젝트 빌드에서 시간이 어디로 가나

```bash
docker buildx build --progress=plain -t study:dev . 2>&1 | \
  grep -E "^#[0-9]+ (\[|DONE)" | paste - - | awk '{print $NF, $0}' | sort -rn | head
```

전형적인 분포(캐시 없음, M 계열 맥):

| 단계 | 시간 | 줄이는 법 |
|---|---|---|
| `pnpm install` | 40~90s | 캐시 마운트, lock 먼저 COPY |
| `pnpm build`(Next) | 60~120s | `.next/cache` 를 캐시 마운트로, 불필요한 페이지 정적 생성 줄이기 |
| 컨텍스트 전송 | 1~20s | `.dockerignore`(`.git`, `node_modules`) |
| 베이스 pull | 5~20s | 다이제스트 고정 + 레지스트리 미러 |
| export(레이어 압축) | 5~15s | 최종 이미지 크기 줄이기 |

변경이 소스뿐일 때는 install 이 CACHED 되어 build 단계만 남는 것이 정상이다. install 이 다시 돈다면 `COPY` 순서나 `.dockerignore` 문제다.

## 멀티 아키텍처의 실제 함정

| 함정 | 증상 | 해결 |
|---|---|---|
| amd64 전용 이미지를 Apple Silicon 에서 실행 | 느림, 경고 `platform (linux/amd64) does not match` | 멀티 아치 이미지 사용, 없으면 직접 빌드 |
| 네이티브 모듈(sharp 등)이 빌드 머신 아키텍처로 설치 | 다른 아키텍처에서 `exec format error` / `invalid ELF header` | 타깃 플랫폼 스테이지 안에서 install |
| QEMU 에뮬레이션 빌드가 느림 | amd64 빌드 10배 지연 | 네이티브 러너(GitHub `ubuntu-24.04-arm`), 원격 빌더, 크로스 컴파일 |
| 공개 이미지가 amd64 만 제공 | arm64 VM 에서 실행 불가/느림 | 이 프로젝트의 `study-bpftrace:local` 처럼 Dockerfile 로 직접 빌드 |

마지막 행은 이 프로젝트에서 실제로 있었다. 공개 bpftrace 이미지가 amd64 전용이라 arm64 Docker VM 에서 쓸 수 없어, eBPF 실험이 Ubuntu 기반 이미지를 **처음 실행할 때 직접 빌드**한다 — [bpftrace 한 줄 관측](/ebpf/notes/02-bpftrace-one-liners).

## 예시로 보기 — 이 저장소 CI 의 이미지 빌드

`.github/workflows/ci.yml` 의 `image` 잡은 `docker/build-push-action` 으로 이미지를 빌드만 하고(푸시 없음) **GHA 캐시**를 쓴다.

```yaml
- uses: docker/build-push-action@v6
  with:
    context: .
    push: false
    tags: study:ci
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

- `mode=max` 라 builder 스테이지의 install 레이어까지 캐시에 저장 → 다음 PR 은 소스 변경분만 빌드.
- GHA 캐시는 저장소당 10GB, 오래 안 쓰면 축출된다. 캐시 적중률이 떨어지면 빌드 시간이 갑자기 늘어난다 — [CI 성능](/github-actions/notes/06-ci-performance).
- 개선 후보: `--target` 으로 테스트 스테이지 분리, `trivy` 스캔 단계 추가, `--sbom=true --provenance=true`.

## 운영·관측 포인트

- 빌드 시간·캐시 적중을 CI 메트릭으로 남겨 두면 "언제부터 느려졌나" 를 답할 수 있다.
- 빌더 캐시는 디스크를 계속 먹는다(`docker buildx du`). 로컬에서는 주기적으로 `docker builder prune --keep-storage 20GB`.
- 같은 커밋으로 두 번 빌드해 다이제스트가 같은지 확인하는 것이 재현성 점검의 시작이다(`SOURCE_DATE_EPOCH`, 다이제스트 고정 베이스).

## 실전에서는 어디에 쓰이나

> BuildKit 캐시·buildx 멀티플랫폼은 "CI 빌드가 PR 마다 수 분씩 걸린다", "맥에서 만든 이미지가 서버에서 안 돈다" 는 문제를 만날 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 하루 수십 번 머지하는 SaaS 모노레포 | PR 마다 의존성 설치·빌드가 처음부터 돈다 | `cache-to/from`(registry·gha, `mode=max`) + 캐시 마운트 | 빌드 결과를 아티팩트로 재사용하는 빌드 시스템 |
| arm64 클라우드 인스턴스로 비용 절감 | x86·arm 서버에 같은 태그로 배포 | `--platform linux/amd64,linux/arm64` 로 매니페스트 리스트 | 아키텍처별 태그를 따로 관리 — 배포 설정이 복잡해진다 |
| Go·Rust 백엔드 서비스 | QEMU 에뮬레이션 빌드가 너무 느림 | `$BUILDPLATFORM` 에서 크로스 컴파일, 산출물만 타깃 스테이지로 | 아키텍처별 네이티브 러너 |
| 사설 패키지를 쓰는 사내 플랫폼 | 레지스트리 토큰을 레이어에 남기지 않기 | `RUN --mount=type=secret` | 빌드 전 의존성 벤더링 |
| 공공·금융 납품 이미지 | 무엇이 들어 있고 어디서 빌드됐는지 증명 | `--sbom=true --provenance=true`, cosign 서명 | 별도 스캐너로 사후 SBOM 생성 |

**이럴 땐 안 맞는다**
- 매번 새로 뜨는 임시 CI 러너에서 캐시 마운트만 믿는 것 — 빌더 로컬이라 러너가 사라지면 같이 사라진다. 레지스트리·gha 캐시 내보내기를 함께 쓴다.
- 한 아키텍처에만 배포하는 서비스에 멀티플랫폼 빌드를 기본으로 거는 것 — 빌드 시간만 늘어난다.

**누가 매일 만나나** — 플랫폼·DevOps 엔지니어는 CI 빌드 시간 그래프가 갑자기 오를 때(캐시 축출·`.dockerignore` 깨짐), 백엔드 개발자는 Apple Silicon 에서 `exec format error` 를 만날 때 만난다.

**면접·실무 단골 질문**
- Q. 레이어 캐시와 캐시 마운트의 차이 → 레이어 캐시는 입력이 완전히 같을 때 결과를 재사용, 캐시 마운트는 입력이 조금 바뀌어도 패키지 저장소를 재사용한다.
- Q. 멀티 아키텍처 이미지는 어떻게 하나의 태그가 되나 → 플랫폼별 매니페스트를 묶은 이미지 인덱스. pull 하는 쪽이 자기 플랫폼을 고른다.

## 실습 체크리스트

- [ ] 이 프로젝트 Dockerfile 에 `RUN --mount=type=cache` 를 추가하고 두 번째 빌드 시간 비교
- [ ] `--platform linux/amd64,linux/arm64` 로 빌드해 `imagetools inspect` 로 매니페스트 보기
- [ ] `--sbom=true` 로 빌드하고 SBOM 에서 의존성 하나 찾아보기
- [ ] `--progress=plain` 출력에서 CACHED 가 아닌 단계만 골라내기
- [ ] 쓰이지 않는 스테이지를 추가해 `--progress=plain` 에서 실행되지 않는 것 확인
- [ ] 락파일에 패키지 하나 추가 후 캐시 마운트 유무로 install 시간 비교
- [ ] `--progress=plain` 출력에서 가장 느린 단계 3개 뽑기
