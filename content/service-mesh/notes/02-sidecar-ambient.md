---
title: "사이드카 vs ambient — 프록시를 어디에 둘까"
order: 2
level: 기초
summary: "Pod 마다 프록시를 붙이는 사이드카 모델과 노드·네임스페이스 단위 프록시로 옮긴 ambient 모델(Istio ztunnel + waypoint), 트래픽 가로채기(iptables·eBPF)의 원리, 쿠버네티스 네이티브 사이드카(restartPolicy: Always initContainer)가 해결한 시작·종료 순서 문제, Linkerd proxy·Envoy·ztunnel 의 자원 비용 비교, 이 클러스터에서 확인한 주입 결과"
tags: [사이드카, ambient, ztunnel, waypoint, Envoy, linkerd-proxy, iptables, 네이티브 사이드카, initContainer]
experiments: [mesh-mtls, mesh-traffic-split]
---

## 프록시는 어떻게 트래픽을 가로채나

앱은 `http://web/` 을 부를 뿐 프록시를 모른다. 그런데도 요청이 프록시를 거치는 이유는 **Pod 의 네트워크 네임스페이스 안 iptables 규칙** 때문이다.

```
Pod 네트워크 네임스페이스
  앱 ─connect(10.96.0.5:80)─▶ [iptables OUTPUT: 나가는 TCP 를 127.0.0.1:4140 으로 REDIRECT]
                                        ▼
                               linkerd-proxy outbound(4140) ─▶ 목적지 결정·LB·mTLS ─▶ 상대 Pod
  들어오는 TCP ─▶ [iptables PREROUTING: 4143 으로 REDIRECT] ─▶ linkerd-proxy inbound(4143) ─▶ 앱:80
```

- 이 규칙을 까는 것이 **linkerd-init** 이다(또는 CNI 플러그인). Pod 가 뜰 때 한 번 실행되고 끝난다.
- 프록시 자신이 보내는 트래픽은 UID(2102)로 구분해 다시 가로채지 않는다 — 안 그러면 무한 루프다.
- 포트 `4191` 은 프록시 관리 포트(메트릭·헬스), `4190` 은 컨트롤 플레인 통신용.
- 프로토콜 감지: 프록시는 연결 첫 바이트로 HTTP/1·HTTP/2 를 알아낸다. 서버가 먼저 말하는 프로토콜(MySQL·SMTP 등)은 감지가 10초 지연되므로 **opaque 포트**로 지정해 TCP 로만 다룬다(Linkerd 기본 opaque: 25, 587, 3306, 5432, 6379 …).

같은 일을 iptables 대신 **eBPF**(cgroup/connect 훅, [eBPF 04](/ebpf/notes/04-networking-xdp-tc-cilium))로 하면 규칙 순회 비용과 conntrack 부담이 줄어든다. Cilium 과 Istio ambient 가 그 방향이다.

## 사이드카 모델

Pod 마다 프록시 컨테이너 하나.

| 장점 | 단점 |
|---|---|
| 격리가 강하다 — 프록시가 그 Pod 의 트래픽만 본다 | 자원 비용이 Pod 수에 비례 |
| 신원 = 그 Pod 의 ServiceAccount, 명확하다 | 프록시 업그레이드 = 모든 Pod 재시작 |
| 장애 반경이 Pod 하나 | 시작·종료 순서 문제(아래) |
| 성숙하다(Linkerd·Istio 기본) | 앱과 같은 자원 제한 안에서 경쟁 |

### 시작·종료 순서 문제와 네이티브 사이드카

일반 컨테이너로 붙인 사이드카에는 고질병이 셋 있었다.

1. **시작 경쟁**: 앱이 프록시보다 먼저 떠서 첫 요청이 실패한다(Linkerd 는 `proxy-await` 로 앱 시작을 막아 우회).
2. **종료 경쟁**: Pod 종료 시 프록시가 먼저 죽으면 앱의 마지막 요청이 실패한다.
3. **Job 이 끝나지 않는다**: 앱 컨테이너가 끝나도 프록시가 계속 살아 있어 Job 이 Completed 가 안 된다.

