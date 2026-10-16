---
title: "데이터 품질·계보·계약 — 틀린 숫자가 대시보드에 닿기 전에"
order: 6
level: 심화
summary: "데이터 품질의 차원(완전성·유일성·유효성·정합성·신선도·분포), 테스트를 어디에 두나(원천·변환 후·발행 전), 심각도와 격리(error 는 멈추고 warn 은 알리고, 불량 행은 격리 테이블로), 데이터 계약(생산자와 소비자의 스키마·의미·SLA 약속)과 CI 에서의 계약 검사, 계보(어느 원천이 어느 대시보드로)와 OpenLineage, 데이터 관측(볼륨·분포 이상 탐지), 실험 실측(심은 불량 6종을 정확히 잡음), 이 사이트에 적용하기"
tags: [데이터 품질, 데이터 계약, 계보, OpenLineage, 신선도, 격리, 데이터 관측, dbt 테스트, 스키마]
experiments: [de-quality-checks]
---

## 품질 문제는 조용히 온다

파이프라인이 실패하면 알림이 온다. 진짜 무서운 것은 **성공했는데 숫자가 틀린** 경우다.

- 원천 앱이 `status` 값을 `'PAID'` 로 바꿨다 → `status = 'paid'` 집계가 하룻밤 사이 0
- 조인 키에 중복이 생겼다 → 매출이 두 배
- 원천 작업이 멈춰 어제 데이터가 안 들어왔다 → 대시보드는 그대로, 아무도 모름
- 새 열이 추가되며 타입이 바뀌었다 → 하류 변환이 조용히 NULL 을 만든다

## 품질의 차원

| 차원 | 질문 | 검사 예 |
|---|---|---|
| 완전성 | 있어야 할 값이 있나 | not_null, 행 수가 예상 범위 안 |
| 유일성 | 중복이 없나 | unique(order_id) |
| 유효성 | 허용된 값·형식인가 | accepted_values, 정규식, 범위(amount ≥ 0) |
| 정합성 | 테이블 사이가 맞나 | relationships(외래 키), 합계 대사 |
| 신선도 | 최신인가 | max(created_at) 가 N시간 이내 |
| 분포 | 평소와 비슷한가 | 행 수·평균·NULL 비율이 어제 대비 ±X% |
| 스키마 | 약속한 모양인가 | 열 목록·타입이 계약과 같나 |

## 실측 — 테스트가 정확히 잡는지

실험 [de-quality-checks](/data-engineering/lab/de-quality-checks) 는 깨끗한 데이터에 불량을 일부러 심고 dbt 식 테스트를 DuckDB SQL 로 돌린다.

| 테스트 | 심은 불량 | 잡은 행 | 예 |
|---|---|---|---|
| not_null(email) | 5 | 5 | id 17, 230, 451 … |
| unique(id) | 3 | 3 | 100, 200, 300 |
| accepted_values(status) | 4 | 4 | `shiped`(오타), `PAID`(대소문자) |
| relationships(customer_id) | 6 | 6 | 5501, 5502 … (없는 고객) |
| range(amount ≥ 0) | 2 | 2 | -131.14, -119.88 |
| contract(columns) | 1 | 1 | `discount` (계약에 없는 새 열) |
| freshness | 최신 37시간 전 | warn | 24h 초과 warn, 48h 초과 error |

각 테스트는 "위반 행을 돌려주는 SELECT" 이고, 몇 ms 면 끝난다. 이 단순함이 품질 검사의 핵심이다 — 비싸지 않으니 모든 단계에 넣을 수 있다.

## 어디에 두나

```
원천 ──[소스 테스트]──▶ staging ──[모델 테스트]──▶ marts ──[발행 전 게이트]──▶ 대시보드·소비자
        신선도·스키마          유일성·관계·유효성          분포·대사·계약
```

