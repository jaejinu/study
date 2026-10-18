---
title: 모듈 설계와 레지스트리 — 인터페이스, 버전, 구성 vs 상속
order: 4
level: 중급
summary: "모듈이 무엇이고 루트 모듈과 자식 모듈이 어떻게 다른지, 좋은 모듈의 인터페이스(적은 필수 입력·의미 있는 출력·옵션은 객체로), 소스(로컬·git·레지스트리)와 버전 고정, 공개 모듈(terraform-aws-modules) 을 쓸 때의 판단 기준, 얇은 래퍼 모듈과 조합(composition) 패턴, 모듈 안의 프로바이더·count/for_each·moved 블록, 모듈 테스트와 문서화(terraform-docs), 과도한 추상화의 함정"
tags: [모듈, 레지스트리, 인터페이스, 버전, composition, terraform-docs, moved]
experiments: [iac-plan-apply-docker]
---

## 모듈 = 디렉터리

`.tf` 파일이 있는 디렉터리 하나가 모듈이다. `tofu apply` 를 실행하는 디렉터리가 **루트 모듈**, 루트가 `module` 블록으로 부르는 것이 **자식 모듈**. 함수와 같다: 입력(variables) → 리소스 → 출력(outputs).

```
infra/
  modules/
    redis/            ← 자식 모듈: StatefulSet + Service + PVC + ACL Secret
      main.tf  variables.tf  outputs.tf  README.md
    web/
  envs/
    dev/              ← 루트 모듈 1 (state 1)
      main.tf  → module "redis" { source = "../../modules/redis"  size = "small" }
    prod/             ← 루트 모듈 2 (state 2)
      main.tf  → module "redis" { source = "../../modules/redis"  size = "large", replicas = 3 }
```

```hcl
module "redis" {
  source  = "../../modules/redis"
  version = "~> 1.2"             # 레지스트리/git 소스일 때만
  name     = "study-redis"
  size     = "small"
  acl_users = { app = { keys = "~session:* ~cache:*", commands = "+@all -@dangerous" } }
}
output "redis_host" { value = module.redis.host }
```

- 자식 모듈의 리소스 주소는 `module.redis.kubernetes_stateful_set.this`. state 에도 그렇게.
- 모듈은 **값을 숨긴다**: 안의 리소스 속성은 output 으로 내보낸 것만 밖에서 보인다. 그래서 output 설계가 인터페이스의 절반.

## 좋은 모듈의 인터페이스

| 원칙 | 설명 |
|---|---|
| **필수 입력은 적게** | 이름·크기 정도. 나머지는 합리적 기본값. "모든 옵션을 변수로" 는 모듈이 아니라 리소스의 복사본 |
| **옵션은 객체로 묶기** | `var.backup = { enabled = true, retention_days = 7 }` — 관련 옵션이 흩어지지 않게. `optional()` 로 기본값 |
| **환경 이름을 모듈 안에서 분기하지 않기** | `if var.env == "prod"` 가 모듈 안에 있으면 환경이 늘 때마다 모듈을 고친다. 크기·복제본 같은 **속성**을 받는다 |
| **의미 있는 출력** | ID 뿐 아니라 연결에 필요한 것(host, port, SA 이름, 보안 그룹 ID). 소비자가 `module.x.resource.attr` 를 못 하니까 |
| **부작용 없는 조합** | 모듈이 프로바이더를 **설정하지 않는다**(상속받는다). 백엔드도 루트만 |
| **한 가지 일** | "네트워크 + 클러스터 + 앱" 모듈은 블라스트 반경이 전체. 계층별로 |
| **검증** | `validation` 블록으로 잘못된 조합을 plan 에서 막기. `precondition`/`postcondition` 으로 리소스 수준 계약 |
| **문서** | `terraform-docs` 로 README 자동 생성(입력·출력·요구 사항 표). 예제 디렉터리 `examples/` |

