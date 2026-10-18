---
title: "WAL·체크포인트·복구 — 죽었다 깨어나도 커밋은 남는다"
order: 4
level: 심화
summary: "버퍼 풀의 dirty 페이지와 원자성·내구성 문제, steal/no-force 정책, WAL 규칙(로그 먼저), LSN, redo 와 undo, ARIES 의 세 단계(분석·redo·undo) 직관, 체크포인트가 복구 시간을 묶는 방법과 체크포인트 스파이크, full page write 와 토른 페이지, 그룹 커밋, PostgreSQL WAL·MySQL redo/binlog·Redis AOF·Kafka 로그·SQLite WAL 비교, 커밋 지연을 정하는 손잡이들. 두 실험으로 fsync 설정의 비용을 잰다"
tags: [WAL, LSN, redo, undo, ARIES, 체크포인트, full page write, 그룹 커밋, synchronous_commit, AOF]
experiments: [dbi-write-amplification, dbi-wal-vs-aof]
---

## 문제 — 메모리에서 고치고, 나중에 쓴다

[버퍼 풀](/db-internals/notes/02-btree-pages-buffer-pool)은 페이지를 메모리에서 고친다. 디스크에는 나중에 쓴다. 이 사이에 프로세스가 죽거나 전원이 나가면:

- 커밋된 트랜잭션의 변경이 아직 디스크에 없으면 → **내구성(D) 위반**.
- 커밋 안 된 트랜잭션의 변경이 이미 디스크에 있으면(버퍼 풀이 공간이 필요해 dirty 페이지를 내보냈다면) → **원자성(A) 위반**.

두 가지 정책 축이 있다.

| | 의미 | 성능 영향 |
|---|---|---|
| **steal** | 커밋 안 된 트랜잭션의 dirty 페이지도 디스크로 내보낼 수 있다 | 버퍼 풀이 자유로움(큰 트랜잭션 가능). 대신 **undo** 가 필요 |
| **no-steal** | 커밋 전엔 못 내보냄 | 큰 트랜잭션이 메모리를 다 먹음 |
| **force** | 커밋 시 그 트랜잭션이 바꾼 페이지를 전부 디스크에 쓴다 | 커밋마다 흩어진 임의 쓰기 → 느림. redo 불필요 |
| **no-force** | 커밋 시 페이지는 안 써도 된다 | 커밋이 빠름. 대신 **redo** 가 필요 |

거의 모든 DB 는 **steal + no-force** — 가장 빠르고 가장 복잡한 조합이다. 그것을 가능하게 하는 것이 **WAL**(Write-Ahead Log)이다.

## WAL 규칙

> **페이지를 디스크에 쓰기 전에, 그 페이지를 바꾼 로그 레코드가 먼저 디스크에 있어야 한다.**
> **커밋을 응답하기 전에, 그 트랜잭션의 커밋 로그 레코드가 디스크에 있어야 한다.**

로그는 **추가 전용 순차 파일**이라 쓰기가 싸다. 커밋 때 흩어진 데이터 페이지 대신 **로그 끝에 순차로 한 번** fsync 하면 된다. 데이터 페이지는 나중에 천천히, 모아서 쓴다. [디스크 노트](/db-internals/notes/01-disk-memory-hierarchy)의 "순차가 임의보다 수십 배" 를 커밋 경로에 적용한 것이다.

### LSN

로그 레코드마다 단조 증가하는 **LSN**(Log Sequence Number, 보통 로그 내 바이트 오프셋)이 붙는다. 그리고:

- 페이지 헤더의 **pageLSN** = 그 페이지에 마지막으로 반영된 로그 레코드의 LSN.
- **flushedLSN** = 디스크에 fsync 된 로그의 끝.
- 버퍼 풀이 dirty 페이지를 내보내려면 `pageLSN ≤ flushedLSN` 이어야 한다(WAL 규칙의 구현). 아니면 로그를 먼저 fsync.

