---
title: Redis 란 무엇인가
order: 1
level: 기초
summary: 인메모리 키-값 저장소가 왜 빠른지, 어디에 쓰는지, 단일 스레드 모델의 의미
tags: [개요, 아키텍처, 이벤트루프]
experiments: [strings-basics]
---

## 한 줄 정의

**Redis** (REmote DIctionary Server) 는 메모리에 데이터를 두는 **키-값(key-value) 저장소**다.
값이 단순 문자열이 아니라 List, Hash, Set, Sorted Set, Stream 같은 **자료구조**라는 점이 memcached 와 가장 큰 차이다.
그래서 "data structure server" 라고도 부른다.

## 왜 빠른가

| 요인 | 설명 |
|---|---|
| 메모리 기반 | 디스크 I/O 가 없다. 읽기/쓰기가 보통 **수십 µs** 안에 끝난다 |
| 단일 스레드 명령 처리 | 락 경합이 없고, 모든 명령이 **원자적**으로 실행된다 |
| I/O 멀티플렉싱 | epoll/kqueue 기반 이벤트 루프로 수만 개 커넥션을 한 스레드가 처리한다 |
| 효율적 자료구조 | 작은 데이터는 listpack/intset 같은 압축 인코딩으로 저장한다 |
| 단순한 프로토콜 | RESP 는 파싱 비용이 거의 없는 텍스트 프로토콜이다 |

로컬에서 `redis-benchmark` 를 돌리면 단순 GET/SET 은 초당 10만 건을 가볍게 넘긴다.

## 단일 스레드가 의미하는 것

Redis 6 부터 네트워크 I/O 는 멀티스레드로 처리할 수 있지만, **명령 실행 자체는 여전히 하나의 스레드**에서 순차적으로 일어난다.

좋은 점:
- `INCR`, `LPUSH`, `ZADD` 같은 명령은 그 자체로 원자적이다. 동시성 걱정 없이 카운터를 올릴 수 있다.
- `MULTI/EXEC`, Lua 스크립트가 다른 클라이언트와 섞이지 않는다.

조심할 점:
- **느린 명령 하나가 전체를 막는다.** `KEYS *`, 큰 컬렉션에 대한 `SMEMBERS`, 긴 Lua 스크립트는 그동안 모든 클라이언트를 기다리게 한다.
- 그래서 Redis 의 거의 모든 명령 문서에는 **시간 복잡도**가 적혀 있다. O(N) 명령은 N 이 얼마인지 늘 의식해야 한다.

```
# 절대 운영에서 하지 말 것
KEYS *            # O(N), 전체 키 스캔 동안 서버 정지
SMEMBERS bigset   # 멤버 100만 개면 100만 개 전송
```

![이벤트 루프](/diagrams/redis-event-loop.svg)

### 예시로 보기: 조회수 카운터 세 가지 방법

```
# 1) 읽고-더하고-쓰기 (앱에서): 동시 요청 2개가 같은 값을 읽으면 하나가 유실된다
GET views → 10 ; SET views 11      ✗ 경쟁
# 2) 원자적 명령: 서버가 한 줄로 실행하므로 100개가 동시에 와도 100 증가
INCR views                         ✓
# 3) 하루치 유니크 조회: 사용자 ID 를 Set/HLL 에 넣고 세기
PFADD views:uniq:2026-10-16 u123 ; PFCOUNT views:uniq:2026-10-16
```

실험실의 **String 기초**와 **파이프라인** 실험이 2)와 "RTT 가 병목" 을 숫자로 보여준다. [내부 구조 심화](/redis/notes/16-internals-deep-dive)에서 이벤트 루프를 더 깊게 다룬다.

## 어디에 쓰는가

1. **캐시** — DB 조회 결과, 렌더링된 페이지, API 응답. TTL 과 축출 정책으로 메모리를 관리한다.
2. **세션 저장소** — 여러 웹 서버가 공유하는 로그인 세션.
3. **카운터·랭킹** — 조회수, 좋아요, 실시간 리더보드(Sorted Set).
4. **분산 락 / 레이트 리미터** — `SET NX PX`, `INCR + EXPIRE`.
5. **큐·메시징** — List 기반 작업 큐, Pub/Sub, Stream.
6. **실시간 분석** — HyperLogLog(UV), Bitmap(DAU), Geo.

## 데이터는 안전한가

메모리 저장소지만 **RDB 스냅샷**과 **AOF 로그**로 디스크에 영속화할 수 있다.
다만 "마지막 1초 데이터는 잃을 수 있다" 같은 트레이드오프가 있다. [영속성 노트](/redis/notes/04-persistence)에서 자세히 다룬다.

