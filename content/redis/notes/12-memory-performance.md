---
title: 메모리와 성능 진단
order: 12
level: 심화
summary: 메모리 구조와 절약 기법, big key·hot key 찾기, SLOWLOG·LATENCY 로 병목 잡기
tags: [메모리, 성능, bigkey, hotkey, SLOWLOG, LATENCY, SCAN]
experiments: [encodings-scan, hash-object, pipeline-vs-sequential]
---

## 메모리는 어디에 쓰이나

```
INFO memory
# used_memory            Redis 가 할당한 바이트 (데이터 + 오버헤드)
# used_memory_rss        OS 가 보는 실제 상주 메모리
# mem_fragmentation_ratio = rss / used_memory  (1.0~1.5 정상, >1.5 단편화, <1 스왑 중)
# used_memory_overhead   클라이언트 버퍼, AOF 버퍼, 복제 버퍼 등
MEMORY USAGE key         # 키 하나의 추정 바이트
MEMORY STATS
MEMORY DOCTOR
```

키 하나당 최소 수십 바이트의 오버헤드(dictEntry, robj, SDS 헤더)가 붙는다. 작은 값 수천만 개는 값보다 오버헤드가 더 크다.

## 절약 기법

1. **작은 Hash 로 묶기**: `user:1:name`, `user:1:age` 두 키 대신 `user:1` Hash 하나. listpack 인코딩이 유지되는 범위(기본 512 필드, 64바이트)에서 수 배 절약.
2. **짧은 키/필드명**: `user:1000:followers` → `u:1000:f`. 수천만 개면 의미 있다.
3. **정수 사용**: `"12345"` 는 `int` 인코딩으로 객체 공유(0~9999 는 공유 풀).
4. **TTL 설정**: 안 쓰는 데이터가 남지 않게.
5. **직렬화 압축**: 큰 JSON 은 압축해서 저장 (CPU 와 트레이드오프).
6. **Bitmap/HLL**: 카운트·플래그는 전용 구조로.
7. `activedefrag yes` 로 단편화를 런타임에 정리.

## Big Key

한 키에 수십만 멤버가 있으면: 삭제 시 멈춤, 복제 지연, 클러스터 슬롯 불균형, `HGETALL` 한 방에 네트워크 폭주.

```
redis-cli --bigkeys          # SCAN 기반, 타입별 최대 키
redis-cli --memkeys          # MEMORY USAGE 기준
```

- 분할: `followers:{user}` → `followers:{user}:{shard}`.
- 삭제는 `UNLINK` 또는 `HSCAN` + `HDEL` 로 나눠서.
- 읽기는 `HSCAN`/`SSCAN`/`ZSCAN` 으로 페이징.

## Hot Key

```
redis-cli --hotkeys          # maxmemory-policy 가 LFU 일 때만
OBJECT FREQ key              # LFU 카운터
MONITOR                      # 운영에서 절대 오래 켜지 말 것 (부하 큼)
```

해법은 [캐싱 노트](/redis/notes/08-caching-patterns)의 핫 키 항목 참고: 로컬 캐시, 키 복제.

## 느린 명령 찾기

```
SLOWLOG GET 10               # slowlog-log-slower-than (기본 10ms, 이 프로젝트 10ms) 이상
SLOWLOG RESET
LATENCY LATEST               # latency-monitor-threshold 이상 이벤트
LATENCY DOCTOR
```

흔한 원인:
- `KEYS *`, `SMEMBERS`, `HGETALL`, `LRANGE 0 -1` 같은 O(N).
- 큰 키 `DEL`.
- fork (BGSAVE/AOF rewrite) 중 copy-on-write.
- 투명 거대 페이지(THP) → `echo never > /sys/kernel/mm/transparent_hugepage/enabled`.
- 스왑.

## SCAN 올바르게 쓰기

```
SCAN 0 MATCH user:* COUNT 1000
# → [다음 커서, 키들]. 커서가 0 으로 돌아올 때까지 반복
```

- `COUNT` 는 힌트. 반환 개수는 다를 수 있고, 같은 키가 **중복**으로 나올 수 있다 (리해시 중). 클라이언트에서 중복 제거.
- 순회 중 추가된 키는 나올 수도 안 나올 수도 있다.
- `TYPE` 옵션으로 타입 필터 (`SCAN 0 TYPE zset`).

## 클라이언트 측

- 커넥션 풀/재사용: 매 요청 새 연결은 TCP 핸드셰이크 + AUTH 비용.
- 타임아웃 설정: 무한 대기 금지. `connectTimeout`, `commandTimeout`.
- 파이프라인/MGET 으로 RTT 줄이기.
- 클라이언트 출력 버퍼 제한(`client-output-buffer-limit`)을 넘으면 서버가 연결을 끊는다. 큰 응답을 느리게 읽는 클라이언트 주의.

