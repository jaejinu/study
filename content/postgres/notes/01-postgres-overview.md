---
title: PostgreSQL 아키텍처 한눈에
order: 1
level: 기초
summary: 프로세스 모델, 공유 버퍼와 WAL, 저장 구조(힙·페이지·TOAST), 시스템 카탈로그, 기본 명령
tags: [개요, 아키텍처, WAL, shared_buffers, psql]
experiments: []
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
