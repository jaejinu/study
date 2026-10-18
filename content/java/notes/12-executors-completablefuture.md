---
title: "Executor·CompletableFuture — 스레드 풀 크기, 거부 정책, 비동기 조합과 예외"
chapter: "3부 · 동시성"
order: 12
level: 심화
summary: "스레드를 직접 만들지 않는 이유와 ExecutorService, ThreadPoolExecutor 의 동작 순서(코어 → 큐 → 최대 → 거부)와 그 직관에 반하는 점, 무한 큐가 장애를 숨기는 문제, 풀 크기 공식(CPU 작업 ≈ 코어 수, I/O 작업 ≈ 코어 × (1 + 대기/계산), 리틀의 법칙), 거부 정책 네 가지와 백프레셔, CompletableFuture 로 병렬 호출 조합(300ms 두 개 → 307ms), exceptionally·handle·orTimeout·completeOnTimeout, 기본 실행기(공용 풀) 함정, 종료와 인터럽트"
tags: [Java, ExecutorService, ThreadPoolExecutor, 스레드 풀, CompletableFuture, 거부 정책, 백프레셔, 타임아웃]
experiments: [java-virtual-threads]
---

## 스레드를 직접 만들지 않는다

`new Thread(task).start()` 를 요청마다 하면 생성 비용(수십 μs)과 개수 폭발(메모리·OOM) 문제가 생긴다. **실행기(Executor)** 는 작업 제출과 실행을 분리하고 스레드를 재사용한다.

```java
ExecutorService ex = Executors.newFixedThreadPool(8);
Future<String> f = ex.submit(() -> callApi());
String r = f.get(1, TimeUnit.SECONDS);       // 결과 대기(시간 제한)
ex.shutdown();                                // 새 작업 거부, 진행 중은 마저
ex.awaitTermination(10, TimeUnit.SECONDS);
```

| 팩토리 | 실체 | 주의 |
|---|---|---|
| `newFixedThreadPool(n)` | 코어=최대=n, **무한** `LinkedBlockingQueue` | 큐가 끝없이 쌓여 메모리·지연 폭발 |
| `newCachedThreadPool()` | 코어 0, 최대 **무한**, 직접 전달 큐 | 부하가 몰리면 스레드 수천 개 |
| `newSingleThreadExecutor()` | 1 스레드, 무한 큐 | 순서 보장 |
| `newScheduledThreadPool(n)` | 지연·주기 실행 | |
| `newVirtualThreadPerTaskExecutor()` | 작업마다 가상 스레드 | [13장](/java/notes/13-virtual-threads-structured) |
| `ForkJoinPool` | 작업 훔치기(work stealing) | 분할 정복·병렬 스트림 |

운영 코드에서는 편의 팩토리 대신 **`ThreadPoolExecutor` 를 직접** 만들어 큐 크기와 거부 정책을 명시하는 것이 좋다.

## ThreadPoolExecutor 의 동작 순서

```
작업 제출 →
  ① 실행 중 스레드 < corePoolSize  → 새 스레드
  ② 아니면 큐에 넣기 (가득 차지 않았으면)
  ③ 큐가 가득 → 스레드 < maximumPoolSize 면 새 스레드
  ④ 그것도 안 되면 → 거부 정책
```

**직관에 반하는 점**: 스레드를 최대까지 늘린 **다음에** 큐에 넣는 것이 아니라, **큐가 가득 찬 뒤에야** 최대까지 늘린다. 그래서 무한 큐(`newFixedThreadPool`)를 쓰면 `maximumPoolSize` 는 영영 쓰이지 않는다.

```java
var pool = new ThreadPoolExecutor(2, 2, 0, SECONDS,
        new ArrayBlockingQueue<>(2),                    // 유한 큐
        new ThreadPoolExecutor.AbortPolicy());
for (int i = 0; i < 6; i++) pool.execute(() -> slow(200));
```

```
코어 2 + 큐 2 에 6개 제출: 수락 4, 거부 2
```

2 개는 바로 실행, 2 개는 큐, 나머지 2 개는 거부 — 시스템이 감당할 수 있는 양을 **명시적으로** 넘었다는 신호다.

### 무한 큐는 장애를 숨긴다

