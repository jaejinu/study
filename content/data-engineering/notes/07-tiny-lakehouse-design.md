---
title: "심화 — 이 사이트를 위한 작은 레이크하우스 설계"
order: 7
level: 심화
summary: "지금까지의 조각(CDC·Kafka·Parquet·DuckDB·ClickHouse·dbt·품질 검사)을 이 학습 사이트 규모에 맞게 엮는 설계 연습: 무엇을 분석하고 싶은지에서 출발해 원천 목록, 수집 경로, 메달리온 계층(bronze·silver·gold), 파티션·파일 크기·병합 주기, 테이블 포맷(손 병합 → Iceberg)으로 넘어가는 시점, 질의 엔진 선택(DuckDB vs ClickHouse), 비용·운영 부담, 단계별 이행 계획과 실험으로 확인한 사실들"
tags: [레이크하우스, 설계, 메달리온, bronze, silver, gold, CDC, Iceberg, DuckDB, ClickHouse]
experiments: [de-cdc-to-lake, de-parquet-duckdb, de-quality-checks]
---

## 출발점은 질문이다

인프라부터 고르면 과설계가 된다. 이 사이트에서 답하고 싶은 질문부터 적는다.

| 질문 | 필요한 데이터 | 신선도 |
|---|---|---|
| 주제·레벨별로 어떤 노트가 많이 읽히나 | 노트 조회 로그 | 하루 |
| 어떤 퀴즈를 자주 틀리나, 복습이 효과가 있나 | 퀴즈 답 기록 | 하루 |
| 실험 성공률·소요 시간 추이, 회귀가 생겼나 | 실험 실행 결과 | 하루 |
| AI 에게 묻기의 비용·지연·자주 묻는 주제 | ask 로그, LLM 메트릭 | 시간 |
| 학습 시간 대비 진도 | 학습 시간, 읽음 기록 | 하루 |

결론부터: **모두 하루~시간 단위면 충분하다.** 스트림 처리는 필요 없다([05 스트림](/data-engineering/notes/05-stream-processing)). 데이터량도 하루 수천~수만 줄이다. 이 규모의 정답은 "작게, 하지만 올바른 모양으로" 다.

## 원천

| 원천 | 어디 | 형태 | 꺼내는 법 |
|---|---|---|---|
| 앱 로그 | `logs/app.jsonl` (+ Loki) | JSON 줄 | 일 단위 파일 복사 |
| 퀴즈 기록 | Redis `quiz:stats:*` | 해시 | 일 단위 덤프 |
| 학습 시간 | Redis `study:day:*` | 해시 | 일 단위 덤프 |
| 실험 결과 | (현재 브라우저 저장) → 서버 저장 필요 | JSON | 앱이 로그로 남기게 |
| 노트 메타 | `content/*/notes/*.md` frontmatter | YAML | 빌드 시 추출 |
| 업무 데이터(가상) | PostgreSQL | 행 | CDC (실험으로 검증) |

## 메달리온 계층

```
bronze (원본 그대로, 추가만)      silver (정리·중복 제거·타입)       gold (질문 단위 집계)
s3://lake/bronze/app_logs/day=…   s3://lake/silver/note_views/day=…   s3://lake/gold/daily_study/
s3://lake/bronze/quiz_dump/day=…  s3://lake/silver/quiz_answers/       s3://lake/gold/quiz_difficulty/
s3://lake/bronze/orders_cdc/…     s3://lake/silver/orders_current/     s3://lake/gold/lab_trends/
```

- **bronze**: 원천을 손대지 않고 쌓는다. 변환이 틀려도 여기서 다시 만들 수 있다(ELT 의 원칙, [01](/data-engineering/notes/01-batch-vs-streaming)).
- **silver**: [dbt staging](/data-engineering/notes/04-transformation-dbt) 에 해당. 타입·이름 정리, CDC 병합(현재 상태), 품질 검사 통과분만.
- **gold**: 대시보드·질문 단위. 작고, 자주 읽힌다.

## 파일 배치

| 결정 | 선택 | 이유 |
|---|---|---|
| 포맷 | Parquet ZSTD | 실험에서 CSV 의 1/4.5 크기, 집계 25배 빠름 |
| 파티션 | `day=YYYY-MM-DD` | 백필·보존 단위 = 하루, [멱등 덮어쓰기](/data-engineering/notes/03-orchestration) |
| 파티션 안 정렬 | 시간(ts), 그다음 주제 | 시간 범위 질의의 행 그룹 건너뛰기 — 실험에서 1/10 만 후보 |
| 파일 크기 | 하루 1개 (수 MB) | 지금 규모에선 작은 파일 문제가 없다. 하루 100MB 를 넘으면 행 그룹 크기 조정 |
| CDC 마이크로배치 | 5분마다 1파일 → 하루 끝에 병합 | 실험의 batch=0001, 0002 처럼 쌓이다가 일 단위로 합침 |

