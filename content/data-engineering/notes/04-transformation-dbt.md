---
title: "변환과 dbt — SQL 모델, 의존, 증분, 테스트"
order: 4
level: 중급
summary: "ELT 의 T 를 코드로 관리하는 dbt 의 사고방식(SELECT 하나 = 모델 하나, ref 로 의존 그래프), 계층 구조(staging·intermediate·marts), 구체화 방식(view·table·incremental·ephemeral)과 증분 모델의 함정(늦게 온 데이터·중복·is_incremental), 테스트(not_null·unique·accepted_values·relationships)와 문서·계보, 매크로·Jinja, 스냅샷(SCD2), DuckDB·ClickHouse 어댑터, 이 사이트 데이터로 만드는 작은 모델 세트"
tags: [dbt, ELT, SQL 모델, 증분 모델, 테스트, 스냅샷, SCD, staging, marts, DuckDB]
experiments: [de-quality-checks]
---

## dbt 가 하는 일

dbt(data build tool)는 **SQL SELECT 문을 파일로 관리하고, 의존 순서대로 실행해 테이블·뷰로 만들어 주는 도구**다. 데이터를 옮기지 않는다 — 이미 웨어하우스(또는 DuckDB·ClickHouse)에 있는 데이터를 그 엔진 안에서 변환한다(ELT 의 T).

dbt 가 가져온 것은 소프트웨어 공학 습관이다: 버전 관리, 코드 리뷰, 테스트, 문서, 모듈화, CI.

## 모델 = SELECT 하나

```sql
-- models/staging/stg_orders.sql
select
    id::int                as order_id,
    customer_id::int       as customer_id,
    lower(status)          as status,
    amount::decimal(12, 2) as amount,
    created_at::timestamp  as created_at
from {{ source('app', 'orders') }}
where id is not null
```

```sql
-- models/marts/fct_daily_sales.sql
select
    date_trunc('day', o.created_at) as day,
    c.country,
    count(*)                        as orders,
    sum(o.amount)                   as revenue
from {{ ref('stg_orders') }} o
join {{ ref('stg_customers') }} c using (customer_id)
where o.status in ('paid', 'shipped')
group by 1, 2
```

`{{ ref('stg_orders') }}` 가 핵심이다. dbt 는 모든 `ref` 를 읽어 **의존 그래프(DAG)** 를 만들고, 상류부터 실행하며, 대상 스키마 이름을 환경(dev/prod)에 맞게 채운다. 오케스트레이터에서 본 [DAG](/data-engineering/notes/03-orchestration) 가 SQL 파일 안에서 자동으로 생긴다.

## 계층 구조

| 계층 | 하는 일 | 규칙 |
|---|---|---|
| **sources** | 원천 테이블 선언 (`sources.yml`) | 신선도 검사 위치 |
| **staging** `stg_` | 원천 1:1, 이름·타입 정리, 정규화 | 원천 하나당 모델 하나, 조인 없음 |
| **intermediate** `int_` | 재사용되는 조인·가공 | 최종 사용자에게 노출 안 함 |
| **marts** `fct_` `dim_` | 비즈니스 개념 단위 결과 | 분석가·대시보드가 읽는 곳 |

`fct_`(사실: 주문·이벤트, 행이 계속 쌓임)와 `dim_`(차원: 고객·상품, 속성)은 차원 모델링(스타 스키마)의 용어다.

## 구체화 방식

```yaml
# dbt_project.yml
models:
  study:
    staging:     { +materialized: view }
    marts:       { +materialized: table }
```

| 방식 | 동작 | 언제 |
|---|---|---|
| `view` | 뷰만 만듦, 질의 때 계산 | 가벼운 staging |
| `table` | 매번 전체 다시 만듦 | 작은~중간 marts |
| `incremental` | 새 데이터만 추가·병합 | 큰 사실 테이블 |
| `ephemeral` | 테이블 없이 CTE 로 끼워 넣음 | 재사용 조각 |
| `materialized_view` | 엔진의 MV (지원 시) | 실시간 집계 |

### 증분 모델과 함정

```sql
{{ config(materialized='incremental', unique_key='order_id', incremental_strategy='merge') }}

select order_id, customer_id, status, amount, updated_at
from {{ ref('stg_orders') }}
{% if is_incremental() %}
  where updated_at > (select max(updated_at) - interval '3 hours' from {{ this }})
{% endif %}
```

- 첫 실행(또는 `--full-refresh`)은 전체, 이후엔 `is_incremental()` 블록이 켜져 새 행만 읽는다.
- **늦게 온 데이터**: `max(updated_at)` 이후만 읽으면 늦게 도착한 옛 시각의 행을 영원히 놓친다. 그래서 **겹치는 창(lookback, 위의 3시간)** 을 두고 `unique_key` 로 중복을 병합한다.
- **삭제는 못 본다**: 증분 쿼리는 삭제된 행을 모른다. 삭제를 반영하려면 CDC 의 삭제 이벤트(`__deleted`)를 쓰거나 주기적으로 full refresh.
- **merge vs delete+insert vs append**: append 는 빠르지만 재실행하면 중복. 대부분 merge 나 파티션 단위 delete+insert 가 안전하다([멱등성](/data-engineering/notes/03-orchestration)).

## 테스트

dbt 테스트는 **"규칙을 어기는 행을 돌려주는 SELECT"** 다. 0행이면 통과.

