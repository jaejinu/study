---
title: "데이터·관측 비용 — 볼륨 × 보존 × 카디널리티"
order: 4
level: 중급
summary: "관측 데이터가 왜 인프라 비용의 10~30% 까지 커지는지, 메트릭(활성 시계열·카디널리티)·로그(수집 GB·보존)·트레이스(스팬 수·샘플링) 각각의 과금 모델과 비용을 키우는 습관, 히스토그램 버킷·고카디널리티 레이블·디버그 로그·전수 트레이스를 줄이는 구체적 기법(relabel drop, 레코딩 룰 후 원본 삭제, 로그 레벨·샘플링, tail sampling, 보존 계층), 이 프로젝트 Prometheus·Loki 실측(시계열 5천, 버킷이 36%)"
tags: [관측 비용, 카디널리티, 활성 시계열, 로그 볼륨, 보존, 샘플링, tail sampling, relabel, Loki, Prometheus]
experiments: [finops-observability-volume]
---

## 관측은 공짜가 아니다

관측 데이터는 **보지 않아도 쌓인다**. 트래픽이 늘면 로그와 트레이스가 선형으로 늘고, 새 레이블 하나가 메트릭을 수십 배로 늘린다. 많은 조직에서 관측 비용이 컴퓨트 비용의 10~30% 에 이르는 이유다.

관측 비용의 공식은 단순하다.

```
비용 = 볼륨 × 단가 × 보존 기간
       └─ 메트릭: 활성 시계열 수 (카디널리티)
       └─ 로그:   수집 바이트 (트래픽 × 줄 수 × 줄 크기)
       └─ 트레이스: 스팬 수 (트래픽 × 서비스 깊이 × 샘플링 비율)
```

세 신호의 기본 개념은 [관측성 — 세 기둥](/observability/notes/01-three-pillars)에서 다뤘다. 이 노트는 각각의 **볼륨이 어디서 생기고 어떻게 줄이는지**에 집중한다.

## 메트릭 — 트래픽이 아니라 카디널리티가 비용이다

Prometheus·관리형 메트릭 서비스는 **활성 시계열(active series)** 수로 비용과 메모리가 정해진다. 시계열 하나 = 메트릭 이름 + 레이블 값 조합 하나.

```
http_requests_total{method, route, status}
  method 5 × route 40 × status 8 = 1,600 시계열
  + instance 10개 → 16,000
  + user_id (10만) 를 레이블로 넣으면 → 16억  💥
```

**요청이 1번 오든 100만 번 오든 시계열 수는 같다.** 그래서 메트릭은 트래픽에 강하고 카디널리티에 약하다. 반대로 로그는 트래픽에 비례한다 — 이 비대칭이 "셀 수 있는 건 메트릭으로" 원칙의 근거다.

### 카디널리티를 키우는 주범

| 주범 | 예 | 대처 |
|---|---|---|
| **히스토그램 버킷** | 버킷 15개 × 레이블 조합 | 버킷 수 줄이기, 네이티브 히스토그램, 필요한 레이블만 |
| 무한 값 레이블 | user_id, email, 요청 URL 원문, 에러 메시지 | 레이블 금지 — 로그·트레이스로 |
| 짧게 사는 대상 | Pod 이름(배포마다 바뀜), 컨테이너 ID | 집계 후 Pod 레이블 제거, 레코딩 룰 |
| 쓰지 않는 메트릭 | exporter 기본 메트릭 수백 개 | relabel 로 수집 단계에서 drop |
| 중복 수집 | 같은 대상을 두 Prometheus 가 | 수집 책임 정리 |

### 찾는 법

```promql
# 시계열을 가장 많이 만드는 메트릭 상위 10
topk(10, count by (__name__) ({__name__=~".+"}))

# 특정 메트릭에서 레이블별 고유 값 수
count(count by (route) (http_requests_total))
```

더 빠른 방법은 TSDB 상태 API 다 — 실험 `finops-observability-volume` 이 이걸 쓴다.

```bash
curl -s localhost:19090/api/v1/status/tsdb | jq '.data.seriesCountByMetricName[:10], .data.labelValueCountByLabelName[:10]'
```

### 줄이는 법

