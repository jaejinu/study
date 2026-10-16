---
title: "심화 — 대안과 설계: Pulumi·CDK·Crossplane, 저장소 구조, 멀티 환경·계정, 거버넌스, 재해 복구"
order: 8
level: 심화
summary: "Terraform 외 선택지의 진짜 차이(Pulumi 의 범용 언어와 state, CDK/CDKTF 의 합성, Crossplane 의 k8s 조정 루프, Ansible 의 자리), 저장소·디렉터리 구조(모노레포 vs 모듈 저장소, 계층·환경 매트릭스), 멀티 계정·리전·테넌트 전략, 거버넌스(태깅·명명·비용·정책·권한 모델·변경 승인), 플랫폼 엔지니어링과 셀프서비스(Backstage·내부 모듈 카탈로그), 재해 복구를 코드로 연습하기, 10년 뒤에도 유지되는 IaC 의 조건"
tags: [Pulumi, CDK, CDKTF, Crossplane, Terragrunt, 모노레포, 멀티 계정, 거버넌스, 태깅, 플랫폼 엔지니어링, DR]
experiments: [iac-plan-apply-docker, iac-drift-detect]
---

## 대안들 — 무엇이 진짜 다른가

| 도구 | 언어 | 상태 | 조정 | 핵심 차이 |
|---|---|---|---|---|
| **Terraform/OpenTofu** | HCL(선언형 DSL) | state 파일 | 사람이 apply | 생태계 최대, 선언형이라 "읽기 쉬움" 과 "표현력 한계" 동시 |
| **Pulumi** | TS/Python/Go/C#/Java/YAML | Pulumi 서비스 또는 S3 등 | 사람이 `up` | **범용 언어**: 루프·함수·클래스·단위 테스트·IDE. 프로바이더는 Terraform 것을 브리지. 결과는 똑같이 선언적 그래프 |
| **AWS CDK** | TS/Python… → CloudFormation | CFN 스택 | CFN 이 롤백 | L2/L3 **구성체**(constructs)가 모범 사례를 캡슐화(VPC 한 줄). AWS 전용, CFN 의 느림·제한 상속 |
| **CDKTF** | TS/Python… → Terraform JSON | Terraform state | Terraform | CDK 스타일 + Terraform 프로바이더. 성숙도 낮음 |
| **Crossplane** | k8s YAML(CRD) | **etcd** (k8s 객체) | **컨트롤러가 계속** | 클라우드 리소스가 k8s 객체가 되고 드리프트를 **자동 복구**. Composition 으로 "회사 표준 DB" 같은 추상 API 제공. k8s 운영 복잡도 |
| **Ansible** | YAML 태스크 | 없음(멱등 모듈) | 사람이 playbook | VM **안** 구성, 네트워크 장비, 일회성 절차. Terraform 이 만든 VM 을 Ansible 이 구성(Packer 로 베이킹하면 더 좋다) |
| **Bicep/ARM, Google DM** | 선언형 | 클라우드 | 클라우드 | 단일 클라우드 네이티브 |

### 선택 기준
- **팀이 이미 아는 언어**가 있고 복잡한 로직(동적 리소스 수, 외부 API 조회)이 많다 → Pulumi/CDK.
- **플랫폼 팀이 k8s 중심**이고 "클라우드 리소스도 GitOps 로, 드리프트 자동 복구" → Crossplane(+ArgoCD).
- 그 외 대부분 → Terraform/OpenTofu. 가장 많은 예제·모듈·채용 풀·정책 도구.
- "HCL 은 프로그래밍 언어가 아니라 좋다": 리뷰어가 읽을 수 있고, 정적 분석(checkov/OPA)이 쉽다. Pulumi 코드의 반복문 안에 든 보안 그룹은 실행해 봐야 안다(`pulumi preview` 의 결과를 검사하면 되긴 한다).
- 혼용은 흔하다: Terraform(계정·네트워크·클러스터) + Crossplane 또는 ArgoCD(클러스터 안) + Ansible(레거시 VM).

### Crossplane 맛보기 — "Terraform 이 컨트롤러라면"

```yaml
apiVersion: database.example.org/v1alpha1     # 플랫폼 팀이 Composition 으로 정의한 추상 API
kind: PostgreSQLInstance
metadata: { name: study-db }
spec:
  parameters: { size: small, version: "16" }
  writeConnectionSecretToRef: { name: study-db-conn }   # 앱은 이 Secret 만 본다
```
개발자는 RDS 의 50개 옵션을 모르고 `size: small` 만 쓴다. 누가 콘솔에서 바꾸면 컨트롤러가 되돌린다(Terraform 드리프트 cron 이 필요 없다). 대가: 모든 것이 k8s 안에 있어야 하고, 클러스터가 죽으면 조정도 멈추며, Composition 작성이 어렵다. [K8s 오퍼레이터 노트](/kubernetes/notes/11-operators-crds) 의 조정 루프가 클라우드로 확장된 것.

