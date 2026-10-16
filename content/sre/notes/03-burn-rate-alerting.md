---
title: "멀티윈도우 번레이트 알림 — 임계값 알림을 버려야 하는 이유"
order: 3
level: 중급
summary: "번레이트의 정의(버짓을 소진하는 속도)와 SLO 기간·알림 창·번레이트·소진 비율의 관계식, 단순 임계값 알림의 네 가지 문제(정밀도·재현율·탐지 시간·리셋 시간), 구글 SRE 워크북의 6단계 진화(임계값 → 긴 창 → 번레이트 → 멀티 번레이트 → 멀티윈도우 → 멀티윈도우 멀티번레이트)와 각 단계가 고치는 것, 1h/6h/3d 창과 14.4·6·1 배 번레이트가 나오는 계산, 짧은 창으로 리셋 시간 줄이기, 이 프로젝트 alert-rules.yml 에 추가하는 실제 규칙과 Alertmanager 라우팅"
tags: [번레이트, 알림, SLO, 멀티윈도우, Prometheus, Alertmanager, 정밀도, 재현율, 리셋 시간]
experiments: [sre-slo-recording-rules, sre-burn-rate-under-chaos]
---

## 번레이트 — 버짓을 쓰는 속도

```
번레이트 = 관측된 에러율 / (1 - SLO)
```

SLO 99.9% 면 허용 에러율 0.1%. 지금 에러율이 0.1% 면 번레이트 **1** — SLO 기간(30일) 끝에 정확히 버짓을 다 쓴다. 에러율 1% 면 번레이트 10 — 3일 만에 소진. 번레이트 1 은 "계획대로", 10 은 "이대로면 3일 뒤 SLO 위반", 100 은 "7시간".

| 번레이트 | 30일 버짓 소진까지 | 1시간 동안 지속 시 소진 비율 |
|---|---|---|
| 1 | 30일 | 0.14% |
| 2 | 15일 | 0.28% |
| 6 | 5일 | 0.83% |
| 10 | 3일 | 1.4% |
| 14.4 | 2.08일 | **2%** |
| 36 | 20시간 | 5% |
| 100 | 7.2시간 | 14% |
| 1000 (전면 장애) | 43분 | 139% |

관계식: `소진 비율 = 번레이트 × 알림 창 / SLO 기간`. 이 식 하나로 모든 번레이트 알림이 설계된다.

## 임계값 알림의 네 가지 문제

흔한 규칙: `에러율 > 1% for 5m → 페이지`. 평가 축:

| 축 | 뜻 | 임계값 알림의 문제 |
|---|---|---|
| **정밀도**(precision) | 울린 알림 중 진짜 비율 | 5분 창은 노이즈에 울린다(요청 100개 중 2개 실패 = 2%) |
| **재현율**(recall) | 진짜 문제 중 울린 비율 | 0.9% 에러가 하루 종일이면(번레이트 9, 하루에 버짓 30% 소진) 안 울린다 |
| **탐지 시간**(detection time) | 문제 시작 → 알림 | 5분 |
| **리셋 시간**(reset time) | 문제 해결 → 알림 해제 | 5분 (창 크기) |

네 축은 서로 당긴다: 창을 늘리면 정밀도 ↑ 탐지 시간 ↑ 리셋 시간 ↑. 번레이트 알림은 이 트레이드오프를 **버짓 소진량**이라는 하나의 기준으로 정리한다: "이 속도면 X 시간 안에 버짓의 Y% 를 쓴다" 일 때만 울린다.

## 6단계 진화 (SRE 워크북 5장)

### 1. 임계값: `에러율 > 0.1% for 10m`
문제: 0.1% 는 번레이트 1 — 30일 내내 지속돼야 SLO 를 어긴다. 10분 지속에 페이지를 보내면 **매일 새벽에 깨운다**. 정밀도 최악.

### 2. 창을 늘린다: 36시간 창에서 번레이트 ≥ 1
36시간 × 번레이트 1 = 버짓 5% 소진. 정밀도는 좋아졌지만 **전면 장애(번레이트 1000)에도 36시간 창이 채워지길 기다려야** 하는 건 아니다 — 아니, 창 평균이라 2분 만에 넘는다. 진짜 문제는 **리셋 시간**: 장애가 끝나도 36시간 동안 창에 남아 알림이 안 꺼진다.

