---
title: "mTLS 와 서비스 신원 — IP 가 아니라 ServiceAccount 로 믿는다"
order: 3
level: 중급
summary: "메시가 Pod 사이에 자동으로 맺는 mTLS 의 흐름(프록시 시작 → ServiceAccount 토큰 → identity 컨트롤러 → 24시간 인증서), SPIFFE 신원 형식, 트러스트 앵커·발급자·워크로드 인증서의 3단 체인과 각각의 회전 주기, 신원 기반 인가(Server·MeshTLSAuthentication·AuthorizationPolicy)와 NetworkPolicy 의 차이, 기본 정책(all-unauthenticated → deny)으로 가는 단계적 전환, 실험에서 확인한 tls·client_id 메트릭과 403"
tags: [mTLS, SPIFFE, 서비스 신원, 인증서 회전, 트러스트 앵커, AuthorizationPolicy, MeshTLSAuthentication, 제로 트러스트]
experiments: [mesh-mtls]
---

## 왜 IP 로 믿으면 안 되나

전통적인 네트워크 보안은 "10.0.3.0/24 에서 온 요청은 결제 서버" 처럼 **IP 로 신원을 추정**한다. 쿠버네티스에서는 이게 무너진다.

- Pod IP 는 재시작마다 바뀐다. 5분 전 결제 Pod 의 IP 를 지금은 다른 Pod 가 쓸 수 있다.
- 한 노드의 여러 Pod 가 섞여 있고, NAT·오버레이를 지나면 원래 IP 가 사라진다.
- 같은 네트워크 안에 들어온 공격자는 IP 를 흉내 낼 수 있다.

그래서 메시는 신원을 **암호학적 인증서**로 증명한다. TLS 의 양쪽이 모두 인증서를 내는 **mutual TLS** 로, 서버는 "누가 불렀는지" 를, 클라이언트는 "내가 원하는 서버가 맞는지" 를 확인한다([보안 02](/security/notes/02-tls-certificates)의 mTLS 를 서비스 간에 자동화한 것).

## 신원은 ServiceAccount 다

Linkerd 의 신원 형식:

```
<serviceaccount>.<namespace>.serviceaccount.identity.linkerd.cluster.local
client-meshed.mesh-lab-mtls.serviceaccount.identity.linkerd.cluster.local
```

Istio 는 **SPIFFE** 형식을 쓴다: `spiffe://cluster.local/ns/<namespace>/sa/<serviceaccount>`. SPIFFE(Secure Production Identity Framework For Everyone)는 "워크로드 신원을 URI 로, 인증서의 SAN 에 담는다" 는 표준이고, SVID(SPIFFE Verifiable Identity Document)가 그 인증서다. 형식은 달라도 생각은 같다: **신원 = 네임스페이스 + ServiceAccount**.

그러므로 서비스마다 **전용 ServiceAccount** 를 만들어야 한다. 모든 Pod 가 `default` SA 를 쓰면 메시 입장에서는 전부 같은 신원이라 인가 정책을 나눌 수 없다([보안 06](/security/notes/06-kubernetes-security)의 RBAC 와 같은 원칙).

## 인증서가 발급되는 흐름

```
① Pod 시작 → linkerd-proxy 가 키 쌍 생성 (개인키는 메모리에만, 디스크·Secret 에 없음)
② 프록시가 projected ServiceAccount 토큰 + CSR 을 linkerd-identity 에 보냄
③ identity 가 TokenReview API 로 토큰 검증 → "이 Pod 는 SA client-meshed 다"
④ 발급자(issuer) 인증서로 서명한 워크로드 인증서(수명 24h) 반환
⑤ 프록시가 만료 전에 ②~④ 를 반복 — 회전이 자동
```

### 3단 인증서 체인

| 인증서 | 수명 | 누가 관리 | 회전 |
|---|---|---|---|
| **트러스트 앵커**(루트) | 보통 1년~10년 | 사람(또는 cert-manager) | 드물다, 가장 위험한 작업 |
| **발급자**(intermediate) | 보통 1년 | 사람·cert-manager | 연 1회, 앵커는 그대로 |
| **워크로드**(프록시) | 24시간 | 프록시가 스스로 | 하루에도 여러 번, 자동 |

워크로드 인증서가 짧은 이유: 유출돼도 하루면 쓸모없어진다. 그래서 **폐기 목록(CRL/OCSP) 없이** 운영할 수 있다.

진짜 위험은 위 두 층이다. `linkerd install` 이 기본으로 만든 앵커·발급자는 **1년 뒤 만료**된다. 만료되면 새 워크로드 인증서가 발급되지 않아 메시 전체가 멈춘다. 그래서 운영 환경에서는:

