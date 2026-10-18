---
title: "복원력 패턴을 실측으로 검증한다 — 타임아웃·재시도·서킷 브레이커·벌크헤드·폴백"
order: 3
level: 중급
summary: "아키텍처 노트의 복원력 패턴 다섯 가지를 이 실험실의 장애 주입으로 하나씩 증명한다. 타임아웃이 없을 때 요청이 영원히 걸리는 것, 재시도 폭풍이 멈춘 의존성에 주는 부하(즉시 재시도 vs 백오프+지터 실측), 서킷 브레이커의 상태 전이 타임라인과 fail-fast 지연, 커넥션 풀 벌크헤드, 캐시 fail-open 폴백. 각 패턴의 '언제 쓰면 안 되는가' 와 메트릭으로 보는 법"
tags: [복원력, 타임아웃, 재시도, 지수 백오프, 지터, 서킷 브레이커, 벌크헤드, 폴백, fail-open, 재시도 예산]
experiments: [chaos-circuit-breaker, chaos-retry-storm, chaos-redis-hang, chaos-pg-connection-exhaustion]
---

[아키텍처 노트 04](/architecture/notes/04-resilience) 는 패턴을 **설명**한다. 이 노트는 같은 패턴을 **장애를 주입해 재고** 숫자로 확인한다. 패턴은 외우는 것이 아니라 "없으면 어떻게 되는지" 를 몸으로 아는 것이다.

## 패턴 지도 — 어떤 장애에 어떤 패턴

| 장애 모습 | 1차 방어 | 2차 방어 | 이 실험실의 증거 |
|---|---|---|---|
| 의존성이 **멈춤**(hang, 응답 없음) | 타임아웃 | 서킷 브레이커 + 폴백 | `chaos-redis-hang`, `chaos-circuit-breaker` |
| 의존성이 **일시적으로** 실패 | 재시도(백오프+지터) | 재시도 예산 | `chaos-retry-storm` |
| 의존성이 **느려짐** | 타임아웃 예산 | 부하 차단, 벌크헤드 | `chaos-pg-connection-exhaustion` |
| 한 의존성 장애가 **다른 기능까지** 전염 | 벌크헤드(풀 분리) | 우선순위 | `chaos-pg-connection-exhaustion` |
| 트래픽 중 **인스턴스 교체** | 그레이스풀 셧다운 + 준비 프로브 | 복제본 ≥ 2 | `chaos-k8s-pod-kill-under-load` |

핵심 원칙 하나: **빠르게 실패하는 것이 느리게 성공하는 것보다 낫다.** 느린 성공은 호출자의 스레드·커넥션·이벤트 루프를 잡아먹어 전체 장애로 번진다.

## 1. 타임아웃 — 없으면 전부 멈춘다

`chaos-redis-hang` 의 실측:

| 클라이언트 | Redis 멈춤 중 GET | 결과 |
|---|---|---|
| `commandTimeout: 300` | 300ms 뒤 에러 → DB 폴백 | 요청 완료 ≈ 350ms |
| 타임아웃 없음 | 2초 상한에서 포기 (실제론 영원히) | 요청이 쌓임 |

타임아웃은 **모든** 외부 호출에 있어야 한다. HTTP 클라이언트, DB 드라이버, Redis, DNS, 심지어 큐 발행까지. 기본값이 "무한" 인 라이브러리가 놀랄 만큼 많다(Node `http.request`, pg 의 `statement_timeout` 미설정, ioredis 의 `commandTimeout` 미설정).

**얼마로?** 의존성의 p99 × 2~3 이 출발점. 그리고 **예산**으로 생각한다: 사용자 요청 전체가 1초라면, 그 안에서 DB 300ms + Redis 50ms + 외부 API 400ms 식으로 나누고 남은 시간을 하위 호출에 **전파**한다(gRPC deadline propagation, [분산 시스템 01](/distributed-systems/notes/01-why-hard)).

```ts
// 예산 전파: 상위에서 남은 시간을 하위로
async function handler(req) {
  const deadline = Date.now() + 1000;
  const user = await db.query(sql, { timeout: deadline - Date.now() });
  const cached = await redis.get(key, { timeout: Math.min(50, deadline - Date.now()) });
}
```

