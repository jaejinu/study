---
title: "심화 — Redis 내부 구조: 이벤트 루프, I/O 스레드, 명령 처리, 메모리"
order: 16
level: 심화
summary: 명령 하나가 소켓에서 응답까지 거치는 경로, 이벤트 루프와 I/O 스레드의 분업, dict 점진적 리해싱, 객체 인코딩 전환 규칙, jemalloc 과 단편화, RESP3, 만료·축출이 루프 안에서 실행되는 방식. 관찰 명령과 함께
tags: [내부구조, 이벤트루프, I/O스레드, dict, rehash, jemalloc, RESP3]
experiments: [encodings-scan, pipeline-vs-sequential]
---

## 명령 하나의 여정

```
클라이언트 ─TCP─▶ [읽기: I/O 스레드 또는 메인] ─▶ RESP 파싱 ─▶ 명령 테이블 조회 ─▶ (ACL·메모리 검사)
   ─▶ 실행 (메인 스레드, 단일) ─▶ 응답 버퍼 ─▶ [쓰기: I/O 스레드 또는 메인] ─▶ 클라이언트
```

- **이벤트 루프**(`ae.c`): epoll/kqueue 로 수천 소켓을 감시, 읽을 수 있는 소켓에서 요청을 읽고, 실행하고, 쓸 수 있는 소켓에 응답을 쓴다. 한 바퀴를 **tick** 이라 하고 `hz`(기본 10) 로 주기 작업(serverCron) 을 돈다.
- **I/O 스레드**(6.0+, `io-threads N`): 읽기·파싱·쓰기를 여러 스레드가 나눠 하지만 **명령 실행은 여전히 메인 스레드 하나**. 네트워크가 병목일 때(큰 응답, 많은 연결) 처리량이 오른다. 8.0 부터 더 적극적으로 병렬화.
- 실행은 순차 → 원자성. 그래서 "느린 명령 = 전체 정지".

```
INFO stats          # instantaneous_ops_per_sec, total_net_input_bytes
INFO clients        # 연결 수, 큰 출력 버퍼 (client_recent_max_output_buffer)
CLIENT LIST         # 클라이언트별 qbuf(입력 버퍼), omem(출력 버퍼), cmd
CONFIG GET io-threads
```

## 데이터베이스는 거대한 dict

키 공간은 **해시 테이블(dict)** 하나(DB 당). 값은 `robj`(redisObject: type, encoding, refcount, lru/lfu 비트, 포인터).

### 점진적 리해싱

dict 가 차면 2배 크기의 새 테이블을 만들고 **한 번에 옮기지 않는다**. 명령이 실행될 때마다 버킷 몇 개씩, serverCron 에서 1ms 씩 옮긴다. 그래서 수억 개 키가 있어도 리해싱이 서버를 멈추지 않는다. 리해싱 중엔 두 테이블을 모두 조회한다 — `SCAN` 이 중복을 돌려줄 수 있는 이유.

```
DEBUG HTSTATS 0        # 테이블 크기, 체인 길이 분포 (DEBUG 는 콘솔에서 막힘, 터미널에서)
```

### 객체 인코딩 전환

| 타입 | 작을 때 | 임계값 (기본) | 클 때 |
|---|---|---|---|
| String | `int` (정수), `embstr` (≤44B, robj 와 한 블록) | | `raw` |
| List | `listpack` | `list-max-listpack-size -2` (8KB 노드) | `quicklist` (listpack 노드 연결) |
| Hash | `listpack` | 512 필드 / 64B 값 | `hashtable` |
| Set | `intset` (정수만), `listpack` | 512 / 128 | `hashtable` |
| ZSet | `listpack` | 128 멤버 / 64B | `skiplist` + dict |

전환은 **한 방향**(작→큼)이다. 큰 해시에서 필드를 지워 작아져도 listpack 으로 돌아가지 않는다. 메모리 효율이 중요하면 임계값을 올리되(`hash-max-listpack-entries 1024`), listpack 은 O(N) 접근이라 너무 크면 느려진다. [인코딩 실험](/redis/lab/encodings-scan)에서 확인.

## 메모리 할당과 단편화

