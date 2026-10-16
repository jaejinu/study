---
title: "오케스트레이션 — DAG, 재시도, 백필, 멱등한 파티션"
order: 3
level: 중급
summary: "cron 이 파이프라인 관리로 부족해지는 지점, DAG(작업 의존 그래프)와 스케줄러의 역할, Airflow(작업 중심)와 Dagster(자산 중심)의 사고방식 차이, 논리 날짜·데이터 구간, 재시도·타임아웃·SLA, 백필이 안전하려면 작업이 멱등해야 하는 이유(파티션 덮어쓰기 vs 덧붙이기), 센서와 이벤트 기반 실행, 관측과 알림, 이 사이트 파이프라인을 DAG 로 그려 보기"
tags: [오케스트레이션, DAG, Airflow, Dagster, 백필, 멱등성, 재시도, 스케줄러, 데이터 구간]
experiments: []
---

## cron 으로 시작해서 막히는 곳

처음 파이프라인은 대개 cron 이다.

```
0 2 * * *  python extract_orders.py && python load_to_lake.py && python build_marts.py
```

배치 파이프라인([01 배치 vs 스트리밍](/data-engineering/notes/01-batch-vs-streaming))이 커지면 이게 무너지는 순간들이 온다:

- `extract` 가 실패했는데 `build_marts` 가 어제 데이터로 돌아 잘못된 숫자를 낸다
- 3일 전 원천이 잘못돼서 그 3일을 다시 돌려야 한다 — 스크립트가 "오늘" 만 안다
- 작업 20개가 서로 의존하는데 순서와 병렬을 손으로 관리한다
- 실패를 알 방법이 로그 파일뿐이다

오케스트레이터는 이것을 정형화한다: **작업 의존 그래프(DAG), 스케줄, 재시도, 백필, 상태 기록, 알림.**

## DAG

```
extract_orders ─┐
                ├─▶ stg_orders ─┐
extract_users ──┘                ├─▶ fct_daily_sales ─▶ dashboard_refresh
                   stg_users ────┘
```

- 노드 = 작업(task) 또는 자산(asset), 간선 = "이것이 끝나야 저것을 시작"
- 순환이 없어야 한다(Directed Acyclic Graph)
- 의존이 없는 노드는 병렬로 돈다

## Airflow vs Dagster — 무엇을 1급으로 보나

| | Airflow | Dagster |
|---|---|---|
| 1급 개념 | **작업(task)** — "무엇을 실행하나" | **자산(asset)** — "무엇이 만들어지나" (테이블·파일) |
| 의존 표현 | `extract >> transform >> load` | 자산 함수의 인자로 상류 자산을 받음 |
| 데이터 구간 | `data_interval_start/end` (논리 날짜) | 파티션(일별·시간별) 정의 |
| 강점 | 거대한 생태계, 연산자 수천 개 | 계보·최신성·자산 단위 관측이 기본 |
| 맞는 곳 | 다양한 시스템을 순서대로 호출 | 데이터 자산 중심 팀, dbt 와 밀접 |

```python
# Airflow
with DAG("daily_sales", schedule="@daily", start_date=datetime(2026, 10, 1), catchup=True) as dag:
    extract = PythonOperator(task_id="extract", python_callable=extract_orders,
                             op_kwargs={"start": "{{ data_interval_start }}", "end": "{{ data_interval_end }}"})
    build = BashOperator(task_id="build", bash_command="dbt run --select fct_daily_sales --vars '{day: {{ ds }}}'")
    extract >> build

# Dagster
@asset(partitions_def=DailyPartitionsDefinition(start_date="2026-10-01"))
def stg_orders(context):
    day = context.partition_key
    return extract_orders(day)

@asset(partitions_def=DailyPartitionsDefinition(start_date="2026-10-01"))
def fct_daily_sales(stg_orders):
    return aggregate(stg_orders)
```

## 논리 날짜 — "언제 실행" 이 아니라 "어느 구간"

오케스트레이션에서 가장 헷갈리는 개념. `@daily` DAG 의 10월 16일 실행은 **10월 16일 00:00~24:00 구간의 데이터를 처리**하고, 그 구간이 끝난 **10월 17일 00:00 이후에** 실행된다.

```
data_interval_start = 2026-10-16 00:00
data_interval_end   = 2026-10-17 00:00
실제 실행 시각       = 2026-10-17 00:05 (또는 백필이면 한 달 뒤 아무 때나)
```

