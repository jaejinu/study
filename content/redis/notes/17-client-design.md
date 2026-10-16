---
title: "심화 — 클라이언트 설계: 커넥션, 재시도, 타임아웃, 파이프라인, 클러스터"
order: 17
level: 심화
summary: 애플리케이션 쪽에서 Redis 를 안전하게 쓰는 법. ioredis 설정값의 의미(retryStrategy·maxRetriesPerRequest·enableOfflineQueue·commandTimeout), 커넥션 수와 풀링, 자동 파이프라이닝, Sentinel/Cluster 클라이언트 동작, 장애 시 앱의 행동 설계, 테스트 전략
tags: [ioredis, 커넥션, 재시도, 타임아웃, 파이프라인, Sentinel, Cluster, 클라이언트]
experiments: [sentinel-failover, cluster-hash-slots, pipeline-vs-sequential]
---

## 커넥션은 적게, 오래

Redis 커넥션은 가볍지만 공짜는 아니다(서버당 fd, 버퍼, `maxclients` 기본 10000). 원칙:
- 프로세스당 **커넥션 몇 개**를 오래 유지 (일반 명령 1개, 구독용 1개, 블로킹 명령용 N개).
- 요청마다 연결하지 않는다. ioredis 의 `Redis` 인스턴스 하나가 내부 큐로 명령을 직렬화하며 수만 ops/s 를 낸다.
- 풀이 필요한 경우: 블로킹 명령(`BRPOP`, `XREADGROUP BLOCK`), `WATCH` 트랜잭션(커넥션 상태), 구독.

이 프로젝트: `getRedis()` 싱글턴 + `createRedis()` 로 실험용 추가 커넥션 (`src/lib/redis.ts`).

## ioredis 핵심 옵션

```ts
new Redis({
  host, port, password, db: 0,
  connectTimeout: 2000,          // TCP 연결 상한
  commandTimeout: 1000,          // 명령 응답 상한 (기본 무제한!) — 반드시 설정
  lazyConnect: true,             // 첫 명령 때 연결 (시작 시 Redis 없어도 앱이 뜸)
  enableOfflineQueue: true,      // 연결 전/끊김 중 명령을 큐에 쌓을지. false 면 즉시 에러
  maxRetriesPerRequest: 3,       // 연결 끊김 시 명령당 재시도 횟수 (null 이면 무한 대기 — 위험)
  retryStrategy: (times) => Math.min(times * 200, 2000),   // 재연결 간격 (null 반환하면 포기)
  reconnectOnError: (err) => err.message.includes("READONLY"),   // failover 로 레플리카에 붙었을 때 재연결
  enableAutoPipelining: true,    // 같은 tick 의 명령을 자동으로 파이프라인
  keyPrefix: "app:",             // 모든 키에 접두어 (멀티테넌트/환경 분리)
  name: "api-server-1",          // CLIENT SETNAME (디버깅)
});
```

**함정**
- `commandTimeout` 미설정 + 네트워크 블랙홀 = 요청이 영원히 걸림 → 앱 스레드/이벤트 루프 점유.
- `enableOfflineQueue: true` + `maxRetriesPerRequest: null` = Redis 가 죽으면 명령이 무한히 큐에 쌓여 메모리 폭발. 캐시 용도면 `enableOfflineQueue: false` 로 **빨리 실패**하고 DB 로 폴백.
- `retryStrategy` 가 없으면 기본 지수 백오프로 무한 재연결 — 보통 원하는 동작이지만 로그 폭주 주의.

## 장애 시 앱의 행동을 정하라

| 용도 | Redis 다운 시 | 설정 |
|---|---|---|
| 캐시 | miss 로 간주, DB 조회 (fail-open) | offlineQueue off, commandTimeout 짧게, 에러 삼키기 + 메트릭 |
| 세션 | 로그아웃 처리 또는 503 | 빠른 실패, 사용자 안내 |
| 레이트 리밋 | 허용(fail-open) 또는 거부(fail-closed) — 정책 결정 | |
| 락 | 작업 중단 (fail-closed) | 재시도 후 포기 |
| 큐 | 생산 실패를 호출자에 알림, 소비자는 재연결 대기 | |

```ts
async function cachedGet<T>(key: string, load: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { metrics.cacheError.inc(); logger.warn("cache.read.failed", { key, error: String(e) }); }
  const v = await load();
  redis.set(key, JSON.stringify(v), "EX", 60).catch(() => metrics.cacheError.inc());   // 쓰기 실패는 무시
  return v;
}
```

## 파이프라인과 자동 파이프라이닝

- 명시적: `redis.pipeline().set().get().exec()` — 배치 작업. 수천 개 단위로 끊는다.
- `enableAutoPipelining`: 같은 이벤트 루프 tick 에 발행된 명령을 모아 보낸다. 코드 변경 없이 RTT 절감. 블로킹·구독 명령은 제외된다.
- `multi()` 는 파이프라인 + MULTI/EXEC. 결과는 `[err, value][]` — **각 명령의 에러를 확인**해야 한다 (exec 자체는 성공).