### 3. 번레이트 임계: 1시간 창에서 번레이트 ≥ 14.4
14.4 × 1h / 720h = **2%**. "1시간 만에 월 버짓 2% 를 썼다" 는 페이지할 가치가 있다. 탐지 시간: 전면 장애면 `1h × 2% / 100%` ≈ 1.2분. 좋다. 문제: 번레이트 5(6일이면 소진)는 안 잡는다 — 재현율.

### 4. 멀티 번레이트: 창·번레이트 조합
```
1h  창, 번레이트 14.4  → 버짓 2%   → page
6h  창, 번레이트 6     → 버짓 5%   → page
3d  창, 번레이트 1     → 버짓 10%  → ticket (업무 시간에 보면 됨)
```
느린 누수(번레이트 1~6)도 3일 창이 잡는다. 긴급도가 창에 따라 달라진다. 남은 문제: **리셋 시간**. 6h 창 알림은 장애가 끝나도 최대 6시간 켜져 있다 → 온콜이 "이제 괜찮은데 왜 울리지" 하다가 진짜 재발을 놓친다.

### 5. 멀티윈도우: 긴 창 AND 짧은 창
긴 창(1h)은 "충분히 많이 썼다", 짧은 창(5m = 긴 창의 1/12)은 "**지금도** 타고 있다". 둘 다 참일 때만 울린다. 장애가 끝나면 5m 창이 먼저 떨어져 알림이 5분 안에 꺼진다. 리셋 시간 해결.

### 6. 멀티윈도우 멀티번레이트 (최종형)

![멀티윈도우 번레이트](/diagrams/sre-burn-rate.svg)

| 심각도 | 긴 창 | 짧은 창 | 번레이트 | 소진 | 대응 |
|---|---|---|---|---|---|
| page | 1h | 5m | 14.4 | 2% / 1h | 즉시 |
| page | 6h | 30m | 6 | 5% / 6h | 즉시 |
| ticket | 1d | 2h | 3 | 10% / 1d | 업무 시간 |
| ticket | 3d | 6h | 1 | 10% / 3d | 업무 시간 |

```promql
# page: 빠른 소진
(slo:action_error:ratio_rate1h  > (14.4 * (1 - 0.999)) and slo:action_error:ratio_rate5m  > (14.4 * (1 - 0.999)))
or
(slo:action_error:ratio_rate6h  > (6    * (1 - 0.999)) and slo:action_error:ratio_rate30m > (6    * (1 - 0.999)))
```

번레이트 숫자가 왜 14.4·6·3·1 인가: 소진 비율을 정하고 역산했다. `번레이트 = 소진비율 × SLO기간 / 창` → 2% × 720h / 1h = 14.4, 5% × 720h / 6h = 6, 10% × 720h / 24h = 3, 10% × 720h / 72h = 1.

## 트래픽이 적을 때

로컬 개발 서버나 새벽의 작은 서비스는 1시간에 요청 10개일 수 있다. 1개 실패 = 10% 에러율 = 번레이트 100 → 페이지. 대책:
- **분모 하한**: `and sum(rate(...count[1h])) > 1` (초당 1요청 이상일 때만).
- **합성 트래픽**: 헬스 프로브를 꾸준히 보내 분모를 채운다(단, SLI 분모 "유효 이벤트" 에서 프로브를 빼지 않는 결정을 명시).
- **윈도우 기반 SLI** 로 바꾼다.
- 작은 서비스는 **SLO 를 낮춘다**(99.9% 는 분당 요청이 수천 개일 때 의미가 있다).

## 예시로 보기 — 이 프로젝트에 넣기

[관측성 노트 09](/observability/notes/09-alerting-pipeline) 의 3계층 규칙(critical/warning/info)은 **원인 기반**(RedisDown, 메모리 80%)이다. 거기에 **증상 기반** SLO 그룹을 추가한다. 실험 `sre-slo-recording-rules` 가 만드는 규칙:

