---
title: "알림 파이프라인 끝까지 — 규칙, Alertmanager, 라우팅, 웹훅, 온콜"
order: 9
level: 중급
summary: "장애가 사람에게 닿기까지의 네 단계(수집·평가·라우팅·전달)와 각 단계의 지연, 이 프로젝트의 3계층 규칙과 Alertmanager 설정 해부, 그룹화·억제·침묵, 웹훅 수신 엔드포인트 구현, Slack/PagerDuty 연결, 런북과 온콜 운영, 알림 품질 지표. 실험으로 실제 지연을 측정"
tags: [알림, Alertmanager, 라우팅, 웹훅, 억제, 침묵, 온콜, 런북]
experiments: [alert-pipeline-redis-down]
---

## 장애가 사람에게 닿는 네 단계

```
1. 수집   exporter/앱이 메트릭 노출 → Prometheus 스크레이프 (5s)
2. 평가   규칙 평가 (evaluation_interval 5s) → pending (for 동안) → firing
3. 라우팅 Alertmanager: 그룹화(group_wait/interval) → 억제·침묵 → 수신자 선택
4. 전달   웹훅/Slack/PagerDuty → 사람 (또는 자동 조치)
```

각 단계가 지연을 더한다: 스크레이프 ≤5s + `for` 30s + 평가 ≤5s + `group_wait` 0~30s + 전달 수 초 = **장애 후 40초~1분 뒤에 안다**. `for` 를 줄이면 빨라지지만 일시적 스파이크에 깨운다. 실험실의 **알림 파이프라인** 실험이 Redis 를 멈춰 이 시간을 실제로 잰다.

## 이 프로젝트의 규칙 — 3계층

`observability/alert-rules.yml`:

| 계층 | severity | 예 | 받는 쪽 |
|---|---|---|---|
| page (즉시 깨움) | `critical` | RedisDown, StudyAppDown, StudyAppRedisUnreachable | `study-app-critical` (group_wait 0, 30분마다 재전송) |
| ticket (근무 중 처리) | `warning` | RedisMemoryHigh, RedisEvictions, StudyExperimentFailures, LLM 비용 | `study-app` (그룹화 30s, 2시간 재전송) |
| log (기록만) | `info` | RedisSlowCommands, StudyActionSlow, **Watchdog** | 느슨한 그룹(5분), 24시간 재전송 |

```yaml
- alert: RedisDown
  expr: redis_up == 0 or absent(redis_up)      # exporter 자체가 사라져도 잡는다
  for: 30s
  labels: { severity: critical, alertname_group: redis }
  annotations:
    summary: "Redis 에 연결할 수 없음"
    description: "redis_up 이 30초 이상 0. pnpm redis:docker 상태와 docker logs 확인."
    runbook_url: "http://localhost:3000/redis/notes/14-ops-commands"
```

- `absent()` 는 "메트릭이 아예 없음" 을 잡는다. 타깃이 죽으면 `redis_up` 자체가 안 오기 때문.
- `alertname_group` 라벨은 억제(inhibit) 의 `equal` 기준이다.
- **Watchdog** 은 항상 firing. 이것이 멈추면 파이프라인이 죽은 것 — 외부 dead man's switch(healthchecks.io 등) 에 연결한다.

## Alertmanager 설정 해부

`observability/alertmanager.yml`:

```yaml
route:
  receiver: study-app                 # 매칭 안 되면 여기
  group_by: [alertname, severity]     # 같은 그룹은 한 통지로 묶는다
  group_wait: 10s                     # 그룹 첫 알림 후 추가 알림을 모을 시간
  group_interval: 30s                 # 그룹에 새 알림이 추가될 때 재전송 간격
  repeat_interval: 2h                 # 계속 firing 이면 다시 알리는 간격
  routes:
    - matchers: [severity="critical"]
      receiver: study-app-critical
      group_wait: 0s                  # 즉시
      repeat_interval: 30m
inhibit_rules:
  - source_matchers: [severity="critical"]
    target_matchers: [severity="warning"]
    equal: [alertname_group]          # Redis 가 죽었으면 Redis 메모리 경고는 숨긴다
receivers:
  - name: study-app
    webhook_configs: [{ url: http://host.docker.internal:3000/api/alerts, send_resolved: true }]
```

- **그룹화**: 노드 10대가 동시에 죽으면 알림 10개가 아니라 "NodeDown ×10" 한 통. `group_by` 에 `instance` 를 넣으면 다시 10통이 된다.
- **억제(inhibit)**: 원인 알림이 있을 때 결과 알림을 숨긴다. `equal` 라벨이 같은 것끼리만.
- **침묵(silence)**: 점검 시간 동안 특정 매처의 알림을 끈다. UI(:19093) 또는 `amtool silence add alertname=RedisDown --duration 1h --comment "점검"`.
- `send_resolved: true` 로 복구 알림도 보낸다 — 채널에서 사건이 닫히는 게 보여야 한다.
- 고가용성: Alertmanager 를 2~3대 **클러스터**(gossip)로 띄우고 Prometheus 가 모두에 보낸다. 중복 제거는 AM 이 한다.

## 웹훅 수신 — 이 앱의 /api/alerts

