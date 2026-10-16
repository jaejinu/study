---
title: "스레드와 자바 메모리 모델 — volatile, happens-before, 안전한 공개"
chapter: "3부 · 동시성"
order: 10
level: 심화
summary: "자바 스레드가 OS 스레드에 1:1 로 대응하는 구조와 비용, 스레드 상태, 왜 '한 스레드가 쓴 값을 다른 스레드가 영원히 못 볼 수 있는가'(JIT 호이스팅·CPU 재배치), 자바 메모리 모델의 happens-before 규칙 여섯 가지, volatile 이 보장하는 것과 보장하지 않는 것(count++ 는 여전히 깨진다), final 필드 의미론과 안전한 공개, 이중 검사 잠금(DCL)이 volatile 없이 깨지는 이유와 더 간단한 홀더 관용구, 그리고 실험으로 보는 가시성 버그"
tags: [Java, 스레드, 자바 메모리 모델, JMM, volatile, happens-before, 안전한 공개, DCL]
experiments: [java-jmm-visibility]
---

## 자바 스레드는 OS 스레드다

`new Thread(...)`(플랫폼 스레드)는 OS 스레드 하나에 1:1 로 대응한다. 그래서 비싸다.

| 비용 | 대략 |
|---|---|
| 스택 메모리 | 기본 최대 1MB 예약(실제 사용은 그보다 적지만 수천 개면 문제) |
| 생성·소멸 | 수십 μs — 요청마다 만들면 안 된다(→ 스레드 풀, [12장](/java/notes/12-executors-completablefuture)) |
| 컨텍스트 스위치 | 수 μs + 캐시 오염 — [OS 내부: 컨텍스트 스위치](/os-internals/notes/01-processes-threads-context-switch) |
| 개수 한계 | 수천~수만(메모리·`ulimit -u`·cgroup pids) |

스레드 하나가 요청 하나를 처리하는 전통적인 서블릿 모델(Tomcat 기본 200 스레드)에서는 "동시에 블로킹할 수 있는 요청 수 = 스레드 수" 다. 이 한계를 깨려는 것이 [가상 스레드](/java/notes/13-virtual-threads-structured)다.

### 스레드 상태

```
NEW → RUNNABLE ⇄ BLOCKED (synchronized 진입 대기)
                ⇄ WAITING (wait·join·park, 시간 제한 없음)
                ⇄ TIMED_WAITING (sleep·wait(ms)·park(ms))
       → TERMINATED
```

스레드 덤프(`jcmd <pid> Thread.print`)에서 이 상태를 본다. `BLOCKED` 가 쌓이면 락 경합, `WAITING` 이 쌓이면 풀·커넥션 대기다. 덤프 읽는 법은 [Java 4~6부 목차](/java/notes)의 진단 장에서 다룬다.

## 가시성 — 쓴 값이 안 보인다

```java
static boolean plain;                     // volatile 아님
// 스레드 A
while (!plain) i++;
// 메인 스레드, 1초 뒤
plain = true;
```

이 루프는 **끝나지 않을 수 있다**. 실험실의 [JMM 가시성 실험](/java/lab/java-jmm-visibility) 결과:

| 필드 | 결과 | join 대기 |
|---|---|---|
| 평범한 boolean (JIT) | **끝나지 않음** (2초 후에도 살아 있음) | 2000 ms |
| volatile boolean | 끝남 | 2 ms |
| 평범한 boolean, `-Xint`(인터프리터만) | 끝남 | 2 ms |

왜? 1초 동안 루프가 수억 번 돌며 C2 가 이 루프를 컴파일한다. C2 가 보기에 루프 안에서 `plain` 을 쓰는 코드가 없으니 **읽기를 루프 밖으로 끌어내** `if (!plain) while (true) i++;` 로 바꾼다(호이스팅). 이 최적화는 단일 스레드 의미로는 완벽히 합법이다. JIT 를 끈 `-Xint` 에서 끝나는 것이 원인이 하드웨어가 아니라 **컴파일러** 라는 증거다.

가시성 문제의 원인은 세 겹이다.

| 층 | 무엇이 재배치·캐시하나 |
|---|---|
| 컴파일러(javac·JIT) | 레지스터에 값 보관, 읽기 호이스팅, 명령 순서 변경 |
| CPU | 비순차 실행, 저장 버퍼(store buffer) — 내 쓰기가 아직 다른 코어 캐시에 안 감 |
| 캐시 일관성 | 프로토콜(MESI)이 결국 맞춰 주지만 "언제" 는 보장 없음 |

자바는 이 모든 층을 추상화한 **자바 메모리 모델(JMM)** 로 "언제 보이는가" 를 정의한다. 개발자는 하드웨어 대신 JMM 규칙만 지키면 된다.

## happens-before

