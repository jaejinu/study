---
title: 시크릿 관리 — 환경 변수의 한계, Vault·SOPS·External Secrets, 회전과 유출 대응
order: 4
level: 중급
summary: "시크릿이 새는 경로(git·이미지·로그·프로세스 목록·CI 출력), 환경 변수 방식의 장단점과 12-factor 의 함정, SOPS 로 암호화해 git 에 두기, Vault 의 동적 시크릿·리스·감사, Kubernetes Secret 의 실체와 External Secrets Operator·CSI 드라이버·Sealed Secrets 비교, 워크로드 신원으로 비밀 자체를 없애기, 회전 설계, gitleaks 로 유출 탐지와 사고 대응 절차"
tags: [시크릿, 환경 변수, Vault, SOPS, External Secrets, Sealed Secrets, 회전, gitleaks, 워크로드 신원]
experiments: [sec-k8s-rbac]
---

## 시크릿은 어디로 새나

시크릿(API 키, DB 비밀번호, 개인키, 토큰)은 **존재하는 곳마다 유출 경로**다. 흔한 순서대로:

| 경로 | 어떻게 | 실제 예 |
|---|---|---|
| **git 커밋** | `.env` 를 실수로, 테스트 코드에 하드코딩, 지웠지만 히스토리에 남음 | GitHub 에서 매일 수천 개의 키가 공개됨. 봇이 **분 단위**로 긁어 클라우드 계정을 채굴에 씀 |
| **컨테이너 이미지** | `COPY . .` 에 `.env` 포함, 빌드 인자 `ARG TOKEN` 이 히스토리에 | `docker history` 로 읽힘 |
| **로그** | 요청 본문·헤더·환경 통째로 로깅, 에러에 연결 문자열 | Loki 에 `postgres://study:study@` 가 검색됨 |
| **프로세스/환경** | `ps auxe`, `/proc/<pid>/environ`, 자식 프로세스에 상속, 크래시 덤프 | 같은 호스트의 다른 컨테이너·디버그 툴 |
| **CI 출력** | `echo $SECRET`, 디버그 모드, 포크 PR 에서 시크릿 접근 | GitHub Actions 는 마스킹하지만 base64 하면 보임 |
| **클라이언트** | `NEXT_PUBLIC_` 접두어로 브라우저 번들에 | 프론트에 쓴 키는 공개 키다 |
| **채팅·티켓·위키** | "임시로 공유" | 영원히 남음 |
| **백업·스냅샷** | state 파일, DB 덤프, 디스크 스냅샷 | Terraform state 에 평문 비밀번호 |

**원칙 1**: 시크릿을 가진 곳의 수를 줄인다. **원칙 2**: 가져야 한다면 짧게 살게 한다(회전·만료). **원칙 3**: 아예 필요 없게 만든다(워크로드 신원).

## 환경 변수 — 좋은 출발, 나쁜 종착

12-factor 는 "설정은 환경에" 라고 했고 `.env` + `process.env` 는 가장 쉬운 방법이다. 하지만:

- 프로세스 환경은 **자식에게 상속**되고 `/proc` 로 읽힌다. 셸 실험이 `docker`·`kubectl` 을 실행하는 이 앱은 그 자식들에게 `ANTHROPIC_API_KEY` 를 그대로 넘긴다(필요 없는데도).
- 크래시 리포터·APM 이 환경을 통째로 수집하기도 한다(Sentry 는 기본 마스킹하지만).
- `.env` 는 결국 디스크의 평문 파일. 노트북 분실·백업·동기화 폴더.
- 회전하려면 재시작 필요, 누가 언제 읽었는지 **감사 불가**.

그래서 환경 변수는 "**주입의 마지막 단계**" 로만 쓰고, 원천은 시크릿 매니저에 둔다. 더 좋은 것은 **파일 마운트**(tmpfs, 0400) — 상속되지 않고, 회전 시 파일만 갱신하면 앱이 다시 읽을 수 있다.

```ts
// 앱 쪽 최소 위생
const key = process.env.ANTHROPIC_API_KEY;
// 로그에 찍지 않기 — logger 에 redact 목록
logger.info("llm.call", { model, keyPrefix: key?.slice(0, 7) + "…" });  // 식별용 접두어만
// 자식 프로세스에 필요한 것만
execFile("kubectl", args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, KUBECONFIG: process.env.KUBECONFIG } });
```

