---
title: "사례 — 분산 레이트리미터: 알고리즘, 원자성, 위치, 장애 시 정책"
order: 3
level: 중급
summary: "고정 창·슬라이딩 로그·슬라이딩 창 카운터·토큰 버킷·리키 버킷 비교, 여러 서버가 공유하는 카운터를 Redis 로 원자적으로(INCR+EXPIRE vs Lua), 게이트웨이·앱·서비스 메시 중 어디에 둘까, 응답 헤더와 429, Redis 장애 시 fail-open/closed, 다중 리전. 속성 기반 테스트가 비원자 구현의 반례를 찾아내는 것까지"
tags: [레이트리미터, 토큰 버킷, 슬라이딩 창, Redis, Lua, 429, fail-open]
experiments: [rate-limiter, test-property-ratelimit]
---

## 요구사항

- 사용자(또는 API 키·IP)별로 "분당 100 요청" 같은 한도를 지킨다.
- 서버가 여러 대여도 **합계** 기준으로.
- 한도 판정은 요청 지연에 1ms 이하만 더한다.
- 초과 시 `429 Too Many Requests` + 언제 다시 시도할지 알려 준다.
- 숫자: API 서버 50대, 총 20만 QPS, 사용자 1,000만 → 판정 20만 QPS, 키 최대 1,000만 개.

## 알고리즘

| 알고리즘 | 저장 | 정확도 | 버스트 | 특징 |
|---|---|---|---|---|
| 고정 창 (INCR + EXPIRE) | 키당 정수 1개 | 창 경계에서 **2배**까지 통과 | 경계에 몰림 | 가장 단순·싸다 |
| 슬라이딩 로그 (ZSET 에 타임스탬프) | 요청 수만큼 | 정확 | 정확히 제한 | 메모리 큼 |
| 슬라이딩 창 카운터 (이전 창 가중) | 정수 2개 | 근사(대개 충분) | 완만 | 실무에서 많이 씀 |
| 토큰 버킷 | 토큰 수 + 마지막 갱신 시각 | 정확 | **허용량만큼 버스트** | 평균과 버스트를 따로 정함 |
| 리키 버킷 (큐) | 대기열 | 출력 속도 일정 | 줄 세움 | Nginx limit_req 가 이 계열 |

고정 창의 경계 문제: 한도 100/분이면 0:59 에 100개, 1:00 에 100개 → 2초 동안 200개가 통과한다. 이게 문제가 되는 API(결제·로그인 시도)는 슬라이딩 창이나 토큰 버킷을 쓴다. Redis 구현과 비교는 [Redis 노트 10](/redis/notes/10-rate-limiting)과 실험 [rate-limiter](/redis/lab/rate-limiter).

## 원자성 — 여러 서버가 같은 키를 볼 때

순진한 구현은 **읽고 → 판단하고 → 쓴다**.

```ts
const n = Number(await redis.get(key)) || 0;   // 두 서버가 동시에 99 를 읽으면
if (n >= 100) return reject();
await redis.set(key, n + 1, "EX", 60);          // 둘 다 100 을 쓰고 둘 다 통과 → 101번째 허용
```

원자 연산으로 바꾼다.

```ts
// 고정 창: INCR 은 원자적이다. 첫 증가일 때만 만료를 건다
const n = await redis.incr(key);
if (n === 1) await redis.expire(key, 60);   // INCR 과 EXPIRE 사이에 죽으면 만료 없는 키 → Lua 로 묶는 편이 안전
if (n > 100) return reject();
```

```lua
-- 토큰 버킷 (Lua, 원자적): KEYS[1] = 버킷, ARGV = rate, capacity, now(ms), cost
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or tonumber(ARGV[2])
local ts = tonumber(b[2]) or tonumber(ARGV[3])
tokens = math.min(tonumber(ARGV[2]), tokens + (tonumber(ARGV[3]) - ts) * tonumber(ARGV[1]) / 1000)
local ok = tokens >= tonumber(ARGV[4])
if ok then tokens = tokens - tonumber(ARGV[4]) end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', ARGV[3])
redis.call('PEXPIRE', KEYS[1], math.ceil(tonumber(ARGV[2]) / tonumber(ARGV[1]) * 1000))
return ok and 1 or 0
```

시각은 **Redis 서버 시각**(`TIME`)을 쓰거나 앱 서버 시계를 동기화한다. 서버마다 시계가 다르면 토큰 계산이 어긋난다 — [분산 시스템 노트 02](/distributed-systems/notes/02-time-and-order).

### 비원자 구현의 버그를 테스트가 찾게 하기

[test-property-ratelimit](/testing/lab/test-property-ratelimit) 는 속성 기반 테스트로 "어떤 요청 시퀀스든 창당 허용 ≤ 한도" 를 검사한다. 원자 Lua 구현은 200개 입력을 통과했고, GET→SET 구현은 첫 실행에 실패해 반례를 `{limit:1, bursts:[2]}` 까지 줄였다. 동시 요청 2개면 한도 1 이 깨진다는 뜻이다. 레이트리미터처럼 "규칙이 단순한데 동시성이 어려운" 코드에 맞는 검증 방법이다 — [테스트 전략 노트 05](/testing/notes/05-property-based-testing).

