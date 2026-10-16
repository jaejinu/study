---
title: PostgreSQL 아키텍처 한눈에
order: 1
level: 기초
summary: 프로세스 모델, 공유 버퍼와 WAL, 저장 구조(힙·페이지·TOAST), 시스템 카탈로그, 기본 명령
tags: [개요, 아키텍처, WAL, shared_buffers, psql]
experiments: [pg-index-explain, pg-transaction-isolation]
---

## 프로세스 모델

PostgreSQL 은 **커넥션마다 백엔드 프로세스**를 fork 한다 (스레드 아님). 그래서 커넥션 수천 개는 부담이고 **PgBouncer** 같은 커넥션 풀러를 앞에 둔다.

```
postmaster (수신 대기)
 ├─ backend ×N        (클라이언트당 하나)
 ├─ background writer (더티 페이지를 디스크로)
 ├─ checkpointer      (주기적 체크포인트)
 ├─ WAL writer
 ├─ autovacuum launcher / workers
 └─ stats collector, archiver, logical replication workers ...
```

## 쓰기 경로: WAL 이 먼저

1. 변경은 **shared_buffers**(메모리 페이지 캐시)의 페이지에 적용된다.
2. 변경 내용이 **WAL(Write-Ahead Log)** 에 순차 기록되고 커밋 시 fsync 된다. 이것이 내구성의 근거.
3. 더티 페이지는 나중에 checkpointer/bgwriter 가 데이터 파일에 쓴다.
4. 크래시 시 마지막 체크포인트부터 WAL 을 재생해 복구한다.

WAL 은 복제(스트리밍 복제)와 PITR(시점 복구)의 기반이기도 하다.

## 저장 구조

- 테이블은 **힙(heap)** 파일. 8KB **페이지** 단위. 행(튜플)은 페이지 안에 저장되고 `ctid`(페이지번호, 슬롯) 로 위치 식별.
- 큰 값(수 KB 이상)은 **TOAST** 테이블로 분리 저장·압축.
- 인덱스는 별도 파일 (B-tree 기본).
- 데이터 디렉터리: `base/<db oid>/<relfilenode>`.

```sql
SELECT pg_relation_filepath('users');
SELECT ctid, * FROM users LIMIT 3;
SELECT pg_size_pretty(pg_total_relation_size('users'));
```

## 주요 설정

| 설정 | 의미 | 가이드 |
|---|---|---|
| `shared_buffers` | 페이지 캐시 | RAM 의 25% 정도 |
| `work_mem` | 정렬·해시 작업당 메모리 | 쿼리×커넥션 수만큼 곱해진다, 조심 |
| `effective_cache_size` | 옵티마이저가 가정하는 OS 캐시 | RAM 의 50~75% |
| `max_connections` | 백엔드 수 상한 | 풀러 쓰면 100~200 |
| `wal_level` | minimal / replica / logical | 복제·CDC 하려면 replica 이상 |
| `synchronous_commit` | 커밋 시 WAL fsync 대기 | off 면 빠르지만 크래시 시 최근 커밋 유실 |

```sql
SHOW shared_buffers;
SELECT name, setting, unit FROM pg_settings WHERE name IN ('work_mem','max_connections');
ALTER SYSTEM SET work_mem = '64MB'; SELECT pg_reload_conf();
```

## 시스템 카탈로그와 통계 뷰

```sql
\dt                       -- 테이블 (psql 메타 명령)
\d+ users                 -- 구조, 인덱스, 크기
SELECT * FROM pg_stat_activity;          -- 현재 세션, 상태, 대기 이벤트
SELECT * FROM pg_stat_user_tables;       -- 테이블별 seq/idx scan 수, dead tuple
SELECT * FROM pg_stat_user_indexes;      -- 안 쓰는 인덱스 찾기 (idx_scan=0)
SELECT * FROM pg_locks;                   -- 잠금
```

## psql 필수

```
pnpm pg:cli                 # docker compose exec postgres psql -U study -d study
\l  \c study  \dt  \d users  \di  \x (확장 출력)  \timing  \q
\e  (에디터)   \i file.sql   \copy users TO 'users.csv' CSV HEADER
```

## 이 노트 시리즈의 실습

```bash
pnpm pg:up          # postgres:16-alpine, 호스트 15432, study/study
pnpm pg:cli
```

실험실은 `pg` 라이브러리로 두세 커넥션을 열어 EXPLAIN, 격리 수준, 잠금, 데드락을 재현한다.

## 쿼리 한 개가 지나가는 길

`SELECT * FROM users WHERE email = $1` 하나가 결과가 되기까지 PostgreSQL 안에서는 다섯 단계를 거친다.

```
클라이언트 ──(TCP/소켓, 프로토콜 메시지)──▶ 백엔드 프로세스
  1. Parser      SQL 문자열 → 파스 트리 (문법 검사)
  2. Analyzer    카탈로그 조회: users 가 있나? 컬럼 타입은? → 쿼리 트리
  3. Rewriter    뷰·규칙(RULE) 펼치기
  4. Planner     가능한 실행 계획들의 비용 추정 → 가장 싼 계획 선택
  5. Executor    계획 트리를 실행: 버퍼에서 페이지 읽기, 필터, 결과 반환
```