## 선택지 지도

| 방식 | 어디에 저장 | 어떻게 전달 | 회전 | 감사 | 적합 |
|---|---|---|---|---|---|
| `.env` / 환경 변수 | 디스크 평문 | 프로세스 환경 | 수동 | 없음 | 로컬 개발 |
| **SOPS** (+age/KMS) | **git 에 암호화해서** | 배포 시 복호화 → env/파일 | 수동(재암호화) | git 히스토리 | 작은 팀, GitOps |
| **Sealed Secrets** | git 에 암호화(클러스터 공개키) | 컨트롤러가 k8s Secret 으로 | 수동 | git | k8s + GitOps, 단순 |
| **External Secrets Operator** | 외부 매니저(AWS SM, Vault, GCP…) | ESO 가 동기화해 k8s Secret 생성 | 매니저가 회전, ESO 가 갱신 | 매니저 | k8s + 클라우드 |
| **Secrets Store CSI** | 외부 매니저 | Pod 에 **파일로 마운트**(Secret 객체 없이도) | 자동 갱신 | 매니저 | etcd 에 안 남기고 싶을 때 |
| **Vault** | Vault | API/Agent 사이드카/CSI | **동적 시크릿**(리스) | 상세 | 모든 규모, 동적 DB 자격 증명 |
| 클라우드 매니저 (AWS Secrets Manager, GCP Secret Manager) | 클라우드 | SDK/IAM | 자동 회전(Lambda) | CloudTrail | 클라우드 네이티브 |
| **워크로드 신원** | 비밀 없음 | 플랫폼이 짧은 토큰 발급 | 자동 | 플랫폼 | **최우선** |

## SOPS — 암호화된 파일을 git 에

```bash
age-keygen -o key.txt                       # 공개키 age1..., 개인키는 key.txt
# .sops.yaml
creation_rules:
  - path_regex: \.enc\.yaml$
    age: age1abc...                         # 여러 수신자(팀원·CI) 나열 가능, KMS 도
sops -e secrets.yaml > secrets.enc.yaml     # 값만 암호화, 키는 평문 → diff 가 읽힘
sops -d secrets.enc.yaml                    # SOPS_AGE_KEY_FILE=key.txt
sops secrets.enc.yaml                       # 에디터로 바로 편집
```

- **값만** 암호화되므로 `git diff` 에서 어떤 키가 바뀌었는지 보인다. 리뷰 가능.
- 복호화 키(age 개인키 또는 KMS 권한)만 지키면 저장소가 공개돼도 안전 — 하지만 **그 키가 새면 전체 히스토리가 열린다**. 키 교체 시 `sops rotate` 로 재암호화.
- Flux 는 SOPS 를 기본 지원, ArgoCD 는 플러그인(ksops) — [GitOps](/kubernetes/notes/13-gitops-progressive-delivery) 와 궁합.
- Helm values, Terraform(`sops` 프로바이더), `.env`(`sops --output-type dotenv`) 모두 가능.

## Vault — 동적 시크릿과 리스

Vault 의 핵심 아이디어: **정적 비밀번호를 나눠 주지 말고, 요청할 때마다 짧게 사는 자격 증명을 만들어 준다**.

```bash
# PostgreSQL 동적 자격 증명
vault secrets enable database
vault write database/config/study plugin_name=postgresql-database-plugin \
  connection_url="postgresql://{{username}}:{{password}}@postgres:5432/study" \
  allowed_roles=app username=vault password=...
vault write database/roles/app db_name=study default_ttl=1h max_ttl=24h \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";"
vault read database/creds/app     # → 새 사용자 v-app-x7k2, 비밀번호, lease 1h
```

- 앱 인스턴스마다 **다른 사용자**가 생기고 1시간 뒤 **자동 폐기**. 유출돼도 창이 짧고, `pg_stat_activity` 에서 어느 인스턴스인지 보인다.
- 인증은 **k8s auth**(Pod 의 SA 토큰을 Vault 가 TokenReview 로 검증) — 앱은 Vault 토큰조차 배포받지 않는다. Vault Agent Injector 가 사이드카로 시크릿을 파일에 써 주고 갱신.
- **Transit** 엔진: 앱이 키를 갖지 않고 Vault 에 암·복호화를 위임(봉투 암호화). **PKI** 엔진: 내부 CA 로 짧은 인증서 발급 — [02 노트](/security/notes/02-tls-certificates).
- 모든 접근이 **감사 로그**에 남는다(`vault audit enable file`). "누가 언제 어떤 시크릿을 읽었나" 가 보안 사고 대응의 출발점.
- 운영 부담이 크다(언실, HA, 백업). 작은 팀은 클라우드 매니저 + ESO 가 현실적.

