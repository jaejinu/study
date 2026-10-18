---
title: "서비스 메시가 푸는 문제 — 라이브러리에서 인프라로"
order: 1
level: 기초
summary: "마이크로서비스 사이의 통신에 반복되는 일(암호화·인증·재시도·타임아웃·부하 분산·관측)을 왜 앱 라이브러리가 아니라 인프라 계층으로 내리는지, 데이터 플레인과 컨트롤 플레인의 역할, 메시가 하는 일과 하지 않는 일, 도입 비용과 '언제 메시가 필요 없나', 이 프로젝트의 kind 클러스터에 올린 Linkerd 의 실제 구성"
tags: [서비스 메시, 데이터 플레인, 컨트롤 플레인, Linkerd, 사이드카, mTLS, 재시도, 관측]
experiments: [mesh-mtls]
---

## 서비스가 서비스를 부를 때 반복되는 일

모놀리스 안에서 함수 호출은 실패하지 않고, 느려지지 않고, 엿들을 수 없다. 서비스를 쪼개 네트워크 너머로 보내는 순간 그 셋이 모두 깨진다([분산 시스템이 어려운 이유](/distributed-systems/notes/01-why-hard)). 그래서 서비스마다 같은 코드가 붙는다.

| 해야 하는 일 | 왜 필요한가 | 앱이 직접 하면 |
|---|---|---|
| 암호화(TLS) | 클러스터 안 트래픽도 엿보이고 위조된다 | 인증서 발급·회전·검증을 서비스마다 구현 |
| 서비스 인증 | "이 요청이 정말 결제 서비스에서 왔나" | 공유 비밀, JWT, IP 허용 목록… 제각각 |
| 재시도·타임아웃 | 일시 실패를 흡수하고 느린 호출을 끊는다 | 언어마다 다른 라이브러리, 다른 기본값 |
| 서킷 브레이커 | 죽은 의존성에 계속 붙지 않는다 | Hystrix·resilience4j·Polly… |
| 부하 분산 | 느린 인스턴스를 피한다 | 클라이언트 측 LB 라이브러리 |
| 관측 | 성공률·지연·처리량(골든 시그널) | 서비스마다 메트릭 이름·버킷이 다르다 |

이걸 **라이브러리**로 풀던 시대가 있었다(Netflix OSS: Hystrix, Ribbon, Eureka). 문제는 세 가지였다.

1. **언어마다 다시 만든다.** Java 는 Hystrix, Go 는 다른 것, Node 는 또 다른 것. 동작이 미묘하게 다르다.
2. **업그레이드가 배포다.** TLS 라이브러리 취약점 하나를 고치려면 서비스 100개를 다시 빌드·배포해야 한다.
3. **정책이 코드에 묻힌다.** "결제 → 재고 호출의 타임아웃이 몇 초냐" 를 알려면 코드를 읽어야 한다.

서비스 메시는 이 일을 **각 Pod 옆의 프록시**로 옮긴다. 앱은 평문 HTTP 로 `http://inventory/` 를 부르고, 프록시가 가로채 TLS·재시도·부하 분산을 한 뒤 상대 Pod 의 프록시로 보낸다.

```
[앱 A] ─평문─▶ [프록시 A] ══mTLS══▶ [프록시 B] ─평문─▶ [앱 B]
                 ▲  재시도·타임아웃·LB·메트릭        ▲  인가·메트릭
                 └──────────── 컨트롤 플레인이 정책·인증서·엔드포인트를 내려준다
```

## 데이터 플레인과 컨트롤 플레인

| 층 | 무엇 | Linkerd 에서 | 하는 일 |
|---|---|---|---|
| **데이터 플레인** | 실제 요청이 지나가는 프록시들 | `linkerd-proxy`(Rust, Pod 마다 하나) | TLS 종단·재시도·LB·메트릭·인가 판정 |
| **컨트롤 플레인** | 프록시를 설정하는 서버들 | `linkerd-destination`, `linkerd-identity`, `linkerd-proxy-injector` | 엔드포인트·정책 배포, 인증서 발급, 사이드카 주입 |

- **destination**: "Service `web` 의 엔드포인트는 이 3개이고, 이 HTTPRoute·재시도 정책이 붙어 있다" 를 프록시에 스트리밍한다. 쿠버네티스 API 를 watch 해 바뀌면 즉시 밀어 준다.
- **identity**: 프록시가 시작할 때 ServiceAccount 토큰을 보여 주면 짧은 수명(24시간)의 인증서를 발급한다. 인증서 이름이 곧 서비스 신원이다([노트 03](/service-mesh/notes/03-mtls-identity)).
- **proxy-injector**: `linkerd.io/inject: enabled` 어노테이션이 붙은 Pod 가 생성될 때 어드미션 웹훅으로 프록시 컨테이너를 끼워 넣는다.

