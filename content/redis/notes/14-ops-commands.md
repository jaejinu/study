---
title: 운영 명령과 redis-cli 활용
order: 14
level: 심화
summary: INFO 읽는 법, CONFIG 런타임 변경, CLIENT 관리, redis-cli 의 유용한 옵션, 보안 기본
tags: [운영, INFO, CONFIG, CLIENT, redis-cli, ACL, 보안]
experiments: [encodings-scan, keyspace-notifications]
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

## 지표를 알림으로 — 무엇을 언제 울릴까

| 알림 | PromQL(redis_exporter) | 임계 예 | 심각도 |
|---|---|---|---|
| Redis 다운 | `redis_up == 0` | 30초 지속 | critical |
| 메모리 포화 | `redis_memory_used_bytes / redis_memory_max_bytes` | > 0.9, 10분 | warning |
| 축출 발생(원본 저장소) | `rate(redis_evicted_keys_total[5m]) > 0` | 즉시 | critical |
| 커넥션 거부 | `increase(redis_rejected_connections_total[5m]) > 0` | 즉시 | warning |
| 영속화 실패 | `redis_rdb_last_bgsave_status == 0` | 즉시 | critical |
| 복제 끊김 | `redis_connected_slaves < 2` | 5분 | warning |
| 지연 | `redis_commands_duration_seconds_total` 증가율 / 호출 수 | 평균 > 1ms | warning |

**주의할 함정**: Redis 가 멈춤(hang) 상태면 exporter 가 응답을 못 받아 `redis_up` 이 0 이 되는 게 아니라 **시계열 자체가 사라진다**. `redis_up == 0` 만 걸어 두면 가장 위험한 장애(hang)에서 알림이 안 온다. `absent(redis_up)` 또는 `up{job="redis"} == 0` 도 함께 건다 — SRE 주제가 실제로 이 문제를 발견하고 SLI 정의를 고쳤다([SRE — 번레이트 알림](/sre/notes/03-burn-rate-alerting), [관측성 — 알림 파이프라인](/observability/notes/09-alerting-pipeline)).

## commandstats — 어떤 명령이 시간을 먹나

```
127.0.0.1:6379> INFO commandstats
cmdstat_get:calls=182733,usec=91203,usec_per_call=0.50,rejected_calls=0,failed_calls=0
cmdstat_hgetall:calls=812,usec=403112,usec_per_call=496.44   ← 호출은 적은데 총시간 1위
cmdstat_smembers:calls=2210,usec=88400,usec_per_call=40.00
```

`calls × usec_per_call` 로 **총 점유 시간**을 정렬하면 최적화 1순위가 보인다. 호출 수 상위가 아니라 **총시간 상위**를 봐야 한다. `HGETALL` 하나가 0.5ms 씩 쓰는 동안 다른 클라이언트는 모두 기다린다.

## CLIENT LIST 읽는 법

```
id=17 addr=127.0.0.1:54012 name=api-server age=3600 idle=0 flags=N db=0 sub=0 psub=0
qbuf=0 qbuf-free=20474 omem=0 tot-mem=22426 cmd=hget user=default lib-name=ioredis
```

| 필드 | 이상 신호 |
|---|---|
| `idle` 큰 연결 수천 개 | 커넥션 누수(풀 미반환, 매 요청 새 연결) |
| `omem` 큼 | 느린 소비자(Pub/Sub 구독자, 큰 응답을 천천히 읽음) |
| `qbuf` 큼 | 큰 요청을 보내는 중 또는 파이프라인 과다 |
| `flags=b` | 블로킹 명령 대기(BRPOP 등) — 정상일 수 있음 |
| `name` 없음 | 누가 연 연결인지 모름 → 모든 클라이언트에 이름 붙이기 |

## ACL 설계 예

```
# 앱: 자기 접두어만, 위험 명령 금지
ACL SETUSER app on >app-secret ~app:* ~progress:* ~study:* ~quiz:* +@all -@dangerous -@admin
# 읽기 전용 대시보드
ACL SETUSER grafana on >ro-secret ~* +@read +info +ping -@dangerous
# 익스포터
ACL SETUSER exporter on >exp-secret +info +ping +config|get +client|list +slowlog|get +latency|latest
ACL WHOAMI
ACL LOG                # 거부된 시도 기록 — 침입 탐지에 유용
```

보안 주제의 `sec-redis-acl` 실험이 제한 사용자를 만들고 거부되는 명령을 확인한다([보안 — 데이터 저장소 하드닝](/security/notes/07-datastore-hardening)).

## 안전한 대량 삭제 스크립트

```bash
# 'tmp:*' 키를 1000개씩 UNLINK, 서버에 쉼을 주며
redis-cli --scan --pattern 'tmp:*' --count 1000 | \
  xargs -n 1000 sh -c 'redis-cli UNLINK "$@" >/dev/null; sleep 0.05' _
```

| 하지 말 것 | 이유 |
|---|---|
| `redis-cli KEYS 'tmp:*' \| xargs redis-cli DEL` | KEYS 가 서버를 멈춤 |
| `DEL` 로 큰 키 | 동기 해제로 멈춤 → `UNLINK` |
| `FLUSHALL` (운영) | 복구 불가. ACL 로 아예 막기 |
| `MONITOR` 장시간 | 처리량이 절반 이하로 |

## 운영 런북 — "Redis 가 느려요"

1. `redis-cli --latency` 로 서버까지 왕복이 정상인지 → 정상이면 앱 쪽(풀·직렬화).
2. `SLOWLOG GET 20` → 특정 명령이 보이면 그 명령의 호출자를 `CLIENT LIST` 의 `name`/`addr` 로 찾기.
3. `INFO stats` 의 `instantaneous_ops_per_sec` 가 평소 대비 몇 배인지 → 트래픽 폭증·재시도 폭풍.
4. `INFO memory` → 축출·스왑·단편화.
5. `INFO persistence` + `LATENCY LATEST` → fork 시각과 겹치는지.
6. 호스트: CPU 스로틀링, 이웃 소음(`--intrinsic-latency`).

이 순서를 문서로 남기고 알림마다 링크하는 것이 [런북](/sre/notes/04-oncall-runbooks)이다.

## 예시로 보기 — 이 프로젝트에서

| 도구 | 위치 | 보는 것 |
|---|---|---|
| 모니터 페이지 | `/redis/monitor` | INFO·SLOWLOG 2초 주기 |
| 키 브라우저 | `/redis/keys` | SCAN 순회, 인코딩·TTL·메모리 |
| 콘솔 | `/redis/console` | 위험 명령(FLUSHALL, CONFIG SET 등)은 차단 |
| Grafana | `localhost:13000` 의 `study-redis` | redis_exporter 지표, 알림 |
| Alertmanager | `localhost:19093` | RedisDown 등 규칙 |

콘솔이 `CONFIG SET` 을 막는 이유는 웹에서 실수로 `maxmemory` 를 바꾸면 학습 기록이 축출될 수 있어서다 — 이것도 ACL 의 `-@dangerous` 와 같은 생각이다.

## 실습 체크리스트

- [ ] `INFO commandstats` 를 총시간 기준으로 정렬해 1위 명령 찾기
- [ ] `CLIENT LIST` 에서 이름 없는 연결을 찾고 앱에 `connectionName` 붙이기
- [ ] 제한 ACL 사용자를 만들어 금지 명령이 거부되고 `ACL LOG` 에 남는 것 확인하기
- [ ] `redis-cli --scan` + `UNLINK` 로 테스트 키 1만 개를 안전하게 지우기
- [ ] Grafana `study-redis` 대시보드에서 위 알림 표의 지표를 찾아보기
