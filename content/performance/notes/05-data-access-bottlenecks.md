---
title: 데이터 접근 병목 — N+1, 인덱스, 커넥션 풀, 배치·파이프라인, 캐시
order: 5
level: 중급
summary: "대부분의 지연이 데이터 접근에서 오는 이유, N+1 문제의 발견과 해결(조인·IN·DataLoader), 인덱스와 EXPLAIN 으로 보는 쿼리 비용, 커넥션 풀 크기의 공식과 풀 고갈의 되먹임, 왕복 횟수를 줄이는 배치·파이프라인·멀티 키, 캐시 적중률·TTL·스탬피드, Redis 지연의 원인(큰 키·KEYS·fork·스왑), 그리고 이 프로젝트 실험으로 각각 확인"
tags: [N+1, 인덱스, EXPLAIN, 커넥션 풀, 배치, 파이프라인, 캐시, 적중률, 스탬피드, 큰 키, 지연]
experiments: [perf-k6-redis-path]
---

## 왜 데이터 접근인가

전형적 웹 요청의 시간 분포: 네트워크 10%, 앱 CPU 10~20%, **데이터 접근 60~80%**. 그리고 데이터 접근 지연의 대부분은 쿼리 자체가 아니라 **왕복 횟수**(RTT × N)와 **대기**(풀, 락)다. 그래서 순서는 (1) 왕복을 줄이고 (2) 각 왕복을 빠르게 하고 (3) 아예 안 가게(캐시) 한다.

| 접근 | 지연 (대략) |
|---|---|
| 프로세스 메모리 | 100ns |
| 같은 호스트 Redis | 0.1~0.3ms |
| 같은 AZ Redis/PG | 0.5~1ms |
| 인덱스 PK 조회 (PG, 캐시 적중) | 0.2~1ms + RTT |
| 디스크 읽는 쿼리 | 수~수십 ms |
| 다른 리전 | 50~200ms |

## N+1 — 가장 흔하고 가장 비싼 실수

```ts
const orders = await db.query("select * from orders where user_id = $1", [uid]);   // 1
for (const o of orders) {
  o.items = await db.query("select * from items where order_id = $1", [o.id]);      // N
}
// 주문 50개 → 51 왕복 × 1ms = 51ms. 주문 500개면 0.5초.
```

발견: 트레이스에서 **같은 모양의 span 이 수십 개 연달아**([트레이싱](/observability/notes/06-tracing-otel)), PG `pg_stat_statements` 에서 calls 가 비정상적으로 많은 짧은 쿼리, ORM 로그.

해결:
```sql
-- (a) 조인 한 번
select o.*, i.* from orders o left join items i on i.order_id = o.id where o.user_id = $1;
-- (b) IN 두 번 (결과가 중복 없이 작음)
select * from items where order_id = any($1::int[]);
```
- ORM: Prisma `include`, Drizzle `with`, TypeORM `relations` — 내부적으로 (a) 또는 (b).
- GraphQL/중첩 리졸버: **DataLoader** 패턴 — 같은 틱의 요청을 모아 한 번의 `IN` 으로(배치 + 요청 범위 캐시).
- Redis 도 마찬가지: 루프 안의 `GET` 은 `MGET` 또는 파이프라인으로.

## 인덱스와 EXPLAIN

쿼리 하나가 느리면 **실행 계획**부터. [인덱스·EXPLAIN](/postgres/notes/02-indexes-explain) 과 [쿼리 최적화 심화](/postgres/notes/07-query-optimization-deep) 가 깊이 다루므로 여기선 성능 관점의 요약:

- `EXPLAIN (ANALYZE, BUFFERS)` 로 **실제** 시간과 버킷 수를 본다. 추정 행 수와 실제 행 수가 10배 이상 다르면 통계 문제(`ANALYZE`).
- `Seq Scan` 이 큰 테이블에서 나오면 인덱스 후보. 하지만 작은 테이블이나 대부분의 행을 읽는 쿼리는 Seq Scan 이 맞다.
- **복합 인덱스 순서**: 등호 조건 컬럼 먼저, 범위 조건 나중. `(user_id, created_at)` 은 `user_id = ? and created_at > ?` 에 좋고 `created_at > ?` 만으로는 못 쓴다.
- **커버링 인덱스**(`INCLUDE`) 로 테이블 접근 제거(Index Only Scan). `OFFSET` 페이지네이션은 뒤로 갈수록 느리다 → 키셋 페이지네이션(`pg-keyset-pagination` 실험).
- 쓰기가 많은 테이블의 인덱스는 **쓰기 비용**이다. 안 쓰는 인덱스는 `pg_stat_user_indexes.idx_scan = 0` 으로 찾아 지운다.
- 락 대기도 "느린 쿼리" 로 보인다: `pg_stat_activity.wait_event_type = 'Lock'` ([잠금·교착](/postgres/notes/04-locks-deadlocks)).