컨트롤 플레인이 죽으면? 이미 떠 있는 프록시는 **마지막으로 받은 설정으로 계속 동작한다**. 새 Pod 가 인증서를 못 받거나 엔드포인트 변경이 늦게 전파될 뿐 기존 트래픽은 흐른다. 데이터 플레인이 컨트롤 플레인 장애에 버티도록 설계하는 것이 메시의 기본 원칙이다.

## 메시가 하는 일, 하지 않는 일

| 메시가 잘하는 것 | 메시가 못 하거나 하면 안 되는 것 |
|---|---|
| 서비스 간 mTLS·신원 기반 인가 | 사용자 인증(로그인·OAuth) — 그건 앱과 게이트웨이의 일 |
| 재시도·타임아웃·장애 축적 | 비멱등 요청의 안전한 재시도 판단 — 앱이 멱등 키로 보장해야 한다([API 설계 04](/api-design/notes/04-errors-retries-deadlines)) |
| 골든 시그널 자동 수집 | 비즈니스 메트릭(주문 수, 결제 금액) |
| 요청 단위 트래픽 분할 | 데이터베이스 스키마 호환성 — 카나리가 DB 를 깨면 메시도 못 막는다 |
| 엔드포인트 단위 부하 분산 | 앱 내부 큐잉·스레드 고갈 — 메시는 바깥만 본다 |

**흔한 오해**: "메시를 깔면 분산 트레이싱이 공짜다." 아니다. 프록시는 스팬을 만들 수 있지만, 들어온 요청의 trace 헤더를 나가는 요청에 붙이는 일은 **앱이** 해야 한다. 앱이 헤더를 전파하지 않으면 스팬이 이어지지 않는다([노트 05](/service-mesh/notes/05-observability)).

## 비용 — 공짜가 아니다

| 비용 | 크기 감각 | 줄이는 법 |
|---|---|---|
| 지연 | 홉당 프록시 2번 통과, Linkerd 는 p50 기준 1ms 미만 | 가벼운 프록시, ambient(노드 프록시) |
| 메모리·CPU | Pod 마다 프록시 하나(Linkerd ~10~20MB, Envoy ~50MB+) | ambient, 프록시 자원 제한 |
| 운영 복잡도 | 컨트롤 플레인 업그레이드, 인증서 루트 회전, 어드미션 웹훅 | 관리형 메시, 작은 메시(Linkerd) |
| 디버깅 난이도 | "앱이 503 을 낸 거냐 프록시가 낸 거냐" | 프록시 메트릭·로그, `linkerd diagnostics` |
| 학습 비용 | CRD 가 많다(Istio 는 특히) | 필요한 기능만 |

### 메시가 필요 없는 경우

- 서비스가 몇 개 안 되고 한 언어로 통일돼 있다 → 라이브러리로 충분하다.
- mTLS 만 필요하다 → CNI 수준 암호화(Cilium WireGuard, [eBPF 04](/ebpf/notes/04-networking-xdp-tc-cilium))가 더 싸다.
- 트래픽 분할만 필요하다 → 인그레스 컨트롤러·Argo Rollouts 의 복제본 비율로 시작([쿠버네티스 13](/kubernetes/notes/13-gitops-progressive-delivery)).
- 클러스터가 하나, 팀이 하나 → 메시의 "정책을 코드 밖으로" 이점이 작다.

메시의 진짜 가치는 **서비스와 팀이 많을 때** 커진다: 모든 서비스가 같은 방식으로 암호화되고, 같은 이름의 메트릭을 내고, 같은 문법으로 재시도를 건다. 표준화의 이득이다.

## 예시로 보기 — 이 프로젝트에서

이 사이트의 kind 클러스터(`kind-study`)에 Linkerd edge-26.10.1 이 올라가 있다. 설치는 세 단계였다.

```bash
# 1. Gateway API CRD (Linkerd 가 HTTPRoute 를 정책 API 로 쓴다)
kubectl --context kind-study apply --server-side \
  -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml
# 2. Linkerd CRD → 3. 컨트롤 플레인
linkerd --context kind-study install --crds | kubectl --context kind-study apply --server-side -f -
linkerd --context kind-study install       | kubectl --context kind-study apply -f -
linkerd --context kind-study check
```

설치하면서 겪은 함정: brew 로 받은 CLI 는 `version-2.20` 이라는 태그를 렌더링했는데 그런 이미지는 레지스트리에 없어서 컨트롤 플레인이 `ImagePullBackOff` 로 멈췄다. GitHub 릴리스의 edge CLI(`~/.linkerd2/bin/linkerd`)로 다시 설치해 해결했다. **CLI 버전 = 컨트롤 플레인 버전 = 프록시 이미지 태그** 가 맞물려야 한다는 교훈.

