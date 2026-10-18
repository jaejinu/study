---
title: 변수·출력·locals·표현식 — for_each, count, dynamic, 함수, 타입
order: 3
level: 중급
summary: "입력 변수의 타입 시스템(string·number·bool·list·map·object·optional)과 검증·민감 표시·우선순위(tfvars·환경 변수·CLI), locals 로 계산값 정리, output 과 모듈 간 전달, count 와 for_each 의 차이(인덱스 vs 키 — 왜 for_each 가 안전한가), for 표현식·스플랫·조건식·문자열 템플릿, dynamic 블록, 자주 쓰는 함수(lookup·merge·templatefile·jsonencode·try), 반복 설계 패턴과 함정"
tags: [variables, outputs, locals, for_each, count, dynamic, 함수, 타입, tfvars]
experiments: [iac-plan-apply-docker]
---

## 입력 변수

```hcl
variable "env" {
  type        = string
  description = "환경 이름"
  validation {
    condition     = contains(["dev", "stage", "prod"], var.env)
    error_message = "env 는 dev/stage/prod 중 하나"
  }
}
variable "replicas"   { type = number, default = 2 }
variable "enable_tls" { type = bool,   default = false }
variable "db_password" {
  type      = string
  sensitive = true            # plan/출력에서 (sensitive value) 로 가려짐. state 에는 평문!
  ephemeral = true            # 1.10+: state 에도 저장하지 않음
}
variable "services" {
  type = map(object({
    image    = string
    port     = number
    replicas = optional(number, 1)          # 기본값 있는 선택 필드
    env      = optional(map(string), {})
  }))
}
```

### 값을 주는 방법과 우선순위 (낮음 → 높음)
1. `default`
2. 환경 변수 `TF_VAR_env=prod`
3. `terraform.tfvars` / `*.auto.tfvars` (자동 로드)
4. `-var-file=prod.tfvars` (명령 순서대로)
5. `-var env=prod`

```hcl
# prod.tfvars
env      = "prod"
replicas = 4
services = {
  web   = { image = "ghcr.io/jaejinu/study:dev", port = 3000, replicas = 2 }
  redis = { image = "redis:8-alpine", port = 6379 }
}
```

- **비밀은 tfvars 에 쓰지 않는다**(git 에 들어간다). `TF_VAR_` 환경 변수나 시크릿 매니저 데이터 소스(`data "aws_secretsmanager_secret_version"`, `data "vault_generic_secret"`) 로.
- 타입을 **항상 명시**. `any` 는 모듈 인터페이스를 모호하게 한다. 객체 타입 + `optional()` 이 "설정 스키마" 역할을 한다.
- `validation` 은 입력 시점에 실패시킨다 — 운영에 `t2.micro` 를 못 넣게.

## locals — 계산값에 이름을

```hcl
locals {
  name_prefix = "${var.project}-${var.env}"
  common_tags = { project = var.project, env = var.env, managed_by = "tofu" }
  is_prod     = var.env == "prod"
  replicas    = local.is_prod ? 4 : 1
  # 복잡한 변환
  service_ports = { for k, s in var.services : k => s.port }
}
resource "docker_container" "svc" {
  for_each = var.services
  name     = "${local.name_prefix}-${each.key}"
  ...
}
```

변수는 **밖에서 들어오는 것**, locals 는 **안에서 계산하는 것**. 같은 식을 두 번 쓰면 local 로.

## output — 밖으로 내보내기

```hcl
output "container_ids" {
  value       = { for k, c in docker_container.svc : k => c.id }
  description = "서비스별 컨테이너 ID"
}
output "db_url" {
  value     = "postgres://app:${var.db_password}@${aws_db_instance.main.address}/app"
  sensitive = true
}
```

- 루트 모듈의 output 은 `tofu output -json` 으로 CI/스크립트가 읽는다. 자식 모듈의 output 은 `module.x.y` 로 부모가 쓴다.
- 다른 state 의 output 을 읽는 `terraform_remote_state` 데이터 소스 → 계층 간 연결(네트워크 state 의 subnet id 를 앱 state 가) — [05 노트](/iac/notes/05-state-management-deep). 다만 결합이 강해지니 가능하면 데이터 소스(태그로 조회)로.

