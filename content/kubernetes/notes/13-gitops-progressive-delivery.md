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
- 드리프트 실험 (직접 해 본 결과):
  - `kubectl -n study set env deploy/web REDIS_URL=redis://wrong:6379` 처럼 **git 에 있는 값을 바꾸면** 다음 조정(수동 refresh 또는 3분 폴링)에서 OutOfSync → selfHeal 이 **5초 안에** 되돌렸다.
  - `kubectl -n study set env deploy/web DRIFT=1` 처럼 **git 에 없는 필드를 추가하면** ArgoCD 는 계속 Synced 다. 3-way diff(desired · live · last-applied)는 "desired 에도 last-applied 에도 없는 live 필드" 를 다른 컨트롤러/웹훅/기본값이 넣은 것으로 보고 무시하기 때문이다. 추가 드리프트까지 잡으려면 `argocd.argoproj.io/compare-options: ServerSideDiff=true` 같은 옵션이나 정책 엔진(Kyverno/OPA)이 필요하다.
  - `kubectl scale` 은 `ignoreDifferences` 에 replicas 가 있어서 드리프트가 아니다 — HPA/Rollouts 와 싸우지 않기 위한 의도적 예외.
- Argo Rollouts 의 CRD 는 커서 `kubectl apply` 의 어노테이션 한도(256KB)를 넘는다. `kubectl apply --server-side` 로 설치해야 한다(`pnpm k8s:rollouts` 에 반영).
- 카나리 실측: `study:dev2` 로 바꾸자 25%(1/4) → 60초 pause → AnalysisRun(`target-up`, `app-redis-up` 각 3/3 Successful) → 50% → 60초 → 100%, 약 3분에 Healthy. 분석이 실패하면 같은 경로로 자동 롤백된다.

## 실전에서는 어디에 쓰이나

> GitOps 는 배포 기록을 "누가 kubectl 을 쳤나" 에서 "어떤 커밋이 머지됐나" 로 바꾼다. 여러 팀·여러 클러스터·감사 요구가 있는 조직에서 사실상 기본 방식이 됐고, 점진적 배포는 그 위에 메트릭 판정을 얹는다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 규제 산업(핀테크·공공) | 배포 승인·감사 이력 | 매니페스트 저장소 PR 리뷰 = 배포 승인, ArgoCD 동기화 | CI 가 `kubectl apply` push — CI 에 클러스터 자격 증명 |
| 리전별 클러스터를 둔 SaaS | 수십 개 클러스터에 같은 앱 일관 배포 | ApplicationSet 클러스터 생성기 | 클러스터마다 별도 파이프라인 |
| 운영 중 손으로 바꾼 설정 | 드리프트 감지·복구 | `selfHeal`, OutOfSync 알림 | 주기적 diff 스크립트 |
| 커머스 결제 경로 신규 버전 | 오류율이 오르면 자동 롤백 | Argo Rollouts 카나리 + Prometheus AnalysisTemplate | 사람이 대시보드 보며 판단 |
| 장애 시 롤백 | 수 분 안에 이전 상태로 | `git revert` → 자동 동기화 | `rollout undo` — git 과 어긋난다 |

**이럴 땐 안 맞는다**
- 클러스터 하나, 서비스 몇 개, 배포 담당 한 명 → ArgoCD 운영이 오히려 부담이다. CI 의 `helm upgrade`·`kubectl apply` 로 충분하다.
- 성공률 지표 없이 카나리 → 판정할 메트릭이 없으면 자동 롤백은 의미가 없다. 관측을 먼저 갖춘다.

**누가 매일 만나나** — 앱 개발자는 이미지 태그 PR 을 올리고 Sync/Health 상태를 본다. 플랫폼 팀은 ArgoCD·Rollouts 를 운영하고, SRE 는 분석 실패로 롤백된 카나리의 원인을 조사한다.

**면접·실무 단골 질문**
- Q. push 배포와 GitOps(pull) 의 차이는? → CI 가 클러스터 자격 증명을 갖고 밀어 넣느냐, 클러스터 안 에이전트가 git 을 당겨 지속 조정(드리프트 복구)하느냐.

## 실습 체크리스트

- [ ] kind 에 ArgoCD 를 설치하고 이 저장소 `k8s/` 를 Application 으로 등록, Synced/Healthy 확인
- [ ] `kubectl -n study set env deploy/web REDIS_URL=redis://wrong:6379` 로 드리프트를 만들고 selfHeal 이 되돌리는지 보기. 새 env 를 *추가*하면 왜 Synced 그대로인지 설명해 보기
- [ ] Argo Rollouts 를 설치해 web 을 Rollout 으로 바꾸고 `setWeight: 50` 에서 pause 되는지 확인
- [ ] AnalysisTemplate 을 kube-prometheus-stack 에 연결해 자동 판정 돌려 보기
