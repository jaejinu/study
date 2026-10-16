---
title: "Terraform/OpenTofu 핵심 모델 — HCL, 프로바이더, 리소스 그래프, plan/apply, state"
order: 2
level: 기초
summary: "HCL 문법(블록·인자·표현식), 프로바이더가 API 를 리소스로 번역하는 방식과 lock 파일, 리소스·데이터 소스·의존성 그래프와 병렬 적용, init→validate→plan→apply→destroy 워크플로와 plan 기호(+ ~ -/+ -) 읽는 법, state 가 왜 필요한지와 refresh, 생명주기(create_before_destroy·prevent_destroy·ignore_changes), 흔한 첫 실수"
tags: [HCL, 프로바이더, 리소스 그래프, plan, apply, state, lifecycle, lock 파일]
experiments: [iac-plan-apply-docker, iac-state-import]
---

## 한 장의 그림

![세 가지 상태와 plan/apply 루프](/diagrams/iac-plan-apply-state.svg)

```
   .tf 파일(HCL)            state(terraform.tfstate)          실제 인프라
   "바라는 상태"              "마지막으로 안 상태"               "현재 상태"
        │                          │                              │
        │        ┌─── refresh ─────┼──── 프로바이더 API (read) ───┘
        ▼        ▼
      [ plan ] = diff(바라는 상태, 갱신된 state) → + 생성 / ~ 수정 / -/+ 교체 / - 삭제
        │
      [ apply ] → 프로바이더 API (create/update/delete) → state 갱신
```

세 가지 상태를 항상 구분하라. 대부분의 혼란("왜 바꿨는데 변화 없음이지?", "왜 지우려 하지?")은 셋 중 어느 것이 달라졌는지 모를 때 생긴다.

## HCL — 블록, 인자, 표현식

```hcl
# 블록: <타입> "<라벨>" ... { 본문 }
terraform {
  required_version = ">= 1.6"
  required_providers {
    docker = { source = "kreuzwerker/docker", version = "~> 3.0" }   # ~> 3.0 = >=3.0,<4.0
  }
  backend "s3" { ... }           # state 저장 위치 (05 노트)
}

provider "docker" {              # 프로바이더 설정 (인증·엔드포인트)
  host = "unix:///var/run/docker.sock"
}

resource "docker_image" "nginx" {        # 리소스: <프로바이더>_<타입> "<이름>"  → 주소 docker_image.nginx
  name         = "nginx:1.27-alpine"     # 인자 = 표현식
  keep_locally = true
}

resource "docker_container" "web" {
  name  = "web"
  image = docker_image.nginx.image_id    # 다른 리소스의 속성 참조 → 암묵적 의존성
  ports {                                # 중첩 블록 (반복 가능)
    internal = 80
    external = 18089
  }
  env = ["ENV=${var.env}", "TS=${timestamp()}"]   # 보간, 함수
}

data "docker_network" "bridge" {         # 데이터 소스: 읽기 전용 조회
  name = "bridge"
}

output "ip" { value = docker_container.web.network_data[0].ip_address }
```

- **인자**(argument) `key = value` vs **블록**(block) `key { ... }`. 중첩 블록은 리스트처럼 반복된다.
- **표현식**: 리터럴, 참조(`var.x`, `local.y`, `docker_image.nginx.id`, `data.x.y`, `module.m.out`), 함수(`length`, `lookup`, `templatefile`, `jsonencode`…), 조건 `a ? b : c`, `for` 식, 스플랫 `aws_instance.web[*].id`. 상세는 [03 노트](/iac/notes/03-variables-expressions).
- 파일 분할은 자유: 같은 디렉터리의 `.tf` 전부가 하나의 **모듈**(루트 모듈)로 합쳐진다. `main.tf / variables.tf / outputs.tf / versions.tf` 가 관례.
- `terraform fmt` 로 정렬, `validate` 로 문법·타입 검사(API 호출 없음).

## 프로바이더 — API 를 리소스로

프로바이더는 **플러그인 바이너리**다. `init` 이 레지스트리(registry.terraform.io / opentofu.org)에서 받아 `.terraform/providers/` 에 둔다. 각 프로바이더는 리소스 타입마다 CRUD 를 구현한다: `docker_container` 의 Create 는 `POST /containers/create` + start, Read 는 `inspect`, Update 는 일부 속성(라벨·restart 정책…)만 가능하고 나머지는 **ForceNew**(교체).

