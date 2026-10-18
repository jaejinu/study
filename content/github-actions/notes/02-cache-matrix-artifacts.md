---
title: 속도와 범위 — 캐시, 매트릭스, 아티팩트, 동시성
order: 2
level: 중급
summary: 의존성·Docker 레이어 캐시, 매트릭스 빌드, 잡 간 데이터 전달, 중복 실행 취소, 비용 절감 팁
tags: [cache, matrix, artifact, concurrency, 비용]
experiments: [gha-cache-key, gha-act-local-run]
---

## 캐시

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: pnpm }          # pnpm store 를 lock 파일 해시로 캐시

# 직접 제어
- uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: pw-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
    restore-keys: pw-${{ runner.os }}-
```

- 키가 정확히 맞으면 복원, 아니면 `restore-keys` 접두어로 가장 최근 것을 복원하고 잡 끝에 새 키로 저장.
- 저장소당 10GB, 7일 미사용 시 삭제.
- Docker 레이어: `docker/build-push-action` 의 `cache-from/to: type=gha`. 이 저장소의 image 잡이 쓴다 — 두 번째 빌드부터 수십 초.

### 실험: 캐시 키는 어떻게 해석되나

실험 [gha-cache-key](/github-actions/lab/gha-cache-key)는 이 저장소 `pnpm-lock.yaml`(241KB)로 `hashFiles()` 를 실제로 계산하고(0.1ms), actions/cache 의 복원 규칙을 시뮬레이션한다. key = `<OS>-pnpm-<해시 앞 8자>`, restore-keys = `<OS>-pnpm-`.

| 상황 | 복원 | cache-hit | 저장 |
|---|---|---|---|
| main 첫 실행 | MISS | false | 새 키 저장 |
| main 재실행 (락 그대로) | **정확 일치** | true | 건너뜀 (키는 불변) |
| 의존성 추가 → 락 변경 | **부분 복원** ← 이전 키 | false | 새 키 저장 |
| feature 브랜치 첫 실행 | main 캐시 정확 일치 | true | 건너뜀 |
| feature 에서 의존성 추가 | main 캐시 부분 복원 | false | feature 범위에 저장 |
| other 브랜치 (락 = feature) | feature 것은 **안 보임** → main 것 부분 복원 | false | other 범위에 저장 |
| macOS 러너 | MISS (OS 접두가 달라 섞이지 않음) | false | 저장 |
| restore-keys 없이 락 변경 | MISS (콜드 설치) | false | 저장 |

- `cache-hit` 이 false 여도 복원은 됐을 수 있다. "설치 생략" 을 `cache-hit == 'true'` 로 분기하면 부분 복원 때 설치를 빼먹지 않도록 주의.
- 검색 범위는 **현재 브랜치 → 기본 브랜치**. 기능 브랜치끼리는 서로의 캐시를 못 본다. 그래서 main 이 자주 돌아 최신 캐시를 유지하는 것이 PR 속도를 정한다.
- 키에 날짜나 커밋 SHA 를 넣으면 매 실행 새 캐시가 쌓여 10GB 한도에서 정작 쓸 캐시가 밀려난다.

잡 그래프와 캐시 키 해석을 한 장으로 본 그림은 [노트 01](/github-actions/notes/01-workflow-basics)에 있다.

## 매트릭스

```yaml
jobs:
  test:
    strategy:
      fail-fast: false                 # 하나 실패해도 나머지 계속
      matrix:
        node: [20, 22]
        os: [ubuntu-latest, macos-latest]
        include:
          - node: 22
            os: ubuntu-latest
            coverage: true
        exclude:
          - node: 20
            os: macos-latest
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
```

조합마다 잡이 병렬로 생긴다. 동적 매트릭스는 앞 잡의 출력(JSON)을 `fromJSON()` 으로.

## 아티팩트와 잡 간 전달

```yaml
jobs:
  build:
    outputs:
      version: ${{ steps.v.outputs.version }}     # 작은 값은 outputs
    steps:
      - id: v
        run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: dist/, retention-days: 7 }
  deploy:
    needs: build
    steps:
      - uses: actions/download-artifact@v4
        with: { name: dist, path: dist/ }
      - run: echo deploying ${{ needs.build.outputs.version }}
```

아티팩트는 실행 결과물 보관(테스트 리포트, 빌드 산출물)과 잡 간 파일 전달용. 캐시와 다르다(캐시는 실행 간 재사용).

## 동시성: 중복 실행 취소

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true      # 같은 브랜치에 새 push 가 오면 진행 중인 실행 취소
```

