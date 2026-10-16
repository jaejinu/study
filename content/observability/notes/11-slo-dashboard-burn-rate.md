---
title: "SLO 대시보드와 번레이트 패널 — Grafana 로 '지금 괜찮은가' 를 한 화면에"
order: 11
level: 심화
summary: "SLO 를 Grafana 대시보드로 구성하는 실무. 레코딩 룰로 SLI 를 미리 계산하는 이유, 패널 배치(현재 SLI·남은 에러 버짓·버짓 소진 추이·번레이트 다중 윈도우·원인 드릴다운), 각 패널의 PromQL 과 시각화 선택, 임계값·색·단위 설정, 대시보드를 코드로 관리(프로비저닝 JSON, 변수, 링크), 흔한 실수(평균 지연 SLI, 짧은 윈도우만 보기, 너무 많은 패널), 이 앱의 RED 메트릭으로 만든 예시"
tags: [SLO, SLI, 에러 버짓, 번레이트, Grafana, 대시보드, 레코딩 룰, PromQL, 프로비저닝]
experiments: [alert-pipeline-redis-down]
---

SLO 의 개념(SLI 선택, 에러 버짓, 번레이트 알림 설계)은 [SRE 주제](/sre) 에서 다룬다. 이 노트는 그것을 **Grafana 대시보드로 만드는 법**이다 — 온콜이 알림을 받고 처음 여는 화면, 그리고 매주 리뷰에서 보는 화면.

좋은 SLO 대시보드는 세 질문에 **위에서 아래로** 답한다:

1. **지금 괜찮은가?** (현재 SLI, 남은 버짓)
2. **얼마나 빨리 나빠지고 있나?** (번레이트)
3. **왜?** (드릴다운: 어느 엔드포인트·어느 의존성)

## 1단계 — 레코딩 룰로 SLI 를 미리 계산

SLO 패널의 쿼리는 30일 윈도우 같은 **긴 범위**를 다룬다. 매번 원시 히스토그램을 30일치 계산하면 대시보드가 느리고 Prometheus 가 힘들다. **레코딩 룰**로 짧은 윈도우 비율을 미리 계산해 두고 패널은 그것을 합친다.

이 앱의 RED 메트릭 `study_action_duration_seconds{action, outcome}` 으로:

```yaml
groups:
  - name: slo-study-app
    interval: 30s
    rules:
      # 가용성 SLI: 성공 비율 (윈도우별)
      - record: sli:study_actions:availability:ratio_rate5m
        expr: |
          sum(rate(study_action_duration_seconds_count{outcome="ok"}[5m]))
          / sum(rate(study_action_duration_seconds_count[5m]))
      - record: sli:study_actions:availability:ratio_rate1h
        expr: |
          sum(rate(study_action_duration_seconds_count{outcome="ok"}[1h]))
          / sum(rate(study_action_duration_seconds_count[1h]))
      # 지연 SLI: 500ms 안에 끝난 비율 (히스토그램 버킷 경계와 맞춘다)
      - record: sli:study_actions:latency_500ms:ratio_rate5m
        expr: |
          sum(rate(study_action_duration_seconds_bucket{le="0.5"}[5m]))
          / sum(rate(study_action_duration_seconds_count[5m]))
      # 에러 비율 = 1 - 가용성 (번레이트 계산용)
      - record: slo:study_actions:error_ratio:rate5m
        expr: 1 - sli:study_actions:availability:ratio_rate5m
      - record: slo:study_actions:error_ratio:rate1h
        expr: 1 - sli:study_actions:availability:ratio_rate1h
```

지연 SLI 는 **"임계 이하 비율"** 로 정의한다. p99 같은 백분위수는 윈도우끼리 평균 낼 수 없지만(백분위수의 평균은 의미 없음), 비율은 더하고 나눌 수 있다. 임계(0.5s)는 히스토그램 **버킷 경계**와 같아야 정확하다([02 PromQL](/observability/notes/02-prometheus-promql)).

## 2단계 — 패널 배치

