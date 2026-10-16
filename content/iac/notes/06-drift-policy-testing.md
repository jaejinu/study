---
title: 드리프트·정책·테스트 — plan 으로 감시, OPA/Conftest 로 금지, CI 로 자동화
order: 6
level: 심화
summary: "드리프트의 원인과 종류(삭제·수정·외부 생성), refresh 와 -detailed-exitcode 로 드리프트를 알림으로 만드는 법, 되돌릴지 수용할지의 판단과 ignore_changes, GitOps selfHeal 과의 비교, 정책 계층(validation/precondition → tflint → checkov/trivy config → OPA/Conftest/Sentinel → 클라우드 SCP), Rego 로 '0.0.0.0/0 에 22 금지' 쓰기, 비용 추정(Infracost), 테스트 피라미드(validate·tftest·통합), CI 파이프라인(PR 에 plan 코멘트·보호된 apply·Atlantis·OIDC 로 비밀 없는 CI), 관측과 연결"
tags: [드리프트, detailed-exitcode, OPA, Conftest, Rego, checkov, tflint, Infracost, Atlantis, CI, GitHub Actions]
experiments: [iac-drift-detect]
---

## 드리프트 — 코드가 거짓말이 되는 순간

| 종류 | 예 | plan 에 보이는 모습 |
|---|---|---|
| **삭제** | 누가 콘솔에서 컨테이너/인스턴스를 지움 | `+ (1 to add)` — refresh 가 "사라졌다" 를 알고 재생성 제안 |
| **수정** | 보안 그룹에 포트 추가, 태그 변경, 인스턴스 크기 변경 | `~ update in-place` 또는 `-/+` (ForceNew 속성이면) |
| **외부 생성** | 코드에 없는 리소스가 생김 | **안 보인다** — Terraform 은 자기 state 에 있는 것만 본다. 별도 도구(driftctl, 클라우드 Config) 필요 |
| **설정 드리프트(앱 레벨)** | 컨테이너 안에서 파일 수정 | Terraform 범위 밖 — 불변 인프라로 해결 |

실험 `iac-drift-detect` 는 첫 두 가지를 만든다: 컨테이너를 `docker rm` 하면 `1 to add`, 같은 이름으로 다른 설정의 컨테이너를 손수 만들면 state 의 ID 와 달라 역시 재생성 제안(그리고 apply 는 이름 충돌로 실패 → "발견" 과 "해결" 은 다른 문제).

### 감시 — plan 을 cron 으로

![드리프트 감시 루프](/diagrams/iac-drift-loop.svg)

```bash
tofu plan -detailed-exitcode -input=false -lock=false -out=/dev/null
# exit 0: 변경 없음 / 1: 오류 / 2: 변경 있음(= 드리프트 또는 미적용 코드)
```

```yaml
# .github/workflows/drift.yml
on: { schedule: [{ cron: "*/30 * * * *" }], workflow_dispatch: {} }
jobs:
  drift:
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@<sha>
      - uses: opentofu/setup-opentofu@<sha>
      - uses: aws-actions/configure-aws-credentials@<sha>   # OIDC, 비밀 없음
        with: { role-to-assume: arn:aws:iam::…:role/tf-plan-readonly, aws-region: … }
      - run: tofu init -input=false
      - id: plan
        run: tofu plan -detailed-exitcode -input=false -lock=false -no-color > plan.txt; echo "code=$?" >> $GITHUB_OUTPUT
        continue-on-error: true
      - if: steps.plan.outputs.code == '2'
        run: |
          curl -X POST "$ALERT_WEBHOOK" -H 'Content-Type: application/json' \
            -d "$(jq -n --arg p "$(head -c 3000 plan.txt)" '{alerts:[{labels:{alertname:"TerraformDrift",severity:"warning",env:"prod"},annotations:{summary:"드리프트 감지",plan:$p}}]}')"
```

- 이 프로젝트의 `/api/alerts` 웹훅 형식과 같으니 **드리프트 알림이 관측성 대시보드의 '최근 알림' 카드에 뜬다** — [알림 파이프라인](/observability/notes/09-alerting-pipeline). Prometheus 가 아니라 CI 가 발신자일 뿐.
- 메트릭으로도: 드리프트 리소스 수를 pushgateway 에 보내 `terraform_drift_resources{env}` 패널.
- `-lock=false` 는 읽기 전용 plan 에서 다른 apply 를 막지 않기 위해. 권한도 **읽기 전용 역할**로.

### 해결 — 되돌릴까, 받아들일까

| 상황 | 조치 |
|---|---|
| 긴급 핫픽스였고 코드가 맞다 | `apply` 로 되돌림(핫픽스는 코드로 다시) |
| 핫픽스가 옳았다 | 코드를 고쳐 plan 이 No changes 가 되게 |
| 다른 시스템(HPA, 오토스케일러, 보안 자동화)이 정당하게 바꾼다 | `lifecycle { ignore_changes = [...] }` — 그 속성은 "코드 밖" 으로 선언 |
| state 만 틀림(실체는 정상) | `apply -refresh-only` 로 state 수용 |
| 코드에 없는 리소스 | import 하거나 삭제. 외부 생성은 driftctl/Config 규칙으로 발견 |

