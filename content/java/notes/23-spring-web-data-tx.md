---
title: "Spring 웹·데이터·트랜잭션 — 서블릿 vs WebFlux, JPA 영속성 컨텍스트와 N+1, @Transactional 함정과 전파"
chapter: "6부 · 빌드·프레임워크·운영"
order: 23
level: 심화
summary: "요청 하나가 스레드 하나를 끝까지 쓰는 Spring MVC 와 이벤트 루프 위의 WebFlux, 그리고 그 사이를 바꿔 놓은 가상 스레드, JPA 영속성 컨텍스트(1차 캐시·변경 감지·쓰기 지연)와 N+1·지연 로딩 함정, @Transactional 의 전파·격리·읽기 전용·롤백 규칙, 트랜잭션 안의 외부 호출이 커넥션 풀을 말리는 이유와 HikariCP 크기 계산"
tags: [Spring MVC, WebFlux, 가상 스레드, JPA, N+1, 영속성 컨텍스트, Transactional, HikariCP]
experiments: []
---

[Spring 핵심](/java/notes/22-spring-core)이 "객체를 어떻게 조립하나" 였다면, 이 노트는 "요청이 들어와 DB 에 닿기까지 무슨 일이 일어나나" 다. 자바 서비스 장애의 대부분 — 느린 응답, 커넥션 풀 고갈, 쿼리 폭발, 데이터 불일치 — 가 이 경로에서 나온다.

## 서블릿(MVC) vs WebFlux vs 가상 스레드

| | Spring MVC (서블릿) | Spring WebFlux | MVC + 가상 스레드 (JDK 21) |
|---|---|---|---|
| 모델 | 요청당 스레드 하나가 끝까지 (블로킹 I/O) | 소수 이벤트 루프 스레드 + 논블로킹 (Reactor) | 요청당 **가상** 스레드, 블로킹 코드 그대로 |
| 동시 요청 한계 | 스레드 풀 크기(Tomcat 기본 200) | 수만 (메모리 한도) | 수만 |
| 코드 | 평범한 순차 코드 | `Mono`/`Flux` 체인, 연산자 학습 필요 | 평범한 순차 코드 |
| 디버깅·스택 트레이스 | 쉬움 | 어렵다 (비동기 경계) | 쉬움 |
| 블로킹 라이브러리(JDBC) | 그대로 | **금지** — 이벤트 루프를 멈춘다 | 그대로 (일부 핀 고정 주의) |
| 맞는 곳 | 대부분의 CRUD 서비스 | 스트리밍·게이트웨이·수많은 느린 외부 호출 | MVC 를 쓰되 대기가 많은 서비스 |

```yaml
spring.threads.virtual.enabled: true   # Boot 3.2+: Tomcat 요청·@Async·스케줄러가 가상 스레드
```

> WebFlux 의 이벤트 루프는 [Node.js 이벤트 루프](/nodejs/notes/02-event-loop-phases)·[Redis 단일 스레드](/redis/notes/01-redis-overview)와 같은 원리다: 블로킹 호출 하나가 그 루프의 모든 요청을 멈춘다. 가상 스레드는 "블로킹 코드를 쓰면서 논블로킹의 확장성" 을 주지만, **병목이 DB 커넥션이라면 스레드를 늘려도 빨라지지 않는다** — 아래 커넥션 풀 절.

## JPA 영속성 컨텍스트 — 마법의 정체

트랜잭션마다 `EntityManager` 가 **영속성 컨텍스트**(엔티티의 1차 캐시이자 변경 추적기)를 들고 있다.

| 기능 | 동작 | 효과·함정 |
|---|---|---|
| 1차 캐시 | 같은 트랜잭션에서 같은 id 를 두 번 `find` → 두 번째는 SQL 없음 | 같은 객체 동일성 보장 |
| **변경 감지(dirty checking)** | 커밋(flush) 시 스냅샷과 비교해 바뀐 필드만 UPDATE | `save()` 를 안 불러도 저장된다 — 의도치 않은 UPDATE 의 원인 |
| 쓰기 지연 | INSERT/UPDATE 를 모았다가 flush 때 | 배치(`hibernate.jdbc.batch_size`)와 함께 쓰면 왕복 감소 |
| 지연 로딩 | 연관 엔티티를 프록시로 두었다가 접근할 때 SELECT | **N+1**, 트랜잭션 밖 접근 시 `LazyInitializationException` |