- **원천 바로 뒤**: 원천이 약속을 어겼는지(스키마, 신선도). 여기서 잡으면 하류를 아예 안 돌린다.
- **변환 후**: 내 변환 로직이 틀렸는지(조인 중복, 관계).
- **발행 전(write-audit-publish)**: 결과를 임시 위치에 쓰고 → 검사하고 → 통과하면 그때 공개 테이블로 교체. Iceberg 의 브랜치·스냅샷이나 ClickHouse 의 `EXCHANGE TABLES` 로 원자적 교체가 가능하다.

## 심각도와 격리

모든 실패에 파이프라인을 멈추면 사소한 문제로 대시보드가 하루 종일 비고, 아무것도 안 멈추면 틀린 숫자가 나간다.

| 심각도 | 동작 | 예 |
|---|---|---|
| **error** | 파이프라인 정지, 발행 안 함, 알림 | 기본 키 중복, 관계 위반, 스키마 깨짐 |
| **warn** | 진행, 알림 | 신선도 지연, 소수의 이상값, 분포 소폭 변화 |
| **격리(quarantine)** | 불량 행만 빼서 별도 테이블로, 정상 행은 진행 | 일부 행의 형식 오류 |

```sql
-- 격리: 불량 행을 따로 저장하고 정상만 하류로
CREATE TABLE orders_quarantine AS
SELECT *, 'invalid_status' AS reason FROM orders WHERE status NOT IN ('placed','paid','shipped','cancelled')
UNION ALL SELECT *, 'negative_amount' FROM orders WHERE amount < 0;

CREATE VIEW orders_clean AS
SELECT * FROM orders WHERE id NOT IN (SELECT id FROM orders_quarantine);
```

실험에서는 격리 대상이 12행이었다. dbt 는 `--store-failures` 로 실패 행을 테이블에 자동 저장한다 — 원인 조사가 훨씬 빨라진다. 이 구조는 [서킷 브레이커](/chaos/notes/03-resilience-patterns-verified) 와 닮았다: 나쁜 입력이 하류 전체를 오염시키기 전에 끊는다.

## 데이터 계약

품질 문제의 상당수는 **생산자(원천 앱 팀)가 소비자(데이터 팀)를 모른 채 스키마를 바꿔서** 생긴다. 데이터 계약은 그 관계를 명시한다.

```yaml
# contracts/orders.yaml
dataset: app.orders
owner: checkout-team
consumers: [data-platform, finance-dashboard]
schema:
  - { name: id,          type: int,       required: true, unique: true }
  - { name: customer_id, type: int,       required: true, references: app.customers.id }
  - { name: status,      type: string,    enum: [placed, paid, shipped, cancelled] }
  - { name: amount,      type: decimal(12,2), min: 0 }
  - { name: created_at,  type: timestamp, required: true }
sla:
  freshness: 1h
  availability: 99.9%
change_policy: 열 추가는 하위 호환, 삭제·타입 변경·enum 축소는 2주 전 공지 + 소비자 승인
```

- **생산자 CI 에서 검사한다.** 앱의 스키마 마이그레이션 PR 이 계약을 깨면 빌드가 실패한다. [API 버전 관리](/api-design/notes/07-versioning-evolution-governance) 의 "깨지는 변경 검사" 를 데이터에 적용한 것이다.
- **계약은 의미도 담는다.** `amount` 가 세전인지 세후인지, `created_at` 이 UTC 인지. 타입 검사로는 못 잡는 오류가 여기 있다.
- **이벤트 스트림**이라면 [Schema Registry](/kafka/notes/06-streams-connect-schema) 의 호환성 모드가 계약의 기계적 부분을 강제한다.

실험의 `contract(columns)` 테스트는 계약에 없는 열 `discount` 가 나타난 것을 잡았다. 열 추가는 대개 하위 호환이지만, "모르는 열이 생겼다" 는 신호 자체가 중요하다 — 누군가 의미 있는 변경을 하고 있다.