하류(DB·외부 API)가 느려지면 무한 큐에 작업이 계속 쌓인다. 응답은 점점 늦어지고(큐 대기), 메모리가 차고, 사용자는 이미 떠났는데 서버는 몇 분 전 요청을 처리한다. 유한 큐 + 거부는 **빠르게 실패** 해서 부하 차단(load shedding)과 백프레셔를 가능하게 한다 → [성능: 꼬리 지연과 대규모](/performance/notes/08-tail-latency-at-scale).

### 거부 정책

| 정책 | 동작 | 언제 |
|---|---|---|
| `AbortPolicy`(기본) | `RejectedExecutionException` | 호출자가 503 으로 바꿔 응답 |
| `CallerRunsPolicy` | **제출한 스레드가 직접 실행** | 자연스러운 백프레셔 — 제출 속도가 저절로 느려짐 |
| `DiscardPolicy` | 조용히 버림 | 거의 쓰지 않는다(유실을 모름) |
| `DiscardOldestPolicy` | 큐의 가장 오래된 것을 버리고 넣음 | 최신 값만 중요한 갱신(위치 추적) |

## 풀 크기는 얼마로

| 작업 성격 | 공식 | 예(코어 8) |
|---|---|---|
| CPU 계산 | ≈ 코어 수(+1) | 8~9 |
| I/O 대기가 섞임 | 코어 × (1 + 대기 시간 / 계산 시간) | 계산 10ms·대기 90ms → 8 × 10 = 80 |
| 하류 자원으로 제한 | 하류의 동시 처리 한계 이하 | DB 커넥션 풀 20 이면 그 이상 늘려 봐야 커넥션 대기 |

**리틀의 법칙**(L = λ × W): 초당 200 요청(λ)을 평균 0.5초(W) 걸려 처리하면 동시에 100 개(L)가 진행 중이다 — 스레드 100 개가 필요하다 → [성능의 언어](/performance/notes/01-language-of-performance). 풀 크기를 늘리기 전에 **하류가 그 동시성을 감당하는지** 먼저 본다. 스레드만 늘리면 DB 커넥션 대기로 줄이 옮겨 갈 뿐이다.

컨테이너에서는 `Runtime.availableProcessors()` 가 **cgroup CPU 한도** 를 반영한다(`--cpus=2` 면 2). 이 실험 환경에서는 18 이었다:

```
CPU 18개, 공용 ForkJoinPool 병렬도 17
```

## CompletableFuture — 비동기 조합

`Future.get()` 은 블로킹뿐이다. `CompletableFuture` 는 **콜백 사슬** 로 조합한다.

```java
var io = Executors.newFixedThreadPool(4);
CompletableFuture<String> user   = CompletableFuture.supplyAsync(() -> slow("user", 300), io);
CompletableFuture<String> orders = CompletableFuture.supplyAsync(() -> slow("orders", 300), io);
String combined = user.thenCombine(orders, (u, o) -> u + "+" + o).join();
```

```
병렬 조합 user+orders: 307 ms (순차면 600ms)
```

| 메서드 | 뜻 |
|---|---|
| `thenApply(f)` | 결과 변환(동기 함수) — `map` |
| `thenCompose(f)` | 결과로 다음 비동기 작업 — `flatMap` |
| `thenCombine(other, f)` | 둘 다 끝나면 합치기 |
| `allOf(...)` / `anyOf(...)` | 전부 / 아무거나 |
| `thenAccept`, `thenRun` | 결과 소비 |
| `...Async` 변형 | 콜백을 **다른 스레드(실행기)** 에서 |

### 예외와 타임아웃

```java
CompletableFuture.supplyAsync(() -> { throw new IllegalStateException("결제 API 장애"); }, io)
    .exceptionally(e -> "fallback(" + e.getCause().getMessage() + ")");
CompletableFuture.supplyAsync(() -> slow("느림", 2000), io).orTimeout(300, MILLISECONDS);
CompletableFuture.supplyAsync(() -> slow("느림", 2000), io).completeOnTimeout("캐시값", 300, MILLISECONDS);
```

```
exceptionally → fallback(결제 API 장애)
orTimeout → TimeoutException
completeOnTimeout → 캐시값
```

| 메서드 | 동작 |
|---|---|
| `exceptionally(f)` | 실패하면 대체값(폴백) |
| `handle((v, e) -> ...)` | 성공·실패 둘 다 받아 변환 |
| `whenComplete((v, e) -> ...)` | 결과는 그대로 두고 부수 효과(로그·메트릭) |
| `orTimeout(t)` | 시간 내 안 끝나면 `TimeoutException` 으로 실패 |
| `completeOnTimeout(v, t)` | 시간 내 안 끝나면 기본값으로 완료 |