```
┌──────────── 행 1: 지금 상태 (Stat) ─────────────────────────────────┐
│ 가용성 30일  │ 지연 SLI 30일 │ 남은 에러 버짓 │ 버짓 소진까지 예상 │
│   99.93%     │    98.7%      │     41% ▼       │     11일          │
├──────────── 행 2: 버짓 추이 (Time series) ───────────────────────────┤
│ 남은 에러 버짓 (30일 롤링) — 100% 에서 시작해 내려가는 선 + 0% 기준선 │
├──────────── 행 3: 번레이트 (Time series, 다중 윈도우) ──────────────┤
│ 1h / 6h / 3d 번레이트 선 + 14.4 / 6 / 1 임계 수평선                 │
├──────────── 행 4: 드릴다운 (Table / Time series) ───────────────────┤
│ action 별 에러율 · p95 · 요청 수   │  의존성(Redis·PG) 상태·지연      │
└──────────────────────────────────────────────────────────────────────┘
```

위에서 아래로 **요약 → 추세 → 원인**. 한 화면(스크롤 1회 이내)에 들어와야 한다.

### 행 1 — Stat 패널

| 패널 | PromQL | 설정 |
|---|---|---|
| 가용성 30일 | `avg_over_time(sli:study_actions:availability:ratio_rate1h[30d])` | 단위 percentunit, 소수 2~3자리, 임계 99.9 미만 빨강 |
| 남은 에러 버짓 | `1 - (1 - avg_over_time(sli:study_actions:availability:ratio_rate1h[30d])) / (1 - 0.999)` | 0~100%, 임계 25% 미만 주황·0 미만 빨강 |
| 소진까지 예상 | 남은 버짓 ÷ 최근 1일 소진 속도 | 단위 일(d), 7일 미만 경고 |

`avg_over_time` 으로 1시간 비율을 평균 내면 **시간 가중**이 된다. 트래픽 가중이 필요하면 `sum(increase(...{outcome="ok"}[30d])) / sum(increase(...[30d]))` 를 쓴다 — 트래픽이 적은 시간대의 장애를 덜 무겁게 센다. 어느 쪽인지 대시보드 설명에 적어 둔다.

### 행 2 — 버짓 추이

같은 "남은 에러 버짓" 식을 Time series 로. 선이 **아래로 꺾이는 지점**이 사건이다. Grafana 어노테이션(배포·카오스 실험·알림)을 겹치면 "배포 직후 꺾임" 이 바로 보인다 — [카오스 게임데이](/chaos/notes/04-gameday-and-automation) 의 어노테이션과 같은 장치.

### 행 3 — 번레이트

번레이트 = 현재 에러 비율 ÷ 허용 에러 비율(1 − SLO). 1 이면 정확히 30일에 버짓을 다 쓰는 속도, 14.4 면 2일 만에.

```promql
slo:study_actions:error_ratio:rate1h / (1 - 0.999)      # 1h 번레이트
slo:study_actions:error_ratio:rate6h / (1 - 0.999)      # 6h (레코딩 룰 추가)
slo:study_actions:error_ratio:rate3d / (1 - 0.999)      # 3d
```

설정: 세 선을 한 패널에, **Thresholds → 선(line) 스타일**로 14.4·6·1 수평선, Y축 로그 스케일(번레이트는 0.1~100 범위). 알림 규칙([SRE](/sre))과 **같은 식·같은 임계**를 써야 "알림은 왔는데 그래프는 정상" 같은 혼란이 없다.

### 행 4 — 드릴다운

- **Table**: `action` 별 에러율·p95·요청 수, 에러율 내림차순. 셀 색상(배경)으로 임계 초과 강조.
- **의존성 패널**: `redis_up`, Redis 명령 지연, PG 커넥션 — SLI 가 떨어질 때 원인 후보를 바로 옆에. 기존 `study-redis` 대시보드의 패널을 **라이브러리 패널**로 재사용한다.
- 패널 링크: action 행을 클릭하면 Tempo 에서 해당 action 의 느린 트레이스 검색, Loki 에서 에러 로그로 — 데이터 링크(`${__data.fields.action}`)를 설정한다.

## 시각화 선택의 원칙

| 데이터 | 적합 | 피할 것 |
|---|---|---|
| 현재 값 하나(SLI, 버짓) | Stat (큰 숫자 + 스파크라인) | 게이지 남용 — 99.9% 와 99.5% 가 게이지에선 똑같아 보인다 |
| 시간 추세 | Time series | 막대(시계열 막대는 읽기 어렵다) |
| 여러 대상 비교 | Table (정렬 가능) | 선 20개 겹친 그래프 |
| 상태(정상/경고/장애) | State timeline | 숫자만 |

