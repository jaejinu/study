---
title: 운영 — 백업, 복제, 커넥션 풀, 모니터링
order: 5
level: 심화
summary: pg_dump 와 PITR, 스트리밍·논리 복제, PgBouncer, 느린 쿼리 찾기(pg_stat_statements), 흔한 장애
tags: [백업, PITR, 복제, PgBouncer, pg_stat_statements, 운영]
experiments: [chaos-pg-connection-exhaustion, cdc-outbox-debezium]
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

## 백업 전략 고르기 — RPO 와 RTO 로

백업은 도구가 아니라 **"얼마나 잃어도 되나(RPO)" 와 "얼마나 빨리 돌아와야 하나(RTO)"** 로 고른다.

| 방식 | RPO | RTO(100GB 기준 감) | 비고 |
|---|---|---|---|
| 매일 `pg_dump` | 최대 24시간 | 수십 분~수 시간(인덱스 재생성 포함) | 단순, 버전 간 이동 |
| 물리 베이스백업 + WAL 아카이브(PITR) | 수 초~분(아카이브 주기) | 베이스 복원 + WAL 재생 시간 | 운영 표준 |
| 스트리밍 복제 스탠바이 승격 | 비동기: 수 초, 동기: 0 | 수 초~분 | **백업이 아님**(실수도 복제됨) |
| 지연 복제(`recovery_min_apply_delay=1h`) | 실수 1시간 안에 발견 시 0 | 분 | 사람 실수 대비 |

"복제가 있으니 백업은 됐다" 는 착각이 가장 흔한 사고 원인이다. `DROP TABLE` 은 스탠바이에도 수 ms 만에 복제된다.

### PITR 복원 연습 절차

```bash
# 1) 베이스백업 (실행 중에 가능)
pg_basebackup -D /backup/base -Ft -z -X stream -P
# 2) 사고: 14:03 에 실수로 DELETE
# 3) 새 데이터 디렉터리에 베이스 풀고, 복구 목표 설정
cat >> postgresql.auto.conf <<'CONF'
restore_command = 'cp /backup/wal/%f %p'
recovery_target_time = '2026-10-17 14:02:59'
recovery_target_action = 'pause'      # 목표에서 멈추고 확인
CONF
touch recovery.signal && pg_ctl start
# 4) 확인 후 SELECT pg_wal_replay_resume(); 또는 필요한 테이블만 덤프해 원본에 복원
```

## 복제의 내부 — WAL 송신자와 수신자

```
primary:  백엔드 → WAL 버퍼 → WAL 파일 ─▶ walsender ──TCP──▶ walreceiver ─▶ standby WAL 파일 ─▶ startup 프로세스가 재생
                                            ▲ 복제 슬롯: "이 스탠바이는 여기(LSN)까지 받았다" 를 primary 가 기억
```

`pg_stat_replication` 의 LSN 4개가 지연이 **어느 구간**에 있는지 알려 준다.

| 컬럼 | 의미 | 여기서 막히면 |
|---|---|---|
| `sent_lsn` | primary 가 보낸 위치 | 네트워크 |
| `write_lsn` | 스탠바이가 OS 에 쓴 위치 | 스탠바이 I/O |
| `flush_lsn` | 스탠바이가 fsync 한 위치 | 스탠바이 디스크 |
| `replay_lsn` | 스탠바이가 재생한 위치 | 재생 충돌·긴 쿼리(hot standby) |

```sql
SELECT application_name, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_gap, replay_lag
FROM pg_stat_replication;
```

스탠바이에서 긴 쿼리가 돌면 재생이 그 쿼리가 보는 행을 지우려 할 때 충돌한다. `max_standby_streaming_delay` 만큼 기다렸다가 쿼리를 취소하거나(`canceling statement due to conflict with recovery`), `hot_standby_feedback=on` 으로 primary 의 VACUUM 을 늦춘다(대가: primary bloat).

### 복제 슬롯 — 유실 방지와 디스크 폭발의 양날

슬롯이 있으면 primary 는 스탠바이(또는 Debezium)가 받기 전까지 WAL 을 지우지 않는다. 받는 쪽이 멈추면 WAL 이 무한히 쌓인다.

```sql
SELECT slot_name, slot_type, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;
ALTER SYSTEM SET max_slot_wal_keep_size = '10GB';   -- 상한(넘으면 슬롯이 무효화됨)
```