```ts
// src/app/api/alerts/route.ts (요지)
export async function POST(req: Request) {
  const payload = await req.json();            // { receiver, status, alerts: [{ status, labels, annotations, startsAt, endsAt, fingerprint }] }
  for (const a of payload.alerts) {
    metrics.alertsReceived.inc({ alertname: a.labels.alertname, severity: a.labels.severity, status: a.status });
    logger.warn("alert.received", { alertname: a.labels.alertname, severity: a.labels.severity, status: a.status });
  }
  await storeAlerts(normalized);               // Redis List alerts:recent (최근 200)
  return Response.json({ ok: true });
}
```

**알림 수신 경로는 장애 중인 의존성에 기대면 안 된다.** 처음 구현은 알림을 Redis 에 저장했는데, RedisDown 알림이 올 때 Redis 가 멈춰 있어 저장이 블록되고 웹훅이 타임아웃됐다(실험에서 실제로 겪음). 지금은 프로세스 메모리 링 버퍼에 먼저 넣고 Redis 에는 1초 타임아웃으로 best-effort 저장한다. 같은 원리로 알림 채널(Slack)이 자기 회사 인프라에 의존하면 안 된다.

관측성 대시보드의 **최근 알림** 카드가 이 리스트를 보여준다. 웹훅은 자동 조치의 출발점이기도 하다: RedisDown → 컨테이너 재시작, 디스크 부족 → 로그 정리 Job. 단, 자동 조치는 멱등하고 상한(시간당 N회)이 있어야 한다.

## 채널 연결

```yaml
# Slack
receivers:
  - name: slack-critical
    slack_configs:
      - api_url: https://hooks.slack.com/services/…        # 또는 api_url_file
        channel: "#alerts-critical"
        send_resolved: true
        title: '[{{ .Status | toUpper }}{{ if eq .Status "firing" }}:{{ .Alerts.Firing | len }}{{ end }}] {{ .CommonLabels.alertname }}'
        text: >-
          {{ range .Alerts }}*{{ .Annotations.summary }}*
          {{ .Annotations.description }}
          <{{ .Annotations.runbook_url }}|런북> · <http://localhost:13000/d/study-redis|대시보드>
          {{ end }}
# PagerDuty (Events API v2) — critical 만
  - name: pagerduty
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/pd_key
        severity: '{{ .CommonLabels.severity }}'
# 이메일, OpsGenie, Telegram, MS Teams, 범용 webhook 도 지원
```

템플릿은 Go template. 메시지에 **무엇이 깨졌는지 + 어디를 보면 되는지(런북·대시보드 링크)** 가 한눈에 들어와야 한다.

## 런북

알림마다 `runbook_url` 을 두고, 런북은 이렇게 쓴다:

```
# RedisDown
영향: 세션·캐시·실험 전부 불가. 사용자에게 500.
확인: docker ps | grep study-redis ; docker logs --tail 50 study-redis ; redis-cli -p 6379 ping
원인별 조치:
  - 컨테이너 종료: pnpm redis:docker
  - 멈춤(hang): docker restart study-redis (AOF 로 복구됨, 최대 1초 유실)
  - 메모리: INFO memory, maxmemory 상향 또는 큰 키 삭제
에스컬레이션: 10분 내 복구 안 되면 …
```

이 프로젝트의 런북 링크는 해당 노트를 가리킨다. 실제 운영에선 위키/저장소의 런북 페이지.

## 온콜 운영

- 로테이션(주 단위), 1차/2차, 인수인계 노트.
- 알림 1건 = 반드시 조치 또는 규칙 수정. "그냥 그런 거" 알림은 즉시 삭제/조정.
- 사후 분석(postmortem): 비난 없이, 타임라인·원인·조치·재발 방지. 알림이 **없었던** 장애는 규칙 추가 대상.
- 주간 리뷰 지표: 알림 수(심각도별), 응답까지 시간(MTTA), 복구까지 시간(MTTR), 조치 없이 닫힌 비율(노이즈), 야간 page 수.

```promql
sum by (alertname) (increase(study_alerts_received_total{status="firing"}[7d]))     # 가장 시끄러운 알림
```

## 흔한 실패

| 증상 | 원인 | 대응 |
|---|---|---|
| 알림이 안 옴 | Prometheus → AM 연결, 라우트 매처 오타, 웹훅 URL | `prometheus_notifications_errors_total`, AM 로그, Watchdog 확인 |
| 폭주 | group_by 과다, 억제 없음 | 그룹화·억제·for |
| 복구 알림 없음 | `send_resolved: false`, resolve_timeout | 설정 |
| 같은 알림 반복 | repeat_interval 짧음 | 늘리기, 근본 원인 해결 |
| 점검 중 알림 | 침묵 미설정 | amtool silence |
| 깨웠는데 조치 불가 | 런북 없음 | 런북 필수 |

## 실습 체크리스트

- [ ] 관측성 대시보드에 Watchdog(info) 가 도착해 있는지 확인
- [ ] 실험실의 **알림 파이프라인** 실험을 돌려 firing·resolved 까지의 초를 읽기
- [ ] `for: 30s` 를 `5s` 로 바꾸고 다시 측정 (Prometheus 재시작 또는 `/-/reload`)
- [ ] Alertmanager UI(:19093)에서 RedisDown 에 1시간 침묵을 걸고 실험을 다시 돌려 알림이 안 오는 것 확인
- [ ] Slack 웹훅이 있다면 critical 수신자에 연결해 메시지 템플릿 다듬기
- [ ] 가장 시끄러운 알림 PromQL 로 노이즈 점검
