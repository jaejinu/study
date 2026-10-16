---
title: 레이트 리미팅
order: 10
level: 중급
summary: 고정 윈도우, 슬라이딩 로그, 슬라이딩 카운터, 토큰 버킷을 Redis 로 구현하는 법과 정확도·비용 비교
tags: [rate-limit, 고정윈도우, 슬라이딩윈도우, 토큰버킷, Lua]
experiments: [rate-limiter]
---

## 고정 윈도우 (Fixed Window)

```
key = rl:{user}:{floor(now/60)}
n = INCR key
if n == 1: EXPIRE key 60
allow = n <= limit
```

- 가장 단순, 메모리 O(1).
- **경계 문제**: 59초에 100번, 61초에 100번 → 2초 동안 200번 통과.
- `INCR` 과 `EXPIRE` 사이에 죽으면 TTL 없는 키가 남을 수 있다 → `SET key 0 EX 60 NX` 후 `INCR`, 또는 Lua 로 묶기.

## 슬라이딩 윈도우 로그 (Sliding Log)

```
MULTI
ZREMRANGEBYSCORE rl:{user} 0 (now - window)   # 오래된 요청 제거
ZADD rl:{user} now <unique-id>
ZCARD rl:{user}
EXPIRE rl:{user} window
EXEC
allow = ZCARD <= limit
```

- 정확하다. 임의 시점 기준 정확히 window 안의 요청 수.
- 요청마다 멤버를 저장하므로 메모리가 limit 에 비례. limit 이 수천 이상이면 부담.
- 거부된 요청도 ZADD 되므로 공격 시 커진다 → 거부 시 ZREM 하거나 Lua 에서 먼저 센 뒤 추가.

## 슬라이딩 윈도우 카운터 (근사)

현재 윈도우와 직전 윈도우의 고정 카운터 두 개로 가중 평균.

```
estimate = prev_count * (1 - elapsed_ratio) + curr_count
```

메모리 O(1) 이면서 경계 문제를 거의 없앤다. Cloudflare 가 쓰는 방식.

## 토큰 버킷 (Token Bucket)

버킷에 초당 r 개 토큰이 차고 최대 b 개까지 쌓인다. 요청은 토큰 1개를 소비. **버스트 허용** 이 핵심.

```lua
-- KEYS[1]=bucket, ARGV: rate, capacity, now, requested
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or capacity)
local ts     = tonumber(redis.call('HGET', KEYS[1], 'ts') or now)
tokens = math.min(capacity, tokens + (now - ts) * rate)
local allowed = tokens >= requested
if allowed then tokens = tokens - requested end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / rate) * 2)
return allowed and 1 or 0
```

Lua 로 읽기-계산-쓰기를 원자적으로 처리한다. 시각 `now` 는 클라이언트가 넘긴다 (스크립트 결정성).

## 비교

| 방식 | 정확도 | 메모리 | 버스트 | 구현 난이도 |
|---|---|---|---|---|
| 고정 윈도우 | 낮음 (경계 2배) | O(1) | 경계에서만 | 매우 쉬움 |
| 슬라이딩 로그 | 정확 | O(limit) | 없음 | 쉬움 |
| 슬라이딩 카운터 | 근사 | O(1) | 거의 없음 | 중간 |
| 토큰 버킷 | 정확 | O(1) | **허용** | 중간 (Lua) |

## 실전 고려

- 키에 사용자/IP/API 키 + 엔드포인트를 조합: `rl:api:{userId}:/orders`.
- 응답 헤더 `X-RateLimit-Remaining`, `Retry-After` 를 위해 남은 수와 리셋 시각을 함께 반환하도록 Lua 를 짠다.
- Redis 장애 시 fail-open(허용) 할지 fail-closed(거부) 할지 미리 정한다.
- 클러스터에선 키 하나가 한 슬롯이므로 자연스럽게 분산된다. 글로벌 한도는 단일 키라 핫 키가 될 수 있다.
