---
title: 자료구조 다섯 가지와 그 이상
order: 2
level: 기초
summary: String, List, Hash, Set, Sorted Set 의 쓰임과 시간 복잡도, 내부 인코딩
tags: [자료구조, String, List, Hash, Set, SortedSet]
experiments: [strings-basics, list-queue, hash-object, set-ops, zset-leaderboard, geo-search, encodings-scan]
---

## 키 설계 먼저

Redis 는 네임스페이스가 없다. 관례적으로 콜론으로 계층을 표현한다.

```
user:1001            # 사용자 객체 (Hash)
user:1001:followers  # 팔로워 집합 (Set)
post:42:views        # 조회수 (String 카운터)
rank:daily:2026-10-16  # 일간 랭킹 (ZSet)
```

- 키는 바이너리 안전, 최대 512MB 지만 **짧게** 유지하자 (메모리, 네트워크).
- 패턴 검색(`SCAN MATCH user:*`)을 염두에 두고 접두어를 일관되게.
- 클러스터에선 `{user:1001}:profile` 처럼 **해시태그** 로 같은 슬롯에 묶을 수 있다.

## String

가장 기본. 문자열, 정수, 직렬화된 JSON, 바이너리(이미지)까지 뭐든 넣는다.

| 명령 | 복잡도 | 용도 |
|---|---|---|
| `SET` / `GET` | O(1) | 값 저장/조회 |
| `SET k v EX 60 NX` | O(1) | 만료·조건부 설정 (락, 캐시) |
| `INCR` / `INCRBY` / `INCRBYFLOAT` | O(1) | 원자적 카운터 |
| `MSET` / `MGET` | O(N) | 여러 키 한 번에 |
| `APPEND`, `GETRANGE`, `SETRANGE` | O(1)~O(N) | 부분 조작 |
| `SETBIT` / `GETBIT` / `BITCOUNT` | O(1)/O(N) | 비트맵 |

내부 인코딩: 정수는 `int`, 44바이트 이하는 `embstr` (객체와 한 번에 할당), 그 이상은 `raw`.

## List

양방향 연결 리스트. 양 끝 삽입/삭제는 O(1), 중간 접근은 O(N).

```
LPUSH queue job        # 왼쪽 삽입
RPOP queue             # 오른쪽 꺼내기 → FIFO 큐
LRANGE timeline 0 9    # 최근 10개
LTRIM timeline 0 99    # 100개만 유지
BRPOP queue 5          # 5초까지 블로킹 대기
BLMOVE src dst RIGHT LEFT 0   # 안전한 큐 (처리 중 리스트로 이동)
```

- 작업 큐, 최근 활동 타임라인, 채팅 메시지 버퍼.
- Redis 7 부터 내부는 **quicklist** (listpack 노드들의 연결). 작으면 listpack 하나.
- 메시지 유실 없는 큐가 필요하면 List 보다 [Stream](/redis/notes/07-pubsub-streams) 을 고려.

## Hash

필드-값 쌍의 집합. 객체 하나를 표현할 때 쓴다.

```
HSET user:1 name alice age 30
HGET user:1 name
HMGET user:1 name age
HGETALL user:1          # 필드 많으면 주의 (O(N))
HINCRBY user:1 age 1
HSCAN user:1 0 COUNT 100   # 큰 해시는 SCAN
```

JSON 문자열 vs Hash:
- 필드 단위 읽기/갱신/증가가 필요하면 Hash.
- 통째로 읽고 쓰기만 하고 중첩 구조가 있으면 JSON String (또는 RedisJSON 모듈).

Hash 는 필드 수 ≤ 512, 값 길이 ≤ 64바이트면 `listpack` 으로 매우 작게 저장된다. 대량의 작은 객체를 저장할 때 메모리 차이가 크다.

## Set

순서 없는 유일 문자열 집합. `SISMEMBER` 가 O(1).

```
SADD tags:post:1 redis cache
SISMEMBER tags:post:1 redis
SINTER tags:post:1 tags:post:2    # 교집합
SUNIONSTORE result a b            # 결과를 키에 저장
SRANDMEMBER lottery 3             # 랜덤 추출
SPOP lottery                      # 랜덤 꺼내기
```