- 앵커·발급자를 cert-manager 로 관리해 자동 갱신한다.
- 만료일을 알림에 건다([관측성 09](/observability/notes/09-alerting-pipeline)의 파이프라인에 "issuer 만료 30일 전" 규칙).
- 앵커 교체는 "새 앵커를 번들에 추가 → 모든 프록시 재시작 → 새 발급자로 교체 → 옛 앵커 제거" 의 단계를 밟는다.

이 클러스터의 설정을 직접 보면:

```bash
kubectl --context kind-study -n linkerd get cm linkerd-config -o jsonpath='{.data.values}' | grep -E 'issuanceLifetime|identityTrustDomain'
#   issuanceLifetime: 24h0m0s
#   identityTrustDomain: cluster.local
```

## 서버 프록시는 무엇을 보나

실험 `mesh-mtls` 에서 서버(whoami) 프록시의 메트릭을 읽은 결과:

```
request_total{direction="inbound", target_port="80", tls="true",
              client_id="client-meshed.mesh-lab-mtls.serviceaccount.identity.linkerd.cluster.local"} 10
request_total{direction="inbound", target_port="80", tls="no_identity",
              no_tls_reason="no_tls_from_remote"} 10
```

- `tls="true"` + `client_id`: 상대가 메시 안이고, 인증서로 신원이 증명됐다.
- `no_tls_from_remote`: 상대가 평문으로 왔다(메시 밖). 기본 정책(`all-unauthenticated`)이라 통과됐을 뿐이다.

앱은 어느 쪽인지 모른다. 둘 다 평문 HTTP 로 받았다. **암호화·신원은 프록시의 일**이다.

## 신원 기반 인가

Linkerd 정책 리소스 세 개로 "client-meshed 신원만 whoami:80 을 부를 수 있다" 를 건다.

```yaml
apiVersion: policy.linkerd.io/v1beta3
kind: Server                       # 보호할 대상: 어떤 Pod 의 어떤 포트
metadata: { name: whoami-http }
spec:
  podSelector: { matchLabels: { app: whoami } }
  port: 80
  proxyProtocol: HTTP/1
---
apiVersion: policy.linkerd.io/v1alpha1
kind: MeshTLSAuthentication        # 누구를: 신원 목록 (또는 serviceAccounts: [...])
metadata: { name: only-client-meshed }
spec:
  identities: ["client-meshed.mesh-lab-mtls.serviceaccount.identity.linkerd.cluster.local"]
---
apiVersion: policy.linkerd.io/v1alpha1
kind: AuthorizationPolicy          # 연결: 이 대상에 이 인증을 요구
metadata: { name: whoami-allow-client-meshed }
spec:
  targetRef: { group: policy.linkerd.io, kind: Server, name: whoami-http }
  requiredAuthenticationRefs:
    - { group: policy.linkerd.io, kind: MeshTLSAuthentication, name: only-client-meshed }
```

적용 후 실측:

| 클라이언트 | 정책 전 | 정책 후 |
|---|---|---|
| client-meshed (허용된 신원) | 200 × 10 | 200 × 10 |
| client-plain (신원 없음) | 200 × 10 | **403** × 10 |

`Server` 가 생기는 순간 그 포트의 기본 동작이 "허가된 것만" 으로 바뀐다. 그래서 순서가 중요하다. **AuthorizationPolicy 없이 Server 만 먼저 만들면 모든 요청이 거부된다.** 운영에서는 반드시 같은 커밋으로 함께 적용한다.

HTTP 라우트 단위로도 건다: `targetRef` 를 `HTTPRoute` 로 주면 "GET /health 는 누구나, POST /admin 은 운영 SA 만" 같은 L7 인가가 된다.

## NetworkPolicy 와의 차이

| 항목 | NetworkPolicy | 메시 AuthorizationPolicy |
|---|---|---|
| 판단 근거 | IP·포트·Pod/네임스페이스 레이블 | 인증서 신원(SA), HTTP 경로·메서드 |
| 집행 위치 | CNI(커널) | 프록시(유저 공간) |
| 메시 밖 Pod | 적용됨 | 적용 안 됨 — 메시 밖은 신원이 없다 |
| 계층 | L3/L4 | L4~L7 |
| 우회 위험 | 노드 수준에서 강제 | 프록시를 거치지 않는 경로(hostNetwork 등)는 못 막음 |

둘은 대체재가 아니라 **겹치는 층**이다. 실험실의 `sec-k8s-networkpolicy`([보안 06](/security/notes/06-kubernetes-security))로 기본 거부를 깔고, 메시로 신원 기반 L7 인가를 얹는 것이 심층 방어다.

## 기본 정책으로 단계적 전환

