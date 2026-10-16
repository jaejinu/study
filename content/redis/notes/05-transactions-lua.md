---
title: 원자성 — MULTI/EXEC, WATCH, Lua
order: 5
level: 중급
summary: 트랜잭션의 실제 의미(롤백 없음), 낙관적 락, 서버 사이드 스크립트로 원자적 로직 만들기
tags: [MULTI, EXEC, WATCH, Lua, 원자성, CAS]
experiments: [transaction-multi, watch-optimistic-lock, lua-atomic]
---

## 단일 명령은 이미 원자적

단일 스레드라서 `INCR`, `HINCRBY`, `ZADD`, `SET NX` 같은 명령 하나는 다른 클라이언트와 절대 섞이지 않는다.
문제는 **여러 명령을 조합**해야 할 때다: "재고를 읽고, 1 이상이면 감소".

## MULTI / EXEC

```
MULTI
DECR stock
LPUSH orders order:1
EXEC
```

- `MULTI` 뒤 명령은 **큐잉**되고 (`QUEUED` 응답), `EXEC` 에서 한 번에, 중간에 다른 클라이언트 명령 없이 실행된다.
- `DISCARD` 로 취소.

### RDBMS 트랜잭션과 다른 점

1. **롤백 없음.** 큐잉된 명령 중 하나가 실행 중 에러 나도 (예: 문자열에 `INCR`) 나머지는 그대로 실행된다.
2. **조건 분기 불가.** 앞 명령 결과를 보고 다음 명령을 결정할 수 없다 (결과는 EXEC 후에 온다).
3. 문법 오류(잘못된 명령어, 인자 수)는 큐잉 단계에서 거부되고 EXEC 전체가 실패한다.

"격리" 는 되지만 "원자적 롤백" 은 아니다. 그래서 Redis 문서도 transaction 보다 **"batch of commands executed atomically"** 로 설명한다.

## WATCH — 낙관적 락

읽은 값을 기반으로 쓰려면 그 사이 값이 바뀌지 않았어야 한다.

```
WATCH stock
val = GET stock          # 10
if val > 0:
  MULTI
  SET stock val-1
  EXEC                   # WATCH 이후 stock 이 바뀌었으면 (nil) → 재시도
```

- `WATCH` 한 키가 EXEC 전에 **다른 클라이언트에 의해** 변경되면 EXEC 는 `nil` 을 반환하고 아무것도 실행하지 않는다.
- Compare-And-Set 과 같은 아이디어. 충돌이 드물 때 효과적이고, 경쟁이 심하면 재시도가 반복된다.
- EXEC, DISCARD, 커넥션 종료 시 WATCH 는 해제된다.

실험실의 **WATCH 낙관적 락** 실험은 두 커넥션으로 이 충돌을 재현한다.

## Lua 스크립트 — 서버에서 분기하기

```
EVAL "
  local v = tonumber(redis.call('GET', KEYS[1]))
  if v and v > 0 then
    return redis.call('DECR', KEYS[1])
  end
  return -1
" 1 stock
```

- 스크립트 전체가 **하나의 명령처럼 원자적**으로 실행된다. WATCH 재시도 루프가 필요 없다.
- `KEYS[]` 와 `ARGV[]` 를 구분해서 넘긴다. 클러스터는 KEYS 로 슬롯을 판단하므로 키를 ARGV 에 숨기면 안 된다.
- `redis.call` 은 에러 시 스크립트를 중단, `redis.pcall` 은 에러를 값으로 돌려준다.
- 스크립트는 **결정적**이어야 한다. 난수·시각은 인자로 넘긴다 (복제·AOF 재생 일관성).

### 캐싱과 함수

```
SCRIPT LOAD "<script>"     # SHA1 반환
EVALSHA <sha> 1 stock      # 본문 대신 SHA 로 호출
SCRIPT EXISTS <sha>
```

클라이언트 라이브러리(ioredis 의 `defineCommand`)는 보통 EVALSHA 를 먼저 시도하고 `NOSCRIPT` 면 EVAL 로 폴백한다.
Redis 7 의 **Functions** (`FUNCTION LOAD`) 는 스크립트를 서버에 영속적으로 등록해 재시작·복제에도 유지된다.

### 주의