- 태그, 팔로우 관계, 중복 제거, 이미 처리한 ID 추적.
- 집합 연산은 O(N·M) 이라 큰 집합끼리는 조심.
- 정수만 있으면 `intset`, 작으면 `listpack`, 아니면 `hashtable`.

## Sorted Set (ZSet)

멤버마다 double **score** 가 있고 항상 정렬 상태를 유지한다. skiplist + hashtable 조합으로 삽입·순위·범위 조회가 모두 O(log N).

```
ZADD rank 100 alice 250 bob
ZINCRBY rank 10 alice
ZREVRANGE rank 0 9 WITHSCORES     # 상위 10
ZRANK rank alice                  # 순위 (0부터)
ZRANGEBYSCORE rank 100 200 LIMIT 0 10
ZRANGE rank (100 +inf BYSCORE     # 100 초과
ZREMRANGEBYSCORE delayed -inf <now>   # 만료된 지연 작업 꺼내기
```

- 리더보드, 우선순위 큐, 지연 큐(score=실행 시각), 슬라이딩 윈도우 카운터, 시계열 인덱스.
- 같은 score 면 멤버 사전순.

## 그 밖의 타입

| 타입 | 기반 | 용도 |
|---|---|---|
| Bitmap | String | 출석·플래그, 1억 명 = 12.5MB |
| HyperLogLog | String | 근사 유니크 카운트, 12KB 고정 |
| Geo | ZSet | 반경 검색, 거리 계산 |
| Stream | radix tree | 로그, 컨슈머 그룹 메시징 |
| Bitfield | String | 임의 비트 폭 정수 배열 |

## 타입 고르기 체크리스트

1. 멤버 존재 여부만 필요? → Set (정확) / Bloom filter 모듈 (근사)
2. 정렬·순위·범위? → Sorted Set
3. 객체의 일부 필드만 갱신? → Hash
4. 순서 있는 큐? → List (단순) / Stream (내구성·그룹)
5. 개수만 세면 되고 멤버는 필요 없음? → HyperLogLog
6. ID 가 조밀한 정수이고 true/false 만? → Bitmap

> 실험실에서 **내부 인코딩과 SCAN** 실험을 돌려 보면 같은 타입이 값 크기에 따라 다른 인코딩을 쓰는 것을 직접 볼 수 있다.

## 인코딩 — 같은 타입, 다른 몸

Redis 는 각 타입을 **작을 때는 압축 형태로, 커지면 빠른 형태로** 저장한다. 이 전환은 자동이고 한 방향(작게 → 크게)이다. 다시 줄어도 작은 인코딩으로 돌아가지 않는다(재작성 전까지).

![인코딩 전환](/diagrams/redis-encodings.svg)

| 타입 | 작을 때 | 커지면 | 전환 기준(기본값) |
|---|---|---|---|
| String | `int` / `embstr` | `raw` | 정수 아님 + 44바이트 초과 |
| List | `listpack` | `quicklist` | 원소 128개 또는 원소 64바이트 초과 |
| Hash | `listpack` | `hashtable` | 필드 128개(`hash-max-listpack-entries`) 또는 값 64바이트 초과 |
| Set | `intset` / `listpack` | `hashtable` | 정수 아니고 128개 초과, 또는 정수 512개 초과 |
| ZSet | `listpack` | `skiplist` + `hashtable` | 원소 128개 또는 멤버 64바이트 초과 |

> 버전마다 기본값이 조금 다르다(512 → 128 등). `CONFIG GET *max-listpack*` 로 내 서버 값을 확인하자.

**listpack** 은 원소들을 한 줄로 이어 붙인 바이트 배열이다. 포인터가 없어 메모리를 1/5~1/10 로 쓰지만, 조회가 O(N) 이다. N 이 128 이하면 캐시에 한 번에 올라와서 O(N) 이라도 해시 테이블보다 빠르기까지 하다. 기준값을 1만으로 올리면 메모리는 더 아끼지만 `HGET` 이 선형 탐색이 되어 CPU 가 튄다.

```
127.0.0.1:6379> HSET small f1 v1
(integer) 1
127.0.0.1:6379> OBJECT ENCODING small
"listpack"
127.0.0.1:6379> HSET small f2 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
(integer) 1
127.0.0.1:6379> OBJECT ENCODING small
"hashtable"          ← 값 하나가 64바이트를 넘자 전체가 전환
127.0.0.1:6379> MEMORY USAGE small
(integer) 352        ← listpack 일 때 ~80 에서 4배
```