## 테이블 포맷 — 언제 Iceberg 로?

실험 [de-cdc-to-lake](/data-engineering/lab/de-cdc-to-lake) 는 테이블 포맷 없이 손으로 병합했다(키별 최신 + `__deleted` 제외). 이게 언제 무너지나?

| 신호 | 손 병합 | Iceberg 가 필요해짐 |
|---|---|---|
| 동시 쓰기 | 한 작업만 씀 | 여러 작업이 같은 테이블에 씀 |
| 파일 수 | 수백 개 | 수만 개 (목록·footer 비용) |
| 원자성 | 하루 단위 덮어쓰기로 충분 | 읽는 중 반쪽 데이터를 보면 안 됨 |
| 스키마 변경 | 거의 없음 | 열 이름·타입이 자주 바뀜 |
| 과거 조회 | 필요 없음 | 감사·롤백을 위해 타임 트래블 |
| 삭제 | 드묾 | 개인정보 삭제 요구 |

지금 이 사이트는 왼쪽 열이다. **Iceberg 는 신호가 둘 이상 켜질 때** 도입한다. 그때도 데이터 파일은 그대로 Parquet 라 이행이 어렵지 않다(`add_files` 로 기존 파일 등록). 자세한 구조는 [02 열 포맷과 레이크하우스](/data-engineering/notes/02-columnar-formats-lakehouse).

## 질의 엔진 — DuckDB 냐 ClickHouse 냐

| | DuckDB | ClickHouse |
|---|---|---|
| 배치 변환(silver·gold 만들기) | ✓ 프로세스 안에서 S3 Parquet 를 바로 | 가능하지만 과함 |
| 노트북 탐색 | ✓ | — |
| 여러 사람이 상시 대시보드 | 동시 접속에 약함 | ✓ |
| 초 단위 로그 분석 | — | ✓ [ClickHouse 주제](/clickhouse/notes/05-log-trace-analytics) |
| 운영 부담 | 없음 (라이브러리) | 서버 하나 |

이 사이트의 선택: **변환은 DuckDB, 서빙은 필요할 때 ClickHouse.** gold 테이블은 작아서 DuckDB 로 Next.js 서버 안에서 바로 읽어도 된다(첫 화면의 '이번 주 학습' 같은 카드). 로그 분석이 커지면 bronze 를 ClickHouse 에도 적재한다.

## 품질 게이트

[06 품질·계보·계약](/data-engineering/notes/06-data-quality-lineage-contracts) 의 원칙대로 silver → gold 사이에 검사를 둔다.

```
bronze ──▶ silver 생성 ──▶ [품질 검사: not_null·unique·relationships·freshness] ──┬─ 통과 → gold 발행
                                                                                  └─ error → 발행 중단 + 알림
```

실험 [de-quality-checks](/data-engineering/lab/de-quality-checks) 의 6종 테스트가 그대로 이 게이트가 된다. 특히 `relationships(note_views.slug → notes.slug)` 는 이름이 바뀐 노트를 가리키는 옛 조회를 잡는다.

## 비용과 운영

| 항목 | 이 설계 |
|---|---|
| 저장 | 하루 수 MB × 365 = 연 수 GB. 사실상 무료 |
| 연산 | 하루 한 번 DuckDB 작업 수 초 |
| 상시 서비스 | 없음 (S3 호환 저장소 하나, 선택적으로 ClickHouse) |
| 운영 | cron 또는 작은 오케스트레이터. 실패 알림은 기존 Alertmanager |

> **설계의 교훈:** 같은 아키텍처 그림(CDC → 로그 → 객체 저장소 → 열 포맷 → 엔진)이 하루 1만 줄에도 하루 100억 줄에도 쓰인다. 달라지는 것은 각 상자의 **구현**(손 병합 ↔ Iceberg, DuckDB ↔ Spark/ClickHouse 클러스터)이다. 작게 시작해 신호가 켜질 때 상자 하나씩 바꾼다.

## 단계별 이행

