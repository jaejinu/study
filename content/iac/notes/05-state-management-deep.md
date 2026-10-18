---
title: 상태 관리 심화 — 원격 백엔드, 잠금, import·moved·state 수술, 환경 분리
order: 5
level: 심화
summary: "state 파일의 구조와 안에 든 것(민감 정보 포함), 로컬 state 가 팀에서 왜 즉시 사고가 되는지, 원격 백엔드(S3+DynamoDB/S3 lockfile·GCS·Azure·HCP·Kubernetes Secret) 와 잠금·버전 관리·암호화·접근 제어, state 수술 도구(import 블록·moved·removed·state mv/rm/pull/push) 와 안전 절차, 워크스페이스 vs 디렉터리 분리로 환경을 나누는 기준, state 분할(계층별) 과 remote_state 데이터 소스, 손상·충돌·드리프트 복구 런북, 실험 iac-state-import"
tags: [state, 백엔드, 잠금, import, moved, removed, workspace, remote_state, 복구]
experiments: [iac-state-import, iac-drift-detect]
---

## state 안에는 무엇이 있나

```json
{
  "version": 4, "terraform_version": "1.8.0", "serial": 17, "lineage": "b1c2…",
  "outputs": { "db_url": { "value": "postgres://app:S3cret@db:5432/app", "sensitive": true } },
  "resources": [{
    "module": "module.redis", "mode": "managed", "type": "docker_container", "name": "web",
    "provider": "provider[\"registry.opentofu.org/kreuzwerker/docker\"]",
    "instances": [{ "schema_version": 2, "attributes": { "id": "72bf…", "name": "web", "env": ["PASSWORD=hunter2"], … },
                    "dependencies": ["docker_image.nginx"] }]
  }]
}
```

- `serial`: 쓰기마다 증가. 백엔드가 "내가 읽은 serial 보다 작으면 거부" 로 **낙관적 잠금**도 한다.
- `lineage`: state 의 혈통 ID. 다른 lineage 의 state 를 push 하면 거부(실수로 다른 환경 덮어쓰기 방지).
- **attributes 는 프로바이더가 돌려준 전부** — 비밀번호, 개인키(`tls_private_key`), 토큰. `sensitive = true` 는 **출력 가리기**일 뿐 state 는 평문. 그래서 state 접근 = 모든 비밀 접근.
- `dependencies`: 삭제 순서용. 코드를 지워도 state 의 의존성으로 역순 삭제.

실험 `iac-plan-apply-docker` 가 `state show` 로 보여 준 수십 줄이 이것이다.

## 로컬 state 가 팀에서 사고가 되는 순서

1. A 가 apply → `terraform.tfstate` 가 A 노트북에.
2. B 가 같은 코드로 apply → B 에겐 state 가 없으니 **전부 새로 만든다** → 이름 충돌 또는 중복 리소스.
3. 둘이 state 를 git 에 커밋하기로 → 충돌 병합 불가(JSON serial) + 비밀이 git 에.
4. 동시에 apply → 한쪽 변경이 사라짐.

원격 백엔드 + 잠금은 "팀" 이 아니라 **CI 가 있는 순간**부터 필수다(CI 러너는 state 를 어디서 읽나?).

## 원격 백엔드

```hcl
terraform {
  backend "s3" {
    bucket         = "study-tfstate"
    key            = "envs/prod/terraform.tfstate"   # state 하나당 하나의 key
    region         = "ap-northeast-2"
    encrypt        = true                            # SSE (KMS 키 지정 가능)
    use_lockfile   = true                            # 1.10+/OpenTofu 1.8+: S3 조건부 쓰기로 잠금 (DynamoDB 불필요)
    # dynamodb_table = "tfstate-lock"               # 구식 잠금
  }
}
```

