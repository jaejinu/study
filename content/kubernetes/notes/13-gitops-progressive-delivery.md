---
title: 심화 — GitOps(ArgoCD) 와 점진적 배포(Argo Rollouts)
order: 13
level: 심화
summary: GitOps 의 원칙(선언·버전·자동 pull·지속 조정), ArgoCD 의 Application·동기화·헬스·드리프트, 저장소 구조(앱 vs 환경), 이미지 태그 갱신 자동화, Argo Rollouts 로 카나리·블루그린과 메트릭 기반 자동 판정, 시크릿 관리, 멀티 클러스터
tags: [GitOps, ArgoCD, Argo Rollouts, 카나리, 블루그린, 드리프트, Flux]
experiments: [k8s-rolling-update]
---

## GitOps 4원칙

1. **선언적**: 원하는 상태를 매니페스트로.
2. **버전 관리**: git 이 유일한 진실. 변경 = 커밋 = 리뷰 = 이력.
3. **자동 pull**: 클러스터 안의 에이전트가 git 을 당겨 적용 (CI 가 `kubectl apply` 를 push 하지 않음 → CI 에 클러스터 자격 증명 불필요).
4. **지속 조정**: 클러스터 상태가 git 과 다르면(드리프트) 되돌리거나 알림.

[GitHub Actions 노트](/github-actions/notes/03-secrets-deploy) 의 "CI 가 kubectl set image" 방식은 push 모델. GitOps 는 CI 가 **매니페스트 저장소의 태그를 바꾸는 커밋**만 하고, 배포는 ArgoCD/Flux 가 한다.