## 커넥션 풀 — 크기가 처리량 상한이다

커넥션 수립은 비싸다(PG 는 프로세스 fork, TLS). 풀로 재사용한다. 그런데 풀 크기는 **클수록 좋지 않다**.

> HikariCP 의 공식: **풀 크기 ≈ CPU 코어 × 2 + 디스크 스핀들 수** (DB 서버 기준). 10~20 이면 대부분 충분.

이유: DB 가 동시에 실행할 수 있는 쿼리는 코어 수에 묶인다. 풀 100개면 90개는 DB 안에서 **대기**하며 컨텍스트 스위치·락 경합만 늘린다. 앱 인스턴스 10개 × 풀 20 = DB 커넥션 200 → PG `max_connections` 와 메모리(커넥션당 수 MB) 압박 → PgBouncer 같은 **외부 풀러**(transaction 모드)로 다중화.

리틀의 법칙으로 검산: 풀 10, 평균 쿼리 5ms → 2000 qps 상한. 그 이상이면 `pool.waitingCount` 가 쌓이고 **풀 대기 시간**이 지연에 더해진다. 풀 고갈의 되먹임:

```
느린 쿼리 1개(락 대기) → 커넥션 점유 → 다른 요청이 풀 대기 → 타임아웃 → 재시도 → 더 많은 대기 → 전체 다운
```

대책: 쿼리 타임아웃(`statement_timeout`), 풀 **획득** 타임아웃(`connectionTimeoutMillis`)을 짧게 두고 빨리 실패, 풀 대기 메트릭 알림. `chaos-pg-connection-exhaustion` 실험이 이 되먹임을 재현한다([장애 카탈로그](/chaos/notes/02-failure-catalog)).

Redis 는 다르다: 단일 커넥션에 **파이프라인**으로 명령을 겹쳐 보내므로 ioredis 는 커넥션 1개로 수만 ops/s. 풀은 블로킹 명령(BLPOP, SUBSCRIBE) 용 별도 커넥션만.

## 왕복 줄이기 — 배치와 파이프라인

| 기법 | Redis | PostgreSQL |
|---|---|---|
| 다중 키 명령 | `MGET`, `MSET`, `HMGET`, `SMISMEMBER` | `IN`/`ANY`, 다중 행 `INSERT … VALUES (),(),()` |
| 파이프라인 | `pipeline().get().get().exec()` — 응답 안 기다리고 연속 전송 | `pg` 의 pipeline 모드(libpq 14+), 또는 트랜잭션에 묶기 |
| 서버 측 스크립트 | Lua `EVAL` — 여러 명령을 한 왕복·원자적 | 저장 프로시저, CTE 로 한 문장 |
| 프리페치/조인 | — | 조인, 윈도 함수로 한 번에 |

[파이프라이닝](/redis/notes/06-pipelining) 의 `pipeline-vs-sequential` 실험: 1만 `SET` 을 개별로 보내면 RTT × 1만, 파이프라인은 수십 ms. **왕복이 병목이면 명령 수를 줄이는 게 아니라 왕복 수를 줄인다.**

## 캐시 — 안 가는 것이 가장 빠르다

[캐싱 패턴](/redis/notes/08-caching-patterns) 이 패턴을, 여기선 성능 지표를:

