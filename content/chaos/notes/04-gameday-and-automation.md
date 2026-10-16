---
title: "게임데이 설계와 카오스 자동화 — 가설, 폭발 반경, 중단 조건, Litmus·Chaos Mesh, CI 연결"
order: 4
level: 심화
summary: "실험실의 단발 실험을 조직의 관행으로 바꾸는 법. 게임데이의 구조(가설→정상 상태 정의→폭발 반경→중단 조건→실행→복기), 운영에서 해도 되는 실험의 조건, Kubernetes 네이티브 카오스 도구(Litmus, Chaos Mesh, Gremlin)의 모델과 CRD 예시, 실험을 CI/정기 작업으로 돌리는 파이프라인, 관측 스택과 묶어 '복원력 회귀' 를 잡는 방법, 그리고 흔한 실패"
tags: [게임데이, 카오스 엔지니어링, 폭발 반경, 중단 조건, Litmus, Chaos Mesh, 정상 상태, 복원력 회귀, CI]
experiments: [chaos-k8s-pod-kill-under-load, chaos-kafka-broker-restart, chaos-circuit-breaker]
---

[01 원칙](/chaos/notes/01-chaos-principles) 에서 "가설을 세우고 실험한다" 고 했다. 이 노트는 그것을 **반복 가능한 행사(게임데이)** 와 **자동화된 파이프라인**으로 만드는 법이다. 실험실 버튼을 한 번 누르는 것과 매주 프로덕션 비슷한 환경에서 자동으로 도는 것 사이의 간격이 조직의 복원력 차이다.

## 게임데이의 구조

게임데이는 "오늘 장애를 일부러 내 보자" 가 아니라 **가설 검증 회의**다. 한 번에 2~3시간, 월 1회가 흔하다.

| 단계 | 산출물 | 예 |
|---|---|---|
| 1. 정상 상태 정의 | 지표와 범위 | 체크아웃 성공률 ≥ 99.5%, p95 < 800ms, 큐 지연 < 5s |
| 2. 가설 | "X 를 해도 정상 상태가 유지된다" | "Redis 프라이머리가 죽어도 Sentinel 이 10초 안에 승격하고 체크아웃 성공률은 99% 이상이다" |
| 3. 폭발 반경 | 영향 범위 상한 | 스테이징 전체 / 프로덕션 트래픽 1% / 한 AZ |
| 4. 중단 조건 | 자동·수동 abort | 에러율 > 2% 가 1분 지속, 또는 누구든 "중단" |
| 5. 실행 | 타임라인 기록 | 주입 시각, 관측된 신호, 복구 시각 |
| 6. 복기 | 액션 아이템 | "타임아웃 3초 → 500ms", "런북 7단계 추가" |

가설이 **틀리면** 성공이다 — 장애가 나기 전에 알았으니까. 가설이 맞으면 폭발 반경을 넓혀 다음 실험으로.

### 좋은 가설의 조건

- **측정 가능한 정상 상태**가 먼저. "서비스가 잘 돈다" 는 가설이 아니다. SLI 가 있어야 한다([SRE](/sre)).
- **한 번에 변수 하나.** Redis 멈춤과 PG 느려짐을 동시에 넣으면 무엇이 원인인지 모른다.
- **현실적인 장애.** 포스트모템·장애 카탈로그([02](/chaos/notes/02-failure-catalog))에서 고른다. "운석 충돌" 보다 "인증서 만료" 가 먼저.
- **복구 경로가 있다.** 되돌릴 수 없는 실험은 실험이 아니라 사고다.

## 폭발 반경과 중단 조건 — 안전장치가 먼저

폭발 반경은 **설계**한다:

```
스테이징 전체 → 프로덕션 카나리 1 Pod → 1% 트래픽 → 1 AZ → 1 리전
```

각 단계에서 가설이 유지될 때만 다음으로. 그리고 중단 조건은 **자동**이어야 한다 — 사람이 대시보드를 보다가 누르는 건 느리다. 카오스 도구의 "probe"(Litmus) 나 "status check"(Gremlin) 가 SLI 를 폴링해 임계를 넘으면 실험을 **스스로 멈추고 되돌린다**.

이 실험실의 코드 실험도 같은 구조다: `requires`(사전 조건), `run`(주입과 측정), `cleanup`/`finally`(복구). `chaos-circuit-breaker` 는 `finally` 에서 반드시 `docker unpause` 한다 — 실험이 실패해도 Redis 는 돌아온다.

하지만 `finally` 는 **실험이 실패할 때**만 지켜 준다. **실험이 사라질 때**(프로세스 강제 종료, 러너 타임아웃, 노트북 절전)는 못 지킨다. 그래서 중단 조건에는 세 번째 층이 필요하다:

| 층 | 무엇이 트리거하나 | 이 프로젝트 |
|---|---|---|
| 1. 프로브 중단 | SLI 가 임계를 넘음 | 실험 안의 `check`·타임아웃 |
| 2. `finally`/`cleanup` | 실험 코드가 예외로 끝남 | 모든 실험 |
| 3. **데드맨 스위치** | 실험 프로세스가 사라짐 | `src/lib/deadman.ts` — 주입 직전 장전, 정상 종료 시 해제 |