## ArgoCD

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd port-forward svc/argocd-server 18443:443        # https://localhost:18443
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: study, namespace: argocd }
spec:
  project: default
  source:
    repoURL: https://github.com/jaejinu/study
    targetRevision: main
    path: k8s                                   # kustomize 디렉터리
    kustomize: { buildOptions: "--load-restrictor LoadRestrictionsNone" }
  destination: { server: https://kubernetes.default.svc, namespace: study }
  syncPolicy:
    automated: { prune: true, selfHeal: true }   # git 에서 지우면 삭제, 드리프트 자동 복구
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
```

- **Sync 상태**: Synced / OutOfSync(git ≠ 클러스터). **Health**: Healthy / Progressing / Degraded(리소스별 헬스 평가: Deployment 는 가용 복제본, Rollout 은 분석 결과).
- **드리프트**: 누가 `kubectl edit` 로 바꾸면 OutOfSync → `selfHeal` 이 되돌린다. "운영 핫픽스는 git 으로" 가 강제된다.
- **App of Apps / ApplicationSet**: 환경·클러스터·팀별 Application 을 생성기(list, git 디렉터리, 클러스터)로 자동 생성.
- Flux 는 같은 역할의 CNCF 대안(Kustomization, HelmRelease CRD, 더 GitOps 순수주의, UI 는 Weave 별도).

## 저장소 구조

```
app 저장소 (코드)                 manifests 저장소 (배포)
  src/, Dockerfile, CI ──build──▶   apps/study/base/      (Deployment, Service …)
                                    apps/study/overlays/dev/   kustomization.yaml (images: tag=sha-abc123)
                                    apps/study/overlays/prod/  kustomization.yaml (images: tag=v1.4.2)
                                    clusters/prod/            ApplicationSet
```

- 코드와 배포를 분리하면 "배포 승인 = 매니페스트 PR 리뷰" 가 된다.
- 이미지 태그 갱신 자동화: CI 가 `kustomize edit set image study=ghcr.io/…:sha-abc` 커밋 + PR, 또는 **ArgoCD Image Updater** / Flux Image Automation 이 레지스트리를 감시해 커밋.

## Argo Rollouts — 점진적 배포

Deployment 를 **Rollout** 으로 바꾸면 카나리·블루그린을 선언하고, Prometheus 메트릭으로 **자동 판정·롤백**한다.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: web, namespace: study }
spec:
  replicas: 4
  selector: { matchLabels: { app: web } }
  template: { … Deployment 와 동일 … }
  strategy:
    canary:
      canaryService: web-canary          # 트래픽 라우팅 (Nginx Ingress / Gateway API / Istio)
      stableService: web
      trafficRouting: { nginx: { stableIngress: web } }
      steps:
        - setWeight: 10
        - pause: { duration: 2m }
        - analysis: { templates: [{ templateName: success-rate }] }   # 메트릭 판정
        - setWeight: 50
        - pause: { duration: 5m }
        - setWeight: 100
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: { name: success-rate, namespace: study }
spec:
  metrics:
    - name: success-rate
      interval: 1m
      count: 3
      successCondition: result[0] >= 0.99
      failureLimit: 1
      provider:
        prometheus:
          address: http://kps-kube-prometheus-stack-prometheus.monitoring:9090
          query: |
            sum(rate(traces_spanmetrics_calls_total{service="study-app", status_code!="STATUS_CODE_ERROR"}[2m]))
            / sum(rate(traces_spanmetrics_calls_total{service="study-app"}[2m]))
```

```bash
kubectl argo rollouts get rollout web -n study --watch
kubectl argo rollouts promote web -n study        # 수동 승격
kubectl argo rollouts abort web -n study          # 롤백
```

- 블루/그린: `strategy.blueGreen` + `previewService`, `autoPromotionEnabled: false` 로 수동 전환.
- Flagger(Flux 진영) 가 같은 역할.
- 메트릭은 [관측성](/observability/notes/02-prometheus-promql) 이 있어야 의미 — span metrics 로 코드 계측 없이 성공률을 얻는 예.

## 시크릿

git 에 평문 시크릿은 금지. 선택지:
- **Sealed Secrets**: 공개키로 암호화한 SealedSecret 을 커밋, 클러스터의 컨트롤러가 복호화.
- **SOPS + age/KMS**: 파일을 암호화해 커밋, ArgoCD/Flux 플러그인이 복호화.
- **External Secrets Operator**: Vault/AWS Secrets Manager 참조만 커밋, 클러스터가 가져와 Secret 생성 (추천).

## 멀티 클러스터·환경

- ArgoCD 하나가 여러 클러스터를 관리(hub-spoke) 또는 클러스터마다 ArgoCD(격리). ApplicationSet 의 cluster 생성기.
- 승격: dev overlay 태그 → PR 로 prod overlay 에 복사. 환경 간 차이는 overlay 패치로만.
- 비상 롤백: git revert → 자동 동기화. 수 분 안에 끝나야 한다 — 그래서 이미지는 레지스트리에 남겨 둔다.

## 이 프로젝트에 적용된 것

```bash
pnpm k8s:argocd            # ArgoCD 설치 + argocd-cm 에 kustomize buildOptions(load-restrictor) + Application(study) 적용
pnpm k8s:argocd:password   # admin 비밀번호
pnpm k8s:argocd:port       # https://localhost:18443 (자체 서명 인증서 경고 무시)
kubectl -n argocd get application study          # SYNC STATUS Synced / HEALTH Healthy
pnpm k8s:rollouts          # Argo Rollouts 설치 + web-canary Rollout(복제본 4, 25%→50%→100%, Prometheus 분석)
pnpm k8s:rollouts:watch
```

- `k8s/argocd/application.yaml`: `automated.prune/selfHeal`, `ignoreDifferences` 로 HPA/Rollouts 가 바꾸는 replicas 는 드리프트로 보지 않는다.
- `k8s/rollouts/web-rollout.yaml`: Ingress 없이 **복제본 비율**로 카나리. AnalysisTemplate 은 kube-prometheus-stack 의 Prometheus 에서 `study_redis_up` 과 타깃 `up` 을 본다 — 실패하면 자동 롤백.
- 드리프트 실험: `kubectl -n study set env deploy/web DRIFT=1` 로 git 에 없는 env 를 넣으면 수 초~3분 안에 ArgoCD 가 지운다 (기본 폴링 3분, 웹훅 연결 시 즉시). **replicas 는 `ignoreDifferences` 에 있어서 `scale` 로는 드리프트가 생기지 않는다** — HPA/Rollouts 와 싸우지 않기 위한 의도적 예외.
- Argo Rollouts 의 CRD 는 커서 `kubectl apply` 의 어노테이션 한도(256KB)를 넘는다. `kubectl apply --server-side` 로 설치해야 한다(`pnpm k8s:rollouts` 에 반영).

## 실습 체크리스트

- [ ] kind 에 ArgoCD 를 설치하고 이 저장소 `k8s/` 를 Application 으로 등록, Synced/Healthy 확인
- [ ] `kubectl -n study set env deploy/web DRIFT=1` 로 드리프트를 만들고 selfHeal 이 되돌리는지 보기 (`scale` 은 왜 드리프트가 아닌지 설명해 보기)
- [ ] Argo Rollouts 를 설치해 web 을 Rollout 으로 바꾸고 `setWeight: 50` 에서 pause 되는지 확인
- [ ] AnalysisTemplate 을 kube-prometheus-stack 에 연결해 자동 판정 돌려 보기