## 시간 복잡도 — "N 이 뭐냐" 를 늘 물어라

| 명령 | 복잡도 | N 의 정체 | 위험한 경우 |
|---|---|---|---|
| `LRANGE k 0 -1` | O(S+N) | 반환 원소 수 | 100만 원소 리스트 전체 |
| `LINDEX k 50000` | O(N) | 인덱스까지 거리 | 큰 리스트 중간 접근 |
| `HGETALL` | O(N) | 필드 수 | 필드 10만 개 해시 |
| `SMEMBERS` | O(N) | 멤버 수 | 큰 집합 |
| `SINTER a b` | O(N·M) | 가장 작은 집합 크기 × 집합 수 | 큰 집합끼리 |
| `ZRANGEBYSCORE` | O(log N + M) | M = 반환 수 | `LIMIT` 없이 넓은 범위 |
| `DEL big` | O(N) | 원소 수 | 큰 컬렉션 → `UNLINK` 사용 |
| `ZADD` / `ZRANK` | O(log N) | 원소 수 | 거의 안전 |

**큰 키(big key)** 는 그 자체로 장애 원인이다. 한 명령이 수십 ms 를 잡고, 복제·마이그레이션·삭제가 모두 느려진다. 찾는 법:

```
$ redis-cli --bigkeys          # 타입별 가장 큰 키 (SCAN 기반, 운영에서도 비교적 안전)
$ redis-cli --memkeys          # 메모리 기준 상위
127.0.0.1:6379> MEMORY USAGE timeline:global SAMPLES 0
```

## 타입별 함정 모음

| 타입 | 함정 | 대처 |
|---|---|---|
| String | 큰 JSON 을 통째로 GET/SET → 일부만 바꿔도 전체 전송 | 필드 갱신이 잦으면 Hash, 중첩이면 RedisJSON |
| String | `SET` 이 TTL 을 지움 | `SET … KEEPTTL` 또는 `SET … EX` 를 항상 함께 |
| List | 끝없이 커지는 타임라인 | `LPUSH` 직후 `LTRIM 0 999` 로 캡 |
| List | `RPOP` 후 처리 중 죽으면 작업 유실 | `BLMOVE` 로 처리 중 리스트, 또는 Stream |
| Hash | 필드별 TTL 이 없다고 생각 | Redis 7.4+ `HEXPIRE` 로 필드 TTL 가능 |
| Set | 집합 연산 결과를 매번 계산 | `SINTERSTORE` + TTL 로 결과 캐시 |
| ZSet | score 가 double — 큰 정수(2^53 초과)는 정밀도 손실 | ID 는 멤버로, 시간은 ms 정수 정도로 |
| ZSet | 같은 score 동률 정렬이 멤버 사전순 | 동률 처리 규칙을 score 에 인코딩(예: 점수·10^6 + 역시간) |

## Stream 은 왜 따로 있나

List 로도 큐를 만들 수 있지만, 메시지가 **한 번 꺼내면 사라진다**. Stream 은 로그처럼 남고 컨슈머 그룹이 읽은 위치를 기억한다. Kafka 의 아이디어를 메모리 안에 작게 옮긴 것이다.

| 비교 | List 큐 | Pub/Sub | Stream |
|---|---|---|---|
| 메시지 보존 | 꺼내면 삭제 | 저장 안 함 | 보존(`MAXLEN` 으로 캡) |
| 소비자 여럿 | 경쟁(한 명만) | 팬아웃(모두) | 그룹별 경쟁 + 그룹 간 팬아웃 |
| 처리 확인 | 없음 | 없음 | `XACK`, 미확인 목록 `XPENDING` |
| 재처리 | 불가 | 불가 | ID 로 다시 읽기 |

자세한 비교는 [Pub/Sub 과 Stream](/redis/notes/07-pubsub-streams)과 [메시징 — 큐·토픽·로그 모델](/messaging/notes/01-queue-topic-log-models)에 있다.

## 예시로 보기 — 이 프로젝트에서

