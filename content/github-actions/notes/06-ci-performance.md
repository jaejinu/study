---
title: "CI 성능 — 캐시 적중, pnpm store, Docker 레이어 캐시, 병렬·매트릭스, concurrency, 회귀 감지"
order: 6
level: 심화
summary: "CI 가 느린 이유를 측정으로 찾는 법(잡·스텝 시간, 캐시 적중률, 대기 시간), 의존성 캐시의 키 설계와 pnpm store 캐시, Docker 빌드 캐시(gha·registry·레이어 순서·multi-stage), 잡 분할과 매트릭스·샤딩, concurrency 로 중복 실행 취소, 테스트 선택과 affected 빌드, CI 시간 회귀를 잡는 메트릭, 그리고 이 저장소 CI 의 구체적 개선안"
tags: [CI 성능, 캐시, pnpm store, Docker 레이어 캐시, buildx, 매트릭스, 샤딩, concurrency, affected, 회귀]
experiments: [gha-cache-key, gha-act-local-run, gha-workflow-lint]
---

느린 CI 는 비용이 아니라 **행동을 바꾼다**: 개발자가 PR 을 묶어 크게 만들고, 테스트를 건너뛰고, 머지 큐가 밀린다. 목표는 "PR 피드백 10분 이내, main 배포 15분 이내" 같은 **SLO** 로 두고 측정한다([SRE](/sre)).

## 먼저 잰다 — 어디서 시간이 가나

```bash
gh run list --workflow ci.yml --limit 30 --json databaseId,conclusion,createdAt,updatedAt \
  | jq -r '.[] | "\(.databaseId) \(.conclusion) \((.updatedAt|fromdate) - (.createdAt|fromdate))s"'
gh run view <id> --json jobs | jq -r '.jobs[] | "\(.name): \(((.completedAt|fromdate)-(.startedAt|fromdate)))s", (.steps[] | "  \(.name): \(((.completedAt|fromdate)-(.startedAt|fromdate)))s")'
```

전형적인 분포(이 저장소 기준 약 1분 30초):

| 구간 | 시간 | 성격 |
|---|---|---|
| 러너 대기·VM 부팅 | 5~20s | 통제 밖(larger runner·self-hosted 로 줄임) |
| 체크아웃 | 2~5s | `fetch-depth: 1` 기본 |
| 의존성 설치 | **20~40s** | 캐시 적중률이 좌우 |
| lint + tsc | 15~25s | 병렬화 가능 |
| 테스트 | 20~30s | 샤딩·선택 |
| Docker 빌드 | 40~90s | 레이어 캐시가 좌우 |

**캐시 적중률**을 로그에서 확인한다: `actions/setup-node` 의 "Cache restored from key", buildx 의 `CACHED` 표시. 적중이 0% 면 키 설계가 틀렸다.

## 의존성 캐시 — 키 설계가 전부

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: pnpm }     # 내부적으로 pnpm store 경로를 lockfile 해시로 캐시
```

이 한 줄이 하는 일: `pnpm store path` 를 `hashFiles('**/pnpm-lock.yaml')` 키로 캐시. 락파일이 안 바뀌면 적중 → `pnpm install --frozen-lockfile` 이 네트워크 없이 store 에서 하드링크만 한다(수 초).

수동으로 할 때의 규칙:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.local/share/pnpm/store
    key: pnpm-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
    restore-keys: pnpm-${{ runner.os }}-        # 부분 적중: 락파일이 바뀌어도 대부분 재사용
```

- **key 는 정확 일치**, **restore-keys 는 접두 일치**(최신 것). 락파일이 바뀐 PR 도 이전 캐시 위에 차분만 받는다.
- `node_modules` 자체를 캐시하지 말 것 — 플랫폼·Node 버전에 묶이고 pnpm 의 하드링크 구조가 깨진다. **store** 를 캐시한다.
- 캐시는 저장소당 10GB, 7일 미사용 시 삭제. 브랜치 격리: PR 은 자기 브랜치 + 기본 브랜치 캐시만 읽는다 → main 에서 캐시를 **만들어 두는** 워크플로(push 시)가 PR 적중률을 올린다.

## Docker 빌드 캐시

```yaml
- uses: docker/build-push-action@v6
  with:
    push: false
    tags: study:ci
    cache-from: type=gha
    cache-to: type=gha,mode=max       # 모든 중간 레이어 저장
```

