---
title: "카나리와 트래픽 분할 — HTTPRoute 가중치로 요청 단위 배포"
order: 6
level: 심화
summary: "복제본 비율 카나리와 요청 비율 카나리의 차이, Gateway API HTTPRoute 를 Service 에 붙이는 GAMMA 모델(parentRefs kind Service), 가중치·헤더 기반 라우팅·미러링, 분할이 클라이언트 프록시에서 일어난다는 것의 의미, Argo Rollouts 와 메시를 엮은 자동 카나리(trafficRouting plugin + AnalysisTemplate), 세션 고정·DB 스키마·롤백 함정, 실험에서 잰 90/10 → 10.0%, 50/50 → 50.0%, 0/100 → 100% 와 메시 밖 클라이언트 0%"
tags: [카나리, 트래픽 분할, Gateway API, HTTPRoute, GAMMA, Argo Rollouts, 미러링, 점진 배포]
experiments: [mesh-traffic-split]
---

## 복제본 비율 vs 요청 비율

[쿠버네티스 13](/kubernetes/notes/13-gitops-progressive-delivery)의 Argo Rollouts 카나리는 **복제본 비율**로 트래픽을 나눴다: 복제본 4개 중 1개를 새 버전으로 → 약 25%.

| 방식 | 비율 단위 | 1% 카나리 | 정확도 |
|---|---|---|---|
| 복제본 비율 | 1/복제본 수 | 복제본 100개 필요 | kube-proxy 무작위라 흔들림 |
| 요청 비율(메시·인그레스) | 1% 단위 | 복제본 1개로 가능 | 요청 단위로 정확 |

요청 비율이면 새 버전은 복제본 1개로 두고 트래픽만 1% → 5% → 25% → 100% 로 올린다. 복제본 수(용량)와 노출 비율(위험)이 분리된다.

## Gateway API 로 Service 를 라우팅한다 (GAMMA)

Gateway API 의 `HTTPRoute` 는 원래 인그레스(북-남 트래픽)용이다([쿠버네티스 12](/kubernetes/notes/12-network-policy-mesh)). GAMMA 이니셔티브는 같은 리소스를 **서비스 간(동-서) 트래픽**에 쓰게 했다: `parentRefs` 에 Gateway 대신 **Service** 를 준다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: echo-split }
spec:
  parentRefs: [{ group: core, kind: Service, name: echo, port: 80 }]   # "echo 로 가는 요청은"
  rules:
    - backendRefs:
        - { name: echo-v1, port: 80, weight: 90 }                     # 90 은 v1
        - { name: echo-v2, port: 80, weight: 10 }                     # 10 은 v2
```

- 부모 Service `echo` 는 클라이언트가 부르는 이름이다. 셀렉터는 무엇이든 되지만(여기서는 v1), 메시 클라이언트에게는 HTTPRoute 가 우선한다.
- backend Service `echo-v1`·`echo-v2` 는 버전별 Pod 를 가리킨다.
- Linkerd·Istio·Cilium 모두 이 API 를 지원한다. 메시를 바꿔도 라우팅 정의를 유지할 수 있다는 것이 표준의 가치다.

### 헤더 기반 라우팅과 미러링

```yaml
rules:
  - matches: [{ headers: [{ name: x-canary, value: "true" }] }]      # 내부 테스터만 v2
    backendRefs: [{ name: echo-v2, port: 80 }]
  - backendRefs: [{ name: echo-v1, port: 80 }]                       # 나머지는 v1
```

미러링(섀도 트래픽)은 실제 응답은 v1 로 주면서 같은 요청을 v2 에도 보내 결과를 버린다. 새 버전의 오류·지연을 사용자 영향 없이 본다. 단, **쓰기 요청을 미러링하면 두 번 쓴다** — 읽기 경로에만.

## 실험 결과

실험 `mesh-traffic-split` 은 가중치를 세 번 바꾸며 메시 클라이언트로 불렀다.

| 가중치 v1 / v2 | v1 | v2 | v2 비율 |
|---|---|---|---|
| 90 / 10 | 180 | 20 | 10.0% |
| 50 / 50 | 100 | 100 | 50.0% |
| 0 / 100 | 0 | 100 | 100.0% |

같은 시점(0/100)에 **메시 밖 클라이언트**가 같은 Service 를 40번 부르자 40번 모두 v1 이었다. 분할은 **호출하는 쪽 프록시**가 하기 때문이다. 메시 밖 호출자(크론잡, 다른 클러스터, 인그레스 컨트롤러)가 있다면 그들에게는 카나리가 보이지 않는다 — 인그레스 컨트롤러도 메시에 넣거나, 게이트웨이에도 같은 분할을 걸어야 한다.

가중치 변경은 `kubectl apply` 후 약 1~3초 안에 반영됐다(실험은 5초 대기). destination 컨트롤러가 HTTPRoute 를 watch 해 클라이언트 프록시로 밀어 주는 시간이다.

## Argo Rollouts 와 엮기 — 자동 카나리

수동으로 가중치를 올리는 대신, Rollouts 가 단계마다 HTTPRoute 가중치를 바꾸고 메트릭으로 판정하게 한다.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
spec:
  strategy:
    canary:
      canaryService: echo-v2
      stableService: echo-v1
      trafficRouting:
        plugins:
          argoproj-labs/gatewayAPI:
            httpRoute: echo-split          # Rollouts 가 이 HTTPRoute 의 가중치를 고친다
            namespace: mesh-lab-split
      steps:
        - setWeight: 5
        - analysis: { templates: [{ templateName: mesh-success-rate }] }
        - setWeight: 25
        - pause: { duration: 5m }
        - setWeight: 100
```

