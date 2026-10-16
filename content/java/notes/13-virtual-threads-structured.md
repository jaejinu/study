---
title: "가상 스레드와 구조적 동시성 — Loom, 캐리어와 피닝, StructuredTaskScope"
chapter: "3부 · 동시성"
order: 13
level: 심화
summary: "요청당 스레드 모델의 한계와 리액티브의 대가, 가상 스레드가 블로킹 호출에서 캐리어(플랫폼 스레드)를 내려놓는 원리(연속체·마운트·언마운트), 1만 개 블로킹 작업 실측(스레드 풀 200: 5091ms·스레드 226개 vs 가상 스레드: 126ms·26개), synchronized 안의 블로킹이 캐리어를 붙잡는 피닝(400개: 2321ms vs ReentrantLock 101ms)과 JDK 24 의 해결, ThreadLocal·풀링·CPU 작업에서의 주의점, 구조적 동시성(StructuredTaskScope)으로 하나가 실패하면 나머지를 취소하고 헤징하기, 언제 이득이고 언제 아닌가"
tags: [Java, 가상 스레드, Project Loom, 캐리어, 피닝, 구조적 동시성, StructuredTaskScope, Spring Boot]
experiments: [java-virtual-threads]
---

## 문제 — 블로킹은 스레드를 붙잡는다

전통적인 서블릿 서버는 요청 하나에 플랫폼 스레드 하나를 쓴다. 요청 처리 시간의 대부분은 DB·외부 API 응답을 **기다리는** 시간인데, 그동안 스레드(=OS 스레드, 스택 1MB)는 아무것도 안 하며 붙잡혀 있다. 그래서 동시 처리량이 스레드 수(Tomcat 기본 200)에 묶인다.

| 해법 | 대가 |
|---|---|
| 스레드를 늘린다(수천) | 메모리·컨텍스트 스위치 비용 |
| 리액티브(WebFlux·Reactor) | 모든 코드를 `Mono`/`Flux` 사슬로 — 스택 트레이스가 읽기 어렵고, 블로킹 라이브러리(JDBC)를 못 쓰고, 디버깅·학습 비용 |
| Node 처럼 이벤트 루프 | 언어가 처음부터 비동기(async/await)여야 함 |
| **가상 스레드** | 기존의 동기·블로킹 코드를 **그대로** 쓰면서 스레드를 수백만 개 |

## 가상 스레드는 어떻게 동작하나

가상 스레드는 JVM 이 관리하는 스레드다. OS 스레드가 아니다. 실제 실행은 소수의 플랫폼 스레드(**캐리어**, 기본적으로 CPU 코어 수만큼의 ForkJoinPool)가 맡는다.

![가상 스레드와 캐리어](/diagrams/java-conc-vthreads.svg)

1. 가상 스레드가 캐리어 위에 **마운트** 되어 실행된다.
2. 블로킹 호출(`sleep`, 소켓 읽기, `BlockingQueue.take`, JDBC 대기 …)을 만나면, JDK 가 그 지점의 스택을 **힙의 연속체(continuation) 객체로 떼어 내고**(언마운트) 캐리어를 놓아준다. 내부적으로는 논블로킹 I/O 와 이벤트 알림으로 바꿔 둔다.
3. 캐리어는 다른 가상 스레드를 실행한다.
4. I/O 가 준비되면 가상 스레드가 다시 아무 캐리어에나 마운트되어 이어서 실행된다.

개발자 코드는 평범한 블로킹 코드다. "기다리는 동안 OS 스레드를 놓아주는" 일을 JDK 가 대신 한다 — Node 의 이벤트 루프와 async/await 가 하는 일을, 코드 모양을 바꾸지 않고 런타임이 하는 셈이다.

```java
Thread vt = Thread.ofVirtual().name("v-1").start(() ->
    System.out.println(Thread.currentThread().isVirtual() + " " + Thread.currentThread()));
```

```
가상 스레드? true VirtualThread[#33,v-1]/runnable@ForkJoinPool-1-worker-1
```

`@ForkJoinPool-1-worker-1` 이 지금 이 가상 스레드를 태우고 있는 캐리어다.

## 실측 — 1만 개의 블로킹 작업

실험실 [가상 스레드 실험](/java/lab/java-virtual-threads): 100ms 씩 블로킹하는 작업 1만 개(컨테이너가 보는 CPU 18개).

| 방식 | 작업 수 | 총 시간 | 최대 플랫폼 스레드 |
|---|---|---|---|
| 고정 스레드 풀 200 | 10,000 | 5,091 ms | 226 |
| 가상 스레드 | 10,000 | **126 ms** | **26** |

- 스레드 풀 200 은 1만 개를 50 번에 나눠 처리한다 → 50 × 100ms ≈ 5초.
- 가상 스레드는 1만 개가 거의 동시에 잠들고 깨어난다 → 100ms + α. OS 스레드는 캐리어(≈코어 수)와 JVM 내부 스레드뿐이다.