`type=gha` 는 GitHub 캐시 API 에 레이어를 저장한다. `mode=max` 가 없으면 최종 스테이지 레이어만 저장돼 multi-stage 의 builder 캐시가 날아간다.

적중을 높이는 Dockerfile 순서(이 저장소의 Dockerfile 이 이미 따르는 것):

```dockerfile
FROM node:22-alpine AS deps
COPY package.json pnpm-lock.yaml ./        # 1) 락파일만 먼저 → 의존성 레이어는 락파일이 안 바뀌면 CACHED
RUN pnpm install --frozen-lockfile
FROM deps AS builder
COPY . .                                   # 2) 소스는 나중에 → 소스 변경은 여기서부터만 재빌드
RUN pnpm build
```

- `COPY . .` 를 위로 올리면 모든 레이어가 매번 무효화된다. **변하지 않는 것부터** 복사.
- `.dockerignore` 에 `node_modules`, `.git`, `logs`, `.next` — 컨텍스트 전송 시간과 캐시 무효화를 줄인다.
- 레지스트리 캐시(`type=registry,ref=ghcr.io/org/app:buildcache`)는 gha 캐시의 10GB 한도와 7일 만료를 피한다. 여러 저장소·러너가 공유할 때 유리.
- `--cache-from` 만 있고 `--cache-to` 가 없으면 캐시가 영원히 안 채워진다(흔한 실수).

## 병렬화 — 잡 분할, 매트릭스, 샤딩

```yaml
jobs:
  lint:   { steps: [install, pnpm lint] }
  types:  { steps: [install, tsc] }
  test:
    strategy:
      fail-fast: false
      matrix: { shard: [1, 2, 3] }
    steps: [install, "pnpm vitest run --shard=${{ matrix.shard }}/3"]
  image:  { needs: [lint, types] }      # 빌드는 정적 검사 통과 후에만
```

- 잡을 나누면 **각 잡이 install 을 반복**한다 — 캐시 적중이 전제. 설치가 5초면 분할이 이득, 40초면 손해.
- `needs` 로 의존 그래프를 만들되 너무 직렬로 두지 않는다. lint 와 test 는 독립.
- 테스트 샤딩: vitest `--shard`, Playwright `--shard`, Jest `--shard`. 느린 테스트 파일의 분포가 고르지 않으면 **시간 기반 분배**(이전 실행의 타이밍 파일)가 더 낫다.
- `fail-fast: false` 는 한 샤드 실패가 나머지를 취소해 **정보를 잃는 것**을 막는다.

## concurrency — 밀려난 실행은 취소

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

같은 브랜치에 푸시가 연속되면 이전 실행을 취소한다. PR 하나가 러너 5대를 잡고 있는 상황을 막는다. main 의 배포 워크플로는 `cancel-in-progress: false` 로 두어 배포 중간 취소를 피한다.

## 테스트 선택 — 바뀐 것만

- **경로 필터**: `on.push.paths` / `paths-ignore` 로 문서만 바뀐 PR 은 테스트를 건너뛴다. 단, 필수 체크가 "skipped" 로 남아 머지가 막힐 수 있다 → `dorny/paths-filter` 로 잡 안에서 분기하거나, 건너뛸 때도 성공 상태를 내는 더미 잡.
- **모노레포 affected**: Turborepo `--filter=...[origin/main]`, Nx `affected` ([04 모노레포](/github-actions/notes/04-monorepo-release-security)).
- **이 저장소**: `content/**` 만 바뀐 커밋(노트 집필)도 전체 vitest 와 Docker 빌드가 돈다. 노트 변경은 lint+tsc+Markdown 검증만으로 충분하다.

## 느린 테스트와 불안정한 테스트

CI 시간의 상당 부분은 **테스트 자체의 설계**에서 온다. 고정 대기(`sleep`)로 짠 테스트는 느리고 불안정하며, "재시도 2회" 로 덮으면 시간이 더 든다 — [테스트 노트 06](/testing/notes/06-e2e-flaky-management)의 실측에서 재시도 2회는 실패율을 6% 로 낮췄지만 시간이 70% 늘었다. 테스트 수가 늘면 샤딩·변경 기반 선택·뮤테이션 점수로 "무엇을 얼마나 돌릴지" 를 정한다([노트 07 뮤테이션 테스트와 비용](/testing/notes/07-mutation-testing-cost)).

