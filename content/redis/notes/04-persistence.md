---
title: 영속성 — RDB 와 AOF
order: 4
level: 기초
summary: 스냅샷과 로그 방식의 차이, fsync 정책, fork 와 copy-on-write, 복구 순서
tags: [RDB, AOF, fsync, fork, 복구]
experiments: []
---

## 두 가지 방식

| | RDB (스냅샷) | AOF (Append Only File) |
|---|---|---|
| 무엇을 저장 | 특정 시점의 전체 데이터 (바이너리) | 모든 쓰기 명령 로그 (RESP 텍스트) |
| 파일 크기 | 작고 압축됨 | 크다 (재작성으로 줄임) |
| 복구 속도 | 빠름 | 느림 (명령 재실행) |
| 데이터 유실 | 마지막 스냅샷 이후 전부 | 설정에 따라 최대 1초 |
| 성능 영향 | fork 시 순간 부하 | 매 쓰기마다 디스크 I/O |

둘 다 켜 두는 것이 일반적이고, 재시작 시 **AOF 가 있으면 AOF 를 우선** 로드한다 (더 완전하므로).

## RDB

```
save 3600 1      # 1시간 동안 1개 이상 변경되면
save 300 100     # 5분 동안 100개
save 60 10000    # 1분 동안 10000개
dbfilename dump.rdb
dir /var/lib/redis        # 이 프로젝트는 명령줄 --dir 로 넘긴다 (로컬 redis/data, Docker /data)
```

- `SAVE` 는 동기(서버 정지), `BGSAVE` 는 자식 프로세스를 **fork** 해서 저장.
- fork 된 자식은 부모 메모리를 **copy-on-write** 로 공유한다. 스냅샷 중 부모가 쓰기를 많이 하면 페이지가 복제되어 메모리가 최대 2배까지 늘 수 있다. 큰 인스턴스에서 fork 자체가 수백 ms 걸리기도 한다 (`INFO stats` 의 `latest_fork_usec`).
- 복제(replication) 초기 동기화에도 RDB 를 쓴다.

## AOF

```
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec      # always | everysec | no
```

| appendfsync | 의미 | 유실 범위 |
|---|---|---|
| `always` | 매 명령마다 fsync | 거의 없음, 매우 느림 |
| `everysec` | 1초마다 백그라운드 fsync | 최대 1초. **권장** |
| `no` | OS 에 맡김 (보통 30초) | OS 버퍼만큼 |

### AOF 재작성 (rewrite)

`INCR counter` 를 100만 번 하면 AOF 에 100만 줄이 쌓인다. `BGREWRITEAOF` 는 현재 데이터셋을 만드는 최소 명령 집합으로 파일을 다시 쓴다.

```
auto-aof-rewrite-percentage 100   # 마지막 재작성 대비 2배 커지면
auto-aof-rewrite-min-size 64mb
```

Redis 7 부터는 **multi-part AOF**: `appendonlydir/` 아래에 base RDB 파일 + 증분 AOF 파일들 + manifest 로 구성된다. 재작성 시 base 를 RDB 형식으로 쓰므로 (`aof-use-rdb-preamble yes`) 빠르게 로드된다.

## 어떤 조합을 쓸까

- **순수 캐시**: 둘 다 끄기 (`save ""`, `appendonly no`). 재시작하면 비어 있지만 상관없음. fork 부하도 없음.
- **세션·큐 등 잃으면 곤란**: AOF `everysec` + RDB 를 백업용으로.
- **절대 유실 불가**: `appendfsync always` 는 매우 느리다. Redis 단독으로는 완전한 내구성을 보장하기 어렵다. 원본은 RDBMS 에 두고 Redis 는 파생 데이터로.

## 직접 확인하기

이 프로젝트의 서버는 `redis/data` 에 `dump.rdb` 와 `appendonlydir/` 를 만든다.

```
INFO persistence      # rdb_last_save_time, aof_enabled, aof_rewrite_in_progress
BGSAVE
LASTSAVE
ls -la redis/data/
```

콘솔에서 `SET` 몇 번 하고 `appendonlydir/*.incr.aof` 를 열어 보면 RESP 형식의 명령이 그대로 쌓이는 것을 볼 수 있다.

```
*3
$3
SET
$5
hello
$5
world
```

## 두 방식을 시간축에 놓으면

![RDB 와 AOF 타임라인](/diagrams/redis-persistence-timeline.svg)

RDB 는 "가끔 찍는 사진", AOF 는 "쉬지 않고 쓰는 일기" 다. 장애가 `t` 시점에 났을 때 잃는 것은:

| 설정 | 잃는 데이터 |
|---|---|
| RDB `save 300 100` 만 | 마지막 BGSAVE 이후 최대 5분 이상 |
| AOF `everysec` | 마지막 fsync 이후 ~1초 (디스크가 느리면 최대 2초) |
| AOF `always` | 마지막 명령 하나 정도 — 대신 쓰기마다 fsync |
| 둘 다 끔 | 전부 |

