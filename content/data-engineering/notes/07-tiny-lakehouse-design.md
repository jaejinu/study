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

## 실습 체크리스트

- [ ] 위 질문 표에 우리만의 질문 2개를 추가하고 필요한 원천과 신선도를 적기
- [ ] bronze·silver·gold 경로와 파티션을 직접 정해 S3(실험의 versitygw)에 하루치를 만들어 보기
- [ ] Iceberg 도입 신호표에서 지금 켜진 신호가 몇 개인지 세고, 도입 시점을 판단하기
- [ ] 품질 게이트가 실패했을 때 gold 를 어제 버전으로 유지하는 방법(덮어쓰기 순서·원자적 교체)을 설계하기
- [ ] 단계 0 (실험 결과를 서버 로그로) 을 구현하려면 어떤 코드가 바뀌어야 하는지 찾아보기