| 단계 | 설정 | 의미 |
|---|---|---|
| 1 | `all-unauthenticated` (기본) | 메시 밖도 통과. 관측만 |
| 2 | 메트릭에서 `no_tls_from_remote` 가 0 이 될 때까지 클라이언트를 메시에 편입 | |
| 3 | `cluster-authenticated` | 클러스터의 메시 신원이면 통과 |
| 4 | `deny` + 서비스별 AuthorizationPolicy | 제로 트러스트 — 허용된 신원만 |

`config.linkerd.io/default-inbound-policy` 어노테이션으로 네임스페이스·Pod 단위로 바꾼다. 한 번에 `deny` 로 가면 아무도 모르던 의존성(크론잡, 모니터링 스크레이퍼, 헬스체크)이 터진다 — 2단계의 메트릭 관찰이 전환의 핵심이다.

## 예시로 보기 — 이 프로젝트에서

- kube-prometheus-stack 의 Prometheus 가 메시 Pod 의 `:4191/metrics` 를 긁으려면, 제로 트러스트 단계에서 Prometheus SA 를 허용 목록에 넣어야 한다(`linkerd-viz` 확장은 이를 위한 정책을 함께 깐다).
- 이 사이트 앱이 Redis 를 부르는 6379 는 opaque 포트라 L7 정책이 아닌 L4(TCP) 신원 인가만 가능하다.
- 실험 `mesh-mtls` 의 정책 전파는 약 1~3초 걸렸다(실험은 403 이 나올 때까지 폴링). 정책은 destination 컨트롤러 → 서버 프록시로 스트리밍된다.

## 위협 모델 — 메시 mTLS 가 막는 것과 못 막는 것

| 공격 | 메시 mTLS 로 | 비고 |
|---|---|---|
| 노드·네트워크에서 패킷 엿보기 | **막음** — 프록시 사이가 암호화 | 같은 Pod 안(앱↔프록시, localhost)은 평문 |
| 다른 Pod 가 IP 를 흉내 내 접근 | **막음** — 인증서 없이는 신원 위조 불가 | |
| 탈취된 Pod 가 허용된 신원으로 호출 | **못 막음** — 그 Pod 의 신원은 진짜다 | 최소 권한 인가로 피해 범위만 줄인다 |
| ServiceAccount 토큰 탈취 | 일부 — 토큰으로 인증서를 받을 수 있음 | projected 토큰(짧은 수명·대상 지정) |
| 노드 root 탈취 | **못 막음** — 프록시 메모리의 키를 읽을 수 있음 | ambient 는 노드 프록시가 여러 Pod 의 키를 가짐 |
| 앱 취약점(SQL 인젝션 등) | 무관 | 메시는 L7 내용을 검사하지 않는다 |

제로 트러스트의 실제 의미는 "아무도 믿지 않는다" 가 아니라 **"네트워크 위치로 믿지 않는다"** 다. 신원은 증명하고, 권한은 최소로 준다([보안 01](/security/notes/01-security-mindset-threat-modeling)).

## 메시 밖과 통신하기

- **메시 밖 → 메시 안**: 기본 정책이 `all-unauthenticated` 면 평문으로 들어온다. `deny` 로 가려면 그 호출자를 메시에 넣거나, 특정 IP 대역을 `NetworkAuthentication` 으로 허용한다(예: 노드 헬스 체크, 인그레스 컨트롤러).
- **메시 안 → 클러스터 밖**: 외부 API 호출은 앱이 직접 TLS 를 한다. 메시는 TCP 로 통과시킨다. 이그레스 정책(`EgressNetwork`)으로 "어디로 나갈 수 있는지" 를 제한할 수 있다.
- **데이터베이스**: 클러스터 밖 RDS 같은 곳은 메시 신원이 닿지 않는다. DB 자체의 TLS·인증([보안 07](/security/notes/07-datastore-hardening))이 필요하다.

> 이어서 읽기: [메시 비교와 운영 — 인증서 루트 회전·장애 모드](/service-mesh/notes/07-mesh-comparison-ops) · [트래픽 정책](/service-mesh/notes/04-traffic-policy)

## 실습 체크리스트

- [ ] 실험 `mesh-mtls` 로 `tls="true"` 와 `no_tls_from_remote` 를 메트릭에서 구분하기
- [ ] Server 만 먼저 적용하면 메시 클라이언트도 403 이 되는지 확인하고, 이유를 설명하기
- [ ] `default` ServiceAccount 를 공유하는 두 Deployment 를 정책으로 구분할 수 없는 이유 설명
- [ ] 트러스트 앵커가 만료되면 무슨 일이 생기는지, 어떤 알림으로 미리 알 수 있는지 적기
- [ ] 같은 네임스페이스에 NetworkPolicy 기본 거부와 메시 인가를 함께 걸고, 각각이 막는 요청을 비교
