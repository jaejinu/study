---
title: IaC 가 왜 필요한가 — 스노우플레이크, 선언 vs 명령, 멱등, 불변 인프라
order: 1
level: 기초
summary: "손으로 만든 서버가 왜 재현 불가능한 '눈송이' 가 되는지, 명령형 스크립트와 선언형 정의의 차이, 멱등성이 자동화의 전제인 이유, 가변 vs 불변 인프라, IaC 가 주는 것(재현·리뷰·감사·재해 복구·환경 복제)과 도구 지형(Terraform/OpenTofu·Pulumi·CloudFormation·Ansible·Kubernetes 매니페스트), 이 프로젝트가 이미 쓰고 있는 IaC"
tags: [IaC, 선언형, 명령형, 멱등성, 불변 인프라, 스노우플레이크, Terraform, OpenTofu]
experiments: [iac-plan-apply-docker]
---

## 스노우플레이크 서버

2015년 어느 회사의 운영 서버. 3년 동안 여러 사람이 SSH 로 들어가 패키지를 깔고, 설정을 고치고, 핫픽스를 붙였다. 아무도 전체를 모른다. 디스크가 죽었다. **다시 만들 수 없다**. 모든 서버가 세상에 하나뿐인 눈송이(snowflake)였다.

IaC(Infrastructure as Code)의 출발점은 단순하다: **인프라를 사람이 만지지 말고, 코드로 정의하고, 도구가 만들게 하라.** 그러면:

| 얻는 것 | 왜 |
|---|---|
| **재현** | 같은 코드 → 같은 인프라. 개발·스테이징·운영이 같은 모양 |
| **리뷰** | 변경이 PR 로 온다. "포트 22 를 0.0.0.0 에 열었다" 가 diff 에 보인다 |
| **감사·이력** | git log 가 "누가 언제 왜" 를 담는다 |
| **재해 복구** | 리전이 죽어도 코드로 다시 세운다. 백업은 데이터만, 인프라는 코드로 |
| **환경 복제** | 프리뷰 환경, 고객별 환경을 변수만 바꿔 |
| **문서** | 코드가 곧 현재 상태의 문서(단, 드리프트가 없을 때만 — [06 노트](/iac/notes/06-drift-policy-testing)) |
| **테스트** | plan 으로 변경을 미리 보고, 정책으로 금지 사항을 자동 검사 |

## 명령형 vs 선언형

```bash
# 명령형: "어떻게" — 순서대로 실행
aws ec2 run-instances --image-id ami-123 --count 1
aws ec2 create-security-group --group-name web
aws ec2 authorize-security-group-ingress --group-name web --port 443
# 두 번 실행하면? 인스턴스 2개, 그룹 중복 오류.
# 인스턴스가 이미 있는데 포트만 바꾸려면? 다른 스크립트.
```

```hcl
# 선언형: "무엇" — 바라는 최종 상태
resource "aws_instance" "web" { ami = "ami-123", instance_type = "t3.small" }
resource "aws_security_group" "web" {
  ingress { from_port = 443, to_port = 443, protocol = "tcp", cidr_blocks = ["0.0.0.0/0"] }
}
# 두 번 적용하면? "No changes". 포트를 바꾸면? 도구가 차이만 적용.
```

선언형 도구는 **현재 상태를 알아내고(refresh) → 바라는 상태와 비교(diff) → 차이만 적용(apply)** 한다. 이 "조정 루프" 가 Kubernetes 컨트롤러([K8s 노트 01](/kubernetes/notes/01-kubernetes-overview))·ArgoCD([GitOps](/kubernetes/notes/13-gitops-progressive-delivery))·Terraform 의 공통 심장이다. 차이는 **누가 언제 루프를 돌리느냐**: k8s 는 컨트롤러가 계속, Terraform 은 사람이/CI 가 `apply` 할 때.

| | 명령형 (스크립트, Ansible 의 일부) | 선언형 (Terraform, k8s, CloudFormation) |
|---|---|---|
| 표현 | 절차 | 최종 상태 |
| 재실행 | 위험(중복·오류) | 안전(멱등) |
| 변경 | 새 절차 작성 | 선언 수정 → 도구가 diff |
| 삭제 | 직접 지워야 | 선언에서 빼면 도구가 삭제(**prune**) |
| 디버깅 | 어디서 멈췄는지 | 왜 이 diff 인지 |
| 적합 | 일회성 작업, 복잡한 순서 | 지속 관리되는 인프라 |

## 멱등성 — 자동화의 전제

**멱등**(idempotent) = 한 번 적용하나 열 번 적용하나 결과가 같다. 멱등하지 않으면 재시도가 위험하고, 재시도가 위험하면 자동화를 믿을 수 없다. 선언형 도구는 설계상 멱등하다. 명령형 스크립트를 멱등하게 만들려면 모든 단계에 "이미 있으면 건너뜀" 을 넣어야 한다(Ansible 모듈이 하는 일).

실험 `iac-plan-apply-docker` 는 같은 코드로 두 번째 `plan` 이 **No changes** 인 것을 보여 준다. 그리고 `name` 을 바꾸면 "must be replaced" — 멱등하지만 **무해하지는 않다**. plan 을 읽는 이유.

