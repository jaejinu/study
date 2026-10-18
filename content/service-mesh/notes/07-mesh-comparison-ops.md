---
title: "심화 — Linkerd · Istio · Cilium 비교와 메시 운영의 실제"
order: 7
level: 심화
summary: "세 메시의 설계 철학(작고 단단함 · 기능 최다 · 커널 중심)과 데이터 플레인·정책 API·mTLS 구현·멀티 클러스터·자원 비용 비교, 메시 도입 순서(관측 → mTLS → 정책 → 트래픽 관리), 업그레이드·인증서 루트 회전·웹훅 장애 같은 운영 위험과 장애 모드(컨트롤 플레인 다운, 프록시 OOM, 프로토콜 감지 지연, DNS·헤드리스 서비스), 메시를 빼는 출구 전략, 이 클러스터에서 겪은 CLI 버전 함정"
tags: [Linkerd, Istio, Cilium, 운영, 업그레이드, 장애 모드, 멀티 클러스터, 웹훅, 비교]
experiments: []
---

## 세 메시, 세 철학

| 항목 | Linkerd | Istio | Cilium (Service Mesh) |
|---|---|---|---|
| 철학 | 작고 단단하게, 기본값으로 동작 | 모든 기능, 최대 유연성 | 커널(eBPF)에서 할 수 있는 건 커널에서 |
| 데이터 플레인 | linkerd2-proxy(Rust) 사이드카 | Envoy 사이드카 또는 ambient(ztunnel + waypoint) | eBPF + 노드당 Envoy(L7) |
| mTLS | 자동, 기본 켜짐 | 자동(PeerAuthentication 으로 강제) | WireGuard/IPsec(노드 간) 또는 상호 인증 |
| 정책 API | Server·AuthorizationPolicy + Gateway API | AuthorizationPolicy·VirtualService·DestinationRule + Gateway API | CiliumNetworkPolicy(L3~L7) + Gateway API |
| 트래픽 관리 | HTTPRoute, 재시도·타임아웃 어노테이션 | 가장 풍부(장애 주입·미러링·지역 LB…) | Gateway API, Envoy 설정 |
| 멀티 클러스터 | 서비스 미러링 | 다양한 토폴로지 | ClusterMesh |
| 자원(Pod 당) | 작음(~10~20MB) | 큼(Envoy) / ambient 는 노드 단위 | Pod 당 없음(노드 단위) |
| 학습 곡선 | 낮음 | 높음 | CNI 를 바꿔야 함 |

선택 기준은 기능 목록이 아니라 **필요한 것과 감당할 운영량**이다.

- mTLS·관측·기본 재시도가 목적 → Linkerd 가 가장 적은 운영량.
- 복잡한 트래픽 정책·다양한 프로토콜·대규모 조직 → Istio.
- 이미 Cilium 을 CNI 로 쓰고 L3/L4 정책이 중심 → Cilium 메시([eBPF 04](/ebpf/notes/04-networking-xdp-tc-cilium)).

## 도입 순서 — 한 번에 다 켜지 않는다

| 단계 | 하는 일 | 위험 |
|---|---|---|
| 1. 관측 | 네임스페이스 하나에 주입, 골든 시그널만 본다 | 낮음 — 동작 변화 거의 없음 |
| 2. mTLS 확인 | 메트릭에서 `tls="true"` 비율을 100% 로 | 메시 밖 호출자 발견 |
| 3. 인가 정책 | `all-unauthenticated` → `cluster-authenticated` → 서비스별 | 가장 큼 — 숨은 의존성이 끊긴다([노트 03](/service-mesh/notes/03-mtls-identity)) |
| 4. 트래픽 관리 | 타임아웃 → 재시도 → 카나리 | 재시도 폭풍, 비멱등 재시도 |

각 단계 사이에 **며칠씩 관찰**한다. 3단계는 [장애 실험실 04](/chaos/notes/04-gameday-and-automation)의 게임데이처럼 가설·중단 조건을 정하고 진행한다.

