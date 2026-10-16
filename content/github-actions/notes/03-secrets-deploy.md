---
title: 시크릿·권한·배포 — OIDC, 환경, 재사용 워크플로
order: 3
level: 중급
summary: 시크릿과 variables, GITHUB_TOKEN 권한 최소화, OIDC 로 클라우드 인증, environment 승인, 재사용 워크플로와 composite 액션, 보안 체크리스트
tags: [secrets, permissions, OIDC, environment, reusable, 보안]
experiments: []
---

## 시크릿과 변수

```yaml
env:
  API_URL: ${{ vars.API_URL }}            # 평문 설정 (Settings → Variables)
steps:
  - run: ./deploy.sh
    env:
      TOKEN: ${{ secrets.DEPLOY_TOKEN }}  # 암호화 저장, 로그에서 마스킹
```

- 시크릿은 **환경 변수로만** 넘기고 명령줄 인자에 넣지 않는다 (ps 에 노출).
- 포크 PR 에는 시크릿이 없다. `pull_request_target` 로 우회하지 말 것.
- 로그 마스킹은 정확히 같은 문자열만. base64 로 바꾸면 노출된다.

## GITHUB_TOKEN 권한 최소화

```yaml
permissions:            # 워크플로/잡 단위. 기본을 read-only 로 (저장소 설정에서도)
  contents: read
  pull-requests: write  # PR 코멘트를 달 때만
  packages: write       # GHCR 푸시할 때만
  id-token: write       # OIDC 쓸 때만
```

## OIDC: 장기 키 없이 클라우드 인증

러너가 GitHub 의 OIDC 토큰을 받아 AWS/GCP/Azure/Vercel 에 "이 저장소의 main 브랜치 워크플로입니다" 를 증명하고 **단기 자격 증명**을 교환한다. 액세스 키를 시크릿에 보관할 필요가 없다.

```yaml
permissions: { id-token: write, contents: read }
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/github-deploy
      aws-region: ap-northeast-2
```

클라우드 쪽 신뢰 정책에서 `repo:jaejinu/study:ref:refs/heads/main` 처럼 **주체를 좁게** 제한한다.

## Environment 와 승인

```yaml
jobs:
  deploy-prod:
    environment:
      name: production
      url: https://study.example.com
    needs: [test, image]
```

Settings → Environments 에서 production 에 **필수 리뷰어**, 대기 시간, 브랜치 제한, 환경별 시크릿을 둔다. 배포 잡은 승인 전까지 대기한다. 배포 이력이 Deployments 탭에 남는다.

## 컨테이너 이미지 배포 흐름

```yaml
- uses: docker/login-action@v3
  with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
- uses: docker/metadata-action@v5
  id: meta
  with: { images: ghcr.io/${{ github.repository }}, tags: "type=sha,type=ref,event=tag" }
- uses: docker/build-push-action@v6
  with: { push: true, tags: ${{ steps.meta.outputs.tags }}, cache-from: type=gha, cache-to: type=gha,mode=max }
- run: kubectl set image deploy/web web=ghcr.io/${{ github.repository }}:sha-${GITHUB_SHA::7} -n study
```

이 저장소의 image 잡에 `push: true` 와 login 스텝만 더하면 GHCR 에 올라간다. 그 다음은 `kubectl`(OIDC + kubeconfig) 이나 ArgoCD(GitOps: 매니페스트 저장소의 태그만 바꾸는 커밋) 로 배포.

## 재사용 워크플로와 composite 액션

```yaml
# .github/workflows/reusable-test.yml
on:
  workflow_call:
    inputs: { node: { type: string, default: "22" } }
    secrets: { TOKEN: { required: false } }
jobs:
  test: ...
# 호출
jobs:
  call:
    uses: ./.github/workflows/reusable-test.yml
    with: { node: "22" }
    secrets: inherit
```

```yaml
# .github/actions/setup/action.yml  (composite: 스텝 묶음)
runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22, cache: pnpm }
    - run: pnpm install --frozen-lockfile
      shell: bash
```

여러 저장소에서 같은 CI 를 쓸 때 조직 `.github` 저장소에 두고 호출한다.

## 보안 체크리스트

- [ ] 기본 `permissions` read-only, 필요한 잡만 확대
- [ ] 서드파티 액션은 SHA 고정 + Dependabot
- [ ] `pull_request_target` 에서 포크 코드 실행 금지
- [ ] 시크릿은 env 로만, 출력에 echo 금지
- [ ] 클라우드 인증은 OIDC, 장기 키 제거
- [ ] production environment 에 필수 리뷰어
- [ ] `actions/dependency-review-action`, CodeQL 로 공급망·코드 점검

## 더 공부할 것

- GitHub Docs "Security hardening for GitHub Actions"
- `act` — 로컬에서 워크플로 실행 (`brew install act`)
- `gh` CLI: `gh workflow`, `gh run`, `gh api`
- ArgoCD / Flux 로 CD 를 GitOps 로 분리

## 관련 노트

- [Kubernetes 배포 전략과 리소스](/kubernetes/notes/07-deploy-resources) — GitOps 로 이어지는 배포
- [Kubernetes ConfigMap 과 Secret](/kubernetes/notes/05-configmap-secret)
- [Docker 이미지 최적화와 보안](/docker/notes/06-optimization-security)
