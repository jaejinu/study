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
