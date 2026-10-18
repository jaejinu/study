---
title: Prometheus 데이터 모델과 PromQL
order: 2
level: 기초
summary: pull 모델과 스크레이프, 네 가지 메트릭 타입, rate/histogram_quantile 같은 핵심 PromQL, 알림 규칙
tags: [Prometheus, PromQL, counter, histogram, rate, alerting]
experiments: []
---

## Pull 모델

Prometheus 가 주기적으로(`scrape_interval`) 각 타깃의 `/metrics` HTTP 엔드포인트를 **긁어 간다**. 앱은 현재 값을 노출하기만 하면 된다.
- 타깃이 죽으면 `up == 0` 으로 바로 안다.
- 짧게 사는 배치 작업은 Pushgateway 로 push.
- 서비스 디스커버리(Kubernetes, Consul, 파일)로 타깃을 자동 등록.

```yaml
# observability/prometheus.yml
scrape_configs:
  - job_name: redis
    static_configs: [{ targets: ["redis-exporter:9121"] }]
  - job_name: study-app
    metrics_path: /api/metrics
    static_configs: [{ targets: ["host.docker.internal:3000"] }]
```

## 노출 형식

```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/redis",status="200"} 1027
```

이 앱의 `/api/metrics` 를 직접 열어 보면 같은 형식이다.

## 메트릭 타입

| 타입 | 의미 | 예 | 주의 |
|---|---|---|---|
| **Counter** | 단조 증가 누적값 | 요청 수, 에러 수, 처리 바이트 | 그대로 보지 말고 `rate()` |
| **Gauge** | 오르내리는 현재값 | 메모리, 커넥션 수, 온도 | 그대로 봄 |
| **Histogram** | 값의 분포를 버킷(`le`)별 카운터로 | 요청 지연 | `histogram_quantile` 로 분위수 |
| **Summary** | 클라이언트가 계산한 분위수 | | 집계 불가, 히스토그램 권장 |

## PromQL 핵심

```promql
up                                             # 타깃 생존 (1/0)
redis_memory_used_bytes                        # 게이지 그대로
rate(redis_commands_processed_total[1m])       # 초당 증가율 (counter 는 항상 rate)
sum by (cmd) (rate(redis_commands_total[5m]))  # 라벨로 집계
topk(5, rate(redis_commands_total[5m]))
increase(http_requests_total{status=~"5.."}[1h])   # 1시간 동안 증가량

# 에러율
sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))

# p99 지연 (histogram)
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

# 비교·예측
redis_memory_used_bytes / redis_memory_max_bytes > 0.8
predict_linear(node_filesystem_avail_bytes[6h], 24*3600) < 0     # 24시간 내 디스크 소진?
```

- `rate` 의 범위 벡터 `[1m]` 는 스크레이프 간격의 **4배 이상**으로 (5초 간격이면 최소 20s, 보통 1m).
- `rate` vs `irate`: 그래프엔 rate, 순간 반응엔 irate.
- 벡터 매칭: 양쪽 라벨이 같아야 연산됨. `on()`, `ignoring()`, `group_left` 로 조정.

## 알림 규칙

```yaml
groups:
  - name: redis
    rules:
      - alert: RedisDown
        expr: up{job="redis"} == 0
        for: 1m
        labels: { severity: critical }
        annotations: { summary: "Redis exporter 응답 없음" }
      - alert: RedisMemoryHigh
        expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.9
        for: 5m
        labels: { severity: warning }
```

`for` 로 일시적 스파이크를 거르고, **Alertmanager** 가 그룹화·억제·라우팅(Slack, PagerDuty)을 맡는다. 알림은 증상 기반으로 적게.

## 보존과 확장

- 로컬 TSDB 기본 15일. 장기 보관은 **Thanos / Cortex / Mimir** (오브젝트 스토리지, 전역 질의).
- 레코딩 규칙(`record:`)으로 비싼 질의를 미리 계산해 대시보드를 가볍게.

## 실전에서는 어디에 쓰이나

> SoundCloud 에서 시작해 CNCF 졸업 프로젝트가 된 Prometheus 는 클라우드 네이티브 메트릭의 사실상 표준이다. PromQL 은 장애 중 "언제부터, 어디서, 얼마나" 를 숫자로 답하는 언어이고, 알림 규칙·대시보드·SLO 가 전부 결국 PromQL 식이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 결제 API 5xx 증가 | 언제부터 얼마나 실패하나 | 5xx `rate` ÷ 전체 `rate` 를 배포 시각과 겹쳐 보기 | 에러 로그 줄 세기 — 느리고 비싸다 |
| SaaS API "가끔 느리다" 문의 | 평균은 정상인데 꼬리가 길다 | `histogram_quantile(0.99, sum by (le, route) (rate(..._bucket[5m])))` 로 라우트별 p99 | 평균 지연 — 꼬리를 숨긴다 |
| 로그가 쌓이는 서버 디스크 | 꽉 차기 전에 미리 | `predict_linear(node_filesystem_avail_bytes[6h], 24*3600) < 0` | 고정 90% 임계 — 급증엔 늦고 완만한 증가엔 시끄럽다 |
| 캐시(Redis) 메모리 압박 | eviction 직전 감지 | 사용량 ÷ maxmemory > 0.9 + `for: 5m` | 사람이 INFO 를 주기적으로 확인 |
| 모바일 게임 이벤트 오픈 | 어떤 명령이 부하를 만드나 | `topk(5, sum by (cmd) (rate(redis_commands_total[5m])))` | APM 제품의 Top N 화면 |

**이럴 땐 안 맞는다**
- "어느 사용자가 실패했나" 를 메트릭으로 → `user_id` 라벨은 카디널리티 폭발이다. 로그·트레이스로 찾는다.
- 과금·정산처럼 정확한 건수 → `rate`·`increase` 는 외삽과 리셋 보정이 들어간 근사값이다. 원장 DB 를 기준으로 한다.

**누가 매일 만나나** — SRE 는 알림 규칙과 레코딩 룰을 쓰고, 백엔드는 배포 직후 에러율·p99 그래프로 "이번 배포 괜찮나" 를 판단한다.

**면접·실무 단골 질문**
- Q. counter 를 그대로 그리면 왜 안 되나? → 누적값이라 재시작 때 0 으로 떨어지고, 의미 있는 건 증가율이다. `rate()` 가 리셋을 보정한다.
- Q. Summary 대신 Histogram 을 권하는 이유는? → 버킷 카운터라 여러 인스턴스를 합친 뒤 분위수를 계산할 수 있다.

## 실습 체크리스트

- [ ] http://localhost:19090/targets 에서 redis, study-app 이 UP 인지 확인
- [ ] Graph 탭에서 `rate(redis_commands_processed_total[1m])` 실행 후 Redis 벤치마크를 돌려 그래프 변화 보기
- [ ] `study_progress_read_total` 을 조회해 노트를 읽음 처리하면 값이 바뀌는지 확인
- [ ] `topk(5, rate(redis_commands_total[1m]))` 로 가장 많이 호출된 명령 보기

## 관련 노트

- [계측과 exporter](/observability/notes/03-instrumentation-exporters)
- [Grafana 와 알림](/observability/notes/04-grafana-alerting)
- [Redis 운영 명령 (INFO 읽기)](/redis/notes/14-ops-commands)
