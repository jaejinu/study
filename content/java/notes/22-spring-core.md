---
title: "Spring 핵심 — IoC·DI, 빈 생명주기, 프록시와 AOP, 자동 설정과 스타터"
chapter: "6부 · 빌드·프레임워크·운영"
order: 22
level: 중급
summary: "Spring 이 객체를 대신 만들고 연결하는 제어의 역전(IoC)과 의존성 주입(DI), 생성자 주입을 권하는 이유, 빈 스코프와 생명주기 콜백, BeanPostProcessor 가 빈을 프록시로 감싸 @Transactional·@Async·@Cacheable 이 동작하는 원리와 자기 호출(self-invocation) 함정, JDK 동적 프록시 vs CGLIB, Spring Boot 자동 설정·조건부 빈·스타터, 시작 시간과 메모리"
tags: [Spring, IoC, DI, 빈 생명주기, AOP, 프록시, 자동 설정, Spring Boot]
experiments: []
---

Spring 은 "객체를 누가 만들고 누구와 연결하나" 를 코드 대신 **컨테이너**가 맡게 한다. 그 결과 테스트에서 가짜를 끼우기 쉽고, 트랜잭션·보안·캐시 같은 공통 관심사를 **프록시**로 덧씌울 수 있다. 반대로 그 마법을 모르면 "어노테이션을 붙였는데 왜 안 되지" 를 수없이 만난다. 이 노트는 그 마법의 정체를 다룬다.

![Spring 빈 생명주기와 요청 처리](/diagrams/java-spring-request.svg)

## IoC 와 DI — 객체를 직접 만들지 않는다

```java
// 직접 만들기: OrderService 가 구현을 고르고 생명주기를 책임진다
class OrderService {
    private final OrderRepository repo = new JdbcOrderRepository(new HikariDataSource(...));
}

// 의존성 주입: 무엇이 필요한지만 선언, 누가 줄지는 컨테이너가 정한다
@Service
class OrderService {
    private final OrderRepository repo;
    private final PaymentClient payment;
    OrderService(OrderRepository repo, PaymentClient payment) {   // 생성자 하나면 @Autowired 생략
        this.repo = repo; this.payment = payment;
    }
}
```

| 주입 방식 | 장점 | 단점 | 권장 |
|---|---|---|---|
| **생성자** | `final` 가능(불변), 필수 의존성 명확, 순환 의존을 시작 시점에 발견, 테스트에서 `new` 로 생성 | 의존성이 많으면 생성자가 길다(→ 설계 신호) | **기본** |
| 세터 | 선택적 의존성 | 반쯤 초기화된 객체 가능 | 선택적일 때만 |
| 필드(`@Autowired private`) | 짧다 | 테스트에서 리플렉션 필요, `final` 불가, 순환 의존 숨김 | 쓰지 않음 |

> 생성자 인자가 7~8개를 넘으면 클래스가 너무 많은 일을 한다는 신호다. DI 는 설계 냄새를 숨기지 않고 드러낸다.

## 빈 스코프

| 스코프 | 인스턴스 | 주의 |
|---|---|---|
| `singleton` (기본) | 컨테이너당 하나 | **상태를 가지면 안 된다** — 모든 요청 스레드가 공유([동시성](/java/notes)) |
| `prototype` | 주입·조회마다 새로 | 싱글톤에 주입하면 한 번만 만들어짐 → `ObjectProvider<T>` 로 |
| `request`·`session` | HTTP 요청·세션당 | 싱글톤에 주입 시 스코프 프록시 필요 |

## 빈 생명주기와 BeanPostProcessor

컨테이너가 빈을 만드는 순서(그림 왼쪽):

1. 정의 수집 — 컴포넌트 스캔·`@Configuration`·자동 설정 → `BeanDefinition`
2. `BeanFactoryPostProcessor` — 정의를 고친다(프로퍼티 자리표시자 해석 등)
3. 인스턴스화 — 생성자 호출, 의존 빈을 먼저 만든다
4. 주입 — 필드·세터, `*Aware` 콜백
5. `BeanPostProcessor.postProcessBeforeInitialization` → `@PostConstruct` → `afterPropertiesSet`
6. **`BeanPostProcessor.postProcessAfterInitialization` — 여기서 프록시로 감싼다**
7. 등록 — 다른 빈은 원본이 아니라 **프록시**를 주입받는다
8. 종료 — `@PreDestroy`, `DisposableBean`

`@Transactional`, `@Async`, `@Cacheable`, `@Retryable`, Spring Security 의 메서드 보안, Micrometer `@Timed` 가 모두 **6단계의 프록시**로 동작한다.

## 프록시와 AOP — 그리고 가장 흔한 함정

```java
@Service
class OrderService {
    @Transactional
    public void place(Order o) { save(o); notifyLater(o); }

    @Transactional(propagation = REQUIRES_NEW)
    public void save(Order o) { ... }        // ⚠ place() 에서 this.save() — 프록시를 안 거친다

    @Async
    public void notifyLater(Order o) { ... } // ⚠ 같은 이유로 동기 실행된다
}
```