```yaml
groups:
  - name: slo.study-app.rules      # 레코딩 (여러 창)
    rules:
      # hang 이면 redis_up 이 '사라지므로' 스크레이프 성공 여부로 채운다 (노트 02 함정 1)
      - record: slo:redis_connectivity_error:ratio_5m
        expr: 1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[5m:])
      - record: slo:redis_connectivity_error:ratio_1h
        expr: 1 - avg_over_time((redis_up * 1 or up{job="redis"} * 1)[1h:])
      # ... 30m, 6h
  - name: slo.study-app.alerts
    rules:
      - alert: RedisConnectivityBurnRateFast
        expr: |
          slo:redis_connectivity_error:ratio_1h > 14.4 * (1 - 0.999)
          and slo:redis_connectivity_error:ratio_5m > 14.4 * (1 - 0.999)
        for: 2m
        labels: { severity: critical, slo: redis-connectivity }
        annotations:
          summary: "Redis 연결 SLO 버짓을 빠르게 소진 중 (1h 창 번레이트 > 14.4)"
          runbook_url: "http://localhost:3000/sre/notes/03-burn-rate-alerting"
```

Alertmanager 라우팅은 `severity` 로 이미 되어 있으니([alertmanager.yml](/observability/notes/09-alerting-pipeline)) `slo` 레이블만 추가하면 그룹화·억제에 쓸 수 있다: 원인 알림(RedisDown)이 떠 있으면 증상 알림(번레이트)을 억제할지, 반대로 할지는 팀의 선택 — 워크북은 **증상이 페이지, 원인은 알림 본문에 첨부**를 권한다.

실험 `sre-burn-rate-under-chaos` 는 study-redis 를 60초 `docker pause` 해 윈도우 SLI 가 떨어지고 5m 창 번레이트가 치솟는 것, unpause 뒤 5m 창이 먼저 내려오고 1h 창은 천천히 내려오는 **리셋 시간 차이**를 Prometheus 샘플로 표로 보여 준다.

### 알림 규칙도 테스트한다

규칙은 코드이므로 `promtool test rules` 로 **합성 시계열**을 넣고 "이 시각에 이 레이블로 울려야 한다" 를 단언할 수 있다. 실험 `sre-slo-recording-rules` 가 만드는 테스트의 핵심:

```yaml
tests:
  - interval: 1m
    input_series:
      - series: 'redis_up{job="redis"}'
        values: '1x60 0x20'            # 60분 정상 → 20분 다운
    alert_rule_test:
      - eval_time: 30m                 # 정상 구간: 침묵
        alertname: RedisConnectivityBurnRateFast
        exp_alerts: []
      - eval_time: 70m                 # 다운 10분째: firing
        alertname: RedisConnectivityBurnRateFast
        exp_alerts:
          - exp_labels: { severity: critical, slo: redis-connectivity, job: redis }
```

다운이 시작되면 1h 창 에러율이 1/60 ≈ 0.0167 > 0.0144 를 넘는 61분부터 조건이 참이 되고 `for: 2m` 뒤 firing 된다 — 계산이 테스트로 증명된다. CI 에 `promtool check rules` + `test rules` 를 넣으면 알림 규칙의 오타·잘못된 임계가 배포 전에 걸린다.

## 알림 본문에 들어가야 할 것

- **무엇이 영향받나**(SLO 이름, 사용자 여정), **얼마나**(번레이트, 소진 %, 남은 버짓)
- **어디서 보나**(대시보드 링크, Loki 질의 링크 — `{service="study-app", level="error"}`)
- **무엇을 하나**(런북 링크) — [온콜·런북](/sre/notes/04-oncall-runbooks)
- 원인 후보: 같은 시간대의 원인 알림(RedisDown 등)을 Alertmanager 그룹으로 묶거나 annotation 에 PromQL 결과를 넣는다.

## 실습 체크리스트

- [ ] `소진 비율 = 번레이트 × 창 / 기간` 으로 SLO 99.5%·7일 기간에 맞는 page/ticket 번레이트를 직접 계산해 보기
- [ ] 실험 `sre-slo-recording-rules` 로 규칙을 검증하고 `observability/alert-rules.yml` 에 옮겨 `docker compose restart prometheus`
- [ ] 실험 `sre-burn-rate-under-chaos` 를 돌리고 5m 창과 1h 창의 리셋 시간 차이를 표에서 읽기
- [ ] Grafana 에 "번레이트(1h, 6h, 3d)" 패널을 만들고 임계선(14.4, 6, 1)을 그리기
- [ ] 기존 원인 알림(RedisDown)과 새 증상 알림이 동시에 울릴 때 Alertmanager 억제 규칙을 어떻게 둘지 정하기
