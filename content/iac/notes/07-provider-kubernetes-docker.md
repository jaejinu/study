---
title: "Kubernetes·Docker 프로바이더로 이 프로젝트 코드화 — kind, Helm, 역할 분담"
order: 7
level: 심화
summary: "package.json 의 명령형 스크립트(kind create, helm install, kubectl apply)를 Terraform 으로 옮기는 과정 — kind 프로바이더로 클러스터, kubernetes/helm 프로바이더로 네임스페이스·kube-prometheus-stack·Redis, 프로바이더 설정의 의존 문제(클러스터가 생기기 전의 kubeconfig)와 해결, kubernetes_manifest 와 CRD 타이밍, Helm 값 관리, 그리고 '어디까지 Terraform 이고 어디부터 ArgoCD 인가' 의 경계 설계, Kustomize·Helm·Terraform 의 역할 비교, 흔한 함정"
tags: [kind, helm 프로바이더, kubernetes 프로바이더, kubernetes_manifest, ArgoCD, 경계, Kustomize, 부트스트랩]
experiments: [iac-plan-apply-docker, iac-drift-detect, iac-local-stack]
---

## 지금: 명령형 스크립트

```json
"k8s:cluster":    "kind create cluster --name study --config k8s/kind-config.yaml",
"k8s:metrics":    "kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/... && kubectl patch ...",
"k8s:monitoring": "helm repo add prometheus-community ... && helm upgrade --install kps prometheus-community/kube-prometheus-stack -n monitoring --create-namespace -f k8s/monitoring/values.yaml",
"k8s:up":         "kubectl apply -k k8s/",
"k8s:argocd":     "kubectl create ns argocd && kubectl apply -n argocd -f https://.../install.yaml"
```

문제: 순서를 사람이 기억해야 하고, 두 번 실행하면 일부가 실패하며(`create cluster` 는 이미 있으면 에러, `create ns` 도), 무엇이 설치돼 있는지는 클러스터를 조회해야 안다. **"무엇"** 을 선언하고 **멱등**하게 만들자.

## 목표: `tofu apply` 한 번

```
infra/local/
  versions.tf        프로바이더: kind, kubernetes, helm, docker
  cluster.tf         kind_cluster.study
  platform.tf        네임스페이스, metrics-server(helm), kube-prometheus-stack(helm), ArgoCD(helm)
  bootstrap.tf       ArgoCD Application "study" (kubernetes_manifest) — 여기서 손을 뗀다
  variables.tf  outputs.tf  terraform.tfvars
```

### 1. 클러스터 — kind 프로바이더

```hcl
terraform {
  required_providers {
    kind       = { source = "tehcyx/kind",          version = "~> 0.7" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
    helm       = { source = "hashicorp/helm",       version = "~> 2.15" }
    docker     = { source = "kreuzwerker/docker",   version = "~> 3.0" }
  }
}

resource "kind_cluster" "study" {
  name            = "study"
  node_image      = "kindest/node:v1.31.2"
  wait_for_ready  = true
  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"
    node {
      role = "control-plane"
      extra_port_mappings { container_port = 30080, host_port = 18090 }   # NodePort → 호스트
    }
    node { role = "worker" }
    node { role = "worker" }
  }
}
output "kubeconfig_path" { value = kind_cluster.study.kubeconfig_path }
```

### 2. 프로바이더 설정의 의존 — "클러스터가 생기기 전엔 kubeconfig 가 없다"

```hcl
provider "kubernetes" {
  host                   = kind_cluster.study.endpoint
  client_certificate     = kind_cluster.study.client_certificate
  client_key             = kind_cluster.study.client_key
  cluster_ca_certificate = kind_cluster.study.cluster_ca_certificate
}
provider "helm" {
  kubernetes {
    host                   = kind_cluster.study.endpoint
    client_certificate     = kind_cluster.study.client_certificate
    client_key             = kind_cluster.study.client_key
    cluster_ca_certificate = kind_cluster.study.cluster_ca_certificate
  }
}
```