**자동 복구(auto-apply)** 는 GitOps 의 selfHeal 과 같은 질문이다. ArgoCD 는 기본 3분마다 되돌리고([K8s 노트 13](/kubernetes/notes/13-gitops-progressive-delivery) 에서 실측: 값 변경은 5초 내 복구, **필드 추가는 3-way diff 가 무시**), Terraform 은 사람이 결정하는 것이 기본. 인프라(DB·네트워크)는 자동 복구가 데이터 손실(교체)을 부를 수 있어 **알림 → 사람 → PR** 이 안전하다. 워크로드(k8s)는 자동이 낫다.

## 정책 — "할 수 있다" 와 "해도 된다" 의 분리

RBAC 는 누가 apply 할 수 있는지, 정책은 **어떤 코드가 통과하는지**.

```
[코드]   validation / precondition      ← 모듈 작성자의 계약
[린트]   tofu fmt·validate, tflint       ← 문법·스타일·프로바이더 규칙(존재하지 않는 인스턴스 타입)
[보안]   checkov, trivy config, tfsec    ← 수백 개 내장 규칙(공개 S3, 암호화 없음, 0.0.0.0/0)
[정책]   OPA/Conftest, Sentinel, HCP policy ← 회사 규칙을 코드로 (태그 필수, 리전 제한, 비용 상한)
[가드]   클라우드 SCP/Org policy          ← 마지막 방어선(코드가 통과해도 API 가 거부)
```

### Conftest + Rego — plan JSON 을 검사

```bash
tofu plan -out=tfplan && tofu show -json tfplan > plan.json
conftest test plan.json -p policy/
```

```rego
# policy/network.rego
package main
import rego.v1

deny contains msg if {
  some rc in input.resource_changes
  rc.type == "aws_security_group_rule"
  rc.change.after.type == "ingress"
  "0.0.0.0/0" in rc.change.after.cidr_blocks
  rc.change.after.from_port <= 22
  rc.change.after.to_port >= 22
  msg := sprintf("%s: SSH(22) 를 인터넷에 열 수 없습니다", [rc.address])
}

deny contains msg if {
  some rc in input.resource_changes
  rc.change.actions[_] == "delete"
  rc.type in {"aws_db_instance", "aws_s3_bucket"}
  msg := sprintf("%s: 데이터 리소스 삭제는 수동 승인 필요", [rc.address])
}

deny contains msg if {
  some rc in input.resource_changes
  rc.mode == "managed"
  not rc.change.after.tags.team
  msg := sprintf("%s: tags.team 필수", [rc.address])
}
```

- **plan JSON** 을 검사하니 변수·모듈이 풀린 **실제 결과**를 본다(HCL 정적 분석의 한계를 넘음).
- 같은 Rego 가 Kubernetes 어드미션(Gatekeeper)·Docker·CI 설정에도 쓰인다 — [보안 06](/security/notes/06-kubernetes-security) 의 Kyverno/Gatekeeper 와 한 가족.
- Sentinel 은 HCP Terraform 전용(유료), **soft/hard mandatory** 로 승인 가능한 위반 구분.
- checkov 는 "무엇이 위험한지" 를 모르는 팀에 좋은 출발점(`checkov -d . --framework terraform`), 결과를 `.checkov.yaml` 로 억제할 땐 사유를.

### 비용도 정책이다

```bash
infracost breakdown --path . --format json > cost.json
infracost diff --path . --compare-to cost-base.json      # PR 코멘트: "+$120/월"
```
"월 $500 이상 증가는 승인 필요" 를 OPA 로. 비용은 설계 결정이고 PR 에서 보이면 가장 싸게 고친다 — [아키텍처 노트](/architecture/notes/01-principles-tradeoffs).

## 테스트 피라미드

| 층 | 도구 | 속도 | 잡는 것 |
|---|---|---|---|
| 정적 | `fmt -check`, `validate`, tflint, checkov | 초 | 문법, 타입, 안티패턴, 보안 규칙 |
| 단위(plan) | `tofu test` 의 `command = plan` + assert, Conftest | 초~분 | 변수 조합 → 기대 속성, 정책 |
| 통합(apply) | `tofu test` 의 `command = apply`, Terratest(Go), kitchen-terraform | 분~시간 | 실제 생성·연결(DNS 응답, HTTP 200) → 자동 destroy |
| 계약/E2E | 환경을 띄우고 앱 테스트 | 시간 | 전체 |

```hcl
# tests/plan.tftest.hcl
variables { env = "prod" }
run "prod_has_4_replicas" {
  command = plan
  assert { condition = docker_container.web.count == 4, error_message = "prod 는 4" }
}
run "no_public_ports_in_prod" {
  command = plan
  assert {
    condition     = alltrue([for p in docker_container.web.ports : p.ip == "127.0.0.1"])
    error_message = "prod 컨테이너는 루프백에만 바인딩"
  }
}
```