`everysec` 이 "최대 2초" 인 이유: 백그라운드 fsync 가 아직 끝나지 않았는데 다음 1초가 오면 Redis 는 최대 1초 더 기다렸다가, 그래도 안 끝나면 **fsync 없이 write 만 하고 넘어간다**(`aof_delayed_fsync` 증가). 디스크가 느린 환경에서 이 카운터가 오르면 내구성 약속이 깨지고 있다는 뜻이다.

## fork 와 copy-on-write — 메모리가 두 배가 되는 순간

BGSAVE 와 BGREWRITEAOF 는 `fork()` 로 자식 프로세스를 만든다. fork 는 메모리를 복사하지 않고 **페이지 테이블만 복사**한 뒤, 부모나 자식이 페이지를 쓸 때 그 페이지(4KB)만 복사한다([운영체제 — 가상 메모리와 COW](/os-internals/notes/02-virtual-memory-page-cache)).

| 상황 | 추가 메모리 |
|---|---|
| 스냅샷 중 쓰기가 거의 없음 | 거의 0 |
| 스냅샷 중 키 전체가 갱신됨 | 데이터 크기만큼(최대 2배) |
| THP(huge page 2MB) 켜짐 | 1바이트 써도 2MB 복사 → 폭증 |

```
127.0.0.1:6379> INFO stats
latest_fork_usec:4210          ← fork 자체에 4.2ms (페이지 테이블 복사, 메모리 클수록 길다)
127.0.0.1:6379> INFO persistence
rdb_last_cow_size:18874368     ← 지난 BGSAVE 중 COW 로 복사된 18MB
aof_last_cow_size:0
```

운영 원칙:
- 서버 메모리의 절반 이상을 Redis 데이터로 채우지 않는다(fork 여유).
- THP 를 끈다(Redis 가 시작 로그에서 경고한다, [NUMA·huge page](/os-internals/notes/06-numa-hugepages-tuning)).
- `vm.overcommit_memory = 1` — 아니면 커널이 "2배가 필요할 수 있다" 며 fork 를 거부한다(`Can't save in background: fork: Cannot allocate memory`).

## fsync 는 왜 비싼가

`write()` 는 페이지 캐시에 넣고 바로 돌아오지만, `fsync()` 는 디스크(그리고 디스크의 쓰기 캐시)까지 내려갈 때까지 기다린다. SSD 에서 0.1~수 ms, 네트워크 디스크(EBS 등)에서 더 길다. AOF `always` 는 명령마다 이걸 하므로 처리량이 수천 ops/s 로 떨어진다. 같은 문제를 PostgreSQL 은 **그룹 커밋**으로 푼다 — 동시에 커밋하는 트랜잭션들의 fsync 를 한 번으로 합친다([DB 내부 — WAL 과 그룹 커밋](/db-internals/notes/04-wal-checkpoint-recovery), [파일시스템과 I/O](/os-internals/notes/04-filesystem-io)).

| 비교 | Redis AOF | PostgreSQL WAL |
|---|---|---|
| 기록 단위 | 명령(RESP) | 페이지 변경(물리·논리 레코드) |
| 기본 내구성 | everysec(최대 ~1초 유실) | 커밋마다 fsync(유실 0) |
| 처리량 확보 | fsync 를 1초에 한 번으로 | 그룹 커밋 |
| 크기 관리 | rewrite(현재 상태로 다시 쓰기) | 체크포인트 후 재활용 |

DB 내부 주제의 `dbi-wal-vs-aof` 실험이 두 설정의 커밋 지연을 같은 머신에서 직접 비교한다.

## 복구 절차 — 재시작하면 무슨 일이

1. `appendonly yes` 이고 AOF 가 있으면 → manifest 를 읽고 base(RDB 형식) 로드 → 증분 AOF 재실행.
2. 없으면 → `dump.rdb` 로드.
3. AOF 끝이 잘려 있으면(전원 차단) `aof-load-truncated yes`(기본) 로 잘린 마지막 명령만 버리고 시작한다.
4. 중간이 깨졌으면 시작을 거부한다 → `redis-check-aof --fix` 로 복구(깨진 지점 이후를 잘라냄).

**로딩 시간**은 데이터 크기에 비례한다. 10GB RDB 는 수십 초~수 분. 그동안 Redis 는 `-LOADING` 에러를 돌려준다 — 헬스체크가 PING 만 보면 "살아 있음" 으로 오판한다. `INFO persistence` 의 `loading:1` 을 함께 본다.

## 백업 — 파일을 복사해도 되나