분석 템플릿은 메시 메트릭을 쓴다 — 새 버전의 **outbound 성공률**과 p99 지연([노트 05](/service-mesh/notes/05-observability)):

```yaml
metrics:
  - name: success-rate
    successCondition: result[0] >= 0.99
    provider:
      prometheus:
        query: |
          sum(rate(response_total{dst_service="echo-v2", direction="outbound", classification="success"}[2m]))
          / sum(rate(response_total{dst_service="echo-v2", direction="outbound"}[2m]))
```

판정이 실패하면 Rollouts 가 가중치를 0 으로 되돌린다. 복제본을 지울 필요도 없다. SLO 기반 자동 롤백([SRE 07](/sre/notes/07-slo-driven-automation))의 메시 구현이다.

## 카나리의 함정

| 함정 | 증상 | 대처 |
|---|---|---|
| 표본이 너무 적다 | 1% × 낮은 트래픽 = 몇 분에 요청 수 건, 판정 불가 | 최소 요청 수 조건, 단계별 시간 늘리기 |
| 세션 고정 필요 | 같은 사용자가 v1·v2 를 오가며 UI 가 깨짐 | 헤더·쿠키 기반 라우팅으로 사용자 단위 고정 |
| DB 스키마 비호환 | v2 가 쓴 데이터를 v1 이 못 읽음 | 확장-축소 마이그레이션([SRE 06](/sre/notes/06-capacity-release-change)) |
| 비동기 경로 | 카나리는 HTTP 만, Kafka 소비자는 v2 가 전부 처리 | 메시지 경로는 별도 카나리(소비자 그룹 분리) |
| 메시 밖 호출자 | 실험처럼 분할이 안 보임 | 인그레스·게이트웨이에도 동일 분할 |
| 롤백이 데이터는 못 되돌림 | v2 가 이미 쓴 레코드 | 쓰기 경로는 플래그로 보호 |

## 예시로 보기 — 이 프로젝트에서

이 프로젝트의 `k8s/rollouts/web-rollout.yaml` 은 복제본 비율 카나리(4개 중 1개 = 25%)다. 메시를 쓰는 버전으로 바꾸려면:

1. `study` 네임스페이스의 `web` 에 Linkerd 를 주입한다(ArgoCD 매니페스트에 어노테이션 추가 → git 커밋).
2. `web-canary-stable`·`web-canary-preview` Service 를 backend 로 하는 HTTPRoute 를 둔다.
3. Rollout 의 `trafficRouting.plugins` 에 Gateway API 플러그인을 지정한다(Rollouts 에 플러그인 설치 필요).
4. 분석 템플릿을 `study_redis_up` 대신 메시 성공률로 바꾼다.

실험 `mesh-traffic-split` 은 이 중 2단계(HTTPRoute 분할)가 실제로 요청 단위로 정확히 동작함을 보여 준다.

![요청 단위 트래픽 분할](/diagrams/mesh-traffic-split.svg)

## 단계별 카나리 예시 타임라인

| 시각 | 가중치 v2 | 하는 일 | 중단 조건 |
|---|---|---|---|
| T+0 | 0% | v2 배포(복제본 1개), 헤더 라우팅으로 내부 테스터만 | 스모크 테스트 실패 |
| T+10m | 1% | 실제 트래픽 노출 시작 | v2 성공률 < v1 − 0.5%p |
| T+30m | 5% | 표본이 판정 가능한 크기가 됨 | p99 > v1 × 1.2 |
| T+1h | 25% | 용량 검증 시작 — v2 복제본 늘림 | 오류 예산 소진 속도 > 2배 |
| T+2h | 50% | | |
| T+3h | 100% | v1 은 즉시 지우지 않고 하루 보관(빠른 롤백) | |

판정은 **v1 과 v2 를 같은 시간대에 비교**한다. 절대 기준(99.9%)만 보면 그 시간대 전체 장애(의존성 문제)를 v2 탓으로 오판한다. Kayenta 같은 도구가 두 그룹의 통계적 차이를 검정한다.

## 무엇을 비교하나

| 지표 | 비교 방법 | 주의 |
|---|---|---|
| 성공률 | v2 − v1 | 표본이 작으면 신뢰 구간이 넓다 |
| p50 · p99 | 비율 | 캐시가 차기 전 v2 는 느리다(워밍업) |
| 자원 | Pod 당 CPU·메모리 | 메모리 누수는 시간이 지나야 보인다 |
| 비즈니스 | 전환율·결제 성공 | 메시 밖 지표 — 별도 수집 |

> 이어서 읽기: [메시 비교와 운영](/service-mesh/notes/07-mesh-comparison-ops) · [사이드카 vs ambient — 분할이 어디서 일어나나](/service-mesh/notes/02-sidecar-ambient)

## 실습 체크리스트

- [ ] 실험 `mesh-traffic-split` 을 돌리고 메시 밖 클라이언트가 분할을 받지 않는 이유를 설명
- [ ] `x-canary: true` 헤더만 v2 로 보내는 HTTPRoute 를 작성해 적용
- [ ] 트래픽이 분당 10건인 서비스에서 1% 카나리 판정에 필요한 시간을 계산
- [ ] Argo Rollouts 의 Gateway API 플러그인 설정을 이 프로젝트의 web-rollout 에 맞춰 설계
- [ ] 쓰기 요청 미러링이 위험한 이유와 안전하게 하는 방법(읽기 전용 v2, 별도 DB)을 적기