배포 잡엔 `cancel-in-progress: false` 로 순서만 보장(큐잉).

## 타임아웃과 재시도

```yaml
jobs:
  test:
    timeout-minutes: 15          # 기본 360분! 꼭 줄인다
    steps:
      - uses: nick-fields/retry@v3
        with: { max_attempts: 3, timeout_minutes: 5, command: pnpm test }
```

## 비용과 속도 팁

- `paths` 필터로 문서만 바뀐 push 엔 실행하지 않기. `paths-ignore: ["**.md"]`.
- 큰 잡을 나누어 병렬화하되, 러너 기동(수십 초)이 잡마다 들어간다.
- macOS 러너는 리눅스의 10배 비용. 꼭 필요한 것만.
- `fetch-depth: 1`(기본) 유지. 전체 이력은 릴리스 노트 생성 때만.
- 대용량 의존성(Playwright 브라우저, 모델 파일)은 캐시.
- private 저장소는 분 단위 과금 — Actions 탭 Usage 에서 확인.

> 캐시 키 설계·Docker 레이어 캐시·샤딩의 심화는 [CI 성능](/github-actions/notes/06-ci-performance).

## 실전에서는 어디에 쓰이나

> 캐시·매트릭스·아티팩트는 "CI 가 매번 의존성을 처음부터 받는다", "여러 버전에서 다 확인해야 한다", "앞 잡의 결과물을 뒤 잡에서 써야 한다" 는 순간 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 오픈소스 라이브러리 | Node 여러 버전·OS 에서 호환 확인 | `matrix: { node: [20, 22], os: [...] }`, `fail-fast: false` | 최신 버전만 테스트 — 사용자 환경에서 깨진다 |
| 웹 서비스 PR 검사 | 매번 수십 초 걸리는 의존성 설치 | 락파일 해시 키 + `restore-keys` 부분 복원 | 사전 설치된 커스텀 러너 이미지 |
| 모바일 앱 빌드 | 빌드 산출물을 테스트·배포 잡에 전달 | `upload-artifact` → `download-artifact`, 보존 기간 설정 | 잡 하나에서 전부 — 실패 격리가 안 된다 |
| 활발한 팀 저장소 | 연속 푸시로 같은 브랜치 실행이 쌓임 | `concurrency` + `cancel-in-progress`, 배포는 큐잉 | 수동 취소 |

**이럴 땐 안 맞는다**
- 실행 간 공유가 아니라 결과 보관이 목적인 파일을 캐시에 → 캐시는 7일 미사용 시 사라진다. 아티팩트로.
- 캐시 키에 커밋 SHA·날짜 → 매번 새 캐시가 쌓여 10GB 한도에서 쓸 캐시가 밀려난다. 락파일 해시로.

**누가 매일 만나나** — 백엔드·프런트 개발자가 "왜 이번 PR 만 설치가 느리지" 를 볼 때(캐시 미스), DevOps 엔지니어가 매트릭스 조합과 비용(macOS 러너 등)을 조정할 때.

**면접·실무 단골 질문**
- Q. 캐시와 아티팩트의 차이? → 캐시는 실행 간 재사용(의존성), 아티팩트는 한 실행의 결과물 보관·잡 간 전달.
- Q. 기능 브랜치 PR 이 다른 기능 브랜치 캐시를 못 쓰는 이유? → 캐시 검색 범위가 현재 브랜치 → 기본 브랜치뿐이다. main 이 최신 캐시를 유지하게 한다.

## 실습 체크리스트

- [ ] ci.yml 에 `concurrency` 를 넣고 연속 push 로 이전 실행이 취소되는지 확인
- [ ] `timeout-minutes` 추가
- [ ] 매트릭스로 Node 20/22 에서 테스트
- [ ] 업로드된 `vitest-report` 아티팩트를 `gh run download` 로 받기
- [ ] 실험 gha-cache-key 의 표를 보고, 키에 `${{ github.ref }}` 를 넣으면 기능 브랜치 첫 실행이 어떻게 바뀌는지 예측하기
- [ ] 실험 gha-act-local-run 에서 매트릭스 잡 출력이 '마지막에 끝난 잡' 값이 되는 것을 확인하고, 잡별 값을 넘기는 방법 찾기

## 관련 노트

- [워크플로 기본](/github-actions/notes/01-workflow-basics)
- [Docker 이미지 최적화 — 레이어 캐시](/docker/notes/06-optimization-security)
- [CI 성능](/github-actions/notes/06-ci-performance) — 캐시 적중률을 재고 개선하는 법
