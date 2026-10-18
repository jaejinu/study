---
title: Kubernetes 보안 — RBAC, Pod Security, NetworkPolicy, 어드미션, 시크릿 암호화
order: 6
level: 심화
summary: "4C(클라우드·클러스터·컨테이너·코드) 모델, API 서버의 인증→인가(RBAC)→어드미션 파이프라인, ServiceAccount 토큰과 최소 권한·권한 상승 경로(escalate/bind/impersonate, secrets list, pods/exec), Pod Security Standards(privileged/baseline/restricted) 와 네임스페이스 레이블, NetworkPolicy 로 기본 거부·egress 제어, Kyverno/Gatekeeper 로 정책 강제(서명 검증·레이블·리소스 제한), etcd 암호화·감사 로그·kube-bench, 이 프로젝트 kind 클러스터의 점검과 개선"
tags: [Kubernetes, RBAC, ServiceAccount, Pod Security Standards, NetworkPolicy, Kyverno, 어드미션, 감사 로그, kube-bench]
experiments: [sec-k8s-rbac, sec-k8s-networkpolicy]
---

## 4C — 계층마다 책임이 있다

```
[코드]  ─ 의존성·입력 검증·시크릿 미포함        ← 08 노트
[컨테이너] ─ 이미지 스캔·non-root·readOnly·caps ← 05 노트
[클러스터] ─ RBAC·PSS·NetworkPolicy·어드미션·etcd 암호화·감사   ← 이 노트
[클라우드/호스트] ─ 노드 OS·네트워크·IAM·API 서버 노출
```

바깥 계층이 뚫리면 안쪽 통제는 무력하다(노드 root 면 모든 Pod 의 시크릿을 읽는다). 안쪽이 뚫려도 바깥이 막아야 한다(컨테이너 탈출 → 노드에서 할 수 있는 일 제한). 심층 방어.

## API 서버 요청의 세 관문

![Kubernetes 보안 — 세 관문과 4C](/diagrams/sec-k8s-layers.svg)

```
kubectl / Pod 의 SA 토큰 / 컨트롤러
   │
   ▼
[인증] 누구? ── X.509 클라이언트 인증서(kubeconfig), SA 토큰(JWT), OIDC(IdP), 웹훅
   │  실패 → 401 (또는 system:anonymous)
   ▼
[인가] 해도 되나? ── RBAC (Node, Webhook, ABAC 도 있음)
   │  실패 → 403
   ▼
[어드미션] 정책대로인가? ── Mutating(기본값·사이드카 주입) → 스키마 검증 → Validating(PSS, Kyverno, 서명 검증)
   │  실패 → 4xx + 이유
   ▼
etcd 저장
```

실험 `sec-k8s-rbac` 의 마지막 단계가 이것을 보여 준다: 토큰으로 `pods` 는 200, `secrets` 는 **403**(인증은 통과, 인가에서 거부), 토큰 없이는 401/403.

## RBAC 제대로 쓰기

| 객체 | 범위 | 내용 |
|---|---|---|
| `Role` / `ClusterRole` | 네임스페이스 / 클러스터 | 규칙: `apiGroups × resources × verbs` (+ `resourceNames`) |
| `RoleBinding` / `ClusterRoleBinding` | 네임스페이스 / 클러스터 | 주체(User, Group, ServiceAccount) ↔ Role |

- **허용 목록만 있다.** 거부 규칙이 없으니 "모든 것 빼고 X" 는 못 쓴다 → 작은 Role 을 여러 개.
- `ClusterRole` 을 `RoleBinding` 으로 묶으면 **그 네임스페이스에서만** 유효 — 공통 Role 재사용 패턴.
- 내장 ClusterRole: `view`(읽기, 시크릿 제외), `edit`(쓰기, RBAC 제외), `admin`(네임스페이스 관리), `cluster-admin`(전부). 사람에게는 `view/edit` 부터.
- **점검 명령**: `kubectl auth can-i --list --as=...`, `kubectl who-can`(플러그인), `rbac-lookup`, `kubectl get clusterrolebinding -o wide | grep cluster-admin`.

