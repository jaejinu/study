---
title: "심화 — SLO 기반 자동화: 릴리스 게이트, 자동 롤백, 버짓 소진 시 차단"
order: 7
level: 심화
summary: "SLO 를 사람의 판단에서 시스템의 입력으로 옮기는 네 단계(대시보드 → 알림 → 게이트 → 자동 조치), Argo Rollouts AnalysisTemplate 을 SLO 기반(에러율·지연 비율의 baseline 대비 비교)으로 다시 쓰는 법과 함정(표본·NaN·캐시 웜업), CI 의 릴리스 게이트로 에러 버짓 잔여를 조회해 배포를 막는 GitHub Actions 단계, 번레이트 알림을 웹훅으로 받아 기능 플래그를 자동으로 끄는 설계와 안전장치(서킷·사람 승인·감사), 자동 조치의 위험(자동화 폭주, 관측 스택 장애 시 오판)과 대책, SLO 리포트 자동 생성"
tags: [SLO, 자동화, Argo Rollouts, AnalysisTemplate, 릴리스 게이트, 자동 롤백, 기능 플래그, GitHub Actions, 웹훅]
experiments: [sre-slo-recording-rules, sre-burn-rate-under-chaos]
---

## SLO 의 네 단계 성숙도

| 단계 | SLO 의 역할 | 사람이 하는 일 |
|---|---|---|
| 1. 대시보드 | 보는 숫자 | 가끔 확인 |
| 2. 알림 | 번레이트가 페이지를 보낸다 | 대응 |
| 3. **게이트** | 배포·승격이 SLO 를 조건으로 진행/중단 | 예외 승인 |
| 4. **자동 조치** | 버짓 소진 시 시스템이 스스로 보수적으로 | 감사·튜닝 |

[02](/sre/notes/02-sli-slo-error-budget)·[03](/sre/notes/03-burn-rate-alerting) 이 1·2 단계였다. 이 노트는 3·4.

## 게이트 1: 카나리 분석을 SLO 로

현재 `k8s/rollouts/web-rollout.yaml` 의 AnalysisTemplate 은 "살아 있나" 만 본다. SLO 기반으로 다시 쓴다:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: { name: slo-canary, namespace: study }
spec:
  args:
    - name: canary-hash      # Rollouts 가 자동 주입 ({{args.canary-hash}})
    - name: stable-hash
  metrics:
    # 1) 카나리 에러율이 SLO 허용치(0.5%) 의 2배 이하  — 절대 기준
    - name: canary-error-ratio
      interval: 30s
      count: 6                 # 3분간 6회
      successCondition: "len(result) == 0 || result[0] <= 0.01"
      failureLimit: 2          # 6회 중 2회 실패하면 롤백 (일시 노이즈 허용)
      provider:
        prometheus:
          address: http://kps-kube-prometheus-stack-prometheus.monitoring:9090
          query: |
            sum(rate(study_action_duration_seconds_count{outcome="error", pod=~".*{{args.canary-hash}}.*"}[2m]))
            / sum(rate(study_action_duration_seconds_count{pod=~".*{{args.canary-hash}}.*"}[2m]))
    # 2) 카나리 지연 SLI(≤250ms 비율) 가 stable 대비 2%p 이상 나쁘지 않다 — 상대 기준
    - name: latency-vs-stable
      interval: 30s
      count: 6
      successCondition: "len(result) == 0 || result[0] >= -0.02"
      failureLimit: 2
      provider:
        prometheus:
          address: http://kps-kube-prometheus-stack-prometheus.monitoring:9090
          query: |
            (sum(rate(study_action_duration_seconds_bucket{le="0.25", pod=~".*{{args.canary-hash}}.*"}[2m]))
              / sum(rate(study_action_duration_seconds_count{pod=~".*{{args.canary-hash}}.*"}[2m])))
            -
            (sum(rate(study_action_duration_seconds_bucket{le="0.25", pod=~".*{{args.stable-hash}}.*"}[2m]))
              / sum(rate(study_action_duration_seconds_count{pod=~".*{{args.stable-hash}}.*"}[2m])))
    # 3) 최소 표본: 2분간 카나리 요청이 30개 미만이면 "판단 불가" → 실패가 아니라 inconclusive 로 처리
    - name: enough-traffic
      interval: 30s
      count: 6
      successCondition: "len(result) > 0 && result[0] >= 30"
      inconclusiveLimit: 6     # 표본 부족은 롤백이 아니라 사람 판단(paused)
      provider:
        prometheus:
          address: http://kps-kube-prometheus-stack-prometheus.monitoring:9090
          query: sum(increase(study_action_duration_seconds_count{pod=~".*{{args.canary-hash}}.*"}[2m]))