## 벤치마크

이 사이트의 **벤치마크** 페이지(`/redis/benchmark`)가 아래 명령을 파이프라인 유무로 두 번 실행해 차트로 보여주고, **모니터** 페이지(`/redis/monitor`)가 INFO·SLOWLOG 를 2초마다 읽어 ops/sec 추이를 그린다.

```
redis-benchmark -q -n 100000 -t set,get,incr,lpush,zadd -P 16
# -P 16 : 파이프라인 16
```

## 메모리 내역 읽기 — MEMORY STATS

```
127.0.0.1:6379> MEMORY STATS
 1) "peak.allocated"        → 8.2MB  역대 최대
 3) "total.allocated"       → 6.1MB  = used_memory
 5) "startup.allocated"     → 0.9MB  빈 서버 기본
 7) "replication.backlog"   → 1.0MB
 9) "clients.normal"        → 0.2MB  클라이언트 버퍼
13) "keys.count"            → 412
15) "keys.bytes-per-key"    → 9800   ← 키 하나 평균. 작아야 정상
17) "dataset.bytes"         → 3.6MB  실제 데이터
19) "dataset.percentage"    → 70%
21) "fragmentation"         → 1.32
```

| 항목이 크면 | 의심 |
|---|---|
| `clients.normal` | 느린 클라이언트, 큰 응답(`HGETALL` 대량), Pub/Sub 구독자 지연 |
| `replication.backlog` | 설정한 크기 그대로 — 정상 |
| `overhead.hashtable.main` | 키가 아주 많음 → 작은 Hash 로 묶기 검토 |
| `fragmentation` > 1.5 | 할당·해제 패턴으로 생긴 구멍 → `activedefrag` |
| `fragmentation` < 1 | **스왑 중** — 즉시 조치(지연 수십 배) |

## 단편화는 왜 생기고 어떻게 없애나

Redis 는 jemalloc 으로 크기별 구간(bin)에 메모리를 할당한다. 키를 대량으로 지우면 used_memory 는 줄지만, 페이지 안에 산 객체가 하나라도 남으면 OS 에 돌려주지 못한다. 그래서 RSS 는 그대로고 비율이 올라간다.

```
CONFIG SET activedefrag yes
CONFIG SET active-defrag-ignore-bytes 100mb      # 낭비가 이만큼 넘을 때만
CONFIG SET active-defrag-threshold-lower 10      # 단편화 10% 넘으면 시작
CONFIG SET active-defrag-cycle-max 25            # CPU 최대 25%
INFO memory | grep -E "defrag|fragmentation"
```

액티브 디프래그는 살아 있는 객체를 새 위치로 옮기고 빈 페이지를 반환한다. CPU 를 쓰므로 트래픽 피크 때는 상한을 낮게 둔다.

## 키를 Hash 로 묶는 계산

1천만 사용자의 "마지막 접속 시각" 을 저장한다고 하자.

| 설계 | 키 수 | 키당 크기 | 총합(대략) |
|---|---|---|---|
| `last:<userId>` String | 1천만 | ~60B | ~600MB |
| `last:<userId/100>` Hash(필드 = userId%100) | 10만 | 필드 100개 listpack ~1.2KB | ~120MB |

5배 차이다. 대신 필드별 TTL 이 없고(7.4 의 `HEXPIRE` 이전), 한 Hash 의 필드 수가 `hash-max-listpack-entries` 를 넘지 않게 버킷 크기를 맞춰야 한다. 이 기법은 인스타그램이 사진 → 사용자 매핑 3억 건을 21GB 에서 5GB 로 줄인 것으로 유명하다.

## 지연의 정체를 가르는 법

```
redis-cli --latency-history -i 5      # 5초 단위 지연 추이
LATENCY LATEST                         # 이벤트별 최근 최대
LATENCY HISTORY fork
LATENCY DOCTOR                         # 원인 추정 문장
```

| 지연 원인 | 증거 | 대처 |
|---|---|---|
| O(N) 명령 | SLOWLOG 에 `HGETALL`/`KEYS` | SCAN 계열, 데이터 분할 |
| fork | `latest_fork_usec` 크고 BGSAVE 시각과 일치 | 레플리카에서 영속화, 메모리 작게 |
| 대량 만료 | `expired_time_cap_reached_count` 증가 | TTL 지터 |
| 축출 | `evicted_keys` 급증과 쓰기 지연 | 메모리 증설, 정책 검토 |
| 스왑 | `fragmentation` < 1, `sar -W` | 메모리 확보, `vm.swappiness` |
| 호스트 노이즈 | `--intrinsic-latency` 큼 | VM·컨테이너 CPU 스로틀링 확인([운영체제 — cgroup](/os-internals/notes/03-scheduler-cgroups)) |
| 네트워크 | 서버 SLOWLOG 는 깨끗한데 앱은 느림 | RTT·커넥션 풀 대기([성능 — 꼬리 지연](/performance/notes/08-tail-latency-at-scale)) |