- 기본 할당자 **jemalloc**: 크기 클래스(8, 16, 32 … 바이트)별 풀. 24B 값은 32B 클래스에 들어가 8B 낭비 → `allocator_frag_ratio`.
- 삭제가 많으면 빈 자리가 흩어져 **외부 단편화** → `mem_fragmentation_ratio` (RSS / used_memory) 가 1.5 이상.
- **active defrag** (`activedefrag yes`): 백그라운드에서 객체를 옮겨 페이지를 비운다. CPU 를 쓰므로 임계값으로 조절.
- 큰 값(수 MB) 은 할당·해제 자체가 ms 단위 → `lazyfree-lazy-user-del yes` 로 백그라운드 스레드에서 해제.

```
INFO memory
# used_memory, used_memory_rss, mem_fragmentation_ratio, allocator_frag_ratio, mem_allocator
MEMORY DOCTOR
MEMORY MALLOC-STATS        # jemalloc 상세
```

## 만료와 축출은 언제 실행되나

- **Lazy expire**: 키 접근 시 `expireIfNeeded` — 만료됐으면 지우고 없는 것처럼.
- **Active expire**: serverCron (hz 마다) 에서 각 DB 의 expires dict 를 샘플링. 만료 비율이 25% 넘으면 반복하되 **시간 상한**(`active-expire-effort`) 을 둔다. 수백만 키가 같은 시각에 만료되면 CPU 스파이크 → TTL 지터.
- **축출**: 명령 실행 **전** `performEvictions` 가 maxmemory 초과분을 샘플 LRU/LFU 로 지운다. 대량 축출이 한 명령의 지연을 늘린다 — `INFO stats` 의 `evicted_keys`, `LATENCY LATEST` 의 `eviction-cycle`.

## 복제와 영속성이 루프에 끼어드는 방식

- `BGSAVE`/AOF rewrite 는 **fork**. fork 자체는 메모리 페이지 테이블 복사라 큰 인스턴스에서 수십~수백 ms 멈춤(`latest_fork_usec`). 그동안 부모는 copy-on-write 로 쓰기 시 페이지 복제.
- AOF 쓰기는 매 tick 에 버퍼를 파일로 `write`, fsync 는 별도 스레드(`everysec`). 디스크가 느리면 fsync 가 밀려 `aof_delayed_fsync` 증가.
- 복제 버퍼: 마스터는 레플리카별 출력 버퍼 + 공유 backlog. 레플리카가 느리면 버퍼가 커져 `client-output-buffer-limit replica` 에 걸려 연결이 끊긴다 → full sync 반복 악순환.

## RESP3

Redis 6+ 의 프로토콜. `HELLO 3` 으로 전환하면 맵·셋·double·null 등 **타입이 있는 응답**을 받아 클라이언트가 변환할 필요가 없고, **client-side caching 의 무효화 푸시**가 가능하다.

```
HELLO 3
HGETALL user:1        # RESP3: 맵으로 옴 (RESP2: 평면 배열)
CLIENT TRACKING ON    # 서버가 내가 읽은 키의 변경을 푸시 → 로컬 캐시 무효화
```

## 관찰 도구 모음

```
INFO everything
LATENCY DOCTOR ; LATENCY HISTORY command
SLOWLOG GET 25
CLIENT LIST | sort by omem
MEMORY USAGE key SAMPLES 0
OBJECT ENCODING key ; OBJECT FREQ key ; OBJECT IDLETIME key
redis-cli --latency-dist           # 지연 분포 히트맵
redis-cli --bigkeys --memkeys
```

## 실습 체크리스트

- [ ] `CONFIG SET hash-max-listpack-entries 1024` 후 600 필드 해시가 listpack 으로 남는지 인코딩 실험으로 확인
- [ ] 1만 개 키에 같은 TTL 을 주고 만료 시점의 `expired_keys` 와 CPU 를 모니터 페이지에서 관찰
- [ ] `redis-cli --latency-dist` 를 띄워 둔 채 벤치마크를 돌려 분포 변화 보기
- [ ] `HELLO 3` 후 `HGETALL` 응답 형식 차이 확인 (터미널 redis-cli)
