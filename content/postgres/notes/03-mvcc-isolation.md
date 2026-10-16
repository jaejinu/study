---
title: MVCC 와 트랜잭션 격리
order: 3
level: 중급
summary: 버전 체인과 스냅샷, 격리 수준별로 막히는 이상 현상, VACUUM 이 필요한 이유, 트랜잭션 ID 랩어라운드
tags: [MVCC, 격리수준, 스냅샷, VACUUM, xmin, 트랜잭션]
experiments: [pg-transaction-isolation]
---

## MVCC: 덮어쓰지 않고 새 버전을 만든다

UPDATE 는 기존 행을 고치지 않고 **새 튜플**을 쓴다. 각 튜플엔 `xmin`(만든 트랜잭션 ID) 과 `xmax`(지운/갱신한 트랜잭션 ID) 가 있다.
트랜잭션은 시작 시점의 **스냅샷**("이 xid 들은 커밋됨") 으로 어떤 버전이 보이는지 판단한다.

```sql
SELECT xmin, xmax, ctid, * FROM acct;
```

결과: **읽기는 쓰기를 막지 않고, 쓰기는 읽기를 막지 않는다.** 같은 행을 쓰려는 둘만 충돌한다.
대가: 옛 버전(dead tuple)이 쌓인다 → **VACUUM**.

## 격리 수준과 이상 현상

| 이상 현상 | READ COMMITTED (기본) | REPEATABLE READ | SERIALIZABLE |
|---|---|---|---|
| Dirty read | 불가 | 불가 | 불가 |
| Non-repeatable read (같은 행 재조회 시 값 바뀜) | **가능** | 불가 | 불가 |
| Phantom read (같은 조건 재조회 시 행 수 바뀜) | **가능** | 불가 (PG 는 막음) | 불가 |
| Serialization anomaly (write skew 등) | 가능 | **가능** | 불가 |

- **READ COMMITTED**: 문장마다 새 스냅샷. 대부분의 웹 앱 기본.
- **REPEATABLE READ**: 트랜잭션 시작 스냅샷 고정. 다른 트랜잭션이 바꾼 행을 갱신하려 하면 `could not serialize access due to concurrent update` → 재시도. 리포트·일관된 읽기에.
- **SERIALIZABLE**: SSI(직렬화 가능 스냅샷 격리)로 write skew 까지 감지. 충돌 시 `40001` 에러 → **재시도 루프 필수**. 잠금 없이 정확성을 얻는 대신 abort 가 늘 수 있다.

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET default_transaction_isolation = 'serializable';
```

## Write skew 예

"당직 의사 2명 중 최소 1명은 남아야 한다": 두 트랜잭션이 각각 "현재 2명이네" 를 읽고 자기만 빠진다 → 0명. REPEATABLE READ 로는 못 막고(서로 다른 행을 갱신), SERIALIZABLE 이나 명시적 잠금(`SELECT ... FOR UPDATE` 로 둘 다 잠그기)이 필요하다.

## VACUUM

- dead tuple 공간 회수(재사용 가능 표시), visibility map 갱신(Index Only Scan 에 필요), 통계 갱신(`ANALYZE`), **xid 랩어라운드 방지**.
- **autovacuum** 이 기본으로 돈다. 큰 테이블은 임계값(`autovacuum_vacuum_scale_factor` 기본 20%)을 낮춰 더 자주.
- `VACUUM FULL` 은 테이블을 다시 써서 공간을 OS 에 돌려주지만 **배타 잠금** → 운영 중엔 `pg_repack`.

```sql
SELECT relname, n_dead_tup, n_live_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC;
VACUUM (VERBOSE, ANALYZE) users;
```

오래 열린 트랜잭션(`idle in transaction`)은 그 스냅샷이 필요한 dead tuple 을 VACUUM 이 못 지우게 막는다 → bloat. `idle_in_transaction_session_timeout` 설정.

## 트랜잭션 ID 랩어라운드

xid 는 32비트 순환. 20억 트랜잭션이 지나면 과거가 미래로 보이는 문제 → VACUUM 이 오래된 튜플을 **freeze** 한다. autovacuum 을 끄거나 막아 두면 결국 DB 가 쓰기를 거부한다. `age(datfrozenxid)` 를 모니터링.

## 실습 체크리스트

- [ ] 두 세션으로 non-repeatable read 재현 (실험실)
- [ ] REPEATABLE READ 에서 갱신 충돌 에러 재현
- [ ] `SELECT xmin, xmax, ctid` 로 UPDATE 전후 튜플 위치 변화 보기
- [ ] `pg_stat_user_tables` 에서 dead tuple 수 보고 VACUUM 후 변화 확인