```yaml
# prometheus.yml — 수집 단계에서 버리기 (가장 싸다: 저장도, 전송도 안 함)
scrape_configs:
  - job_name: redis
    metric_relabel_configs:
      - source_labels: [__name__]
        regex: "redis_commands_latencies_usec_bucket"   # 정밀 지연이 필요 없으면
        action: drop
      - regex: "pod_template_hash|controller_revision_hash"
        action: labeldrop
```

레코딩 룰로 필요한 집계만 남기고 원본은 짧게 보존하는 방식도 있다. 예: `job:http_requests:rate5m` 만 장기 보관(Thanos/Mimir 다운샘플링), 원본 버킷은 2일.

## 로그 — 트래픽에 비례하는 비용

로그 비용 = **수집 GB**(인덱싱·처리) + **보존 GB-월**(저장). Loki 는 내용을 인덱싱하지 않고 라벨만 인덱싱해 수집 단가가 싸지만, 볼륨이 곧 비용인 것은 같다([로그 — Loki](/observability/notes/05-logging-loki)).

볼륨 = 요청 수 × 요청당 로그 줄 수 × 줄 크기.

| 습관 | 효과 |
|---|---|
| 프로덕션 기본 레벨 info, debug 는 동적으로만 | 줄 수 1/10 |
| 성공 요청 로그 샘플링 (예: 1%), 에러는 100% | 볼륨 1/50, 문제 조사력 유지 |
| 요청 본문·헤더 전문 로깅 금지 | 줄 크기 1/5 + PII 위험 제거([보안](/security/notes/08-web-api-llm-security)) |
| 헬스체크·메트릭 스크레이프 접근 로그 제외 | 의외로 큰 비중 |
| JSON 키를 짧게, 중복 필드 제거 | 줄 크기 20~40% |
| 보존 계층: 7일 핫 → 30일 오브젝트 스토리지 → 삭제 | 보존 비용 1/5 |

> **주의:** Loki 에서 라벨을 늘리면 스트림이 쪼개져 청크가 작아지고 효율이 떨어진다. 라벨은 적게(서비스·환경·레벨), 나머지는 로그 본문의 JSON 필드로 — 비용과 성능 둘 다의 원칙이다.

## 트레이스 — 샘플링이 곧 비용 정책

트레이스 볼륨 = 요청 수 × 요청당 스팬 수(서비스·DB 호출 깊이). 전수 수집은 대부분 낭비다 — 정상 요청 수백만 개의 트레이스는 거의 보지 않는다.

| 샘플링 | 결정 시점 | 장점 | 단점 |
|---|---|---|---|
| **head 샘플링** | 요청 시작 시 확률(예: 5%) | 싸고 단순, SDK 에서 | 느린·에러 요청을 놓칠 수 있다 |
| **tail 샘플링** | 트레이스가 끝난 뒤 collector 에서 | 에러·느린 요청 100%, 정상 1% | collector 가 버퍼링해야 해 무겁다 |
| 속도 제한 | 초당 N 개 | 비용 상한이 확실 | 트래픽 급증 때 대표성 하락 |

```yaml
# OpenTelemetry Collector — tail sampling 정책 예
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      - { name: errors,  type: status_code, status_code: { status_codes: [ERROR] } }
      - { name: slow,    type: latency,     latency: { threshold_ms: 500 } }
      - { name: sample,  type: probabilistic, probabilistic: { sampling_percentage: 2 } }
```

또 하나: 트레이스에서 **스팬 메트릭**(Tempo metrics-generator)을 만들면 RED 메트릭을 얻는 대신 시계열이 늘어난다. 이 프로젝트에서 시계열 1위가 `traces_spanmetrics_latency_bucket` 인 이유다. 트레이드오프를 알고 켜자.

## 계산 연습: 레이블 하나의 값

새 메트릭을 추가하기 전에 시계열 수를 계산하는 습관이 가장 싼 비용 통제다.

```
http_server_duration_seconds_bucket{service, route, method, status, le}
  service 20 × route 30 × method 3 × status 6 × le 12 = 129,600 시계열
  + Pod 레이블 (서비스당 평균 8 Pod, 배포마다 이름이 바뀜)
    → 활성 103만, 하루 배포 3번이면 "죽은 시계열" 까지 하루 수백만
```

