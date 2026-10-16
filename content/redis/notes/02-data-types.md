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