## 키 설계와 네임스페이스

- `keyPrefix` 로 환경(`prod:`, `staging:`)·테넌트 분리. 같은 인스턴스를 공유할 때 충돌 방지.
- 클러스터 대비 처음부터 해시태그 `{user:123}:…` 로 묶을 것을 묶는다.
- 직렬화: JSON 이 기본, 큰 값은 MessagePack/압축. 버전 접두어(`v2:`) 로 포맷 변경 시 구 키 무시.

## Sentinel 클라이언트

```ts
new Redis({ sentinels: [{ host, port: 26379 }], name: "mymaster", role: "master",
            sentinelRetryStrategy: (t) => Math.min(t * 100, 1000), enableOfflineQueue: true, maxRetriesPerRequest: 20 });
```
- 시작 시 Sentinel 에 `SENTINEL get-master-addr-by-name` 로 마스터를 묻고 연결. `+switch-master` 를 구독해 failover 시 재연결.
- failover 중(1~5초) 명령은 큐에서 대기하거나 실패 — `maxRetriesPerRequest` 로 상한. [failover 실험](/redis/lab/sentinel-failover)에서 재연결 지연을 측정했다.
- `role: "slave"` 로 읽기 전용 커넥션을 레플리카에 분산할 수 있다 (stale 허용 시).

## Cluster 클라이언트

```ts
new Cluster([{ host, port: 7001 }], {
  scaleReads: "slave",                 // 읽기를 레플리카로
  redisOptions: { commandTimeout: 1000 },
  enableReadyCheck: true,
  clusterRetryStrategy: (t) => Math.min(t * 100, 2000),
});
```
- 시작 시 `CLUSTER SLOTS` 로 슬롯 맵을 받고, 키마다 슬롯을 계산해 맞는 노드로. `MOVED` 를 받으면 맵 갱신, `ASK` 는 일회성 리다이렉트. [Cluster 실험](/redis/lab/cluster-hash-slots).
- 다중 키 명령·MULTI·Lua 는 같은 슬롯이어야. 파이프라인은 노드별로 자동 분할되지만 원자성 없음.
- 리샤딩·failover 중 일시적 에러 → 재시도 전략 필수.

## 관측

- 클라이언트 측 메트릭: 명령 지연 히스토그램, 에러율, 재연결 횟수, 오프라인 큐 길이.
- OpenTelemetry `@opentelemetry/instrumentation-ioredis` 가 명령마다 span 을 만든다 — 이 프로젝트의 트레이스에서 `smembers`, `hgetall` span 을 볼 수 있다 ([트레이싱 노트](/observability/notes/06-tracing-otel)).
- 서버 측: `CLIENT LIST` 의 `name` 으로 어느 앱의 연결인지, `omem` 으로 느린 소비자.

## 테스트 전략

- 단위: ioredis-mock 또는 인터페이스 추상화. 단, 인코딩·만료·Lua 는 가짜에서 다르게 동작할 수 있다.
- 통합: 실제 Redis (Docker, CI 서비스 컨테이너). 이 프로젝트의 vitest 가 그렇다 — 실험이 곧 통합 테스트.
- 장애: 테스트 중 `CLIENT KILL`, `DEBUG SLEEP`, 컨테이너 일시정지(`docker pause`) 로 타임아웃·재연결 경로 검증.

## 이 프로젝트의 클라이언트 설정 해부

`src/lib/redis.ts` 의 기본 옵션:

```ts
const baseOptions: RedisOptions = {
  lazyConnect: true,          // Redis 없이도 앱이 뜬다 (학습 사이트는 Redis 가 꺼져 있을 수 있음)
  maxRetriesPerRequest: 1,    // 끊김 중 명령은 1번만 재시도하고 실패
  enableOfflineQueue: false,  // 연결 안 됐으면 큐에 쌓지 않고 즉시 에러
  connectTimeout: 1500,
  retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),   // 4번째엔 포기
};
```

| 선택 | 이유 | 트레이드오프 |
|---|---|---|
| `enableOfflineQueue: false` | Redis 가 꺼져도 페이지가 즉시 그려져야 함(진행률만 빈칸) | 짧은 끊김에도 그 순간 명령은 실패 |
| `retryStrategy` 4회 후 포기 | 로그 폭주·무한 재연결 방지 | 다시 붙으려면 `ensureConnected` 가 `connect()` 를 다시 부름 |
| 전역 싱글턴(`globalThis.__redisClient`) | Next.js dev HMR 마다 연결이 새로 생기는 것 방지 | 커넥션 1개 — 블로킹 명령은 `createRedis()` 로 따로 |
| `commandTimeout` 없음 | (개선 여지) | 서버가 멈춘(hang) 경우 명령이 오래 걸림 |

