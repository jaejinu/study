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

## 심화 — 슬라이딩 창 카운터를 숫자로

"이전 창 가중" 이 실제로 어떻게 계산되는지 보자. 한도 100/분, 현재 시각이 이번 창의 15초 지점(25% 경과).

```
이전 창(0:00~1:00) 카운트 = 84
현재 창(1:00~2:00) 카운트 = 30   ← 1:15 현재
추정 = 30 + 84 × (1 − 0.25) = 30 + 63 = 93  → 허용 (한도 100)
```

```lua
-- KEYS[1]=현재 창 키, KEYS[2]=이전 창 키, ARGV[1]=한도, ARGV[2]=경과 비율(0~1), ARGV[3]=창 길이(초)
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
local est = cur + prev * (1 - tonumber(ARGV[2]))
if est >= tonumber(ARGV[1]) then return {0, cur} end
cur = redis.call('INCR', KEYS[1])
if cur == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]) * 2) end  -- 다음 창에서 '이전 창' 으로 읽히도록 2배
return {1, cur}
```

Cloudflare 가 발표한 분석에서 이 근사는 실제 슬라이딩 로그와 비교해 오판이 0.003% 수준이었다 — 요청이 창 안에 고르게 분포한다는 가정이 대부분 맞기 때문이다. 메모리는 키당 정수 두 개로 고정 창과 같다.

### 클러스터에서의 키 설계

여러 한도(분당·시간당)를 한 Lua 로 묶으려면 키가 **같은 슬롯**에 있어야 한다. 해시 태그를 쓴다.

```
rl:{user:42}:m:28934871     ← {} 안만 해시 → 같은 슬롯
rl:{user:42}:h:482247
```

해시 태그를 너무 넓게(`{rl}`) 잡으면 모든 키가 한 노드로 몰린다 — [Redis 노트 11](/redis/notes/11-replication-sentinel-cluster).

### 로컬 선판정으로 왕복 줄이기

20만 QPS 전부를 Redis 로 보내지 않는 방법: 각 서버가 사용자별 **로컬 토큰 버킷**(한도 ÷ 서버 수 × 여유)을 먼저 보고, 로컬에서 명백히 여유 있으면 통과, 경계 근처에서만 Redis 에 묻는다. 또는 서버가 Redis 에서 토큰을 **묶음으로 빌려 오는**(lease 10개) 방식. 정확도를 조금 내주고 Redis 부하를 크게 줄인다.

## 모니터링·로그 — 레이트리미터 자체를 관측한다

레이트리미터는 "아무 일도 없을 때 보이지 않는" 부품이라, 장애 때 원인 후보에서 빠지기 쉽다.

| 메트릭 | 의미 | 나쁜 신호 |
|---|---|---|
| `ratelimit_decisions_total{result="allowed|limited|error"}` | 판정 결과 | `limited` 급증 → 공격 또는 **우리 클라이언트 버그**(재시도 루프) |
| 판정 지연 p99 | 레이트리미터가 더하는 지연 | 1ms 예산 초과 → Redis 포화·네트워크 |
| `result="error"` + fail-open 횟수 | 판정 못 하고 통과시킨 수 | 0 이 아니면 그 시간 동안 보호가 없었다 |
| 상위 limited 키 (topk) | 누가 막히나 | 한 고객사가 대부분 → 요금제·연동 문제 상담 |
| Redis 명령률·CPU | 저장소 포화 | Lua 스크립트가 길어 CPU 단일 스레드를 잡아먹음 |

```yaml
# 기록 규칙으로 '막힌 비율' 을 만들고, 평소(1일 평균)의 3배를 넘으면 알림 — 공격인지 배포 사고인지 사람이 본다
- record: ratelimit:limited_ratio:5m
  expr: sum(rate(ratelimit_decisions_total{result="limited"}[5m])) / sum(rate(ratelimit_decisions_total[5m]))
- alert: RateLimitedSpike
  expr: ratelimit:limited_ratio:5m > 3 * avg_over_time(ratelimit:limited_ratio:5m[1d])
  for: 10m
```

429 응답 로그에는 `limit_key`, `policy`(어떤 한도에 걸렸나), `remaining`, `client_id` 를 남긴다. 고객 문의 "왜 막혔나요?" 에 답하려면 **어떤 규칙** 이 막았는지가 필수다. 한도 카디널리티(키 1,000만)를 메트릭 라벨에 넣으면 시계열 폭발이 나므로 사용자 ID 는 로그에만 — [관측 노트 02](/observability/notes/02-prometheus-promql).

## 흔한 실수와 오해

| 실수 | 결과 |
|---|---|
| `INCR` 후 별도 `EXPIRE` (비원자) | 사이에 프로세스가 죽으면 만료 없는 키 → 그 사용자는 영원히 막힌다 |
| 앱 서버 시계로 토큰 계산 | 서버 간 시계 차이로 토큰이 생기거나 사라진다 |
| 429 응답에 `Retry-After` 없음 | 클라이언트가 즉시 재시도 → 한도 걸린 사용자가 더 많은 부하를 만든다 |
| 레이트리미터 호출에 타임아웃 없음 | Redis 가 느려지면 **모든 요청이** 느려진다 — 보호 장치가 장애 원인이 된다 |
| IP 만으로 제한 | NAT·사내망 뒤 수천 명이 한 IP → 정상 사용자 대량 차단 |
| 한도를 코드에 하드코딩 | 고객별 예외·긴급 완화에 배포가 필요 → 설정 저장소·동적 갱신 |