```yaml
# models/marts/schema.yml
models:
  - name: fct_orders
    columns:
      - name: order_id
        tests: [not_null, unique]
      - name: status
        tests:
          - accepted_values: { values: ['placed', 'paid', 'shipped', 'cancelled'] }
      - name: customer_id
        tests:
          - relationships: { to: ref('dim_customers'), field: customer_id }
      - name: amount
        tests:
          - dbt_utils.expression_is_true: { expression: ">= 0" }
```

`dbt test` 를 돌리면 각 테스트가 SQL 로 컴파일돼 실행된다. 실험 [de-quality-checks](/data-engineering/lab/de-quality-checks) 는 이 6종을 DuckDB SQL 로 직접 짜서, 일부러 심은 불량을 정확히 그 개수만큼 잡는 것을 보여 준다.

| 테스트 | 심은 불량 | 잡은 행 |
|---|---|---|
| not_null(email) | 5 | 5 |
| unique(order_id) | 3 | 3 |
| accepted_values(status) | 4 (`shiped`, `PAID`) | 4 |
| relationships(customer_id) | 6 | 6 |
| range(amount ≥ 0) | 2 | 2 |
| contract(columns) | 계약 밖 열 1 | 1 |

품질 검사의 설계(심각도·위치·격리)는 [06 품질·계보·계약](/data-engineering/notes/06-data-quality-lineage-contracts) 에서 더 깊게 다룬다.

## 스냅샷 — 차원의 변화 이력 (SCD2)

고객의 국가가 KR → JP 로 바뀌면, 과거 주문은 어느 국가로 집계해야 할까? 변화 이력을 남기는 것이 **천천히 변하는 차원(SCD) 타입 2** 다.

```sql
{% snapshot customers_snapshot %}
{{ config(unique_key='id', strategy='timestamp', updated_at='updated_at') }}
select * from {{ source('app', 'customers') }}
{% endsnapshot %}
```

결과 테이블에는 `dbt_valid_from`, `dbt_valid_to` 가 붙어 "이 행은 이 기간 동안 유효했다" 를 기록한다. 주문을 그 시점의 고객 속성과 조인할 수 있다.

## 매크로와 Jinja

SQL 안에서 반복을 줄인다.

```sql
{% macro cents_to_won(col) %} ({{ col }} * 10)::bigint {% endmacro %}

select {{ cents_to_won('amount_cents') }} as amount_won from …

{% for status in ['placed', 'paid', 'shipped'] %}
  , countif(status = '{{ status }}') as {{ status }}_orders
{% endfor %}
```

과하면 읽기 어려운 SQL 이 된다. 매크로는 진짜 반복되는 것에만.

## 문서와 계보

```bash
dbt docs generate && dbt docs serve
```

모델·열 설명, 테스트, 그리고 **계보 그래프**(어느 원천이 어느 대시보드로 흘러가나)를 웹으로 보여 준다. 원천 열 하나를 바꾸면 무엇이 깨지는지 미리 알 수 있다.

## 어댑터 — 어디서 돌리나

| 어댑터 | 쓰임 |
|---|---|
| dbt-duckdb | 로컬·작은 레이크하우스. Parquet·S3 를 직접 소스로 |
| dbt-clickhouse | ClickHouse 위 변환, 증분 전략이 MergeTree 특성에 맞춰짐 |
| dbt-postgres | 작은 규모, 운영 DB 복제본 위 |
| dbt-bigquery·snowflake·databricks | 클라우드 웨어하우스 |

## 예시로 보기 — 이 프로젝트에서

이 사이트의 학습 데이터로 dbt-duckdb 프로젝트를 만든다면:

```
sources: s3://lake/app_logs/day=*/   (logs/app.jsonl 을 매일 내보낸 것)
         s3://lake/quiz_stats/        (Redis quiz:stats:* 덤프)

models/staging/stg_note_views.sql     -- msg = 'note.view' 만, subject·slug·ts 추출
models/staging/stg_quiz_answers.sql
models/marts/fct_daily_study.sql      -- 날짜 × 주제: 조회 수, 퀴즈 정답률
models/marts/dim_notes.sql            -- content/*/notes 의 frontmatter (title, level)
```

```sql
-- models/staging/stg_note_views.sql
select
    cast(ts as timestamp)                    as viewed_at,
    json_extract_string(line, '$.subject')   as subject,
    json_extract_string(line, '$.slug')      as slug,
    json_extract_string(line, '$.trace_id')  as trace_id
from {{ source('lake', 'app_logs') }}
where json_extract_string(line, '$.msg') = 'note.view'
```

`dim_notes` 와 조인하면 "레벨별(기초·중급·심화) 조회 비율" 같은 질문에 답할 수 있다. 테스트는 `relationships(stg_note_views.slug → dim_notes.slug)` — 삭제된 노트를 가리키는 조회가 있는지 잡는다.

## 실습 체크리스트

- [ ] `pip install dbt-duckdb` 로 프로젝트를 만들고 Parquet 파일을 source 로 등록해 staging 모델 하나 만들기
- [ ] 증분 모델에서 lookback 창이 없을 때 늦게 온 행이 빠지는 상황을 재현하기
- [ ] 실험 `de-quality-checks` 의 테스트 6종을 `schema.yml` 테스트로 옮겨 보기
- [ ] SCD2 스냅샷으로 고객 국가 변경 이력을 남기고, 주문을 당시 국가로 집계하기
- [ ] `dbt docs` 의 계보 그래프에서 원천 열 하나를 바꾸면 영향받는 모델을 찾기
