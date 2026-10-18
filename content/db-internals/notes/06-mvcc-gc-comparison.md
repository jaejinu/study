---
title: "MVCC 와 GC 구현 비교 — 읽기가 쓰기를 막지 않게 하는 방법들과 그 청소비"
order: 6
level: 심화
summary: "MVCC 가 해결하는 문제(락 없는 일관된 읽기), 스냅샷과 가시성 판단, 세 가지 버전 저장 방식(추가 전용 힙: PostgreSQL / undo 로그 델타: InnoDB·Oracle / 시간 순 저장소·LSM 버전), 각각의 GC(VACUUM, purge, 컴팩션), 블로트·긴 트랜잭션·XID 랩어라운드, HOT 와 인덱스, 스냅샷 격리의 쓰기 왜곡과 SSI, 운영 체크리스트"
tags: [MVCC, 스냅샷, 가시성, VACUUM, undo 로그, purge, 블로트, XID 랩어라운드, HOT, 쓰기 왜곡, SSI]
experiments: [dbi-btree-pageinspect]
---

## MVCC 가 해결하는 것

락만으로 격리를 하면 **읽기가 쓰기를 막고 쓰기가 읽기를 막는다**. 리포트 쿼리가 10분 동안 테이블을 읽으면 그동안 아무도 못 쓴다. MVCC(다중 버전 동시성 제어)는 행을 고칠 때 **새 버전**을 만들고 옛 버전을 남겨 둔다. 읽는 트랜잭션은 자기 시작 시점(스냅샷)에 맞는 버전을 본다. 그래서:

- 읽기는 락을 잡지 않는다. 쓰기와 동시에 진행된다.
- 읽기는 항상 **일관된 스냅샷**을 본다(10분짜리 리포트도 시작 시점 기준).
- 쓰기끼리는 여전히 충돌한다(같은 행에 행 락).

대가는 하나다: **옛 버전을 언젠가 치워야 한다.** MVCC 구현의 차이는 거의 전부 "버전을 어디에 두고 어떻게 치우나" 다. 격리 수준의 사용자 관점은 [PostgreSQL MVCC·격리](/postgres/notes/03-mvcc-isolation)에, 이 노트는 엔진 내부 비교다.

## 스냅샷과 가시성

트랜잭션마다 단조 증가 ID(XID 또는 타임스탬프). 각 버전에는 "누가 만들었고 누가 지웠나" 가 붙는다. 스냅샷은 대략 **(xmin, xmax, 진행 중 XID 목록)**.

버전 V 가 스냅샷 S 에 보이려면:

1. V 를 **만든** 트랜잭션이 S 시작 전에 **커밋**됐고,
2. V 를 **지운**(또는 새 버전으로 대체한) 트랜잭션이 없거나, S 시작 시점에 아직 커밋되지 않았다.

```
행 id=1 의 버전 사슬
 v1: xmin=100 (커밋)  xmax=205 (커밋)     "balance=1000"
 v2: xmin=205 (커밋)  xmax=0              "balance=900"

스냅샷 S (XID 200 시작, 205 는 그때 진행 중)  → v1 을 본다 (205 는 S 에게 미래)
스냅샷 S' (XID 210 시작)                      → v2 를 본다
```

"커밋됐나?" 는 별도 구조(PostgreSQL 의 `pg_xact` 비트맵, 힌트 비트 캐시)로 확인한다. 첫 조회 때 확인 결과를 튜플 헤더에 **힌트 비트**로 써 두므로, SELECT 가 페이지를 dirty 로 만들고 WAL 을 만드는 묘한 일이 생긴다.

## 버전을 어디에 두는가 — 세 가지 방식

### 1. 추가 전용 힙 (PostgreSQL)

UPDATE = **옛 튜플의 xmax 를 채우고, 새 튜플을 힙 어딘가에 추가**. 옛 튜플은 그 자리에 남는다.

```
힙 페이지 7:  [v1 xmin=100 xmax=205] [다른 행] [v2 xmin=205 xmax=0]   ← 같은 페이지면 HOT
```