```sql
SELECT pg_current_wal_lsn(), pg_walfile_name(pg_current_wal_lsn());
-- 0/1A3F4B8 | 000000010000000000000001
SELECT lsn FROM page_header(get_raw_page('lab_users', 0));   -- pageinspect: 이 페이지의 pageLSN
```

## redo 와 undo

| 로그 정보 | 쓰임 | 필요한 이유 |
|---|---|---|
| **redo**(after image 또는 연산) | 커밋됐는데 페이지가 디스크에 없는 변경을 **다시 적용** | no-force |
| **undo**(before image) | 커밋 안 됐는데 페이지가 디스크에 있는 변경을 **되돌림** | steal |

**물리 로깅**(페이지 X 의 오프셋 Y 를 바이트 Z 로)은 재적용이 단순하고 멱등이다. **논리 로깅**(테이블 T 에 행 R 삽입)은 작지만 재적용이 페이지 상태에 의존한다. 대부분은 **생리학적**(physiological): "페이지 X 안에서 슬롯 3 에 이 튜플 삽입" — 페이지는 물리적으로, 페이지 안은 논리적으로.

PostgreSQL 은 독특하게 **undo 로그가 없다**. MVCC 로 옛 버전을 힙에 그대로 두므로, 커밋 안 된 트랜잭션의 새 튜플은 **커밋 로그(pg_xact)에 abort 로 표시**되면 그냥 안 보인다(나중에 VACUUM 이 치움). 대신 [MVCC 블로트](/db-internals/notes/06-mvcc-gc-comparison)라는 비용을 치른다. MySQL InnoDB 는 **undo 로그**에 before image 를 두고 MVCC 읽기도 거기서 옛 버전을 재구성한다.

## ARIES — 복구의 표준 직관

IBM 의 ARIES(1992)가 거의 모든 상용 DB 복구의 원형이다. 재시작하면 세 단계:

```
1. 분석 (Analysis)
   마지막 체크포인트부터 로그 끝까지 훑어
   - 죽을 때 진행 중이던 트랜잭션 목록 (→ undo 대상)
   - dirty 페이지 테이블: 각 페이지가 처음 더러워진 LSN (recLSN)
   를 재구성한다.

2. Redo  — "역사를 반복한다"
   min(recLSN) 부터 끝까지, 모든 로그 레코드를 다시 적용한다
   (커밋 여부와 상관없이! 죽기 직전 상태를 정확히 재현)
   단, 페이지의 pageLSN ≥ 레코드 LSN 이면 이미 반영됐으니 건너뜀 (멱등)

3. Undo
   진행 중이던(커밋 안 된) 트랜잭션들의 변경을 로그를 거꾸로 따라가며 되돌린다
   되돌린 것도 로그에 남긴다 (CLR: compensation log record)
   → undo 중에 또 죽어도, 다음 복구가 이미 되돌린 것을 다시 되돌리지 않음
```

핵심 아이디어 두 개: **"일단 전부 redo 해서 죽기 직전으로 돌아간 뒤, 미완료만 undo"**(단순하고 정확), 그리고 **CLR 로 복구 자체를 로그에 남겨 복구가 멱등**이 되게 한 것.

## 체크포인트 — 복구 시간을 묶는다

체크포인트가 없으면 복구는 로그의 처음부터 redo 해야 한다. 체크포인트는 "이 LSN 이전의 변경은 전부 데이터 파일에 있다" 를 보장하는 지점을 만든다.

```
PostgreSQL 체크포인트:
  1. 체크포인트 시작 LSN 기록 (redo 시작점)
  2. 그 시점의 모든 dirty 페이지를 데이터 파일에 쓰고 fsync
  3. 체크포인트 레코드를 WAL 에, pg_control 에 위치 기록
  4. redo 시작점 이전의 WAL 세그먼트는 재활용/삭제 가능
```