eBPF 주제의 `ebpf-bpftrace-syscalls` 실험은 Redis 프로세스의 시스템 콜 분포(write 45%·read 34%·epoll_wait 21%)와 지연 히스토그램을 커널에서 직접 본다 — "Redis 가 무엇을 하며 시간을 쓰는가" 를 SLOWLOG 밖에서 확인하는 방법이다.

## 예시로 보기 — 이 프로젝트에서

```
127.0.0.1:6379> MEMORY USAGE progress:read
(integer) 1408
127.0.0.1:6379> OBJECT ENCODING progress:read
"listpack"                   ← 멤버가 적어 압축 인코딩
127.0.0.1:6379> OBJECT ENCODING quiz:stats:redis
"listpack"                   ← JSON 값이 64바이트 넘으면 hashtable 로 바뀐다
```

`quiz:stats:<주제>` 의 값은 `{"right":..,"wrong":..,"streak":..,"box":..,"due":..,"last":..}` JSON 이라 100바이트 안팎이다. 카드가 몇 장만 기록돼도 `hash-max-listpack-value`(64)를 넘어 hashtable 로 바뀐다. 주제당 카드가 수십 장이라 문제는 없지만, 수백만 사용자 규모라면 값을 `box|due` 처럼 짧게 인코딩하거나 필드를 분리해 listpack 을 유지하는 편이 메모리를 몇 배 아낀다. 이 판단을 직접 해 보는 것이 이 노트의 목표다.

## 실전에서는 어디에 쓰이나

> "Redis 메모리가 계속 오른다", "가끔 수십 ms 씩 튄다" 는 운영 문의에서 등장한다. 키가 수천만 개 규모가 되면 키당 오버헤드와 인코딩이 비용을 좌우한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 대량의 작은 ID 매핑 | 키 오버헤드가 값보다 큼 | 작은 Hash 버킷으로 묶어 listpack 유지 (Instagram 이 블로그로 공개한 기법) | 디스크 기반 KV |
| SNS 팔로워 목록 | big key 조회·삭제로 서버 정지 | 키 분할, `UNLINK`, `SSCAN` 페이징 | RDBMS·그래프 저장소 |
| 게임 이벤트 공지 키 | hot key 로 한 노드만 포화 | `--hotkeys`(LFU 정책), 앱 로컬 캐시 | 키 복제 |
| 운영 중 지연 스파이크 | 원인 구분(O(N) 명령·fork·스왑) | `SLOWLOG`, `LATENCY DOCTOR`, `MEMORY STATS` | eBPF 로 시스템 콜 관찰 |
| 대량 삭제 후 메모리 미반환 | 단편화 | `activedefrag yes` + 임계값 | 레플리카로 옮겨 재시작 |

**이럴 땐 안 맞는다**
- 메모리를 아끼려고 listpack 임계값을 크게 올리기 — 조회가 선형 탐색이 되어 CPU 가 튄다. 키 구조를 바꾼다.
- 운영에서 `MONITOR`·`KEYS *` 로 원인 찾기 — 그 자체가 장애가 된다. `--bigkeys`·SCAN 기반 도구를 쓴다.

**누가 매일 만나나** — SRE 가 메모리·지연 알림을 받은 직후의 첫 진단에서, 백엔드가 설계 리뷰에서 "키 1억 개면 몇 GB?" 를 계산할 때.

**면접·실무 단골 질문**
- Q. `mem_fragmentation_ratio` 가 1보다 작으면 → 스왑 중이라는 신호, 즉시 조치.
- Q. 작은 키 수억 개의 메모리를 줄이는 법 → Hash 버킷으로 묶어 listpack 유지, 짧은 키 이름, 정수 인코딩.

## 실습 체크리스트

- [ ] `MEMORY STATS` 에서 `keys.bytes-per-key`, `dataset.percentage`, `fragmentation` 읽기
- [ ] 같은 1만 건을 String 키 1만 개와 Hash 100개로 저장해 `INFO memory` 의 used_memory 비교하기
- [ ] `OBJECT ENCODING quiz:stats:redis` 를 확인하고 왜 그 인코딩인지 설명하기
- [ ] `redis-cli --latency-history` 를 켠 상태에서 BGSAVE 를 실행해 지연 변화 관찰하기
- [ ] eBPF 주제의 시스템 콜 실험을 돌려 Redis 가 시간을 어디에 쓰는지 확인하기