```hcl
# modules/redis/variables.tf
variable "name" { type = string }
variable "size" {
  type    = string
  default = "small"
  validation { condition = contains(["small", "medium", "large"], var.size), error_message = "small/medium/large" }
}
variable "replicas" { type = number, default = 1 }
variable "acl_users" {
  type    = map(object({ keys = string, commands = string }))
  default = {}
}
locals {
  sizes = {
    small  = { cpu = "100m", memory = "128Mi", maxmemory = "100mb" }
    medium = { cpu = "500m", memory = "512Mi", maxmemory = "400mb" }
    large  = { cpu = "2",    memory = "2Gi",   maxmemory = "1600mb" }
  }
  spec = local.sizes[var.size]
}
```

## 소스와 버전

| 소스 | 형식 | 버전 |
|---|---|---|
| 로컬 | `./modules/x`, `../x` | 없음(같은 저장소, 같은 커밋) |
| git | `git::https://github.com/org/repo.git//modules/x?ref=v1.2.0` | `ref=` 태그/SHA — **SHA 가 가장 안전** |
| 레지스트리 | `terraform-aws-modules/vpc/aws` | `version = "~> 5.0"` |
| 사설 레지스트리 | Terraform Cloud/HCP, GitLab, Artifactory, 또는 git | |
| S3/GCS/HTTP 아카이브 | `s3::https://...zip` | URL 에 버전 |

- `tofu init` 이 모듈을 `.terraform/modules/` 로 받는다. **lock 파일은 프로바이더만** 잠근다 — 모듈 버전은 `version`/`ref` 로 직접 고정. `~> 1.2` 는 1.x 안에서 최신(1.3 이 나오면 바뀐다) — 모노레포 로컬 모듈이 아니면 Renovate 로 올리기.
- 태그는 움직일 수 있다(공급망). 신뢰가 중요하면 커밋 SHA `?ref=3f2a…`.
- 사내 모듈 저장소는 **시맨틱 버저닝** + CHANGELOG + 호환성 깨는 변경은 메이저.

## 공개 모듈을 쓸까 — 판단 기준

`terraform-aws-modules/vpc`, `eks`, `rds` 같은 공개 모듈은 수백 개 옵션과 수년의 엣지 케이스가 녹아 있다.

| 쓰는 편이 나을 때 | 직접 쓰는 편이 나을 때 |
|---|---|
| 복잡한 리소스 묶음(EKS: 수십 개 리소스 + IAM) | 리소스 2~3개(S3 버킷 하나에 모듈은 과함) |
| 팀에 그 서비스 전문가가 없음 | 우리 규약(이름·태그·보안)이 강함 |
| 옵션의 90% 는 안 쓰더라도 나머지 10% 가 정확 | 모듈 업그레이드 때마다 plan 에 수십 개 변경이 나와 두려움 |

쓸 때의 규칙: **버전 고정**, 소스 한 번은 읽기(무엇을 만드는지, 어떤 권한을 요구하는지), 업그레이드는 plan 을 꼼꼼히(이름 변경 → 교체 유발이 흔함), 가능하면 **얇은 래퍼 모듈**로 감싸 우리 기본값을 고정.

```hcl
# modules/our-vpc/main.tf — 회사 규약을 박은 얇은 래퍼
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.8.1"
  name = var.name
  cidr = var.cidr
  enable_flow_log = true                 # 우리 보안 기준
  flow_log_destination_type = "cloud-watch-logs"
  tags = merge(var.tags, { managed_by = "tofu", team = var.team })
}
```

## 구성(composition) vs 상속

Terraform 에는 상속이 없다. 재사용은 **조합**으로: 작은 모듈을 루트에서 엮고 output → input 으로 연결.

```hcl
module "network" { source = "./modules/network"  cidr = "10.0.0.0/16" }
module "cluster" { source = "./modules/kind-cluster"  subnet_ids = module.network.private_subnets }
module "monitoring" { source = "./modules/kube-prometheus"  cluster = module.cluster.context }
module "app" { source = "./modules/web"  cluster = module.cluster.context  redis_url = module.redis.url }
```

