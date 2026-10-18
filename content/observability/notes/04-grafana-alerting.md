---
title: Grafana 대시보드와 알림 설계
order: 4
level: 중급
summary: 프로비저닝으로 코드화된 대시보드, 패널·변수·단위, 좋은 대시보드의 구조, 알림 피로를 줄이는 규칙, SLO
tags: [Grafana, 대시보드, 프로비저닝, 알림, SLO, 온콜]
experiments: []
---

## 프로비저닝 = 대시보드를 코드로

클릭으로 만든 대시보드는 사라지고 복제되지 않는다. 이 프로젝트는 파일로 정의한다.

```
observability/grafana/provisioning/datasources/prometheus.yml   데이터소스
observability/grafana/provisioning/dashboards/dashboards.yml    대시보드 폴더 경로
observability/grafana/dashboards/study-redis.json               대시보드 본문 (7 패널)
```

Grafana 는 기동 시 이를 읽는다. UI 에서 수정한 뒤 **JSON model 을 내보내 파일에 반영**하는 흐름으로 관리한다. 더 크게 가면 Grafonnet(Jsonnet)이나 Terraform provider.

```bash
pnpm obs:up
open http://localhost:13000/d/study-redis
```

## 패널 만들 때

- **단위**를 꼭 지정 (bytes, ops, percentunit, seconds). 축 숫자가 의미를 가진다.
- Counter 는 반드시 `rate()`.
- 범례 `{{label}}` 로 시리즈 이름을 의미 있게.
- 임계값(threshold) 선을 그어 "정상 범위" 를 눈에 보이게.
- Stat/Gauge 패널은 현재값 한눈에, Time series 는 추세, Table 은 상세.
- **변수**(`$instance`, `$job`) 로 하나의 대시보드를 여러 환경에 재사용.

## 좋은 대시보드의 구조

1. 맨 위: 서비스 건강 요약 (RED — 요청률, 에러율, p99). 한 화면에서 "지금 괜찮은가" 가 보여야 한다.
2. 중간: 자원 (CPU, 메모리, 커넥션, 큐 길이).
3. 아래: 상세·디버깅용.
4. 대시보드마다 목적 하나. "모든 것" 대시보드는 아무도 안 본다.
5. 링크: 관련 런북, 로그 탐색기, 트레이스.

## 알림 설계

알림 피로(alert fatigue)가 생기면 진짜 장애도 무시된다. 원칙:

- **증상 기반**: "결제 API 에러율 > 2% 5분간" ○ / "CPU > 80%" △ (원인은 대시보드로).
- **사용자 영향이 있을 때만 깨운다.** 나머지는 티켓/채널로.
- `for` 로 지속 시간 조건을 두어 스파이크를 거른다.
- 모든 알림에 **런북 링크**와 "무엇을 확인하라" 를 annotation 으로.
- 주기적으로 알림 목록을 정리: 지난 한 달 아무도 반응 안 한 알림은 지운다.

Grafana Alerting(통합) 또는 Prometheus rules + Alertmanager. 라우팅: severity 별로 채널, 야간엔 critical 만.

## SLO 와 에러 버짓

- **SLI**: 측정값. "성공한 요청 비율", "500ms 이내 응답 비율".
- **SLO**: 목표. "30일 동안 99.9%".
- **에러 버짓**: 허용 실패량 (0.1% = 30일 중 43분). 버짓이 빠르게 소진되면(burn rate) 알림. 느린 소진은 배포 속도 조절의 근거.

```promql
# 30일 가용성 SLI
1 - sum(rate(http_requests_total{status=~"5.."}[30d])) / sum(rate(http_requests_total[30d]))
# burn rate 알림 (1시간 창에서 버짓을 14.4배 속도로 태우면 → 2일 내 소진)
(sum(rate(http_requests_total{status=~"5.."}[1h])) / sum(rate(http_requests_total[1h]))) > 14.4 * 0.001
```

## 로그·트레이스 백엔드