| 단계 | 할 일 | 확인 |
|---|---|---|
| 0 | 실험 결과를 서버 로그로도 남기기 (지금은 브라우저에만) | `logs/app.jsonl` 에 `lab.result` 이벤트 |
| 1 | 일 단위로 로그·Redis 덤프를 bronze 로 | `s3://lake/bronze/*/day=…` |
| 2 | DuckDB 스크립트로 silver·gold 생성, 품질 게이트 | 테스트 0 실패 |
| 3 | gold 를 앱이 읽어 카드로 표시 | 첫 화면 통계 |
| 4 | (필요해지면) ClickHouse 로 로그 분석, Iceberg 로 테이블화 | 위 신호표 |

## 예시로 보기 — 이 프로젝트에서

세 실험이 이 설계의 각 부분을 이미 검증했다.

| 실험 | 확인한 사실 |
|---|---|
| [de-parquet-duckdb](/data-engineering/lab/de-parquet-duckdb) | Parquet ZSTD 9.0MB vs CSV 40.6MB, 시간순 정렬이면 1시간 질의 후보 행 그룹 1/10 |
| [de-cdc-to-lake](/data-engineering/lab/de-cdc-to-lake) | PG → Debezium → Kafka → S3 Parquet → DuckDB 병합 결과가 원본과 행 수·합계·max(id) 정확히 일치. 병합 없이 세면 283 vs 210 |
| [de-quality-checks](/data-engineering/lab/de-quality-checks) | 심은 불량 6종을 정확히 그 개수만큼 탐지, 신선도는 warn |

## 심화 — DuckDB 로 실제 한 바퀴 돌리기

설계를 코드로 옮기면 아래 정도가 된다. 하루치를 처리하는 스크립트 하나가 bronze → silver → 검사 → gold 를 모두 한다(경로와 열 이름은 예시).

```sql
INSTALL httpfs; LOAD httpfs;
-- 실험이 띄우는 versitygw 와 같은 설정
CREATE SECRET lake (TYPE s3, KEY_ID 'study', SECRET 'study-secret',
                    ENDPOINT '127.0.0.1:19102', URL_STYLE 'path', USE_SSL false, REGION 'us-east-1');

-- silver: 노트 조회만 골라 타입 정리
COPY (
  SELECT CAST(ts AS TIMESTAMP) AS viewed_at, subject, slug, trace_id
  FROM read_json_auto('s3://lake/bronze/app_logs/day=2026-10-16/*.jsonl')
  WHERE msg = 'note.view'
  ORDER BY viewed_at, subject          -- 행 그룹 건너뛰기를 위한 정렬
) TO 's3://lake/silver/note_views/day=2026-10-16/part-0.parquet' (FORMAT parquet, COMPRESSION zstd);

-- silver: CDC 병합 — 키별 최신 1건, 삭제 제외
COPY (
  SELECT * EXCLUDE (rn) FROM (
    SELECT *, row_number() OVER (PARTITION BY id ORDER BY _offset DESC) AS rn   -- 실험과 같은 기준: Kafka 오프셋
    FROM read_parquet('s3://lake/bronze/orders_cdc/**/*.parquet')
  ) WHERE rn = 1 AND __deleted = 'false'
) TO 's3://lake/silver/orders_current/part-0.parquet' (FORMAT parquet, COMPRESSION zstd);
```

병합의 **정렬 기준**이 핵심이다. 이벤트를 "받은 순서" 나 앱 시각(`updated_at`)으로 정렬하면 같은 밀리초에 두 번 바뀐 행이나 시계가 어긋난 서버에서 틀린 버전이 이긴다. 원천 DB 가 정한 순서를 써야 한다. 실험 [de-cdc-to-lake](/data-engineering/lab/de-cdc-to-lake) 는 Kafka 오프셋(`_offset`)으로 정렬하는데, 이것이 맞는 이유는 Debezium 이 같은 키를 같은 파티션에 커밋 순서대로 넣기 때문이다. 토픽 파티션 수를 바꾸거나 여러 토픽을 합치면 이 전제가 깨지니, 그때는 WAL 위치(LSN)를 레코드에 함께 실어 그것으로 정렬한다.

### 작은 파일 병합(compaction)

5분 마이크로배치는 하루 288 파일을 만든다. 하루가 끝나면 합친다.

```sql
COPY (SELECT * FROM read_parquet('s3://lake/bronze/orders_cdc/day=2026-10-16/batch=*.parquet') ORDER BY _offset)
TO 's3://lake/bronze/orders_cdc/day=2026-10-16/compacted.parquet' (FORMAT parquet, COMPRESSION zstd);
-- 그다음 batch=* 파일 삭제
```

"새 파일 쓰기" 와 "옛 파일 삭제" 사이에 읽는 쪽은 **같은 데이터를 두 번** 본다. 병합 결과가 키별 최신이라 CDC 병합은 이를 견디지만, 단순 합계를 내는 질의는 두 배가 된다. 이 창을 없애고 싶어지는 순간이 위 신호표의 "원자성" 칸이 켜지는 순간이다.