| 쓰임 | 이 사이트의 키 | 왜 이 타입인가 |
|---|---|---|
| 읽은 노트 목록 | `progress:read` (Set) | "읽었나?" 는 멤버십, 중복 불가 |
| 체크리스트 상태 | `progress:checks:redis/02-data-types` (Hash) | 줄 번호별 on/off, 필드 단위 HDEL |
| 퀴즈 복습 상태 | `quiz:stats:redis` (Hash, 값은 JSON) | 카드 키로 바로 찾고 통째로 갱신 |
| 노트 학습 시간 | `study:time:redis/02-data-types` (String) | INCRBY 원자 카운터 |
| 최근 알림 | List + LTRIM | 최신 N 개만, 순서 유지 |

만약 "주제별 읽은 수" 를 자주 센다면 지금처럼 Set 하나를 전부 읽어 접두어로 나누는 대신 `progress:read:<주제>` 로 나누고 `SCARD` 만 쓰는 편이 O(1) 이다. 이 사이트는 노트가 수백 개 수준이라 하나의 Set 으로 충분하다 — 타입 선택은 항상 **규모**와 **접근 패턴**의 함수다.

## 실전에서는 어디에 쓰이나

> 자료구조 선택은 "이 데이터에 어떤 질문을 던지나" 로 정해진다. 실무에서 Redis 설계 리뷰의 절반은 타입과 키 이름을 고르는 일이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 모바일 게임 리더보드 | 점수 갱신과 순위 조회를 둘 다 빠르게 | ZSet `ZINCRBY` + `ZREVRANK`, 동점 규칙은 score 에 인코딩 | DB `ORDER BY … LIMIT` 은 갱신이 잦으면 인덱스 부담 |
| SNS 팔로우·태그 | "이미 팔로우했나", 공통 관심사 | Set `SISMEMBER`, 작은 집합끼리 `SINTER` | RDBMS 조인, 그래프 DB |
| 커머스 사용자 프로필 캐시 | 필드 일부만 자주 갱신 | Hash `HSET`/`HINCRBY`, listpack 범위 유지 | JSON String 통째 저장 (부분 갱신 불가) |
| 사내 알림함 | 최근 N개만 순서대로 | List `LPUSH` + `LTRIM` 캡 | Stream (ACK·재처리가 필요할 때) |
| 미디어 조회수 | 초당 많은 증가를 DB 쓰기 없이 | String `INCR`, 주기적으로 DB 반영 | DB `UPDATE … SET n = n + 1` 은 핫 로우 경합 |

**이럴 땐 안 맞는다**
- 한 키에 멤버가 수십만 이상 쌓이는 설계 — big key 가 되어 `HGETALL`·`DEL` 이 서버를 멈춘다. 키를 샤딩하거나 원본을 DB 에 둔다.
- 여러 조건을 조합한 조회(가격 범위 + 카테고리 + 정렬) — 기본 타입으로 인덱스를 손수 유지하기 어렵다. RDBMS 나 Redis Query Engine.

**누가 매일 만나나** — 백엔드 개발자가 새 기능의 키 이름·타입을 정할 때, SRE 가 `--bigkeys` 로 메모리를 잡아먹는 키를 찾을 때.

**면접·실무 단골 질문**
- Q. ZSet 의 순위·범위 조회가 왜 O(log N) 인가 → skiplist + hashtable 조합, `ZSCORE` 는 해시로 O(1).
- Q. 객체를 JSON String 과 Hash 중 무엇으로 → 필드 단위 갱신 여부·중첩 구조, 인코딩에 따른 메모리 차이.

## 실습 체크리스트

- [ ] `HSET` 으로 작은 해시를 만들고 64바이트 넘는 값을 넣어 `OBJECT ENCODING` 이 바뀌는 순간 보기
- [ ] 같은 데이터를 String(JSON) 과 Hash 로 저장해 `MEMORY USAGE` 비교하기
- [ ] `redis-cli --bigkeys` 를 실행해 가장 큰 키를 찾기
- [ ] `ZADD` 로 동점자를 만들고 정렬 순서가 멤버 사전순인지 확인하기
- [ ] 실험실의 내부 인코딩·SCAN 실험과 리더보드 실험을 돌리고 결과를 이 노트의 표와 맞춰 보기