- 암묵 의존성이 참조로 생기니 순서는 Terraform 이 정한다.
- "거대한 모듈 하나(`platform`)" 보다 "계층별 모듈 + 환경 루트" 가 변경 범위·plan 시간·리뷰에서 낫다. 하지만 계층이 **다른 state** 로 나뉘면 모듈 참조가 아니라 `terraform_remote_state`/데이터 소스가 된다 — [05 노트](/iac/notes/05-state-management-deep).

## 모듈 안의 주의점

- **프로바이더**: 모듈은 루트의 프로바이더를 상속한다. 별칭이 필요하면 `providers = { aws = aws.eu }` 로 **명시적으로 전달**. 모듈 안에 `provider` 블록을 두면 `count/for_each` 를 못 쓰고 제거가 어렵다(레거시 패턴).
- **count/for_each on module**: `module "svc" { for_each = var.services ... }` → `module.svc["web"].out`. 모듈 안 리소스의 주소가 `module.svc["web"].x.y` 로 깊어진다.
- **`moved` 블록**: 리팩터링으로 주소가 바뀔 때 교체 없이 state 이동.
  ```hcl
  moved { from = docker_container.web  to = module.web.docker_container.this }
  moved { from = module.old_name       to = module.new_name }
  ```
  apply 후 삭제. 모듈 작성자가 내부 리팩터링 시 모듈 안에 `moved` 를 넣어 소비자를 보호하는 것이 관례.
- **`removed` 블록**(1.7+): 선언적 `state rm` — "이 리소스는 이제 관리 안 함, 지우지는 말 것".
- **데이터 소스를 모듈 안에서 남용**하면 plan 마다 API 호출이 늘고, `(known after apply)` 의존이 생길 수 있다.

## 테스트와 문서

```hcl
# modules/redis/tests/basic.tftest.hcl  (terraform test / tofu test)
run "small_defaults" {
  command = plan
  variables { name = "t" }
  assert {
    condition     = kubernetes_stateful_set.this.spec[0].replicas == 1
    error_message = "기본 복제본은 1"
  }
}
run "apply_and_check_output" {
  command = apply                      # 실제 생성(테스트용 프로바이더/클러스터에)
  assert { condition = output.port == 6379, error_message = "포트" }
}
```

- `tofu test` 는 plan/apply 를 실제로 돌리므로 **일회용 환경**(kind, LocalStack, Docker)이 필요. 단위 수준은 `plan` 단계 assert 로 빠르게.
- 정적 검사: `tofu validate`, `tflint`(미사용 변수, 잘못된 인스턴스 타입), `checkov/trivy config`(보안) — [06 노트](/iac/notes/06-drift-policy-testing).
- 문서: `terraform-docs markdown table . > README.md` 를 pre-commit 에.
- `examples/complete`, `examples/minimal` 디렉터리가 곧 통합 테스트이자 사용 설명서.

## 과도한 추상화의 함정

- **모든 옵션을 통과시키는 모듈**: 리소스 인자 100개를 변수 100개로 → 모듈의 의미가 없다. 결정을 **모듈 안에서 내리는** 것이 모듈의 가치(크기 프리셋, 보안 기본값).
- **너무 이른 모듈화**: 두 번째 사용처가 생기기 전엔 모듈을 만들지 않는다(복사가 더 싸다). 세 번째에 추상화.
- **깊은 중첩**: 모듈 안의 모듈 안의 모듈 → 주소가 길고 plan 읽기 어렵고 `moved` 지옥. 2단계면 충분.
- **환경별 모듈 복사**(`modules/redis-dev`, `redis-prod`): 분기를 모듈 밖(환경 루트의 변수)으로.

## 예시로 보기 — 이 프로젝트의 모듈 후보