JMM 의 핵심 개념이다. **A happens-before B 이면, A 의 모든 쓰기가 B 에 보인다.** 이 관계가 없으면 아무 보장이 없다.

![happens-before 관계](/diagrams/java-conc-jmm-hb.svg)

| 규칙 | A | → | B |
|---|---|---|---|
| 프로그램 순서 | 한 스레드 안의 앞 문장 | → | 같은 스레드의 뒤 문장 |
| 모니터 | `synchronized` 블록을 나감(unlock) | → | **같은 락** 으로 들어감(lock) |
| volatile | volatile 변수 쓰기 | → | **그 변수** 의 이후 읽기 |
| 스레드 시작 | `t.start()` 이전의 모든 것 | → | t 안의 첫 동작 |
| 스레드 종료 | t 안의 모든 것 | → | `t.join()` 의 반환 |
| 추이성 | A → B, B → C | → | A → C |

`java.util.concurrent` 의 도구들도 이 위에 정의돼 있다: `BlockingQueue.put` → 그 원소를 꺼낸 `take`, `Future` 의 작업 완료 → `get()` 반환, `CountDownLatch.countDown` → `await` 통과, `ExecutorService.submit` 이전 → 작업 실행.

```java
Thread t = new Thread(() -> System.out.println(Holder.get().url));
t.start(); t.join();
```

```
시작 전 쓴 값을 본다: redis://cache:6379
join 후 상태: TERMINATED
```

`start()` 이전의 쓰기는 새 스레드에 보이고, `join()` 이후에는 스레드 안의 쓰기가 보인다 — 규칙대로다.

> 자주 하는 오해: "synchronized 는 같은 락끼리만 의미가 있다." 맞다. 쓰는 쪽은 `lockA`, 읽는 쪽은 `lockB` 로 동기화하면 happens-before 가 없다. 읽기에도 같은 락이 필요하다.

## volatile 이 해 주는 것과 안 해 주는 것

| 보장 | 보장하지 않음 |
|---|---|
| 가시성: 쓰기가 이후 읽기에 보인다 | **원자성(복합 연산)**: `count++` 는 읽기·더하기·쓰기 세 단계 |
| 재배치 금지: volatile 쓰기 이전의 쓰기가 그 뒤로 밀리지 않는다 | 여러 변수에 걸친 불변식 |
| `long`·`double` 쓰기의 원자성(volatile 이 아니면 32비트씩 둘로 쪼개질 수 있음) | |

`volatile int count; count++` 를 여러 스레드에서 하면 여전히 값이 사라진다 — [다음 장](/java/notes/11-locks-juc)의 실측에서 `plain++` 은 1,600만 중 324만만 남았다. 카운터는 `AtomicLong`/`LongAdder`.

**volatile 이 맞는 곳**: 한 스레드가 쓰고 여러 스레드가 읽는 **플래그·상태 공개**(종료 신호, 설정 교체), 불변 객체의 참조 교체(`volatile Config current`).

## final 필드와 안전한 공개

객체를 다른 스레드에 넘기는 것을 **공개(publication)** 라고 한다. 동기화 없이 넘기면 받은 스레드가 **덜 초기화된 객체**(필드가 기본값 0·null)를 볼 수 있다 — 생성자의 필드 쓰기와 참조 대입이 재배치될 수 있기 때문이다.

예외가 `final` 필드다. 생성자에서 `this` 를 새게 하지 않았다면, **final 필드는 생성자가 끝난 뒤 어떤 스레드에서 봐도 초기화된 값** 이다(final 필드 의미론). 불변 객체가 동기화 없이 공유해도 안전한 이유다([2장](/java/notes/02-types-objects-immutability)).

안전한 공개 방법:

| 방법 | |
|---|---|
| 정적 초기화 | `static final Config C = new Config(...)` — 클래스 초기화는 JVM 이 동기화 |
| volatile 필드에 저장 | `volatile Config current` |
| 락으로 보호되는 필드 | 같은 락으로 읽기 |
| 스레드 안전 컬렉션에 넣기 | `ConcurrentHashMap.put` → `get` |
| final 필드 | 불변 객체 |

## 이중 검사 잠금(DCL)

지연 초기화 싱글턴의 유명한 함정이다.

```java
private static Config instance;          // volatile 없음 — 깨진 버전
static Config get() {
    if (instance == null) {              // ① 락 없이 검사
        synchronized (Holder.class) {
            if (instance == null) instance = new Config(...);   // ② 생성
        }
    }
    return instance;
}
```

②의 `instance = new Config(...)` 는 "메모리 할당 → 필드 초기화 → 참조 대입" 인데, 재배치로 **참조 대입이 필드 초기화보다 먼저** 보일 수 있다. 다른 스레드가 ①에서 null 이 아닌 `instance` 를 보고 락 없이 반환 — 필드가 아직 null 인 객체를 쓴다. ①의 읽기와 ②의 쓰기 사이에 happens-before 가 없기 때문이다.

