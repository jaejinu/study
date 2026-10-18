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

## 테이블 잠금 8단계 — 무엇이 무엇을 막나

DDL 사고를 이해하려면 테이블 수준 잠금 모드의 충돌표가 필요하다. 약한 것부터:

| 잠금 모드 | 잡는 문장(예) | 충돌하는 것(요약) |
|---|---|---|
| ACCESS SHARE | `SELECT` | ACCESS EXCLUSIVE 만 |
| ROW SHARE | `SELECT FOR UPDATE/SHARE` | EXCLUSIVE, ACCESS EXCLUSIVE |
| ROW EXCLUSIVE | `INSERT`, `UPDATE`, `DELETE` | SHARE 이상 |
| SHARE UPDATE EXCLUSIVE | `VACUUM`(일반), `ANALYZE`, `CREATE INDEX CONCURRENTLY` | 자기 자신 이상(같은 테이블 VACUUM 둘 불가) |
| SHARE | `CREATE INDEX`(일반) | ROW EXCLUSIVE(쓰기) 이상 → **쓰기 전부 대기** |
| SHARE ROW EXCLUSIVE | 일부 트리거·제약 | |
| EXCLUSIVE | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | 읽기 외 전부 |
| ACCESS EXCLUSIVE | `ALTER TABLE`(대부분), `DROP`, `TRUNCATE`, `VACUUM FULL` | **SELECT 까지 전부** |

### 잠금 큐 사고 — 가장 흔한 운영 장애

```
10:00:00  긴 리포트 쿼리 시작           ACCESS SHARE 획득 (5분 걸림)
10:00:10  배포: ALTER TABLE users ADD … ACCESS EXCLUSIVE 요청 → 리포트 때문에 대기
10:00:11  일반 SELECT 들                ACCESS SHARE 요청 → 큐의 ALTER 뒤에 줄 섬 → 대기
...       커넥션 풀 고갈, 서비스 전체 응답 없음 (리포트가 끝나는 10:05 까지)
```

ALTER 자체는 1ms 짜리 메타데이터 변경이었다. 문제는 **큐에서 기다리는 동안 뒤에 온 모든 쿼리를 막은 것**이다. 그래서 마이그레이션에는 항상:

```sql
SET lock_timeout = '3s';          -- 3초 안에 못 잡으면 포기(재시도)
SET statement_timeout = '30s';
ALTER TABLE users ADD COLUMN nickname text;
```

그리고 재시도 루프를 둔다. "잠깐 못 잡고 실패" 가 "5분 전체 장애" 보다 훨씬 낫다.

## 행 잠금은 어디에 저장되나

수백만 행을 `FOR UPDATE` 해도 공유 메모리의 잠금 테이블이 넘치지 않는 이유: **행 잠금은 튜플 헤더에 기록**된다. 잠근 트랜잭션의 xid 를 튜플의 `xmax` 에 쓰고 플래그를 세운다. 다른 트랜잭션은 튜플을 보다가 "이 xmax 트랜잭션이 아직 진행 중" 이면 **그 트랜잭션 ID 자체**에 대한 잠금을 기다린다.

```sql
-- 세션 A: BEGIN; SELECT * FROM stock WHERE id = 1 FOR UPDATE;
-- 세션 B: UPDATE stock SET qty = qty - 1 WHERE id = 1;   (대기)
SELECT locktype, transactionid, mode, granted, pid FROM pg_locks WHERE locktype IN ('transactionid','tuple');
--  transactionid | 1203 | ExclusiveLock | t | A   ← A 가 자기 xid 를 쥠
--  transactionid | 1203 | ShareLock     | f | B   ← B 는 A 의 xid 가 끝나길 대기
--  tuple         |      | ExclusiveLock | t | B   ← 큐 순서용 튜플 잠금
```

그래서 `pg_locks` 에서 행 잠금 대기는 `relation` 이 아니라 **`transactionid` 대기**로 보인다. 부작용: 잠금이 튜플 헤더 쓰기이므로 `SELECT FOR UPDATE` 도 페이지를 더티로 만들고 WAL 을 남긴다.