```

Rollout 쪽:

```yaml
strategy:
  canary:
    steps:
      - setWeight: 25
      - pause: { duration: 60s }         # 캐시 웜업 — 첫 1분은 비교하지 않는다
      - analysis:
          templates: [{ templateName: slo-canary }]
          args:
            - { name: canary-hash, valueFrom: { podTemplateHashValue: Latest } }
            - { name: stable-hash, valueFrom: { podTemplateHashValue: Stable } }
      - setWeight: 50
      - pause: { duration: 60s }
      - setWeight: 100
```

### 함정

- **NaN/빈 결과**: 트래픽이 없으면 비율이 NaN → `len(result) == 0` 분기를 둬야 한다. 그리고 그것이 "통과" 인지 "판단 불가" 인지 명시한다(위에서는 에러율은 통과, 표본은 inconclusive).
- **Pod 레이블**: kube-prometheus-stack 이 긁는 메트릭에는 `pod` 레이블이 붙는다. 앱 자체 메트릭이라면 Rollouts 가 Pod 에 넣는 `rollouts-pod-template-hash` 를 앱이 레이블로 노출해야 한다(Downward API 로 env → prom-client 기본 레이블).
- **웜업**: 새 Pod 는 JIT·캐시가 비어 처음 30초가 느리다. 첫 pause 뒤에 비교.
- **stable 도 새로 띄울 것**: 공정 비교를 위해 Kayenta 식 baseline 을 원하면 `experiment` 단계로 stable 복제본을 새로 띄운다.
- `failureLimit` 로 노이즈를 흡수하고, `inconclusiveLimit` 로 "모르겠음" 은 사람에게.

## 게이트 2: CI 에서 에러 버짓 확인

배포 파이프라인 첫 단계에서 Prometheus 에 버짓 잔여를 묻는다. 소진이면 배포를 중단(예외 레이블 있으면 통과):

```yaml
# .github/workflows/deploy.yml (발췌)
jobs:
  budget-gate:
    runs-on: self-hosted            # Prometheus 에 접근 가능한 러너
    outputs: { ok: ${{ steps.q.outputs.ok }} }
    steps:
      - id: q
        run: |
          REMAIN=$(curl -s "$PROM/api/v1/query" --data-urlencode \
            'query=1 - (1 - sum(increase(study_action_duration_seconds_count{outcome!="error"}[30d])) / sum(increase(study_action_duration_seconds_count[30d]))) / (1 - 0.995)' \
            | jq -r '.data.result[0].value[1] // "1"')
          echo "remaining budget ratio: $REMAIN"
          if (( $(echo "$REMAIN < 0" | bc -l) )) && [[ "${{ contains(github.event.head_commit.message, '[budget-override]') }}" != "true" ]]; then
            echo "::error::에러 버짓 소진 ($REMAIN). 신뢰성 수정만 배포 가능. 예외는 커밋 메시지에 [budget-override] + 리드 승인"
            exit 1
          fi
  deploy:
    needs: budget-gate
    ...