Litmus·Chaos Mesh 가 실험을 CRD 로 두고 **컨트롤러**가 원복하는 이유가 같다: 원복의 수명이 실험 클라이언트와 분리돼 있다. 3층이 없을 때 무슨 일이 생기는지는 [노트 01](/chaos/notes/01-chaos-principles)의 실제 사고(Redis 2시간 57분 정지)와 [장애 지도](/diagrams/chaos-fault-map.svg)를 보라.

## 프로덕션에서 해도 되는가

조건을 만족할 때만:

1. 스테이징에서 **같은 실험이 통과**했다.
2. 정상 상태 SLI 가 실시간으로 보이고 **자동 중단**이 걸려 있다.
3. 폭발 반경이 작다(카나리·일부 트래픽) 와 롤백이 **초 단위**다.
4. 온콜과 이해관계자가 **알고 있다**(알림 채널에 공지, 변경 캘린더 등록).
5. 피크 시간·릴리스 직후·프리즈 기간은 피한다.

Netflix 가 프로덕션에서 Chaos Monkey 를 돌리는 건 위 조건이 **자동으로** 충족되는 플랫폼을 먼저 만들었기 때문이다. 순서를 바꾸면 안 된다.

## Kubernetes 네이티브 도구

세 도구 모두 "실험을 CRD 로 선언하고 컨트롤러가 주입·검증·정리" 하는 모델이다. 이 실험실의 `chaos-k8s-pod-kill-under-load` 를 선언형으로 쓰면:

### Litmus (CNCF)

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata: { name: web-pod-delete, namespace: study }
spec:
  appinfo: { appns: study, applabel: "app=web", appkind: deployment }
  chaosServiceAccount: litmus-admin
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - { name: TOTAL_CHAOS_DURATION, value: "60" }
            - { name: CHAOS_INTERVAL, value: "10" }
            - { name: PODS_AFFECTED_PERC, value: "50" }
        probe:                                   # 정상 상태 = 중단 조건
          - name: web-availability
            type: httpProbe
            mode: Continuous
            httpProbe/inputs:
              url: http://web.study.svc:3000/api/metrics
              method: { get: { criteria: "==", responseCode: "200" } }
            runProperties: { probeTimeout: 2s, interval: 2s, retry: 1 }
```

`probe` 가 실패하면 실험 결과(ChaosResult)가 Fail 이 되고, 설정에 따라 즉시 중단한다. 결과는 CRD 로 남아 **히스토리**가 된다.

### Chaos Mesh (CNCF)

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata: { name: redis-latency, namespace: study }
spec:
  action: delay
  mode: all
  selector: { namespaces: [study], labelSelectors: { app: redis } }
  delay: { latency: "200ms", jitter: "50ms" }
  duration: "2m"
---
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule                        # 정기 실행
metadata: { name: weekly-pod-kill }
spec:
  schedule: "0 10 * * 2"              # 매주 화요일 10시
  type: PodChaos
  podChaos: { action: pod-kill, mode: one, selector: { labelSelectors: { app: web } } }
```

Chaos Mesh 의 강점은 **네트워크·I/O·시간·커널** 장애(지연·유실·분단·디스크 지연·시계 왜곡)까지 CRD 로 다룬다는 것. `Workflow` CRD 로 여러 장애를 순서대로 엮는다.

### 비교

| | Litmus | Chaos Mesh | Gremlin (상용) |
|---|---|---|---|
| 모델 | ChaosEngine + 실험 허브(100+) | 장애 종류별 CRD + Workflow | SaaS 에이전트 |
| 정상 상태 검사 | probe (http/cmd/prom/k8s) | 외부(Argo/Prometheus 와 조합) | status check |
| 네트워크/커널 장애 | 일부 | 강함(tc·iptables·시간) | 강함 |
| 대시보드 | ChaosCenter | Dashboard | 포함 |
| 적합 | 실험 라이브러리·GitOps | 세밀한 네트워크·스케줄 | 플랫폼팀 없는 조직 |

이 프로젝트의 kind 클러스터에 둘 다 Helm 으로 설치할 수 있다(`helm install chaos-mesh chaos-mesh/chaos-mesh -n chaos-mesh --create-namespace --set chaosDaemon.runtime=containerd --set chaosDaemon.socketPath=/run/containerd/containerd.sock`). kind 는 containerd 라 소켓 경로 지정이 필요하다.

## 자동화 — CI 와 정기 실행

실험을 사람이 누르는 한 "가끔 하는 행사" 로 남는다. 세 단계:

1. **PR 체크**: 복원력에 관련된 코드(클라이언트 설정, 재시도 로직)가 바뀌면 `chaos-circuit-breaker`·`chaos-retry-storm` 같은 **빠른 코드 실험**(10초)을 CI 에서 돌린다. 이 저장소의 CI 는 Redis 서비스 컨테이너를 쓰므로 `docker pause` 는 못 하지만, 타임아웃·재시도 로직은 가짜 서버로 검증할 수 있다([GitHub Actions 06](/github-actions/notes/06-ci-performance)).
2. **야간/주간 스케줄**: 스테이징에 Chaos Mesh `Schedule` 로 Pod kill·네트워크 지연을 돌리고 SLI 가 유지됐는지 **리포트**(Slack). 실패하면 이슈 자동 생성.
3. **배포 파이프라인 게이트**: 카나리 단계에서 작은 장애(복제본 1개 kill)를 주입하고 분석이 통과해야 승격 — [Argo Rollouts AnalysisTemplate](/kubernetes/notes/13-gitops-progressive-delivery) 에 카오스 단계를 넣는다.

```yaml
# 예: GitHub Actions 야간 게임데이 (스테이징 클러스터)
on: { schedule: [{ cron: "0 18 * * 1-5" }] }
jobs:
  chaos:
    steps:
      - run: kubectl apply -f chaos/pod-kill-web.yaml
      - run: kubectl wait --for=jsonpath='{.status.experimentStatus.verdict}'=Pass chaosresult/web-pod-delete --timeout=5m
      - if: failure()
        run: gh issue create --title "복원력 회귀: web pod-kill 실패 $(date)" --body-file chaos/report.md
```

**복원력 회귀**: 지난달엔 통과했는데 이번엔 실패 — 누군가 타임아웃을 지웠거나 복제본을 1로 줄였다. 자동화의 진짜 가치는 이 회귀를 잡는 것이다.

## 관측과 묶기

게임데이 타임라인은 손으로 적지 말고 관측 스택에서 뽑는다:

- 주입 시각을 **Grafana 어노테이션**으로 남긴다(`POST /api/annotations`, 태그 `chaos`). 모든 패널에 세로선이 생긴다.
- Alertmanager 알림(`/api/alerts`), Loki 의 에러 로그, Tempo 의 느린 트레이스를 주입 시각 기준으로 모으면 포스트모템 타임라인이 **자동**으로 나온다([관측성 09](/observability/notes/09-alerting-pipeline)).
- "장애가 알림으로 보이기까지" 가 실험의 또 다른 측정값이다 — `alert-pipeline-redis-down` 실험이 재는 73초가 곧 탐지 시간(TTD).

## 흔한 실패

| 실패 | 왜 | 처방 |
|---|---|---|
| 정상 상태 없이 실험 | "뭔가 느려진 듯" 으로 끝남 | SLI 먼저. 숫자가 없으면 실험을 미룬다 |
| 복구 스크립트 없음 | 실험이 사고가 됨 | `cleanup` 을 먼저 쓰고 실험을 쓴다 |
| 복구가 실험 프로세스 안에만 있음 | 실험이 끊기면 장애가 남음 (이 프로젝트에서 실제로 3시간) | 데드맨 스위치·컨트롤러처럼 수명이 독립된 원복 |
| 스테이징이 프로덕션과 다름 | 통과해도 의미 없음 | 토폴로지·설정·데이터 크기를 맞추거나 프로덕션 카나리로 |
| 결과를 아무도 안 봄 | 행사로 끝남 | 액션 아이템을 이슈로, 다음 게임데이에서 검증 |
| 너무 큰 폭발 반경으로 시작 | 첫 실험에서 신뢰를 잃음 | 가장 작은 범위에서 시작해 넓힌다 |
| 동시에 여러 변수 | 원인 불명 | 하나씩 |

## 예시로 보기 — 이 프로젝트의 게임데이 한 회

1. 정상 상태: `/api/metrics` 200 비율 100%, 앱 RED p95 < 300ms (Prometheus `study_action_*`).
2. 가설: "web 복제본 하나가 죽어도 요청 실패는 0건이다."
3. 주입: `chaos-k8s-pod-kill-under-load` (0.5초 간격 요청 중 Pod 강제 삭제).
4. 관측: 실패 요청 수, Pod 재생성 시간, 준비 프로브 통과까지.
5. 결과: 복제본 2 + 준비 프로브 + 그레이스풀 셧다운이면 0건, 복제본 1 이면 수 초 실패 — 이것이 "복제본 ≥ 2" 라는 **근거 있는** 규칙이 된다.
6. 액션: `k8s/web.yaml` 의 replicas 를 ArgoCD `ignoreDifferences` 로 두되 최소 2 를 HPA minReplicas 로 고정.

## 실습 체크리스트

- [ ] 장애 카탈로그에서 하나를 골라 위 표 형식(정상 상태·가설·폭발 반경·중단 조건)으로 게임데이 계획서를 쓰기
- [ ] kind-study 에 Chaos Mesh 를 설치하고 `NetworkChaos` 로 redis 에 200ms 지연을 넣은 뒤 `chaos-redis-hang` 의 타임아웃 클라이언트가 어떻게 반응하는지 보기
- [ ] 실험 시작·종료를 Grafana 어노테이션으로 남기는 스크립트를 만들고 대시보드에서 확인
- [ ] `chaos-circuit-breaker` 를 GitHub Actions 에서 돌릴 수 있게 Redis 멈춤 대신 가짜 느린 서버로 바꿔 보기(복원력 회귀 테스트)