### N+1 — 가장 흔한 JPA 성능 사고

```java
List<Order> orders = orderRepo.findAll();                  // SELECT * FROM orders           (1)
for (Order o : orders) total += o.getCustomer().getGrade(); // SELECT * FROM customers WHERE id=? × N
```

| 해결 | 방법 | 쿼리 수 |
|---|---|---|
| 페치 조인 | `@Query("select o from Order o join fetch o.customer")` | 1 |
| `@EntityGraph` | `@EntityGraph(attributePaths = "customer")` | 1 |
| 배치 페치 | `hibernate.default_batch_fetch_size=100` → `WHERE id IN (...)` | 1 + N/100 |
| DTO 프로젝션 | 필요한 열만 `select new OrderView(...)` | 1, 엔티티 관리 비용도 없음 |

탐지: `spring.jpa.properties.hibernate.generate_statistics=true`, 또는 테스트에서 쿼리 수를 단언(datasource-proxy). [데이터 접근 병목 노트](/performance/notes/05-data-access-bottlenecks)의 N+1 과 같은 문제이고, 원인이 ORM 의 지연 로딩일 뿐이다. 페치 조인을 컬렉션 두 개에 동시에 걸면 카티션 곱(`MultipleBagFetchException`)이 나므로 하나는 배치 페치로.

> OSIV(Open Session In View, Boot 기본 켜짐)는 뷰 렌더링까지 영속성 컨텍스트를 열어 두어 `LazyInitializationException` 을 숨기지만, **요청 내내 DB 커넥션을 붙잡는다**. API 서버는 `spring.jpa.open-in-view=false` 로 끄고 필요한 데이터를 서비스 계층에서 미리 로딩한다.

## @Transactional — 규칙과 함정

```java
@Transactional(readOnly = true)                              // 클래스 기본: 읽기 전용
class OrderService {
    @Transactional                                           // 쓰기 메서드만 덮어쓰기
    public void place(PlaceOrder cmd) { ... }
}
```

| 속성 | 기본 | 의미 |
|---|---|---|
| `propagation` | `REQUIRED` | 있으면 참여, 없으면 새로. `REQUIRES_NEW` 는 바깥을 잠시 멈추고 **새 커넥션**으로 새 트랜잭션 |
| `isolation` | DB 기본 (PG·MySQL 다름) | [격리 수준 노트](/postgres/notes/03-mvcc-isolation) |
| `readOnly` | false | Hibernate flush 생략·스냅샷 생략, 일부 드라이버는 읽기 복제본 라우팅 |
| `rollbackFor` | 런타임 예외·Error 만 롤백 | 체크 예외는 **커밋된다** |
| `timeout` | 없음 | 긴 트랜잭션 방지 |

| 함정 | 증상 |
|---|---|
| 자기 호출 | 같은 클래스 안 호출에 트랜잭션 안 걸림 ([프록시](/java/notes/22-spring-core)) |
| 체크 예외 | 예외가 났는데 데이터가 커밋됨 |
| `REQUIRES_NEW` 남용 | 요청 하나가 커넥션 두 개 → 풀 크기의 절반 동시 요청에서 **데드락처럼 멈춤** |
| 예외를 잡고 삼킴 | 안쪽 `REQUIRED` 가 롤백 표시 → 바깥 커밋 시 `UnexpectedRollbackException` |
| **트랜잭션 안의 외부 호출** | HTTP·메시지 발행이 느리면 그동안 커넥션을 잡고 있음 → 풀 고갈 |

### 트랜잭션 안의 외부 호출 — 풀 고갈의 정석