## 장애 모드

| 장애 | 증상 | 대처 |
|---|---|---|
| 컨트롤 플레인(destination) 다운 | 기존 트래픽은 흐름, **새 엔드포인트·정책 반영 안 됨** | 복제본 2+, PDB, 알림 |
| identity 다운 | 새 Pod 가 인증서를 못 받아 시작 실패, 기존 Pod 는 24h 까지 | HA, 루트·발급자 만료 감시 |
| 주입 웹훅 다운 | `failurePolicy: Ignore` 면 **주입 없이** Pod 생성 → 조용히 메시 밖 | 주입 여부 감시(메시 밖 Pod 알림) |
| 프록시 OOM | Pod 재시작, 큰 클러스터의 Envoy 에서 흔함 | 프록시 메모리 한도, 엔드포인트 범위 축소 |
| 프로토콜 감지 지연 | 서버가 먼저 말하는 프로토콜이 10초 멈춤 | opaque 포트 지정([노트 02](/service-mesh/notes/02-sidecar-ambient)) |
| 헤드리스 서비스·StatefulSet | Pod 별 DNS 로 직접 접근, LB 정책 미적용 | 의도 확인, 필요 시 opaque |
| 인증서 루트 만료 | 메시 전체 mTLS 실패 | cert-manager 자동 갱신, 30일 전 알림 |
| 시간 불일치 | 인증서 유효성 검증 실패 | NTP, clockSkewAllowance |

이 중 가장 조용하고 위험한 것은 **주입 웹훅 장애**다. Linkerd 기본 `webhookFailurePolicy: Ignore` 는 웹훅이 죽어도 배포를 막지 않지만, 그동안 생긴 Pod 는 **메시 밖**이다. 정책이 `deny` 라면 그 Pod 들은 서비스를 못 부른다. "주입 안 된 Pod 수" 를 메트릭·알림으로 두어야 한다.

## 업그레이드

- 컨트롤 플레인 먼저, 그다음 데이터 플레인(Pod 재시작으로 새 프록시). 한 버전 차이는 호환되게 설계돼 있다.
- 데이터 플레인 업그레이드 = 모든 메시 Pod 롤링 재시작. PDB·롤링 전략이 없으면 장애다([쿠버네티스 07](/kubernetes/notes/07-deploy-resources)).
- CRD 변경은 따로 먼저 적용한다(`install --crds` / `upgrade --crds`).
- **CLI 버전 = 컨트롤 플레인 버전 = 프록시 이미지 태그.** 아래 사고가 이걸 어겨서 생겼다.

### 이 클러스터에서 겪은 사고

brew 로 설치한 `linkerd` CLI 는 자기 버전을 `version-2.20` 으로 보고했고, `linkerd install` 은 그 문자열을 그대로 이미지 태그로 썼다. `cr.l5d.io/linkerd/proxy:version-2.20` 은 레지스트리에 없어서 컨트롤 플레인 Pod 3개가 모두 `Init:ImagePullBackOff` 였다. `linkerd check` 는 "No running pods for linkerd-destination" 으로만 보여 줬고, 원인은 `kubectl describe pod` 의 이벤트에 있었다.

해결은 GitHub 릴리스의 공식 edge CLI(`edge-26.10.1`)를 받아 네임스페이스를 지우고 다시 설치하는 것이었다. 교훈:

1. 패키지 관리자의 CLI 가 공식 배포와 같은 버전 체계인지 확인한다.
2. `linkerd check` 가 실패하면 바로 `kubectl describe` 로 이벤트를 본다 — 이미지 문제는 거기에만 나온다.
3. 설치 매니페스트를 git 으로 관리(GitOps)하면 "무엇이 설치됐는지" 가 이미지 태그까지 남는다.

## 멀티 클러스터