프로바이더 설정이 **리소스 속성을 참조**하는 이 패턴은 동작하지만 유명한 함정이 있다:
- 첫 plan 에서 값이 `(known after apply)` 라 kubernetes 프로바이더가 "설정 불완전" 으로 **실패하거나 데이터 소스를 못 읽는다**. `kubernetes_manifest` 는 plan 시점에 클러스터에 접속해 스키마를 가져오므로 **클러스터가 없으면 plan 자체가 안 된다**.
- `destroy` 때 클러스터가 먼저 사라지면 그 위의 리소스 삭제가 실패한다.

**해법: state 를 둘로 나눈다** — `10-cluster`(kind) 와 `20-platform`(kubernetes/helm, `terraform_remote_state` 또는 kubeconfig 파일 경로로 연결). [05 노트](/iac/notes/05-state-management-deep) 의 계층 분할이 여기서 필연이 된다. 단일 state 로 가려면 `kubernetes_manifest` 를 피하고(Helm 또는 `kubectl_manifest` 프로바이더 사용) 첫 apply 를 `-target=kind_cluster.study` 로 두 단계로.

### 3. 플랫폼 — Helm 프로바이더

```hcl
resource "kubernetes_namespace_v1" "monitoring" { metadata { name = "monitoring" } }

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.12.2"
  namespace  = "kube-system"
  set { name = "args[0]", value = "--kubelet-insecure-tls" }     # kind 전용
}

resource "helm_release" "kps" {
  name       = "kps"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  version    = "65.1.1"
  namespace  = kubernetes_namespace_v1.monitoring.metadata[0].name
  values     = [file("${path.module}/../../k8s/monitoring/values.yaml")]   # 기존 values 재사용
  set_sensitive { name = "grafana.adminPassword", value = var.grafana_password }
  timeout    = 600
  wait       = true
}

resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = "7.6.12"
  namespace        = "argocd"
  create_namespace = true
  values = [yamlencode({
    configs = { params = { "server.insecure" = true } }
    server  = { service = { type = "NodePort", nodePortHttp = 30080 } }
  })]
}
```

- `values` 파일을 기존 `k8s/monitoring/values.yaml` 과 **공유**하면 `pnpm k8s:monitoring` 과 Terraform 이 같은 설정을 쓴다(이행기).
- `set_sensitive` 로 비밀번호는 plan 에서 가려짐. 값은 `TF_VAR_grafana_password`.
- Helm 차트 버전을 **고정**. `helm_release` 는 차트 값의 diff 를 보여 주지만 차트가 만든 리소스 내부의 드리프트는 못 본다(Helm 의 한계) — 그것은 ArgoCD 가 더 잘 본다.
- CRD 를 설치하는 차트(kps, ArgoCD) 뒤에 그 CRD 의 커스텀 리소스를 `kubernetes_manifest` 로 만들면 **plan 시점에 CRD 가 없어 실패**. `depends_on` 만으로는 부족(plan 에서 스키마 조회) → 별도 apply 단계, 또는 `kubectl_manifest`(gavinbunney) 프로바이더(스키마 조회 없이 서버 사이드 apply).

### 4. 부트스트랩 — ArgoCD 에게 넘기는 지점

```hcl
# 20-platform/bootstrap.tf  (CRD 가 있는 2단계 state)
resource "kubernetes_manifest" "app_study" {
  manifest = yamldecode(file("${path.module}/../../k8s/argocd/application.yaml"))
  depends_on = [helm_release.argocd]
}
```

이 한 리소스가 **Terraform 의 마지막 일**이다. 이후 `k8s/` 의 Redis StatefulSet·web Deployment·Rollout 은 ArgoCD 가 git 에서 동기화한다. Terraform 은 클러스터와 플랫폼(모니터링, ArgoCD, cert-manager, 인그레스 컨트롤러, 네임스페이스·RBAC·쿼터)을, ArgoCD 는 워크로드를.