통합 테스트는 **일회용 환경**(kind, Docker, LocalStack, 클라우드 샌드박스 계정) + 반드시 `destroy`(실패해도 — `cleanup` 단계, 고아 리소스 청소 cron).

## CI 파이프라인 — PR 에 plan, 보호된 apply

```
PR 열림 → fmt/validate/tflint/checkov → plan → Conftest(plan.json) → Infracost → PR 코멘트(plan 요약 + 비용)
리뷰·승인 → main 머지 → apply(환경별 승인 게이트) → 알림 → (드리프트 cron 이 지속 감시)
```

| 요소 | 선택지 |
|---|---|
| plan 코멘트 | `tf-summarize`, `terraform-pr-commenter`, Atlantis(PR 에서 `atlantis plan/apply` 명령) |
| apply 게이트 | GitHub Environments 의 required reviewers, HCP Terraform 의 run 승인 |
| 자격 증명 | **OIDC** → 클라우드 역할(plan 은 읽기 전용 역할, apply 는 쓰기 역할). 장기 키 금지 — [보안 04](/security/notes/04-secrets-management), [GHA 노트](/github-actions/notes/03-secrets-deploy) |
| 동시성 | `concurrency: { group: tf-prod }` 로 apply 직렬화 + 백엔드 잠금 |
| 저장된 plan 적용 | `plan -out` 아티팩트를 apply 가 그대로 — 리뷰한 것과 적용되는 것이 같도록(그 사이 드리프트가 있으면 apply 가 거부) |
| 포크 PR | plan 도 돌리지 않기(시크릿·state 노출) 또는 읽기 전용 샌드박스 |

Atlantis 는 "PR 이 곧 작업 단위" 를 서버로 구현: 각 PR 마다 잠금, 코멘트로 plan 결과, `atlantis apply` 로 적용, 머지 전 apply 강제 가능. 셀프호스팅이 가능해 비용 없이 HCP 급 워크플로.

## 관측과 연결

- 드리프트 알림(위), apply 성공/실패·소요·변경 리소스 수를 **메트릭**으로(CI 에서 pushgateway 또는 OTel), 환경별 마지막 apply 시각 패널("prod 는 3일째 미적용" = 미머지 변경이 쌓임).
- apply 로그는 **감사 로그**다(누가 언제 무엇을 바꿨나). Loki 에 `job=terraform-apply` 로 수집, `- destroy` 가 포함된 apply 는 별도 알림.
- 변경 이벤트를 Grafana **어노테이션**으로 — 지연 그래프의 스파이크 옆에 "14:02 apply: web 복제본 2→4" 가 보이면 원인 분석이 끝난다. [관측성 노트](/observability/notes/04-grafana-alerting).

## 예시로 보기 — 이 프로젝트에서

- 실험 `iac-drift-detect` 의 마지막 메모가 CI cron 과 웹훅 형식을 알려 준다. 로컬에서 흉내 내려면: 실험의 설정으로 apply 해 두고 터미널에서 `docker rm -f`, 그리고 `tofu plan -detailed-exitcode; echo $?` → 2 를 `curl localhost:3000/api/alerts` 로 보내면 관측성 대시보드에 뜬다.
- 정책 연습: 실험의 plan JSON(`tofu show -json`)에 "컨테이너 포트는 127.0.0.1 에만" Rego 를 Conftest 로 적용해 보기. compose 의 보안 결정을 Terraform 으로 옮길 때 그 결정이 **정책으로 강제**된다.
- `.github/workflows/ci.yml` 에 `tofu fmt -check && tofu validate && checkov` 단계를 추가(아직 `.tf` 가 없으면 07 노트 뒤에).

> 이어서 읽기: [계약 테스트 — 서비스를 같이 띄우지 않고 호환성을 검증한다](/testing/notes/04-contract-testing) — 계약 테스트 — 인터페이스를 CI 에서 지키는 같은 발상

## 실습 체크리스트

- [ ] 실험 `iac-drift-detect` 를 돌리고 두 드리프트의 plan 출력 차이를 설명
- [ ] `plan -detailed-exitcode` 의 exit 2 를 `/api/alerts` 웹훅으로 보내 관측성 대시보드에서 확인
- [ ] 실험 설정의 plan JSON 에 Conftest 정책("호스트 포트 바인딩은 127.0.0.1 만", "latest 태그 금지") 적용
- [ ] checkov 를 이 프로젝트 `k8s/`·`docker-compose.yml` 에 돌려 보고 결과 중 3개를 고치거나 사유와 함께 억제
- [ ] `tofu test` 로 plan 단계 테스트 2개 작성(복제본 수, 포트 바인딩)
- [ ] 드리프트 cron 워크플로를 작성(실제 클라우드가 없으면 Docker 프로바이더 + self-hosted runner 또는 로컬 cron)
- [ ] `ignore_changes` 가 필요한 속성이 이 프로젝트에 있는지(HPA 의 replicas 처럼) 찾아 보기
