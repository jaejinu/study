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

## 심화 — 증분 전략을 SQL 로 이해하기

`incremental_strategy` 는 결국 "새 행 묶음을 기존 테이블에 어떻게 넣나" 의 선택이고, dbt 는 이것을 엔진 SQL 로 컴파일한다. 대략 이런 모양이 된다(어댑터마다 세부는 다르다).

| 전략 | 컴파일되는 모양 | 재실행 시 | 주의 |
|---|---|---|---|
| `append` | `insert into t select …` | **중복** | 로그처럼 불변·중복 허용일 때만 |
| `merge` | `merge into t using new on t.k = new.k when matched update … when not matched insert …` | 같음 | `unique_key` 가 정말 유일해야 함 |
| `delete+insert` | `delete from t where k in (select k from new); insert …` | 같음 | merge 미지원 엔진의 대안 |
| `insert_overwrite` | 새 행이 속한 **파티션 전체**를 교체 | 같음 | 파티션 안 옛 행이 사라짐 — 파티션 전체를 다시 계산해야 함 |
| `microbatch` (dbt 1.9+) | 시간 구간별로 쪼개 각각 교체 | 같음 | 모델에 이벤트 시간 열이 필요 |

```sql
{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    event_time='created_at',      -- 이 열로 구간을 나눈다
    batch_size='day',
    lookback=3,                   -- 매번 최근 3일치를 다시 계산 (늦게 온 데이터 흡수)
    begin='2026-01-01'
) }}
select order_id, customer_id, amount, created_at from {{ ref('stg_orders') }}
```

```bash
# 특정 구간만 다시 (백필)
dbt run --select fct_orders --event-time-start 2026-09-01 --event-time-end 2026-10-01
```

microbatch 는 [오케스트레이션 노트](/data-engineering/notes/03-orchestration) 의 "구간 = 파티션, 덮어쓰기로 멱등" 을 dbt 안으로 가져온 것이다. 직접 `is_incremental()` 블록을 쓸 때보다 lookback·백필 실수가 줄어든다.

## 심화 — 실무 설정 몇 가지

```yaml
# models/sources.yml — 원천 신선도
sources:
  - name: app
    loaded_at_field: _loaded_at
    freshness:
      warn_after:  { count: 12, period: hour }
      error_after: { count: 24, period: hour }
    tables: [{ name: orders }, { name: customers }]
```

```yaml
# models/marts/schema.yml — 심각도와 계약
models:
  - name: fct_orders
    config:
      contract: { enforced: true }      # 선언한 열·타입과 다르면 빌드 실패
      on_schema_change: fail            # 기본값 ignore 는 새 열을 조용히 버린다
    columns:
      - name: order_id
        data_type: int
        tests:
          - unique
          - not_null
      - name: email
        data_type: varchar
        tests:
          - not_null:
              config: { severity: error, warn_if: ">0", error_if: ">100" }
```

- `dbt build` 는 run 과 test 를 **DAG 순서로 섞어** 돈다. `stg_orders` 테스트가 실패하면 그 하류 모델은 건너뛴다 — 틀린 데이터가 marts 까지 번지지 않는다. 운영에선 `run` 보다 `build` 가 기본이다.
- `warn_if`/`error_if` 로 "불량 몇 개까지는 경고" 를 표현한다. 이메일 null 3건에 파이프라인 전체를 세우는 건 과하다.
- **Slim CI**: PR 에서 바뀐 모델과 그 하류만 돌린다.

```bash
dbt build --select state:modified+ --defer --state ./prod-artifacts
```

`--defer` 는 바뀌지 않은 상류를 운영 테이블에서 읽게 해, PR 마다 전체를 다시 만들지 않는다.

## 모니터링 — dbt 실행을 관측하기

dbt 는 실행마다 `target/run_results.json` 과 `target/manifest.json` 을 남긴다. 이것이 관측의 원료다.

```bash
# 실패·경고만 뽑기
jq -r '.results[] | select(.status != "success" and .status != "pass")
       | [.unique_id, .status, .execution_time] | @tsv' target/run_results.json

# 가장 느린 모델 5개
jq -r '.results | sort_by(-.execution_time) | .[:5][] | [.unique_id, .execution_time] | @tsv' target/run_results.json
```

| 볼 것 | 어디서 | 의미 |
|---|---|---|
| 모델별 실행 시간 추세 | `execution_time` | 증분 모델이 갑자기 느려짐 = lookback 질의가 전체 스캔 |
| 영향 행 수 | `adapter_response.rows_affected` | 0 이면 원천 문제, 평소의 10배면 중복 |
| 테스트 실패 수 | `status = fail`, `failures` | 품질 추세 |
| 원천 신선도 | `dbt source freshness` 결과 | SLA |

이 값들을 실행 뒤 Prometheus Pushgateway 나 로그로 내보내면 [알림 파이프라인](/observability/notes/09-alerting-pipeline) 에 붙는다. "테스트 실패 수가 지난 7일 평균의 3배" 같은 추세 경보가 단일 실패 경보보다 유용하다.

## 흔한 실수와 오해

