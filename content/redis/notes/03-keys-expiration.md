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

## 능동 만료를 그림으로

![키 만료 샘플링](/diagrams/redis-expire-sampling.svg)

능동 만료(active expire cycle)는 `hz`(기본 10, 즉 초당 10번) 주기로 돈다. 한 번에:

1. TTL 이 있는 키 사전(expires)에서 **무작위 20개**를 뽑는다.
2. 만료된 것을 지운다.
3. 지운 비율이 **25% 를 넘으면** 1로 돌아가 반복한다(최대 시간 예산까지, 기본 CPU 25%).

이 설계 때문에 생기는 성질:

| 성질 | 결과 |
|---|---|
| 만료 키가 많지 않으면 | 대부분 lazy 로 지워지고 메모리에 조금 남는다 |
| 한꺼번에 대량 만료되면 | 25% 규칙으로 루프가 길게 돌며 **지연 스파이크** |
| 아무도 접근 안 하는 만료 키 | 샘플링에 걸릴 때까지 메모리 점유 |

```
127.0.0.1:6379> INFO stats
expired_keys:1832
expired_stale_perc:0.52        ← 샘플 중 이미 만료된 비율 추정
expired_time_cap_reached_count:3   ← 시간 예산을 다 써서 멈춘 횟수(높으면 대량 만료)
expire_cycle_cpu_milliseconds:412
```

`expired_time_cap_reached_count` 가 늘고 있다면 같은 시각에 만료되는 키가 많다는 신호다 — TTL 지터를 넣자.

## 축출(eviction)이 일어나는 순간

축출은 **쓰기 명령이 들어와 메모리가 maxmemory 를 넘을 때** 그 명령을 실행하기 전에 일어난다. 즉, 축출 비용은 그 쓰기 요청의 지연에 그대로 더해진다.

```
used_memory > maxmemory ?
  └─ 예 → 정책에 따라 후보 샘플링 → 가장 나쁜 키 삭제 → 다시 확인 (필요한 만큼)
         └─ 지울 게 없음(noeviction 또는 volatile-* 인데 TTL 키 없음) → "-OOM command not allowed"
```

| 지표 | 의미 | 경보 기준 예 |
|---|---|---|
| `evicted_keys` 증가율 | 초당 축출 수 | 캐시라면 정상일 수 있음, 세션 저장소라면 사고 |
| `used_memory / maxmemory` | 여유 | 90% 지속 |
| `mem_fragmentation_ratio` | RSS / used_memory | 1.5 초과 지속이면 `activedefrag yes` 검토 |
| `rejected_connections`, OOM 에러 로그 | 쓰기 거부 | 1 이상 |

**주의**: maxmemory 는 Redis 의 데이터 메모리 기준이고, 복제 버퍼·클라이언트 출력 버퍼·fork 의 COW 복사는 포함되지 않는다. 컨테이너 메모리 한도를 maxmemory 와 같게 잡으면 BGSAVE 중 OOMKilled 가 난다. 보통 **컨테이너 한도의 60~75%** 로 maxmemory 를 둔다([운영체제 — cgroup 과 OOM](/os-internals/notes/03-scheduler-cgroups)).

## LRU vs LFU — 어떤 키를 지킬 것인가

| 접근 패턴 | LRU 결과 | LFU 결과 |
|---|---|---|
| 최근 본 것을 또 본다(뉴스 피드) | 잘 맞음 | 오래된 인기 글을 너무 오래 지킴 |
| 매일 조금씩 꾸준히 보는 핫 키 + 한 번 훑는 배치 스캔 | 스캔이 핫 키를 밀어냄(**캐시 오염**) | 빈도가 높은 핫 키를 지킴 |
| 유행이 빠르게 바뀜 | 잘 맞음 | `lfu-decay-time` 으로 감쇠를 빨리 해야 함 |

LFU 카운터는 8비트 로그 카운터다. `lfu-log-factor`(기본 10)가 클수록 카운터가 천천히 오르고, `lfu-decay-time`(분)마다 반감된다.

```
127.0.0.1:6379> CONFIG SET maxmemory-policy allkeys-lfu
127.0.0.1:6379> OBJECT FREQ hot:key
(integer) 47
127.0.0.1:6379> OBJECT IDLETIME cold:key     # LRU 정책일 때 마지막 접근 후 초
(integer) 3601
```

## TTL 설계 레시피

| 데이터 | TTL 전략 | 이유 |
|---|---|---|
| 캐시된 DB 행 | 5~60분 + 지터 10% | 신선도와 적중률의 균형, 동시 만료 방지 |
| 세션 | 30분, 접근할 때마다 `EXPIRE` 갱신(슬라이딩) | 활동 중엔 유지 |
| 레이트리밋 카운터 | 윈도우 길이와 같게 | 윈도우 끝에 자동 리셋 |
| 분산 락 | 작업 예상 시간 × 2~3 | 죽은 소유자 자동 해제([분산 락](/redis/notes/09-distributed-lock)) |
| 일별 집계 | 보존 기간(예: 60일) | 정리 작업 없이 자동 소멸 |
| 멱등 키 | 재시도 가능 기간(24시간 등) | 오래된 키 정리 |

## 예시로 보기 — 이 프로젝트에서

`src/lib/study.ts` 는 일별 학습 시간 Hash 를 이렇게 다룬다.

```ts
const dayKey = `study:day:${day()}`;
await Promise.all([
  r.incrby(`study:time:${subject}/${slug}`, seconds),   // TTL 없음 — 누적 기록
  r.hincrby(dayKey, subject, seconds),                 // HINCRBY 는 TTL 을 지우지 않는다
  r.expire(dayKey, 60 * 86_400),                       // 60일 뒤 자동 삭제
]);
```

- `HINCRBY` 는 "값을 수정하는 명령" 이라 기존 TTL 을 유지한다. 그래서 매번 `EXPIRE` 를 다시 걸어도, 걸지 않아도 결과는 같다. 다시 거는 이유는 **키가 처음 생길 때** TTL 을 붙이기 위해서다.
- 만약 이 코드를 `SET dayKey json` 으로 바꿨다면, 매 갱신마다 TTL 이 지워져 60일 뒤에도 남는 키가 쌓였을 것이다 — 위 "값을 덮어쓰면 TTL 은?" 의 함정 그대로다.
- `study:time:*` 는 TTL 이 없다. 영구 기록이고 개수가 노트 수만큼이라 작다. `INFO keyspace` 에서 `keys` 와 `expires` 의 차이가 바로 이런 키들이다.

```
127.0.0.1:6379> INFO keyspace
db0:keys=412,expires=63,avg_ttl=2941830211
```

## 실습 체크리스트

- [ ] `SET k v EX 100` 후 `SET k v2` 를 해서 TTL 이 -1 이 되는 것, `SET k v3 KEEPTTL` 로는 유지되는 것 확인하기
- [ ] `HINCRBY` 를 해도 TTL 이 유지되는지 확인하기
- [ ] 키 1만 개를 같은 TTL(5초)로 만든 뒤 `INFO stats` 의 `expired_time_cap_reached_count` 변화를 보기
- [ ] `CONFIG SET maxmemory 5mb` + `allkeys-lru` 로 키를 계속 넣어 `evicted_keys` 가 오르는 것을 보고 원복하기
- [ ] 실험실의 만료·TTL 실험과 키스페이스 알림 실험을 돌리기