| 설정 | 의미 | 트레이드오프 |
|---|---|---|
| `checkpoint_timeout` (5min) | 최대 간격 | 길면 복구 오래, I/O 평탄 |
| `max_wal_size` (1GB) | WAL 이 이만큼 쌓이면 강제 체크포인트 | 쓰기 많으면 늘려야(체크포인트 너무 잦음 경고) |
| `checkpoint_completion_target` (0.9) | 다음 체크포인트까지 시간의 90% 에 걸쳐 천천히 쓰기 | I/O 스파이크 완화 |

**체크포인트 스파이크**: dirty 페이지 수 GB 를 한꺼번에 쓰면 디스크가 포화돼 질의 지연이 튄다. `completion_target` 으로 펼치고, `pg_stat_bgwriter`/`pg_stat_checkpointer` 의 `checkpoints_req`(요청된 = 강제된) 가 `checkpoints_timed` 보다 많으면 `max_wal_size` 를 늘린다. 이것은 [Redis RDB fork](/redis/notes/04-persistence)·[LSM 컴팩션](/db-internals/notes/03-lsm-tree-compaction)과 같은 "백그라운드 정리가 전경 지연을 갉아먹는" 문제다.

**퍼지 체크포인트**: 체크포인트 동안에도 트랜잭션은 계속된다. 그래서 "시작 시점의 dirty 페이지" 만 쓰고, 그 사이 새 변경은 다음 복구 때 redo 시작점 이후 로그로 커버된다.

## full page write 와 토른 페이지

DB 페이지는 8KB, OS·디스크의 원자적 쓰기 단위는 4KB(또는 512B). 페이지를 쓰는 도중 전원이 나가면 **앞 4KB 는 새것, 뒤 4KB 는 옛것** 인 토른 페이지가 생긴다. redo 는 "페이지가 일관된 상태" 를 전제로 하는데 그 전제가 깨진다.

- **PostgreSQL**: 체크포인트 후 페이지를 **처음** 수정할 때 페이지 전체 이미지(FPI)를 WAL 에 쓴다(`full_page_writes = on`). 복구 때 FPI 로 페이지를 통째로 덮은 뒤 이후 변경을 redo. 대가: 체크포인트 직후 WAL 이 폭증하고, 무작위 키 인덱스는 거의 모든 페이지가 "처음" 이 된다([B-tree 노트](/db-internals/notes/02-btree-pages-buffer-pool)의 UUID 문제).
- **MySQL InnoDB**: **doublewrite buffer** — 페이지를 먼저 연속 영역에 쓰고 fsync, 그 다음 제자리에 쓴다. 쓰기 2배.
- 원자적 16KB 쓰기를 보장하는 파일시스템(ZFS)·장치에서는 끌 수 있다.

## 그룹 커밋 — fsync 를 나눠 내기

fsync 가 1ms 면 단일 스레드 커밋은 초당 1,000 이 상한이다. 동시에 100개 트랜잭션이 커밋하려 하면? **한 번의 fsync 로 100개의 커밋 레코드를 함께** 내리면 된다.

```
T1 커밋 레코드 → 로그 버퍼 ─┐
T2 커밋 레코드 → 로그 버퍼 ─┼─ 리더가 fsync 1회 ─► T1, T2, T3 모두 응답
T3 커밋 레코드 → 로그 버퍼 ─┘
```

PostgreSQL `commit_delay`/`commit_siblings`, MySQL 의 binlog 그룹 커밋, Kafka 프로듀서의 `linger.ms` 배치([Kafka 내부](/kafka/notes/05-internals-storage-replication))가 같은 아이디어다. 동시성이 높을수록 커밋당 fsync 비용이 0 에 수렴한다. 실험 `dbi-write-amplification` 의 "2,000행 단일 커밋 1ms vs 2,000번 커밋 수십 ms" 는 애플리케이션 수준의 그룹 커밋이다.

## 다섯 시스템의 로그 비교