쿠버네티스 1.28+ 의 **네이티브 사이드카**가 이걸 해결했다: `initContainers` 에 `restartPolicy: Always` 를 주면 그 컨테이너는 다른 init 이 끝나길 기다리지 않고 계속 떠 있으며, **앱 컨테이너보다 먼저 시작해 앱이 끝난 뒤 종료**된다.

```yaml
spec:
  initContainers:
    - name: linkerd-init           # iptables 규칙 설치 후 종료
    - name: linkerd-proxy          # restartPolicy: Always → 네이티브 사이드카
      restartPolicy: Always
  containers:
    - name: whoami                 # 앱
```

이 클러스터의 Linkerd 는 `proxy.nativeSidecar: true` 로 설치돼 있어서, 실험 `mesh-mtls` 에서 확인한 주입 결과가 이렇다.

```
whoami         init=linkerd-init linkerd-proxy   containers=whoami
client-meshed  init=linkerd-init linkerd-proxy   containers=curl
client-plain   init=                             containers=curl
```

`kubectl get pods` 의 READY 가 `1/1` 로 보여도 프록시가 없는 게 아니다 — initContainer 라 컨테이너 수에 안 잡힌다. "사이드카가 안 붙었나?" 로 착각하기 쉬운 지점이다.

## ambient 모델 — 프록시를 Pod 밖으로

Istio ambient 는 프록시를 두 층으로 나눠 Pod 밖으로 뺐다.

```
노드마다            ztunnel (Rust, L4)  ── 모든 Pod 의 mTLS·L4 인가·텔레메트리
네임스페이스/서비스마다  waypoint (Envoy, L7) ── 필요할 때만: HTTP 라우팅·재시도·L7 인가
```

| 항목 | 사이드카 | ambient |
|---|---|---|
| 프록시 수 | Pod 수 | 노드 수 (+ 필요한 곳에만 waypoint) |
| 메시 편입 | Pod 재시작 필요 | 네임스페이스 레이블만, 재시작 없음 |
| L7 기능 | 항상 | waypoint 를 둔 곳만 |
| 신원 | Pod 의 SA | ztunnel 이 Pod 별 신원을 대신 들고 있음 |
| 장애 반경 | Pod 하나 | ztunnel 장애 = 노드의 모든 Pod |
| 홉 | 프록시 2번 | L4 만이면 ztunnel 2번, L7 이면 waypoint 추가 |

ambient 는 "mTLS 만 원하는데 Pod 마다 Envoy 50MB 는 아깝다" 는 요구에서 나왔다. 대가는 **노드 프록시가 여러 테넌트의 비밀(인증서)을 함께 들고 있다**는 보안 모델 변화와, 노드 단위 장애 반경이다.

Cilium 메시는 L4·mTLS 를 eBPF(커널)로, L7 은 노드당 Envoy 로 처리한다 — ambient 와 비슷한 "Pod 밖 프록시" 방향이다.

## 프록시 비교

| 프록시 | 언어 | 메모리(유휴, 대략) | 성격 |
|---|---|---|---|
| **linkerd-proxy** (linkerd2-proxy) | Rust | 10~20MB | 메시 전용, 설정 표면이 작다, 메모리 안전 |
| **Envoy** | C++ | 50MB+ (설정 크기에 비례) | 범용 L7 프록시, 기능 최다, xDS API |
| **ztunnel** | Rust | 노드당 수십 MB | ambient 의 L4 전용 |

Envoy 메모리는 **클러스터 크기에 비례**해 커진다. 모든 서비스의 엔드포인트 정보를 다 받기 때문이다. Istio 는 `Sidecar` 리소스로 "이 Pod 가 알아야 할 서비스만" 범위를 줄인다. 큰 클러스터에서 사이드카 메모리가 GB 단위로 쌓이는 흔한 원인이다.

## 자원 요청과 FinOps

사이드카 자원은 Pod 마다 곱해진다. Pod 500개 × 프록시 요청 100m CPU = 50 코어가 **요청만으로** 예약된다. 비용 배분은 [FinOps 03](/finops/notes/03-kubernetes-cost)의 requests vs 실사용 분석을 프록시 컨테이너에도 그대로 적용해야 한다.