이 프로젝트의 CDC 실험이 실험 끝에 슬롯을 반드시 지우는 이유다 — [CDC 와 Outbox](/kafka/notes/08-cdc-outbox-debezium).

## PgBouncer 풀 모드 비교

| 모드 | 서버 커넥션을 돌려받는 시점 | 깨지는 기능 |
|---|---|---|
| session | 클라이언트 연결 종료 | 없음(다중화 효과 작음) |
| transaction | 트랜잭션 종료 | 세션 `SET`, 세션 advisory lock, `LISTEN`, 임시 테이블, (1.21 이전) prepared statement |
| statement | 문장 종료 | 다문장 트랜잭션 불가 |

크기 잡기 예: 앱 Pod 20개 × 앱 풀 10 = 클라이언트 200 → PgBouncer `default_pool_size=20` → DB 서버 커넥션 20. 대기는 PgBouncer 큐에서 일어나고 DB 는 코어 수에 맞는 동시성만 받는다. PgBouncer 의 `SHOW POOLS;` 에서 `cl_waiting` 과 `maxwait` 가 늘면 풀이 작거나 쿼리가 느린 것이다.

## pg_stat_statements 를 제대로 읽기

```sql
SELECT queryid, calls,
       round(total_exec_time::numeric / 1000, 1) AS total_s,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 1) AS pct,
       rows / nullif(calls, 0) AS rows_per_call,
       round(100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       left(query, 60)
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
```

| 패턴 | 해석 |
|---|---|
| calls 매우 큼 + mean 작음 + pct 큼 | N+1·과도한 호출 → 앱에서 배치/캐시 |
| calls 작음 + mean 큼 | 무거운 단일 쿼리 → 계획·인덱스 |
| hit_pct 낮음 | 디스크 읽기 → 캐시 부족 또는 큰 스캔 |
| rows_per_call 큼 | 필요 이상 가져옴 → LIMIT·컬럼 줄이기 |

**총 시간(total)** 순으로 보는 것이 핵심이다. 평균이 빠르더라도 호출이 많으면 DB 시간의 대부분을 쓴다 — [데이터 접근 병목](/performance/notes/05-data-access-bottlenecks).

## 예시로 보기 — 이 프로젝트에서 연습하는 운영 작업

```bash
pnpm pg:up
# 논리 백업과 복원
docker exec study-postgres pg_dump -U study -Fc study > /tmp/study.dump
docker exec -i study-postgres pg_restore -U study -d postgres --create --clean < /tmp/study.dump
# 느린 쿼리 Top 10
docker exec -it study-postgres psql -U study -c "SELECT calls, round(mean_exec_time::numeric,2) ms, left(query,60) FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"
# 복제 슬롯 확인 (CDC 실험 후 남아 있으면 안 됨)
docker exec -it study-postgres psql -U study -c "SELECT slot_name, active FROM pg_replication_slots;"
```

장애 실험 `chaos-pg-connection-exhaustion` 은 `max_connections` 를 다 채워 새 연결이 `too many clients` 로 거부되는 상황과, 앱 풀이 그것을 어떻게 흡수(또는 실패)하는지 보여 준다. 관측은 postgres_exporter → Prometheus → Grafana 로 이어 붙일 수 있다 — [계측과 exporter](/observability/notes/03-instrumentation-exporters).

## 운영·관측 포인트

| 알림 | 조건(예) | 이유 |
|---|---|---|
| 복제 지연 | `replay_lag > 30s` 5분 | 읽기 복제본의 오래된 데이터, 장애 조치 시 유실 |
| 슬롯 보존 WAL | `retained > 5GB` | 디스크 폭발 전조 |
| xid age | `age(datfrozenxid) > 1e9` | 랩어라운드 위험 |
| 커넥션 사용률 | `numbackends / max_connections > 0.8` | 고갈 직전 |
| 체크포인트 강제 비율 | requested 비율 상승 | `max_wal_size` 부족 → I/O 스파이크 |

## 실습 체크리스트

- [ ] `pg_dump -Fc` → `pg_restore --create` 로 이 프로젝트 DB 복원 연습(복원 시간 기록)
- [ ] `pg_stat_statements` 를 total 기준으로 정렬해 Top 3 쿼리의 hit_pct·rows_per_call 해석
- [ ] CDC 실험 전후 `pg_replication_slots` 확인 — 슬롯이 남지 않는지
