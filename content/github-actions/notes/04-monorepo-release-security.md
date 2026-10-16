---
title: 심화 — 모노레포 CI, 릴리스 자동화, 보안 파이프라인
order: 4
level: 심화
summary: 변경된 패키지만 빌드·테스트하는 모노레포 전략(paths·Turborepo·affected), 머지 큐와 필수 체크, 시맨틱 버전·체인지로그·릴리스 자동화(release-please/changesets), 컨테이너 이미지 릴리스 파이프라인(빌드→스캔→서명→SBOM→배포), SAST/의존성/시크릿 스캔, 셀프 호스티드 러너, 비용·속도 관측
tags: [모노레포, Turborepo, 머지큐, release-please, changesets, SBOM, cosign, CodeQL, self-hosted]
experiments: []
---

## 모노레포에서 "바뀐 것만"

```yaml
on:
  pull_request:
    paths: ["apps/web/**", "packages/ui/**", "pnpm-lock.yaml"]     # 1) 경로 필터 (워크플로 단위)
jobs:
  changes:                                                         # 2) 잡 단위 동적 필터
    runs-on: ubuntu-latest
    outputs: { web: ${{ steps.f.outputs.web }}, api: ${{ steps.f.outputs.api }} }
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: f
        with: { filters: "web: ['apps/web/**','packages/**']\napi: ['apps/api/**','packages/**']" }
  web:
    needs: changes
    if: needs.changes.outputs.web == 'true'
    …
```

- **Turborepo / Nx**: `turbo run test --filter=...[origin/main]` 로 git diff 기준 영향받는 패키지만. 원격 캐시(Vercel Remote Cache, 자체 S3)로 "이미 빌드한 해시" 는 건너뛴다 — CI 시간이 분 단위에서 초 단위로.
- 공유 패키지가 바뀌면 의존하는 앱 전부 재실행되어야 한다 — 경로 필터만으론 놓치기 쉬우니 그래프 도구를 쓴다.
- 러너 하나에서 전부 돌리지 말고 **매트릭스로 패키지별 잡**(실패 격리, 병렬).

## 머지 큐와 필수 체크

- Branch protection: 필수 상태 체크(`test`, `lint`), 리뷰 1명, 선형 이력.
- **머지 큐**(GitHub Merge Queue): 여러 PR 을 main 에 순차 적용한 상태로 CI 를 돌려 "각자는 통과했는데 합치면 깨짐" 을 막는다. `on: merge_group` 이벤트를 워크플로에 추가.

```yaml
on:
  pull_request:
  merge_group:
```

## 릴리스 자동화

| 도구 | 방식 |
|---|---|
| **release-please** | Conventional Commits(`feat:`, `fix:`, `feat!:`) 를 읽어 릴리스 PR(버전·CHANGELOG) 생성, 머지 시 태그·GitHub Release |
| **changesets** | 모노레포 패키지별 변경 메모(`.changeset/*.md`) → 버전 올리기·npm 퍼블리시 |
| semantic-release | 커밋 메시지로 완전 자동 (PR 없이) |

```yaml
# release-please
on: { push: { branches: [main] } }
permissions: { contents: write, pull-requests: write }
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        id: rp
        with: { release-type: node }
      # 릴리스가 만들어졌을 때만 이미지 빌드·푸시
      - if: ${{ steps.rp.outputs.release_created }}
        run: echo "tag=${{ steps.rp.outputs.tag_name }}" >> "$GITHUB_OUTPUT"
```
커밋 컨벤션을 PR 제목 린트(`amannn/action-semantic-pull-request`)로 강제하면 체인지로그 품질이 유지된다.

## 컨테이너 릴리스 파이프라인

```
PR: lint · test · build(push 없음) · 취약점 스캔(fail on HIGH)
main: 빌드 → 태그(sha, semver) → 푸시(GHCR) → 스캔 → SBOM 첨부 → cosign 서명 → 매니페스트 저장소에 태그 커밋(GitOps) → ArgoCD 배포
```