- **단위**를 반드시 지정(percentunit, s, ops). 0.999 와 99.9% 를 헷갈리면 장애 판단이 틀린다.
- **색은 의미에만**: 초록·주황·빨강은 임계와 연결. 장식용 색을 쓰지 않는다.
- SLI 패널의 Y축을 0~100% 로 두면 99.9% 와 99% 차이가 안 보인다 → **min 을 SLO 근처**(예: 99%)로.

## 대시보드를 코드로

이 프로젝트의 `study-redis` 대시보드는 `observability/grafana/dashboards/*.json` 을 프로비저닝으로 로드한다. SLO 대시보드도 같은 방식으로:

- **변수**: `$service`, `$slo`(0.999), `$window`(30d) — 같은 대시보드를 여러 서비스에 재사용.
- **버전 관리**: JSON 을 git 에. UI 에서 고친 뒤 "Save JSON to file" → PR. 프로비저닝 대시보드는 UI 저장이 막혀 있어 드리프트가 생기지 않는다(`allowUiUpdates: false`).
- **생성 도구**: Grafonnet(Jsonnet), grafana-foundation-sdk(TS/Go), 또는 Sloth·Pyrra 같은 SLO 도구가 레코딩 룰·알림·대시보드를 **SLO 정의 하나에서** 생성한다.

```yaml
# Sloth SLO 정의 → 레코딩 룰 + 다중 윈도우 번레이트 알림 + 대시보드 자동 생성
version: prometheus/v1
service: study-app
slos:
  - name: actions-availability
    objective: 99.9
    sli:
      events:
        error_query: sum(rate(study_action_duration_seconds_count{outcome!="ok"}[{{.window}}]))
        total_query: sum(rate(study_action_duration_seconds_count[{{.window}}]))
    alerting: { name: StudyActionsAvailability, page_alert: { labels: { severity: critical } } }
```

## 흔한 실수

| 실수 | 왜 나쁜가 | 고침 |
|---|---|---|
| 평균 지연을 SLI 로 | 꼬리를 숨김 | "임계 이하 비율" |
| 5분 윈도우만 표시 | 버짓 상황을 모름 | 30일 롤링 + 다중 번레이트 |
| SLO 대시보드에 패널 40개 | 온콜이 길을 잃음 | 요약 4개 + 추세 + 드릴다운, 나머지는 링크 |
| 알림 식과 패널 식이 다름 | "그래프는 정상인데 알림이" | 같은 레코딩 룰을 공유 |
| 트래픽 0 일 때 0/0 = NaN | 패널이 비거나 100% 로 오해 | `or vector(1)` 로 기본값, 또는 "데이터 없음" 표시 |
| Y축 0~100% | 99.9 vs 99.0 이 같아 보임 | min 을 SLO 근처로 |

## 예시로 보기 — 이 앱에 적용

1. 위 레코딩 룰을 `observability/alert-rules.yml` 옆 `slo-rules.yml` 로 추가하고 `prometheus.yml` 의 `rule_files` 에 등록.
2. 앱에 트래픽을 만든다(노트 열람·실험 실행, 또는 [k6](/performance/notes/03-k6-load-testing)).
3. 위 배치대로 대시보드 JSON 을 만들고 `study-redis` 의 Redis 패널을 라이브러리 패널로 행 4 에 재사용.
4. `alert-pipeline-redis-down` 실험으로 Redis 를 멈추면 → 액션 에러율 상승 → 1h 번레이트가 14.4 선을 넘는 모습 + 같은 시각 RedisDown 알림 어노테이션.

## 실습 체크리스트

- [ ] 가용성·지연 SLI 레코딩 룰을 추가하고 Prometheus 의 Rules 화면에서 값이 계산되는지 확인
- [ ] Stat 패널 4개(가용성·지연 SLI·남은 버짓·소진 예상)를 만들고 단위·소수점·임계 색을 설정
- [ ] 번레이트 3개 윈도우를 로그 스케일 한 패널에 그리고 14.4·6·1 임계선을 추가
- [ ] Redis 를 잠깐 멈춰(카오스 실험) 버짓 추이 선이 꺾이는 것을 어노테이션과 함께 확인
- [ ] 같은 SLO 를 Sloth 정의로 쓰고 생성된 규칙을 손으로 쓴 것과 비교