## 저장소와 디렉터리 구조

### 모노레포 vs 분리

| | 인프라 모노레포 (`infra/`) | 모듈 저장소 + 환경 저장소 |
|---|---|---|
| 모듈 변경 → 환경 반영 | 같은 PR (원자적, 하지만 블라스트 반경 ↑) | 모듈 태그 → 환경별 버전 올리기(점진, Renovate) |
| 권한 | 디렉터리별 CODEOWNERS | 저장소별 |
| 적합 | 1~3팀 | 여러 팀, 모듈을 "제품" 처럼 |

이 프로젝트처럼 앱과 인프라가 한 저장소면 `infra/` 하위 모노레포가 자연스럽다. `k8s/`(GitOps 대상)와 `infra/`(Terraform)를 분리해 ArgoCD 의 경로를 좁힌다.

### 매트릭스: 계층 × 환경

```
infra/
  modules/            재사용 모듈 (버전은 git 태그 또는 경로)
    kind-cluster/  kube-prometheus/  redis/  web/
  live/               루트 모듈들 = state 단위
    local/
      10-cluster/  20-platform/
    dev/
      10-network/  20-cluster/  30-data/  40-platform/
    prod/
      10-network/  20-cluster/  30-data/  40-platform/
  policy/             Rego, checkov 설정
  .tflint.hcl  .pre-commit-config.yaml
```

- 환경 루트는 **얇게**(모듈 호출 + tfvars). 환경 간 diff 는 `diff -r live/dev live/prod` 로 한눈에.
- 반복되는 backend/provider 블록은 **Terragrunt**(`terragrunt.hcl` 의 `include`, `generate`, `dependency`) 로 생성하거나, 1.x 의 `-backend-config` + 템플릿으로. Terragrunt 는 `run-all plan` 으로 계층을 순서대로 돌려 준다.
- 숫자 접두사(10-, 20-)는 의존 순서를 사람에게 알려 준다. 도구는 `remote_state`/`dependency` 로 안다.

## 멀티 계정·리전·테넌트

- **계정(프로젝트) 분리**가 가장 강한 격리: `prod` 와 `dev` 를 다른 AWS 계정/GCP 프로젝트에. IAM 실수의 반경이 계정 안에 갇힌다. 조직(AWS Organizations) + SCP 로 "prod 계정에서는 리전 X 만, 루트 사용 금지" 같은 가드레일 — 코드가 틀려도 API 가 거부.
- **계정 자동화**: 계정 생성(Account Factory/Control Tower)도 Terraform 으로. 새 팀 = PR 하나.
- **리전**: 프로바이더 alias 로 멀티 리전, 모듈에 `providers = { aws = aws.eu }`. 리전 간 의존(글로벌 서비스, 리플리케이션)은 remote_state 보다 출력 → SSM 공유.
- **테넌트**(고객별 환경): `for_each = var.tenants` 로 모듈 반복 — 단, 테넌트가 수백이면 state 하나에 다 넣지 말고 테넌트별 state(워크스페이스가 어울리는 드문 경우) 또는 Crossplane.
- **DR 리전**: 같은 모듈을 다른 리전에 `count = var.dr_enabled ? 1 : 0` — 평소엔 0 으로 비용 절약, 훈련 때 1.

## 거버넌스 — 코드로 강제하는 운영 규칙

| 영역 | 규칙 예 | 강제 수단 |
|---|---|---|
| **태깅** | 모든 리소스에 `team, env, cost-center, managed-by` | 프로바이더 `default_tags`, OPA deny, 클라우드 태그 정책 |
| **명명** | `{project}-{env}-{component}` | 모듈 안에서 이름을 **생성**(입력은 component 만) |
| **비용** | 월 증가 $500 초과 승인, 특정 인스턴스 패밀리 금지 | Infracost + OPA, 예산 알림 |
| **보안** | 공개 버킷 금지, 암호화 필수, 0.0.0.0/0 금지 | checkov/trivy config, OPA, SCP |
| **권한** | plan 은 읽기 역할, apply 는 CI 만, 사람은 break-glass | OIDC 역할 분리, 환경 보호 규칙 |
| **변경 승인** | prod 는 2인 리뷰 + 업무 시간 | CODEOWNERS, GitHub Environments, Atlantis `--require-approval` |
| **삭제 보호** | 데이터 리소스 삭제는 별도 PR + 수동 | `prevent_destroy`, OPA(`delete` 액션 거부) |
| **수명** | dev 환경 7일 후 자동 파괴 | 태그 `expires` + cron destroy |

규칙은 **문서가 아니라 파이프라인**에 산다. 문서의 규칙은 지켜지지 않는다.

## 플랫폼 엔지니어링 — 셀프서비스

규모가 커지면 "인프라 팀에 티켓" 이 병목이 된다. 해법은 **내부 개발자 플랫폼**(IDP):

