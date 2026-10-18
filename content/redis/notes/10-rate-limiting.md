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

## 알고리즘을 그림으로 비교

같은 한도(분당 10회)에서 59초에 10번, 61초에 10번 요청이 오면:

| 방식 | 59~61초 사이 통과 | 이유 |
|---|---|---|
| 고정 윈도우 | 20 | 61초는 새 윈도우라 카운터 0 부터 |
| 슬라이딩 로그 | 10 | 61초 시점에 직전 60초 안에 이미 10개 |
| 슬라이딩 카운터 | 약 10~11 | 직전 윈도우 10 × (1 − 1/60) + 현재 0 ≈ 9.8 |
| 토큰 버킷(용량 10, 초당 1/6) | 10 + 약 0.3 | 59초에 버킷을 비우고 2초 동안 0.33개만 참 |

## 원자적 고정 윈도우 — Lua 한 방

`INCR` 후 `EXPIRE` 를 따로 보내면, 그 사이 프로세스가 죽을 때 TTL 없는 카운터가 남아 **그 사용자는 영원히 차단**된다.

```lua
-- KEYS[1]=rl:{user}:{window}, ARGV[1]=limit, ARGV[2]=window_sec
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
local ttl = redis.call('TTL', KEYS[1])
return { n <= tonumber(ARGV[1]) and 1 or 0, math.max(0, tonumber(ARGV[1]) - n), ttl }
--      허용 여부,                         남은 횟수,                         리셋까지 초
```

반환한 세 값을 그대로 응답 헤더로 쓴다.

```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 23
Retry-After: 23
```

## 비원자 구현이 실제로 깨지는 모습

테스트 전략 주제의 `test-property-ratelimit` 실험은 fast-check 로 "어떤 요청 순서든 윈도우당 허용 ≤ 한도" 라는 성질을 수백 가지 입력으로 검사한다. `GET` 으로 읽고 앱에서 판단한 뒤 `SET` 하는 구현은 첫 실행에서 반례를 내고, 그 반례를 `{limit: 1, bursts: [2]}` — "한도 1 에 동시 요청 2개" — 까지 줄여 준다. 동시 요청 두 개가 같은 값을 읽고 둘 다 통과하는 경쟁이다. Lua 버전은 같은 검사를 통과한다([테스트 — 속성 기반 테스트](/testing/notes/05-property-based-testing)).

## 어디서 제한할 것인가

| 계층 | 장점 | 한계 |
|---|---|---|
| CDN·WAF | 앱 앞에서 차단, 공격 흡수 | 사용자 단위 비즈니스 규칙 어려움 |
| API 게이트웨이·Nginx(`limit_req`) | 설정만으로, 빠름 | 인스턴스별 메모리라 분산 시 합산 안 됨 |
| 앱 + Redis | 사용자·플랜·엔드포인트별 정교한 규칙, 전체 인스턴스 공유 | Redis 왕복 추가, Redis 장애 시 정책 결정 필요 |
| 서비스 메시 | 서비스 간 보호 | 설정 복잡 |

실무에서는 층을 겹친다 — Nginx 가 IP 당 거친 상한을 걸고, 앱이 Redis 로 사용자·플랜별 한도를 건다([API 설계 — 게이트웨이·인증·레이트리밋](/api-design/notes/06-gateway-auth-ratelimit)).

## 운영 함정

| 함정 | 증상 | 대처 |
|---|---|---|
| 글로벌 한도 하나의 키 | 그 키가 핫 키, 클러스터 한 노드 과부하 | 키를 N 개로 쪼개 한도/N 씩 (근사) |
| 시계가 서버마다 다름 | 토큰 버킷 계산이 튐 | `now` 를 Redis `TIME` 으로 통일하거나 단조 증가 보장 |
| Redis 장애 | 모든 요청 실패(fail-closed) 또는 무제한(fail-open) | 엔드포인트별로 정책 결정, 로컬 대체 한도 |
| 거부된 요청도 저장(슬라이딩 로그) | 공격 시 ZSet 폭증 | 먼저 세고 허용일 때만 ZADD |
| 재시도 폭풍 | 429 받은 클라이언트가 즉시 재시도 | `Retry-After` 존중, 지터 백오프([장애 실험실 — 재시도 폭풍](/chaos/notes/03-resilience-patterns-verified)) |