고치는 법은 `volatile` 하나다(자바 5 의 JMM 이후로 올바르다).

```java
private static volatile Config instance;
static Config get() {
    Config c = instance;                 // volatile 읽기를 한 번만 (지역 변수로)
    if (c == null) {
        synchronized (Holder.class) {
            c = instance;
            if (c == null) instance = c = new Config("redis://cache:6379");
        }
    }
    return c;
}
```

```
DCL 인스턴스 수: 1, url=redis://cache:6379, 홀더=lazy
```

8 개 스레드에서 1000 번 호출해도 인스턴스는 하나다. 그런데 더 간단한 방법이 있다 — **초기화 지연 홀더**.

```java
static final class Lazy { static final Config INSTANCE = new Config("lazy"); }
// Lazy.INSTANCE 를 처음 참조할 때 JVM 이 클래스를 초기화 — 스레드 안전, 락 비용 없음
```

실무에서는 대부분 **DI 컨테이너(Spring 싱글턴 빈)** 가 이 일을 한다. 직접 지연 초기화가 필요하면 홀더 관용구나 `enum` 싱글턴을 쓴다.

## 예시로 보기 — 이 프로젝트에서

- 이 사이트 서버(Node)는 요청 처리 코드가 **단일 스레드** 이벤트 루프에서 돈다. 그래서 `src/lib/redis.ts` 의 싱글턴 클라이언트나 `src/lib/notes.ts` 의 메모리 캐시(`Map`)에 동기화가 없어도 된다 — 한 번에 한 콜백만 실행되기 때문이다. 같은 코드를 자바 서블릿에 옮기면 요청 스레드 200 개가 동시에 그 `HashMap` 캐시를 건드려 깨진다(`ConcurrentHashMap` 이 필요하다). Node 의 `worker_threads` 와 `SharedArrayBuffer` 를 쓰는 순간 같은 메모리 모델 문제가 나타난다 → [동시성](/concurrency).
- 분산 시스템의 일관성 모델(선형화·인과·최종)과 JMM 은 같은 질문 — "누가 쓴 값을 누가 언제 보나" — 의 다른 규모다 → [분산: 일관성 모델](/distributed-systems/notes/03-consistency-models). JMM 은 "데이터 경합이 없는 프로그램은 순차 일관성처럼 동작한다(DRF-SC)" 를 보장한다.
- 실험실 [JMM 가시성](/java/lab/java-jmm-visibility)을 돌려 위 표를 재현해 보자. 평범한 필드 버전이 끝나지 않는 것을 직접 보는 것이 이 장의 핵심이다.

### Spring 서비스에서

- 싱글턴 빈(`@Service`)에 **요청마다 바뀌는 상태를 필드로 두면** 모든 요청 스레드가 공유한다. 컨트롤러·서비스는 무상태로, 상태는 지역 변수·요청 범위 객체로.
- 설정 핫 리로드는 `volatile` 참조에 **새 불변 설정 객체를 통째로 교체** 하는 방식이 단순하고 안전하다.

## 정리

- 플랫폼 스레드 = OS 스레드. 비싸서 풀로 쓴다.
- 동기화 없는 공유 변수는 다른 스레드가 영원히 못 볼 수 있다 — 실험에서 JIT 호이스팅으로 루프가 끝나지 않았다.
- 보장은 happens-before 로만: 같은 락, 같은 volatile 변수, start/join, j.u.c 도구.
- volatile 은 가시성·재배치 금지이지 원자성이 아니다. 불변 객체(final 필드)는 안전하게 공유된다.
- DCL 은 volatile 이 필수. 더 간단한 홀더 관용구나 DI 를 쓴다.

다음: [락과 java.util.concurrent](/java/notes/11-locks-juc). 앞: [정렬·TreeMap](/java/notes/09-sorting-treemap-pq).

## 실습 체크리스트

- [ ] [JMM 가시성 실험](/java/lab/java-jmm-visibility)을 돌려 평범한 필드 버전이 끝나지 않는 것을 확인
- [ ] 같은 코드를 `-Xint` 와 `-XX:TieredStopAtLevel=1`(C1 만)로 돌려 어떤 컴파일 단계에서 호이스팅이 일어나는지 본다
- [ ] `volatile int` 카운터를 8 스레드로 증가시켜 값이 사라지는 것 — volatile 이 원자성이 아님 — 을 확인
- [ ] DCL 을 volatile 없이, 있게 써 보고, 홀더 관용구로 다시 쓴다
- [ ] `jcmd <pid> Thread.print` 로 스레드 덤프를 떠서 각 스레드의 상태를 읽는다