```text
컨트롤러 ──▶ [OrderService 프록시] ──트랜잭션 시작──▶ OrderService.place()
                                                         └─ this.save()  ← 프록시가 아니라 자기 자신
```

| 함정 | 증상 | 해결 |
|---|---|---|
| **자기 호출** | 같은 클래스 안의 `@Transactional`·`@Async`·`@Cacheable` 이 조용히 무시 | 별도 빈으로 분리, 또는 자신의 프록시를 주입(`@Lazy` self) |
| `private`·`final` 메서드 | CGLIB 가 오버라이드할 수 없어 어노테이션 무시 | public, non-final |
| 체크 예외 | `@Transactional` 은 기본적으로 **런타임 예외에만** 롤백 | `rollbackFor = Exception.class` |
| 프록시 타입 | 인터페이스 없으면 CGLIB(하위 클래스) — 생성자가 두 번 불리는 것처럼 보일 수 있음 | Boot 기본은 CGLIB(`proxyTargetClass=true`) |

| 프록시 | 방식 | 조건 |
|---|---|---|
| JDK 동적 프록시 | 인터페이스 구현 객체를 런타임 생성 | 인터페이스가 있어야 |
| CGLIB (ByteBuddy) | 클래스를 상속한 하위 클래스를 런타임 생성 | final 클래스·메서드 불가 |

AOP 의 용어(어드바이스·포인트컷·조인포인트)는 결국 "어떤 메서드 호출 앞뒤에 어떤 코드를 끼울지" 다. Spring AOP 는 **프록시 기반이라 메서드 호출에만** 끼울 수 있다(AspectJ 위빙은 필드 접근·생성자까지).

## Spring Boot 자동 설정 — 클래스패스가 설정이다

```text
spring-boot-starter-data-redis 를 추가
  → 클래스패스에 Lettuce·spring-data-redis 가 생김
  → RedisAutoConfiguration 의 @ConditionalOnClass(RedisOperations.class) 가 참
  → 내가 RedisConnectionFactory 빈을 안 만들었으면(@ConditionalOnMissingBean)
  → application.yml 의 spring.data.redis.* 로 LettuceConnectionFactory·RedisTemplate 생성
```

| 조건 어노테이션 | 뜻 |
|---|---|
| `@ConditionalOnClass` | 이 클래스가 클래스패스에 있으면 |
| `@ConditionalOnMissingBean` | 사용자가 같은 타입 빈을 안 만들었으면 — **사용자 설정이 항상 이긴다** |
| `@ConditionalOnProperty` | 설정값이 이러면 |
| `@ConditionalOnWebApplication` | 웹 앱이면 |