### gold 를 원자적으로 발행하기

품질 게이트가 실패하면 gold 는 어제 버전이어야 한다. 객체 저장소에는 디렉터리 rename 이 없으니 **새 경로에 쓰고 포인터만 바꾼다.**

```
s3://lake/gold/daily_study/runs/2026-10-16T01-00/part-0.parquet   ← 새로 씀
s3://lake/gold/daily_study/runs/2026-10-15T01-00/part-0.parquet   ← 어제 것 그대로
s3://lake/gold/daily_study/_current  = "runs/2026-10-16T01-00"     ← 검사 통과 후에만 갱신 (객체 하나 PUT = 원자적)
```

읽는 쪽은 `_current` 를 먼저 읽고 그 경로만 본다. 실패하면 포인터를 안 바꾸면 되니 롤백도 공짜다. 이것은 Iceberg 가 메타데이터 파일 포인터를 바꿔 커밋하는 방식의 아주 작은 버전이다.

## 관측 — 이 레이크하우스가 아프면

작은 시스템일수록 관측을 작게, 하지만 **신선도·양·품질** 세 가지는 꼭 둔다.

| 메트릭 (작업이 내보냄) | 경보 조건 예 | 잡는 장애 |
|---|---|---|
| `lake_last_success_timestamp_seconds{asset}` | gold 가 26시간 넘게 갱신 안 됨 | cron 멈춤, 게이트 실패 반복 |
| `lake_partition_rows{asset, day}` | 전주 같은 요일 대비 50% 미만 | 로그 수집 누락, 앱 이벤트 이름 변경 |
| `lake_quality_failures{test}` | error 심각도 1 이상 | 원천 스키마 변경 |
| `lake_files_per_partition{asset}` | 하루 300 초과 | 병합 작업 멈춤 |

```yaml
# Prometheus 규칙 예
- alert: LakeGoldStale
  expr: time() - lake_last_success_timestamp_seconds{layer="gold"} > 26 * 3600
  for: 15m
  labels: { severity: warning }
  annotations:
    summary: "gold {{ $labels.asset }} 가 26시간 넘게 갱신되지 않음"
```

이 사이트는 이미 Prometheus·Alertmanager 가 있으니 배치 작업은 끝날 때 Pushgateway 로 위 값을 보내면 된다. 26시간인 이유: 하루 한 번 작업이라 24시간 + 실행 여유 2시간. 23시간으로 걸면 매일 아침 오탐이 난다.

### AI 기능의 비용도 같은 레이크로

"AI 에게 묻기" 로그(모델, 입력·출력 토큰, 지연, 주제)를 bronze 에 쌓으면 gold 에 `ask_daily(day, subject, model, calls, tokens_in, tokens_out, p95_latency_ms, est_cost)` 를 만들 수 있다. 실시간 경보는 [LLM 관측](/observability/notes/08-llm-observability) 의 메트릭이 맡고, 레이크는 "어느 주제 질문이 비싼가, 프롬프트를 바꾼 뒤 토큰이 줄었나" 같은 **기간 비교**를 맡는다. 같은 데이터라도 질문의 시간 단위에 따라 저장소가 나뉜다.

## 설계 트레이드오프 — 다른 선택지와 비교

| 선택지 | 장점 | 단점 | 이 사이트에 |
|---|---|---|---|
| 운영 PostgreSQL 에 분석 테이블 추가 | 가장 단순, 새 부품 없음 | 분석 질의가 운영과 자원 경쟁, 로그 적재에 부적합 | 아주 초기엔 가능 |
| ClickHouse 하나에 모두 적재 | 빠른 질의, 대시보드 강함 | 상시 서버 운영, 원본 보존·재처리 경로를 따로 설계 | 로그 분석이 커지면 |
| **객체 저장소 + Parquet + DuckDB (이 설계)** | 서버 없음, 원본 보존, 엔진 교체 쉬움 | 동시성·원자성은 직접 챙김 | 지금 |
| 클라우드 웨어하우스 | 운영 거의 없음, 확장 | 비용, 로컬 실습 불가 | 과함 |

## 흔한 실수와 오해