| 방식 | 원리 |
|---|---|
| 서비스 미러링(Linkerd) | 원격 클러스터의 Service 를 로컬에 `web-east` 처럼 미러링, 게이트웨이를 통해 mTLS |
| 공유 신뢰 루트 | 클러스터들이 같은 트러스트 앵커를 써야 서로의 신원을 믿는다 |
| 페일오버 | 로컬이 실패하면 원격으로 — HTTPRoute 가중치로 표현 |

클러스터 경계를 넘는 순간 지연(리전 간 수십 ms)과 egress 비용([FinOps 01](/finops/notes/01-cloud-cost-model))이 붙는다. 자동 페일오버는 비용 폭탄이 될 수 있다.

## 출구 전략 — 메시를 뺄 수 있나

메시는 앱 코드에 들어가지 않으므로 빼기가 비교적 쉽다. 단, 메시에 맡겼던 일이 다시 앱으로 돌아온다.

| 메시가 하던 일 | 빼면 |
|---|---|
| mTLS | CNI 암호화나 앱 TLS 로 대체하지 않으면 평문 |
| 재시도·타임아웃 | 앱 라이브러리 설정 필요(대부분 이미 일부 있음) |
| 인가 정책 | NetworkPolicy + 앱 인증으로 |
| 골든 시그널 | 앱 계측(OTel) 필요 |
| 카나리 | 복제본 비율이나 인그레스 분할로 |

그래서 처음부터 **Gateway API 같은 표준 리소스**를 쓰는 것이 출구를 열어 둔다 — 메시를 바꿔도, 인그레스로 옮겨도 라우팅 정의가 남는다.

## 예시로 보기 — 이 프로젝트에서

이 클러스터의 메시 구성을 운영 관점으로 점검하면:

| 항목 | 현재 | 운영이라면 |
|---|---|---|
| 컨트롤 플레인 복제본 | 1 (`highAvailability: false`) | `--ha` 로 3, PDB |
| 루트·발급자 | install 이 생성, 1년 | cert-manager 로 관리 |
| 웹훅 실패 정책 | Ignore | 그대로 두되 "주입 안 된 Pod" 알림 |
| 기본 인바운드 정책 | all-unauthenticated | 단계적으로 deny |
| 프록시 메트릭 | 수집 안 함 | kps PodMonitor + 레코딩 룰 |
| 설치 방식 | CLI → kubectl apply | Helm 차트 + ArgoCD(GitOps) |

## 런북 — "메시 때문인가?" 를 5분 안에 가르기

1. 메시 밖에서 같은 서비스를 직접 불러 본다(`kubectl port-forward` 로 Pod 에 직접). 직접 호출은 되는데 메시 경유가 실패하면 메시 쪽.
2. `linkerd check --proxy -n <ns>` — 프록시 버전·인증서·연결 상태.
3. 서버 프록시 메트릭에서 `inbound_http_authz_deny_total` — 0 이 아니면 인가 정책이 막고 있다.
4. 클라이언트 프록시의 `outbound_http_*` 오류와 `linkerd diagnostics endpoints` — 엔드포인트가 비어 있지 않은가.
5. 최근 변경: HTTPRoute·정책·어노테이션 커밋(GitOps 라면 git log).
6. 급하면 해당 워크로드의 주입을 끄고(`linkerd.io/inject: disabled`) 재시작 — 메시 밖으로 빼는 것이 가장 빠른 완화다. 단, `deny` 정책 아래에서는 그 Pod 가 다른 서비스를 못 부르게 되니 확인 후.

## 비용 산정 예

Pod 300개, 평균 RPS 50, 사이드카 모델일 때 대략:

| 항목 | Linkerd | Istio(Envoy 사이드카) |
|---|---|---|
| 프록시 메모리 | 300 × 20MB ≈ 6GB | 300 × 60MB ≈ 18GB |
| 프록시 CPU 요청(보수적) | 300 × 10m = 3 코어 | 300 × 50m = 15 코어 |
| 컨트롤 플레인 | 수백 MB | 1~2GB |
| 운영 인력 | 낮음 | 높음 |