처리량이 40배가 된 것이 아니라, **기다리는 동안 붙잡히는 자원이 사라진 것** 이다. CPU 계산이 주인 작업에서는 이득이 없다.

## 피닝 — 캐리어를 놓지 못할 때

JDK 21 에서 가상 스레드는 다음 상황에서 블로킹해도 캐리어에서 내려오지 못한다(**피닝**).

1. **`synchronized` 블록·메서드 안에서 블로킹** — 모니터가 OS 스레드에 묶여 있기 때문.
2. 네이티브 메서드·외부 함수 호출 안에서 블로킹.

| 방식 | 작업 수 | 총 시간 |
|---|---|---|
| 가상 스레드 + `synchronized` 안에서 sleep(100ms) | 400 | **2,321 ms** |
| 가상 스레드 + `ReentrantLock` 안에서 sleep(100ms) | 400 | 101 ms |

피닝되면 동시에 진행할 수 있는 수가 **캐리어 수(18)** 로 떨어진다: 400 / 18 × 100ms ≈ 2.2초. 각 작업이 **서로 다른 락 객체** 를 잡았는데도 그렇다 — 경합 때문이 아니라 캐리어를 붙잡았기 때문이다.

| 대처(JDK 21) | |
|---|---|
| 블로킹 구간의 `synchronized` 를 `ReentrantLock` 으로 | 정석 |
| 피닝 위치 찾기 | `-Djdk.tracePinnedThreads=short`, JFR 이벤트 `jdk.VirtualThreadPinned` |
| 라이브러리 확인 | 오래된 JDBC 드라이버·커넥션 풀이 내부에 synchronized 를 쓰는지 — 최신 버전 사용 |
| JDK 24+ | JEP 491 로 synchronized 피닝이 대부분 해결됨 |

## 주의할 점

| 함정 | 이유 | 대처 |
|---|---|---|
| 가상 스레드를 **풀링** | 가상 스레드는 싸다. 풀은 수를 제한해 이점을 없앤다 | 작업마다 새로(`newVirtualThreadPerTaskExecutor`) |
| 동시성 제한이 사라짐 | 풀이 하던 "동시에 N 개만" 이 없어져 DB·외부 API 를 수천 개 요청이 동시에 친다 | **`Semaphore`** 로 하류별 동시 호출 제한, 커넥션 풀 크기 확인 |
| `ThreadLocal` | 가상 스레드 수백만 × ThreadLocal 값 = 메모리 | 요청 범위 값은 매개변수로, 또는 스코프 값(`ScopedValue`, 21 미리보기 → 25 정식) |
| CPU 집약 작업 | 계산 중엔 내려오지 않으므로 이점 없음, 캐리어를 독점 | CPU 작업은 플랫폼 스레드 풀 |
| 장시간 계산 루프 | 가상 스레드는 시간 분할 선점이 없다 | 계산은 별도 풀로 |

## 구조적 동시성

비동기 작업을 여러 개 띄우면 흔히 생기는 문제: 하나가 실패해도 나머지가 계속 돌고(자원 낭비), 부모가 먼저 끝나도 자식이 고아로 남고, 스레드 덤프에서 누가 누구를 띄웠는지 모른다. **구조적 동시성** 은 "자식 작업의 수명은 그것을 띄운 코드 블록 안으로 한정된다" 는 원칙이다 — `try` 블록을 나가면 자식이 모두 끝나 있다.

`StructuredTaskScope` 는 JDK 21 에서 **미리보기** 다(`--enable-preview`, API 는 이후 버전에서 바뀌었다). 개념을 보자.

```java
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    var user   = scope.fork(() -> fetch("user", 200, false));
    var orders = scope.fork(() -> fetch("orders", 1000, false));
    var coupon = scope.fork(() -> fetch("coupon", 100, true));   // 100ms 에 실패
    scope.join();
    scope.throwIfFailed();
    return user.get() + orders.get() + coupon.get();
}
```

```
ShutdownOnFailure: coupon 실패 → 나머지 취소, 104 ms 에 끝남 (orders 1000ms 를 기다리지 않음)
```

```java
try (var scope = new StructuredTaskScope.ShutdownOnSuccess<String>()) {
    scope.fork(() -> fetch("replica-A", 300, false));
    scope.fork(() -> fetch("replica-B", 80, false));
    scope.join();
    return scope.result();                 // 먼저 성공한 것
}
```

```
ShutdownOnSuccess(헤징): replica-B 가 먼저, 82 ms
```

| 정책 | 동작 | 용도 |
|---|---|---|
| `ShutdownOnFailure` | 하나라도 실패하면 나머지 취소 | 화면 조합(모두 필요한 데이터) |
| `ShutdownOnSuccess` | 하나라도 성공하면 나머지 취소 | **헤징**(복제본 중 먼저 오는 것) — [성능: 꼬리 지연](/performance/notes/08-tail-latency-at-scale) |