## 어디에 둘까

| 위치 | 장점 | 단점 |
|---|---|---|
| 엣지·CDN·WAF | 공격 트래픽을 가장 먼저 자름 | 사용자 정체(인증)를 모르는 경우가 많다 |
| API 게이트웨이 | 한 곳에서 일관되게, API 키별 | 비즈니스 규칙(요금제별 한도)을 넣기 애매 |
| 앱(미들웨어) | 사용자·요금제·엔드포인트별 세밀 | 서버마다 같은 코드, 공유 저장소 필요 |
| 서비스 메시 (사이드카) | 서비스 간 호출 보호 | 설정 복잡 |
| Nginx `limit_req` | 매우 빠름, 로컬 | 서버별 카운터(합계 아님) |

실무는 **층을 나눈다**: 엣지에서 IP 기준 거친 제한(DDoS), 게이트웨이에서 API 키 기준, 앱에서 비싼 작업(결제·검색)별 세밀한 제한. Nginx 실측(5r/s, burst=10 nodelay 에서 30 동시요청 중 11개 통과)은 [Nginx 노트 03](/nginx/notes/03-cache-tls-ratelimit), 게이트웨이 설계는 [API 설계 노트 06](/api-design/notes/06-gateway-auth-ratelimit).

## 응답 — 클라이언트가 잘 행동하게

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 12
```

클라이언트가 `Retry-After` 를 무시하고 즉시 재시도하면 **재시도 폭풍**이 된다. 지수 백오프 + 지터를 SDK 에 넣는다 — 실험 [chaos-retry-storm](/chaos/lab/chaos-retry-storm).

## 장애 시 정책 — Redis 가 죽으면

| 정책 | 의미 | 맞는 경우 |
|---|---|---|
| fail-open | 판정 불가 → 통과 | 일반 API (가용성 우선) |
| fail-closed | 판정 불가 → 거절 | 로그인 시도, 결제, 비싼 외부 API (보호 우선) |
| 로컬 폴백 | 서버별 메모리 카운터로 한도/서버수 근사 | 둘의 절충 |

판정 호출에는 **짧은 타임아웃**(예: 5ms)을 건다. 레이트리미터가 느려져 모든 요청이 느려지면 본말전도다. Redis 가 멈췄을 때 타임아웃·폴백이 어떻게 동작하는지는 실험 [chaos-redis-hang](/chaos/lab/chaos-redis-hang).

## 규모 — 키 1,000만 개, 20만 QPS

- 메모리: 고정 창 키 하나 ≈ 수십 바이트 → 1,000만 개면 수백 MB. 슬라이딩 로그는 요청마다 ZSET 원소 → 수십 GB 가 될 수 있어 대규모에는 부적합.
- 처리량: Redis 한 대 10만 QPS 수준 → 클러스터로 키를 나눈다(사용자 ID 해시 — [Redis 노트 11](/redis/notes/11-replication-sentinel-cluster)).
- 왕복 줄이기: 같은 요청에서 여러 한도(분당·시간당)를 한 Lua 호출로.
- 다중 리전: 리전별로 한도를 나누거나(합계 근사), 전역 정확성이 필요한 소수 한도만 중앙 저장소로.

## 면접식 후속 질문

1. 요금제가 바뀌면 진행 중인 창은 어떻게? (새 한도로 즉시, 키에 요금제 버전 포함)
2. 한 사용자가 여러 IP 로 오면? (정체 기준을 무엇으로 하나)
3. 배치 API 처럼 요청 하나의 비용이 다르면? (토큰 버킷의 cost)
4. "정확히 100" 이 아니라 "대략 100" 이면 충분한 이유는?

## 예시로 보기 — 이 프로젝트에서

이 사이트의 "AI 에게 묻기"(`/api/ask`)는 아직 레이트리밋이 없다. 사용자당 분당 10회 토큰 버킷을 위 Lua 로 붙인다면 키는 `rl:ask:<세션>` 이 된다. 비용(LLM 토큰)이 큰 엔드포인트라 **fail-closed** 가 맞다 — Redis 가 죽었을 때 무제한 호출이 나가면 요금이 터진다([FinOps 노트 05](/finops/notes/05-llm-token-cost)).

```bash
pnpm exec tsx scripts/run-code-lab.mts testing test-property-ratelimit   # 비원자 구현의 반례 찾기
```

## 실습 체크리스트

- [ ] 고정 창의 경계 2배 문제를 시간축 그림으로 설명하기
- [ ] 토큰 버킷 Lua 를 redis-cli 로 EVAL 해 버스트 후 속도 제한을 확인하기
- [ ] 엔드포인트 세 개(로그인·검색·조회)에 fail-open/closed 를 정하고 이유 적기
- [ ] 실험 test-property-ratelimit 의 반례 `{limit:1, bursts:[2]}` 가 왜 버그인지 설명하기