- **모듈 카탈로그**: "서비스 하나 = `module "svc"` 호출 하나" 가 되도록 표준 모듈(앱 + DB + 큐 + 대시보드 + 알림 규칙까지 묶은 것). 모듈이 곧 회사의 모범 사례.
- **골든 패스**: 새 서비스 생성 템플릿(Backstage Scaffolder, cookiecutter)이 저장소·CI·Terraform 환경·ArgoCD Application 을 한 번에.
- **추상 API**: Crossplane Composition 또는 Terraform 모듈 + 셀프서비스 UI(Backstage 플러그인, HCP no-code modules).
- **가드레일 ≠ 게이트**: 정책이 자동으로 막고, 사람 승인은 예외에만. 리드타임을 측정([운영 아키텍처](/architecture/notes/07-operations-architecture) 의 DORA 지표).

## 재해 복구를 코드로 연습하기

IaC 의 가장 큰 약속은 "**다시 만들 수 있다**" 다. 약속은 연습하지 않으면 거짓이 된다.

| 연습 | 방법 | 확인 |
|---|---|---|
| **환경 재생성** | 새 계정/리전에 같은 코드로 apply | 몇 분? 수동 단계는 몇 개? (0 이어야) |
| **state 손실** | state 백업을 숨기고 import 로 복구 | 모든 리소스에 식별 가능한 ID/태그가 있나 |
| **부분 파괴** | 데이터 계층만 destroy 후 백업에서 복원 | RTO/RPO 측정 |
| **프로바이더/모듈 장애** | 레지스트리 접근 차단 | 프로바이더 미러(`provider_installation`)·모듈 캐시 |
| **CI 장애** | 로컬에서 apply 할 수 있나 | break-glass 절차, 자격 증명 |

[카오스 엔지니어링](/chaos/notes/01-chaos-principles) 의 "가설 → 실험 → 측정" 을 인프라 계층에 적용한 것이다. 분기 1회 게임데이에 "리전 손실" 시나리오를 넣자.

## 오래 가는 IaC 의 조건

1. **작은 state, 명확한 소유권** — 변경이 두렵지 않다.
2. **버전 고정 + 자동 갱신 PR** — 2년 뒤에도 init 이 된다.
3. **plan 이 항상 No changes** — 드리프트 0 이 기본 상태. 알림으로 지킨다.
4. **정책이 파이프라인에** — 사람이 기억하지 않는다.
5. **비밀이 코드·state 에 없다** — 워크로드 신원, 매니저.
6. **문서는 생성된다** — terraform-docs, 다이어그램(`terraform graph`, Inframap).
7. **재현을 연습했다** — DR 리허설 기록.
8. **관측과 연결** — apply 이벤트·드리프트·비용이 대시보드에.

## 예시로 보기 — 이 프로젝트의 로드맵

| 단계 | 내용 | 노트 |
|---|---|---|
| 1 | 실험 3개로 plan/apply/drift/import 체화 | 01·02·05·06 |
| 2 | `infra/local/10-cluster`, `20-platform` 으로 kind + kps + ArgoCD 코드화, `pnpm k8s:*` 스크립트를 `tofu` 로 교체 | 07 |
| 3 | 소유권 표, `k8s/` 는 ArgoCD 전담 | 07 |
| 4 | CI 에 fmt/validate/checkov/plan 코멘트, Conftest 정책(루프백 바인딩, latest 금지) | 06 |
| 5 | state 를 MinIO(s3 호환) 에 두고 잠금·버저닝·암호화 체험 | 05 |
| 6 | 환경 점검 카드에 드리프트 상태, apply 이벤트를 Grafana 어노테이션으로 | 06·관측성 |
| 7 | `destroy` → `apply` 재현 리허설, 소요 시간 기록 | 08 |

> 함께 읽기: [모듈 설계와 레지스트리 — 인터페이스, 버전, 구성 vs 상속](/iac/notes/04-modules-registry)

## 실습 체크리스트

- [ ] 실험 `iac-plan-apply-docker` 의 설정을 Pulumi(TypeScript) 로 똑같이 작성해 `pulumi preview` 출력과 `tofu plan` 출력을 비교
- [ ] Crossplane 을 kind 에 설치하고 `provider-kubernetes` 로 네임스페이스 하나를 CR 로 만들어, `kubectl delete ns` 하면 되살아나는지 확인
- [ ] `infra/` 디렉터리 구조(modules/live/policy)를 만들고 README 에 소유권 표 작성
- [ ] 태깅 정책(`managed_by`, `env` 필수)을 OPA 로 쓰고 plan JSON 에 적용
- [ ] "state 를 잃었다" 시나리오: state 를 치우고 import 블록만으로 복구하는 데 걸리는 시간 측정
- [ ] 10년 조건 8개를 이 프로젝트에 대입해 ✓/✗ 표 만들기