| 백엔드 | 잠금 | 버전 관리 | 비고 |
|---|---|---|---|
| **s3** | lockfile(조건부 PUT) 또는 DynamoDB | 버킷 버저닝 켜기 | 가장 흔함. 버킷 정책으로 최소 권한, 퍼블릭 차단, 객체 잠금(랜섬) |
| **gcs** | 내장 | 객체 버저닝 | |
| **azurerm** | blob lease | 스냅샷 | |
| **http** | 선택 | 서버 구현 | GitLab 관리 state |
| **remote / cloud** (HCP Terraform) | 내장 | 내장 + UI + RBAC + 원격 실행 | 팀 기능(정책·승인) |
| **kubernetes** (Secret) | Lease | 없음 | k8s 안에서만 — 1MB 제한, 비밀이 Secret 에 |
| **pg** | advisory lock | 없음 | 셀프호스팅 간단 |
| OpenTofu **state 암호화** | — | — | 1.7+: 백엔드와 무관하게 state 자체를 클라이언트 측 암호화(AES-GCM + KMS/PBKDF2). 백엔드 접근만으로는 못 읽는다 |

### 백엔드 보안 체크
- state 버킷은 **별도 계정/프로젝트**에, 읽기는 CI 역할과 소수 관리자만. `prod` state 읽기 권한 = prod 비밀 전부.
- 버저닝 + MFA delete/객체 잠금 → 삭제·랜섬 대비.
- 접근 로그(S3 access log, CloudTrail) → "누가 state 를 읽었나" 감사 — [보안 04](/security/notes/04-secrets-management).
- `backend` 블록에는 변수를 못 쓴다 → `-backend-config=prod.hcl` 로 환경별 분리(또는 `cloud` 블록의 workspace).
- 백엔드 **마이그레이션**: 블록을 바꾸고 `tofu init -migrate-state` → 복사 후 확인 → 옛것 삭제. 반드시 백업 먼저.

## 환경 분리 — 워크스페이스 vs 디렉터리

| | 워크스페이스 (`tofu workspace new prod`) | 디렉터리 분리 (`envs/dev`, `envs/prod`) |
|---|---|---|
| state | 같은 백엔드, `env:/prod/…` 키 | 별도 key/버킷 가능 |
| 코드 | **같은 코드**, `terraform.workspace` 로 분기 | 같은 모듈을 다른 변수로 호출 |
| 권한 분리 | 어렵다(같은 백엔드 설정) | 쉽다(prod 디렉터리만 prod 역할) |
| 실수 위험 | "지금 어느 워크스페이스지?" → prod 에 dev 적용 | 디렉터리가 명시적 |
| 드리프트(환경 간 코드 차이) | 적음 | 모듈 버전이 달라질 수 있음(의도적일 수도) |
| 적합 | 동일 구조의 **임시/프리뷰** 환경(브랜치별) | **dev/stage/prod** 같은 영구 환경 |

대세는 **디렉터리 분리 + 공유 모듈**이다. 환경별 루트는 10~30줄(모듈 호출 + 변수)이어야 한다. Terragrunt 는 이 반복(backend·provider 블록)을 DRY 하게 생성해 주는 래퍼.

## state 분할 — 블라스트 반경과 plan 시간

하나의 state 에 네트워크·클러스터·DB·앱이 다 있으면: plan 에 5분, 앱 태그 하나 바꾸는 PR 이 DB 교체 위험을 안고, 권한은 전부에게 전부. **계층별로 나눈다**:

```
envs/prod/
  10-network/     (VPC, 서브넷)            변경 빈도 낮음, 권한 최소
  20-cluster/     (kind/EKS, 노드)         ↓
  30-data/        (RDS, Redis, Kafka)      prevent_destroy
  40-platform/    (모니터링, ArgoCD, cert-manager)
  50-apps/        (앱 — 또는 여기서부터 ArgoCD 로 넘김)
```

계층 간 연결:
```hcl
# 40-platform 에서 20-cluster 의 출력 읽기
data "terraform_remote_state" "cluster" {
  backend = "s3"
  config  = { bucket = "study-tfstate", key = "envs/prod/20-cluster.tfstate", region = "…" }
}
provider "kubernetes" { config_path = data.terraform_remote_state.cluster.outputs.kubeconfig }
```
`remote_state` 는 **상대 state 전체 읽기 권한**이 필요하다(비밀 포함). 가능하면 **데이터 소스로 실제 리소스를 조회**(`data "aws_vpc" { tags = { env = "prod" } }`) 하거나, 출력을 SSM/ConfigMap 에 써서 공유하는 편이 결합이 약하다.

## state 수술 — 도구와 절차