## 예시로 보기 — 이 프로젝트에서

이 사이트의 `/api/ask`(AI 에게 묻기)는 요청마다 모델 토큰 비용이 든다. 레이트리밋을 붙인다면:

```ts
// 사용자(또는 IP)별 분당 10회, 일 200회 — 두 윈도우를 함께
const minute = Math.floor(Date.now() / 60000);
const day = new Date().toISOString().slice(0, 10);
const [m, d] = await Promise.all([
  redis.fixedWindow(`rl:ask:${ip}:m:${minute}`, 10, 60),
  redis.fixedWindow(`rl:ask:${ip}:d:${day}`, 200, 86400),
]);
if (!m[0] || !d[0]) return new Response("too many", { status: 429, headers: { "Retry-After": String(m[0] ? d[2] : m[2]) } });
```

`fixedWindow` 는 위 Lua 를 `defineCommand` 로 등록한 것이다. 실험실의 **레이트 리미터** 실험이 고정 윈도우와 슬라이딩 로그의 경계 동작 차이를 숫자로 보여 준다.

## 실전에서는 어디에 쓰이나

> 외부에 열린 API, 비용이 드는 호출, 로그인처럼 남용되기 쉬운 경로에 등장한다. 인스턴스가 여러 대일 때 한도를 공유하려고 Redis 를 쓴다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| SaaS 공개 API (플랜별 한도) | 키·플랜별 분당/일 한도와 응답 헤더 | Lua 고정 윈도우 → `RateLimit-*`, `Retry-After` | API 게이트웨이 내장 기능 |
| AI 서비스 LLM 호출 | 사용자당 모델 비용 폭주 방지 | 분·일 두 윈도우를 함께 적용 | 월 예산 기반 쿼터 |
| 로그인·OTP 발송 | 무차별 대입·문자 폭탄 차단 | IP·계정별 슬라이딩 로그 | CAPTCHA, WAF |
| CDN·엣지 레이트리밋 | 메모리 O(1) 로 경계 문제 완화 | 슬라이딩 윈도우 카운터 (Cloudflare 가 공개한 방식) | 고정 윈도우 |
| 외부 결제·지도 API 를 부르는 백엔드 | 상대가 정한 초당 한도 지키기 | 토큰 버킷으로 버스트 허용 | 큐 + 고정 속도 소비자 |

**이럴 땐 안 맞는다**
- DDoS 급 대량 트래픽 차단 — 요청마다 Redis 왕복이 붙어 Redis 가 먼저 쓰러진다. CDN·WAF·Nginx `limit_req` 로 앞단에서 거른다.
- 전역 한도 하나를 키 하나로 — 핫 키가 된다. 키를 N 개로 쪼개 근사하거나 계층별로 나눈다.

**누가 매일 만나나** — 백엔드·API 플랫폼 팀이 429 정책과 플랜별 한도를 설계할 때, 보안 담당이 크리덴셜 스터핑을 막을 때, SRE 가 Redis 장애 시 fail-open/closed 를 정할 때.

**면접·실무 단골 질문**
- Q. 고정 윈도우의 문제와 대안 → 경계에서 최대 2배 통과, 슬라이딩 로그·슬라이딩 카운터·토큰 버킷.
- Q. Redis 가 죽으면 레이트리미터는 → 엔드포인트별 fail-open/closed 를 미리 정하고 로컬 대체 한도를 둔다.

## 실습 체크리스트

- [ ] 실험실의 레이트 리미터 실험을 돌려 경계에서 고정 윈도우가 2배 통과시키는 것 확인하기
- [ ] 위 Lua 고정 윈도우를 `EVAL` 로 실행해 세 반환값(허용·남은 수·리셋 초) 확인하기
- [ ] `INCR` 만 하고 `EXPIRE` 를 빠뜨린 키가 영원히 남는 것(`TTL` -1) 재현하기
- [ ] 테스트 주제의 속성 기반 레이트리밋 실험을 돌려 비원자 구현의 반례 읽기
- [ ] 토큰 버킷 Lua 에 `now` 를 서버 `TIME` 으로 바꾸는 방법 적어 보기