같은 개념이 다른 곳에도: Kafka 멱등 프로듀서([전달 보장](/kafka/notes/04-delivery-guarantees)), HTTP PUT, 멱등 소비자, `kubectl apply`.

## 가변 vs 불변 인프라

| | 가변 (mutable) | 불변 (immutable) |
|---|---|---|
| 변경 방법 | 기존 서버에 SSH/Ansible 로 패치 | **새 이미지로 교체**, 기존은 폐기 |
| 드리프트 | 쌓인다 | 구조적으로 없다(서버를 안 만지니까) |
| 롤백 | 어렵다(역패치) | 이전 이미지로 교체 |
| 디버깅 | 서버에 들어가 본다 | 로그·메트릭으로(서버는 소모품) |
| 대표 | VM + 구성 관리(Chef/Puppet/Ansible) | 컨테이너, AMI 베이킹(Packer), k8s |

컨테이너가 불변 인프라의 대중화다: 이미지를 바꾸지 않고 **새로 빌드해 교체**한다. [Docker 노트](/docker/notes/03-images-dockerfile) 의 레이어·태그, [K8s 롤링 업데이트](/kubernetes/notes/07-deploy-resources). "Pets vs Cattle" — 이름 붙인 애완동물이 아니라 번호 붙은 가축.

IaC 는 이 두 층을 모두 다룬다: **인프라 층**(네트워크·클러스터·DB 인스턴스·IAM) 은 Terraform 이 선언적으로, **워크로드 층**(컨테이너) 은 이미지 교체 + k8s 매니페스트. 경계는 [07 노트](/iac/notes/07-provider-kubernetes-docker) 에서.

## 도구 지형

| 도구 | 방식 | 범위 | 특징 |
|---|---|---|---|
| **Terraform / OpenTofu** | 선언형, HCL, state 파일 | 모든 클라우드·SaaS(프로바이더 수천 개) | 사실상 표준. OpenTofu 는 2023 라이선스 변경 후 Linux Foundation 포크(호환) |
| **Pulumi** | 선언형(결과), **범용 언어**(TS/Python/Go) | Terraform 프로바이더 재사용 | 루프·타입·테스트가 언어 것. 개발자 친화 |
| **CloudFormation / CDK** | 선언형(YAML) / CDK 는 언어 → CFN | AWS 전용 | 상태를 AWS 가 관리. 느림, 롤백 자동 |
| **Bicep / ARM** | 선언형 | Azure 전용 | |
| **Ansible** | 명령형+멱등 모듈, 에이전트 없음(SSH) | VM 구성 관리, 네트워크 장비 | 서버 **안**을 다룬다. Terraform 과 보완 |
| **Chef / Puppet / Salt** | 구성 관리(에이전트) | VM | 불변 인프라 시대에 축소 |
| **Packer** | 이미지 베이킹 | AMI/컨테이너 | 불변 이미지 생산 |
| **Kubernetes 매니페스트 + Helm/Kustomize** | 선언형 | k8s 안 | 워크로드 층의 IaC — [K8s 노트](/kubernetes/notes/07-deploy-resources) |
| **Crossplane** | k8s CRD 로 클라우드 리소스 | 모든 것 | "k8s API 로 Terraform 을" — [08 노트](/iac/notes/08-alternatives-design) |
| **docker compose** | 선언형(YAML) | 단일 호스트 컨테이너 | 로컬 개발의 IaC |

이 시리즈는 **Terraform/OpenTofu** 를 중심으로 한다(가장 널리 쓰이고, 개념이 다른 도구에 그대로 옮겨진다).

## 예시로 보기 — 이 프로젝트가 이미 쓰는 IaC

| 파일 | 도구 | 선언하는 것 |
|---|---|---|
| `docker-compose.yml` | Compose | Redis·Kafka·PG·관측 스택·Nginx·Connect (프로파일로 선택) |
| `Dockerfile` | Docker | 앱 이미지(불변 아티팩트) |
| `k8s/` (kustomize) | Kubernetes | Redis StatefulSet, web Deployment, Service |
| `k8s/argocd/application.yaml` | ArgoCD | "이 저장소의 k8s/ 를 클러스터와 동기화" — **IaC 의 IaC** |
| `k8s/rollouts/web-rollout.yaml` | Argo Rollouts | 카나리 전략 |
| `observability/*.yml` | Prometheus/Alertmanager/Grafana 프로비저닝 | 규칙·라우팅·대시보드 |
| `.github/workflows/ci.yml` | GitHub Actions | 파이프라인 |
| `package.json` scripts (`k8s:cluster`, `k8s:monitoring`) | **셸 명령** | kind 클러스터, Helm 설치 — 여기가 **명령형**으로 남은 부분 |

마지막 줄이 과제다. `kind create cluster` + `helm install kps` 는 두 번 실행하면 실패하거나 중복된다. [07 노트](/iac/notes/07-provider-kubernetes-docker) 에서 이것을 Terraform(`kind` 프로바이더 + `helm` 프로바이더)으로 옮겨 `tofu apply` 한 번에 클러스터·모니터링·앱이 올라오고, 두 번째는 No changes 가 되게 만든다.