- 롤백이 공짜: 새 튜플의 XID 를 abort 로 표시하면 끝. undo 로그가 없다.
- 긴 버전 사슬도 읽기는 각 버전이 완전한 튜플이라 단순.
- **모든 인덱스가 새 튜플을 가리켜야** 한다 → UPDATE 하나가 인덱스 N 개 삽입. 이를 피하는 것이 **HOT**(Heap-Only Tuple): 새 버전이 **같은 페이지**에 들어가고 **인덱스 열이 안 바뀌면** 인덱스를 건드리지 않고 페이지 안 사슬로 연결. 그래서 테이블 `fillfactor` 를 70~90 으로 두어 같은 페이지에 여유를 남긴다([B-tree 노트](/db-internals/notes/02-btree-pages-buffer-pool)).
- 청소는 **VACUUM**: 어떤 스냅샷에서도 안 보이는 죽은 튜플을 찾아 공간을 재사용 가능으로 표시하고, 인덱스 항목도 지운다.

### 2. undo 로그 (MySQL InnoDB, Oracle)

UPDATE = **행을 제자리에서 고치고, 옛 값(델타)을 undo 로그에 쓴다**. 행 헤더에 undo 레코드를 가리키는 롤백 포인터.

```
클러스터드 인덱스 리프:  [id=1, balance=900, trx=205, roll_ptr → undo#77]
undo#77:                 [이전 값 balance=1000, trx=100, roll_ptr → ...]
옛 스냅샷의 읽기 = 현재 행에서 시작해 undo 사슬을 거꾸로 적용해 재구성
```

- 테이블(클러스터드 인덱스)은 항상 **최신만** 담아 조밀하다. 블로트가 거의 없다.
- 보조 인덱스는 PK 를 가리키므로 PK 가 안 바뀌면 인덱스가 그대로.
- 롤백 = undo 적용(큰 트랜잭션의 롤백은 오래 걸린다).
- 옛 스냅샷 읽기는 사슬이 길수록 느려진다(재구성 비용).
- 청소는 **purge 스레드**: 더 이상 어떤 읽기도 필요 없는 undo 레코드를 지운다. 긴 트랜잭션이 있으면 purge 가 멈추고 **history list length** 가 자라 undo 테이블스페이스가 부푼다.

### 3. 버전이 키에 붙은 저장소 (LSM 계열: CockroachDB, TiKV, RocksDB 스냅샷)

키에 타임스탬프를 붙여 `(key, ts)` 로 저장. 새 버전 = 새 레코드 추가([LSM](/db-internals/notes/03-lsm-tree-compaction)이 원래 추가 전용이라 자연스럽다). 읽기는 `key` 의 `ts ≤ 스냅샷` 중 최신을 찾는다. 청소는 **GC TTL** 을 지난 버전을 컴팩션이 버리는 것으로.

| | 추가 전용 힙 (PG) | undo 로그 (InnoDB) | 키 버전 (LSM) |
|---|---|---|---|
| UPDATE 쓰기 | 새 튜플 + (HOT 아니면) 모든 인덱스 | 제자리 + undo 델타 | 새 레코드 |
| 최신 읽기 | 사슬 따라 최신 찾기(HOT 사슬) | 바로 | 키 범위 첫 레코드 |
| 옛 스냅샷 읽기 | 그대로(완전 튜플) | undo 재구성(느려짐) | 범위 탐색 |
| 롤백 | 공짜 | undo 적용 | 레코드 무시/정리 |
| 청소 | VACUUM (테이블·인덱스 스캔) | purge (undo 만) | 컴팩션 |
| 블로트가 쌓이는 곳 | **테이블과 인덱스** | undo 테이블스페이스 | SSTable(공간 증폭) |

## 긴 트랜잭션 — 모든 MVCC 의 공통 적

어떤 방식이든 "가장 오래된 활성 스냅샷이 볼 수 있는 버전" 은 치울 수 없다. 그래서 **트랜잭션 하나가 오래 열려 있으면 그 이후 생긴 모든 옛 버전이 쌓인다.**

- PostgreSQL: VACUUM 이 돌아도 `xmin horizon` 이후 죽은 튜플을 못 지운다 → 테이블·인덱스가 계속 부풀고, 지운 공간은 VACUUM FULL/`pg_repack` 전엔 OS 로 안 돌아온다.
- InnoDB: history list length 폭증 → undo 증가, 옛 스냅샷 읽기 느려짐.
- 범인: `idle in transaction` 커넥션(트랜잭션 열고 앱이 딴짓), 몇 시간짜리 분석 쿼리, 잊힌 복제 슬롯·준비된 트랜잭션(2PC), `hot_standby_feedback` 이 켜진 복제본의 긴 쿼리.

```sql
-- PG: 가장 오래된 트랜잭션들
SELECT pid, state, now() - xact_start AS age, left(query, 60) FROM pg_stat_activity
WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 5;
-- 블로트 신호
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 5;
-- 방어
ALTER SYSTEM SET idle_in_transaction_session_timeout = '60s';
```