```
.terraform.lock.hcl      ← 프로바이더 버전 + 바이너리 해시 (git 에 커밋!)
provider "registry.opentofu.org/kreuzwerker/docker" {
  version     = "3.0.2"
  constraints = "~> 3.0"
  hashes      = ["h1:...", "zh:..."]
}
```

- lock 파일은 npm 의 lockfile 과 같다: 팀·CI 가 **같은 프로바이더 바이너리**를 쓰게 하고 공급망 변조를 막는다. `init -upgrade` 로만 올린다.
- 프로바이더 설정(host, 리전, 자격 증명)은 환경 변수로 받는 것이 관례(`AWS_PROFILE`, `DOCKER_HOST`, `KUBECONFIG`). 코드에 비밀을 쓰지 않는다.
- 같은 프로바이더를 여러 설정으로: `provider "aws" { alias = "eu" region = "eu-west-1" }` → `provider = aws.eu`.
- 프로바이더 종류: 클라우드(aws, google, azurerm), 플랫폼(kubernetes, helm, docker, kind), SaaS(github, datadog, grafana, cloudflare), 유틸리티(random, tls, local, null/terraform_data, time, http).

## 리소스 그래프와 병렬 적용

Terraform 은 참조를 분석해 **DAG** 를 만든다. `docker_container.web` 이 `docker_image.nginx.image_id` 를 참조하면 이미지가 먼저. 의존이 없는 리소스는 **병렬**(기본 10개)로 만든다.

```bash
tofu graph | dot -Tsvg > graph.svg     # 그래프 시각화
depends_on = [aws_iam_role_policy.x]   # 참조로 표현 안 되는 숨은 의존성 (IAM 전파 등). 남용 금지
```

삭제는 역순. 교체(-/+)는 기본 **destroy → create** 라 다운타임이 생긴다 → `create_before_destroy`.

## 워크플로

```bash
tofu init                  # 백엔드 초기화 + 프로바이더/모듈 다운로드. 설정 바뀌면 다시
tofu fmt -check && tofu validate
tofu plan -out=tfplan      # 변경 계획 (파일로 저장 → apply 가 정확히 그 계획만 적용)
tofu apply tfplan          # 또는 tofu apply (plan 보여 주고 yes 확인)
tofu show / tofu state list / tofu output
tofu destroy               # 전부 삭제 (= 빈 설정을 apply)
```

### plan 읽기

```
  # docker_container.web will be created        +   생성
  # docker_container.web will be updated in-place   ~   제자리 수정 (다운타임 없음, 보통)
  # docker_container.web must be replaced       -/+ 교체 (삭제 후 생성 — 다운타임·데이터 손실 가능!)
      ~ name = "web" -> "web2" # forces replacement
  # docker_container.web will be destroyed      -   삭제
  # docker_container.web will be read during apply   <=  데이터 소스가 apply 때 읽힘
Plan: 1 to add, 0 to change, 1 to destroy.
```

- `(known after apply)`: 생성 전엔 모르는 값(ID, IP). 이것을 다른 리소스의 ForceNew 인자가 참조하면 **연쇄 교체**가 일어날 수 있다 — 실험 `iac-state-import` 가 `env = (known after apply) # forces replacement` 로 보여 준다.
- **`-/+` 와 `-` 를 반드시 눈으로 확인**하고 apply. CI 에서는 plan 을 PR 코멘트로(Atlantis, tf-summarize). `-detailed-exitcode` 로 변경 유무를 exit 코드로.
- `-target=resource` 는 비상용. 그래프 일부만 적용하면 state 가 불일치할 수 있다.
- `-refresh=false` 는 빠르지만 드리프트를 못 본다. `-refresh-only` 는 state 만 실제에 맞춘다.

## state — 왜 필요한가

"코드와 실제를 비교하면 되지, 왜 state 가 따로?"

1. **매핑**: 코드의 `docker_container.web` 이 실제 어떤 컨테이너(ID `72bf…`)인지. 이름이 같은 게 둘이면? 태그가 없는 리소스면? state 가 **주소 ↔ 실제 ID** 를 기억한다.
2. **성능**: 수천 리소스를 매번 전부 조회하면 느리다. state 를 캐시로 쓰고 refresh 로 갱신.
3. **메타데이터**: 의존 순서(삭제 때 필요), 프로바이더 버전, 민감 출력.
4. **코드에 없는 값**: `(known after apply)` 였던 ID·IP 가 state 에 저장돼 output·참조로 쓰인다.