주의: 예외는 `CompletionException` 으로 **감싸여** 온다 — `e.getCause()` 를 본다. 그리고 **`orTimeout` 은 원래 작업을 멈추지 않는다** — 2초짜리 작업은 백그라운드에서 계속 돈다. 진짜로 하류 호출을 끊으려면 HTTP 클라이언트·드라이버 자체의 타임아웃을 함께 건다. 데드라인을 하류로 전파하는 이유가 이것이다 → [API 설계: 에러·재시도·데드라인](/api-design/notes/04-errors-retries-deadlines).

### 기본 실행기의 함정

`supplyAsync(task)` 처럼 **실행기를 안 주면 공용 ForkJoinPool** 에서 돈다(병렬도 = CPU − 1). 여기에 블로킹 I/O 를 넣으면 공용 풀이 막혀 병렬 스트림까지 멈춘다([4장](/java/notes/04-lambdas-streams)). **I/O 작업은 항상 전용 실행기를 넘긴다.**

## 종료와 인터럽트

```java
ex.shutdown();                                     // 새 작업 거부
if (!ex.awaitTermination(30, SECONDS)) {
    ex.shutdownNow();                              // 진행 중 작업에 인터럽트
}
```

- 자바의 취소는 **협조적** 이다. `shutdownNow`·`Future.cancel(true)` 는 인터럽트 플래그만 세운다. 작업이 `sleep`·`wait`·블로킹 큐에서 `InterruptedException` 을 받거나 `Thread.interrupted()` 를 확인해야 멈춘다.
- `InterruptedException` 을 잡고 무시하지 않는다. 처리할 수 없으면 `Thread.currentThread().interrupt()` 로 플래그를 되살려 위로 알린다.
- 풀 스레드에 이름을 준다(`ThreadFactory`). 스레드 덤프에서 `pool-3-thread-7` 보다 `payment-io-7` 이 백배 낫다.
- 작업 안에서 난 예외는 `execute` 면 스레드를 죽이며 로그로, `submit` 이면 **Future 안에 갇혀** 아무도 `get()` 하지 않으면 사라진다.

## 예시로 보기 — 이 프로젝트에서

- 이 사이트(Node)는 `Promise.all([...])` 로 병렬 호출을 조합한다 — 첫 화면은 34 개 주제의 노트·퀴즈를 동시에 읽는다(`src/app/page.tsx`). 자바라면 `CompletableFuture.allOf(...)` 다. Node 는 I/O 가 이벤트 루프에서 비동기라 스레드 풀 크기를 고민할 일이 적지만, 대신 CPU 작업 하나가 전체를 막는다 → [성능: Node 웹 서버](/performance/notes/04-node-web-server-performance).
- AI 에게 묻기(`src/app/api/ask/route.ts`)는 모델 호출에 타임아웃을 걸고 실패를 이벤트로 바꿔 보낸다 — `orTimeout` + `exceptionally` 와 같은 구조다.
- 실험실 [가상 스레드 실험](/java/lab/java-virtual-threads)의 "고정 스레드 풀 200" 행은 이 장의 스레드 풀이 블로킹 작업 1만 개를 어떻게 처리하는지(50번에 나눠 약 5초) 보여 준다.

### Spring 서비스에서

```java
@Bean
ThreadPoolTaskExecutor ioExecutor() {
    var e = new ThreadPoolTaskExecutor();
    e.setCorePoolSize(16); e.setMaxPoolSize(32); e.setQueueCapacity(200);
    e.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
    e.setThreadNamePrefix("io-");
    e.setWaitForTasksToCompleteOnShutdown(true); e.setAwaitTerminationSeconds(30);
    return e;
}
```

`@Async` 의 기본 실행기는 버전에 따라 스레드를 무한히 만들 수 있으니 반드시 직접 정의한다. 실행기의 활성 스레드·큐 크기·거부 수를 Micrometer 로 메트릭에 내보내 대시보드에 둔다 → [관측성: 계측](/observability/notes/03-instrumentation-exporters).

## 실전에서는 어디에 쓰이나