| | 로그 | 커밋 전 fsync 손잡이 | 복구 | 특이점 |
|---|---|---|---|---|
| **PostgreSQL** | WAL(16MB 세그먼트) | `synchronous_commit` on/off/local/remote_write/remote_apply | redo only(+ MVCC) | WAL 이 복제·PITR·논리 디코딩([CDC](/kafka/notes/08-cdc-outbox-debezium))의 원천 |
| **MySQL InnoDB** | redo 로그(순환) + undo + **binlog**(복제용) | `innodb_flush_log_at_trx_commit` 0/1/2, `sync_binlog` | ARIES 식 redo + undo | redo 와 binlog 의 2단계 커밋(XA) |
| **SQLite** | 롤백 저널 또는 WAL | `synchronous` OFF/NORMAL/FULL | 저널이면 undo, WAL 이면 redo | 임베디드, 체크포인트를 쓰기 쪽이 수행 |
| **Redis** | AOF(명령 로그) | `appendfsync` always/everysec/no | AOF 재생 | 로그가 곧 데이터, 재작성 = 컴팩션([Redis 영속성](/redis/notes/04-persistence)) |
| **Kafka** | 파티션 로그 자체 | `flush.messages`/`flush.ms` (기본: OS 에 맡김) | 로그 끝 검증·잘라내기 | 내구성을 **fsync 대신 복제**(acks=all + min.insync.replicas)로 |

Kafka 의 선택이 흥미롭다: 기본적으로 메시지마다 fsync 하지 **않는다**. 대신 `acks=all` 로 여러 브로커의 메모리(페이지 캐시)에 복제되면 커밋으로 본다. "한 대의 디스크" 대신 "여러 대의 메모리" 로 내구성을 산다 — 동시에 모든 브로커의 전원이 나갈 확률이 디스크 fsync 의 비용보다 싸다는 판단. 분산 데이터베이스(Spanner, CockroachDB)의 Raft 로그도 비슷한 계산을 한다([합의](/distributed-systems/notes/05-consensus)).

## 커밋 지연을 정하는 손잡이들

| 손잡이 | 지연 ↓ 대가 |
|---|---|
| 비동기 커밋(`synchronous_commit=off`, `appendfsync everysec`, `innodb_flush_log_at_trx_commit=2`) | 최근 수백 ms ~ 1초 유실 가능. **손상은 없다** |
| 배치·그룹 커밋 | 개별 지연은 약간 ↑, 처리량 ↑↑ |
| 더 빠른 fsync 장치(전원 보호 SSD, NVMe) | 돈 |
| 로그를 별도 장치에 | 데이터 I/O 와 경합 제거 |
| 동기 복제(`synchronous_standby_names`) | 지연 ↑(네트워크 왕복 추가), 노드 장애 시 유실 0 |

"결제는 on, 조회수·세션은 off" 처럼 **트랜잭션마다** 고를 수 있다는 것이 PostgreSQL 의 강점이다: `SET LOCAL synchronous_commit = off;`.

## 예시로 보기 — 이 프로젝트에서

**실험 `dbi-wal-vs-aof`**(1초): 같은 질문을 두 엔진에.

| | 설정 | 500건 총 시간 | 무엇을 잃나 |
|---|---|---|---|
| PostgreSQL | `synchronous_commit=on` | ~200 ms | 없음 |
| PostgreSQL | `off` | ~170 ms | 최근 ~600ms |
| Redis | `appendfsync=always` | ~370 ms | 거의 없음 |
| Redis | `everysec` | ~110 ms | 최대 1초 |

PostgreSQL 차이가 작은 것은 Docker Desktop 가상 디스크의 fsync 가 싸서다(실제 서버에서는 수 배). Redis 는 차이가 크게 보인다 — `always` 는 이벤트 루프 안에서 fsync 를 기다리기 때문에 단일 스레드 전체가 멈춘다.

**실험 `dbi-write-amplification`**(1초): SQLite 의 롤백 저널(undo 방식: 옛 페이지를 저널에 복사 후 제자리 수정) vs WAL(redo 방식: 새 페이지를 로그에 추가). 커밋당 쓰기 8.8KB vs 4.3KB, 지연 4배 차이.