> 함정: 타임아웃이 걸려도 **의존성 쪽 작업은 계속된다**(DB 는 쿼리를 계속 돌림). 서버 측 타임아웃(`statement_timeout`, gRPC 서버 deadline)과 짝을 맞춰야 자원이 실제로 풀린다.

## 2. 재시도 — 폭풍을 만들지 않으려면

`chaos-retry-storm` 은 Redis 를 3초 멈춘 뒤 30개 클라이언트가 재시도하는 두 방식을 비교한다.

| 방식 | 총 시도 | 초당 피크 | 복구 직후 0.5초 안 몰림 |
|---|---|---|---|
| 즉시 재시도(간격 0, 성공까지) | 수백~1천 | 수백 | 많음 |
| 지수 백오프 + 풀 지터(base 200ms, cap 2s) | 100대 | 수십 | 흩어짐 |

같은 장애, 같은 클라이언트 수인데 멈춘 Redis 가 받는 요청은 **5~10배** 차이가 난다. 복구 직후의 몰림(thundering herd)도 지터가 흩뿌린다.

재시도 규칙:

1. **멱등 요청만.** POST 결제를 재시도하면 이중 결제다. 멱등 키([아키텍처 09](/architecture/notes/09-payments-ledger-consistency))가 있어야 재시도할 수 있다.
2. **재시도할 에러만.** 타임아웃·503·연결 거부는 재시도, 400·401·404·검증 실패는 즉시 포기.
3. **지수 백오프 + 지터.** `sleep = random(0, min(cap, base × 2^attempt))` (AWS 의 "full jitter").
4. **횟수보다 시간 예산.** 3회가 아니라 "총 2초 안" — 그 뒤엔 사용자에게 실패를 돌려준다.
5. **재시도 예산(retry budget).** 재시도가 전체 요청의 10% 를 넘으면 재시도를 끈다(Google SRE 의 방식). 의존성이 진짜 죽었을 때 폭풍을 막는 마지막 안전장치.
6. **중첩 금지.** 게이트웨이 3회 × 서비스 3회 × 클라이언트 3회 = 27배. 재시도는 **한 계층**에서만.

```ts
async function withRetry<T>(fn: () => Promise<T>, { budgetMs = 2000, base = 100, cap = 1000 } = {}) {
  const until = Date.now() + budgetMs;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!isRetryable(e) || Date.now() >= until) throw e;
      const delay = Math.random() * Math.min(cap, base * 2 ** attempt);
      await sleep(Math.min(delay, until - Date.now()));
    }
  }
}
```

메트릭: `retries_total{reason}` 와 `retry_ratio = retries / requests`. 비율이 오르면 의존성 장애의 가장 빠른 신호다.

## 3. 서킷 브레이커 — "이미 죽은 걸 안다"

타임아웃은 **매 요청**이 타임아웃만큼 기다리게 한다. 300ms × 1000 req/s = 초당 300초의 대기가 쌓인다. 서킷 브레이커는 실패를 **상태**로 기억해 즉시 거부한다.

```
closed ──연속 실패 ≥ N──▶ open ──openMs 경과──▶ half-open ──성공──▶ closed
                           ▲                        │실패
                           └────────────────────────┘
```

`chaos-circuit-breaker` 의 타임라인(실측):

| 시각 | 상태 | 무슨 일 |
|---|---|---|
| 0ms | closed | Redis 멈춤 시작 |
| ~300·600·900ms | closed | 호출 3회가 각각 300ms 타임아웃 |
| ~900ms | **open** | 연속 실패 3회 ≥ 임계 |
| 900ms~ | open | 이후 50개 동시 호출이 **수 ms** 에 전부 거부 (Redis 로 안 감) |
| +2000ms | half-open | 시험 호출 1회 → Redis 아직 멈춤 → 다시 open |
| Redis 복구 후 +2000ms | half-open → **closed** | 시험 호출 성공 |

open 상태의 두 효과: 호출자가 **즉시** 답을 받고(폴백으로), 복구 중인 의존성에 **부하를 주지 않는다**. half-open 의 시험 호출 1회가 복구를 감지한다.

설계 포인트:

