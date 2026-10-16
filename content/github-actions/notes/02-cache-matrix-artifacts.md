---
title: 속도와 범위 — 캐시, 매트릭스, 아티팩트, 동시성
order: 2
level: 중급
summary: 의존성·Docker 레이어 캐시, 매트릭스 빌드, 잡 간 데이터 전달, 중복 실행 취소, 비용 절감 팁
tags: [cache, matrix, artifact, concurrency, 비용]
experiments: []
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

## 실습 체크리스트

- [ ] ci.yml 에 `concurrency` 를 넣고 연속 push 로 이전 실행이 취소되는지 확인
- [ ] `timeout-minutes` 추가
- [ ] 매트릭스로 Node 20/22 에서 테스트
- [ ] 업로드된 `vitest-report` 아티팩트를 `gh run download` 로 받기