원칙: Redis 를 **유일한 진실의 원천(source of truth)** 으로 쓰려면 영속성·복제·장애 조치를 제대로 설계해야 한다. 캐시로 쓸 때는 "날아가도 다시 채우면 된다" 는 전제로 설계하는 편이 안전하다.

## 이 사이트 사용법

- **학습 노트**: 목차 순서대로 읽는다. 기초 → 중급 → 심화.
- **실험실**: 노트에서 읽은 내용을 실제 Redis 로 확인한다. 실행된 명령과 응답을 그대로 보여준다.
- **콘솔**: 궁금한 명령을 바로 쳐 본다.
- **키 브라우저**: 실험이 만든 데이터가 어떻게 저장됐는지 들여다본다.
- **테스트**: 모든 실험은 vitest 테스트이기도 하다. `pnpm test` 로 한 번에 검증한다.

> 시작하기: 터미널에서 `pnpm redis` 로 서버를 띄우고 `pnpm dev` 로 이 사이트를 연다.

## 요청 하나가 처리되는 길

클라이언트가 `SET user:1:name alice` 를 보내면 서버 안에서 다음이 일어난다.

| 단계 | 하는 일 | 걸리는 시간(로컬 기준) |
|---|---|---|
| 1. 네트워크 | 클라이언트 → 서버 TCP 전송 | 루프백 ~30µs, 같은 AZ ~200µs |
| 2. 읽기 이벤트 | epoll 이 소켓 준비를 알리고 버퍼로 읽음 | 수 µs |
| 3. 파싱 | RESP 배열 `*3 $3 SET …` 을 명령·인자로 분해 | 1µs 미만 |
| 4. 실행 | 키 공간 dict 에서 해시 조회 → 값 저장 | 1µs 미만 |
| 5. 응답 버퍼 | `+OK\r\n` 을 클라이언트 출력 버퍼에 씀 | 1µs 미만 |
| 6. 쓰기 이벤트 | 다음 루프에서 소켓으로 전송 | 수 µs |

명령 실행(4)은 1µs 도 안 되는데 왕복(1·6)은 그 수십~수백 배다. 그래서 Redis 성능 이야기의 절반은 **왕복 횟수를 줄이는 이야기**다([파이프라인](/redis/notes/06-pipelining)). 나머지 절반은 **한 명령이 오래 잡고 있지 않게 하는 이야기**다(O(N) 명령, 큰 키, 긴 Lua).

```
$ redis-cli --latency            # 서버까지 왕복 지연 (PING 반복)
min: 0, max: 1, avg: 0.11 (1203 samples)
$ redis-cli --intrinsic-latency 5   # 서버가 도는 머신 자체의 지연(스케줄링·VM)
Max latency so far: 89 microseconds.
```

`--latency` 가 0.1ms 인데 앱에서 보는 지연이 5ms 라면, 문제는 Redis 가 아니라 **커넥션 풀 대기, 직렬화, 앱 이벤트 루프 지연** 쪽일 가능성이 크다. 이 구분이 장애 대응의 첫 질문이다([성능 공학 — 데이터 접근 병목](/performance/notes/05-data-access-bottlenecks)).

## 메모리 안의 모습 — 키 하나에 얼마나 드나

Redis 는 모든 키를 하나의 거대한 해시 테이블(dict)에 둔다. 키 하나는 대략 다음을 소비한다.

| 구성 | 크기(대략) |
|---|---|
| dict 엔트리 (키 포인터·값 포인터·next) | 24B |
| 키 문자열 (SDS 헤더 + 내용) | 3B + 키 길이 |
| 값 객체 (robj: 타입·인코딩·LRU·refcount·ptr) | 16B |
| 값 내용 | 인코딩에 따라 다름 |
| 만료가 있으면 expires dict 엔트리 | +24B 정도 |

그래서 `SET a 1` 같은 아주 작은 키도 **50~70바이트** 를 쓴다. 1억 개의 작은 키를 String 으로 두면 5~7GB 가 "오버헤드" 로 사라진다. 이걸 줄이는 기법(작은 Hash 로 묶기)은 [메모리 노트](/redis/notes/12-memory-performance)에서 다룬다.

```
127.0.0.1:6379> SET user:1:name alice
OK
127.0.0.1:6379> MEMORY USAGE user:1:name
(integer) 56
127.0.0.1:6379> OBJECT ENCODING user:1:name
"embstr"
```