```java
@Transactional
public void place(PlaceOrder cmd) {
    orderRepo.save(order);              // 커넥션 획득
    paymentClient.charge(order);        // ⚠ 외부 PG 가 3초 걸리면 3초 동안 커넥션 점유
    kafka.send("orders", event);        // ⚠ 커밋 전에 이벤트가 나간다 (롤백되면 유령 이벤트)
}
```

- 커넥션 풀 10개, 이 메서드가 3초 → **초당 3.3건이 상한**. 그 이상은 `HikariPool-1 - Connection is not available, request timed out after 30000ms`.
- 외부 호출은 트랜잭션 밖으로, 이벤트는 [아웃박스](/kafka/notes/08-cdc-outbox-debezium)나 `@TransactionalEventListener(phase = AFTER_COMMIT)` 으로.
- 이 장애를 직접 재현한 것이 [PostgreSQL 커넥션 고갈 실험](/chaos/lab/chaos-pg-connection-exhaustion)이다.

## HikariCP — 풀 크기 계산

| 설정 | 기본 | 권장 |
|---|---|---|
| `maximumPoolSize` | 10 | 작게 시작. 경험식 `코어 × 2 + 디스크 수` (DB 쪽 코어 기준) |
| `connectionTimeout` | 30s | **짧게 (1~3s)** — 빨리 실패해야 상위가 폴백 |
| `maxLifetime` | 30분 | DB·프록시의 유휴 끊김보다 짧게 |
| `leakDetectionThreshold` | 꺼짐 | 2~10s 로 켜서 반환 안 된 커넥션의 스택 출력 |

풀은 크다고 빠르지 않다. DB 는 코어 수 이상의 동시 쿼리를 병렬로 처리하지 못하고, 커넥션마다 메모리를 쓴다(PG 는 프로세스). **파드 수 × 풀 크기 ≤ DB max_connections** 도 지켜야 한다 — 오토스케일 때 깨지기 쉬운 식([PG 운영](/postgres/notes/05-operations), PgBouncer). 관측은 `hikaricp_connections_active`·`_pending`·`_acquire_seconds` 다.

## 캐시 — @Cacheable 과 Redis

```java
@Cacheable(cacheNames = "product", key = "#id")
public ProductView find(long id) { ... }        // 프록시가 먼저 캐시를 보고, 없으면 실행 후 저장

@CacheEvict(cacheNames = "product", key = "#cmd.id")
@Transactional
public void update(UpdateProduct cmd) { ... }   // ⚠ 커밋 전에 지우면 그 사이 옛 값이 다시 캐시될 수 있다
```

- `spring-boot-starter-data-redis` + `spring.cache.type=redis` 면 [캐시 어사이드](/redis/notes/08-caching-patterns)가 어노테이션 하나로 된다. TTL 은 `spring.cache.redis.time-to-live`.
- 직렬화: 기본 JDK 직렬화는 크고 클래스 변경에 취약 → `GenericJackson2JsonRedisSerializer`.
- 스탬피드(만료 순간 동시 미스)는 `@Cacheable(sync = true)`(JVM 안에서만 한 번) 또는 Redis 락([분산 락](/redis/notes/09-distributed-lock)).
- 자기 호출이면 캐시도 무시된다 — 모든 프록시 어노테이션의 공통 함정.

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 실험 [`chaos-pg-connection-exhaustion`](/chaos/lab/chaos-pg-connection-exhaustion)이 `max_connections` 를 다 채워 새 연결이 거부되는 순간을 실측한다. Spring 서비스에서는 그 앞단의 Hikari 풀이 먼저 마르고, 증상은 `connectionTimeout` 만큼의 지연 후 예외다.
- [이벤트 소싱 노트의 낙관적 동시성](/event-sourcing/notes/03-event-store)과 JPA 의 `@Version` 은 같은 기법이다(버전 불일치면 `OptimisticLockException` → 재시도).
- [결제·원장 노트](/architecture/notes/09-payments-ledger-consistency)의 "외부 PG 호출을 트랜잭션 밖으로, 멱등 키로" 가 위 `place()` 의 올바른 모양이다.

## 실전에서는 어디에 쓰이나

