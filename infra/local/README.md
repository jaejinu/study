# infra/local — 로컬 인프라를 OpenTofu 로

`pnpm k8s:cluster`/`k8s:up` 셸 스크립트의 선언형 버전 (IaC 노트 07). 단계별 디렉터리 = 단계별 state.

| 단계 | 디렉터리 | 만드는 것 | 명령 |
|---|---|---|---|
| 1 | `10-cluster` | kind 클러스터 `study-tf` (tehcyx/kind) | `pnpm tf:cluster init && pnpm tf:cluster apply` |
| 2 | `20-platform` | 네임스페이스 `study-tf`, Redis ConfigMap·Deployment·Service (hashicorp/kubernetes) | `pnpm tf:platform init && pnpm tf:platform apply` |

- 두 번째 `apply` 는 **No changes** 여야 한다. `terraform.tfvars` 로 `redis_maxmemory` 를 바꾸면 ConfigMap 과 Pod(해시 어노테이션)만 바뀐다.
- 정리는 역순: `pnpm tf:platform destroy` → `pnpm tf:cluster destroy`.
- 기존 `kind-study` 클러스터(ArgoCD 가 `k8s/` 를 동기화)와는 분리돼 있다 — 한 리소스에 소유자는 하나.
- 실험 `iac-local-stack` 이 이 두 단계를 자동으로 돌리고 멱등성·드리프트(ConfigMap 수정)·destroy 까지 확인한다.