> 스레드 풀과 비동기 조합은 "외부 호출 여러 개를 모아 한 응답을 만드는" API, 알림 발송 같은 백그라운드 처리, 주기 작업에 쓰인다. 큐 크기와 거부 정책을 정하지 않으면 하류 장애가 서버 장애로 번진다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 상품 상세 조합 API | 가격·재고·리뷰 서비스를 병렬 호출 | `CompletableFuture.allOf` + 전용 I/O 실행기 + `orTimeout`·`exceptionally` 폴백 | 가상 스레드, 리액티브(WebFlux) |
| 알림·이메일 발송 | 응답 시간에서 발송 시간을 떼어 내기 | 유한 큐 `ThreadPoolExecutor` 를 `@Async` 전용 실행기로 | 메시지 큐(Kafka 등)로 넘김 |
| 트래픽이 몰리는 이벤트 API | 과부하 때 서버 전체가 느려짐 | 유한 큐 + `AbortPolicy` → 503(부하 차단), 또는 `CallerRunsPolicy` 백프레셔 | 게이트웨이 레이트 리밋 |
| 배달·모빌리티 위치 갱신 | 최신 값만 의미 있는 작업 | `DiscardOldestPolicy` | 최신 값만 덮어쓰는 저장소 키 |
| 정산·리포트 주기 실행 | 정해진 간격의 작업 | `newScheduledThreadPool`, Spring `@Scheduled` | 배치 스케줄러, k8s CronJob |

**이럴 땐 안 맞는다**
- `newFixedThreadPool`·`newCachedThreadPool` 을 그대로 운영: 무한 큐·무한 스레드라 하류 장애가 메모리 폭발로 번진다 → 큐 크기와 거부 정책을 명시한 `ThreadPoolExecutor`.
- 재시작돼도 잃으면 안 되는 작업: 메모리 큐라 프로세스가 죽으면 사라진다 → 영속 큐(Kafka, DB outbox).
- I/O 작업에 실행기 없는 `supplyAsync`: 공용 ForkJoinPool 이 막힌다 → 전용 실행기를 넘긴다.

**누가 매일 만나나** — 백엔드 개발자가 외부 API 호출을 병렬화하거나 `@Async` 를 붙일 때, SRE 가 실행기의 활성 스레드·큐 크기·거부 수 메트릭과 스레드 덤프의 풀 이름을 볼 때 만난다.

**면접·실무 단골 질문**
- Q. ThreadPoolExecutor 에 작업이 들어가는 순서는? → 코어 스레드 → 큐 → 최대 스레드 → 거부. 무한 큐면 최대 스레드는 영영 쓰이지 않는다.
- Q. I/O 위주 작업의 풀 크기는 어떻게 정하나? → 코어 × (1 + 대기/계산), 리틀의 법칙으로 필요한 동시성을 구하고, 하류(DB 커넥션 풀) 한계 이하로 맞춘다.

## 정리

- 스레드는 실행기로 재사용한다. 편의 팩토리는 무한 큐·무한 스레드 함정이 있으니 운영에선 `ThreadPoolExecutor` 를 명시.
- 순서: 코어 → 큐 → 최대 → 거부. 유한 큐 + 거부 정책이 백프레셔다.
- 풀 크기: CPU 작업은 코어 수, I/O 는 리틀의 법칙과 하류 한계로.
- `CompletableFuture` 로 병렬 조합, 예외는 감싸여 오고, `orTimeout` 은 원래 작업을 멈추지 않는다. I/O 에는 전용 실행기.

다음: [가상 스레드와 구조적 동시성](/java/notes/13-virtual-threads-structured). 앞: [락과 j.u.c](/java/notes/11-locks-juc).

## 실습 체크리스트

- [ ] 코어 2·큐 2 풀에 작업 6 개를 넣어 거부를 재현하고, `CallerRunsPolicy` 로 바꿔 제출 스레드가 직접 실행하는 것을 확인
- [ ] `newFixedThreadPool` 의 큐가 무한히 자라는 상황(느린 작업 + 빠른 제출)을 만들고 큐 크기를 출력
- [ ] 300ms 호출 두 개를 순차와 `thenCombine` 으로 각각 실행해 시간을 비교
- [ ] `orTimeout` 이 원래 작업을 멈추지 않는다는 것을 작업 안의 로그로 확인
- [ ] `submit` 한 작업에서 예외를 던지고 `get()` 을 하지 않으면 예외가 사라지는 것을 확인