```bash
kubectl --context kind-study -n linkerd get deploy
# linkerd-destination   1/1   엔드포인트·정책
# linkerd-identity      1/1   인증서 발급
# linkerd-proxy-injector 1/1  사이드카 주입 웹훅
```

실험 `mesh-mtls` 는 메시 Pod 와 메시 밖 Pod 가 같은 서버를 부를 때 서버 프록시가 둘을 어떻게 구분하는지 보여 준다. 실측 결과는 이랬다.

| 서버 프록시가 본 요청 | tls | client_id |
|---|---|---|
| 메시 클라이언트 10건 | `true` | `client-meshed.mesh-lab-mtls.serviceaccount.identity.linkerd.cluster.local` |
| 메시 밖 클라이언트 10건 | `no_identity` | (이유: `no_tls_from_remote`) |

앱(whoami)은 어느 쪽이든 평문 HTTP 를 받았다. 암호화와 신원 확인은 전부 프록시가 했다.

이 사이트의 앱 Pod(`study` 네임스페이스의 `web`)에는 메시를 주입하지 않았다. ArgoCD 가 관리하는 매니페스트([쿠버네티스 13](/kubernetes/notes/13-gitops-progressive-delivery))를 건드리지 않기 위해 실험은 모두 `mesh-lab-*` 네임스페이스에서 한다.

## 다음 노트

- [사이드카 vs ambient — 프록시를 어디에 둘까](/service-mesh/notes/02-sidecar-ambient)
- [mTLS 와 서비스 신원](/service-mesh/notes/03-mtls-identity)
- [트래픽 정책 — 재시도·타임아웃·장애 축적](/service-mesh/notes/04-traffic-policy)

![서비스 메시 구조](/diagrams/mesh-architecture.svg)

## 흔한 오해

| 오해 | 실제 |
|---|---|
| "메시를 깔면 보안이 해결된다" | 서비스 **간** 신원·암호화만 해결한다. 사용자 인증, 입력 검증, 시크릿 관리, 데이터베이스 권한은 그대로 앱과 플랫폼의 일이다([보안 01](/security/notes/01-security-mindset-threat-modeling)) |
| "메시가 장애를 막아 준다" | 재시도·장애 축적은 **일부 Pod** 의 고장을 숨긴다. 의존성 전체가 죽으면 메시는 빨리 실패할 뿐이다 — 폴백은 앱이 정한다 |
| "메시 = Istio" | Linkerd·Cilium·Consul 등 여럿이고, 기능·비용이 크게 다르다([노트 07](/service-mesh/notes/07-mesh-comparison-ops)) |
| "메시를 켜면 모든 트래픽이 보인다" | **메시 안 Pod 끼리**만. 메시 밖 호출자, 클러스터 밖 데이터베이스, hostNetwork Pod 는 보이지 않는다 |
| "사이드카 지연은 무시해도 된다" | 홉당 1ms 미만이라도 호출 체인이 10단이면 수 ms. 지연 예산이 빠듯한 경로(초당 수십만 요청)에서는 측정해서 판단한다 |
| "메시가 쿠버네티스 Service 를 대체한다" | 메시는 Service·EndpointSlice 위에서 동작한다. 엔드포인트 목록은 여전히 쿠버네티스가 만든다 |

## 도입 전 점검표

1. **문제가 무엇인가.** "서비스 간 암호화가 규정 요구사항이다" 처럼 구체적인 문제가 있어야 한다. "요즘 다들 쓰니까" 는 운영 비용만 남긴다.
2. **서비스·팀 수.** 5개 미만 서비스, 1개 팀이면 라이브러리·인그레스로 충분한 경우가 많다.
3. **프로토콜.** HTTP/gRPC 위주인가? 서버가 먼저 말하는 TCP 프로토콜(DB·메시지 큐)은 L4 기능만 받는다.
4. **운영 인력.** 컨트롤 플레인 업그레이드·인증서 루트 회전을 누가 하나.
5. **관측 기반.** Prometheus·대시보드가 있어야 메시의 메트릭을 쓸 수 있다.
6. **출구 전략.** 표준 API(Gateway API)를 쓰면 나중에 바꾸거나 뺄 수 있다.

> 이어서 읽기: [메시 비교와 운영](/service-mesh/notes/07-mesh-comparison-ops) · [쿠버네티스 12 — 네트워크 정책과 메시 개요](/kubernetes/notes/12-network-policy-mesh)

## 실전에서는 어디에 쓰이나 — 서비스 메시 지도