이 프로젝트는 Loki + Alloy(로그), Tempo + OpenTelemetry(트레이스) 까지 `pnpm obs:up` 에 포함했다. 자세한 내용은 [로그 노트](/observability/notes/05-logging-loki) 와 [트레이싱 노트](/observability/notes/06-tracing-otel).

### 참고 비교

| 신호 | 경량 선택 | 특징 |
|---|---|---|
| 로그 | **Loki** (+Promtail/Alloy) | 라벨 인덱스만, 본문은 grep. 저렴. LogQL 은 PromQL 과 닮음 |
| 트레이스 | **Tempo** | 오브젝트 스토리지, 트레이스 ID 조회 중심 |
| 전체 | Grafana LGTM 스택 | Loki·Grafana·Tempo·Mimir |
| 대안 | Elastic(ELK), Jaeger, Datadog/New Relic(SaaS) | |

> 이어서 읽기: [데이터·관측 비용 — 볼륨 × 보존 × 카디널리티](/finops/notes/04-data-observability-cost) — 대시보드·시계열 수의 비용

## 실전에서는 어디에 쓰이나

> 대시보드와 알림은 관측 데이터가 사람에게 닿는 접점이다. 같은 데이터라도 패널 구성과 알림 규칙에 따라 장애 파악이 몇 분이 되기도, 한 시간이 되기도 한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 장애 대응 중인 온콜 | 30초 안에 "어디가 아픈가" 판단 | 맨 위 RED(요청률·에러율·p99), 중간 자원, 아래 상세 + 런북·로그 링크 | 모든 지표를 한 화면에 — 아무도 못 읽는다 |
| 핀테크 결제 API | 사용자가 아플 때만 사람을 깨움 | "에러율 > 2% 가 5분" 같은 증상 알림만 page, CPU 는 대시보드 | CPU 80% 알림 — 사용자 영향 없이 깨운다 |
| 여러 환경·여러 Redis 인스턴스 | 같은 대시보드 재사용 | `$instance`·`$env` 변수 | 환경마다 복사본 — 금방 어긋난다 |
| SaaS 플랫폼 팀 | 대시보드가 사라지거나 몰래 바뀌는 문제 | 프로비저닝 JSON 을 git 에 두고 PR 리뷰 | UI 에서만 편집 |
| 기능 배포 속도 논쟁 | "지금 더 배포해도 되나" | SLO·에러 버짓 소진 속도 | 감으로 결정 |

**이럴 땐 안 맞는다**
- 원인 지표(CPU·메모리)로 야간 page → 사용자 영향 없이 깨워 알림 피로가 쌓인다. 티켓이나 대시보드로 내린다.
- 한 달 동안 아무도 반응하지 않은 알림을 유지 → 진짜 알림까지 무시된다. 지우거나 조건을 고친다.

**누가 매일 만나나** — 온콜은 알림 메시지의 링크로 대시보드를 열어 첫 판단을 한다. SRE 는 알림 목록을 정리하고 SLO 를 정한다.

**면접·실무 단골 질문**
- Q. 좋은 알림의 조건은? → 사용자 영향(증상), 지속 시간 조건(`for`), 조치 가능(런북 링크). 셋 중 하나라도 없으면 page 가 아니라 티켓.

## 실습 체크리스트

- [ ] Grafana 에서 study-redis 대시보드를 열고 Redis 벤치마크를 돌려 패널 변화 보기
- [ ] 패널 하나 수정 → JSON model 복사 → `study-redis.json` 에 반영 → 재시작 후 유지 확인
- [ ] `redis_memory_used_bytes > 100MB` 알림 규칙을 만들고 상태 변화 보기
- [ ] 가용성 SLI 를 PromQL 로 써 보기

## 관련 노트

- [관측성의 세 기둥](/observability/notes/01-three-pillars)
- [Kafka 전달 보장 — LAG 모니터링](/kafka/notes/04-delivery-guarantees)