## 회귀 감지 — CI 시간도 메트릭이다

CI 시간은 조용히 늘어난다. 잡 시간을 **시계열로** 남겨야 "지난달보다 2배" 를 알 수 있다.

```yaml
- name: CI 시간 기록
  if: always()
  run: |
    curl -s -X POST http://pushgateway:9091/metrics/job/ci/workflow/${{ github.workflow }} \
      --data-binary "ci_job_seconds{job=\"${{ github.job }}\",status=\"${{ job.status }}\"} $SECONDS"
```

또는 GitHub API 로 주기적으로 `gh run list` 를 긁어 Prometheus 로(이 사이트의 GitHub Actions 환경 점검 카드가 그 시작이다). 대시보드: p50/p95 잡 시간, 캐시 적중률, 실패율, 큐 대기 시간 — [관측성](/observability/notes/02-prometheus-promql) 의 RED 를 CI 에 적용한 것.

회귀의 흔한 원인: 락파일 변경으로 캐시 미스가 잦아짐, 테스트 추가로 샤드 불균형, Dockerfile 에 `COPY . .` 가 앞으로 이동, 러너 SKU 변경.

## 예시로 보기 — 이 저장소 CI 개선안

현재(`.github/workflows/ci.yml`): `test` 잡(install → lint → tsc → vitest → 리포트 업로드) + `image` 잡(buildx, gha 캐시). 약 1분 30초.

| # | 제안 | 기대 효과 | 리스크 |
|---|---|---|---|
| 1 | `concurrency` + `cancel-in-progress` 추가 | 연속 푸시 시 러너 낭비 제거 | 없음 |
| 2 | `image` 잡을 `needs: test` 없이 **병렬**로 유지(현재도 병렬) 하되 `paths` 로 `content/**`·`*.md` 만 바뀐 경우 건너뛰기 | 노트 커밋 시 ~60s 절감 | 필수 체크 설정 시 더미 잡 필요 |
| 3 | lint 와 tsc 를 별도 잡으로 분리 | 20s → 병렬 | install 반복(캐시 적중 전제, 현재 적중 중) |
| 4 | vitest 를 Redis 실험 그룹별 2샤드 | 테스트 30s → 15s | Redis 서비스 컨테이너를 샤드마다 |
| 5 | 액션 SHA 고정 + Dependabot | 보안([05](/github-actions/notes/05-runners-and-security)) | 갱신 PR 증가 |
| 6 | `pnpm install` 에 `--prefer-offline` | 캐시 적중 시 네트워크 조회 생략 | 없음 |
| 7 | CI 시간을 Pushgateway/API 로 기록해 Grafana 패널 | 회귀 가시화 | 인프라 필요 |

적용 순서는 1 → 6 → 2 → 5 → 3/4 → 7. 1과 6은 무위험이고, 2가 이 저장소 특성(노트 커밋이 대부분)에 가장 효과적이다.

## 실습 체크리스트

- [ ] `gh run view` 로 최근 실행의 스텝별 시간을 뽑아 위 분포 표를 이 저장소 숫자로 채우기
- [ ] 로그에서 pnpm 캐시와 buildx 레이어의 적중 여부를 찾고, 락파일을 바꾼 PR 에서 restore-keys 부분 적중이 일어나는지 확인
- [ ] `concurrency` 를 추가하고 같은 브랜치에 두 번 연속 푸시해 첫 실행이 취소되는 것 보기
- [ ] Dockerfile 에서 `COPY . .` 를 `pnpm install` 앞으로 옮긴 뒤 빌드 시간이 얼마나 늘어나는지 재고 되돌리기
- [ ] vitest 를 2샤드로 나눠 총 시간과 샤드 불균형을 측정
- [ ] 실험 gha-cache-key 로 지금 키 설계의 부분 복원 시나리오를 확인하고, 실험 gha-workflow-lint 를 CI 첫 단계로 넣었을 때 줄어드는 '푸시→실패' 왕복 수를 추정
- [ ] 플레이키 테스트가 CI 시간을 얼마나 잡아먹는지 [테스트 노트 06](/testing/notes/06-e2e-flaky-management)의 재시도 비용 실측과 비교
