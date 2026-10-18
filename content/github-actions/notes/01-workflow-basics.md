---
title: 워크플로 기본 — 이벤트, 잡, 스텝
order: 1
level: 기초
summary: 워크플로 파일 구조, 트리거 이벤트, 잡과 러너, 스텝과 액션, 표현식·컨텍스트. 이 저장소의 ci.yml 해부
tags: [workflow, on, jobs, steps, actions, 표현식]
experiments: [gha-act-local-run, gha-workflow-lint]
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

## 푸시하기 전에 로컬에서 — act 와 actionlint

워크플로를 고칠 때마다 푸시하고 기다리면 한 번에 1~3분이 사라진다. 두 도구가 이 루프를 줄인다.

| 도구 | 하는 일 | 못 하는 일 |
|---|---|---|
| **actionlint** | 문법·러너 라벨·`${{ }}` 식 타입·`needs` 그래프·유명 액션 입력·스크립트 인젝션을 **실행 없이** 검사 | 의미 문제(권한 과다, `pull_request_target` 위험) |
| **act** | 잡마다 Docker 컨테이너를 띄워 단계를 **실제로 실행**, `act -l` 로 잡 그래프 확인 | GitHub-hosted 러너 이미지·`actions/cache`·OIDC·권한을 그대로 재현하지 못함 |

![잡 그래프와 캐시 키 해석](/diagrams/gha-pipeline.svg)

실험 [gha-act-local-run](/github-actions/lab/gha-act-local-run)은 매트릭스(node 20·22) → `needs` 로 이어진 워크플로를 act 로 1.8초에 실행했다. 확인한 것: 매트릭스가 두 잡으로 확장되고, `if: matrix.node == 22` 단계는 22 에서만 돌고, `continue-on-error` 단계는 실패해도 잡이 성공하고, `$GITHUB_OUTPUT` 으로 만든 잡 출력이 `needs.build.outputs` 로 다음 잡에 넘어간다. 그리고 **매트릭스 잡의 outputs 는 마지막에 끝난 잡의 값 하나만 남는다**(실측: `study-20.tgz`). `act -l` 로 본 이 저장소 CI 는 test·image 두 잡이 모두 stage 0 — 서로 기다리지 않고 병렬로 돈다.

실험 [gha-workflow-lint](/github-actions/lab/gha-workflow-lint)는 이 저장소 워크플로가 actionlint 0건인 것을 확인한 뒤, 일부러 틀린 워크플로에서 6건을 잡았다: 러너 라벨 오타(`ubuntu-lates`), 액션 입력 오타(`fetch-dept`), PR 제목을 `run:` 에 직접 넣는 인젝션, 정의 안 된 `matrix.nod`, 없는 잡 `needs: [biuld]`, 없는 `steps.missing`. 특히 `matrix.nod` 같은 오타는 실행해도 에러 없이 **빈 문자열**이 되므로 정적 검사가 아니면 늦게 발견된다.

## 실전에서는 어디에 쓰이나 — GitHub Actions 지도

> GitHub Actions 는 코드가 저장소에 들어오는 순간부터 배포까지를 자동으로 잇는 CI/CD 실행기다. 실무에서는 "PR 마다 무엇을 검사하나", "누가 어떤 권한으로 배포하나", "CI 가 왜 이렇게 느린가" 라는 세 질문으로 매일 등장한다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| PR 마다 lint·테스트 자동 실행 | 이벤트·잡·스텝, 서비스 컨테이너, actionlint | 이 노트 |
| 여러 Node·OS 버전 지원 라이브러리 | 매트릭스, 의존성 캐시, 아티팩트 | [캐시·매트릭스·아티팩트](/github-actions/notes/02-cache-matrix-artifacts) |
| 클라우드·쿠버네티스로 배포 | OIDC, environment 승인, 재사용 워크플로 | [시크릿·권한·배포](/github-actions/notes/03-secrets-deploy) |
| 여러 앱이 한 저장소에 있는 모노레포 | affected 빌드, 머지 큐, 릴리스 자동화 | [모노레포·릴리스·보안](/github-actions/notes/04-monorepo-release-security) |
| 사내망 자원이 필요한 빌드·공급망 보안 | self-hosted 러너, 액션 SHA 고정, pull_request_target | [러너와 보안](/github-actions/notes/05-runners-and-security) |
| "PR 피드백이 너무 느리다" | 캐시 적중, 샤딩, concurrency, CI 시간 메트릭 | [CI 성능](/github-actions/notes/06-ci-performance) |

**회사 규모에 따라**
- 스타트업: 워크플로 파일 한두 개(test·image)로 시작한다. GitHub-hosted 러너와 기본 캐시면 충분하고, 배포 키를 시크릿에 넣는 실수가 흔하다.
- 성장기: OIDC 배포, environment 승인, 매트릭스·캐시 튜닝, 머지 큐가 들어온다. CI 시간이 개발 속도를 좌우하기 시작한다.
- 대규모 조직: 조직 `.github` 저장소의 재사용 워크플로로 표준 CI 를 배포하고, ARC 러너 풀·액션 허용 목록·CI 시간 대시보드를 플랫폼 팀이 운영한다.

**이럴 땐 안 맞는다**
- 코드가 GitHub 밖(GitLab·사내 Git)에 있음 → 그 플랫폼의 CI(GitLab CI 등)가 자연스럽다.
- 몇 시간씩 도는 데이터 파이프라인·주기 배치 → CI 러너는 잡 시간 제한과 비용이 맞지 않는다. Airflow 같은 오케스트레이터나 쿠버네티스 CronJob 으로.

**누가 매일 만나나** — 모든 개발자가 PR 의 빨간 체크를 열어 실패 로그를 볼 때, 플랫폼·DevOps 엔지니어가 워크플로를 고치고 러너·캐시·권한을 관리할 때, 보안 담당이 공급망 스캔 결과를 볼 때.

## 실습 체크리스트

- [ ] `gh run list`, `gh run view <id> --log` 로 이 저장소의 실행 로그 읽기
- [ ] `workflow_dispatch` 를 ci.yml 에 추가하고 `gh workflow run CI` 로 수동 실행
- [ ] 스텝에 `if: failure()` 로 실패 시에만 도는 디버그 스텝 추가
- [ ] 일부러 lint 를 깨뜨려 PR 체크가 빨간불이 되는 것 확인
- [ ] `brew install actionlint act` 후 `actionlint` 와 `act -l` 을 이 저장소에서 실행해 보기
- [ ] ci.yml 의 첫 단계에 `actionlint` 를 넣는다면 어떤 잡·순서가 좋을지 정하기

## 관련 노트

- [Docker 이미지와 Dockerfile](/docker/notes/03-images-dockerfile) — image 잡이 빌드하는 것
- [Redis 란 무엇인가](/redis/notes/01-redis-overview) — 서비스 컨테이너로 띄우는 Redis
- [테스트 전략: 테스트 피라미드와 트로피](/testing/notes/01-test-pyramid-trophy) — CI 가 무엇을 어느 층에서 돌릴지
- [캐시·매트릭스·아티팩트](/github-actions/notes/02-cache-matrix-artifacts)
