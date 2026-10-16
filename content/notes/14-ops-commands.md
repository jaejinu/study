---
title: 운영 명령과 redis-cli 활용
order: 14
level: 심화
summary: INFO 읽는 법, CONFIG 런타임 변경, CLIENT 관리, redis-cli 의 유용한 옵션, 보안 기본
tags: [운영, INFO, CONFIG, CLIENT, redis-cli, ACL, 보안]
experiments: []
---

## INFO 섹션별 핵심 지표

```
INFO server        # redis_version, uptime_in_seconds, process_id
INFO clients       # connected_clients, blocked_clients
INFO memory        # used_memory_human, mem_fragmentation_ratio, maxmemory_policy
INFO persistence   # rdb_last_bgsave_status, aof_enabled, aof_last_write_status
INFO stats         # total_commands_processed, instantaneous_ops_per_sec,
                   # keyspace_hits/misses, expired_keys, evicted_keys, rejected_connections
INFO replication   # role, connected_slaves, master_repl_offset
INFO keyspace      # db0:keys=…,expires=…,avg_ttl=…
INFO commandstats  # 명령별 호출 수와 평균 µs
```

주시할 것: `evicted_keys` 증가(메모리 부족), `rejected_connections`(maxclients), `mem_fragmentation_ratio`, `rdb_last_bgsave_status:err`.

## CONFIG

```
CONFIG GET maxmemory
CONFIG GET '*lazy*'
CONFIG SET maxmemory-policy allkeys-lfu     # 재시작 없이 변경
CONFIG REWRITE                              # 현재 설정을 redis.conf 에 반영
CONFIG RESETSTAT                            # INFO stats 초기화
```
이 사이트의 콘솔에서는 `CONFIG SET` 이 막혀 있다. 터미널에서 `pnpm redis:cli` 로 실행하자.

## CLIENT

```
CLIENT LIST            # 연결된 클라이언트, idle, 명령, 버퍼
CLIENT SETNAME worker-1    # 이름 붙이기 (디버깅에 매우 유용)
CLIENT KILL ID 123
CLIENT PAUSE 1000 WRITE    # 1초간 쓰기 일시정지 (마이그레이션 시)
CLIENT NO-EVICT ON
```

ioredis: `new Redis({ connectionName: 'api-server' })`.

## 키 관련 유틸

```
DBSIZE
RANDOMKEY
TYPE key
OBJECT ENCODING key
OBJECT IDLETIME key        # 마지막 접근 후 초
OBJECT FREQ key            # LFU 일 때
DUMP key / RESTORE key 0 <payload>    # 직렬화 복사
COPY src dst
RENAME / RENAMENX
TOUCH key                  # LRU 갱신만
```

## redis-cli 옵션

```
redis-cli -u redis://:pass@host:6379/0
redis-cli -r 5 -i 1 INFO stats | grep ops     # 5번, 1초 간격
redis-cli --stat                              # 실시간 요약
redis-cli --latency / --latency-history
redis-cli --bigkeys / --memkeys / --hotkeys
redis-cli --scan --pattern 'session:*' | head
redis-cli --scan --pattern 'tmp:*' | xargs redis-cli UNLINK
redis-cli --pipe < commands.txt
redis-cli --rdb dump.rdb                      # 원격 스냅샷 받기
redis-cli -x SET bigvalue < file.bin          # stdin 을 마지막 인자로
```

## 보안 기본

- **바인드**: `bind 127.0.0.1` 또는 사설망만. 인터넷에 노출된 Redis 는 수 분 내 공격당한다.
- `protected-mode yes` (기본).
- `requirepass` 또는 **ACL** (Redis 6+):
  ```
  ACL SETUSER app on >secret ~app:* +@read +@write -@dangerous
  ACL LIST
  ```
- 위험 명령 비활성화: `rename-command FLUSHALL ""` (레거시) 또는 ACL 로 `-flushall`.
- TLS: `tls-port 6380`, 인증서 설정.
- 클라이언트 입력(키 이름)을 그대로 `EVAL` 에 넣지 말 것.

## 디버깅 루틴

1. `INFO` 전체를 저장해 두고 평소 값과 비교.
2. `SLOWLOG GET`, `LATENCY LATEST`.
3. `CLIENT LIST` 에서 idle 길거나 `omem`(출력 버퍼) 큰 클라이언트.
4. `--bigkeys`.
5. 정말 필요할 때만 수 초 동안 `MONITOR` (또는 `redis-cli monitor | head -1000`).

## 더 공부할 것

- Redis 공식 문서의 명령 레퍼런스 (각 명령의 시간 복잡도)
- "Redis in Action" (Josiah Carlson) — 패턴 중심
- Redis 소스의 `src/t_*.c` — 각 타입 구현
- Martin Kleppmann, "How to do distributed locking"
- Redis University RU101/RU102 무료 강의
