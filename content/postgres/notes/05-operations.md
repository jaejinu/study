---
title: 운영 — 백업, 복제, 커넥션 풀, 모니터링
order: 5
level: 심화
summary: pg_dump 와 PITR, 스트리밍·논리 복제, PgBouncer, 느린 쿼리 찾기(pg_stat_statements), 흔한 장애
tags: [백업, PITR, 복제, PgBouncer, pg_stat_statements, 운영]
experiments: []
---

## 백업

| 방법 | 특징 |
|---|---|
| `pg_dump` | 논리 백업(SQL/커스텀 포맷). 단일 DB, 버전 간 이동 가능, 느림 |
| `pg_dumpall` | 전체 클러스터 + 롤·설정 |
| `pg_basebackup` + WAL 아카이브 | 물리 백업. **PITR**(임의 시점 복구) 가능 |
| pgBackRest / WAL-G | 증분·압축·S3, 운영 표준 |

```bash
pg_dump -Fc -U study study > study.dump          # 커스텀 포맷 (병렬 복원 가능)
pg_restore -d study -j 4 study.dump
docker compose exec postgres pg_dump -U study study | gzip > backup.sql.gz
```

PITR: `archive_mode=on`, `archive_command` 로 WAL 을 보관하고, 복구 시 `restore_command` + `recovery_target_time`. "어제 14:03 에 잘못 지운 테이블" 을 되살리는 유일한 방법.

**백업은 복원 연습을 해 봐야 백업이다.**

## 복제

- **스트리밍 복제**(물리): WAL 을 스탠바이로 실시간 전송. 스탠바이는 읽기 전용(hot standby). 전체 클러스터 복제, 같은 메이저 버전.
  - 비동기(기본) / 동기(`synchronous_standby_names`): 동기는 커밋 지연 ↑, 유실 0.
  - 장애 조치는 Patroni, repmgr, 클라우드 관리형이 담당.
- **논리 복제**: `PUBLICATION`/`SUBSCRIPTION` 으로 테이블 단위 전송. 버전 간, 일부 테이블만, 다른 DB 로. CDC(Debezium) 도 `wal_level=logical` 의 복제 슬롯을 쓴다.

```sql
SELECT * FROM pg_stat_replication;         -- primary 에서
SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn();   -- standby 에서
SELECT * FROM pg_replication_slots;         -- 슬롯이 쌓이면 WAL 디스크 폭발 주의
```

## 커넥션 풀: PgBouncer

백엔드 프로세스는 비싸다. 앱 서버 수십 대 × 풀 20 = 수백 커넥션 → PgBouncer 가 수천 클라이언트 커넥션을 수십 개 서버 커넥션으로 다중화.
- `pool_mode=transaction` 이 보통. 단, 세션 상태(`SET`, prepared statement, advisory lock)를 쓰면 주의.
- 앱 쪽 풀(pg-pool, HikariCP)과 조합.

## 느린 쿼리 찾기

```sql
CREATE EXTENSION pg_stat_statements;   -- shared_preload_libraries 에 추가 필요
SELECT calls, round(mean_exec_time::numeric,2) ms, round(total_exec_time::numeric) total, left(query,80)
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
```

- `log_min_duration_statement = 500` : 500ms 넘는 쿼리를 로그에.
- `auto_explain` 확장: 느린 쿼리의 계획을 자동 로깅.
- N+1 은 DB 가 아니라 앱에서 보인다 → 앱 APM 과 함께.

## 모니터링 지표

- 커넥션 수 / `max_connections`, `idle in transaction` 세션
- 캐시 히트율: `pg_stat_database.blks_hit / (blks_hit + blks_read)` (99% 근처가 정상)
- dead tuple, 마지막 autovacuum 시각
- 복제 지연 (`pg_stat_replication.replay_lag`)
- 디스크, WAL 크기, 복제 슬롯 지연
- 트랜잭션 ID age (`age(datfrozenxid)` < 10억)
- postgres_exporter + Grafana 대시보드 (관측성 노트)

## 흔한 장애와 대응

| 증상 | 원인 | 대응 |
|---|---|---|
| `too many connections` | 풀 없이 커넥션 폭주 | PgBouncer, `max_connections` 재검토 |
| 갑자기 느려짐 | 통계 낡음, bloat, 잠금 대기 | `ANALYZE`, `pg_stat_activity` 잠금, VACUUM |
| 디스크 꽉 참 | WAL 아카이브 실패, 복제 슬롯 방치, 로그 | 아카이브 복구, 슬롯 삭제 |
| 마이그레이션이 서비스 멈춤 | DDL 잠금 | `lock_timeout`, CONCURRENTLY, 단계적 변경 |
| 쓰기 거부 "wraparound" | VACUUM 실패 누적 | 긴급 VACUUM, autovacuum 설정 |

## 더 공부할 것

- "The Internals of PostgreSQL" (interdb.jp) — 무료, 깊이 있음
- "PostgreSQL 14 Internals" (Rogov)
- pgMustard / explain.dalibo.com — EXPLAIN 시각화
- 확장: PostGIS, pgvector, TimescaleDB, pg_partman(파티셔닝)