## count vs for_each — 가장 중요한 선택

```hcl
# count: 인덱스로 식별
resource "docker_container" "w" {
  count = 3
  name  = "w-${count.index}"
}
# 주소: docker_container.w[0], w[1], w[2]

# for_each: 키로 식별 (map 또는 set(string))
resource "docker_container" "w" {
  for_each = toset(["a", "b", "c"])
  name     = "w-${each.key}"
}
# 주소: docker_container.w["a"], w["b"], w["c"]
```

**왜 for_each 가 안전한가**: `count` 로 `["a","b","c"]` 를 만들었다가 `"b"` 를 빼면 `[a, c]` → `w[1]` 이 b 에서 c 로 바뀌고 `w[2]` 가 삭제된다 → **b 와 c 둘 다 교체**된다. `for_each` 는 `w["b"]` 만 삭제된다. 리스트의 중간 요소를 지우거나 순서를 바꿀 가능성이 있으면 무조건 `for_each`.

`count` 는 **켜고 끄기**에만: `count = var.enable_monitoring ? 1 : 0` → `aws_x.y[0]`. 1.x 에서는 이것도 모듈에 `for_each = var.enabled ? { on = 1 } : {}` 로 쓰기도.

- `for_each` 의 키는 **apply 전에 알려진 값**이어야 한다. 다른 리소스의 `(known after apply)` ID 를 키로 쓰면 에러 — 키는 입력 변수나 이름처럼 정적인 것으로.
- `each.key / each.value`, count 는 `count.index`.
- 모듈에도 `count/for_each` 가 된다(0.13+).

## 표현식

```hcl
# 조건
instance_type = var.env == "prod" ? "m6i.large" : "t3.small"
# for 식: 리스트 → 리스트/맵, 필터
upper_names = [for n in var.names : upper(n) if n != ""]
port_map    = { for s in var.services : s.name => s.port }
# 스플랫
ids = docker_container.w[*].id                # count 일 때
ids = values(docker_container.w)[*].id        # for_each 일 때
# 문자열 템플릿
user_data = <<-EOT
  #!/bin/bash
  echo "env=${var.env}"
  %{ for p in var.ports ~}
  open ${p}
  %{ endfor ~}
EOT
# 파일 템플릿
config = templatefile("${path.module}/nginx.conf.tftpl", { upstream = var.upstream, port = 3000 })
```

### 자주 쓰는 함수

| 범주 | 함수 |
|---|---|
| 컬렉션 | `length, lookup(map, key, default), merge(a, b), concat, flatten, distinct, keys, values, zipmap, setproduct, slice, element, coalesce, compact, one` |
| 문자열 | `format, join, split, replace, regex, regexall, trimspace, lower/upper, substr, startswith` |
| 인코딩 | `jsonencode/jsondecode, yamlencode/yamldecode, base64encode, csvdecode, urlencode` |
| 파일 | `file, templatefile, fileexists, filebase64, pathexpand` — `path.module`, `path.root`, `path.cwd` |
| 타입 | `tostring, tonumber, tolist, toset, tomap, can(expr), try(expr, fallback), type` |
| 해시·암호 | `sha256, md5, bcrypt, uuid(비멱등!), uuidv5` |
| 날짜 | `timestamp()(비멱등!), formatdate, timeadd, plantimestamp` |
| 네트워크 | `cidrsubnet, cidrhost, cidrnetmask` |
| 숫자 | `min, max, ceil, floor, abs, pow` |

**비멱등 함수 주의**: `timestamp()`, `uuid()` 는 매 plan 마다 바뀌어 영원히 diff 가 난다. 필요하면 `time_static`/`random_uuid` **리소스**로(한 번 만들고 state 에 고정). 실험 `iac-plan-apply-docker` 의 설정에 `env = ["TS=${timestamp()}"]` 를 넣어 보면 두 번째 plan 이 No changes 가 아니게 된다.