## IaC 가 만드는 새 위험

- **블라스트 반경**: `terraform destroy` 한 줄이 전부를 지운다. 실수도 코드처럼 빠르고 넓다 → 환경 분리, `prevent_destroy`, 리뷰, 권한 최소화.
- **state 가 비밀을 담는다** → [05 노트](/iac/notes/05-state-management-deep).
- **드리프트**: 코드 밖에서 바꾸면 코드가 거짓말이 된다 → [06 노트](/iac/notes/06-drift-policy-testing).
- **프로바이더 공급망**: 프로바이더 바이너리는 서명 검증되지만(`.terraform.lock.hcl` 의 해시), 모듈 레지스트리는 공급망 — 버전 고정·소스 검토 — [보안 05](/security/notes/05-container-supply-chain).

## 실전에서는 어디에 쓰이나 — IaC 지도

> IaC 는 클라우드 계정·네트워크·클러스터·DB 같은 인프라를 코드로 선언해 리뷰·재현·감사가 가능하게 만드는 일이다. 콘솔에서 손으로 만든 "눈송이" 를 없애고, 환경 복제와 재해 복구를 PR 하나와 apply 한 번으로 바꾸는 것이 실무의 목적이다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 새 서비스의 DB·버킷·DNS 만들기 | HCL, 프로바이더, plan 기호 읽기 | [Terraform 핵심 모델](/iac/notes/02-terraform-core-model) |
| 개발·스테이징·운영을 같은 모양으로 | 변수, `for_each`, tfvars, validation | [변수·출력·표현식](/iac/notes/03-variables-expressions) |
| 여러 팀이 같은 규약으로 인프라 생성 | 모듈 인터페이스, 버전 고정, 얇은 래퍼 | [모듈 설계와 레지스트리](/iac/notes/04-modules-registry) |
| CI 가 apply 하는 팀 협업 | 원격 백엔드·잠금, import·moved, 환경 분리 | [상태 관리 심화](/iac/notes/05-state-management-deep) |
| 금융·공공의 보안·컴플라이언스 | 드리프트 감시, OPA 정책, PR plan 코멘트 | [드리프트·정책·테스트](/iac/notes/06-drift-policy-testing) |
| 쿠버네티스 플랫폼 부트스트랩 | 클러스터 + Helm + ArgoCD 경계 | [Kubernetes·Docker 프로바이더](/iac/notes/07-provider-kubernetes-docker) |
| 멀티 계정·셀프서비스·DR 리허설 | Pulumi·Crossplane 비교, 거버넌스, 재현 연습 | [대안과 설계](/iac/notes/08-alternatives-design) |

**회사 규모에 따라** — 스타트업은 콘솔 클릭으로 시작했다가 두 번째 환경이 필요해질 때 루트 모듈 하나와 원격 state 로 옮기며, 관리형 서비스 위주라 리소스 수가 적다.
성장기에는 환경·계층별로 state 를 나누고, PR 에 plan 코멘트·보호된 apply·정책 검사를 붙이며 공용 모듈을 만든다.
대규모 조직에서는 플랫폼 팀이 계정 생성 자동화·모듈 카탈로그·골든 패스를 제공하고, 태깅·비용·보안 규칙을 파이프라인과 조직 정책으로 강제하며 드리프트 감시와 DR 리허설을 정기 운영한다.

**이럴 땐 안 맞는다**
- 한 번 쓰고 버릴 실험 리소스 → 코드화 비용이 더 크다. 대신 지우는 것을 잊지 않게 수명 태그를 단다.
- 서버 안의 패키지·설정 구성 → Terraform 의 영역이 아니다. 이미지 베이킹(Packer, Dockerfile)이나 Ansible 로.
- 하루에도 여러 번 바뀌는 앱 배포 → 인프라 IaC 로 하면 느리다. 워크로드는 GitOps(ArgoCD)로.

**누가 매일 만나나** — 플랫폼·SRE·DevOps 엔지니어는 매일 plan 을 읽고 apply 를 승인하고, 백엔드 개발자는 새 큐·버킷·DB 가 필요할 때 모듈 호출 PR 을 올리며, 보안 엔지니어는 정책 위반 리포트를 본다.

## 실습 체크리스트

- [ ] 실험 `iac-plan-apply-docker` 를 돌리고 plan 출력의 `+`, `No changes`, `must be replaced` 를 각각 설명
- [ ] `package.json` 의 `k8s:cluster` 스크립트를 두 번 실행하면 무슨 일이 생기는지 확인(명령형의 비멱등)
- [ ] 이 프로젝트의 compose 파일에서 "선언" 과 "명령"(command/entrypoint) 부분을 구분해 보기
- [ ] 내가 손으로 만든 리소스(클라우드 콘솔·`docker run`) 를 하나 떠올리고, 그것이 사라지면 재현 가능한지 자문
- [ ] 명령형 스크립트 하나를 멱등하게 고치려면 각 줄에 어떤 조건이 필요한지 적어 보기