## 계보 (Lineage)

"이 대시보드 숫자는 어디서 왔나?", "이 원천 열을 지우면 무엇이 깨지나?"

```
app.orders.amount ─▶ stg_orders.amount ─▶ fct_daily_sales.revenue ─▶ 매출 대시보드
                                       └▶ fct_customer_ltv.ltv ─▶ 마케팅 세그먼트
```

- dbt 는 `ref` 로 모델 수준 계보를 자동으로 그린다.
- **OpenLineage** 는 작업 실행 이벤트(입력 데이터셋·출력 데이터셋·열 매핑)를 표준 형식으로 내보내는 규격이다. Airflow·Spark·Flink·dbt 통합이 있고 Marquez·DataHub 같은 카탈로그가 받아서 그래프를 그린다.
- 계보는 **장애 영향 분석**(원천 장애 → 영향받는 대시보드 목록)과 **변경 영향 분석**(열 삭제 전 소비자 찾기)에 쓴다. 관측성의 [분산 트레이싱](/observability/notes/06-tracing-otel) 이 요청의 경로를 보여 준다면, 계보는 데이터의 경로를 보여 준다.

## 데이터 관측 — 규칙으로 못 잡는 것

규칙 기반 테스트는 **알고 있는** 실패만 잡는다. 모르는 실패는 **평소와 다름**으로 잡는다.

| 지표 | 이상 신호 |
|---|---|
| 볼륨 | 오늘 행 수가 같은 요일 평균 대비 −40% |
| 신선도 | 마지막 갱신이 평소 주기의 2배 이상 늦음 |
| 분포 | 특정 열의 NULL 비율·평균·고유값 수 급변 |
| 스키마 | 열 추가·삭제·타입 변경 |

이건 [SLO](/sre/notes/02-sli-slo-error-budget) 와 [이상 탐지](/finops/notes/06-governance) 를 데이터에 적용한 것이다. 이 지표들을 Prometheus 메트릭으로 내보내면 기존 알림 파이프라인에 그대로 붙는다.

## 예시로 보기 — 이 프로젝트에서

이 사이트 자체에도 "데이터 품질" 문제가 있다. 노트·퀴즈·용어집이 데이터이기 때문이다.

| 품질 차원 | 이 사이트에서의 예 | 검사 |
|---|---|---|
| 스키마(계약) | 노트 frontmatter 에 title·order·level·summary 필수, level 은 기초/중급/심화 | 모든 md 파일 파싱 |
| 유효성 | title/summary 에 `: ` 가 있으면 따옴표 | YAML 파싱 오류 = 페이지 500 |
| 관계 | frontmatter `experiments` 의 id 가 실제 실험에 있나, quiz 의 note slug 가 존재하나, 용어집 link 가 존재하나 | 조인 검사 |
| 완전성 | 주제마다 퀴즈·용어가 최소 개수 이상 | 개수 검사 |

이것은 실험 `de-quality-checks` 의 relationships·accepted_values·contract 테스트와 정확히 같은 모양이다. CI 에서 이 검사를 돌리면 "YAML 하나 잘못 써서 페이지가 500" 같은 사고를 머지 전에 막는다.

## 실습 체크리스트

- [ ] 실험 `de-quality-checks` 에 불량 종류를 하나 더 심고(예: 미래 날짜 created_at) 그것을 잡는 테스트 추가하기
- [ ] 우리 핵심 테이블 하나에 대해 품질 차원 7개별 검사를 하나씩 적어 보기
- [ ] 각 검사의 심각도를 error / warn / 격리 중 하나로 정하고 이유를 쓰기
- [ ] 원천 테이블 하나의 데이터 계약 YAML 을 작성하고, 어떤 변경이 "깨지는 변경" 인지 정하기
- [ ] 이 사이트 노트 frontmatter 를 위 표의 검사로 훑는 스크립트를 짜 보기