## 데드락 탐지의 실제

`deadlock_timeout`(기본 1초) 동안 잠금을 못 잡은 백엔드가 **그때서야** 대기 그래프를 검사한다. 매번 검사하면 비싸기 때문이다.

```
ERROR:  deadlock detected
DETAIL:  Process 2301 waits for ShareLock on transaction 1204; blocked by process 2302.
         Process 2302 waits for ShareLock on transaction 1203; blocked by process 2301.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (0,7) in relation "acct"
```

- 사이클을 찾은 쪽(검사를 수행한 백엔드)이 희생된다. 그래서 데드락 에러는 **약 1초 지연 후** 난다.
- 서버 로그에 양쪽 쿼리가 다 남는다(`log_lock_waits=on` 이면 대기도).
- 앱은 SQLSTATE `40P01` 을 받으면 트랜잭션 전체를 재시도한다.

실험 `pg-deadlock` 이 반대 순서 갱신으로 이 에러를 만들고, 순서를 맞춰 사라지는 것까지 보여 준다. 데드락은 분산 시스템의 "자원 순서" 문제와 같은 구조다 — [분산 트랜잭션과 코디네이션](/distributed-systems/notes/06-transactions-coordination).

## SKIP LOCKED 큐의 성능 특성

| 측면 | 동작 | 주의 |
|---|---|---|
| 처리량 | 워커 수만큼 병렬 | `ORDER BY created_at` 에 인덱스 필수(없으면 매번 정렬) |
| 순서 | 대략적인 FIFO | 엄격한 순서는 보장 안 됨(잠긴 행을 건너뛰므로) |
| 실패 처리 | 롤백 시 자동으로 다시 보임 | 독 메시지는 `attempts` 컬럼으로 상한 |
| bloat | 처리된 행을 UPDATE/DELETE → dead tuple | 완료 행은 삭제 + autovacuum 공격적으로, 또는 파티션 단위 DROP |
| 대기 | 폴링 | `LISTEN/NOTIFY` 로 깨우기 |

브로커가 필요한지 판단할 때 이 표가 기준이 된다 — [메시징 비교 — Kafka 를 쓰지 말아야 할 때](/messaging/notes/05-when-not-kafka), [아웃박스와 사가](/architecture/notes/03-async-messaging-consistency).

## Advisory lock 의 함정

- **세션 수준**(`pg_advisory_lock`)은 트랜잭션 풀링(PgBouncer `transaction` 모드)과 함께 쓰면 안 된다. 다른 클라이언트가 같은 서버 커넥션을 이어받아 잠금이 "새는" 사고가 난다 → 트랜잭션 수준(`pg_advisory_xact_lock`)을 쓴다.
- 키는 `bigint` 하나 또는 `int` 둘. 문자열은 `hashtext()` 로 바꾸는데 충돌 가능성을 감수해야 한다.
- 분산 락으로 쓸 때도 펜싱 토큰 문제는 같다(잠금을 쥔 줄 알았는데 세션이 끊겨 있었다) — 실험 `ds-fencing-token`.

## 예시로 보기 — 실험 `pg-row-locks` 를 진단 질의로 읽기

실험이 세션 A 로 행을 잠그고 세션 B 를 기다리게 할 때, 다른 터미널에서 이 질의를 돌리면 누가 누구를 막는지 트리로 보인다.

```sql
WITH RECURSIVE w AS (
  SELECT pid, pg_blocking_pids(pid) AS blockers, left(query, 50) AS q, 0 AS depth
  FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0
)
SELECT pid, blockers, q, now() - query_start AS waiting FROM w JOIN pg_stat_activity USING (pid);
```

## 운영·관측 포인트

- 알림 후보: `pg_stat_activity` 에서 Lock 대기가 N초 이상인 세션 수, `idle in transaction` 이 M초 이상인 세션.
- `pg_stat_database.deadlocks` 카운터 증가율. 0 이 아니면 잠금 순서를 점검한다.
- 마이그레이션 도구(예: Flyway, Prisma migrate, sqitch)에 `lock_timeout` 기본값을 강제한다.

