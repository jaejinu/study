---
title: 관측성의 세 기둥 — 메트릭·로그·트레이스
order: 1
level: 기초
summary: 모니터링과 관측성의 차이, 메트릭/로그/트레이스의 역할과 비용, RED·USE·골든 시그널, 이 프로젝트의 스택
tags: [관측성, 메트릭, 로그, 트레이스, 골든시그널]
experiments: []
---

## 모니터링 vs 관측성

- **모니터링**: 미리 정한 지표를 보고 임계값을 넘으면 알린다 ("CPU 90%").
- **관측성**: 시스템이 내보내는 데이터만으로 **예상 못 한 질문**에 답할 수 있는 성질 ("왜 특정 사용자만 느린가?").

세 종류의 신호를 조합해야 질문에 답할 수 있다.

| 신호 | 무엇 | 장점 | 비용 |
|---|---|---|---|
| **메트릭** | 숫자 시계열 (요청 수, 지연 p99, 메모리) | 싸다, 집계·알림에 최적 | 고카디널리티(사용자 ID 라벨)에 취약 |
| **로그** | 이벤트 텍스트/JSON | 상세 맥락 | 양이 많고 비싸다, 검색 느림 |
| **트레이스** | 요청 하나가 거친 서비스·함수의 span 트리 | 분산 시스템의 "어디서 느린가" | 샘플링 필요, 계측 노력 |

연결 고리: 트레이스 ID 를 로그에 넣고, 메트릭 exemplar 에 트레이스 ID 를 달면 세 신호를 오갈 수 있다.

## 무엇을 재야 하나

**골든 시그널** (Google SRE): Latency, Traffic, Errors, Saturation.
**RED** (요청 처리 서비스): Rate, Errors, Duration.
**USE** (자원): Utilization, Saturation, Errors — CPU, 메모리, 디스크, 네트워크, 커넥션 풀.

"평균 지연" 은 쓸모가 적다. **p50/p95/p99** 를 본다. 1% 의 느린 요청이 사용자의 불만 대부분을 만든다.

## 카디널리티

메트릭 라벨의 고유 조합 수 = 시계열 수. `user_id`, `request_id`, 전체 URL 을 라벨로 넣으면 시계열이 폭발해 Prometheus 가 죽는다. 라벨은 **유한하고 작은 집합**(status, method, route 템플릿)만. 개별 식별자는 로그/트레이스로.

## 이 프로젝트의 스택

```
Redis ──▶ redis_exporter ──┐
                           ├──▶ Prometheus (수집·저장·PromQL·알림 규칙) ──▶ Grafana (대시보드)
Study 앱 /api/metrics ─────┘
```

```bash
pnpm obs:up               # Prometheus :19090, Grafana :13000 (익명 Admin), redis_exporter
open http://localhost:19090/targets
open http://localhost:13000/d/study-redis
pnpm obs:down
```

로그·트레이스는 이 프로젝트에 스택을 두지 않았다 (Loki/Tempo 는 노트에서 다룬다). 사용자의 다른 프로젝트(ticketing)에 LGTM 스택이 이미 떠 있다면 그 Grafana 에 이 Prometheus 를 데이터소스로 추가해 볼 수 있다.

## 설계 원칙

1. 대시보드보다 **알림**을 먼저 설계한다. 알림은 "사용자가 아픈 증상"(에러율, 지연)에, 원인(CPU)은 대시보드에.
2. 모든 서비스가 같은 라벨 규칙(`service`, `env`, `version`)을 쓴다.
3. 메트릭 이름은 `<namespace>_<subsystem>_<name>_<unit>` 예 `http_server_request_duration_seconds`.
4. 계측은 라이브러리로 자동화(OpenTelemetry), 비즈니스 지표만 수동.