```yaml
metadata:
  annotations:
    config.linkerd.io/proxy-cpu-request: "20m"
    config.linkerd.io/proxy-memory-request: "20Mi"
    config.linkerd.io/proxy-memory-limit: "128Mi"
```

## 예시로 보기 — 이 프로젝트에서

- 주입은 Pod 템플릿 어노테이션 `linkerd.io/inject: enabled` 로 했다. 네임스페이스에 붙이면 그 안의 모든 새 Pod 가 주입된다.
- 실험 `mesh-traffic-split` 은 메시 클라이언트와 메시 밖 클라이언트를 같은 Service 에 보낸다. 메시 밖 클라이언트는 HTTPRoute 분할을 **전혀 적용받지 않았다**(40/40 이 v1). 사이드카 모델에서 정책은 **호출하는 쪽 프록시**에서 실행되기 때문이다. ambient 에서는 같은 정책이 waypoint 에서 실행되므로, 호출자가 메시에 있든 없든 서비스로 들어가는 트래픽 전체에 적용된다 — 모델이 바꾸는 미묘한 차이다.
- Docker Desktop 의 linuxkit 커널에서 iptables 모드는 `nft` 로 설정된다(`proxyInit.iptablesMode: nft`).

## 주입을 제어하는 어노테이션

| 어노테이션 | 어디에 | 뜻 |
|---|---|---|
| `linkerd.io/inject: enabled` | 네임스페이스·Pod 템플릿 | 프록시 주입 |
| `linkerd.io/inject: disabled` | Pod 템플릿 | 네임스페이스가 enabled 여도 이 Pod 는 제외 |
| `config.linkerd.io/opaque-ports: "5432,6379"` | Service·Pod | 프로토콜 감지 없이 TCP 로만 프록시 |
| `config.linkerd.io/skip-outbound-ports: "4222"` | Pod | 이 포트로 나가는 트래픽은 프록시를 우회(가로채지 않음) |
| `config.linkerd.io/skip-inbound-ports` | Pod | 들어오는 포트 우회 |
| `config.linkerd.io/proxy-await: enabled` | Pod | 프록시가 준비될 때까지 앱 시작을 막음(네이티브 사이드카 이전의 우회책) |
| `config.linkerd.io/default-inbound-policy` | 네임스페이스·Pod | 기본 인가 정책(all-unauthenticated · cluster-authenticated · deny) |

`skip-*-ports` 는 강력하지만 **그 포트의 트래픽은 mTLS·관측·정책 밖**이 된다. 성능 문제로 우회하기 전에, 그 트래픽이 보호받지 않아도 되는지 먼저 따진다.

## 사이드카를 디버깅하는 법

```bash
kubectl -n mesh-lab-mtls logs deploy/whoami -c linkerd-proxy            # 프록시 로그 (warn 이상)
kubectl -n mesh-lab-mtls logs deploy/whoami -c linkerd-init             # iptables 설치 로그
linkerd diagnostics proxy-metrics -n mesh-lab-mtls deploy/whoami        # 프록시 메트릭 (4191)
linkerd diagnostics endpoints web.mesh-lab-retry.svc.cluster.local:80   # destination 이 아는 엔드포인트
linkerd diagnostics policy -n mesh-lab-mtls po/<pod> 80                 # 이 포트에 적용된 인바운드 정책
kubectl -n linkerd logs deploy/linkerd-destination -c destination       # 컨트롤 플레인 쪽
```

증상별 첫 확인:

| 증상 | 먼저 볼 것 |
|---|---|
| 연결이 10초 멈춘 뒤 진행 | 프로토콜 감지 — opaque 포트 지정 필요 |
| 메시 Pod 가 시작 안 됨 | `linkerd-init` 로그(iptables 권한), identity 컨트롤러 |
| 특정 호출만 403 | `linkerd diagnostics policy`, AuthorizationPolicy 의 신원 철자 |
| 엔드포인트가 안 바뀜 | `linkerd diagnostics endpoints`, destination 컨트롤러 상태 |