```

버짓이 10~50% 면 중단 대신 **카나리 단계를 늘리는 변수**를 출력해 Rollout 에 넘길 수도 있다 — 정책([02](/sre/notes/02-sli-slo-error-budget))을 코드로.

## 자동 조치: 번레이트 → 기능 플래그 차단

```
Prometheus(번레이트 page 알림) → Alertmanager → 웹훅 /api/alerts
  → 앱: alertname=SLOBurnRateFast 이면 "위험 기능" 플래그를 off (Redis 키 flags:expensive_features=0)
  → 알림 resolved 면 복구 (또는 사람 승인 후)
```

이 프로젝트의 `/api/alerts` 는 이미 알림을 받는다. 거기에 **조치 핸들러**를 붙이면 4단계다. 예: 번레이트 알림이 오면 AI 도우미(LLM 호출, 비싸고 느림)와 실험 실행을 잠시 막아 핵심 여정(노트 읽기·진행률)의 버짓을 지킨다 — **부하 차단**([성능 08](/performance/notes/08-tail-latency-at-scale))을 SLO 가 트리거하는 형태.

### 안전장치 (자동 조치의 필수 조건)

1. **서킷**: 같은 조치가 10분에 3회 이상이면 멈추고 사람 호출. 자동화 폭주(flapping 알림 → 플래그 on/off 반복)를 막는다.
2. **관측 스택 장애 시 오판 방지**: Prometheus 가 죽으면 번레이트 질의가 빈 값 → "문제 없음" 으로 읽으면 안 되고, "판단 불가" 로. Watchdog 알림(항상 firing)이 끊기면 자동 조치를 비활성화.
3. **되돌리기 경로**: 자동으로 껐으면 자동으로 켜거나(알림 resolved + 10분), 최소한 켜는 버튼이 대시보드에.
4. **감사 로그**: 누가(어떤 알림이) 언제 무엇을 바꿨나 — `logger.warn("auto.action", {...})` 와 메트릭 `study_auto_actions_total{action, trigger}`.
5. **단계적 도입**: 처음엔 "제안만"(로그·알림 본문에 "플래그 off 권장"), 몇 주 정밀도를 본 뒤 자동으로.
6. **범위 제한**: 자동 조치는 **안전한 방향**만(기능 끄기, 롤백, 스케일 아웃). 스케일 인·삭제·설정 변경은 사람.

## SLO 리포트 자동 생성

분기 리뷰용 리포트는 스크립트로:

```promql
# 30일 SLI 달성률
sum(increase(study_action_duration_seconds_count{outcome!="error"}[30d])) / sum(increase(study_action_duration_seconds_count[30d]))
# 버짓 소진 이벤트 수 (번레이트 알림 firing 횟수)
sum(increase(study_alerts_received_total{alertname=~".*BurnRate.*", status="firing"}[30d]))
# 가장 많이 버짓을 쓴 날 (일별 에러율 상위)
topk(3, max_over_time((1 - slo:action_availability:ratio_rate5m)[30d:1d]))
```

리포트 항목: SLO 별 달성률, 버짓 잔여 추세, 소진 이벤트와 연결된 포스트모템, 알림 정밀도, 토일 비율. 숫자가 자동으로 나오면 리뷰는 "왜" 에 집중할 수 있다.

## 예시로 보기 — 이 프로젝트에서 끝까지

1. 실험 `sre-slo-recording-rules` → 레코딩·알림 규칙 검증 → `observability/alert-rules.yml` 에 반영.
2. 위 `slo-canary` AnalysisTemplate 을 `k8s/rollouts/` 에 추가, Rollout 이 참조하도록 수정(kps Prometheus 는 앱 메트릭을 `study` 네임스페이스 ServiceMonitor 로 긁어야 `pod` 레이블이 붙는다 — [k8s 10](/kubernetes/notes/10-monitoring-stack)).
3. `study:dev3` 로 승격해 AnalysisRun 의 세 지표가 어떻게 판정되는지 본다. 트래픽이 없으면 `enough-traffic` 이 inconclusive → Rollout 이 paused → 그게 올바른 동작이다. k6 로 트래픽을 주고 다시.
4. `/api/alerts` 에 조치 핸들러(제안 모드)를 붙이고 실험 `sre-burn-rate-under-chaos` 로 알림을 유발해 로그에 "권장 조치" 가 찍히는지 본다.
5. 두 주 뒤 정밀도를 보고 자동 모드로.

## 실전에서는 어디에 쓰이나

> 배포가 너무 잦아 사람이 매번 SLO 를 보고 판단할 수 없을 때, SLO 를 배포 게이트와 자동 조치의 입력으로 옮긴다. 사람은 예외 승인과 자동화의 정밀도 감사만 맡는다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 쿠버네티스 위 SaaS 배포 | 카나리가 "살아 있나" 만 봐서 회귀 통과 | Argo Rollouts AnalysisTemplate 에 에러율·지연 비율의 stable 대비 비교, 표본 부족은 inconclusive | 사람이 대시보드 보고 승격 |
| 핀테크 배포 파이프라인 | 버짓을 다 쓴 상태에서 기능 배포 강행 | CI 첫 단계에서 Prometheus 로 버짓 잔여 조회, 소진이면 차단 + 예외 레이블 | 구두 합의된 버짓 정책 |
| AI 기능이 붙은 서비스 | 비싼 LLM 호출이 핵심 여정의 버짓을 잠식 | 번레이트 알림 웹훅 → 기능 플래그로 고비용 기능 자동 차단 | 장애 때마다 사람이 플래그 수동 조작 |
| 대규모 플랫폼 조직의 분기 리뷰 | SLO 숫자를 손으로 모으는 토일 | PromQL 로 달성률·소진 이벤트·상위 소진일 리포트 자동 생성 | 스프레드시트 수작업 |

**이럴 땐 안 맞는다**
- 관측 스택 자체가 불안정한 환경: Prometheus 가 비면 "문제 없음" 으로 오판한다. Watchdog 이 끊기면 자동 조치를 끄고, 먼저 관측 신뢰성부터 확보한다.
- 되돌리기 어려운 조치(스케일 인·삭제·설정 변경): 자동화하면 폭주 시 피해가 크다. 기능 끄기·롤백·스케일 아웃 같은 안전한 방향만 자동화한다.

**누가 매일 만나나** — 플랫폼·SRE 엔지니어는 AnalysisTemplate 과 CI 게이트를 유지보수할 때, 백엔드 개발자는 자동 롤백된 배포의 AnalysisRun 결과를 읽을 때 만난다.

**면접·실무 단골 질문**
- Q. 자동 롤백의 위험은? → 노이즈·관측 장애로 인한 오판과 폭주. failureLimit·서킷·감사 로그·제안 모드 단계적 도입으로 막는다.
- Q. 카나리 판정에서 트래픽이 없으면? → 통과도 실패도 아닌 "판단 불가" 로 처리해 사람에게 넘긴다.

## 실습 체크리스트

- [ ] `slo-canary` AnalysisTemplate 을 적용하고 트래픽 없이 승격 → inconclusive 로 멈추는 것 확인 → k6 로 트래픽 주고 통과시키기
- [ ] `study:dev2` 이미지에 일부러 에러를 넣어(예: 액션이 10% 확률로 throw) 자동 롤백을 유발, `kubectl argo rollouts get rollout web-canary` 로 Degraded 와 AnalysisRun Failed 확인
- [ ] CI 에 버짓 게이트 잡을 추가(로컬 러너가 없다면 `workflow_dispatch` 로 수동 실행)
- [ ] `/api/alerts` 에 "번레이트 알림이면 로그에 권장 조치 기록" 핸들러 추가, 실험으로 검증
- [ ] 자동 조치 안전장치 6개 중 서킷과 감사 로그를 먼저 구현