### 권한 상승 경로 — 이 동사들은 사실상 admin 이다

| 권한 | 왜 위험한가 |
|---|---|
| `secrets` **list/get** | 네임스페이스의 모든 시크릿(SA 토큰 포함) → 다른 SA 로 위장 |
| `pods/exec`, `pods/attach` | 어떤 Pod 든 들어감 → 그 Pod 의 SA 토큰·시크릿 |
| `pods` **create** (+ hostPath/privileged 허용) | 노드 루트 파일시스템 마운트 → 노드 장악 |
| `serviceaccounts/token` create | 임의 SA 토큰 발급 |
| `roles/rolebindings` **escalate / bind** | 자기보다 큰 권한 부여 |
| `users/groups` **impersonate** | `--as=cluster-admin` |
| `nodes/proxy`, `pods/portforward` | 노드/Pod 네트워크 접근 |
| `daemonsets` create | 모든 노드에 Pod |
| `certificatesigningrequests` approve | 클라이언트 인증서 발급 |
| `mutatingwebhookconfigurations` | 모든 객체를 변조 |

"CI 에 `edit` 만 줬는데" — `edit` 에는 `secrets` 와 `pods/exec` 가 들어 있다. 실제로는 `deployments` 의 `patch` 만 필요한 경우가 대부분이다.

### ServiceAccount 위생

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: web, namespace: study }
automountServiceAccountToken: false      # API 를 안 쓰는 앱은 토큰 자체를 마운트하지 않는다
---
# Pod 에서 꼭 필요하면 projected 토큰 (짧은 수명·audience 지정)
volumes:
  - name: token
    projected:
      sources:
        - serviceAccountToken: { audience: vault, expirationSeconds: 3600, path: token }
```

- 앱마다 전용 SA. `default` SA 에 권한을 주면 그 네임스페이스의 **모든 Pod** 가 받는다.
- 1.24+ 는 SA 토큰이 자동 생성되는 영구 Secret 이 아니라 **projected, 시간 제한, Pod 에 바인딩**. `kubectl create token` 으로 발급 — 실험에서 `--duration=10m` 으로 쓴 것.
- 외부 시스템(Vault, AWS IRSA)은 이 토큰을 OIDC 로 검증 → **비밀 배포 없는 인증** — [04 노트](/security/notes/04-secrets-management).

## Pod Security Standards — Pod 스펙의 위험을 막는다

PodSecurityPolicy(삭제됨)를 대체하는 내장 어드미션. 세 프로파일, 세 모드.

| 프로파일 | 막는 것 |
|---|---|
| `privileged` | 아무것도 안 막음(시스템 네임스페이스) |
| `baseline` | privileged, hostPID/IPC/Network, hostPath, 위험 capabilities, hostPort, AppArmor/SELinux 변경… |
| `restricted` | baseline + **runAsNonRoot 필수**, `allowPrivilegeEscalation: false`, `drop ALL`, seccomp 필수, 볼륨 타입 제한 |

```bash
kubectl label ns study \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted
kubectl -n study apply -f pod-without-securitycontext.yaml
#  Error: pods "x" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false, unrestricted capabilities, runAsNonRoot != true, seccompProfile
```

**도입 순서**: `warn`+`audit` 로 먼저 켜서 어떤 워크로드가 걸리는지 감사 로그로 보고 → 고치고 → `enforce`. 이 프로젝트의 `k8s/` web Deployment 는 아마 `restricted` 에 걸린다(securityContext 없음) — 체크리스트 과제.

## NetworkPolicy — 기본은 "모두가 모두와" 다

Kubernetes 는 기본적으로 모든 Pod 가 모든 Pod·외부와 통신한다. 침해된 Pod 하나가 DB·메타데이터 서비스·다른 네임스페이스로 **측면 이동**하는 걸 막으려면 NetworkPolicy 가 필요하다(CNI 가 지원해야: Calico, Cilium. kind 기본 kindnet 은 **미지원** — 정책을 만들어도 아무 일도 안 일어나는 것이 가장 흔한 "정책이 있는데 뚫린" 사고다. 이 프로젝트는 `pnpm k8s:netpol` 로 Calico 를 넣은 별도 kind 클러스터 `study-netpol` 을 만들고, 실험 `sec-k8s-networkpolicy` 가 `k8s/security/netpol/` 의 매니페스트를 순서대로 적용하며 redis·web·intruder 세 Pod 의 연결을 `nc` 로 확인한다: 정책 없음(둘 다 연결) → default-deny(둘 다 차단, **DNS 도 차단**) → DNS 허용(이름은 풀리지만 6379 는 차단) → web→redis 허용(web 만 연결).)

```yaml
# 1. 네임스페이스 기본 거부 (ingress + egress)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: study }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# 2. web → redis 만 허용, DNS egress 허용
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: web-egress, namespace: study }
spec:
  podSelector: { matchLabels: { app: web } }
  policyTypes: [Egress]
  egress:
    - to: [{ podSelector: { matchLabels: { app: redis } } }]
      ports: [{ port: 6379 }]
    - to: [{ namespaceSelector: { kubernetes.io/metadata.name: kube-system } }]
      ports: [{ port: 53, protocol: UDP }]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: redis-ingress, namespace: study }
