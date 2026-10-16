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
dir ./redis/data
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
