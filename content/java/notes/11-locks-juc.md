---
title: "락과 java.util.concurrent — synchronized, ReentrantLock, Atomic, LongAdder, ConcurrentHashMap"
chapter: "3부 · 동시성"
order: 11
level: 심화
summary: "경합 조건이 값을 잃는 실측(8 스레드 × 200만 증가 → plain++ 은 324만만 남음), synchronized 의 동작(모니터·재진입·락 상태)과 비용, ReentrantLock 의 tryLock·타임아웃·공정성·Condition, ReadWriteLock 과 StampedLock 의 낙관적 읽기, CAS 기반 AtomicLong 과 경합이 심할 때 셀을 나누는 LongAdder(13ms vs AtomicLong 203ms vs synchronized 470ms), ConcurrentHashMap 의 버킷 단위 락과 merge·compute 의 원자성, HashMap 을 공유하면 생기는 일, 교착 상태와 피하는 법"
tags: [Java, synchronized, ReentrantLock, AtomicLong, LongAdder, ConcurrentHashMap, CAS, 교착 상태]
experiments: [java-jmm-visibility]
---

## 경합 조건

8 개 스레드가 각자 200만 번씩 카운터를 증가시켰다. 기대값은 1,600만.

| 방식 | 시간 | 결과 |
|---|---|---|
| `plain++` (동기화 없음) | 62 ms | **3,248,430** |
| `synchronized` | 470 ms | 16,000,000 |
| `ReentrantLock` | 134 ms | 16,000,000 |
| `AtomicLong.incrementAndGet` | 203 ms | 16,000,000 |
| `LongAdder.increment` | 13 ms | 16,000,000 |

(18 코어 Docker VM, `eclipse-temurin:21-jdk`. 절대값은 환경마다 다르고 경합 정도에 크게 좌우된다.)

`plain++` 은 빠르지만 **80% 가 사라졌다**. `count++` 는 "읽기 → 더하기 → 쓰기" 세 단계라, 두 스레드가 같은 값을 읽고 각자 1 을 더해 쓰면 하나가 사라진다(lost update). 게다가 [앞 장](/java/notes/10-threads-jmm)의 가시성 문제까지 겹친다. 이 장의 도구들은 이 세 단계를 **원자적으로** 만드는 서로 다른 방법이다.

## synchronized

```java
synchronized (lock) { count++; }          // 블록
public synchronized void inc() { ... }    // 메서드 = synchronized(this)
public static synchronized void f() {}    // = synchronized(클래스 객체)
```

- **상호 배제**: 같은 객체의 모니터를 한 스레드만 잡는다.
- **가시성**: 블록을 나갈 때의 쓰기가 다음에 같은 락을 잡는 스레드에 보인다(happens-before).
- **재진입**: 이미 잡은 스레드는 다시 들어갈 수 있다(같은 객체의 다른 synchronized 메서드 호출).
- 예외가 나도 자동으로 풀린다.

HotSpot 은 경합이 없으면 객체 헤더의 마크 워드만 CAS 로 바꾸는 **경량 락**, 경합이 생기면 OS 수준 대기열을 쓰는 **팽창된 모니터** 로 바뀐다. 위 실측의 470ms 는 8 스레드가 한 락에 몰린 **심한 경합** 의 비용이다 — 스레드들이 줄을 서서 잠들고 깨어나기를 반복한다. 경합이 없으면 synchronized 는 수 ns 다.

> 가상 스레드에서 synchronized 블록 안에 블로킹 호출이 있으면 캐리어를 붙잡는다(피닝) — JDK 21 기준. [13장](/java/notes/13-virtual-threads-structured)의 실험에서 30배 가까이 느려졌다.

## ReentrantLock

`synchronized` 와 같은 상호 배제·재진입이지만 기능이 많다.

```java
private final ReentrantLock lock = new ReentrantLock();
lock.lock();
try { count++; }
finally { lock.unlock(); }                       // 반드시 finally — 안 풀면 영원히 잠김
```

| 기능 | synchronized | ReentrantLock |
|---|---|---|
| 시도하고 실패하면 다른 일 | 불가 | `tryLock()` |
| 시간 제한 대기 | 불가 | `tryLock(100, MILLISECONDS)` |
| 대기 중 인터럽트 | 불가 | `lockInterruptibly()` |
| 공정성(먼저 온 순서) | 없음 | `new ReentrantLock(true)` — 처리량은 떨어짐 |
| 조건 변수 여러 개 | `wait/notify` 하나 | `newCondition()` 여러 개 |
| 블록 구조 강제 | 있음(자동 해제) | 없음(직접 unlock) |
| 가상 스레드 피닝(21) | 있음 | 없음 |