자동 설정 목록은 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`. **무엇이 왜 켜졌는지**는:

```bash
java -jar app.jar --debug          # CONDITIONS EVALUATION REPORT: Positive/Negative matches
curl localhost:8080/actuator/conditions
```

**스타터**는 "이 기능에 필요한 의존성 묶음 + 자동 설정" 이다(`spring-boot-starter-web` = Spring MVC + Tomcat + Jackson + 자동 설정). 버전은 [Boot BOM](/java/notes/21-build-dependencies)이 맞춰 둔다.

## 설정 — 우선순위

명령행 인자 > 환경 변수(`SPRING_DATA_REDIS_HOST`) > `application-{profile}.yml` > `application.yml` > 기본값. k8s 에서는 ConfigMap·Secret 을 환경 변수로 넣는 것이 가장 단순하다([ConfigMap·Secret](/kubernetes/notes/05-configmap-secret)). 타입 안전한 설정은 `@ConfigurationProperties` 레코드로:

```java
@ConfigurationProperties("study.cache")
record CacheProps(Duration ttl, int maxSize) {}
```

## 시작 시간과 메모리 — 마법의 비용

컴포넌트 스캔·리플렉션·프록시 생성·자동 설정 평가가 모두 시작 시점에 일어난다. 중간 크기 앱이 **3~10초, 힙 200~400MB** 로 시작하는 이유. 줄이는 방법:

| 방법 | 효과 |
|---|---|
| `spring.main.lazy-initialization=true` | 시작 단축 (대신 첫 요청이 느리고 설정 오류를 늦게 발견) |
| 불필요한 스타터 제거 | 자동 설정 평가·빈 수 감소 |
| AppCDS, Spring AOT | 클래스 로딩·리플렉션 분석을 빌드 타임으로 |
| GraalVM 네이티브 이미지 | 시작 0.1초 수준, 메모리 1/3 (빌드 느림, 리플렉션 제약) |
| CRaC | 워밍업된 상태를 체크포인트로 저장·복원 |

자세한 비교는 [운영과 관측](/java/notes/24-operations-observability).

## 테스트 — 컨텍스트를 얼마나 띄울 것인가

| 방식 | 띄우는 것 | 속도 | 쓸 때 |
|---|---|---|---|
| 순수 단위 테스트 (`new Service(fakeRepo)`) | 없음 | ms | 도메인 로직 — **생성자 주입의 보상** |
| `@WebMvcTest(OrderController.class)` | MVC 계층만 + `@MockBean` | 1~2s | 컨트롤러·검증·직렬화 |
| `@DataJpaTest` | JPA·DataSource 만 | 수 s | 쿼리·매핑 (Testcontainers 로 진짜 PG) |
| `@SpringBootTest` | 전체 | 수~수십 s | 통합 시나리오 소수 |

Spring 은 같은 설정의 테스트끼리 **컨텍스트를 캐시**한다. 테스트마다 `@MockBean` 조합이 다르면 캐시가 깨져 매번 새로 띄운다 — 테스트 스위트가 느린 흔한 원인이다. [통합 테스트와 컨테이너](/testing/notes/03-integration-containers)의 Testcontainers 와 함께 쓴다.

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 `src/lib/subjects.ts`·`src/lab/registry.ts` 는 Spring 없이 손으로 만든 작은 "등록부" 다 — 주제·실험을 선언하면 화면·환경 점검이 그것을 찾아 쓴다. 규모가 커지면 이런 등록·조립을 프레임워크(컨테이너)가 맡게 되는 것이 IoC 의 출발점이다.
- Spring 의 `@ConditionalOnClass` 자동 설정은 이 사이트의 [환경 점검 카드](/platform-engineering/notes/07-this-repo-as-idp)가 "Docker 가 있으면 이 실험을 켠다" 와 같은 발상이다.
- 트랜잭션 프록시 안에서 DB 커넥션을 잡는다는 사실은 [커넥션 풀 고갈 장애](/chaos/notes/02-failure-catalog)와 바로 이어진다 — 다음 노트.

## 실전에서는 어디에 쓰이나

> 많은 자바 백엔드가 Spring Boot 위에서 돈다. DI·프록시·자동 설정의 정체를 알면 "어노테이션을 붙였는데 안 된다" 류의 버그와 느린 시작·느린 테스트의 원인을 바로 짚을 수 있다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 서비스 | 같은 클래스 내부 호출의 `@Transactional`·`@Async` 가 무시됨 | 별도 빈으로 분리해 프록시를 거치게 | `TransactionTemplate` 같은 프로그래밍 방식 |
| 사내 공통 기능(로깅·감사·메트릭) | 수십 개 서비스에 횡단 관심사 일괄 적용 | 사내 스타터 + 자동 설정, `@ConditionalOnMissingBean` 으로 덮어쓰기 허용 | 서비스마다 복붙 |
| 쿠버네티스 배포 설정 | 환경별 DB·Redis 주소 주입 | ConfigMap·Secret → 환경 변수 → `@ConfigurationProperties` record | 설정 서버 |
| 대형 모놀리스의 테스트 스위트 | 테스트가 수십 분 | 생성자 주입으로 순수 단위 테스트, 슬라이스 테스트, `@MockBean` 조합 통일로 컨텍스트 캐시 유지 | 테스트 샤딩 |
| 빠른 스케일 아웃이 필요한 서비스 | 수 초짜리 시작 시간 | Spring AOT·AppCDS, 네이티브 이미지, CRaC | 빌드 타임 DI 프레임워크(Micronaut·Quarkus) |

**이럴 땐 안 맞는다**
- 싱글턴 빈에 요청별 상태를 필드로: 모든 요청 스레드가 공유해 값이 섞인다 → 무상태 빈, 상태는 지역 변수로.
- 작은 CLI·짧게 도는 함수에 Spring 전체: 시작 비용이 일보다 크다 → 순수 자바나 경량 프레임워크.
- 필드 주입: 테스트가 어렵고 순환 의존을 숨긴다 → 생성자 주입.

**누가 매일 만나나** — Spring 백엔드 개발자가 매일, 특히 "트랜잭션이 안 걸린다", "같은 타입 빈이 둘이라 주입 실패" 를 볼 때. 플랫폼팀은 사내 스타터와 자동 설정을 만들 때 만난다.

**면접·실무 단골 질문**
- Q. 같은 클래스 안에서 호출한 `@Transactional` 은 왜 동작하지 않나? → 프록시를 거치지 않는 자기 호출이라 트랜잭션 어드바이스가 끼어들 자리가 없다.
- Q. 생성자 주입을 권장하는 이유는? → `final` 로 불변, 필수 의존성이 명확, 순환 의존을 시작 시점에 발견, 테스트에서 `new` 로 만들 수 있다.

## 실습 체크리스트

- [ ] 필드 주입을 생성자 주입으로 바꾸고, 그 클래스를 Spring 없이 `new` 로 단위 테스트
- [ ] 같은 클래스 안에서 `@Transactional(REQUIRES_NEW)` 메서드를 호출해 새 트랜잭션이 안 열리는 것을 로그(`logging.level.org.springframework.transaction=DEBUG`)로 확인
- [ ] `--debug` 실행의 CONDITIONS EVALUATION REPORT 에서 내 앱에 켜진 자동 설정 세기
- [ ] `@ConditionalOnMissingBean` 을 이용해 자동 설정된 `RedisTemplate` 을 내 빈으로 덮어쓰기
- [ ] `lazy-initialization` 켜고 끄고 시작 시간과 첫 요청 지연 비교
- [ ] 다음: [Spring 웹·데이터·트랜잭션](/java/notes/23-spring-web-data-tx)