- 스크립트가 도는 동안 서버 전체가 멈춘다. 수 ms 이상 걸리는 로직은 넣지 말 것. `lua-time-limit`(5초) 넘으면 `SCRIPT KILL` 로 중단 가능 (쓰기 전까지).
- 큰 반복문, 큰 컬렉션 전체 조회는 금물.

## 선택 가이드

| 상황 | 도구 |
|---|---|
| 여러 명령을 그냥 묶어서 한 번에 | `MULTI/EXEC` (또는 파이프라인) |
| 읽은 값에 따라 쓰되 충돌이 드묾 | `WATCH` + `MULTI` |
| 읽고-판단하고-쓰기를 확실히 원자적으로 | Lua / Function |
| 분산 락 해제처럼 "내 것일 때만 삭제" | Lua |

## 실행 중 에러 vs 큐잉 중 에러 — 직접 보기

```
127.0.0.1:6379> SET name alice
OK
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379(TX)> INCR name          ← 문자열에 INCR: 문법은 맞으니 큐잉된다
QUEUED
127.0.0.1:6379(TX)> SET other 1
QUEUED
127.0.0.1:6379(TX)> EXEC
1) (error) ERR value is not an integer or out of range
2) OK                                   ← 앞 명령이 실패해도 실행됨, 롤백 없음

127.0.0.1:6379> MULTI
OK
127.0.0.1:6379(TX)> SETT x 1           ← 없는 명령: 큐잉 단계에서 거부
(error) ERR unknown command 'SETT'
127.0.0.1:6379(TX)> SET y 1
QUEUED
127.0.0.1:6379(TX)> EXEC
(error) EXECABORT Transaction discarded because of previous errors.
```

두 결과를 구분하는 것이 Redis 트랜잭션 이해의 전부다. **실행 시 에러는 "그 명령만" 실패**, 큐잉 시 에러는 "전체 취소" 다. 그래서 MULTI 안의 명령은 실패할 수 없는 것(타입이 확실한 키)만 넣는 것이 원칙이다.

## ACID 로 따져 보면

| 성질 | MULTI/EXEC | Lua / Function | 비고 |
|---|---|---|---|
| Atomicity(모두 또는 없음) | 부분 — 실행 에러 시 나머지 진행 | 부분 — `redis.call` 에러 전까지 쓴 것은 남음 | 롤백이 없다 |
| Consistency | 앱이 책임 | 스크립트가 검증 후 쓰면 보장 | |
| Isolation | 완전(직렬 실행) | 완전 | 단일 스레드 |
| Durability | 영속성 설정 따름 | 동일 | AOF 에는 MULTI…EXEC 로 기록, 재시작 시 반쪽만 있으면 버림 |

Lua 에서 "검증 먼저, 쓰기는 마지막에" 를 지키면 사실상 원자적이 된다. 쓰기 도중 에러가 날 일은 타입 오류 정도라 검증으로 막을 수 있다.

## 예시 — 재고 차감을 세 가지로

```js
// 1) WATCH 재시도 (ioredis)
async function buyWatch(r, key) {
  for (let i = 0; i < 5; i++) {
    await r.watch(key);
    const stock = Number(await r.get(key));
    if (stock <= 0) { await r.unwatch(); return false; }
    const res = await r.multi().decr(key).exec();   // null 이면 충돌
    if (res) return true;
  }
  throw new Error("too much contention");
}

// 2) Lua — 재시도 없음
r.defineCommand("buy", { numberOfKeys: 1, lua: `
  local s = tonumber(redis.call('GET', KEYS[1]) or '0')
  if s <= 0 then return 0 end
  redis.call('DECR', KEYS[1]); return 1` });
await r.buy("stock:42");

// 3) 단일 명령으로 바꿀 수 있으면 그게 최선
const left = await r.decr("stock:42");
if (left < 0) await r.incr("stock:42");   // 초과 차감 보정 (음수 허용 설계)
```

| 방식 | 경쟁 많을 때 | 지연 | 복잡도 |
|---|---|---|---|
| WATCH | 재시도 폭발, 처리량 급락 | 여러 RTT | 중 |
| Lua | 일정 | 1 RTT | 중(스크립트 관리) |
| 단일 명령 + 보정 | 일정 | 1~2 RTT | 낮음, 대신 잠깐 음수 노출 |

실험실의 **WATCH 낙관적 락** 과 **Lua 원자성** 실험이 같은 문제를 두 방식으로 푼다.