## 스스로 점검

1. **한도 100/분, 이전 창 84, 현재 창 30, 창 25% 경과면 슬라이딩 창 카운터의 추정은?** — 30 + 84 × 0.75 = 93.
2. **클러스터에서 분당·시간당 한도를 한 Lua 로 검사하려면?** — 해시 태그로 두 키를 같은 슬롯에 둔다(`rl:{user:42}:m`, `rl:{user:42}:h`).
3. **`limited` 판정이 갑자기 10배가 됐다. 공격과 내부 버그를 어떻게 구분하나?** — 상위 키·client_id·User-Agent 분포를 본다. 우리 SDK 버전 하나에 몰려 있으면 재시도 루프 버그다.
4. **Redis 왕복 없이 대부분의 판정을 하려면?** — 서버별 로컬 버킷 선판정 또는 토큰 묶음 lease. 정확도와 부하의 교환.

## 예시로 보기 — 이 프로젝트에서

이 사이트의 "AI 에게 묻기"(`/api/ask`)는 아직 레이트리밋이 없다. 사용자당 분당 10회 토큰 버킷을 위 Lua 로 붙인다면 키는 `rl:ask:<세션>` 이 된다. 비용(LLM 토큰)이 큰 엔드포인트라 **fail-closed** 가 맞다 — Redis 가 죽었을 때 무제한 호출이 나가면 요금이 터진다([FinOps 노트 05](/finops/notes/05-llm-token-cost)).

```bash
pnpm exec tsx scripts/run-code-lab.mts testing test-property-ratelimit   # 비원자 구현의 반례 찾기
```

## 실전에서는 어디에 쓰이나

> 한 사용자가 너무 많이 호출해 다른 사용자나 비용을 위협할 때 레이트리미터가 등장한다. 공개 API 의 공정성, 로그인 무차별 대입 방지, 비싼 외부 호출(LLM·결제) 보호가 대표적이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 공개 API 를 파는 SaaS | 요금제별 한도와 공정한 사용 | 게이트웨이에서 API 키별 슬라이딩 창 카운터, `RateLimit-*` 헤더 | 서버별 로컬 카운터(합계 아님) |
| 로그인·OTP 인증 | 무차별 대입 공격 | 계정·IP 별 고정 창 + fail-closed | 캡차만으로 대응 |
| AI 챗봇 서비스 | LLM 토큰 비용 폭주 | 사용자별 토큰 버킷(요청 비용 = cost), Redis 장애 시 fail-closed | 월말 청구서 보고 사후 차단 |
| 대형 커머스 선착순 이벤트 | 봇·매크로 트래픽 | 엣지·WAF 에서 IP 기준 거친 제한 + 앱에서 사용자별 세밀 제한 | 앱 한 층에서만 제한 |
| 사내 서비스 간 호출 | 한 서비스의 재시도 폭주가 다른 서비스를 죽임 | 서비스 메시 사이드카 레이트리밋 + 클라이언트 백오프·지터 | 호출 측 선의에 의존 |

**이럴 땐 안 맞는다**
- 순간 트래픽을 버리지 않고 줄 세워야 하는 작업(주문 접수·결제 처리): 거절보다 큐잉이 맞다. 대기열(가상 대기실)이나 메시지 큐로 평탄화한다.
- NAT·사내망 뒤 사용자가 많은 B2B 서비스에 IP 만 기준: 정상 사용자가 대량 차단된다. API 키·사용자 ID 를 기준으로 한다.

**누가 매일 만나나** — 백엔드 개발자는 비싼 엔드포인트에 한도를 붙일 때, 플랫폼·API 게이트웨이 팀은 요금제별 정책과 429 문의("왜 막혔나요")에 답할 때, 보안 엔지니어는 크리덴셜 스터핑 방어를 설계할 때 만난다.

**면접·실무 단골 질문**
- Q. 여러 서버가 같은 한도를 공유하려면? → Redis 같은 공유 저장소에서 판정·증가를 원자적으로(INCR 또는 Lua). GET→SET 은 경쟁 조건.
- Q. Redis 가 죽으면 통과시키나 막나? → 엔드포인트별로 정한다. 일반 API 는 fail-open, 로그인·결제·LLM 은 fail-closed.

## 실습 체크리스트

- [ ] 고정 창의 경계 2배 문제를 시간축 그림으로 설명하기
- [ ] 토큰 버킷 Lua 를 redis-cli 로 EVAL 해 버스트 후 속도 제한을 확인하기
- [ ] 엔드포인트 세 개(로그인·검색·조회)에 fail-open/closed 를 정하고 이유 적기
- [ ] 실험 test-property-ratelimit 의 반례 `{limit:1, bursts:[2]}` 가 왜 버그인지 설명하기