- **bronze 를 "정리된 원본" 으로 만들기** — bronze 에서 필터·변환을 하면 그 실수를 되돌릴 원본이 없다. bronze 는 정말 손대지 않는다.
- **파티션을 너무 잘게** — `day=/hour=/subject=` 로 쪼개면 파일 하나가 수 KB 가 된다. 파티션은 "백필·삭제 단위" 로만 정하고 나머지는 파일 안 정렬로 해결한다.
- **CDC 병합을 수신 시각으로 정렬** — 위에서 본 것처럼 오프셋·LSN 같은 원천 순서를 쓴다.
- **"작으니 품질 검사는 나중에"** — 작은 시스템일수록 아무도 대시보드를 매일 안 보므로 틀린 숫자가 오래 산다. 게이트는 처음부터.

## 스스로 점검

1. gold 발행 중 품질 검사가 실패했다. 사용자가 반쪽 데이터를 보지 않게 하려면? — 새 경로에 쓰고 검사 통과 후 포인터 객체만 교체.
2. 작은 파일 병합 중 합계 질의가 일시적으로 두 배가 됐다. 원인과 근본 해결은? — 새 파일 쓰기와 옛 파일 삭제 사이의 창. 원자적 커밋(테이블 포맷) 또는 포인터 교체.
3. 신선도 경보를 24시간이 아니라 26시간으로 거는 이유는? — 하루 주기 작업의 실행 시각 변동 때문에 오탐이 난다.
4. 이 사이트에서 ClickHouse 를 도입할 신호는? — 여러 사람의 상시 대시보드, 초 단위 로그 분석, DuckDB 변환 시간 급증.

## 실전에서는 어디에 쓰이나

> 분석 기반이 아직 없는 작은 팀이 "나중에 커져도 갈아엎지 않을 모양" 으로 시작하고 싶을 때 이 설계 방식이 등장한다. 질문에서 출발해, 신호가 켜질 때 상자를 하나씩 바꾼다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 초기 스타트업 제품 분석 | 상시 서버 없이 일 단위 지표 | 객체 저장소 + Parquet + DuckDB 배치, 작은 gold 는 앱이 직접 읽기 | 클라우드 웨어하우스(비용), 운영 DB 에 분석 테이블(자원 경쟁) |
| 사내 도구·학습 플랫폼 | 사용 로그와 퀴즈·실험 결과 결합 | bronze(원본)·silver(정리)·gold(질문 단위) 메달리온 | 로그 시스템에서 바로 질의 |
| AI 기능을 붙인 서비스 | 모델·주제별 토큰 비용과 지연의 기간 비교 | ask 로그를 bronze 로, gold `ask_daily` 집계 | LLM 관측 도구의 짧은 보존 기간 |
| 성장 중인 SaaS | 손 병합의 한계(동시 쓰기, 파일 수만, 삭제 요구) | 신호가 둘 이상 켜지면 Iceberg 도입, 기존 Parquet 는 `add_files` 로 등록 | 처음부터 Iceberg(과설계) |

**이럴 땐 안 맞는다**
- 여러 사람이 상시로 보는 초 단위 대시보드 — DuckDB 는 동시 접속에 약하다. ClickHouse 같은 서버형 OLAP.
- 이미 데이터량·동시 쓰기가 큰 조직 — 손 병합과 포인터 교체로는 원자성·운영을 감당하지 못한다. 테이블 포맷과 클러스터 엔진부터.

**누가 매일 만나나** — 작은 팀에서 백엔드와 데이터를 겸하는 엔지니어가 첫 분석 파이프라인을 만들 때, 플랫폼 엔지니어가 "언제 Iceberg·ClickHouse 로 넘어가나" 를 판단할 때.

**면접·실무 단골 질문**
- Q. 메달리온 계층에서 bronze 를 손대지 않는 이유? → 변환 실수를 되돌릴 원본이 남아 있어야 재처리할 수 있다.
- Q. 객체 저장소에서 결과를 원자적으로 발행하려면? → 새 경로에 쓰고, 검사 통과 후 포인터 객체 하나만 PUT 한다(Iceberg 커밋의 축소판).

## 실습 체크리스트

- [ ] 위 질문 표에 우리만의 질문 2개를 추가하고 필요한 원천과 신선도를 적기
- [ ] bronze·silver·gold 경로와 파티션을 직접 정해 S3(실험의 versitygw)에 하루치를 만들어 보기
- [ ] Iceberg 도입 신호표에서 지금 켜진 신호가 몇 개인지 세고, 도입 시점을 판단하기
- [ ] 품질 게이트가 실패했을 때 gold 를 어제 버전으로 유지하는 방법(덮어쓰기 순서·원자적 교체)을 설계하기
- [ ] 단계 0 (실험 결과를 서버 로그로) 을 구현하려면 어떤 코드가 바뀌어야 하는지 찾아보기