state 는 JSON 이고 **실제 속성을 전부**(비밀번호·키 포함) 담는다 → 원격·암호화·잠금·최소 권한이 필수 — [05 노트](/iac/notes/05-state-management-deep). 손으로 편집하지 말고 `state mv/rm`, `import`, `moved` 블록으로 — 실험 `iac-state-import`.

## 생명주기 메타 인자

```hcl
resource "aws_db_instance" "main" {
  ...
  lifecycle {
    prevent_destroy       = true                # 실수로 destroy/replace 하면 plan 이 에러
    create_before_destroy = true                # 교체 시 새것 먼저 (무중단), 이름 충돌 주의
    ignore_changes        = [tags["LastScan"]]  # 외부(다른 자동화)가 바꾸는 속성은 드리프트로 안 봄
    replace_triggered_by  = [terraform_data.version]   # 다른 값이 바뀌면 교체
    precondition { condition = var.size != "db.t2.micro", error_message = "운영은 micro 금지" }
  }
}
```

`ignore_changes` 는 ArgoCD 의 `ignoreDifferences`([GitOps 노트](/kubernetes/notes/13-gitops-progressive-delivery)) 와 같은 역할 — HPA 가 바꾸는 replicas, 오토스케일링 그룹의 desired_capacity.

## 흔한 첫 실수

| 실수 | 증상 | 교정 |
|---|---|---|
| state 를 로컬에 두고 둘이 작업 | 서로의 변경을 덮어씀, 리소스 중복 | 원격 백엔드 + 잠금 |
| state/lock 파일을 git 에 안 넣거나(lock) 넣거나(state) | 프로바이더 버전 불일치 / 비밀 유출 | lock 은 커밋, state 는 절대 커밋 금지 |
| plan 안 읽고 `apply -auto-approve` | DB 교체로 데이터 소실 | CI 외엔 금지, `prevent_destroy` |
| 콘솔에서 고치고 코드 안 고침 | 다음 apply 가 되돌림 | 드리프트 — [06](/iac/notes/06-drift-policy-testing) |
| `-target` 남용 | state 불일치 | 모듈/환경 분리로 범위 축소 |
| 비밀을 변수 기본값·`.tfvars` 로 커밋 | 유출 | 환경 변수 `TF_VAR_x`, 시크릿 매니저 데이터 소스, `sensitive = true` |
| 프로바이더 버전 미고정 | 어느 날 CI 가 깨짐 | `~>` 제약 + lock 파일 |
| 거대한 단일 루트 모듈 | plan 10분, 블라스트 반경 전체 | 환경·계층별 분리 — [08](/iac/notes/08-alternatives-design) |

## 예시로 보기 — 실험 둘

- `iac-plan-apply-docker`: init(lock 파일 생성) → plan(2 to add) → apply → state list → plan(No changes) → `-var name=` 으로 replace 확인 → output → destroy. 한 바퀴.
- `iac-state-import`: 손으로 만든 컨테이너를 `import` 블록으로 편입, `-generate-config-out` 초안이 왜 그대로는 안 되는지, 속성을 빠뜨리면 왜 **교체**가 제안되는지, `state rm` 과 `destroy` 의 차이.

둘 다 작업 디렉터리를 임시 폴더에 만들고 끝나면 지운다. 직접 해 보려면 실험 설명의 `code` 블록을 복사하면 된다.

## 실습 체크리스트

- [ ] 실험 두 개를 돌리고 plan 출력에서 `+`, `~`, `-/+`, `(known after apply)`, `# forces replacement` 를 찾아 표시
- [ ] `tofu graph | dot -Tsvg` 로 그래프 그려 보기(graphviz 설치)
- [ ] `.terraform.lock.hcl` 을 열어 해시를 보고, 프로바이더 버전을 `~> 2.0` 으로 바꿔 `init` 이 어떻게 반응하는지
- [ ] `terraform.tfstate` 를 `jq` 로 열어 컨테이너의 어떤 속성이 저장돼 있는지, 민감 정보가 될 만한 것이 있는지 확인
- [ ] `prevent_destroy = true` 를 넣고 `destroy` 가 거부되는지, `create_before_destroy` 로 교체 순서가 바뀌는지 보기