## 실전에서는 어디에 쓰이나

> 여러 요청·워커가 같은 행을 집거나 운영 중 스키마를 바꿀 때 잠금이 등장한다. 잘 쓰면 재고 차감·작업 큐가 단순해지고, 잘못 쓰면 마이그레이션 한 줄이 서비스 전체를 멈춘다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 재고 차감 | 동시 주문의 초과 판매 방지 | `SELECT … FOR UPDATE` 후 차감, 여러 행은 id 오름차순으로 잠금 | 선착순 같은 극단 트래픽은 Redis 원자 연산 + 비동기 반영 |
| 사내 백오피스 작업 큐 | 브로커 없이 워커 여러 개가 중복 없이 처리 | `FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY` 로 깨우기 | 처리량·팬아웃이 크면 Kafka·RabbitMQ |
| SaaS 무중단 배포 | `ALTER TABLE` 이 잠금 큐를 만들어 전체 장애 | `lock_timeout`·`statement_timeout` + 재시도, `CREATE INDEX CONCURRENTLY` | 큰 테이블은 단계적 변경(NOT VALID → VALIDATE) |
| 여러 인스턴스의 정기 배치 | 같은 일일 정산이 두 번 도는 것 | `pg_try_advisory_xact_lock(hashtext('job'))` | Redis 분산 락, k8s CronJob `concurrencyPolicy: Forbid` |
| 핀테크 계좌 간 이체 | 양방향 동시 이체의 데드락 | 계좌 id 순서로 잠그고 `40P01` 이면 트랜잭션 재시도 | 단일 문장 조건부 UPDATE 로 잠금 시간 축소 |

**이럴 땐 안 맞는다**
- 초당 수만 건 이상이거나 여러 소비자 그룹이 같은 이벤트를 받아야 하는 경우 → SKIP LOCKED 큐는 한 번 소비 모델이고 bloat 가 생긴다. 로그 기반 브로커(Kafka)로.
- PgBouncer transaction 모드에서 세션 수준 advisory lock → 잠금이 다른 클라이언트로 샌다. 트랜잭션 수준 잠금을 쓴다.

**누가 매일 만나나** — 백엔드 개발자가 마이그레이션 PR 을 쓸 때 `lock_timeout` 을 넣는 순간, SRE 가 "DB 응답 없음" 장애에서 `pg_blocking_pids` 로 막고 있는 세션을 찾을 때.

**면접·실무 단골 질문**
- Q. 1ms 짜리 `ALTER TABLE` 이 왜 서비스 장애를 내나? → ACCESS EXCLUSIVE 대기 뒤에 일반 SELECT 가 줄 서는 잠금 큐. `lock_timeout` + 재시도로 막는다.
- Q. 데드락 예방법은? → 항상 같은 순서로 잠그기, 한 문장으로 잠그기, 트랜잭션 짧게, `40P01` 재시도.

## 실습 체크리스트

- [ ] FOR UPDATE 로 막힌 세션을 `pg_stat_activity` 에서 찾고 `pg_blocking_pids` 확인 (실험실)
- [ ] `lock_timeout` 으로 대기 포기
- [ ] SKIP LOCKED 로 워커 2개가 다른 작업을 집는 것 확인
- [ ] 반대 순서 갱신으로 데드락을 만들고 에러 메시지 읽기, 같은 순서로 고쳐 사라지는지 확인
- [ ] 긴 SELECT 를 열어 둔 상태에서 `ALTER TABLE` 을 실행하고, 그 뒤 SELECT 가 막히는 잠금 큐 사고 재현 → `lock_timeout` 으로 해결
- [ ] 행 잠금 대기 중 `pg_locks` 에서 `transactionid` ShareLock 대기 확인
- [ ] 데드락 에러가 약 1초 뒤 나는 것을 `\timing` 으로 측정