## 경계 설계 — 어디까지 Terraform, 어디부터 GitOps

| 층 | 도구 | 이유 |
|---|---|---|
| 클라우드 계정·네트워크·IAM·DNS | Terraform | k8s 밖. 변경 드묾, 권한 민감 |
| 클러스터(kind/EKS/GKE)·노드 풀 | Terraform | 클러스터가 있어야 GitOps 가 돈다 |
| 클러스터 애드온(CNI, 메트릭, 인그레스, cert-manager, 모니터링, ArgoCD 자신) | Terraform **또는** ArgoCD(app-of-apps) | 부트스트랩 문제: ArgoCD 가 자신을 설치할 수 없으니 **ArgoCD 까지는 Terraform**, 그 뒤 애드온은 ArgoCD 로 넘기는 팀이 많다 |
| 네임스페이스·RBAC·쿼터·NetworkPolicy 기본 | 둘 다 가능 | 플랫폼 팀 소유면 Terraform, 앱 팀 셀프서비스면 GitOps |
| 애플리케이션 워크로드 | **ArgoCD/Flux** | 배포 빈도 높음, 자동 동기화·헬스·롤백·UI, 개발자가 kubectl/tofu 없이 PR 만 |
| 데이터 스토어(RDS, 관리형 Redis) | Terraform | k8s 밖, prevent_destroy. k8s 안의 StatefulSet 이면 GitOps |

**원칙**: 한 리소스를 **두 도구가 동시에 관리하지 않는다**(서로 되돌리며 싸운다 — ArgoCD 의 `ignoreDifferences`, Terraform 의 `ignore_changes` 는 그 충돌의 완화책). 소유권을 표로 적어 두고, 네임스페이스나 레이블(`managed-by: tofu` / `argocd.argoproj.io/instance`)로 표시.

### Kustomize vs Helm vs Terraform(k8s 프로바이더)

| | Kustomize | Helm | Terraform kubernetes 프로바이더 |
|---|---|---|---|
| 표현 | 순수 YAML + 패치(오버레이) | 템플릿 + values | HCL(타입 있음) |
| 재사용 | base/overlay | 차트(레지스트리 생태계) | 모듈 |
| 상태·드리프트 | 없음(kubectl apply) — ArgoCD 가 보완 | release 기록(차트 레벨) | state(리소스 속성 레벨) |
| 강점 | 단순, 투명, 이 프로젝트의 `k8s/` | 서드파티 설치 표준 | 클러스터 밖 리소스와 **같은 그래프**(IAM ↔ SA, DNS ↔ 인그레스) |
| 약점 | 로직 없음(조건·반복 제한) | 템플릿 디버깅 괴로움 | k8s 매니페스트를 HCL 로 옮기는 비용, CRD 타이밍, 느린 plan |
| 추천 | 자체 앱 매니페스트 | 외부 소프트웨어 | 플랫폼 부트스트랩 + k8s 밖과 엮이는 것 |

셋은 경쟁이 아니라 층이다: Terraform(helm_release) → ArgoCD → Kustomize(앱).

## Docker 프로바이더로 compose 를 대체할까

실험들이 쓴 kreuzwerker/docker 프로바이더로 compose 의 서비스들을 옮길 수 있다([03 노트](/iac/notes/03-variables-expressions) 의 예). 장점: 같은 언어, state 로 드리프트 감지, 변수·정책. 단점: compose 의 `profiles`·`depends_on: condition: service_healthy`·`logs -f` 같은 **개발 편의**가 없다. 결론: **로컬 개발은 compose**, Terraform 은 "코드로 인프라" 를 연습하는 대상(실험)으로. 실제 서버의 단일 호스트 배포라면 Terraform docker 프로바이더도 선택지.