- **적중률(hit ratio)** = hits / (hits + misses). 90% 면 DB 부하가 1/10. 적중률이 낮으면 캐시가 비용만 든다 — 키 분포(핫 키가 있나), TTL(너무 짧나), 키 설계(파라미터 순서가 달라 같은 데이터가 다른 키로)를 본다. Redis `INFO stats` 의 `keyspace_hits/misses`.
- **TTL** 은 "얼마나 stale 해도 되나" 와 "적중률" 의 트레이드오프. 변경 시 무효화(`DEL`)를 붙이면 TTL 을 길게 둘 수 있다.
- **스탬피드**: 핫 키 만료 순간 수백 요청이 동시에 DB 로 → 락(`SET NX`)으로 한 요청만 재생성, 또는 **확률적 조기 갱신**(xfetch), stale-while-revalidate. 실험 `cache-stampede` 참고.
- 캐시 계층: 프로세스 메모리(LRU, μs) → Redis(ms) → DB. 프로세스 캐시는 인스턴스마다 다르고 무효화가 어렵다(짧은 TTL 로만).
- 메모리: `maxmemory` + `allkeys-lru`. 메모리가 차면 축출이 CPU 를 쓰고 적중률이 떨어진다([메모리·성능](/redis/notes/12-memory-performance)).

## Redis 자체가 느릴 때

Redis 는 보통 0.1ms 이지만 다음이 지연을 만든다([성능 튜닝](/redis/notes/19-performance-tuning)):

| 원인 | 증상 | 확인 |
|---|---|---|
| **큰 키·느린 명령** | `KEYS *`, 100만 원소 `SMEMBERS`, `HGETALL` 큰 해시 → 단일 스레드가 수십 ms 점유, 모든 클라이언트 대기 | `SLOWLOG GET`, `redis-cli --bigkeys`, `LATENCY LATEST` |
| **fork(RDB/AOF rewrite)** | 메모리 큰 인스턴스에서 fork 가 수십~수백 ms | `INFO stats` 의 `latest_fork_usec` |
| **스왑/THP** | 간헐적 수백 ms | `LATENCY DOCTOR`, THP 비활성화 |
| 네트워크·대역폭 | 큰 값 반복 조회 | `INFO` 의 `total_net_output_bytes`, 값 압축 |
| 클라이언트 측 | 커넥션 재생성, 동기 호출 직렬화 | 클라이언트 풀/파이프라인, [클라이언트 설계](/redis/notes/17-client-design) |

## 예시로 보기 — 이 프로젝트에서

**증폭 계수**(`perf-k6-redis-path`): 첫 화면 요청 1개가 Redis 명령 수십 개(주제 16개 × `SMEMBERS` 2 + `SCAN` + `HGETALL`)가 된다. 이것이 N+1 의 Redis 판이다. 개선안: `progress:read` 와 `progress:lab` 은 전체를 한 번만 읽고 메모리에서 주제별로 나누기(16회 → 2회), `progress:checks:*` 는 `SCAN` 대신 주제별 Set 인덱스로 — 증폭 계수가 1/10 이 된다. 실험 결과의 "증폭 계수" 숫자를 개선 전후로 비교해 보자.

**PG 실험들**: `pg-keyset-pagination`(OFFSET 10만 vs 키셋 — 수십 배 차이), `pg-partition-pruning`, `pg-vector-search`(작은 테이블에서는 플래너가 Seq Scan 을 고르는 게 맞다는 것도) — 전부 `EXPLAIN (ANALYZE, BUFFERS)` 를 출력한다.

**Redis 실험들**: `pipeline-vs-sequential`(왕복의 비용), `cache-stampede`(만료 순간의 폭주와 락), `encodings-scan`(KEYS 대신 SCAN) — [Redis 실험실](/redis/lab). 큰 키·느린 명령은 `/redis/monitor` 의 SLOWLOG 패널에서 본다.

**커넥션 고갈**: `chaos-pg-connection-exhaustion` 이 풀을 고의로 비우고 획득 타임아웃이 어떻게 동작하는지 보여 준다. 그 실험의 대기 시간 분포가 바로 "풀 대기가 지연에 더해진다" 의 측정값이다.

## 실습 체크리스트

- [ ] 첫 화면의 Redis 호출을 2회로 줄이는 리팩터링을 하고 `perf-k6-redis-path` 의 증폭 계수와 p95 를 전후 비교한다
- [ ] `pg_stat_statements` 에서 calls 가 가장 많은 쿼리를 찾아 N+1 인지 확인한다
- [ ] 풀 크기 5/20/100 으로 같은 k6 부하를 주고 p99 와 PG `pg_stat_activity` 의 활성/대기 수를 비교한다
- [ ] `redis-cli --bigkeys` 와 `SLOWLOG GET 10` 으로 느린 명령을 찾고 `SCAN` 으로 바꾼다
- [ ] 캐시 적중률(`keyspace_hits/misses`)을 Grafana 패널로 만들고 TTL 을 바꿔 가며 본다