## 실전 — 이 사이트에 실제로 건 SLO

위 "예시로 보기" 를 실제로 구현해 두었다. 파일은 세 개다.

| 파일 | 내용 |
| --- | --- |
| `observability/slo-rules.yml` | SLO 3개의 레코딩 룰(창 8개씩)·남은 예산·번레이트·알림 6개 |
| `observability/tests/slo-rules.test.yml` | promtool 단위 테스트 5개 — "나야 할 때만 나는가" |
| `observability/grafana/dashboards/study-slo.json` | Grafana "Study 사이트 SLO" 대시보드 |

### SLI 를 어디서 얻나 — 요청 메트릭이 없던 문제

처음엔 이 앱에 **요청 단위 메트릭이 없었다**. 서버 액션 시간(`study_action_duration_seconds`)만 있었고, 페이지가 5xx 를 냈는지는 알 길이 없었다. App Router 에는 "모든 응답" 을 가로채는 훅이 없다. `proxy.ts` 는 요청 앞에서 돌기 때문에 응답 코드를 모른다.

해법은 **트레이스를 메트릭으로 바꾸는 것**이다. Next.js 는 모든 요청을 `BaseServer.handleRequest` 루트 스팬으로 감싼다. 끝날 때 `http.status_code`·`next.route`(라우트 패턴)·`next.rsc` 를 붙인다. `src/lib/request-metrics.ts` 의 스팬 프로세서가 이 스팬이 끝날 때 히스토그램에 기록한다.

```ts
// instrumentation.ts — "auto" 는 기존 내보내기, 뒤의 것이 RED 메트릭 기록기
registerOTel({ spanProcessors: ["auto", new RequestMetricsProcessor()], ... });
```

```text
study_http_request_duration_seconds_bucket{route="/[subject]/notes/[slug]", method="GET", kind="page", code="200", le="1"}
```

- **route 는 URL 이 아니라 패턴**이다. 그래서 노트가 수백 편이어도 라벨 값은 수십 개로 묶인다(카디널리티 폭발 방지).
- **kind** 로 요청을 나눈다. page 는 문서 요청, rsc 는 클라이언트 화면 전환, action 은 서버 액션 POST, api 는 `/api/*` 다.
- `/api/metrics` 자체와 `/_next` 정적 자원은 뺀다. 그러지 않으면 5초마다 오는 스크레이프가 "성공한 요청" 으로 SLI 를 부풀린다.

트레이스 익스포터가 없어도(Tempo 가 꺼져 있어도) 스팬 프로세서는 돌기 때문에 메트릭은 항상 나온다.

### SLO 3개

| SLO | SLI (좋은 이벤트 / 전체) | 목표 | 30일 예산 |
| --- | --- | --- | --- |
| 가용성 | 5xx 가 아닌 응답 | 99.5% | 0.5% |
| 페이지 지연 | 1초 안에 끝난 page·rsc 요청 | 95% | 5% |
| 서버 액션 | 예외 없이 끝난 액션 | 99% | 1% |

지연 SLI 에서 API 를 뺀 이유가 있다. `/api/ask` 같은 LLM 스트리밍은 원래 수 초가 걸린다. 이것을 섞으면 "페이지가 느리다" 는 신호가 묻힌다. 성격이 다른 요청은 다른 SLO 로 다룬다.

### 직접 부딪힌 함정 두 가지

**① 5xx 가 한 번도 없으면 SLI 가 사라진다.** `sum(rate(x{code=~"5.."}[5m]))` 는 5xx 시계열이 아예 없으면 0 이 아니라 **빈 결과**다. 빈 것을 나누면 결과도 비어서, 대시보드에 "No data" 가 뜨고 알림 식도 평가되지 않는다. 분자에 `or vector(0)` 을 붙여 해결했다.

```promql
(sum(rate(study_http_request_duration_seconds_count{code=~"5.."}[5m])) or vector(0))
  /
sum(rate(study_http_request_duration_seconds_count[5m]))
```

분모는 그대로 둔다. 트래픽이 아예 없을 때 결과가 비어야 "조용한 밤에 깨우지 않는다".