`tofu console` 에서 식을 바로 평가해 볼 수 있다: `> cidrsubnet("10.0.0.0/16", 8, 3)`.

## dynamic 블록 — 중첩 블록을 반복

```hcl
resource "docker_container" "web" {
  name  = "web"
  image = docker_image.nginx.image_id
  dynamic "ports" {
    for_each = var.ports            # [{internal=80, external=18089}, ...]
    content {
      internal = ports.value.internal
      external = ports.value.external
    }
  }
  dynamic "labels" {
    for_each = local.common_tags
    content {
      label = labels.key
      value = labels.value
    }
  }
}
```

중첩 블록(`ports {}`, `ingress {}`, `labels {}`)은 인자가 아니라 리스트 값을 직접 넣을 수 없으니 `dynamic` 으로 반복한다. 남용하면 읽기 어렵다 — 블록 두세 개면 그냥 쓴다.

## 반복 설계 패턴

```hcl
# 패턴 1: 설정 맵 하나로 리소스 묶음 — "데이터가 코드를 구동"
variable "topics" {
  type = map(object({ partitions = number, retention_ms = optional(number, 604800000) }))
}
resource "kafka_topic" "t" {
  for_each           = var.topics
  name               = each.key
  partitions         = each.value.partitions
  replication_factor = 3
  config             = { "retention.ms" = each.value.retention_ms }
}

# 패턴 2: 조건부 리소스 (모듈 안에서 옵션 기능)
resource "aws_cloudwatch_alarm" "cpu" {
  count = var.alarms_enabled ? 1 : 0
  ...
}

# 패턴 3: 두 집합의 곱 (환경 × 서비스)
locals {
  pairs = { for p in setproduct(var.envs, var.services) : "${p[0]}-${p[1]}" => { env = p[0], svc = p[1] } }
}
resource "x" "y" { for_each = local.pairs ... }

# 패턴 4: 리스트 → for_each 용 맵 (키 안정화)
for_each = { for u in var.users : u.name => u }
```

## 함정 모음

| 함정 | 결과 | 대처 |
|---|---|---|
| `count` 로 리스트 관리 | 중간 삭제 시 연쇄 교체 | `for_each` |
| `for_each` 키에 apply 후 값 | "The for_each value depends on resource attributes that cannot be determined until apply" | 정적 키, 또는 2단계 apply |
| `sensitive` 변수를 `for_each` 키로 | 에러(키는 평문이어야) | `nonsensitive()` 신중히 |
| `optional()` 없이 object 타입 | 필드 하나 빠지면 에러 | `optional(type, default)` |
| 문자열로 받은 숫자 `"3"` | 암묵 변환되지만 혼란 | 타입 명시 |
| `lookup(map, key)` 기본값 없이 | 키 없으면 에러 | `lookup(m, k, null)` 또는 `try(m[k], null)` |
| `timestamp()`/`uuid()` 인자 | 영구 diff | 리소스로 고정 |
| 깊은 `merge` 기대 | `merge` 는 얕다 | 구조를 평평하게, 또는 `deepmerge` 모듈 |
| `templatefile` 에서 `${}` 충돌 | 셸 변수 `${HOME}` 이 보간됨 | `$${HOME}` 로 이스케이프 |

## 예시로 보기 — 이 프로젝트의 compose 를 변수화한다면

compose 의 서비스 목록을 Terraform 맵으로 옮기면:

```hcl
variable "services" {
  default = {
    redis    = { image = "redis:8-alpine",   port = 6379,  host_port = 6379,  profile = "core" }
    postgres = { image = "pgvector/pgvector:pg16", port = 5432, host_port = 15432, profile = "postgres" }
    kafka    = { image = "apache/kafka:3.9.1", port = 9092, host_port = 19092, profile = "kafka" }
  }
}
variable "profiles" { default = ["core"] }
resource "docker_container" "svc" {
  for_each = { for k, s in var.services : k => s if contains(var.profiles, s.profile) }
  name     = "study-${each.key}"
  image    = each.value.image
  ports { internal = each.value.port, external = each.value.host_port, ip = "127.0.0.1" }
}
```