| 작업 | 선언형(권장) | 명령형 |
|---|---|---|
| 기존 리소스 편입 | `import { to = x.y, id = "…" }` + `-generate-config-out` | `tofu import x.y <id>` |
| 주소 변경(리팩터링) | `moved { from = a.b, to = module.m.a.b }` | `tofu state mv a.b module.m.a.b` |
| 관리 제외(실체는 유지) | `removed { from = a.b, lifecycle { destroy = false } }` | `tofu state rm a.b` |
| 강제 교체 | `tofu apply -replace=a.b` | (`taint` 는 폐기) |
| 실제에 맞춰 state 만 갱신 | `tofu apply -refresh-only` | |
| 백업/복원 | `tofu state pull > backup.json` / `state push` | |

**선언형이 나은 이유**: PR 에 보이고, plan 에 "moved/imported" 로 미리 보이고, CI 가 그대로 적용한다. `state mv` 는 한 사람 터미널에서 조용히 일어난다.

### 안전 절차 (수술 전 체크리스트)
1. `tofu state pull > state-$(date +%s).json` 백업. 백엔드 버저닝 확인.
2. 잠금 확인: 다른 apply 가 돌지 않는지(CI 일시 중지).
3. 변경 후 **plan 이 No changes(또는 의도한 것만)** 인지. 실험 `iac-state-import` 가 import 후 `plan -detailed-exitcode` 가 0 인지 확인하는 이유.
4. 잘못됐으면 `tofu state push backup.json`(serial/lineage 확인, `-force` 는 최후).

### import 의 현실
- `-generate-config-out` 초안은 **모든 속성**(빈 문자열·기본값·계산값)을 뱉어 그대로는 validate 에 실패하기 일쑤 — 실험에서 `cpu_set = ""` 로 실패하는 것을 본다. 필요한 속성만 남기고 다듬는다.
- 속성을 빠뜨리면 plan 이 **교체**를 제안할 수 있다(`env = (known after apply) # forces replacement`). import 후 plan 을 읽지 않고 apply 하면 "편입하려던 리소스를 지우고 새로 만드는" 사고.
- 대량 import 는 스크립트로 `import` 블록을 생성(`for_each` 지원: `import { for_each = var.ids  to = x.y[each.key]  id = each.value }`).
- 도구: `terraformer`(클라우드 전체를 코드+state 로), `aws2tf`.

## 복구 런북

| 상황 | 증상 | 조치 |
|---|---|---|
| 잠금이 안 풀림 | `Error acquiring the state lock` (CI 가 죽음) | 정말 아무도 안 도는지 확인 → `tofu force-unlock <ID>` |
| state 와 실제 불일치(드리프트) | plan 에 예상 밖 변경 | [06 노트](/iac/notes/06-drift-policy-testing): refresh-only 로 수용 또는 apply 로 복구 |
| 리소스가 밖에서 삭제됨 | plan `+ (1 to add)` | 재생성 의도면 apply, 아니면 `removed`/`state rm` |
| state 손상/덮어씀 | `lineage mismatch`, 리소스가 사라짐 | 버킷 버전에서 이전 state 복원 → `state push` |
| apply 중 실패(절반 적용) | "Error: … (partial)" + state 는 성공분 반영 | 원인 수정 → 다시 plan/apply(멱등). 생성됐는데 state 에 없으면 import |
| 다른 환경에 apply 해 버림 | prod 에 dev 변수 | 즉시 중단, state 백업, 변경분을 역으로 apply 또는 버전 복원. 사후: 디렉터리 분리·권한·`precondition` |
| state 에 비밀이 유출 | 버킷 공개 등 | 비밀 전부 회전(state 의 모든 sensitive 값) — [보안 04](/security/notes/04-secrets-management) |

## 예시로 보기 — 이 프로젝트에서

- 실험은 임시 디렉터리의 **로컬 state** 를 쓰고 끝나면 지운다. 실험 `iac-state-import` 의 단계를 그대로 따라가면 import·generate·state rm 을 한 번씩 손에 익힌다.
- [07 노트](/iac/notes/07-provider-kubernetes-docker) 에서 kind 클러스터를 코드화할 때, state 를 `infra/.state/`(gitignore) 에 두고 "팀이면 어디에 둘지" 를 결정 항목으로 남긴다. 로컬 대안: Docker 로 MinIO 를 띄워 `s3` 백엔드(`endpoints`, `skip_credentials_validation`) 를 흉내 내면 잠금·버저닝을 실제로 본다.
- OpenTofu 라면 `encryption` 블록으로 state 암호화를 켜 보자 — 백엔드가 MinIO 라도 평문이 안 보인다.