**② Prometheus 3 은 `le` 라벨을 정규화한다.** 앱은 `le="1"` 로 내보내지만 Prometheus 3.x 는 저장할 때 `le="1.0"` 으로 바꾼다. 그래서 `le="1"` 로 고르면 아무것도 안 잡힌다. promtool 단위 테스트는 입력을 그대로 써서 통과하므로 더 헷갈린다. 두 경우를 모두 잡도록 정규식을 썼다.

```promql
study_http_request_duration_seconds_bucket{kind=~"page|rsc", le=~"1(\\.0)?"}
```

### 알림 — 멀티 윈도우 · 멀티 번레이트

| 계층 | 번레이트 | 긴 창 & 짧은 창 | 뜻 |
| --- | --- | --- | --- |
| page (critical) | 14.4 | 1h & 5m | 30일 예산의 2% 를 1시간에 태움 |
| page (critical) | 6 | 6h & 30m | 예산의 5% 를 6시간에 |
| ticket (warning) | 3 | 1d & 2h | 예산의 10% 를 하루에 |
| ticket (warning) | 1 | 3d & 6h | 이대로면 30일 끝에 예산이 정확히 바닥 |

임계값은 `14.4 * (1 - 0.995)` 처럼 **상수**로 쓴다. 레코딩 룰과 `on() group_left()` 로 곱하려 하면 스칼라와 벡터 사이의 매칭이라 문법 오류가 난다. 30일 창을 계산하려면 보존 기간도 30일보다 길어야 해서, compose 의 Prometheus 에 `--storage.tsdb.retention.time=35d` 를 줬다.

### 규칙도 테스트한다 — promtool

알림 규칙은 "평소엔 조용하고, 정말 나쁠 때만 울리는지" 를 **코드처럼 테스트**할 수 있다. `pnpm obs:check` 가 문법 검사와 단위 테스트 5개를 돌리고, CI 의 observability 잡도 같은 것을 돌린다.

1. 요청의 10% 가 500 이면 → 70분 시점에 가용성 page 알림이 발화한다.
2. 오류 0.2% 는 예산(0.5%) 안쪽이므로 → 3시간이 지나도 어떤 알림도 없다.
3. 트래픽이 0 이면 → 알림이 없다.
4. 페이지 20% 가 1초를 넘으면 → 3x(15%) 는 넘고 6x(30%) 는 안 넘으므로 ticket 만 발화한다.
5. 서버 액션이 10분 동안만 폭주하면 → 5m 창은 14.4x 를 넘지만 1h 창이 못 넘어 page 가 나지 않는다. **짧은 창과 긴 창을 같이 보는 이유**가 이것이다.

```yaml
# 시계열 표기: '0+9x120' = 0 에서 1분마다 9 씩 120번 증가
- series: 'study_http_request_duration_seconds_count{code="500", ...}'
  values: '0+1x120'
```

### 대시보드에서 배운 것

- **값이 없을 때를 디자인한다.** 서버 액션을 한 번도 안 부르면 SLI 는 0/0 이다. 기본 설정에선 "요청 없음" 이 빨간 배경으로 떠서 장애처럼 보였다. `(식) or on() vector(NaN)` 으로 빈 결과를 NaN 으로 채우고, NaN 을 회색 "—" 로 매핑했다.
- `or vector(NaN)` 만 쓰면 **값이 있을 때도** NaN 이 따라붙는다. 라벨이 달라 둘 다 살아남기 때문이다. `or on()` 으로 "왼쪽이 비었을 때만" 이 되게 해야 한다.
- 번레이트 패널의 점선(14.4·6·3·1)은 알림 임계값과 같은 숫자다. 알림이 왜 울렸는지 그래프에서 바로 읽힌다.

### 따라 해 보기

```bash
pnpm obs:check                       # 규칙 문법 + 단위 테스트
pnpm obs:up                          # Prometheus·Grafana (규칙·대시보드 자동 로드)
# Grafana → Study 폴더 → "Study 사이트 SLO"
```

- [ ] `/api/metrics` 에서 `study_http_request_duration_seconds` 의 route 라벨이 패턴으로 묶이는지 확인
- [ ] promtool 테스트 4번의 비율을 바꿔 page 알림이 나도록 만들어 보고, 테스트가 실패하는 것을 확인
- [ ] 존재하지 않는 노트를 여러 번 열어 404 가 가용성 SLI 에 들어가지 않는 것(5xx 만 나쁜 이벤트)을 확인