## 단일 스레드라는데 CPU 를 몇 개 쓰나

"단일 스레드" 는 **명령 실행**에 대한 말이다. 프로세스 전체로 보면 스레드가 여러 개다.

| 스레드 | 역할 | 켜는 법 |
|---|---|---|
| 메인 스레드 | 이벤트 루프, 명령 실행, 만료, 축출 | 항상 |
| bio 스레드 3개 | 파일 close, AOF fsync, lazyfree(UNLINK) | 항상 |
| I/O 스레드 | 소켓 읽기·쓰기·파싱 병렬화 | `io-threads 4` (Redis 6+) |
| 자식 프로세스 | BGSAVE, BGREWRITEAOF (fork) | 영속성 설정에 따라 |

그래서 Redis 서버 한 대는 CPU 1코어를 꽉 채우면 한계다. 코어를 더 쓰려면 **샤딩(Cluster)** 하거나 한 머신에 인스턴스를 여러 개 띄운다. `INFO cpu` 의 `used_cpu_sys`·`used_cpu_user` 증가율이 1초당 1에 가까우면 그 인스턴스는 포화다.

## Redis 와 다른 선택지

| 상황 | Redis 가 맞나 | 대안 |
|---|---|---|
| 읽기 많은 캐시, ms 미만 응답 | 맞다 | Memcached(단순 문자열만, 멀티스레드) |
| 카운터·랭킹·세션·레이트리밋 | 맞다 | — |
| 내구성이 핵심인 원장·주문 | 원본으로는 부적합 | PostgreSQL([MVCC·WAL](/db-internals/notes/04-wal-checkpoint-recovery)) |
| 대용량 이벤트 로그, 재처리 | Stream 으로 가능하나 메모리 비용 | Kafka([메시징 비교](/messaging/notes/01-queue-topic-log-models)) |
| 전문 검색·복잡한 집계 | Redis Search 로 일부 | OpenSearch, ClickHouse |
| 데이터가 RAM 보다 큼 | 부적합 | 디스크 기반 KV(RocksDB 계열) |

판단 기준은 하나다. **"이 데이터가 날아가면 다시 만들 수 있나?"** 예라면 Redis 를 마음 편히 쓰고, 아니라면 원본은 다른 곳에 둔다.

## 예시로 보기 — 이 프로젝트에서

이 사이트 자체가 Redis 를 학습 기록 저장소로 쓴다. 콘솔에서 직접 들여다볼 수 있다.

| 키 | 타입 | 쓰는 코드 | 이유 |
|---|---|---|---|
| `progress:read` | Set | `src/lib/progress.ts` 의 `SADD/SREM` | 읽은 노트 "주제/slug" — 중복 없는 멤버십 |
| `progress:checks:<주제>/<slug>` | Hash | `HSET/HDEL` | 체크리스트 줄 번호 → 1 |
| `progress:lab` | Set | `SADD` | 성공한 실험 |
| `quiz:stats:<주제>` | Hash | `src/lib/study.ts` | 카드 키 → JSON(상자·기한) |
| `study:time:<주제>/<slug>` | String | `INCRBY` | 노트별 누적 학습 초 |
| `study:day:<날짜>` | Hash | `HINCRBY` + `EXPIRE 60일` | 일별 주제 합계, 오래되면 자동 소멸 |
| `alerts:recent` 류 | List | `LPUSH` + `LTRIM` | 최근 알림 N개만 유지(`src/lib/alerts.ts`) |

```
127.0.0.1:6379> TYPE progress:read
set
127.0.0.1:6379> SCARD progress:read
(integer) 12
127.0.0.1:6379> TTL study:day:2026-10-17
(integer) 5183987
```

여섯 가지 쓰임(카운터·멤버십·객체·만료·캡드 리스트)이 이미 다 들어 있다. 이 표를 들고 [자료구조 노트](/redis/notes/02-data-types)를 읽으면 "왜 이 키는 이 타입인가" 가 바로 보인다.

## 운영에서 처음 보는 지표

| 명령 | 볼 필드 | 의미 |
|---|---|---|
| `INFO server` | `redis_version`, `uptime_in_seconds` | 버전·재시작 여부 |
| `INFO clients` | `connected_clients`, `blocked_clients` | 커넥션 누수·블로킹 대기 |
| `INFO memory` | `used_memory_human`, `mem_fragmentation_ratio` | 메모리·단편화 |
| `INFO stats` | `instantaneous_ops_per_sec`, `keyspace_hits/misses` | 처리량·캐시 적중률 |
| `INFO persistence` | `rdb_last_bgsave_status`, `aof_last_write_status` | 영속화 실패 여부 |
| `SLOWLOG GET 10` | 실행 시간·명령 | 느린 명령 범인 |