`-var 'profiles=["core","kafka"]'` 가 compose 의 `--profile` 과 같은 역할. 포트가 `127.0.0.1` 에만 바인딩되는 보안 결정([보안 07](/security/notes/07-datastore-hardening))이 코드에 남는다.

> 함께 읽기: [Terraform/OpenTofu 핵심 모델 — HCL, 프로바이더, 리소스 그래프, plan/apply, state](/iac/notes/02-terraform-core-model) · [모듈 설계와 레지스트리 — 인터페이스, 버전, 구성 vs 상속](/iac/notes/04-modules-registry)

## 실전에서는 어디에 쓰이나

> 같은 인프라를 환경·리전·고객별로 여러 벌 만들거나, 목록(토픽·사용자·규칙)을 데이터로 관리하기 시작하면 변수·`for_each`·표현식이 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 개발·스테이징·운영 환경 | 같은 코드에 크기·복제본만 다르게 | 환경별 tfvars, 타입 + `validation` 으로 운영 금지값 차단 | 환경별 코드 복사 |
| 사내 Kafka 플랫폼 토픽 관리 | 팀이 요청한 토픽 목록을 코드로 | 토픽 설정 map + `for_each`("데이터가 코드를 구동") | 콘솔·CLI 수동 생성 |
| 선택 기능(모니터링·알람) | 환경마다 켜고 끄기 | `count = var.enabled ? 1 : 0` | 별도 루트 모듈 |
| 방화벽·보안 그룹 규칙 | 규칙 목록을 중첩 블록으로 | `dynamic` 블록으로 반복 | 규칙을 별도 리소스로 |
| DB 비밀번호 전달 | 비밀을 git 에 남기지 않기 | `TF_VAR_` 환경 변수, 시크릿 매니저 데이터 소스, `sensitive` | tfvars 커밋(유출) |

**이럴 땐 안 맞는다**
- 중간 삭제·재정렬이 있는 목록에 `count` → 인덱스가 밀려 연쇄 교체가 난다. `for_each` 로 키를 고정한다.
- 외부 API 조회나 복잡한 계산을 HCL 표현식으로 억지로 → 읽기 어려워진다. 데이터를 미리 가공하거나 범용 언어 IaC(Pulumi·CDK)를 검토한다.

**누가 매일 만나나** — 플랫폼 엔지니어가 "운영에 이 인스턴스 타입 금지" 같은 규칙을 `validation` 으로 넣을 때, 누군가 `count` 목록에서 하나를 지웠다가 plan 에 교체가 줄줄이 뜨는 것을 리뷰할 때.

**면접·실무 단골 질문**
- Q. `count` 와 `for_each` 는 언제 쓰나? → `count` 는 켜고 끄기, 목록은 `for_each`. 인덱스 식별은 중간 삭제 시 연쇄 교체를 부른다.
- Q. 비밀 변수는 어떻게 전달하나? → `TF_VAR_` 환경 변수나 시크릿 매니저. `sensitive` 는 출력만 가리고 state 에는 평문으로 남는다.

## 실습 체크리스트

- [ ] 실험 `iac-plan-apply-docker` 의 설정을 복사해 `variable "containers" = map` + `for_each` 로 컨테이너 2개를 만들고, 하나를 맵에서 빼면 plan 이 그것만 지우는지 확인
- [ ] 같은 것을 `count` + 리스트로 만들어 중간 요소를 빼면 교체가 일어나는지 비교
- [ ] `validation` 으로 이미지 태그에 `latest` 를 금지해 보기
- [ ] `tofu console` 에서 `{ for k, v in var.services : k => v.port }` 같은 식 5개 평가
- [ ] `templatefile` 로 Nginx 설정을 생성해 `docker_container` 의 `upload` 블록으로 넣기
- [ ] `env = ["TS=${timestamp()}"]` 를 넣어 영구 diff 를 재현하고 `time_static` 리소스로 고치기