> **규칙:** 작업 코드는 절대 `now()` 로 구간을 정하지 않는다. 항상 오케스트레이터가 넘겨주는 구간을 쓴다. 그래야 같은 작업을 과거 날짜로 다시 돌렸을 때(백필) 같은 결과가 나온다.

## 멱등성 — 백필의 전제

같은 구간으로 작업을 두 번 돌려도 결과가 같아야 한다. 그렇지 않으면 재시도·백필이 데이터를 망친다.

| 방식 | 두 번 돌리면 | 판정 |
|---|---|---|
| `INSERT INTO sales SELECT … WHERE day = '10-16'` | 10-16 이 두 배 | ✗ 덧붙이기 |
| `DELETE WHERE day='10-16'; INSERT …` (같은 트랜잭션) | 같음 | ✓ |
| 파티션 덮어쓰기 (`INSERT OVERWRITE PARTITION`, ClickHouse `REPLACE PARTITION`) | 같음 | ✓ |
| 결과 파일을 `day=2026-10-16/part.parquet` 로 덮어쓰기 | 같음 | ✓ |
| `MERGE`(upsert) 로 키 기준 갱신 | 같음 | ✓ |
| 외부 API 호출(메일 발송) | 두 번 발송 | ✗ — 멱등 키 필요 |

**파티션 단위 덮어쓰기**가 가장 단순하고 강력하다. 구간 = 파티션 하나로 맞춰 두면 백필은 그 파티션들을 다시 만드는 일이 된다. 외부 부작용이 있는 작업은 [멱등 키](/architecture/notes/09-payments-ledger-consistency) 를 쓴다.

## 백필

원천 오류를 고쳤거나, 새 지표를 추가했을 때 과거 구간을 다시 계산하는 일.

```bash
airflow dags backfill daily_sales -s 2026-09-01 -e 2026-09-30
dagster asset materialize --select fct_daily_sales --partition-range 2026-09-01...2026-09-30
```

- 병렬도를 제한한다(`max_active_runs`). 한 달치를 동시에 돌리면 원천·웨어하우스가 터진다.
- 하류까지 다시 돌려야 한다. 자산 중심 도구는 하류를 자동으로 "오래됨(stale)" 으로 표시한다.
- 멱등하지 않은 작업이 섞여 있으면 백필 전에 먼저 고친다.

## 재시도·타임아웃·SLA

```python
default_args = {
    "retries": 3,
    "retry_delay": timedelta(minutes=5),
    "retry_exponential_backoff": True,   # 재시도 폭풍 방지
    "execution_timeout": timedelta(hours=1),
}
```

- **일시적 실패**(네트워크, 원천 잠깐 다운)는 재시도로, **데이터 오류**(스키마 변경)는 재시도해도 소용없으니 빠르게 실패시키고 사람에게 알린다.
- 재시도는 멱등해야 안전하다(위 표).
- **신선도 SLA**: "fct_daily_sales 는 매일 06:00 까지 준비" — 이걸 어기면 알림. [SLO](/sre/notes/02-sli-slo-error-budget) 개념을 데이터에 적용한 것이다.

## 센서와 이벤트 기반 실행

시간이 아니라 **조건**으로 시작하고 싶을 때.

- 센서: "S3 에 `_SUCCESS` 파일이 생기면", "원천 테이블의 오늘 파티션이 생기면" 시작
- 데이터 인지 스케줄(Airflow Datasets, Dagster 자동 구체화): 상류 자산이 갱신되면 하류 자동 실행

폴링 센서는 워커 슬롯을 잡아먹으니 `reschedule` 모드(확인 사이에 슬롯 반납)를 쓴다.

## 관측

| 볼 것 | 왜 |
|---|---|
| 실행 성공/실패·소요 시간 추이 | 점점 느려지는 작업은 곧 SLA 를 어긴다 |
| 자산 신선도(마지막 갱신 시각) | 대시보드가 낡은 데이터를 보여 주는지 |
| 처리 행 수 | 갑자기 0행 = 원천 문제. [품질 검사](/data-engineering/notes/06-data-quality-lineage-contracts) 와 연결 |
| 큐 대기 | 워커가 부족한지 |

메트릭을 Prometheus 로 내보내면 이 사이트의 [알림 파이프라인](/observability/notes/09-alerting-pipeline) 에 그대로 붙는다.

## 예시로 보기 — 이 프로젝트에서

이 사이트 데이터를 매일 레이크로 옮긴다면 DAG 는 이렇게 생긴다.