| 모듈 | 입력 | 출력 | 내용 |
|---|---|---|---|
| `kind-cluster` | name, k8s version, node 수 | kubeconfig path, context | kind 프로바이더로 클러스터 |
| `kube-prometheus` | cluster ctx, grafana 포트, 보존 기간 | grafana url | helm_release `kps` + 대시보드 ConfigMap |
| `redis` | name, size, acl_users | host, port | StatefulSet/Service/ConfigMap/ACL Secret |
| `web` | image, replicas, redis_url, canary(bool) | service name | Deployment 또는 Rollout(변수로 선택) |
| `argocd-app` | repo, path, namespace | — | Application CR — "이제부터 ArgoCD 가 관리" 의 교차점 |

[07 노트](/iac/notes/07-provider-kubernetes-docker) 에서 이 중 처음 둘을 실제로 만든다.

## 실전에서는 어디에 쓰이나

> 같은 인프라 묶음(서비스 + DB + 대시보드)을 여러 팀·환경이 반복해서 만들기 시작하면 모듈이 등장한다. 잘 만든 모듈은 회사의 모범 사례를 코드로 배포하는 수단이 된다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 사내 플랫폼 표준 서비스 | 새 서비스마다 같은 태그·로그·알람 규약 | 필수 입력이 적은 표준 모듈 + 크기 프리셋 | 위키 문서와 복사·붙여넣기 |
| 초기 스타트업의 네트워크·클러스터 | 복잡한 리소스 묶음을 빠르게 | 공개 모듈 버전 고정 + 회사 기본값을 박은 얇은 래퍼 | 처음부터 직접 작성 |
| 다환경 SaaS | dev·prod 가 같은 구조 | 환경 루트는 모듈 호출 + 변수만 | 환경별 모듈 복사 |
| 여러 팀이 쓰는 모듈 저장소 | 모듈 변경이 모든 환경을 깨뜨리지 않게 | 시맨틱 버저닝 + git ref·SHA 고정, 자동 갱신 PR | 항상 main 참조 |
| 대규모 리팩터링 | 리소스를 모듈로 옮길 때 교체 방지 | `moved` 블록 | `state mv` 수작업 |

**이럴 땐 안 맞는다**
- 사용처가 하나뿐인 리소스 2~3개 → 이른 모듈화는 간접층만 늘린다. 세 번째 사용처에서 추상화한다.
- 리소스 인자를 전부 변수로 통과시키는 모듈 → 결정을 대신 내려 주지 못하면 모듈의 가치가 없다. 프리셋과 기본값으로 결정을 담는다.

**누가 매일 만나나** — 플랫폼 팀이 모듈 카탈로그를 관리하고 새 버전을 릴리스할 때, 앱 팀 개발자가 "모듈 업그레이드 PR 의 plan 에 교체가 수십 개" 를 검토할 때.

**면접·실무 단골 질문**
- Q. 좋은 모듈 인터페이스의 조건은? → 적은 필수 입력, 객체로 묶은 옵션, 연결에 필요한 출력, 프로바이더는 상속.
- Q. 공개 모듈은 언제 쓰나? → 복잡한 묶음이고 팀에 전문가가 없을 때. 버전 고정, 소스 검토, 얇은 래퍼가 조건이다.

## 실습 체크리스트

- [ ] 실험 `iac-plan-apply-docker` 의 설정을 `modules/container` 로 빼고 루트에서 두 번 호출(다른 이름)해 보기
- [ ] 모듈에 `size` 프리셋(locals 맵)과 `validation` 을 넣기
- [ ] 리소스를 모듈로 옮길 때 `moved` 블록을 써서 plan 이 교체 없이 "moved" 만 보이는지 확인
- [ ] `terraform-docs` 로 README 생성
- [ ] 공개 모듈 하나(`terraform-aws-modules/s3-bucket` 등)의 소스를 열어 리소스 수와 필수 입력 수를 세어 보기
- [ ] `tofu test` 로 plan 단계 assert 하나 작성
