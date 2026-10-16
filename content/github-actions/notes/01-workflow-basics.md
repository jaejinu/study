---
title: 워크플로 기본 — 이벤트, 잡, 스텝
order: 1
level: 기초
summary: 워크플로 파일 구조, 트리거 이벤트, 잡과 러너, 스텝과 액션, 표현식·컨텍스트. 이 저장소의 ci.yml 해부
tags: [workflow, on, jobs, steps, actions, 표현식]
experiments: []
---

## 구조

```yaml
name: CI                      # 워크플로 이름
on: [push, pull_request]      # 언제 (이벤트)
jobs:
  test:                       # 잡 (러너 하나에서 순차 실행되는 스텝 묶음)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # 액션 사용
      - run: pnpm test                     # 셸 명령
```

- **워크플로**: `.github/workflows/*.yml` 하나.
- **잡**: 기본적으로 **병렬** 실행. `needs:` 로 순서. 각 잡은 새 러너(VM)에서 시작 — 파일이 공유되지 않는다 (아티팩트로 전달).
- **스텝**: 잡 안에서 순차. `uses`(액션) 또는 `run`(셸).
- **러너**: GitHub 호스팅(ubuntu/windows/macos) 또는 self-hosted.

## 이벤트

```yaml
on:
  push:
    branches: [main]
    paths: ["src/**", "package.json"]      # 경로 필터
    tags: ["v*"]
  pull_request:
    types: [opened, synchronize, reopened]
  schedule:
    - cron: "0 3 * * 1"                    # 매주 월 03:00 UTC
  workflow_dispatch:                       # 수동 실행 (inputs 가능)
    inputs:
      env: { type: choice, options: [staging, prod] }
  release:
    types: [published]
```

`pull_request` 는 포크 PR 에서 시크릿을 받지 못한다 (안전). `pull_request_target` 은 받지만 위험 — 포크 코드를 실행하지 말 것.

## 이 저장소의 ci.yml

```yaml
jobs:
  test:
    services:                              # 사이드카 컨테이너
      redis:
        image: redis:8-alpine
        ports: ["6379:6379"]
        options: --health-cmd "redis-cli ping" --health-interval 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }   # pnpm store 캐시
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm exec tsc --noEmit -p tsconfig.json
      - run: pnpm test:report
        env: { REDIS_URL: redis://127.0.0.1:6379 }
      - uses: actions/upload-artifact@v4
        if: always()                        # 실패해도 리포트 업로드
        with: { name: vitest-report, path: reports/vitest.json }
  image:
    steps:
      - uses: docker/build-push-action@v6
        with: { push: false, cache-from: type=gha, cache-to: type=gha,mode=max }
```

**services** 가 핵심: Redis 실험 28개가 CI 러너 안의 실제 Redis 에 대해 돈다. 대시보드의 환경 카드가 `gh run list` 로 최근 실행을 보여준다.

## 표현식과 컨텍스트

```yaml
- run: echo "${{ github.ref_name }} by ${{ github.actor }}"
- if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')
- if: ${{ failure() }}                 # 앞 스텝 실패 시
- if: always()
- run: echo "sha=${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"      # 출력 만들기
  id: meta
- run: echo ${{ steps.meta.outputs.sha }}
- run: echo "VAR=value" >> "$GITHUB_ENV"                     # 다음 스텝 환경 변수
```

컨텍스트: `github`, `env`, `secrets`, `vars`, `steps`, `needs`, `matrix`, `runner`, `inputs`.

## 자주 쓰는 액션

| 액션 | 용도 |
|---|---|
| `actions/checkout@v4` | 코드 받기 (`fetch-depth: 0` 으로 전체 이력) |
| `actions/setup-node@v4` | Node + 패키지 캐시 |
| `actions/cache@v4` | 임의 경로 캐시 |
| `actions/upload-artifact` / `download-artifact` | 잡 간 파일 전달, 결과 보관 |
| `docker/build-push-action@v6` | Buildx 빌드·푸시, GHA 캐시 |
| `softprops/action-gh-release` | 릴리스 생성 |

액션은 **태그 대신 커밋 SHA 로 고정**하는 것이 공급망 안전에 좋다 (`uses: actions/checkout@<sha> # v4.2.2`). Dependabot 이 갱신해 준다.

## 실습 체크리스트

- [ ] `gh run list`, `gh run view <id> --log` 로 이 저장소의 실행 로그 읽기
- [ ] `workflow_dispatch` 를 ci.yml 에 추가하고 `gh workflow run CI` 로 수동 실행
- [ ] 스텝에 `if: failure()` 로 실패 시에만 도는 디버그 스텝 추가
- [ ] 일부러 lint 를 깨뜨려 PR 체크가 빨간불이 되는 것 확인

## 관련 노트

- [Docker 이미지와 Dockerfile](/docker/notes/03-images-dockerfile) — image 잡이 빌드하는 것
- [Redis 란 무엇인가](/redis/notes/01-redis-overview) — 서비스 컨테이너로 띄우는 Redis
- [캐시·매트릭스·아티팩트](/github-actions/notes/02-cache-matrix-artifacts)