## 흔한 함정

| 함정 | 증상 | 대처 |
|---|---|---|
| 프로바이더가 리소스 출력을 참조 | 첫 plan 실패, destroy 순서 꼬임 | state 분리 / 2단계 apply |
| `kubernetes_manifest` + 같은 apply 의 CRD | "no matches for kind" at plan | 별도 단계, `kubectl_manifest`, Helm 으로 CR 포함 |
| helm_release `wait` 없이 다음 리소스가 의존 | 서비스 준비 전 실패 | `wait = true`, `timeout` 넉넉히, readiness 확인 데이터 소스 |
| Helm 차트가 만든 리소스를 Terraform k8s 리소스로도 선언 | 두 소유자 충돌 | 소유권 하나로 |
| ArgoCD 가 Terraform 리소스를 prune | 네임스페이스/RBAC 가 사라짐 | Application 의 범위를 `k8s/apps` 로 좁히거나 `argocd.argoproj.io/sync-options: Prune=false` |
| kind 의 docker 네트워크·포트 매핑 변경 | 클러스터 교체(ForceNew) → 전부 재생성 | 처음에 포트 계획, `extra_port_mappings` 는 신중히 |
| kubeconfig 를 state/출력에 | 비밀 유출(클라이언트 키) | `sensitive = true`, 로컬 전용, state 암호화 |

## 예시로 보기 — 단계별 이행 계획

1. **(완료)** `infra/local/10-cluster` 에 `kind_cluster` 만(`pnpm tf:cluster apply`, 클러스터 `study-tf`). `20-platform` 에 네임스페이스 + Redis ConfigMap·Deployment·Service(`pnpm tf:platform apply`). 실험 `iac-local-stack` 이 apply → 재 plan No changes → `-var redis_maxmemory=128mb` 로 ConfigMap·Deployment 2개만 change(해시 어노테이션으로 롤아웃) → 역순 destroy 를 끝까지 돌린다. 기존 `kind-study`(ArgoCD 소유)와는 분리 — 한 리소스에 소유자는 하나.
2. `20-platform` 에 metrics-server·kps·ArgoCD(`helm_release`). 기존 `k8s/monitoring/values.yaml` 재사용. `pnpm k8s:monitoring`/`k8s:argocd` 제거.
3. `bootstrap.tf` 로 Application 생성 → `k8s/` 는 그대로 ArgoCD 가 동기화(이미 Synced/Healthy 인 상태를 재현).
4. 환경 점검 카드([IaC 대시보드](/iac))에 `tofu show`/`state list` 결과를 띄워 "코드가 아는 리소스" 와 실제를 비교(드리프트 패널).
5. CI 에 `fmt/validate/checkov` + plan 코멘트. 드리프트 cron 은 로컬 클러스터라 생략(또는 self-hosted runner).

## 실습 체크리스트

- [ ] 실험 `iac-local-stack` 을 돌리고, `infra/local/20-platform/main.tf` 의 `config-hash` 어노테이션을 지운 뒤 변수를 바꿔 Pod 가 재시작되지 **않는** 것을 확인(ConfigMap 만 바뀌고 프로세스는 옛 값)
- [ ] `20-platform` 에 metrics-server 를 `helm_release` 로 설치하고 `kubectl top nodes` 확인
- [ ] kps 를 Terraform 으로 설치하되 기존 values 파일을 재사용, Grafana(13001) 접속
- [ ] ArgoCD 를 helm_release 로 설치 → Application 을 `kubernetes_manifest` 로 만들 때 CRD 타이밍 문제를 **직접 겪고** 해결
- [ ] 소유권 표(리소스 → Terraform/ArgoCD/compose) 를 작성해 두 도구가 겹치는 곳이 없는지
- [ ] `tofu destroy` 로 전부 지우고 다시 `apply` — 재현 시간 측정(재해 복구 리허설)