```
cdc_consume_to_lake (스트림, 상시)          ─┐
export_app_logs(day)  logs/app.jsonl → s3   ─┼─▶ stg_note_views(day) ─▶ fct_daily_study(day) ─▶ 첫 화면 '이번 주 학습'
export_quiz_stats(day) Redis quiz:stats:*   ─┘                     └─▶ quality_checks(day)
```

- 각 작업은 `day` 구간을 받아 `s3://lake/<asset>/day=YYYY-MM-DD/` 를 **덮어쓴다** → 멱등
- `quality_checks` 가 실패하면 `fct_daily_study` 를 발행하지 않는다(서킷 브레이커처럼)
- 실험 [de-quality-checks](/data-engineering/lab/de-quality-checks) 의 테스트 6종이 그대로 `quality_checks` 작업이 된다

## 심화 — 멱등 쓰기를 엔진별로

"파티션 덮어쓰기" 는 엔진마다 문법과 원자성 보장이 다르다. 같은 생각을 세 곳에서 구현해 보면 차이가 보인다.

```sql
-- PostgreSQL: 한 트랜잭션 안의 delete + insert. 읽는 쪽은 옛 값 또는 새 값만 본다
begin;
delete from fct_daily_sales where day = '2026-10-16';
insert into fct_daily_sales
select date_trunc('day', created_at), country, count(*), sum(amount)
from stg_orders where created_at >= '2026-10-16' and created_at < '2026-10-17'
group by 1, 2;
commit;
```

```sql
-- ClickHouse: 임시 테이블에 만든 뒤 파티션을 통째로 교체 (교체 자체는 원자적)
insert into fct_daily_sales_tmp select … where toDate(created_at) = '2026-10-16';
alter table fct_daily_sales replace partition '2026-10-16' from fct_daily_sales_tmp;
```

```sql
-- DuckDB → S3: 객체 저장소에는 원자적 rename 이 없다
copy (select …) to 's3://lake/gold/daily_sales/day=2026-10-16/part-0.parquet' (format parquet);
```

마지막 경우가 함정이다. S3 에서 "디렉터리 덮어쓰기" 는 **여러 객체를 지우고 쓰는 일**이라 그 사이에 읽는 쪽이 반쪽 데이터(옛 파일 일부 + 새 파일 일부)를 볼 수 있다. 파일 하나로 덮어쓰면(같은 키 PUT) 객체 단위로는 원자적이라 작은 테이블은 이걸로 충분하다. 파일이 여러 개가 되면 테이블 포맷(Iceberg 의 메타데이터 커밋)이나 "새 경로에 쓰고 포인터만 바꾸기" 가 필요하다 → [07 작은 레이크하우스](/data-engineering/notes/07-tiny-lakehouse-design).

## 심화 — 동시성 손잡이와 백필 계산

| 설정 (Airflow) | 범위 | 막는 것 |
|---|---|---|
| `max_active_runs` | DAG 하나의 동시 실행(날짜) 수 | 백필이 한꺼번에 30일치 돌기 |
| `max_active_tasks` | DAG 하나의 동시 작업 수 | DAG 하나가 워커 독점 |
| `pool` (슬롯 N개) | 여러 DAG 가 공유하는 자원 | "원천 DB 를 동시에 4개 이하만 때린다" |
| `priority_weight` | 대기열 순서 | 백필이 매일 작업을 밀어내기 |

백필 시간을 미리 계산해 본다(가정치). 하루 파티션 하나에 4분, 30일 백필, `max_active_runs=4` 면 대략 `30 / 4 × 4분 ≈ 30분`. 하지만 원천 DB 질의가 병렬 4개에서 느려져 작업당 10분이 되면 75분이다. **병렬도를 올리면 총 시간이 줄 것 같지만 공유 자원(원천·웨어하우스) 이 포화되면 오히려 늘어난다.** 그래서 백필은 `pool` 로 원천 접근을 제한하고, 매일 작업보다 낮은 우선순위로 돌린다.

Dagster 에서는 자산에 **검사(asset check)** 를 붙여 "만들어졌다" 와 "믿을 만하다" 를 구분한다.

```python
@asset_check(asset=fct_daily_sales)
def has_rows(context) -> AssetCheckResult:
    n = count_rows("fct_daily_sales", context.partition_key)  # 가상의 헬퍼
    return AssetCheckResult(passed=n > 0, metadata={"rows": n})
```

## 모니터링·로그 — 오케스트레이터가 아프면

