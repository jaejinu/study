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

## serverCron 이 하는 일

이벤트 루프는 소켓 이벤트 외에 **시간 이벤트**도 처리한다. 대표가 `serverCron` 으로, `hz`(기본 10) 마다 돈다.

| 작업 | 내용 | 관련 지표 |
|---|---|---|
| 능동 만료 | expires 샘플링 삭제([키 만료](/redis/notes/03-keys-expiration)) | `expired_keys`, `expire_cycle_cpu_milliseconds` |
| 점진적 리해싱 | 1ms 예산으로 버킷 이동 | `DEBUG HTSTATS` |
| 클라이언트 정리 | 타임아웃·큰 버퍼 축소 | `connected_clients` |
| 통계 갱신 | ops/sec 표본, 메모리 피크 | `instantaneous_*` |
| 영속화 트리거 | `save` 조건 확인 → BGSAVE, AOF rewrite 조건 | `rdb_changes_since_last_save` |
| 복제 | 레플리카 핑, 타임아웃 | `master_link_status` |
| 액티브 디프래그 | 조각 모음 | `active_defrag_running` |

`hz` 를 100 으로 올리면 만료가 더 정확하고 클라이언트 타임아웃이 빨리 감지되지만, 유휴 상태에서도 CPU 를 더 쓴다. `dynamic-hz yes`(기본)는 클라이언트 수에 따라 자동으로 올린다.

## skiplist — ZSet 이 O(log N) 인 이유

```
레벨 3:  head ─────────────────────────────▶ 70 ──────────────▶ nil
레벨 2:  head ──────────▶ 30 ──────────────▶ 70 ──────▶ 90 ──▶ nil
레벨 1:  head ──▶ 10 ──▶ 30 ──▶ 50 ──▶ 60 ──▶ 70 ──▶ 80 ──▶ 90 ──▶ nil
```

- 노드는 1/4 확률로 한 레벨씩 올라간다(최대 32). 위 레벨에서 크게 건너뛰고 아래로 내려가며 찾으므로 평균 O(log N).
- 각 링크에 **span**(건너뛰는 노드 수)을 저장해 `ZRANK` 를 O(log N) 에 계산한다 — 균형 트리보다 구현이 단순하고 범위 순회(`ZRANGE`)가 연결 리스트라 빠르다.
- skiplist 와 별도로 **dict(멤버 → score)** 를 같이 둔다. `ZSCORE` 가 O(1) 인 이유이고, ZSet 이 메모리를 많이 쓰는 이유다(멤버당 두 구조).

## listpack 의 실제 바이트

```
[총 바이트 4B][원소 수 2B][원소1][원소2]…[끝 0xFF]
원소 = [인코딩+길이 1~5B][내용][역방향 길이 1~5B]
```

- 앞뒤 어느 방향으로도 순회할 수 있게 원소 끝에 자기 길이를 다시 적는다(예전 ziplist 의 "연쇄 갱신" 문제를 없앤 설계).
- 작은 정수는 인코딩 바이트 안에 값까지 넣는다 — `HSET h f 7` 의 값 7 은 1바이트.
- 삽입·삭제는 뒤쪽 바이트를 `memmove` 해야 해서 O(N). 그래서 크기 상한이 있다.

## eBPF 로 본 Redis

커널 밖에서 보는 INFO·SLOWLOG 와 달리, eBPF 는 Redis 프로세스의 **시스템 콜과 스택**을 직접 본다. eBPF 주제의 실험 결과를 보면 이 노트의 설명이 숫자로 확인된다.

| 관찰 | 결과(이 Mac, redis-benchmark 부하) | 해석 |
|---|---|---|
| 시스템 콜 분포 | write 45% · read 34% · epoll_pwait 21% | 명령 실행보다 **소켓 I/O 가 일의 대부분** |
| CPU 스택 프로파일 | 커널 샘플 69%, `connSocketWrite` 52% | 응답 쓰기가 가장 비싸다 → 파이프라인·I/O 스레드의 근거 |
| TCP 연결 수명 | `-k 0`(매번 연결) 2,017개 vs `-k 1` 20개 | 커넥션 재사용의 차이 |

[eBPF — bpftrace 한 줄 관측](/ebpf/notes/02-bpftrace-one-liners)과 [프로파일링](/ebpf/notes/06-profiling-continuous)에서 같은 측정을 직접 해 볼 수 있다. "단일 스레드가 병목" 이라는 말의 실체는 대개 **그 한 스레드가 네트워크 시스템 콜을 하느라 바쁘다** 는 뜻이다.

## 예시로 보기 — 이 프로젝트에서

| 이 사이트의 동작 | 내부에서 일어나는 일 |
|---|---|
| 노트 하단 "읽음" 클릭 → `SADD progress:read` | Set 이 작으면 listpack 에 append(memmove 없이 끝에) |
| 첫 화면 → `SMEMBERS progress:read` 한 번 | listpack 순회 O(N), 결과를 출력 버퍼에 |
| 퀴즈 답 → `HGET`·`HSET quiz:stats:<주제>` | 값이 64B 넘어 hashtable — dict 조회 O(1) |
| 학습 시간 30초마다 `INCRBY` | 정수 String 은 `int` 인코딩, 내용 변경만 |
| `study:day:*` 60일 TTL | expires dict 에 등록, serverCron 샘플링 대상 |

`OBJECT ENCODING` 으로 위 표를 콘솔에서 하나씩 확인해 보면, 같은 "Hash" 라도 이 사이트에서 이미 두 가지 인코딩이 공존한다는 것을 알 수 있다.

## 실습 체크리스트

- [ ] `CONFIG SET hash-max-listpack-entries 1024` 후 600 필드 해시가 listpack 으로 남는지 인코딩 실험으로 확인
- [ ] 1만 개 키에 같은 TTL 을 주고 만료 시점의 `expired_keys` 와 CPU 를 모니터 페이지에서 관찰
- [ ] `redis-cli --latency-dist` 를 띄워 둔 채 벤치마크를 돌려 분포 변화 보기
- [ ] `HELLO 3` 후 `HGETALL` 응답 형식 차이 확인 (터미널 redis-cli)