## Kubernetes Secret 의 실체

- `Secret` 은 **base64 인코딩**일 뿐 암호화가 아니다. `kubectl get secret -o yaml | base64 -d` 로 누구나 읽는다(RBAC 가 허용하면).
- etcd 에 평문 저장 → **etcd 저장 암호화**(`EncryptionConfiguration`, KMS 프로바이더) 를 켜야 한다. 관리형(EKS/GKE)은 기본 또는 옵션.
- RBAC: `secrets` 의 `get/list/watch` 는 가장 신중히. `list` 가 되면 네임스페이스의 모든 시크릿을 읽는다 — [실험 sec-k8s-rbac](/security/lab) 가 `secrets list → no` 를 확인하는 이유.
- 전달: **환경 변수보다 볼륨 마운트**(tmpfs, 갱신 반영, 상속 없음). `automountServiceAccountToken: false` 로 불필요한 SA 토큰 마운트 끄기.
- git 에 평문 Secret 매니페스트를 넣는 순간 GitOps 가 유출 파이프라인이 된다 → Sealed Secrets/SOPS/ESO 중 하나는 필수.

```yaml
# External Secrets Operator: 외부 매니저 → k8s Secret
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: { name: app-secrets, namespace: study }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-sm, kind: ClusterSecretStore }
  target: { name: app-secrets }
  data:
    - secretKey: ANTHROPIC_API_KEY
      remoteRef: { key: prod/study/anthropic, property: api_key }
```
git 에는 **참조**만 있고 값은 없다. 매니저에서 회전하면 1시간 안에 Secret 이 갱신된다(Pod 재시작은 Reloader 같은 도구로).

## 비밀 자체를 없애기 — 워크로드 신원

가장 안전한 시크릿은 **없는 시크릿**이다.

| 플랫폼 | 메커니즘 | 효과 |
|---|---|---|
| AWS | IAM 역할(인스턴스 프로파일, IRSA/Pod Identity) | 액세스 키 없이 SDK 가 임시 자격 증명 자동 획득 |
| GCP | 서비스 계정 + Workload Identity | 키 파일 없음 |
| Kubernetes | projected SA 토큰(`audience`, 1h, 자동 회전) | 외부 시스템(Vault, 클라우드)이 TokenReview/OIDC 로 검증 |
| GitHub Actions | **OIDC 토큰** → 클라우드 역할 assume | 장기 클라우드 키를 GitHub Secrets 에 안 둠 — [GHA 노트](/github-actions/notes/03-secrets-deploy) |
| 서비스 메시 | SPIFFE SVID(mTLS 인증서) | 서비스 간 공유 키 제거 |

남는 것은 **외부 SaaS 키**(Anthropic, Stripe)처럼 플랫폼 신원을 모르는 상대뿐. 그것들은 매니저에 두고 짧게 회전.

## 회전 설계

- **무중단 회전 = 두 개가 동시에 유효한 창**: 새 키 발급 → 소비자가 새 키로 전환 → 옛 키 폐기. DB 비밀번호는 사용자 두 개(blue/green) 를 번갈아, API 키는 "두 키 동시 활성" 기능을 쓴다.
- **주기**: 정적 자격 증명 90일 이하, 유출 의심 시 즉시. 동적 시크릿은 시간 단위.
- **앱은 재읽기 가능하게**: 파일 마운트를 감시하거나(`fs.watch`), 연결 실패 시 시크릿을 다시 읽고 재연결. ioredis·pg 풀은 새 연결 시점에 자격 증명을 읽도록 팩토리 함수로.
- **회전을 연습**: 분기마다 실제로 돌려 본다. 한 번도 안 해 본 회전은 사고 때 못 한다 — [카오스 원칙](/chaos/notes/01-chaos-principles) 과 같은 논리.