> 서비스 메시는 "서비스가 서비스를 부르는 일" 의 암호화·신원·복원력·관측을 앱 밖의 공통 계층으로 표준화하는 도구다. 서비스와 팀이 많아져 같은 일을 언어마다 다시 만들기 시작할 때 등장한다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 핀테크·의료 등 규제 산업에서 "내부 트래픽도 암호화" 요구 | 자동 mTLS 와 ServiceAccount 기반 신원 | [mTLS 와 서비스 신원](/service-mesh/notes/03-mtls-identity) |
| 수백 개 Pod 클러스터에서 프록시 메모리 비용이 문제 | 사이드카 vs ambient 선택, 프록시 자원 요청 | [사이드카 vs ambient](/service-mesh/notes/02-sidecar-ambient) |
| 커머스 주문 → 재고 → 결제 호출 체인의 일시 실패 흡수 | 재시도·타임아웃·장애 축적·EWMA 부하 분산 | [트래픽 정책](/service-mesh/notes/04-traffic-policy) |
| 여러 언어로 된 마이크로서비스의 성공률·지연을 한 대시보드로 | 프록시가 내는 골든 시그널, outbound/inbound 시점 | [메시 관측](/service-mesh/notes/05-observability) |
| SaaS 의 새 버전을 1% 사용자에게만 먼저 노출 | HTTPRoute 가중치 분할, Argo Rollouts 자동 판정 | [카나리와 트래픽 분할](/service-mesh/notes/06-canary-traffic-split) |
| 사내 플랫폼 팀이 Linkerd·Istio·Cilium 중 하나를 골라야 할 때 | 설계 철학·운영량·장애 모드 비교 | [메시 비교와 운영](/service-mesh/notes/07-mesh-comparison-ops) |

**회사 규모에 따라**
- 스타트업: 서비스가 몇 개면 메시 없이 HTTP 클라이언트 라이브러리의 타임아웃·재시도와 인그레스로 충분하다. 메시는 운영 비용만 남기기 쉽다.
- 성장기: 팀·언어가 늘어 "서비스마다 재시도 기본값이 다르다" 가 장애 원인이 될 때, 운영량이 작은 메시를 네임스페이스 하나에서 관측 목적으로 시작한다.
- 대규모 조직: 플랫폼 팀이 메시를 공용 인프라로 운영하고 mTLS·인가 정책·카나리를 표준으로 강제한다. 멀티 클러스터·인증서 루트 회전·업그레이드 자체가 전담 업무가 된다.

**이럴 땐 안 맞는다**
- 서비스가 한 언어·한 팀·한 클러스터 — 라이브러리와 인그레스가 더 싸고 디버깅도 쉽다.
- 필요한 것이 노드 간 암호화뿐 — CNI 수준 암호화(WireGuard 등)가 Pod 마다 프록시를 두는 것보다 가볍다.
- 트래픽 대부분이 DB·메시지 큐 같은 서버 우선 TCP 프로토콜 — L4 기능만 받으므로 얻는 것이 적다.

**누가 매일 만나나** — 플랫폼·SRE 엔지니어는 메시 업그레이드, 인증서 만료 알림, "앱이 503 을 낸 건가 프록시가 낸 건가" 를 가르는 순간에 만난다. 백엔드 개발자는 자기 서비스의 재시도·타임아웃 어노테이션과 대시보드의 성공률로 만난다.

**면접·실무 단골 질문**
- Q. 서비스 메시와 API 게이트웨이의 차이는? → 게이트웨이는 북-남(외부→클러스터) 진입점, 메시는 동-서(서비스 간) 트래픽 전체에 붙는다. 사용자 인증은 게이트웨이·앱, 서비스 신원은 메시.
- Q. 컨트롤 플레인이 죽으면 트래픽이 멈추나? → 아니다. 데이터 플레인은 마지막 설정으로 계속 동작하고, 새 Pod 인증서와 엔드포인트 반영만 늦어진다.

## 실습 체크리스트

- [ ] `linkerd --context kind-study check` 로 컨트롤 플레인 상태 확인
- [ ] `kubectl -n linkerd get deploy` 로 세 컴포넌트(destination·identity·proxy-injector)의 역할을 말로 설명하기
- [ ] 실험 `mesh-mtls` 를 돌리고 서버 프록시 메트릭의 `tls`·`client_id` 를 읽기
- [ ] "우리 팀에 메시가 필요한가" 를 위 비용 표로 판단해 보기 — 필요 없다는 결론도 정답이다
- [ ] 컨트롤 플레인(`linkerd-destination`)을 0으로 스케일했을 때 기존 트래픽이 계속 흐르는지 확인(끝나면 1로 복구)
