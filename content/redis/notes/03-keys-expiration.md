---
title: 키 만료와 메모리 축출
order: 3
level: 기초
summary: TTL 동작 원리, 만료 키 삭제 방식, maxmemory 와 축출 정책(LRU/LFU)
tags: [TTL, 만료, maxmemory, eviction, LRU, LFU]
experiments: [expire-ttl, keyspace-notifications]
---

## TTL 설정하기

```
SET session:abc data EX 3600      # 초
SET flash hi PX 500               # 밀리초
EXPIRE key 60                     # 기존 키에 추가
EXPIREAT key 1760000000           # 절대 시각(unix)
TTL key        # 남은 초. -1: 만료 없음, -2: 키 없음
PTTL key       # 밀리초
PERSIST key    # 만료 제거
EXPIRETIME key # 만료 예정 시각
```

Redis 7 부터 `EXPIRE key 60 NX|XX|GT|LT` 옵션으로 "만료가 없을 때만", "더 길어질 때만" 같은 조건을 줄 수 있다.

## 값을 덮어쓰면 TTL 은?

- `SET`, `GETSET`, `MSET` 등 **값을 통째로 바꾸는 명령은 TTL 을 제거**한다.
- `INCR`, `LPUSH`, `HSET` 등 **값을 수정하는 명령은 TTL 을 유지**한다.
- `SET key value KEEPTTL` 로 덮어쓰면서 TTL 을 유지할 수 있다.
- `RENAME` 은 TTL 을 유지한다.

실수하기 쉬운 지점이다. 캐시 갱신 로직에서 `SET` 만 호출하면 영원히 안 지워지는 키가 생긴다.

## 만료 키는 언제 삭제되나

Redis 는 만료 시각을 별도 딕셔너리에 저장하고 두 방식으로 삭제한다.

1. **Lazy (passive)**: 키에 접근할 때 만료됐으면 지우고 없는 것처럼 응답한다.
2. **Active**: 100ms 마다 만료 딕셔너리에서 무작위로 20개를 샘플링해 만료된 것을 지운다. 25% 이상이 만료 상태면 반복한다.

따라서 `TTL` 이 0이 된 직후에도 메모리에는 잠깐 남아 있을 수 있지만, **외부에서 관찰되는 동작은 항상 만료된 것처럼** 보인다.

복제 환경에서는 **마스터만** 만료를 결정하고 레플리카에는 `DEL` 을 전파한다. 레플리카에서 읽을 때 잠시 만료된 값이 보일 수 있었던 이유인데, 지금은 레플리카도 논리적으로 만료 처리해서 응답한다.

## maxmemory 와 축출 정책

메모리가 `maxmemory` 에 도달하면 설정된 **eviction policy** 에 따라 키를 지운다.

| 정책 | 대상 | 설명 |
|---|---|---|
| `noeviction` | - | 기본값. 쓰기 명령이 에러 (OOM) |
| `allkeys-lru` | 모든 키 | 가장 오래 안 쓴 키 제거. **캐시 용도 추천** |
| `volatile-lru` | TTL 있는 키 | TTL 있는 것 중 LRU |
| `allkeys-lfu` | 모든 키 | 가장 적게 쓴 키 제거 (Redis 4+) |
| `volatile-lfu` | TTL 있는 키 | |
| `allkeys-random` / `volatile-random` | | 무작위 |
| `volatile-ttl` | TTL 있는 키 | 만료가 가장 가까운 키 |

- Redis 의 LRU 는 **근사 LRU** 다. 전체 정렬이 아니라 `maxmemory-samples`(기본 5)개를 샘플링해 그중 가장 오래된 것을 지운다. 10 정도로 올리면 정확도가 올라간다.
- **LFU** 는 접근 빈도를 로그 스케일 카운터로 추적한다. "오래됐지만 자주 쓰는" 핫 키를 지키고 싶으면 LFU.
- `volatile-*` 정책에서 TTL 있는 키가 없으면 `noeviction` 처럼 동작한다.

이 프로젝트의 `redis/redis.conf` 는 `maxmemory 256mb`, `allkeys-lru` 로 설정되어 있다.

```
CONFIG GET maxmemory-policy
INFO memory          # used_memory, evicted_keys 확인
INFO stats           # expired_keys, evicted_keys
```

## 실전 팁

- **TTL 지터**: 같은 시각에 대량 생성된 캐시가 동시에 만료되면 DB 에 부하가 몰린다. `EX 3600 + rand(0..300)` 처럼 흩뿌린다.
- **큰 키 삭제**: `DEL` 은 동기적이라 큰 컬렉션 삭제가 서버를 멈춘다. `UNLINK` 는 백그라운드 스레드에서 해제한다. 만료 시에도 `lazyfree-lazy-expire yes` 로 비동기 해제 가능.
- **키 전체에 TTL 이 없는지 점검**: `INFO keyspace` 의 `expires` 수와 `keys` 수를 비교한다.