- 임계는 "연속 실패 N" 보다 **최근 윈도우의 실패율**(예: 10초에 50%, 최소 20건)이 낫다. 간헐 실패 몇 번에 전체를 끊지 않는다.
- open 중 폴백: 캐시된 값, 기본값, 빈 목록, "잠시 후 다시" 503. **무엇을 돌려줄지**가 패턴 자체보다 중요하다.
- 브레이커는 **의존성 단위**(Redis, 결제 API) 로, 때로는 **엔드포인트 단위**로.
- 상태를 메트릭으로: `circuit_state{dep}` (0/1/2) 와 전이 이벤트 로그. 대시보드에서 "지금 열려 있는 서킷" 패널 하나면 장애 범위가 보인다.
- 라이브러리: Node `opossum`, Java `resilience4j`, 서비스 메시(Istio outlier detection)는 프록시에서 같은 일을 한다.

## 4. 벌크헤드 — 한 의존성이 전체를 못 잠그게

`chaos-pg-connection-exhaustion` 에서 느린 쿼리가 풀의 커넥션을 전부 쥐면 **DB 를 쓰지 않는 기능까지** 대기한다 — 풀이 하나이기 때문이다. 배의 격벽(bulkhead)처럼 자원을 **나눈다**:

| 격리 단위 | 방법 |
|---|---|
| 커넥션 풀 | 중요 경로(결제)용 풀과 배치/리포트용 풀을 분리 |
| 동시성 | 의존성마다 세마포어(동시 호출 상한) — 느린 외부 API 가 이벤트 루프의 모든 요청을 잡지 못하게 |
| 프로세스/Pod | 트래픽 종류별 Deployment 분리(API vs 웹훅 수신 vs 배치) |
| 큐 | 우선순위 큐, 테넌트별 큐([아키텍처 08](/architecture/notes/08-multitenancy-saas)) |

```ts
const limiter = new Semaphore(20);           // 외부 API 동시 20
async function callExternal() {
  if (!limiter.tryAcquire()) throw new Error("bulkhead full");   // 기다리지 않고 거부 → 부하 차단
  try { return await api(); } finally { limiter.release(); }
}
```

"가득 차면 **거부**" 가 핵심이다. 기다리게 하면 벌크헤드가 아니라 또 하나의 큐다.

## 5. 폴백 — fail-open 인가 fail-closed 인가

`chaos-redis-hang` 의 캐시는 Redis 가 죽으면 **DB 로 간다**(fail-open). 반대로 [분산 락](/redis/notes/09-distributed-lock) 이나 레이트 리밋은 Redis 가 죽었을 때 **열어 주면 안전성이 깨진다**(fail-closed 가 맞을 수 있다).

| 의존성 용도 | 장애 시 | 이유 |
|---|---|---|
| 캐시 | fail-open (원본으로) | 느려질 뿐 틀리지 않음. 단, 스탬피드 주의([cache-stampede](/redis/lab/cache-stampede)) |
| 세션 조회 | 상황 따라 | 로그아웃 처리 vs 짧은 유예 |
| 레이트 리밋 | 보통 fail-open | 과금 보호보다 가용성 — 단, 남용 방어용이면 fail-closed |
| 분산 락, 결제 멱등 키 | fail-closed | 중복 실행·이중 결제가 다운타임보다 비싸다 |
| 기능 플래그 | 마지막 값 캐시 | 플래그 서비스 죽음 ≠ 기능 죽음 |

폴백은 **설계 결정**이고 의존성마다 문서에 적혀 있어야 한다. "Redis 죽으면 어떻게 되지?" 에 답을 못 하면 아직 설계가 끝나지 않은 것이다.

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 진행률·퀴즈 기록은 Redis 에 저장한다. `src/lib/progress.ts`·`study.ts` 는 모두 try/catch 로 **fail-open**(Redis 없으면 빈 진행률) — 학습 기능은 Redis 없이도 노트를 읽을 수 있어야 하므로.
- `/api/alerts` 는 메모리 링버퍼 우선 + Redis best-effort 1초 타임아웃 — Redis 가 죽었다는 알림이 Redis 저장에 막히던 사고를 겪고 고친 것([관측성 09](/observability/notes/09-alerting-pipeline)).
- AI 도우미의 LLM 호출은 타임아웃·재시도가 SDK 기본값에 의존한다 — 개선 과제: 예산 전파와 재시도 예산.

## 패턴의 반대편 — 과잉 복원력

- 재시도 + 서킷 + 타임아웃 + 폴백을 **모든** 호출에 붙이면 코드가 패턴에 묻힌다. 의존성 **경계**(어댑터) 한 곳에 모아라.
- 폴백이 너무 좋으면 장애를 **아무도 모른다**. fail-open 은 반드시 메트릭(`fallback_total`)과 알림을 동반해야 한다.
- 서킷이 너무 민감하면 간헐 실패에 전체가 끊긴다. 실패율 기반 + 최소 샘플 수.