`tryLock(timeout)` 은 [교착 상태](#교착-상태)를 피하는 가장 실용적인 도구다 — 영원히 기다리지 않고 실패를 돌려준다. 분산 락에서 TTL 을 두는 것과 같은 발상이다 → [Redis 분산 락](/redis/notes/09-distributed-lock).

## 읽기가 많을 때: ReadWriteLock, StampedLock

| 락 | 읽기끼리 | 읽기-쓰기 | 특징 |
|---|---|---|---|
| `ReentrantReadWriteLock` | 동시 허용 | 배타 | 쓰기 기아 가능, 읽기 락도 공유 카운터를 갱신(캐시 라인 경합) |
| `StampedLock` | 동시 허용 + **낙관적 읽기** | 배타 | 재진입 불가, Condition 없음 |

```java
StampedLock sl = new StampedLock();
long stamp = sl.tryOptimisticRead();     // 락 없이 '도장' 만 받는다
double x = this.x, y = this.y;            // 읽기
if (!sl.validate(stamp)) {                // 그 사이 쓰기가 있었나?
    stamp = sl.readLock();                // 있었으면 진짜 읽기 락으로 다시
    try { x = this.x; y = this.y; } finally { sl.unlockRead(stamp); }
}
```

낙관적 읽기는 쓰기가 드물 때 읽기 비용을 거의 0 으로 만든다. DB 의 낙관적 동시성(버전 비교)과 같은 아이디어다 → [이벤트 소싱: 이벤트 스토어](/event-sourcing/notes/03-event-store)의 `expected_version`.

## CAS 와 Atomic 클래스

`AtomicLong.incrementAndGet()` 은 락이 아니라 CPU 의 **CAS**(Compare-And-Swap, x86 의 `LOCK CMPXCHG`)를 반복한다.

```
do { old = value; } while (!CAS(value, old, old + 1));   // 그 사이 누가 바꿨으면 다시
```

| 장점 | 단점 |
|---|---|
| 잠들지 않음(락 없음, lock-free) | 경합이 심하면 **같은 캐시 라인** 을 코어들이 서로 빼앗으며 재시도 |
| 짧은 연산에 빠름 | 여러 변수를 함께 바꾸는 건 불가(하나만) |

`AtomicReference.compareAndSet` 으로 불변 객체 참조를 교체하면 여러 필드를 한 번에 바꾸는 것과 같은 효과를 낸다(`updateAndGet(old -> old.withX(...))`).

### LongAdder — 경합을 나눈다

실측에서 `LongAdder` 는 `AtomicLong` 보다 15배 빨랐다. 비결은 **셀 분산** 이다. 경합이 생기면 스레드마다 다른 셀(카운터 조각, 캐시 라인이 겹치지 않게 패딩)에 더하고, `sum()` 할 때 셀들을 합친다.

| | AtomicLong | LongAdder |
|---|---|---|
| 증가 | 하나의 값에 CAS | 경합 시 셀 분산 |
| 읽기 | 정확한 현재값 | `sum()` — 진행 중 증가와 겹치면 근사 |
| 용도 | 시퀀스·ID 생성(정확한 값 필요) | **메트릭 카운터**(요청 수·바이트 수) |

Micrometer·prom-client 같은 메트릭 라이브러리의 카운터가 내부적으로 쓰는 방식이다. Redis 의 `INCR` 은 단일 스레드라 이런 고민이 없지만, 대신 처리량이 한 코어에 묶인다.

## ConcurrentHashMap

`HashMap` 을 여러 스레드가 공유하면:

```java
var hm = new HashMap<String, Integer>(); hm.put("k", 0);
// 8 스레드 × 10만 번: hm.put("k", hm.get("k") + 1)
```

```
ConcurrentHashMap.merge 결과 800000, HashMap get+put 결과 121367 (기대 800000)
```

값을 잃는 것은 물론, 리사이즈 중 경합하면 내부 구조가 깨진다(옛 자바에서는 체인이 순환해 `get` 이 무한 루프에 빠지는 사고가 유명했다).

`ConcurrentHashMap`(자바 8+)의 설계:

- 읽기(`get`)는 **락 없음** — volatile 읽기로 노드를 본다.
- 쓰기는 **버킷 단위** 로 잠근다(빈 버킷은 CAS, 아니면 그 버킷 머리 노드에 synchronized). 다른 버킷의 쓰기와 동시에 진행된다.
- 리사이즈는 여러 스레드가 **나눠서** 돕는다.
- `size()` 는 `LongAdder` 와 같은 셀 방식.

**원자성이 보장되는 것은 메서드 하나 단위** 다.

| 원자적 | 원자적이 아님 |
|---|---|
| `merge(k, 1, Integer::sum)` | `put(k, get(k) + 1)` — 두 호출 사이에 끼어들 수 있음 |
| `compute(k, (key, v) -> ...)` | `if (!containsKey(k)) put(k, v)` → `putIfAbsent` 써야 |
| `computeIfAbsent(k, f)` | 반복 + 수정 |

`computeIfAbsent(k, f)` 의 `f` 는 해당 버킷의 락을 잡은 채 실행된다. **f 안에서 원격 호출·같은 맵 수정을 하지 않는다** — 그 버킷의 다른 키 쓰기가 모두 막힌다.

`null` 키·값은 허용하지 않는다 — `get` 의 null 반환이 "없음" 인지 "null 값" 인지 동시성 환경에서 구별할 수 없기 때문이다.

## 그 밖의 도구

| 도구 | 용도 |
|---|---|
| `CountDownLatch` | N 개 작업이 끝날 때까지 기다리기(일회용) — 위 측정 코드가 시작 신호로 사용 |
| `CyclicBarrier` | N 개 스레드가 서로를 기다렸다 함께 다음 단계로(재사용) |
| `Semaphore` | 동시 접근 수 제한(벌크헤드 — [아키텍처: 복원력](/architecture/notes/04-resilience)) |
| `BlockingQueue` | 생산자-소비자 — `put`/`take` 가 가득·비었을 때 블록(백프레셔) |
| `CopyOnWriteArrayList` | 읽기 압도적·쓰기 드문 목록(리스너) |
| `ConcurrentLinkedQueue` | 락 없는 큐 |
| `Exchanger`, `Phaser` | 특수 용도 |

## 교착 상태

```
스레드 1: lock(A) → lock(B)
스레드 2: lock(B) → lock(A)       ← 서로 상대가 가진 락을 영원히 기다림
```

조건 네 가지(상호 배제·점유 대기·비선점·순환 대기)가 모두 성립해야 생기므로 하나를 깨면 된다.

| 방법 | |
|---|---|
| **락 순서 고정** | 항상 id 가 작은 계좌 → 큰 계좌 순으로 잠근다 |
| 타임아웃 | `tryLock(timeout)` 실패 시 모두 풀고 재시도 |
| 락 범위 축소 | 락 안에서 다른 락·원격 호출·사용자 콜백을 부르지 않는다 |
| 하나의 락 | 정말 필요하면 더 큰 단위 하나로 |

교착 상태는 스레드 덤프가 바로 알려 준다: `jcmd <pid> Thread.print` 끝에 `Found one Java-level deadlock:` 과 순환이 출력된다. PostgreSQL 은 이것을 스스로 감지해 하나를 죽인다 → [PostgreSQL 잠금과 교착](/postgres/notes/04-locks-deadlocks).

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 모든 카운터는 Redis 의 `INCR`·`HINCRBY` 다(`src/lib/study.ts`). Redis 는 명령 하나를 단일 스레드에서 실행하므로 `INCR` 은 원자적이다 — 자바의 `AtomicLong` 을 서버 바깥에 둔 셈이다. 대신 "읽고 판단하고 쓰기" 는 여러 명령이라 원자적이지 않아 Lua 나 `WATCH` 가 필요하다 → [Redis 트랜잭션·Lua](/redis/notes/05-transactions-lua). 자바의 `put(k, get(k)+1)` vs `merge` 와 정확히 같은 구분이다.
- 실험실 [JMM 가시성 실험](/java/lab/java-jmm-visibility)은 이 장의 전제 — 동기화 없는 공유는 보이지도 않는다 — 를 보여 준다.

### Spring 서비스에서

```java
@Service
class RateLimiter {
    private final ConcurrentHashMap<String, LongAdder> hits = new ConcurrentHashMap<>();
    long hit(String user) {
        LongAdder a = hits.computeIfAbsent(user, k -> new LongAdder());
        a.increment();
        return a.sum();
    }
}
```

인스턴스가 여러 대면 이 메모리 카운터는 인스턴스마다 따로라 레이트리밋이 대수만큼 느슨해진다 — 그래서 분산 레이트리밋은 Redis 로 한다 → [Redis 레이트 리미팅](/redis/notes/10-rate-limiting).

## 실전에서는 어디에 쓰이나

> 여러 스레드가 같은 값을 고치는 곳 — 카운터, 시퀀스, 계좌 잔액, 메모리 캐시 — 이면 이 노트의 도구 중 하나를 골라야 한다. 기준은 정확성, 경합 정도, 그리고 그 상태가 한 JVM 안에만 있는가다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| API 서버의 요청 수·바이트 수 메트릭 | 경합이 심한 카운터의 비용 | `LongAdder`(메트릭 라이브러리 카운터와 같은 방식) | `AtomicLong` — 정확한 순간값이 필요할 때 |
| 단일 인스턴스의 시퀀스 발급 | 중복 없는 증가값 | `AtomicLong.incrementAndGet` | DB 시퀀스, 여러 인스턴스면 Redis `INCR` |
| 핀테크 메모리 원장의 계좌 이체 | 두 계좌를 동시에 잠글 때의 교착 | 락 순서 고정(id 작은 쪽 먼저) + `tryLock(timeout)` | DB 행 잠금(`SELECT … FOR UPDATE`) |
| 상품·설정 메모리 캐시 | 요청 스레드들의 동시 갱신 | `ConcurrentHashMap` 의 `merge`·`compute`·`computeIfAbsent` | Caffeine 같은 캐시 라이브러리 |
| 환율·코드표 같은 읽기 위주 참조 데이터 | 읽기 비용 최소화 | `StampedLock` 낙관적 읽기, 또는 불변 객체 참조 교체 | `ReentrantReadWriteLock` |
| 느린 외부 API 동시 호출 | 하류 보호(벌크헤드) | `Semaphore` 로 동시 호출 상한 | 레이트 리미터 라이브러리 |

**이럴 땐 안 맞는다**
- 서버가 여러 대인데 JVM 락·메모리 카운터로 재고나 레이트 리밋을 지키려 할 때: 인스턴스마다 따로라 보호가 안 된다 → DB 잠금, Redis `INCR`·Lua, 분산 락.
- 락 안이나 `computeIfAbsent` 함수 안에서 원격 호출: 락(버킷)을 쥔 채 기다려 다른 스레드가 모두 막힌다 → 원격 호출은 락 밖에서.

**누가 매일 만나나** — 백엔드 개발자가 "재고가 음수가 됐다", "집계 숫자가 안 맞는다" 를 고칠 때, SRE 가 스레드 덤프의 `Found one Java-level deadlock:` 이나 BLOCKED 스레드 더미를 볼 때 만난다.

**면접·실무 단골 질문**
- Q. AtomicLong 대신 LongAdder 를 쓰는 경우는? → 경합이 심하고 정확한 순간값이 필요 없는 메트릭 카운터. 셀로 경합을 나누고 `sum()` 때 합친다.
- Q. `ConcurrentHashMap` 에서 `put(k, get(k) + 1)` 은 왜 안전하지 않나? → 원자성은 메서드 하나 단위다. 두 호출 사이에 다른 스레드가 끼어든다 → `merge`·`compute`.

## 정리

- `count++` 는 세 단계 — 동기화 없으면 값이 사라진다(실측 80% 유실).
- `synchronized` 는 간단·자동 해제, `ReentrantLock` 은 tryLock·타임아웃·공정성·피닝 없음.
- 카운터는 `AtomicLong`(정확), 메트릭은 `LongAdder`(경합 분산).
- `ConcurrentHashMap` 은 메서드 하나 단위로 원자적 — `merge`·`compute` 를 쓴다.
- 교착은 락 순서 고정과 타임아웃으로 막고, 스레드 덤프로 확인한다.

다음: [Executor·CompletableFuture](/java/notes/12-executors-completablefuture). 앞: [스레드와 JMM](/java/notes/10-threads-jmm).

## 실습 체크리스트

- [ ] 8 스레드 카운터 실험을 직접 돌려 위 표를 재현하고, 스레드 수를 1·2·8 로 바꿔 경합이 결과에 주는 영향을 본다
- [ ] `ReentrantLock.tryLock(100ms)` 로 두 계좌 이체의 교착을 피하는 코드를 쓴다
- [ ] 일부러 교착 상태를 만들고 `jcmd <pid> Thread.print` 로 "Found one Java-level deadlock" 을 확인
- [ ] `HashMap` 과 `ConcurrentHashMap` 에 같은 경합을 주어 결과를 비교
- [ ] `computeIfAbsent` 안에서 `Thread.sleep` 을 하면 같은 버킷의 다른 쓰기가 막히는 것을 확인