```bash
docker exec -it study-postgres psql -U study -c "select * from pg_stat_wal"
docker exec -it study-postgres psql -U study -c "select checkpoints_timed, checkpoints_req, buffers_checkpoint from pg_stat_bgwriter"
docker exec -it study-postgres ls /var/lib/postgresql/data/pg_wal | head
```

> 이어서 읽기: [스토리지와 StatefulSet](/kubernetes/notes/06-storage-statefulset) — StatefulSet 과 PVC — 디스크를 Pod 에 묶기

## 실전에서는 어디에 쓰이나

> "완료라고 응답했는데 재시작 후 없다", "커밋 지연이 왜 수 ms 인가", "체크포인트 때마다 쿼리가 튄다" — 내구성과 커밋 지연을 맞바꾸는 결정에서 WAL 이 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 결제·원장 | 커밋 응답 = 유실 없음 | `synchronous_commit=on` + 동기 복제, 동시성으로 그룹 커밋 효과 | 비동기 커밋은 최근 수백 ms 를 잃을 수 있다 |
| 커머스 조회수·세션성 데이터 | 커밋 지연 최소화 | 트랜잭션 단위로 `SET LOCAL synchronous_commit = off` | Redis 같은 메모리 저장소로 분리 |
| 이벤트 기반 MSA 연동 | DB 변경을 다른 시스템으로 전파 | WAL 논리 디코딩 기반 CDC(Debezium)·outbox | 애플리케이션 이중 쓰기(불일치 위험) |
| SaaS DB 운영 | 체크포인트 스파이크와 복구 시간 | `max_wal_size`·`checkpoint_completion_target` 조정, `checkpoints_req` 감시 | 더 빠른 디스크, WAL 별도 장치 |
| 금융·공공 데이터 복구 요구 | 특정 시점으로 되돌리기 | 베이스 백업 + WAL 아카이브로 PITR | 정기 덤프(마지막 덤프 이후 유실) |

**이럴 땐 안 맞는다**
- 잃어도 다시 만들 수 있는 캐시·파생 데이터 — 커밋마다 fsync 는 낭비다. 비동기 커밋이나 영속성 없는 저장소.
- 여러 노드의 복제로 내구성을 사는 설계(Kafka `acks=all`)에 노드마다 fsync 강제 — 처리량만 잃기 쉽다. 다만 같은 랙 동시 전원 차단 같은 상관 장애는 따로 따진다.

**누가 매일 만나나** — DBA·SRE 가 WAL 디스크 사용량·복제 지연·체크포인트 경고를 볼 때, 백엔드 개발자가 "이 쓰기는 잃어도 되나" 를 정하고 배치 커밋을 설계할 때.

**면접·실무 단골 질문**
- Q. WAL 이 있으면 왜 커밋이 빨라지나? → 흩어진 데이터 페이지 대신 로그 끝에 순차로 한 번 fsync 하고 페이지는 나중에 모아 쓴다(steal + no-force).
- Q. `synchronous_commit=off` 에서 잃는 것과 잃지 않는 것은? → 최근 커밋 일부를 잃을 수 있지만 데이터 손상·불일치는 없다.

## 실습 체크리스트

- [ ] 실험 `dbi-wal-vs-aof` 를 돌리고 네 설정 각각이 "전원이 나가면 무엇을 잃는가" 를 자기 말로 적기
- [ ] steal/no-force 조합에서 redo 와 undo 가 각각 왜 필요한지 2x2 표로 정리하기
- [ ] `pg_stat_wal` 의 `wal_fpi`(full page image 수)를 기록한 뒤 `CHECKPOINT` 직후 무작위 UPDATE 1만 건을 하고 다시 보기
- [ ] ARIES 의 세 단계를 "T1 커밋, T2 진행 중, 체크포인트, T3 커밋, 크래시" 시나리오로 손으로 따라가기
- [ ] Kafka 가 fsync 대신 복제로 내구성을 얻는 설계의 실패 시나리오(같은 랙 전원 차단)를 [Kafka 전달 보장](/kafka/notes/04-delivery-guarantees)과 연결해 설명하기