> 요청이 들어와 DB 에 닿는 경로다. 느린 응답, 커넥션 풀 고갈, 쿼리 폭발, 데이터 불일치 같은 자바 서비스 장애의 대부분이 여기서 나온다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 목록 API | 주문 100건 조회에 쿼리 101번(N+1) | 페치 조인·`@EntityGraph`·`default_batch_fetch_size`, 테스트에서 쿼리 수 단언 | DTO 프로젝션, jOOQ·MyBatis 로 직접 SQL |
| 핀테크 결제 처리 | 트랜잭션 안의 외부 PG 호출이 커넥션을 붙잡아 풀 고갈 | 외부 호출은 트랜잭션 밖으로 + 멱등 키, 이벤트는 아웃박스·`AFTER_COMMIT` | 사가 기반 비동기 처리 |
| 오토스케일되는 API 서비스 | Pod 수 × 풀 크기가 DB `max_connections` 초과 | 작은 풀, 짧은 `connectionTimeout`, `hikaricp_connections_pending` 알림 | PgBouncer 같은 커넥션 프록시 |
| 상품 상세 조회 | 같은 데이터 반복 조회로 DB 부하 | `@Cacheable` + Redis(JSON 직렬화, TTL, `sync = true`) | 로컬 캐시와 2단 구성 |
| 스트리밍·게이트웨이 서비스 | 느린 외부 호출이 많아 요청 스레드가 묶임 | WebFlux(논블로킹) 또는 MVC + 가상 스레드 | 스레드 풀 증설 |
| 재고·포인트 동시 수정 | 덮어쓰기로 인한 갱신 유실 | JPA `@Version` 낙관적 잠금 + 재시도 | 비관적 잠금(`SELECT … FOR UPDATE`) |

**이럴 땐 안 맞는다**
- 수십만 건 갱신 배치를 JPA 엔티티로 하나씩: 영속성 컨텍스트·변경 감지 비용이 크다 → JDBC 배치, 벌크 UPDATE.
- WebFlux 에서 JDBC 같은 블로킹 라이브러리: 이벤트 루프가 멈춘다 → R2DBC, 또는 MVC + 가상 스레드.
- `REQUIRES_NEW` 남용: 요청 하나가 커넥션 두 개를 잡아 풀 크기 절반의 동시 요청에서 멈춘다 → 정말 독립 커밋이 필요한 곳만.

**누가 매일 만나나** — Spring 백엔드 개발자가 느린 API 의 쿼리 로그, `LazyInitializationException`, `Connection is not available` 을 볼 때. DBA·SRE 는 커넥션 수와 느린 쿼리를 함께 본다.

**면접·실무 단골 질문**
- Q. N+1 문제란, 어떻게 푸나? → 지연 로딩된 연관을 루프에서 건드려 건마다 SELECT 가 나가는 것. 페치 조인, EntityGraph, 배치 페치, DTO 프로젝션.
- Q. API 서버에서 OSIV 를 끄는 이유는? → 요청 내내 DB 커넥션을 붙잡아 풀이 마른다. 필요한 데이터는 서비스 계층에서 미리 로딩한다.

## 실습 체크리스트

- [ ] 연관 엔티티를 루프에서 접근하는 코드로 N+1 을 만들고 SQL 로그로 쿼리 수 세기 → 페치 조인으로 1개로
- [ ] `open-in-view` 를 끄고 컨트롤러에서 지연 로딩 접근 시 `LazyInitializationException` 확인
- [ ] 체크 예외를 던지는 `@Transactional` 메서드가 커밋되는 것을 확인하고 `rollbackFor` 로 고치기
- [ ] 풀 크기 2, 트랜잭션 안에서 `Thread.sleep(2000)` 하는 엔드포인트에 동시 요청 10개를 보내 `Connection is not available` 재현
- [ ] `spring.threads.virtual.enabled=true` 로 바꿔 같은 부하에서 Tomcat 스레드 수와 응답 시간 비교 (병목이 풀이면 그대로임을 확인)
- [ ] 다음: [운영과 관측](/java/notes/24-operations-observability)