이 비용을 [FinOps 03](/finops/notes/03-kubernetes-cost)의 단가로 환산해 "얻는 것(mTLS·관측·카나리)" 과 비교하는 것이 도입 결정의 출발점이다. ambient 모델이면 프록시 메모리 줄은 노드 수 × 수십 MB 로 바뀐다.

> 이어서 읽기: [서비스 메시가 푸는 문제](/service-mesh/notes/01-what-mesh-solves) · [장애 실험실 04 — 게임데이](/chaos/notes/04-gameday-and-automation) · [쿠버네티스 13 — GitOps 와 점진 배포](/kubernetes/notes/13-gitops-progressive-delivery)

## 실전에서는 어디에 쓰이나

> 메시를 "고르고, 들이고, 업그레이드하고, 필요하면 빼는" 운영 결정의 자리에서 등장한다. 기능 목록보다 감당할 운영량과 장애 모드가 선택을 가른다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 운영 인력이 적은 스타트업·성장기 팀 | mTLS·골든 시그널만 적은 운영량으로 | 작고 기본값 위주의 메시(Linkerd 류) | 메시 없이 라이브러리 + CNI 암호화 |
| 프로토콜·트래픽 정책이 다양한 대규모 조직 | 장애 주입·지역 LB·세밀한 라우팅 | 기능이 가장 많은 메시(Istio 류), ambient 로 자원 절감 | 게이트웨이에 정책 집중 |
| 이미 eBPF CNI 를 쓰는 클러스터 | L3/L4 정책 중심, Pod 당 프록시 없이 | CNI 통합 메시(Cilium 류) | 별도 메시를 CNI 위에 추가 |
| 여러 리전 클러스터를 운영하는 서비스 | 리전 장애 시 페일오버 | 공유 트러스트 앵커 + 서비스 미러링 + 가중치 페일오버 | DNS·글로벌 LB 페일오버 |
| 메시 도입 1년 차 조직 | 루트 인증서 만료·웹훅 장애로 메시 전체 마비 | cert-manager 자동 갱신, "주입 안 된 Pod" 알림, HA 컨트롤 플레인 | 수동 회전(만료 사고 위험) |

**이럴 땐 안 맞는다**
- 기능 비교표만 보고 가장 큰 메시를 고르는 경우 — 운영 인력이 없으면 업그레이드·CRD·인증서가 부채가 된다. 필요한 기능부터 정하고 가장 작은 것을 고른다.
- 리전 간 자동 페일오버를 기본으로 켜는 경우 — 리전 간 지연과 egress 비용이 붙는다. 페일오버 조건과 비용을 먼저 계산한다.

**누가 매일 만나나** — 플랫폼 팀이 메시 업그레이드 계획·런북을 쓰고, 온콜 SRE 가 "메시 때문인가?" 를 5분 안에 가를 때 만난다. 아키텍트는 도입 비용(프록시 메모리·CPU)을 FinOps 단가로 환산해 의사결정 문서를 쓸 때 만난다.

**면접·실무 단골 질문**
- Q. 메시 도입 순서는? → 관측 → mTLS 확인 → 인가 정책 → 트래픽 관리. 인가 단계가 숨은 의존성을 끊으므로 가장 위험하다.
- Q. 가장 조용한 메시 장애는? → 주입 웹훅 장애. `failurePolicy: Ignore` 면 Pod 가 메시 밖으로 조용히 생성된다.

## 실습 체크리스트

- [ ] 우리 조직의 요구(mTLS·정책·트래픽 관리·운영 인력)로 세 메시 중 하나를 고르고 이유를 적기
- [ ] 주입 웹훅을 일시적으로 0 으로 스케일하고 새 Pod 가 메시 밖으로 생기는 것을 확인(끝나면 복구)
- [ ] `linkerd check --proxy` 로 데이터 플레인 버전 불일치를 확인하는 법 익히기
- [ ] 트러스트 앵커 교체 절차를 단계별로 적기
- [ ] 메시를 제거했을 때 앱이 다시 맡아야 할 일의 목록을 우리 서비스 기준으로 만들기