```yaml
jobs:
  image:
    permissions: { contents: read, packages: write, id-token: write }    # id-token: cosign keyless
    steps:
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/metadata-action@v5
        id: meta
        with: { images: ghcr.io/${{ github.repository }}, tags: "type=sha,prefix=sha-\ntype=semver,pattern={{version}}" }
      - uses: docker/build-push-action@v6
        id: build
        with: { push: true, tags: ${{ steps.meta.outputs.tags }}, platforms: linux/amd64,linux/arm64, sbom: true, provenance: mode=max, cache-from: type=gha, cache-to: type=gha,mode=max }
      - uses: aquasecurity/trivy-action@0.28.0
        with: { image-ref: ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}, severity: HIGH,CRITICAL, exit-code: "1" }
      - uses: sigstore/cosign-installer@v3
      - run: cosign sign --yes ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}     # keyless (OIDC)
      - name: GitOps 태그 갱신
        run: |
          git clone https://x-access-token:${{ secrets.MANIFESTS_TOKEN }}@github.com/jaejinu/study-manifests
          cd study-manifests/apps/study/overlays/dev && kustomize edit set image study=ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
          git commit -am "deploy: ${{ github.sha }}" && git push
```
**다이제스트**로 배포하면 태그 덮어쓰기와 무관하게 정확히 스캔·서명한 그 이미지가 간다 ([Docker 보안](/docker/notes/10-security-hardening), [GitOps](/kubernetes/notes/13-gitops-progressive-delivery)).

## 보안 스캔 계층

| 종류 | 도구 | 언제 |
|---|---|---|
| SAST (코드) | CodeQL (`github/codeql-action`), Semgrep | PR |
| 의존성 취약점 | Dependabot alerts, `dependency-review-action`(PR 에서 새로 추가된 취약 의존성 차단), `pnpm audit` | PR |
| 시크릿 유출 | GitHub secret scanning + push protection, gitleaks | push |
| 컨테이너 | Trivy, Docker Scout | 빌드 후 |
| IaC | Checkov, tfsec, kube-linter | PR |
| 라이선스 | FOSSA, `license-checker` | 주기 |

```yaml
- uses: actions/dependency-review-action@v4
  with: { fail-on-severity: high, deny-licenses: GPL-3.0 }
```
알림만 쌓이면 무시된다 — PR 을 **막는** 것과 **알리는** 것을 구분하고, 기준(HIGH 이상)을 명시.

## 셀프 호스티드 러너

- 쓰는 이유: 사설 네트워크 접근(사내 DB), 특수 하드웨어(GPU, arm64), 비용(대량), 큰 캐시 유지.
- 위험: 공개 저장소에서 포크 PR 이 러너에서 코드를 실행하면 러너가 털린다 — **공개 저장소엔 쓰지 말 것**. 사설이라도 일회용(ephemeral) 러너 + 컨테이너.
- Kubernetes 에 **ARC**(actions-runner-controller) 로 오토스케일 러너 풀. `runs-on: [self-hosted, linux, arm64]` 레이블.

## CI 자체의 관측

- 워크플로 실행 시간·실패율·큐 대기 시간을 메트릭으로(GitHub API → Prometheus, 또는 `gh run list --json`). 이 사이트의 GitHub Actions 대시보드 카드가 `gh run list` 를 보여주는 작은 예.
- 불안정 테스트(flaky)를 추적해 격리·수정. 재시도로 덮지 않는다.
- 비용: Actions usage 리포트, 가장 비싼 워크플로 Top 5 를 월간 리뷰. macOS 러너·긴 매트릭스가 주범.

## 이 저장소에 적용한다면

1. `concurrency` + `timeout-minutes` 추가 (즉시).
2. `dependency-review-action`, CodeQL 추가 (PR 보호).
3. 릴리스: release-please 로 태그, 태그 시 이미지 푸시 + cosign.
4. 배포: `k8s/` 를 별도 manifests 저장소로 분리하고 ArgoCD 연결.

## 실습 체크리스트

- [ ] ci.yml 에 `merge_group` 트리거와 `dependency-review-action` 추가
- [ ] CodeQL 기본 설정(Settings → Code security) 켜고 첫 스캔 결과 보기
- [ ] release-please 워크플로를 추가하고 `feat:` 커밋 후 릴리스 PR 이 생기는지
- [ ] image 잡을 `push: true` + cosign keyless 로 바꿔 GHCR 에 서명된 이미지 올리기, `cosign verify` 로 검증