오케스트레이터 장애는 두 층이다. **작업이 실패**하는 것과, **오케스트레이터 자체가 느려져 작업이 시작조차 안 되는 것**. 후자가 더 조용하고 위험하다.

| 증상 | 볼 메트릭 (Airflow StatsD 이름 예) | 흔한 원인 |
|---|---|---|
| 실행이 예정 시각보다 계속 늦게 시작 | `scheduler_heartbeat` 끊김, `dag_processing.total_parse_time` 증가 | DAG 파일 최상단에서 DB·API 호출 → 파싱이 느림 |
| 작업이 `queued` 에 오래 머묾 | `pool.open_slots.<pool>` = 0, `executor.queued_tasks` | 풀·워커 부족, 센서가 슬롯 점유 |
| 소요 시간이 매주 조금씩 증가 | `dagrun.duration.success.<dag_id>` 추세 | 데이터 증가, 증분이 사실상 전체 스캔 |
| 실패 폭증 | `ti_failures` | 원천 스키마 변경, 자격 증명 만료 |

작업 로그는 사람이 읽을 문장보다 **질의할 수 있는 필드**를 남긴다.

```json
{"msg":"task.done","dag":"daily_sales","task":"build","run_id":"scheduled__2026-10-16T00:00:00+00:00",
 "interval_start":"2026-10-16T00:00:00Z","rows_out":18342,"duration_ms":41210,"try":1}
```

`try` 가 2 이상인 작업이 늘면 일시적 장애가 늘고 있다는 신호다. `rows_out` 을 전주 같은 요일과 비교하면 "성공했지만 틀린" 실행을 잡는다. 신선도 경보는 [SLO 번레이트](/sre/notes/03-burn-rate-alerting) 처럼 "몇 번 연속 늦었나" 로 거는 편이 소음이 적다.

## 흔한 실수와 오해

- **`start_date=datetime.now()`** — 매번 파싱할 때 시작일이 바뀌어 스케줄이 영원히 안 돈다. 시작일은 고정값으로.
- **`catchup` 기본값을 믿고 과거 `start_date` 로 배포** — 버전에 따라 기본값이 다르다(Airflow 2 는 `True`, 3 은 `False`). 켜져 있으면 배포 직후 수백 개 실행이 쏟아진다. 항상 명시한다.
- **작업 사이 데이터를 XCom 으로 넘김** — XCom 은 메타데이터 DB 에 저장되는 작은 값용이다. 데이터는 객체 저장소에 쓰고 경로만 넘긴다.
- **재시도 = 안전** — 반쯤 쓰고 실패한 작업을 재시도하면, 덧붙이기 방식에선 앞부분이 두 번 들어간다. 재시도는 멱등 쓰기 위에서만 안전하다.
- **오케스트레이터에서 무거운 계산** — 오케스트레이터는 지휘자다. 계산은 웨어하우스·DuckDB·Spark 에 맡기고 오케스트레이터는 호출과 상태만.

## 스스로 점검

1. 10월 16일 `@daily` 실행의 `data_interval_end` 와 실제 실행 시각은? — 10-17 00:00, 실행은 그 이후(백필이면 아무 때나).
2. 같은 작업을 같은 구간으로 두 번 돌렸더니 매출이 두 배가 됐다. 원인과 고치는 방법 두 가지는? — 덧붙이기 쓰기. 같은 트랜잭션 delete+insert, 파티션 교체, merge.
3. 백필 병렬도를 4 → 16 으로 올렸더니 총 시간이 늘었다. 왜? — 원천·웨어하우스가 포화돼 작업당 시간이 늘었다. 풀로 공유 자원 접근을 제한한다.
4. 작업은 실패 없이 모두 성공인데 대시보드가 하루 늦다. 무엇을 의심하나? — 스케줄러 지연(파싱 시간, 큐 대기), 센서가 늦게 풀림, 신선도 지표 확인.

## 실습 체크리스트

- [ ] 지금 쓰는 cron 작업 하나를 골라 "멱등한가?" 를 표의 기준으로 판정하기
- [ ] `now()` 를 쓰는 SQL 하나를 논리 날짜(구간) 인자를 받도록 고쳐 보기
- [ ] 위 이 사이트용 DAG 를 Airflow 와 Dagster 문법으로 각각 써 보고 차이를 비교하기
- [ ] 백필 한 달치를 돌릴 때 병렬도·원천 부하·하류 재계산 계획을 세워 보기
- [ ] 신선도 SLA 하나를 정의하고 어겼을 때 누구에게 어떤 알림이 가는지 정하기
