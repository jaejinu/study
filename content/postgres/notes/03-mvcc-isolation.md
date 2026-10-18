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

![MVCC 튜플 버전](/diagrams/pg-mvcc.svg)

### 예시로 보기: 잔액 이체에서 격리 수준 고르기

```sql
-- READ COMMITTED (기본) 로 안전하게: 행 잠금으로 직렬화
BEGIN;
SELECT balance FROM acct WHERE id = 1 FOR UPDATE;      -- 다른 이체는 여기서 대기
UPDATE acct SET balance = balance - 100 WHERE id = 1;
UPDATE acct SET balance = balance + 100 WHERE id = 2;
COMMIT;
-- 또는 조건부 갱신 한 문장으로 (잠금 짧게)
UPDATE acct SET balance = balance - 100 WHERE id = 1 AND balance >= 100;   -- 영향 행 0 이면 잔액 부족
```
"읽고 계산해서 쓰기" 를 `FOR UPDATE` 없이 하면 두 이체가 같은 잔액을 읽어 초과 인출이 난다 — 실험실의 **격리 수준**·**행 잠금** 실험이 두 세션으로 재현한다. 복잡한 불변식(당직 의사 ≥ 1)은 SERIALIZABLE + 재시도.

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

## 스냅샷의 정체 — xmin, xmax, xip

"이 트랜잭션에게 어떤 버전이 보이나" 는 **스냅샷** 하나로 결정된다.

```sql
SELECT pg_current_snapshot();     -- 예: 1050:1058:1052,1055
--                                    xmin:xmax:진행 중 xid 목록
```

| 구성 | 의미 |
|---|---|
| xmin(1050) | 이보다 작은 xid 는 모두 끝났다(커밋 또는 롤백) |
| xmax(1058) | 이 이상인 xid 는 아직 시작 안 했다 → 안 보임 |
| xip(1052,1055) | 이 사이에서 **아직 진행 중**인 xid → 안 보임 |

튜플 하나의 가시성 판단(단순화):

```
튜플의 xmin 이 "내 스냅샷 기준 커밋됨" 이고
  (xmax 가 없거나 / xmax 가 아직 커밋 안 됨 / xmax 가 내 스냅샷에서 안 보임)
이면 → 보인다
```

"커밋됐는지" 는 `pg_xact`(커밋 로그)를 봐야 알지만, 매번 보면 비싸므로 한 번 확인한 결과를 튜플 헤더의 **힌트 비트**에 기록한다. 그래서 대량 적재 직후 첫 SELECT 가 페이지를 **쓰는**(힌트 비트 설정) 의외의 현상이 생긴다 — 읽기 쿼리인데 WAL 과 더티 페이지가 생기는 이유다.

## UPDATE 한 번에 일어나는 일 — 직접 보기

```sql
CREATE EXTENSION IF NOT EXISTS pageinspect;
CREATE TABLE acct (id int PRIMARY KEY, balance int);
INSERT INTO acct VALUES (1, 1000);
SELECT ctid, xmin, xmax, * FROM acct;               -- (0,1) xmin=900 xmax=0
UPDATE acct SET balance = 900 WHERE id = 1;
SELECT ctid, xmin, xmax, * FROM acct;               -- (0,2) xmin=901 xmax=0   ← 새 위치
SELECT lp, t_xmin, t_xmax, t_ctid FROM heap_page_items(get_raw_page('acct', 0));
--  lp | t_xmin | t_xmax | t_ctid
--   1 |   900  |   901  | (0,2)    ← 옛 버전: 901 이 지웠고, 새 버전은 (0,2) 를 가리킴
--   2 |   901  |     0  | (0,2)    ← 새 버전
```

옛 튜플은 그 자리에 남아 `t_ctid` 로 새 버전을 가리킨다(버전 체인). VACUUM 이 "이제 아무 스냅샷에도 필요 없다" 고 판단해야 1번 슬롯이 재사용된다.

### HOT 업데이트 — 인덱스를 안 건드리는 갱신

인덱스가 걸린 컬럼을 바꾸지 않았고 **같은 페이지에 빈 공간**이 있으면, 새 버전을 같은 페이지에 두고 인덱스는 그대로 둔다(Heap-Only Tuple). 인덱스 항목은 여전히 첫 튜플을 가리키고 체인을 따라간다.