spec:
  podSelector: { matchLabels: { app: redis } }
  ingress:
    - from: [{ podSelector: { matchLabels: { app: web } } }]
      ports: [{ port: 6379 }]
```

- **egress 가 핵심**: 침해된 Pod 가 C2 서버·클라우드 메타데이터(`169.254.169.254`)·외부로 데이터를 못 보내게. 외부 API 가 필요하면 egress 게이트웨이/FQDN 정책(Cilium).
- 정책은 **더해진다**(OR). 하나라도 허용하면 허용. 기본 거부가 없으면 나머지는 장식.
- 디버깅: `kubectl exec -it web -- nc -zv redis 6379`, Cilium 의 `hubble observe` 가 드롭을 보여 준다. 관측과 연결 — [K8s 노트 12](/kubernetes/notes/12-network-policy-mesh).
- 서비스 메시(mTLS + L7 인가 정책)는 "누가" 까지 본다: "`web` SA 만 `/api/*` GET 허용".

## 어드미션 정책 — Kyverno / Gatekeeper

RBAC 는 "누가 무엇을" 이고, 어드미션은 "**어떤 모양이어야**" 다. 정책을 YAML(Kyverno) 또는 Rego(Gatekeeper/OPA)로 쓴다. ValidatingAdmissionPolicy(CEL, 1.30+ GA)는 웹훅 없이 내장.

```yaml
# Kyverno: 레지스트리 제한 + 서명 검증 + 리소스 제한 요구
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata: { name: supply-chain }
spec:
  validationFailureAction: Enforce
  rules:
    - name: allowed-registries
      match: { any: [{ resources: { kinds: [Pod] } }] }
      validate:
        message: "ghcr.io/jaejinu/* 이미지만 허용"
        pattern: { spec: { containers: [{ image: "ghcr.io/jaejinu/*" }] } }
    - name: verify-signature
      match: { any: [{ resources: { kinds: [Pod] } }] }
      verifyImages:
        - imageReferences: ["ghcr.io/jaejinu/*"]
          attestors: [{ entries: [{ keyless: { subject: "https://github.com/jaejinu/study/.github/workflows/*", issuer: "https://token.actions.githubusercontent.com" } }] }]
    - name: require-limits
      match: { any: [{ resources: { kinds: [Pod] } }] }
      validate:
        message: "모든 컨테이너에 resources.limits 필요"
        pattern: { spec: { containers: [{ resources: { limits: { memory: "?*" } } }] } }
```

자주 쓰는 정책: 레지스트리 허용 목록, 이미지 서명·다이제스트 강제, `latest` 태그 금지, 레이블(`team`, `app`) 필수, 리소스 limits 필수, `hostPath` 금지, 기본 NetworkPolicy 자동 생성(generate), 시크릿을 env 로 쓰지 못하게. **Audit 모드로 시작**해 위반 리포트(`PolicyReport` CRD → Grafana 패널)를 보고 Enforce.

## 데이터 평면 — etcd, 감사 로그, 노드

- **etcd 암호화**: Secret 은 기본 평문. `EncryptionConfiguration` 으로 `aescbc`/`secretbox` 또는 **KMS v2**(클라우드 KMS). 관리형 클러스터는 옵션 한 번. kind 는 기본 평문 — `docker exec study-control-plane etcdctl get /registry/secrets/study/x` 로 평문을 직접 보면 체감된다.
- **감사 로그**(audit policy): "누가 언제 어떤 리소스에 어떤 동사" 를 JSON 으로. `secrets` 의 get/list, `pods/exec`, RBAC 변경은 **RequestResponse** 레벨로 전부 기록 → Loki → 규칙: "사람 사용자가 운영 시간 밖에 secrets list" 알림. 보안 관측의 핵심 소스.
- **API 서버 노출**: 공인 IP 에 열지 않기, OIDC + 짧은 토큰, 익명 인증 끄기(`--anonymous-auth=false`), `kubectl` 접근은 VPN/배스천.
- **노드**: kubelet 인증·인가 켜기(`--authorization-mode=Webhook`), 읽기 전용 포트 10255 끄기, 노드 OS 최소화(Bottlerocket/Flatcar), 자동 패치, **메타데이터 서비스 차단**(IMDSv2 강제 또는 NetworkPolicy).
- **점검 도구**: `kube-bench`(CIS 벤치마크), `kubescape`, `trivy k8s --report summary cluster`, `polaris`.

## 멀티테넌시와 블라스트 반경

| 수준 | 도구 |
|---|---|
| 네임스페이스 분리 | RBAC + NetworkPolicy + ResourceQuota + LimitRange + PSS 레이블 |
| 노드 분리 | nodeSelector/taint 로 민감 워크로드를 전용 노드에 |
| 런타임 분리 | gVisor/Kata RuntimeClass |
| 클러스터 분리 | 진짜 격리. 비용 ↑ — 환경(prod/dev)·규제 경계는 클러스터 분리 |

## 예시로 보기 — kind 클러스터 점검

```bash
kubectl get clusterrolebinding -o json | jq -r '.items[] | select(.roleRef.name=="cluster-admin") | .metadata.name + " → " + (.subjects // [] | map(.kind+":"+.name) | join(","))'
kubectl -n study get sa web -o jsonpath='{.automountServiceAccountToken}'       # 비어 있으면 true(마운트됨)
kubectl -n study get deploy web -o jsonpath='{.spec.template.spec.securityContext}{"\n"}{.spec.template.spec.containers[0].securityContext}'
kubectl get ns study -o jsonpath='{.metadata.labels}'                            # PSS 레이블 없음
kubectl get networkpolicy -A                                                     # 없음
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d   # 초기 비밀번호가 아직 Secret 에
```

예상 결과와 개선:
- ArgoCD·kube-prometheus-stack 은 넓은 ClusterRole 을 가진다(설계상). 그 SA 가 든 Pod 가 뚫리면 클러스터 전체 → 이 네임스페이스는 가장 엄격히(접근 제한, 감사).
- web Deployment 에 `securityContext` 추가 → `restricted` 통과시키기. Next.js standalone 은 `.next/cache` 에 쓰므로 `readOnlyRootFilesystem` + emptyDir 마운트.
- `automountServiceAccountToken: false` — web 은 API 를 안 쓴다.
- kind 를 Calico/Cilium 으로 다시 만들고 `default-deny` + 허용 정책 → `kubectl exec web -- nc -zv kafka 9092` 가 막히는지.
- ArgoCD 초기 비밀번호 Secret 삭제, 비밀번호 변경.

## 실전에서는 어디에 쓰이나

> Kubernetes 보안은 "여러 팀·서비스가 한 클러스터를 나눠 쓰기 시작할 때", 그리고 "Pod 하나가 뚫렸을 때 어디까지 번지나" 를 따질 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 여러 팀이 쓰는 사내 공용 클러스터 | 팀마다 자기 네임스페이스만 다루게 | 네임스페이스별 Role/RoleBinding, 사람은 `view`·`edit` 부터, OIDC 로그인 | 팀별 클러스터 — 격리는 강하지만 비용이 크다 |
| CI/CD 배포 계정 | 배포 권한으로 시크릿·exec 까지 가능해지는 문제 | `deployments` patch 만 주는 전용 SA, 짧은 토큰 | 내장 `edit` — secrets·pods/exec 가 포함된다 |
| 결제·개인정보를 다루는 서비스 | 침해된 Pod 의 DB·메타데이터 접근(측면 이동) | default-deny NetworkPolicy + 필요한 흐름만 허용, egress 제한 | 보안 그룹만 — Pod 단위로 세밀하게 못 막는다 |
| 보안 인증을 받아야 하는 SaaS | 위험한 Pod 스펙(root·hostPath·privileged) 배포 차단 | PSS `restricted` 를 warn·audit → enforce 순으로, Kyverno 로 레지스트리·서명·limits 강제 | 배포 후 정기 점검 — 이미 떠 있다 |
| 운영 클러스터 감사 대응 | 누가 언제 시크릿을 읽었고 exec 했는지 | API 감사 로그(secrets·pods/exec 는 RequestResponse) → 로그 수집·알림, kube-bench | 노드 접근 기록만 — API 수준 행위를 모른다 |

**이럴 땐 안 맞는다**
- NetworkPolicy 를 지원하지 않는 CNI 에서 정책만 작성 — 아무 일도 일어나지 않는다. Calico·Cilium 같은 지원 CNI 를 먼저 확인한다.
- 규제·환경(prod/dev) 경계를 네임스페이스만으로 나누는 것 — 커널·컨트롤 플레인을 공유한다. 강한 경계가 필요하면 클러스터를 분리한다.

**누가 매일 만나나** — 플랫폼 엔지니어는 RBAC·PSS·어드미션 정책을 관리할 때, 앱 개발자는 배포가 `violates PodSecurity` 로 거부될 때, 보안 엔지니어는 감사 로그 알림을 볼 때 만난다.

**면접·실무 단골 질문**
- Q. 사실상 cluster-admin 과 같은 권한은 → secrets list/get, pods/exec, privileged Pod 생성, escalate·bind·impersonate 등.
- Q. API 서버 요청이 거치는 순서 → 인증(401) → 인가 RBAC(403) → 어드미션(Mutating → 검증 → Validating) → etcd 저장.

## 실습 체크리스트

- [ ] 실험 `sec-k8s-rbac` 로 최소 권한 SA 와 403 확인
- [ ] `kubectl auth can-i --list --as=system:serviceaccount:argocd:argocd-application-controller` 로 ArgoCD 의 권한 범위 읽어 보기
- [ ] study 네임스페이스에 PSS `warn=restricted` 레이블을 붙이고 `kubectl rollout restart` 후 경고 읽기 → web 에 securityContext 추가해 통과
- [ ] `etcdctl` 로 Secret 이 평문인지 직접 확인(kind control-plane 컨테이너 안)
- [ ] Kyverno 설치 → "`latest` 태그 금지" 정책을 Audit 으로 적용 → PolicyReport 확인 → Enforce 로 전환해 거부 메시지 보기
- [ ] (심화) Calico 로 kind 재생성, default-deny + web→redis 허용 정책, 차단되는 연결을 `kubectl exec` 로 확인
- [ ] (심화) API 서버 감사 정책을 켜고 `secrets list` 이벤트를 Loki 에서 질의