## 실전에서는 어디에 쓰이나

> 외부 의존성(DB·캐시·결제 API·LLM)을 호출하는 코드라면 어디서든 타임아웃·재시도·서킷 브레이커·벌크헤드·폴백 가운데 무엇을 붙일지 정해야 한다. 이 노트는 그 결정을 감이 아니라 실측으로 내리는 법이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 결제의 외부 PG 호출 | PG 지연이 결제 서버 스레드를 전부 묶는 것 | 타임아웃 + 서킷 브레이커(예: resilience4j), 재시도는 멱등 키가 있을 때만 | 비동기 결제 요청 + 결과 웹훅 |
| 커머스 상품 상세의 캐시 조회 | Redis 장애가 페이지 장애로 번짐 | 짧은 `commandTimeout` + fail-open 으로 DB 폴백, `fallback_total` 메트릭 | 로컬 캐시를 앞에 둔 2단 캐시 |
| AI 서비스의 LLM API 호출 | 공급자 지연·일시 실패에 재시도 폭풍 | 지수 백오프 + 풀 지터, 시간 예산, 재시도 예산 | 다른 모델·공급자로 폴백 라우팅 |
| SaaS 의 리포트와 실시간 API 공존 | 무거운 리포트가 DB 풀을 독점 | 풀 분리(벌크헤드), 세마포어로 동시 호출 상한 | 리포트를 읽기 복제본으로 |
| MSA 게이트웨이 → 서비스 → 클라이언트 | 계층마다 재시도해 요청이 수십 배로 증폭 | 재시도는 한 계층에서만, deadline 전파 | 서비스 메시(Istio outlier detection)에 위임 |
| 분산 락·레이트 리밋 | Redis 장애 때 열어 줄지 닫을지 | 락·멱등 키는 fail-closed, 일반 레이트 리밋은 보통 fail-open | 의존성별 폴백 정책을 문서로 고정 |

**이럴 땐 안 맞는다**
- 멱등하지 않은 쓰기(결제 승인, 포인트 적립)에 무조건 재시도: 이중 처리가 된다 → 멱등 키를 먼저 도입하거나 재시도 대신 상태 조회.
- 400·401·404 같은 확정 실패의 재시도: 결과가 바뀌지 않고 부하만 는다 → 즉시 실패.
- 모든 호출에 패턴을 다 붙이기: 코드가 패턴에 묻히고 폴백이 장애를 감춘다 → 의존성 어댑터 한 곳에 모으고 폴백은 메트릭·알림과 함께.

**누가 매일 만나나** — 백엔드 개발자는 외부 API 클라이언트를 처음 붙이며 타임아웃·재시도 값을 정할 때, SRE 는 "열린 서킷" 패널과 `retry_ratio` 로 장애 범위를 판단할 때, ML 엔지니어는 LLM·추론 서버 호출의 타임아웃과 폴백을 정할 때 만난다.

**면접·실무 단골 질문**
- Q. 타임아웃이 있는데 서킷 브레이커가 왜 또 필요한가? → 타임아웃은 매 요청이 그만큼 기다린다. 서킷은 실패를 상태로 기억해 즉시 거부하고, 복구 중인 의존성에 부하를 주지 않는다.
- Q. 재시도 폭풍은 어떻게 막나? → 지수 백오프 + 지터, 횟수 대신 시간 예산, 재시도 예산(약 10%), 재시도는 한 계층에서만.

## 실습 체크리스트

- [ ] `chaos-circuit-breaker` 를 돌리고 타임라인에서 open 전환 시각과 half-open 시험 호출을 찾기
- [ ] `chaos-retry-storm` 의 총 시도 수를 보고, 재시도 예산(10%) 을 코드에 추가하면 A 의 숫자가 어떻게 바뀔지 예측해 보기
- [ ] 내 서비스의 외부 호출을 전부 나열하고 각각의 타임아웃 값과 폴백 정책을 표로 만들기 — 빈칸이 있으면 그게 다음 장애다
- [ ] 서킷 상태를 Prometheus 게이지로 내보내고 Grafana 에 "열린 서킷" 패널 만들기