![PostgreSQL 쿼리 처리 파이프라인](/diagrams/pg-query-pipeline.svg)

| 단계 | 느려지는 경우 | 확인 |
|---|---|---|
| 파싱·분석 | 거의 없음(수십 µs). 단 거대한 IN 리스트, 수천 파티션 | `Planning Time` 일부 |
| 플래닝 | 조인 테이블이 많을 때(10개 이상은 유전 알고리즘 GEQO), 파티션 수천 개 | `EXPLAIN` 의 `Planning Time` |
| 실행 | 대부분의 경우 | `EXPLAIN ANALYZE` 의 `Execution Time` |

**Prepared statement** 는 1~3단계를 한 번만 하고 재사용한다. 처음 5번은 매개변수마다 **커스텀 계획**을 만들고, 그 뒤 일반(generic) 계획이 비용상 비슷하면 그것을 고정한다. 매개변수에 따라 최적 계획이 크게 다른 쿼리(편향된 데이터)에서 이 전환이 갑자기 느려지는 원인이 되기도 한다(`plan_cache_mode` 로 제어).

## 왜 커넥션이 비싼가 — 프로세스 모델 다시 보기

```sql
SELECT pid, backend_type, state, backend_start FROM pg_stat_activity ORDER BY backend_type;
--  pid  | backend_type          | state  |
--  101  | checkpointer          |        |
--  102  | background writer     |        |
--  103  | walwriter             |        |
--  104  | autovacuum launcher   |        |
--  105  | logical replication launcher |  |
--  240  | client backend        | idle   |   ← 커넥션 하나 = 프로세스 하나
```

새 커넥션마다 postmaster 가 `fork()` 하고, 백엔드는 카탈로그 캐시를 처음부터 채운다. 그래서:

| 항목 | 대략 값 | 결과 |
|---|---|---|
| 커넥션 수립(TCP+인증+fork) | 수 ms(TLS 면 더) | 요청마다 연결하면 지연이 쿼리보다 큼 |
| 백엔드당 메모리 | 수 MB(+ `work_mem` × 정렬/해시 노드 수) | 커넥션 1000개 = GB 단위 |
| 문맥 교환·스냅샷 계산 | 커넥션 수에 비례 | 활성 커넥션이 코어 수의 몇 배를 넘으면 처리량 감소 |

그래서 **앱 쪽 풀 + 필요하면 PgBouncer** 가 기본이다. 풀 크기의 출발점은 `코어 수 × 2 + 디스크 수` 근처이고, 그보다 크게 잡으면 대기열만 DB 안으로 옮겨 놓은 셈이다 — [데이터 접근 병목](/performance/notes/05-data-access-bottlenecks). 실험 `chaos-pg-connection-exhaustion` 이 풀이 바닥났을 때 무슨 일이 생기는지 재현한다.

## 메모리 구조: 공유 버퍼와 OS 캐시의 이중 캐싱

```
          ┌──────── 백엔드 프로세스(각자) ────────┐
          │ work_mem(정렬·해시), temp_buffers     │
          └───────────────┬───────────────────────┘
                          ▼
     shared_buffers (공유 메모리, 8KB 페이지 배열 + 버퍼 매핑 해시)
                          ▼ 미스
     OS 페이지 캐시 (커널)        ← effective_cache_size 는 "여기까지 합쳐 이 정도 캐시가 있다" 는 힌트
                          ▼ 미스
     디스크
```

PostgreSQL 은 데이터 파일을 **일반 read/write 로** 읽는다(O_DIRECT 아님). 그래서 같은 페이지가 shared_buffers 와 OS 페이지 캐시에 두 번 있을 수 있다. shared_buffers 를 RAM 의 25% 로 권하는 이유가 이것이다: 너무 크게 잡으면 OS 캐시와 겹치는 낭비가 커지고 체크포인트 때 쓸 더티 페이지도 많아진다. 버퍼 교체 정책(clock-sweep)과 페이지 구조는 [B-tree 와 버퍼 풀](/db-internals/notes/02-btree-pages-buffer-pool), OS 쪽은 [가상 메모리와 페이지 캐시](/os-internals/notes/02-virtual-memory-page-cache).

```sql
CREATE EXTENSION IF NOT EXISTS pg_buffercache;
SELECT c.relname, count(*) AS buffers, pg_size_pretty(count(*) * 8192) AS size
FROM pg_buffercache b JOIN pg_class c ON b.relfilenode = pg_relation_filenode(c.oid)
GROUP BY c.relname ORDER BY buffers DESC LIMIT 5;   -- 지금 캐시를 누가 차지하나
```

## 커밋이 "끝났다" 는 것의 의미

```
UPDATE … ; COMMIT;
 1) 변경을 shared_buffers 의 페이지에 적용(더티 표시)
 2) WAL 레코드를 WAL 버퍼에 기록
 3) COMMIT 레코드까지 WAL 파일에 write + fsync    ← synchronous_commit=on 이면 여기까지 기다림
 4) 클라이언트에 "COMMIT" 응답
 (나중) checkpointer/bgwriter 가 더티 페이지를 데이터 파일에 씀
```