## Lua 의 실전 함정

| 함정 | 증상 | 대처 |
|---|---|---|
| 키를 ARGV 로 넘김 | 클러스터에서 `CROSSSLOT` 혹은 다른 노드에서 실행 | 접근하는 모든 키는 KEYS 로 |
| 스크립트 안에서 `TIME`·난수 | 예전 버전은 복제 불일치 | 효과 복제(Redis 5+ 기본)라 지금은 안전하지만, 인자로 넘기는 습관이 이식성↑ |
| 긴 루프 | `BUSY Redis is busy running a script` 를 모든 클라이언트가 받음 | 작업을 쪼개 여러 번 호출 |
| `SCRIPT FLUSH` / 재시작 후 | `NOSCRIPT` | 클라이언트가 EVAL 로 폴백(ioredis 자동) 또는 Functions |
| 큰 반환값 | 네트워크·메모리 급증 | 필요한 것만 반환 |

`SLOWLOG GET` 에는 스크립트 전체가 `EVALSHA` 한 줄로 기록된다. 스크립트가 느린지 보려면 SLOWLOG 의 duration 을 본다.

## Functions — 스크립트를 "배포" 하기

```
127.0.0.1:6379> FUNCTION LOAD "#!lua name=shop
redis.register_function('buy', function(keys, args)
  local s = tonumber(redis.call('GET', keys[1]) or '0')
  if s <= 0 then return 0 end
  redis.call('DECR', keys[1]); return 1
end)"
"shop"
127.0.0.1:6379> FCALL buy 1 stock:42
(integer) 1
127.0.0.1:6379> FUNCTION LIST
```

Functions 는 RDB·AOF·복제에 포함된다. 즉 **스키마 마이그레이션처럼** 버전 관리하고 배포한다. 앱 배포와 함수 배포 순서가 어긋나면 `ERR Function not found` 가 나므로, 함수를 먼저 배포하고 앱이 쓰도록 한다(확장-축소 전략, [SRE — 변경 관리](/sre/notes/06-capacity-release-change)).

## 다른 시스템과 비교

| | Redis MULTI/Lua | PostgreSQL 트랜잭션 | 분산 트랜잭션(2PC) |
|---|---|---|---|
| 격리 | 직렬(단일 스레드) | MVCC + 격리 수준 | 코디네이터 |
| 롤백 | 없음 | 있음 | 있음(비싸게) |
| 여러 노드 | 같은 슬롯만 | 한 DB | 여러 DB |
| 비용 | µs | ms | 수십 ms + 블로킹 위험 |

여러 저장소를 묶어야 하면 트랜잭션 대신 **사가와 보상**, **아웃박스** 를 쓴다([분산 시스템 — 트랜잭션과 코디네이션](/distributed-systems/notes/06-transactions-coordination)).

## 예시로 보기 — 이 프로젝트에서

`src/lib/study.ts` 의 퀴즈 기록은 "HGET → 계산 → HSET" 이다.

```ts
const prevRaw = await r.hget(field, key);      // ① 읽기
const next = compute(prevRaw, right);          // ② 앱에서 계산
await r.hset(field, key, JSON.stringify(next)); // ③ 쓰기
```

한 사용자가 한 카드를 동시에 두 번 답할 일은 거의 없어 이대로도 충분하다. 만약 여러 탭에서 같은 카드를 동시에 채점한다면 ①~③ 사이에 끼어들어 한 답이 유실된다. 해결책은 위 표 그대로다 — `WATCH quiz:stats:redis` 로 감싸거나, 상자 계산을 Lua 로 옮긴다. "드물면 WATCH, 잦으면 Lua" 를 이 코드로 연습해 보자.

## 실습 체크리스트

- [ ] MULTI 안에서 문자열에 INCR 을 넣어 실행 에러가 나도 다음 명령이 실행되는 것 확인하기
- [ ] 없는 명령으로 EXECABORT 가 나는 것 확인하기
- [ ] 두 콘솔 창으로 WATCH 충돌을 만들어 EXEC 가 nil 을 돌려주는 것 보기
- [ ] 재고 차감을 Lua 로 작성해 `EVALSHA` 로 호출하고 `SLOWLOG GET` 에서 확인하기
- [ ] `FUNCTION LOAD` 로 함수를 등록하고 서버를 재시작한 뒤에도 남아 있는지 확인하기