- **marts 에서 `source()` 를 직접 참조** — staging 을 우회하면 이름·타입 정리가 모델마다 달라진다. 원천은 staging 에서 한 번만 읽는다.
- **`unique_key` 가 실제로는 유일하지 않음** — merge 가 "여러 행이 매칭" 오류를 내거나(엔진에 따라) 조용히 중복이 남는다. `unique_key` 열에 `unique` 테스트를 반드시 붙인다.
- **`{{ this }}` 서브쿼리의 비용** — `select max(updated_at) from {{ this }}` 가 큰 테이블에서 전체 스캔이면 증분의 이점이 사라진다. 파티션·정렬 키를 확인한다.
- **`on_schema_change` 기본값** — 원천에 열이 추가돼도 증분 모델은 모른 척한다. 의도적으로 `append_new_columns` 나 `fail` 을 고른다.
- **"테스트가 통과했으니 숫자가 맞다"** — 규칙 테스트는 아는 문제만 잡는다. 행 수 급감·분포 변화는 [06 품질](/data-engineering/notes/06-data-quality-lineage-contracts) 의 이상 탐지로.
- **거대한 테이블에 실수로 `--full-refresh`** — 수 시간짜리 재계산이 돈다. 모델에 `full_refresh: false` 를 걸어 막을 수 있다.

## 스스로 점검

1. `append` 증분 모델을 같은 구간으로 두 번 돌리면? 어떤 전략으로 바꿔야 하나? — 중복. merge, delete+insert, insert_overwrite, microbatch.
2. `insert_overwrite` 에서 새 행만 SELECT 하면 무슨 일이 생기나? — 그 파티션의 기존 행이 사라진다. 파티션 전체를 다시 계산해야 한다.
3. `dbt run` 대신 `dbt build` 를 쓰는 이유는? — 테스트 실패 시 하류를 건너뛰어 틀린 데이터의 전파를 막는다.
4. 증분 모델 실행 시간이 어느 날부터 10배가 됐다. 무엇을 확인하나? — `is_incremental` 필터가 파티션 프루닝되는지, `{{ this }}` 서브쿼리, lookback 창 크기, 원천 데이터 급증.

## 실전에서는 어디에 쓰이나

> 분석 SQL 이 수백 개로 늘고 "매출" 정의가 대시보드마다 달라질 때, 변환 로직을 버전 관리·코드 리뷰·테스트·CI 아래 두려고 dbt 가 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 매출·주문 마트 | 지표 정의를 한 곳에 | staging → marts 계층, `ref` 의존, `dbt build` 로 테스트 실패 시 하류 중단 | BI 도구 안 계산 필드(정의가 흩어진다) |
| SaaS 구독 분석 | 플랜·국가 변경 이력으로 당시 기준 집계 | snapshot(SCD2) `dbt_valid_from/to` 로 시점 조인 | 현재 상태만 보관(과거 재현 불가) |
| 대용량 이벤트 사실 테이블 | 매일 전체 재빌드 비용 | incremental merge·microbatch + lookback 으로 늦은 데이터 흡수 | 매번 table 전체 재생성 |
| 데이터 팀 PR 리뷰 | 변경 영향 확인을 빠르게 | Slim CI `state:modified+ --defer` | PR 마다 전체 빌드 |
| 앱 팀과의 경계 | 원천 열 추가·타입 변경 감지 | 모델 계약(`contract: enforced`), `on_schema_change: fail` | 대시보드 오류로 사후 발견 |

**이럴 땐 안 맞는다**
- SQL 로 표현하기 어려운 변환(복잡한 파이썬 로직, ML 추론, 외부 API 호출) — dbt 는 엔진 안 SELECT 다. Spark·파이썬 작업으로.
- 초 단위 신선도가 필요한 지표 — 배치 실행 단위다. 스트림 처리나 엔진의 MV.

**누가 매일 만나나** — 분석 엔지니어·데이터 엔지니어가 모델을 추가하고 테스트 실패를 고칠 때, 분석가가 "이 열은 어디서 왔나" 를 dbt docs 계보로 찾을 때.

**면접·실무 단골 질문**
- Q. 증분 모델에서 늦게 온 데이터는 어떻게 처리하나? → lookback 창으로 겹쳐 읽고 `unique_key` merge 로 중복을 합친다(또는 microbatch 의 lookback).
- Q. `append` 증분의 위험은? → 재실행하면 중복된다. merge·delete+insert·insert_overwrite 로 멱등하게 만든다.

## 실습 체크리스트

- [ ] `pip install dbt-duckdb` 로 프로젝트를 만들고 Parquet 파일을 source 로 등록해 staging 모델 하나 만들기
- [ ] 증분 모델에서 lookback 창이 없을 때 늦게 온 행이 빠지는 상황을 재현하기
- [ ] 실험 `de-quality-checks` 의 테스트 6종을 `schema.yml` 테스트로 옮겨 보기
- [ ] SCD2 스냅샷으로 고객 국가 변경 이력을 남기고, 주문을 당시 국가로 집계하기
- [ ] `dbt docs` 의 계보 그래프에서 원천 열 하나를 바꾸면 영향받는 모델을 찾기
