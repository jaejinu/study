---
title: 잠금과 데드락
order: 4
level: 중급
summary: 행·테이블 잠금 모드, 잠금 대기 진단(pg_locks, pg_stat_activity), lock_timeout, SKIP LOCKED 큐, 데드락 예방
tags: [잠금, FOR UPDATE, SKIP LOCKED, 데드락, pg_locks, DDL]
experiments: [pg-row-locks, pg-deadlock]
---

## 행 잠금

| 문장 | 잠금 | 막는 것 |
|---|---|---|
| `UPDATE` / `DELETE` | FOR UPDATE (배타) | 같은 행의 UPDATE/DELETE/FOR UPDATE |
| `SELECT ... FOR UPDATE` | 배타 | 위와 같음. 읽고-갱신 사이 변경 방지 |
| `SELECT ... FOR NO KEY UPDATE` | 약한 배타 | 키 변경·삭제만 막음 (FK 참조와 공존) |
| `SELECT ... FOR SHARE` | 공유 | 갱신·삭제만 막고 다른 FOR SHARE 는 허용 |

일반 `SELECT` 는 아무 행 잠금도 잡지 않는다 (MVCC).

```sql
SELECT * FROM stock WHERE id = 1 FOR UPDATE;          -- 커밋까지 대기
SELECT * FROM stock WHERE id = 1 FOR UPDATE NOWAIT;   -- 잠겨 있으면 즉시 에러
SELECT * FROM stock WHERE id = 1 FOR UPDATE SKIP LOCKED;   -- 잠긴 행은 건너뜀
SET lock_timeout = '2s';                              -- 대기 상한
```

## 잠금 대기 진단

```sql
-- 누가 누구를 막고 있나
SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by, left(query, 80)
FROM pg_stat_activity WHERE wait_event_type = 'Lock';

-- 잠금 목록
SELECT locktype, relation::regclass, mode, granted, pid FROM pg_locks WHERE NOT granted;

-- 막고 있는 세션 끊기
SELECT pg_cancel_backend(1234);     -- 쿼리 취소
SELECT pg_terminate_backend(1234);  -- 세션 종료
```

`log_lock_waits = on` 이면 `deadlock_timeout`(1초) 이상 기다린 잠금이 로그에 남는다.

## 테이블 잠금과 DDL

`ALTER TABLE`, `CREATE INDEX`(일반), `VACUUM FULL`, `TRUNCATE` 는 강한 테이블 잠금을 잡는다. 운영 중 큰 테이블에 실행하면 **모든 쿼리가 줄줄이 막힌다** (잠금 큐: 뒤에 온 SELECT 도 대기).
- `CREATE INDEX CONCURRENTLY`
- `ALTER TABLE ... ADD COLUMN ... DEFAULT` 는 PG11+ 에서 즉시 (메타데이터만)
- NOT NULL 추가, 타입 변경은 전체 재작성 → 단계적으로 (CHECK 제약 NOT VALID → VALIDATE)
- 마이그레이션 전에 `SET lock_timeout = '5s'` 로 무한 대기 방지

## SKIP LOCKED 작업 큐

```sql
BEGIN;
SELECT id, payload FROM jobs
 WHERE status = 'pending' ORDER BY created_at
 LIMIT 1 FOR UPDATE SKIP LOCKED;
-- 처리 ...
UPDATE jobs SET status = 'done' WHERE id = $1;
COMMIT;   -- 실패하면 ROLLBACK → 다시 pending 으로 보임
```

여러 워커가 동시에 돌려도 서로 다른 행을 집는다. 트랜잭션이 끝날 때까지 행이 잠겨 있어 "처리 중" 표시가 자동이다. 소규모 큐엔 Kafka 없이 이걸로 충분하다. 폴링 대신 `LISTEN/NOTIFY` 로 깨울 수 있다.

## 데드락

A 가 행 1 → 2, B 가 행 2 → 1 순서로 잠그면 서로 기다린다. PostgreSQL 은 `deadlock_timeout` 마다 대기 그래프의 사이클을 찾아 **한쪽을 abort** 한다 (`40P01 deadlock detected`). 애플리케이션은 재시도해야 한다.

예방:
1. **항상 같은 순서**로 잠근다 (ID 오름차순, 테이블 순서 고정).
2. 필요한 행을 한 문장에 잠근다: `SELECT ... WHERE id IN (1,2) ORDER BY id FOR UPDATE`.
3. 트랜잭션을 짧게. 사용자 입력을 기다리며 트랜잭션을 열어 두지 않기.
4. 외래키 참조 행 갱신 시 `FOR NO KEY UPDATE`.

## Advisory lock

행이 아닌 **임의의 숫자 키**에 거는 애플리케이션 잠금. 분산 락처럼 쓴다.

```sql
SELECT pg_advisory_lock(42);        -- 세션 수준, 명시적 unlock 필요
SELECT pg_try_advisory_xact_lock(hashtext('report:daily'));  -- 트랜잭션 끝나면 자동 해제, 즉시 true/false
```

## 실습 체크리스트

- [ ] FOR UPDATE 로 막힌 세션을 `pg_stat_activity` 에서 찾고 `pg_blocking_pids` 확인 (실험실)
- [ ] `lock_timeout` 으로 대기 포기
- [ ] SKIP LOCKED 로 워커 2개가 다른 작업을 집는 것 확인
- [ ] 반대 순서 갱신으로 데드락을 만들고 에러 메시지 읽기, 같은 순서로 고쳐 사라지는지 확인