> 이어서 읽기: [mTLS 와 서비스 신원](/service-mesh/notes/03-mtls-identity) · [카나리와 트래픽 분할 — 호출 쪽 프록시에서 나눈다](/service-mesh/notes/06-canary-traffic-split) · [메시 비교와 운영 — 장애 모드](/service-mesh/notes/07-mesh-comparison-ops) · [운영체제 07 — 컨테이너는 결국 프로세스](/os-internals/notes/07-containers-are-processes)

## 실전에서는 어디에 쓰이나

> 프록시를 Pod 옆에 둘지 노드에 둘지는 "Pod 수 × 프록시 비용" 이 눈에 띄게 커지거나, Job·배치가 사이드카 때문에 끝나지 않을 때 실제 결정 문제가 된다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| Pod 수천 개의 대형 커머스 클러스터 | Envoy 사이드카 메모리가 GB 단위로 쌓임 | ambient(ztunnel) 로 L4 만 노드 단위, L7 은 필요한 서비스에만 waypoint | 사이드카 유지 + `Sidecar` 리소스로 엔드포인트 범위 축소 |
| 데이터 파이프라인·ML 배치 Job | 앱이 끝나도 프록시가 살아 Job 이 Completed 가 안 됨 | 네이티브 사이드카(`restartPolicy: Always` initContainer) | Job 은 `linkerd.io/inject: disabled` 로 메시 밖 |
| 핀테크 멀티 테넌트 클러스터 | 테넌트 간 키·장애 반경 격리 | Pod 별 사이드카로 신원·장애를 Pod 단위로 | ambient 는 노드 프록시가 여러 테넌트 키를 쥐므로 보안 검토 필요 |
| PostgreSQL·Redis 를 부르는 SaaS 백엔드 | 연결이 10초씩 멈추는 프로토콜 감지 지연 | 5432·6379 를 opaque 포트로 지정해 TCP 로만 프록시 | `skip-outbound-ports` 로 우회(단, mTLS·관측 밖) |

**이럴 땐 안 맞는다**
- 사이드카: 짧게 뜨고 사라지는 Pod 가 아주 많은 환경(배치·서버리스형) — 매번 프록시 기동·인증서 발급 비용을 낸다. 해당 워크로드만 메시에서 빼거나 노드 단위 프록시를 쓴다.
- ambient: 노드 하나의 프록시 장애가 그 노드 전체 Pod 에 번지는 것을 받아들일 수 없는 곳 — 사이드카가 장애 반경이 작다.

**누가 매일 만나나** — 플랫폼 엔지니어는 프록시 자원 요청값과 주입 어노테이션 표준을 정할 때, SRE 는 "READY 1/1 인데 사이드카가 없나?" 같은 질문과 `linkerd-init` 로그를 볼 때 만난다.

**면접·실무 단골 질문**
- Q. 앱은 프록시를 모르는데 트래픽이 어떻게 프록시를 지나나? → Pod 네트워크 네임스페이스의 iptables(또는 eBPF) 규칙이 나가고 들어오는 TCP 를 프록시 포트로 REDIRECT 한다. 프록시 자신의 트래픽은 UID 로 제외한다.
- Q. 네이티브 사이드카가 해결한 것은? → 시작 경쟁·종료 경쟁·Job 미종료. 앱보다 먼저 시작하고 앱이 끝난 뒤 종료된다.

## 실습 체크리스트

- [ ] 메시 Pod 의 `spec.initContainers` 에서 `linkerd-proxy` 와 `restartPolicy: Always` 를 찾기
- [ ] `kubectl exec` 로 메시 Pod 안에서 `cat /proc/net/nf_conntrack` 이나 iptables 규칙을 볼 수 없는 이유 설명(권한·이미지)
- [ ] 메시 Job 을 하나 만들어 Completed 가 되는지 확인 — 네이티브 사이드카 덕분
- [ ] PostgreSQL(5432)·Redis(6379) 가 opaque 포트인 이유를 프로토콜 감지 관점에서 설명
- [ ] 사이드카 1000개 클러스터의 프록시 메모리 총량을 Linkerd·Envoy 각각 계산해 보기