## XID 랩어라운드 (PostgreSQL)

PG 의 XID 는 **32비트**(약 42억)이고 원형으로 비교한다(현재 XID 기준 앞 21억은 과거, 뒤 21억은 미래). 오래된 튜플의 xmin 이 계속 남아 있으면 XID 가 한 바퀴 돌 때 과거 튜플이 **미래로 보여 사라진다**. 방지책은 **freeze**: 충분히 오래된 튜플을 "모든 스냅샷에 보임" 으로 표시(VACUUM 이 수행). autovacuum 이 freeze 를 못 따라가면 PG 는 데이터 손상을 막기 위해 **새 쓰기를 거부**한다(가장 무서운 PG 장애).

```sql
SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;   -- 2억 넘으면 주의, 20억 가까우면 비상
```

긴 트랜잭션은 freeze 도 막는다. 쓰기가 아주 많은 PG 운영의 1순위 지표다([PostgreSQL 운영](/postgres/notes/05-operations)).

## VACUUM 의 실제 일

1. 힙을 훑어 죽은 튜플(모든 스냅샷에서 안 보임)을 찾아 TID 목록을 모은다(메모리 `maintenance_work_mem`).
2. **모든 인덱스**를 훑어 그 TID 를 가리키는 항목을 지운다(인덱스 수 × 인덱스 크기 — 가장 비싼 단계).
3. 힙의 그 튜플 슬롯을 재사용 가능으로 표시, 여유 공간 맵(FSM) 갱신.
4. 페이지의 모든 튜플이 모두에게 보이면 **visibility map** 에 all-visible 표시 → Index Only Scan 이 힙을 건너뛸 수 있게 되고, 다음 VACUUM 도 건너뜀.
5. 오래된 튜플 freeze.

자주, 조금씩 하는 것이 핵심이다(autovacuum 의 `scale_factor` 를 큰 테이블에선 0.01 처럼 낮춘다). 큰 테이블을 한 번에 VACUUM 하면 I/O 스파이크.

## 스냅샷 격리의 구멍 — 쓰기 왜곡

MVCC 의 자연스러운 격리 수준은 **스냅샷 격리(SI)** 다(PG 의 REPEATABLE READ). 각 트랜잭션은 시작 시점 스냅샷을 보고, 같은 행을 둘이 쓰면 늦은 쪽이 실패한다. 하지만 **서로 다른 행을 쓰는데 서로의 읽기에 의존하면** 못 잡는다.

```
규칙: 당직 의사는 최소 1명
T1: SELECT count(*) FROM oncall WHERE on=true → 2   그러면 나는 빠져도 되겠다 → UPDATE alice SET on=false
T2: SELECT count(*) FROM oncall WHERE on=true → 2   그러면 나는 빠져도 되겠다 → UPDATE bob   SET on=false
둘 다 커밋 → 당직 0명. 서로 다른 행을 썼으니 쓰기 충돌 없음.
```

해법:

- **SSI**(Serializable Snapshot Isolation, PG 의 SERIALIZABLE): 읽은 집합과 다른 트랜잭션의 쓰기 사이의 **rw-의존성 고리**를 추적해 위험한 구조가 생기면 한쪽을 abort. 락 없이 직렬화 가능성을 보장하지만 재시도 로직이 필수.
- `SELECT ... FOR UPDATE` 로 읽은 행을 잠그기(이 예에선 모든 당직 행).
- 제약을 DB 로(트리거, 배제 제약).

[분산 트랜잭션](/distributed-systems/notes/06-transactions-coordination)과 [일관성 모델](/distributed-systems/notes/03-consistency-models)에서 같은 이상 현상이 분산 버전으로 다시 나온다.

## 예시로 보기 — 이 프로젝트에서

pageinspect(실험 `dbi-btree-pageinspect` 가 설치)로 **힙 튜플의 xmin/xmax** 를 직접 본다.

```sql
CREATE TABLE lab_mvcc (id int primary key, v text) WITH (fillfactor = 70);
INSERT INTO lab_mvcc VALUES (1, 'a');
UPDATE lab_mvcc SET v = 'b' WHERE id = 1;
UPDATE lab_mvcc SET v = 'c' WHERE id = 1;
SELECT lp, t_xmin, t_xmax, t_ctid, t_infomask2 & 16384 > 0 AS hot_updated
FROM heap_page_items(get_raw_page('lab_mvcc', 0));
--  lp | t_xmin | t_xmax | t_ctid | hot_updated
--   1 |  801   |  802   | (0,2)  | t        ← v1, 802 가 대체, 다음 버전은 (0,2)
--   2 |  802   |  803   | (0,3)  | t        ← v2
--   3 |  803   |    0   | (0,3)  | f        ← 현재 버전
VACUUM lab_mvcc;
SELECT lp, lp_flags, t_xmin FROM heap_page_items(get_raw_page('lab_mvcc', 0));   -- lp 1, 2 가 정리됨(redirect/unused)
```