## 유출 탐지와 대응

### 탐지
```bash
brew install gitleaks
gitleaks detect --source . --verbose          # 히스토리 전체 스캔
gitleaks protect --staged                     # pre-commit 훅: 커밋 전에 막기
# CI: gitleaks/gitleaks-action — PR 마다
# GitHub: Secret scanning + Push protection (공개 저장소 무료) — 알려진 키 형식을 푸시 시 차단
```
- 이 저장소는 **공개**다. `gitleaks detect` 를 한 번 돌려 보자. `.env` 가 `.gitignore` 에 있어도 **히스토리**에 한 번이라도 들어갔으면 남아 있다.
- 이미지도: `trivy image --scanners secret study:dev` 가 레이어 안의 키를 찾는다 — [05 노트](/security/notes/05-container-supply-chain).
- 로그도: Loki 에서 `{service="study-app"} |~ "sk-ant-|postgres://.*:.*@|AKIA[0-9A-Z]{16}"` 를 주기적으로 질의해 0 이어야 한다. 알림 규칙으로.

### 대응 절차 (유출은 "언제" 의 문제)
1. **즉시 폐기·회전** — 지우는 것보다 먼저. 봇은 이미 긁어 갔다고 가정.
2. **영향 범위**: 그 키로 무엇을 할 수 있었나(권한), 감사 로그에서 실제 사용 흔적(Anthropic 콘솔 사용량, CloudTrail, Vault audit).
3. **히스토리 정리**: `git filter-repo` 로 제거 + 강제 푸시 + 포크·클론 통지. 그래도 "유출됐음" 은 변하지 않는다.
4. **재발 방지**: pre-commit 훅, Push protection, 코드 리뷰 체크리스트, 키를 애초에 안 쓰는 구조(워크로드 신원).
5. **기록**: 포스트모템 — [장애 카탈로그](/chaos/notes/02-failure-catalog) 형식으로.

## 예시로 보기 — 이 프로젝트에서

| 시크릿 | 지금 | 개선 |
|---|---|---|
| `ANTHROPIC_API_KEY` | `.env.local`, 환경 변수 | 로컬: 그대로. 공유/운영: 매니저 + 파일 마운트, 사용량 알림(`llm_cost_usd` 메트릭이 이미 있다 — 일 예산 초과 → critical) |
| PostgreSQL `study/study` | compose 평문 | 학습용 수용. k8s 배포면 ESO/Sealed Secret, 가능하면 Vault 동적 자격 증명 |
| Grafana admin (`admin/study`) | compose/k8s 평문 | 익명 Admin 은 로컬 전용. 공유 시 OIDC 로그인 |
| ArgoCD admin 비밀번호 | 초기 Secret | 로그인 후 즉시 변경·삭제, SSO 연동 |
| kubeconfig | `~/.kube/config` | 클러스터 admin 자격 증명 — 노트북 디스크 암호화, 짧은 토큰(OIDC) |
| Terraform state (IaC 노트) | 로컬 파일 | 원격 백엔드 + 암호화 + 최소 권한 — [IaC 노트 05](/iac/notes/05-state-management-deep) |

셸 실험이 자식 프로세스에 환경을 통째로 넘기는 것(`env: process.env`)은 개선 후보다: 실험 러너에 필요한 변수만 허용 목록으로 넘기면 LLM 키가 `docker`/`kubectl` 프로세스에 보이지 않는다.

## 실습 체크리스트

- [ ] `gitleaks detect` 를 이 저장소에 돌리고 결과 확인(히스토리 포함)
- [ ] `trivy image --scanners secret study:dev` 로 이미지 안 시크릿 검사
- [ ] age 키를 만들고 `secrets.enc.yaml` 을 SOPS 로 암호화해 diff 가 어떻게 보이는지 확인
- [ ] kind 에 Sealed Secrets 또는 ESO(+ 로컬 Vault dev 모드)를 설치하고 Secret 이 생성되는 것 보기
- [ ] `vault server -dev` 로 PostgreSQL 동적 자격 증명을 발급받아 `pg_stat_activity` 에서 사용자 이름 확인, 1분 TTL 로 폐기 관찰
- [ ] 이 앱의 logger 에 redact 규칙을 넣고 Loki 에서 시크릿 패턴 질의가 0 건인지 확인