```hcl
terraform {
  encryption {
    key_provider "pbkdf2" "pw" { passphrase = var.state_passphrase }   # 실전은 KMS
    method "aes_gcm" "m" { keys = key_provider.pbkdf2.pw }
    state { method = method.aes_gcm.m }
    plan  { method = method.aes_gcm.m }
  }
}
```

> 함께 읽기: [Terraform/OpenTofu 핵심 모델 — HCL, 프로바이더, 리소스 그래프, plan/apply, state](/iac/notes/02-terraform-core-model)

## 실전에서는 어디에 쓰이나

> 두 번째 사람이나 CI 가 apply 하는 순간부터 state 를 어디에 두고, 어떻게 잠그고, 누가 읽을 수 있는지가 사고를 가른다. 콘솔로 만든 기존 리소스를 코드로 편입할 때도 이 노트의 도구가 쓰인다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| CI 로 apply 하는 팀 | 동시 apply 와 덮어쓰기 방지 | 원격 백엔드(S3·GCS) + 잠금 + 버저닝 | HCP Terraform 같은 관리형 실행 |
| 핀테크·공공 보안 감사 | state 안의 비밀 보호 | 별도 계정의 state 버킷, 최소 권한, 접근 로그, OpenTofu state 암호화 | 비밀이 state 에 들어가지 않는 설계 |
| 콘솔로 만든 레거시 인프라 | 지우지 않고 코드로 편입 | `import` 블록 + 생성된 초안 다듬기, plan No changes 확인 | 새로 만들고 이전(다운타임) |
| 거대한 단일 state 분해 | plan 시간과 블라스트 반경 축소 | 네트워크·클러스터·DB·앱 계층별 state, `moved`·`removed` | Terragrunt 로 계층 순서 관리 |
| SaaS 브랜치별 프리뷰 환경 | 같은 구조를 임시로 여러 벌 | 워크스페이스로 state 분리, 머지 후 destroy | 영구 환경은 디렉터리 분리 |

**이럴 땐 안 맞는다**
- dev·stage·prod 같은 영구 환경을 워크스페이스로 → "지금 어느 워크스페이스지?" 실수와 권한 분리 문제가 생긴다. 디렉터리로 나눈다.
- 계층 간 값 공유에 `remote_state` 남발 → 상대 state 전체(비밀 포함) 읽기 권한이 필요하다. 태그 기반 데이터 소스나 SSM·ConfigMap 출력으로.

**누가 매일 만나나** — 플랫폼 엔지니어가 "state lock" 에러로 멈춘 CI 를 확인하고 `force-unlock` 여부를 판단할 때, 운영자가 콘솔 리소스를 import 해 코드로 가져올 때.

**면접·실무 단골 질문**
- Q. state 를 git 에 커밋하면 안 되는 이유는? → 비밀이 평문으로 남고, 병합이 불가능하며, 잠금이 없다.
- Q. import 직후 반드시 할 일은? → plan 이 No changes 인지 확인한다. 속성이 빠지면 교체가 제안돼 편입하려던 리소스를 지울 수 있다.

## 실습 체크리스트

- [ ] 실험 `iac-state-import` 를 돌리고 "generate 초안이 왜 실패했나", "속성을 빼면 왜 교체인가", "state rm 뒤 컨테이너는 왜 살아 있나" 세 질문에 답하기
- [ ] `tofu state pull | jq '.resources[].instances[].attributes | keys'` 로 저장 속성 확인
- [ ] MinIO 컨테이너로 s3 백엔드를 구성해 `init -migrate-state`, 두 터미널에서 동시에 apply 해 잠금 에러 보기
- [ ] 리소스를 모듈로 옮기며 `moved` 블록 → plan 에 "moved" 만 보이는지
- [ ] `removed` 블록(또는 `state rm`)으로 관리에서 빼고 `docker ps` 로 실체 확인, 다시 import
- [ ] 일부러 state 를 백업한 뒤 손상시키고(`serial` 수정) push 가 거부되는지, 백업으로 복원
- [ ] (OpenTofu) state 암호화를 켜고 백엔드의 파일이 평문이 아닌지 확인