같은 페이지 안의 HOT 사슬, VACUUM 후 슬롯이 재사용 가능으로 바뀌는 것까지 눈으로 확인된다. 다른 세션에서 `BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT * FROM lab_mvcc;` 를 열어 둔 채 UPDATE·VACUUM 하면 **정리되지 않는** 것도 보인다 — 긴 트랜잭션의 효과다.

## 실전에서는 어디에 쓰이나

> "디스크가 계속 찬다", "VACUUM 이 돌아도 줄지 않는다", "동시 요청에서 규칙이 깨졌다" — 긴 트랜잭션·블로트·쓰기 왜곡 장애에서 MVCC 내부가 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 PostgreSQL 운영 | 테이블·인덱스 블로트로 디스크 증가 | `n_dead_tup`·가장 오래된 `xact_start` 감시, `idle_in_transaction_session_timeout` | `pg_repack` 으로 사후 회수 |
| 쓰기 많은 SaaS PostgreSQL | XID 랩어라운드로 쓰기 거부 | `age(datfrozenxid)` 알림, 큰 테이블 autovacuum 비율 낮추기 | 장애 후 단일 사용자 모드 VACUUM(긴 중단) |
| 당직·최소 재고 같은 규칙 | 쓰기 왜곡으로 불변식이 깨짐 | SERIALIZABLE(SSI) + 재시도, 또는 `FOR UPDATE` | 트리거·배제 제약으로 DB 에 규칙 |
| 운영 DB 의 장시간 리포트 | 리포트가 쓰기를 막지 않게 | 스냅샷 읽기, 단 긴 스냅샷이 GC 를 막으니 분석 저장소로 | 복제본 + `hot_standby_feedback`(주 서버 블로트 위험) |
| 갱신이 잦은 대형 테이블 | UPDATE 마다 모든 인덱스에 새 항목 | HOT 유도(fillfactor, 인덱스 열 갱신 회피) | undo 로그 방식 엔진(InnoDB) |

**이럴 땐 안 맞는다**
- 재시도 로직 없이 SERIALIZABLE 켜기 — 직렬화 실패가 그대로 사용자 오류가 된다. 재시도할 수 없으면 명시적 락이나 제약을 쓴다.
- 트랜잭션을 열어 둔 채 외부 API 호출 — 그동안 생긴 모든 옛 버전이 쌓인다. 트랜잭션은 DB 작업만 짧게.

**누가 매일 만나나** — DBA·SRE 가 블로트·랩어라운드 대시보드를 볼 때, 백엔드 개발자가 `idle in transaction` 커넥션을 남기는 코드를 리뷰할 때.

**면접·실무 단골 질문**
- Q. PostgreSQL 과 InnoDB 의 MVCC 차이? → PG 는 새 튜플을 힙에 추가하고 VACUUM 으로 청소, InnoDB 는 제자리 갱신 + undo 로그와 purge.
- Q. 스냅샷 격리에서 생기는 이상 현상은? → 쓰기 왜곡. 서로 다른 행을 쓰며 서로의 읽기에 의존한다. SSI 나 `FOR UPDATE` 로 막는다.

## 실습 체크리스트

- [ ] 위 SQL 로 HOT 사슬을 만들고, 인덱스 열(id)을 UPDATE 했을 때 `hot_updated` 가 false 가 되는 것 확인
- [ ] 다른 psql 세션에 REPEATABLE READ 트랜잭션을 열어 둔 채 UPDATE 1만 번 + VACUUM, `n_dead_tup` 이 줄지 않는 것 보기
- [ ] 당직 의사 쓰기 왜곡을 REPEATABLE READ 와 SERIALIZABLE 로 재현해 SERIALIZABLE 에서 한쪽이 `could not serialize` 로 실패하는 것 확인
- [ ] `age(datfrozenxid)` 를 기록하고 `VACUUM FREEZE` 후 다시 보기
- [ ] 세 가지 버전 저장 방식에서 "1억 행 테이블의 10% 를 갱신" 했을 때 블로트가 어디에 생기는지 표로 정리하기