| 바꾸기 | 시계열 | 가정 단가($8/1천) 월 |
|---|---|---|
| 그대로 + Pod 레이블 | 약 1,036,800 | 약 $8,300 |
| Pod 레이블 제거 (서비스 단위 집계) | 129,600 | 약 $1,040 |
| + 버킷 12 → 6 | 64,800 | 약 $520 |
| + status 를 2xx/4xx/5xx 3종으로 | 32,400 | 약 $260 |

같은 질문(서비스·경로별 지연 분포)에 답하면서 **30배** 차이다. 이 계산을 PR 리뷰 체크리스트에 넣는 것이 [거버넌스](/finops/notes/06-governance)의 "만드는 경로에서 막기" 다.

## 보존 기간은 누가 정했나

보존은 대개 "기본값" 이다. 근거를 묻자.

| 데이터 | 보존 근거 | 흔한 정답 |
|---|---|---|
| 원본 메트릭 | 사고 조사, 대시보드 | 15~30일 |
| 다운샘플 메트릭 | 용량 계획, 연간 추세 | 1~2년 (5분·1시간 해상도) |
| 애플리케이션 로그 | 디버깅 | 7~14일 핫 |
| 감사 로그 | 규정 | 1~7년, 콜드 스토리지 |
| 트레이스 | 최근 문제 조사 | 3~14일 |

## 예시로 보기 — 이 프로젝트에서

실험 `finops-observability-volume` 를 이 Mac 의 관측 스택에서 돌린 결과:

| 항목 | 값 |
|---|---|
| 활성 시계열 | 약 5,000 |
| 수집 샘플/초 | 약 790 (하루 6,800만 샘플) |
| 시계열 1위 | `traces_spanmetrics_latency_bucket` 1,140 (23%) |
| 시계열 2위 | `redis_commands_latencies_usec_bucket` 673 (13%) |
| 히스토그램 버킷 비중 | 상위 10개 중 버킷 2개가 전체의 **36%** |
| 레이블 고유 값 상위 | `cmd` 133, `le` 113, `span_name` 74, `handler` 56 |
| Loki 수집 | 12 MiB / 7만 줄 (약 7시간) |

해석:

- 시계열의 1/3 이 히스토그램 버킷이다. `redis_commands_latencies_usec_bucket` 는 Redis 명령 종류(cmd 133개) × 버킷이라 크다. 정말 모든 명령의 지연 분포가 필요한지가 질문이다 — 자주 쓰는 10개 명령만 남기면 이 메트릭은 1/10 이 된다.
- 가정 단가(시계열 1천 개당 $8/월)로 메트릭은 월 약 $40, 로그는 수집 1달러 미만이다. 트래픽을 100배로 늘리면 메트릭은 거의 그대로($44)인데 로그는 수집·보존 합쳐 약 $80 이 된다. 로컬에선 메트릭이 비싸 보이지만 **규모가 커지면 로그가 역전**한다.
- 실험의 "히스토그램 버킷 절반" 시나리오는 메트릭 비용을 약 18% 줄인다. relabel 한 줄로 얻는 절감이다.

> **팁:** 카디널리티 문제는 "어떤 대시보드·알림이 이 시계열을 쓰는가" 를 먼저 확인하자. 아무도 쓰지 않는 메트릭이 대부분이다. Grafana 의 메트릭 사용량 분석(또는 `mimirtool analyze`)이 그 목록을 준다.

## 실습 체크리스트

- [ ] 실험 `finops-observability-volume` 를 돌려 상위 10 메트릭 중 실제로 대시보드·알림에서 쓰는 것을 표시해 보기
- [ ] `observability/prometheus.yml` 의 redis 잡에 버킷 drop 규칙을 넣으면 시계열이 몇 개 줄지 `count(...)` 로 미리 계산하기
- [ ] 앱 로그(`logs/app.jsonl`) 한 줄의 평균 크기를 보고 줄일 수 있는 필드 찾기
- [ ] Tempo metrics-generator 를 끄면(스팬 메트릭 제거) 무엇을 잃고 무엇을 아끼는지 정리하기
- [ ] 우리 서비스의 메트릭·로그·트레이스 보존 기간을 근거와 함께 표로 정하기