| 방법 | 안전한가 |
|---|---|
| BGSAVE 완료 후 `dump.rdb` 복사 | 안전(원자적 rename 으로 생성) |
| 실행 중 AOF 디렉터리 복사 | 쓰는 중 파일이라 위험. `BGREWRITEAOF` 직후 base 파일 위주로 |
| 레플리카에서 BGSAVE 해서 복사 | 권장 — 마스터에 fork 부하 없음 |

백업은 **복구 리허설**까지 해야 백업이다. 새 컨테이너에 파일을 넣고 띄워 `DBSIZE` 를 비교하는 스크립트를 주기적으로 돌리자([SRE — 변경 관리](/sre/notes/06-capacity-release-change)).

## 예시로 보기 — 이 프로젝트에서

- 로컬 brew 서버(`pnpm redis`)와 Docker `study-redis` 는 모두 `--dir` 로 데이터 디렉터리를 지정한다. `redis/redis.conf` 를 열어 `save`·`appendonly` 설정을 확인해 보자.
- 이 사이트의 학습 기록(읽은 노트·퀴즈·학습 시간)은 Redis 에만 있다. 즉 이 데이터는 **원본** 이다. 그래서 AOF `everysec` 이 켜져 있어야 하고, 컨테이너를 지워도 볼륨(`redis-data`)이 남아 있어야 한다. `docker compose down -v` 는 학습 기록을 지운다.
- DB 내부 주제의 실험이 `appendfsync` 를 잠시 바꿔 지연을 재고 원래 값으로 되돌린다. 실험 후 `CONFIG GET appendfsync` 로 `everysec` 인지 확인하는 습관을 들이자.

```
127.0.0.1:6379> CONFIG GET appendonly
1) "appendonly"
2) "yes"
127.0.0.1:6379> INFO persistence
aof_enabled:1
aof_last_write_status:ok
rdb_last_bgsave_status:ok
aof_delayed_fsync:0
```

## 실전에서는 어디에 쓰이나

> 영속성 설정은 "Redis 가 재시작되면 무엇을 잃어도 되나" 에 대한 답이다. 캐시면 끄고, 잃으면 곤란한 데이터면 AOF 를 켜고 백업·복구 리허설까지 한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 페이지 캐시 | fork 부하 없이 최대 처리량 | RDB·AOF 모두 끄고, 비면 DB 에서 다시 채움 | — |
| 게임 매칭 대기열·세션 | 재시작 후 대부분 복구 | AOF `everysec` + RDB 백업 | 원본은 DB, Redis 는 파생 데이터 |
| 결제 연동 멱등 키 | 재시도 창 동안 중복 방지 기록 유지 | AOF `everysec` + 레플리카 | DB 유니크 제약 (정확성이 필요하면) |
| 사내 플랫폼 백업 | 마스터에 fork 부하 없이 백업 | 레플리카에서 `BGSAVE` → 파일 보관 | 관리형 서비스 스냅샷 |
| 대용량 인스턴스 운영 | fork 지연·메모리 2배 사고 방지 | THP 끄기, `vm.overcommit_memory=1`, 메모리 절반 이하 사용 | 인스턴스 쪼개기(샤딩) |

**이럴 땐 안 맞는다**
- 확인 응답한 쓰기를 절대 잃으면 안 되는 원장 — `always` 는 매우 느리고 복제는 비동기다. PostgreSQL 의 WAL·그룹 커밋에 맡긴다.
- maxmemory 를 컨테이너 한도와 같게 둔 상태의 BGSAVE — COW 로 OOMKilled. 한도의 60~75% 로 둔다.

**누가 매일 만나나** — SRE·DBA 가 백업·복구 리허설과 `rdb_last_bgsave_status` 알림을 다룰 때, 플랫폼 엔지니어가 노드 커널 설정(THP, overcommit)을 표준화할 때.

**면접·실무 단골 질문**
- Q. RDB 와 AOF 를 같이 켜면 재시작 때 무엇을 읽나 → AOF 우선(더 완전), Redis 7 은 base RDB + 증분 AOF.
- Q. BGSAVE 중 메모리가 왜 늘어나나 → fork 뒤 copy-on-write, 쓰기가 많을수록 페이지가 복사된다.

## 실습 체크리스트

- [ ] `INFO persistence` 에서 `rdb_last_cow_size`, `aof_delayed_fsync`, `rdb_last_bgsave_status` 를 읽고 의미 말하기
- [ ] `BGSAVE` 직후 `INFO stats` 의 `latest_fork_usec` 를 확인하기
- [ ] `INCR c` 를 1000번 한 뒤 AOF 증분 파일 크기 → `BGREWRITEAOF` → 크기 변화 확인하기
- [ ] Docker `study-redis` 의 `dump.rdb` 를 새 컨테이너에 넣고 띄워 `DBSIZE` 가 같은지 복구 리허설하기
- [ ] DB 내부 주제의 WAL vs AOF 실험을 돌리고 `everysec` 과 `always` 의 지연 차이를 기록하기