마지막 줄이 실제로 사고를 냈다. 장애 주입 실험이 `docker pause study-redis` 로 Redis 를 멈춘 채 남았을 때, 앱의 `/api/metrics` 가 Redis 핑을 기다리며 멈춰 **StudyAppDown 알림까지** 울렸다. `commandTimeout: 500` 을 두고 메트릭·진행률 조회를 fail-open 으로 처리했다면 앱은 살아 있었을 것이다([SRE — 사고와 포스트모템](/sre/notes/05-incident-postmortem)). 장애 실험실의 `chaos-redis-hang` 실험이 바로 이 상황(연결은 살아 있는데 응답 없음)을 재현한다.

## 타임아웃 예산 짜기

사용자 요청 하나에 300ms SLO 가 있다면 그 안에서 Redis 몫을 나눈다.

| 구간 | 예산 | 설정 |
|---|---|---|
| 전체 요청 | 300ms | 게이트웨이 타임아웃 |
| Redis 조회(캐시) | 20ms | `commandTimeout: 20`, 실패 시 DB |
| DB 조회 | 150ms | 쿼리 타임아웃 |
| 나머지(렌더링 등) | 130ms | |

타임아웃이 짧으면 일시적 지연에 오탐(불필요한 DB 폴백)이 늘고, 길면 장애 시 스레드·이벤트 루프가 묶인다. **p99.9 지연의 2~3배** 가 출발점이다. 하위 호출로 남은 시간을 넘기는 데드라인 전파는 [API 설계 — 에러·재시도·데드라인](/api-design/notes/04-errors-retries-deadlines)에서 다룬다.

## 재시도는 언제 해로운가

| 상황 | 재시도 | 이유 |
|---|---|---|
| 연결 거부·리셋, `LOADING`, `READONLY`(failover 중) | 지수 백오프 + 지터로 | 일시적, 곧 회복 |
| 명령 타임아웃 | **멱등 명령만** | `INCR` 이 서버에선 실행됐을 수 있음 → 두 번 증가 |
| `OOM`, `WRONGTYPE`, `NOSCRIPT` 외 스크립트 에러 | 하지 않음 | 다시 해도 같음 |
| 모든 클라이언트가 동시에 | 재시도 예산 필요 | 재시도 폭풍으로 복구 중인 서버를 다시 눕힘 |

장애 실험실의 `chaos-retry-storm` 실험은 Redis 를 3초 멈춘 동안 백오프 없는 재시도와 지수 백오프+지터의 요청 수 차이를, `chaos-circuit-breaker` 는 서킷 브레이커가 open → half-open → closed 로 바뀌며 fail-fast 하는 것을 보여 준다([복원력 패턴 실측](/chaos/notes/03-resilience-patterns-verified)).

## 커넥션 수 계산

```
필요 커넥션 = 인스턴스 수 × (일반 1 + 구독 1 + 블로킹 워커 수) × (Cluster 면 노드 수)
예: Pod 50개 × (1 + 1 + 4) × 6노드 = 1,800
```

`maxclients`(기본 10000)는 여유가 있어 보이지만, 오토스케일로 Pod 가 늘거나 재시작 루프로 커넥션이 정리되기 전에 새로 생기면 금방 찬다. `INFO clients` 의 `connected_clients` 추이와 Pod 수를 같은 대시보드에 둔다.

## 예시로 보기 — 개선안 정리

이 사이트에 적용할 만한 변경(학습용 제안):

```ts
const baseOptions: RedisOptions = {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 1500,
  commandTimeout: 500,                    // hang 대비
  connectionName: "study-web",            // CLIENT LIST 에서 식별
  retryStrategy: (t) => Math.min(t * 200, 2000),   // 포기하지 않고 계속 (지터 추가 권장)
  enableAutoPipelining: true,             // 첫 화면의 여러 조회를 자동 묶음
};
```

바꾼 뒤에는 장애 실험실의 Redis hang 실험을 다시 돌려 `/api/metrics` 가 500ms 안에 응답하는지 확인한다 — **설정 변경을 실험으로 검증**하는 것이 이 사이트의 학습 방식이다.

## 실습 체크리스트

- [ ] `commandTimeout` 을 50ms 로 두고 `DEBUG SLEEP 0.2` 중 명령을 보내 타임아웃 에러 확인 (터미널)
- [ ] `docker pause study-redis` 후 콘솔 명령이 어떻게 실패하는지, `unpause` 후 자동 재연결되는지 관찰
- [ ] `enableAutoPipelining` 을 켜고 Pipeline 실험의 순차 루프 시간이 줄어드는지 비교
- [ ] Sentinel 실험에서 `maxRetriesPerRequest` 를 1 로 바꿔 failover 중 실패를 보기