커밋 지연의 대부분은 3)의 **fsync** 다. 동시에 커밋하는 트랜잭션들은 한 번의 fsync 를 공유한다(그룹 커밋). `synchronous_commit=off` 는 3)을 기다리지 않아 빠르지만 크래시 시 최근 수백 ms 의 커밋을 잃는다(데이터 손상은 아님). 실험 `dbi-wal-vs-aof` 가 이 설정을 바꿔 가며 커밋 지연을 재고 Redis AOF 와 비교한다 — [WAL·체크포인트·복구](/db-internals/notes/04-wal-checkpoint-recovery).

## 대기 이벤트 — "지금 무엇을 기다리나"

`pg_stat_activity.wait_event_type/wait_event` 는 PostgreSQL 성능 진단의 출발점이다.

| wait_event_type | 예 | 의미 |
|---|---|---|
| (NULL, state=active) | — | CPU 에서 실행 중 |
| Lock | `transactionid`, `tuple`, `relation` | 다른 트랜잭션의 잠금 대기 → [잠금과 데드락](/postgres/notes/04-locks-deadlocks) |
| LWLock | `BufferMapping`, `WALWrite` | 내부 경량 락 경합(버퍼·WAL) |
| IO | `DataFileRead`, `WALSync` | 디스크 읽기·fsync 대기 |
| Client | `ClientRead` | 클라이언트가 다음 명령을 안 보냄(`idle in transaction` 이면 위험) |
| IPC | `BgWorkerShutdown` 등 | 프로세스 간 통신 |

```sql
SELECT wait_event_type, wait_event, count(*) FROM pg_stat_activity
WHERE state <> 'idle' GROUP BY 1,2 ORDER BY 3 DESC;
```

이 질의를 1초마다 샘플링해 쌓으면 "DB 시간이 어디에 쓰이는가" 그래프(Active Session History)가 된다. 관측 스택에 postgres_exporter 를 붙이면 Grafana 에서 볼 수 있다.

## 예시로 보기 — 이 프로젝트의 PostgreSQL

`docker-compose.yml` 의 `postgres` 서비스는 학습용 설정을 담고 있다.

| 설정 | 값 | 이유 |
|---|---|---|
| 이미지 | `pgvector/pgvector:pg16` | PostgreSQL 16 + 벡터 확장 → [JSONB·전문검색·pgvector](/postgres/notes/08-jsonb-fulltext-pgvector) |
| 포트 | `127.0.0.1:15432` | 기본 5432 와 충돌 회피, 루프백만 |
| `wal_level=logical` | 논리 복제 | Debezium CDC 실험 → [CDC 와 Outbox](/kafka/notes/08-cdc-outbox-debezium) |
| `shared_preload_libraries=pg_stat_statements` | 쿼리 통계 | [운영](/postgres/notes/05-operations) 의 느린 쿼리 찾기 |
| healthcheck | `pg_isready -U study -d study` | compose 의 `service_healthy` |
| 볼륨 | `pg-data` | 컨테이너 재생성에도 데이터 유지 |

```bash
pnpm pg:cli
study=# SHOW wal_level; SHOW shared_buffers; SELECT extname, extversion FROM pg_extension;
```

실험실의 PostgreSQL 실험은 `pg` 클라이언트로 여러 커넥션을 열어 이 시리즈의 개념을 실제로 재현한다: 실행 계획(`pg-index-explain`), 격리 수준(`pg-transaction-isolation`), 잠금·데드락(`pg-row-locks`, `pg-deadlock`), 파티션 프루닝·키셋 페이지네이션·벡터 검색.

## 운영·관측 포인트

- **커넥션 상태 분포**(active / idle / idle in transaction)와 대기 이벤트 분포를 같이 본다. idle in transaction 이 오래 있으면 VACUUM 이 막힌다.
- 캐시 히트율 99% 미만이 지속되면 working set 이 메모리를 넘었거나, 큰 Seq Scan 이 캐시를 쓸어내고 있다.
- 체크포인트 빈도(`pg_stat_bgwriter`/`pg_stat_checkpointer`의 requested 비율)가 높으면 `max_wal_size` 가 작다.

## 실습 체크리스트

- [ ] `pg_stat_activity` 로 백그라운드 프로세스 종류와 내 커넥션의 pid 확인
- [ ] `pg_buffercache` 로 지금 shared_buffers 를 차지한 테이블 상위 5개 보기
- [ ] 대기 이벤트 집계 질의를 실험(`pg-row-locks`) 중에 실행해 Lock 대기 관찰

## 관련 노트

- [인덱스와 실행 계획](/postgres/notes/02-indexes-explain)
- [Redis 영속성 — RDB 와 AOF](/redis/notes/04-persistence) — WAL 과 AOF 의 비교
- [Docker 볼륨](/docker/notes/04-volumes-networks) — pg-data 볼륨