`CompletableFuture` 로도 할 수 있지만, 취소 전파·고아 작업 방지·스레드 덤프의 부모-자식 관계를 직접 챙겨야 한다. 구조적 동시성은 이것을 **문법 구조(try 블록)** 로 강제한다.

## 언제 쓰나

| 이득이 큰 곳 | 이득이 없는 곳 |
|---|---|
| 요청당 스레드 서버의 I/O 대기(DB·HTTP 호출이 많은 API) | CPU 계산(인코딩·암호화·통계) |
| 외부 호출을 병렬로 모으는 조합 서비스 | 이미 리액티브로 잘 돌아가는 서비스(갈아엎을 이유는 약함) |
| 블로킹 클라이언트(JDBC·RestClient)를 그대로 쓰고 싶을 때 | synchronized 가 깊숙이 박힌 오래된 라이브러리(21 기준) |

## 예시로 보기 — 이 프로젝트에서

- 이 사이트(Node)는 처음부터 이벤트 루프 + async/await 다. `await redis.get(...)` 에서 함수는 멈추지만 스레드는 다른 요청을 처리한다 — 가상 스레드가 자바에 가져온 것이 바로 이 성질이다. 차이는 자바는 **코드에 async/await 를 쓰지 않아도** 된다는 점(함수 색깔 문제가 없다)과, CPU 작업은 여전히 여러 코어에서 병렬로 돈다는 점이다.
- 이 사이트의 실험 러너가 여러 단계를 순서대로 실행하고 한 단계가 실패하면 나머지를 건너뛰는 것, 그리고 데드맨 스위치가 블록을 나갈 때 반드시 정리되는 것은 구조적 동시성과 같은 발상이다 — "시작한 것은 그 블록 안에서 끝낸다".
- [가상 스레드 실험](/java/lab/java-virtual-threads)을 돌려 위 두 표를 재현해 보자. `-Djdk.tracePinnedThreads=short` 를 붙이면 피닝 위치가 스택으로 찍힌다.

### Spring Boot 에서

```properties
# Spring Boot 3.2+, Java 21
spring.threads.virtual.enabled=true
```

이 한 줄로 Tomcat 요청 처리, `@Async`, 스케줄러가 가상 스레드를 쓴다. 켠 뒤 확인할 것:

1. DB 커넥션 풀(HikariCP) 크기 — 요청 수천 개가 커넥션 20 개를 기다리게 된다. 병목이 스레드에서 커넥션으로 옮겨 갈 뿐이다.
2. 외부 API 호출에 `Semaphore`·레이트리밋 — 하류를 지킨다.
3. JFR 로 피닝 이벤트를 본다(JDK 21 이면 특히).
4. 부하 테스트로 지연 분포를 전후 비교 → [성능: k6 부하 테스트](/performance/notes/03-k6-load-testing).

## 정리

- 가상 스레드는 블로킹 호출에서 캐리어를 내려놓아, 동기 코드 그대로 수만 개의 동시 대기를 가능하게 한다(실측: 5초 → 0.13초, OS 스레드 226 → 26).
- JDK 21 에서는 synchronized 안의 블로킹이 피닝을 일으킨다(실측 23배 느림) — ReentrantLock 으로 바꾸거나 JDK 24+.
- 가상 스레드는 풀링하지 말고, 대신 하류 보호를 위해 Semaphore 로 동시성을 제한한다. CPU 작업에는 이점이 없다.
- 구조적 동시성은 자식 작업의 수명을 블록으로 묶어 취소·실패 전파·헤징을 단순하게 만든다.

이것으로 1~3부(언어·컬렉션·동시성)를 마친다. 처음부터 다시 보려면 [자바와 JVM 생태계](/java/notes/01-java-jvm-ecosystem). 다음은 JVM 내부·GC·성능·운영을 다루는 4~6부 — [Java 노트 목차](/java/notes). 동시성의 언어 중립적인 원리는 [동시성 프로그래밍](/concurrency) 주제에서 이어진다.

## 실습 체크리스트

- [ ] [가상 스레드 실험](/java/lab/java-virtual-threads)을 돌려 스레드 풀 200 과 가상 스레드의 시간·스레드 수를 비교
- [ ] 같은 실험을 `docker run --cpus=2` 로 돌려 피닝 시간이 캐리어 수에 따라 바뀌는 것을 확인(400 / 2 × 100ms)
- [ ] `-Djdk.tracePinnedThreads=short` 로 피닝 스택을 출력
- [ ] 가상 스레드 1만 개가 DB 를 동시에 치지 않도록 `Semaphore(20)` 로 제한하는 코드를 쓴다
- [ ] `--enable-preview --source 21` 로 `StructuredTaskScope.ShutdownOnFailure` 예제를 돌려 실패 시 나머지가 취소되는 것을 확인