이 지표들을 Prometheus 로 모으는 방법은 [관측성 — 계측과 익스포터](/observability/notes/03-instrumentation-exporters)에, 대시보드는 이 사이트 Grafana(13000)의 `study-redis` 에 있다.

## 실전에서는 어디에 쓰이나 — Redis 지도

> 실무에서 Redis 는 대개 "DB 앞의 빠른 보조 저장소" 다. 원본은 RDBMS 에 두고, 자주 읽히거나 짧게 살거나 원자적으로 세야 하는 데이터를 맡는다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 커머스 상품 상세·목록 캐시 | Cache-aside, TTL 지터, 스탬피드 방지 | [캐싱 패턴과 함정](/redis/notes/08-caching-patterns) |
| 웹·앱 로그인 세션 공유 | Hash + 슬라이딩 TTL, 역인덱스 Set | [실전 설계 레시피](/redis/notes/18-design-recipes) |
| 공개 API·AI 서비스 호출 한도 | Lua 고정 윈도우, 토큰 버킷 | [레이트 리미팅](/redis/notes/10-rate-limiting) |
| 모바일 게임 실시간 랭킹 | Sorted Set, 동점 처리 | [자료구조 다섯 가지와 그 이상](/redis/notes/02-data-types) |
| 선착순 쿠폰·재고 차감 | 원자 명령, Lua 조건부 차감 | [원자성 — MULTI/EXEC, WATCH, Lua](/redis/notes/05-transactions-lua) |
| 여러 Pod 의 배치 중복 실행 방지 | 토큰 락, 펜싱 토큰 | [분산 락](/redis/notes/09-distributed-lock) |
| 백그라운드 작업 큐·소규모 이벤트 전달 | List 신뢰 큐, Stream 컨슈머 그룹 | [메시징 — List, Pub/Sub, Stream](/redis/notes/07-pubsub-streams) |
| RAG·추천의 벡터 검색 | Redis 8 Query Engine 의 VECTOR 인덱스 | [Redis 8 내장 모듈](/redis/notes/15-redis8-modules) |

**회사 규모에 따라**
- 스타트업: 관리형 Redis 한 대(또는 앱 옆 컨테이너)에 캐시·세션·레이트리밋을 함께 둔다. 영속성은 끄거나 기본값으로 둔다.
- 성장기: 복제 + Sentinel(또는 관리형 HA)로 장애 조치를 붙이고, 원본성 데이터와 캐시를 인스턴스로 나눠 축출 정책을 분리한다.
- 대규모 조직: Cluster 로 샤딩하고 플랫폼 팀이 Redis 를 공용 서비스로 제공한다. 키 네임스페이스·ACL·용량 할당·big/hot key 감시가 운영 업무가 된다.

**이럴 땐 안 맞는다**
- 잃으면 안 되는 원장·주문의 원본 — 비동기 복제와 `everysec` 때문에 마지막 수 ms~1초가 사라질 수 있다. PostgreSQL 같은 RDBMS 에 둔다.
- 데이터가 RAM 보다 크거나, 오래 보존하며 재처리하는 이벤트 로그 — 디스크 기반 KV, Kafka.
- 복잡한 조인·임의 집계·전문 검색 — RDBMS, ClickHouse, OpenSearch.

**누가 매일 만나나** — 백엔드 개발자는 캐시 키·TTL·원자 연산을 설계할 때, SRE·플랫폼 엔지니어는 `used_memory`·`evicted_keys`·지연 알림이 울릴 때, ML 엔지니어는 피처·벡터 저장소로 붙일 때 만난다.

## 실습 체크리스트

- [ ] `redis-cli --latency` 와 `--intrinsic-latency 5` 를 실행해 두 값의 차이를 설명하기
- [ ] `SET a 1` 후 `MEMORY USAGE a` 로 작은 키 하나의 실제 크기를 확인하기
- [ ] 콘솔에서 `TYPE progress:read`, `SCARD progress:read`, `TTL study:day:<오늘>` 을 쳐서 이 사이트의 키를 읽기
- [ ] `INFO stats` 의 `keyspace_hits` / `keyspace_misses` 로 적중률을 계산하기
- [ ] 실험실의 String 기초 실험을 돌리고 INCR 이 왜 경쟁이 없는지 한 문장으로 쓰기