| | 일반 UPDATE | HOT UPDATE |
|---|---|---|
| 인덱스 갱신 | 모든 인덱스에 새 항목 | 없음 |
| 조건 | — | 인덱스 컬럼 불변 + 같은 페이지에 공간 |
| 효과 | 쓰기 증폭, 인덱스 bloat | 빠름, bloat 적음 |

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd, round(100.0*n_tup_hot_upd/nullif(n_tup_upd,0),1) AS hot_pct
FROM pg_stat_user_tables ORDER BY n_tup_upd DESC LIMIT 5;
ALTER TABLE acct SET (fillfactor = 80);   -- 페이지에 20% 여유를 둬 HOT 확률을 높임
```

자주 갱신되는 테이블에 `updated_at` 인덱스를 걸면 매 UPDATE 가 HOT 이 아니게 된다. 인덱스 하나가 쓰기 비용을 몇 배로 만드는 흔한 예다. MVCC 구현을 MySQL(undo 로그) 등과 비교한 내용은 [MVCC·GC 구현 비교](/db-internals/notes/06-mvcc-gc-comparison).

## READ COMMITTED 의 재검사 — 놀라운 동작

READ COMMITTED 에서 UPDATE 가 다른 트랜잭션이 잠근 행을 만나면, 그 트랜잭션이 커밋될 때까지 기다린 뒤 **최신 버전으로 WHERE 조건을 다시 검사**한다(EvalPlanQual).

```
T1: UPDATE acct SET balance = balance - 100 WHERE id = 1 AND balance >= 100;   (잠금 획득, 900→800 진행 중)
T2: UPDATE acct SET balance = balance - 850 WHERE id = 1 AND balance >= 850;   (T1 대기)
T1: COMMIT  (balance=800)
T2: 최신 버전(800)으로 조건 재검사 → 800 >= 850 거짓 → 0 행 갱신
```

그래서 "조건부 UPDATE 한 문장" 이 READ COMMITTED 에서도 안전한 잔액 차감이 된다. 반대로 SELECT 로 읽어 앱에서 계산 후 UPDATE 하면 재검사가 없어 초과 인출이 생긴다 — 실험 `pg-transaction-isolation`, `pg-row-locks` 가 두 세션으로 재현한다.

## SERIALIZABLE 은 어떻게 감지하나

SSI 는 트랜잭션 사이의 **읽기-쓰기 의존성(rw-antidependency)** 을 추적한다. "T1 이 읽은 것을 T2 가 썼고, T2 가 읽은 것을 T1 이 썼다" 같은 위험한 구조(연속된 두 rw 간선)가 생기면 하나를 abort 한다.

- 읽기도 **SIRead 잠금**(실제 대기 없는 표식)을 남긴다 → `pg_locks` 에 `SIReadLock` 으로 보인다.
- 인덱스로 읽은 범위는 인덱스 페이지 단위로, Seq Scan 은 테이블 전체로 추적 → **인덱스가 없으면 거짓 양성 abort 가 많아진다**.
- abort 는 `ERROR: could not serialize access due to read/write dependencies among transactions` (SQLSTATE 40001). 재시도하면 대부분 성공한다.

```js
// 재시도 루프 (node-postgres)
for (let i = 0; i < 5; i++) {
  try { await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); /* … */ await client.query("COMMIT"); break; }
  catch (e) { await client.query("ROLLBACK"); if (e.code !== "40001" || i === 4) throw e; await sleep(2 ** i * 10 + Math.random() * 10); }
}
```

이론 쪽 정의(선형화·직렬화 가능성·스냅샷 격리의 차이)는 [일관성 모델](/distributed-systems/notes/03-consistency-models).

## 예시로 보기 — 이 프로젝트의 실험과 대응

| 실험 | 재현하는 현상 | 이 노트의 개념 |
|---|---|---|
| `pg-transaction-isolation` | non-repeatable read(RC), 갱신 충돌(RR), write skew 감지(SERIALIZABLE) | 격리 수준 표, SSI |
| `pg-row-locks` | 읽고-쓰기 경쟁, `FOR UPDATE` 로 해결 | 재검사, 행 잠금 |
| `dbi-btree-pageinspect` | `pageinspect` 로 페이지 내부 보기 | heap_page_items 와 같은 도구 |

## 운영·관측 포인트

- `pg_stat_activity` 에서 `backend_xmin` 이 가장 오래된 세션이 VACUUM 의 "지평선" 이다. 오래 열린 트랜잭션·복제 슬롯·준비된 트랜잭션(2PC)이 범인이다.
  ```sql
  SELECT pid, state, age(backend_xmin) AS xmin_age, now()-xact_start AS xact_dur, left(query,60)
  FROM pg_stat_activity WHERE backend_xmin IS NOT NULL ORDER BY age(backend_xmin) DESC LIMIT 5;
  ```
- HOT 비율(`n_tup_hot_upd / n_tup_upd`)이 낮은 갱신 테이블은 인덱스 설계·fillfactor 를 점검한다.
- SERIALIZABLE 을 쓰면 40001 발생률을 메트릭으로 남긴다. 재시도율이 오르면 경합이 늘었다는 신호다.

## 실전에서는 어디에 쓰이나

> 같은 데이터를 동시에 읽고 쓰는 요청 — 이체, 예약, 근무 배정 — 이 생기는 순간 격리 수준이 결과의 정확성을 정한다. 그리고 오래 열린 트랜잭션이 VACUUM 을 막아 테이블이 부푸는 운영 문제로도 다시 만난다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 잔액 차감 | 동시 이체의 초과 인출 방지 | READ COMMITTED 에서 조건부 UPDATE 한 문장(재검사) 또는 `FOR UPDATE` | SERIALIZABLE + 재시도는 일반적이지만 abort 처리 필요 |
| 병원·매장 근무표 SaaS | "최소 1명 당직" 같은 여러 행 불변식(write skew) | SERIALIZABLE + `40001` 재시도 루프 | 관련 행을 모두 `FOR UPDATE` 로 명시 잠금 |
| 정산·리포트 배치 | 긴 집계 동안 일관된 한 시점의 숫자 | REPEATABLE READ 읽기 전용 트랜잭션 | 읽기 복제본에서 돌려 primary 부담 분리 |
| 자주 갱신되는 상태 테이블 | UPDATE 마다 새 튜플·인덱스 갱신으로 bloat | fillfactor 낮추고 갱신 컬럼에 인덱스를 걸지 않아 HOT 비율 유지 | 휘발성 상태는 Redis 로 |
| 사내 DB 운영 | `idle in transaction` 세션이 VACUUM 지평선을 붙잡음 | `idle_in_transaction_session_timeout`, `backend_xmin` 나이 감시 | 사후에 `pg_repack` 으로 정리 |

**이럴 땐 안 맞는다**
- 전역 카운터처럼 경합이 몰리는 한 행에 SERIALIZABLE → abort·재시도가 폭증한다. 원자적 `UPDATE … SET n = n + 1` 이나 Redis `INCR`, 집계 테이블로.
- 넣자마자 지우는 대량 임시 데이터 → MVCC 라 dead tuple 이 쌓인다. 파티션 단위 DROP 이나 전용 브로커로.

**누가 매일 만나나** — 결제·주문 백엔드 개발자가 "가끔 재고·잔액이 음수가 된다" 는 버그를 두 세션으로 재현할 때, DBA 가 bloat·`age(datfrozenxid)` 경보를 받을 때.

**면접·실무 단골 질문**
- Q. PostgreSQL 기본 격리 수준과 막지 못하는 이상 현상은? → READ COMMITTED. non-repeatable read, phantom, write skew 는 가능하다.
- Q. VACUUM 은 왜 필요한가? → MVCC 가 남긴 옛 버전 회수, visibility map 갱신, xid 랩어라운드 방지(freeze).

## 실습 체크리스트

- [ ] 두 세션으로 non-repeatable read 재현 (실험실)
- [ ] REPEATABLE READ 에서 갱신 충돌 에러 재현
- [ ] `SELECT xmin, xmax, ctid` 로 UPDATE 전후 튜플 위치 변화 보기
- [ ] `pg_stat_user_tables` 에서 dead tuple 수 보고 VACUUM 후 변화 확인
- [ ] `pageinspect` 의 `heap_page_items` 로 UPDATE 전후 버전 체인(t_ctid) 확인
- [ ] fillfactor 100 과 80 테이블에서 같은 UPDATE 를 반복해 HOT 비율 비교
- [ ] 조건부 UPDATE 를 두 세션에서 동시에 실행해 재검사로 0행 갱신되는 것 확인
