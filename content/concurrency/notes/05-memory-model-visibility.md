---
title: "메모리 모델과 가시성 — '쓴 값이 보인다' 는 보장은 어디서 오는가"
order: 5
level: 심화
summary: "컴파일러 최적화와 CPU 의 저장 버퍼·캐시가 메모리 접근 순서를 바꾸는 이유, 순차 일관성이라는 이상과 실제 하드웨어(x86 TSO, ARM 약한 순서)의 차이, happens-before 와 동기화 관계, acquire·release·seq_cst 의미, 안전한 공개와 이중 확인 잠금의 함정, Java·C++·JavaScript 메모리 모델 비교, 데이터 경합이 없으면 순차 일관(DRF-SC) 이라는 핵심 정리"
tags: [메모리 모델, 가시성, happens-before, 재정렬, acquire, release, 순차 일관성, TSO, volatile, DRF-SC]
experiments: [conc-race-condition, conc-channel-csp]
---

## 순서대로 실행된다는 착각

```js
// 공유 메모리: data = 0, ready = 0
// 스레드 A                      // 스레드 B
data = 42;                       while (ready === 0) {}
ready = 1;                       console.log(data);     // 42 가 보장될까?
```

직관은 "당연히 42" 다. 하지만 **동기화 없이** 쓰면 보장되지 않는다. B 가 영원히 돌 수도, 0 을 볼 수도 있다. 이유는 세 군데에 있다.

| 누가 | 무엇을 하나 | 결과 |
|---|---|---|
| 컴파일러·JIT | 독립적인 문장을 재배치, 루프 안의 읽기를 레지스터에 캐시 | `ready` 를 한 번만 읽고 무한 루프 |
| CPU 저장 버퍼 | 쓰기를 버퍼에 두고 나중에 캐시로 내보냄 | A 의 쓰기가 다른 코어에 늦게 보임 |
| CPU 비순차 실행·약한 순서 | 서로 다른 주소의 읽기·쓰기 순서를 바꿈 | B 가 `ready=1` 은 보고 `data=42` 는 아직 못 봄 |

단일 스레드에서는 결과가 같으므로("as-if-serial") 이런 최적화가 허용된다. 문제는 **다른 스레드가 중간 상태를 관찰할 때**다.

## 순차 일관성 — 이상적인 모델

**순차 일관성(sequential consistency, Lamport 1979)**: 모든 스레드의 연산이 어떤 하나의 전역 순서로 끼워 맞춰지고, 각 스레드 안에서는 프로그램 순서가 지켜진다. 사람이 상상하는 동작이다. 하지만 하드웨어가 이것을 항상 지키면 저장 버퍼·비순차 실행 같은 최적화를 못 해서 느리다.

### 실제 하드웨어

| 아키텍처 | 모델 | 허용되는 재정렬 |
|---|---|---|
| x86-64 | TSO (Total Store Order) | **쓰기 → 이후 읽기** 만 바뀔 수 있음 (저장 버퍼 때문) |
| ARM64·POWER | 약한 순서 (weakly ordered) | 거의 모든 순서가 바뀔 수 있음 — 배리어 없이는 위 예제가 실제로 깨짐 |
| Apple Silicon | ARM64 (Rosetta 실행 시 TSO 모드 지원) | 위와 같음 |

x86 에서 잘 돌던 코드가 ARM 서버(Graviton, Apple M 칩)에서 깨지는 사례가 바로 이것이다. 이 사이트를 돌리는 Mac 도 ARM64 다.

## happens-before — 언어가 주는 약속

언어 메모리 모델은 하드웨어 차이를 감추고 **"이 조건이면 보인다"** 를 정의한다. 핵심 관계가 **happens-before(→)** 다.

1. 같은 스레드 안: 프로그램 순서대로 앞의 연산 → 뒤의 연산
2. **동기화**: 락 해제 → 같은 락의 다음 획득, volatile/원자 쓰기 → 그 값을 읽은 원자 읽기, 스레드 start() → 그 스레드의 첫 연산, 스레드 끝 → join() 반환
3. 추이성: a → b, b → c 이면 a → c

**a → b 이면 a 의 쓰기는 b 에서 반드시 보인다.** 위 예제를 고치려면 `ready` 를 원자 변수로 만들면 된다. 그러면 "A 의 data=42 → A 의 ready=1(원자 쓰기) → B 의 ready 읽기(원자, 1을 봄) → B 의 data 읽기" 가 happens-before 사슬이 된다.

```js
// JavaScript
data[0] = 42;                       // 일반 쓰기
Atomics.store(flag, 0, 1);          // 원자 쓰기 (release 의미 포함)
// 다른 워커
while (Atomics.load(flag, 0) === 0) {}   // 원자 읽기 (acquire)
console.log(data[0]);                     // 42 보장
```

분산 시스템의 Lamport 시계가 정의하는 happens-before([분산 시스템 02](/distributed-systems/notes/02-time-and-order))와 **같은 개념**이다. 메시지 송신 → 수신이 동기화의 역할을 한다.

## acquire · release · seq_cst

C++ 와 Java(VarHandle)는 원자 연산마다 순서 강도를 고르게 한다.

| 의미 | 보장 | 비유 |
|---|---|---|
| relaxed | 그 변수 자체의 원자성만 (다른 변수와의 순서 없음) | 카운터 증가만 할 때 |
| **release** (쓰기) | 이 쓰기 **이전**의 모든 읽기·쓰기가 이 쓰기보다 뒤로 가지 않음 | "다 준비했다" 고 깃발 올리기 |
| **acquire** (읽기) | 이 읽기 **이후**의 모든 읽기·쓰기가 앞으로 오지 않음 | 깃발을 보고 나서 데이터 읽기 |
| seq_cst | acquire + release + 모든 seq_cst 연산의 전역 순서 | 가장 강하고 가장 비쌈 |

release 쓰기와 그 값을 읽은 acquire 읽기 사이에 동기화가 생긴다. 락 해제가 release, 락 획득이 acquire 인 이유다. JavaScript 의 Atomics 는 항상 seq_cst 라 선택지가 없다 — 단순함과 성능을 맞바꾼 설계.

## 안전한 공개와 이중 확인 잠금

객체를 만들어 다른 스레드에 넘기는 것을 **공개(publication)** 라 한다. 동기화 없이 참조만 넘기면, 받은 쪽이 **초기화가 덜 된 객체**를 볼 수 있다(생성자 안의 쓰기와 참조 대입이 재배치될 수 있으므로).

고전적인 실수가 **이중 확인 잠금(double-checked locking)** 이다.

```java
// 잘못 (Java 5 이전, 또는 volatile 없이)
if (instance == null) {
  synchronized (this) {
    if (instance == null) instance = new Heavy();   // 참조가 먼저 보이고 필드는 나중에 보일 수 있다
  }
}
return instance;   // 락 없이 읽으므로 반쯤 만들어진 객체를 볼 수 있음
// 올바름: private static volatile Heavy instance;  — 또는 홀더 클래스 지연 초기화
```

안전한 공개 방법: volatile/원자 참조, final 필드(Java 는 생성자 종료 시 final 필드의 가시성을 보장), 락으로 보호된 필드, 정적 초기화, 동시성 컬렉션에 넣기.

## 언어별 메모리 모델 비교

| | Java (JSR-133) | C/C++ (C++11) | JavaScript (ES2017) | Go |
|---|---|---|---|---|
| 데이터 경합 시 | 이상한 값은 보일 수 있지만 "허공에서 나온 값" 은 없음 (타입 안전 유지) | **정의되지 않은 동작** | 일반 TypedArray 접근은 찢어진 값 등 가능, 타입 안전은 유지 | 정의되지 않은 동작에 가깝다 (race detector 권장) |
| 동기화 도구 | synchronized, volatile, final, j.u.c | mutex, std::atomic (+ memory_order) | Atomics (seq_cst), postMessage | 채널, sync, atomic |
| 기본 원자 순서 | volatile = seq_cst 에 가까움 | 선택 | 항상 seq_cst | seq_cst |

모든 현대 언어가 공유하는 핵심 정리가 있다: **DRF-SC — 데이터 경합이 없는(data-race-free) 프로그램은 순차 일관성처럼 동작한다.** 즉 공유 변수의 모든 충돌 접근을 동기화(락·원자 연산)로 보호하면, 재정렬·캐시·저장 버퍼를 전혀 생각하지 않아도 된다. 메모리 모델의 복잡함은 **경합을 허용하는 사람만** 짊어진다.

## 예시로 보기 — 이 프로젝트에서

이 주제의 실험들은 모두 DRF 원칙을 따른다.

- [경합 조건 실험](/concurrency/lab/conc-race-condition)의 시작 신호: 메인 스레드가 `Atomics.store(a, 1, 1)` + `Atomics.notify` 로 깃발을 올리고, 워커들이 `Atomics.wait` 로 기다린다. 깃발 이후의 공유 상태는 모두 보인다.
- [CSP 채널 실험](/concurrency/lab/conc-channel-csp)은 데이터 칸(`d[tail % cap] = i`)을 **일반 쓰기**로 쓰고 그다음 tail 을 `Atomics.store` 한다. 소비자는 tail 을 `Atomics.load` 로 읽은 뒤 데이터 칸을 읽는다. 원자적 tail 이 release/acquire 역할을 해서 일반 쓰기의 가시성까지 보장한다 — 위 data/ready 예제의 정확한 실전판이다.

같은 원리가 분산에도 있다. Redis 복제본이나 PostgreSQL 읽기 복제본에서 "방금 쓴 값이 안 보인다" 는 문제([분산 시스템 03](/distributed-systems/notes/03-consistency-models))는 메모리 모델의 가시성 문제를 네트워크 크기로 키운 것이다. 해법도 같다 — 동기화 지점(쓴 쪽에서 읽기, 세션 일관성, 동기 복제)을 만든다.

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| 종료 플래그를 일반 변수로 | 루프가 영원히 돎 (JIT 가 읽기를 끌어올림) | volatile / AtomicBoolean / Atomics |
| 생성 중인 객체를 다른 스레드에 넘김 | 초기화 덜 된 필드가 보임 | 안전한 공개 (final, volatile, 락, 동시성 컬렉션) |
| "x86 에서 잘 됐다" | ARM 서버에서 깨짐 | 하드웨어가 아니라 언어 메모리 모델로 추론 |
| volatile 로 복합 연산을 보호 | volatile 은 가시성만, `count++` 는 여전히 경합 | 원자 클래스·락 |
| 이중 확인 잠금을 volatile 없이 | 반쯤 만들어진 싱글턴 | volatile 또는 홀더 클래스 |
| 데이터 경합을 "무해하다" 고 둠 | C/C++ 에서는 정의되지 않은 동작, 최적화가 이상한 결과 | DRF 를 지킨다 — 경합을 허용하지 않는다 |

## 실전에서는 어디에 쓰이나

> 테스트에선 멀쩡한데 운영(특히 ARM 서버·다코어)에서 가끔 "플래그를 바꿨는데 루프가 안 멈춘다", "반쯤 초기화된 객체가 보인다" 는 버그가 날 때 메모리 모델이 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| x86 에서 ARM 서버로 이전 | x86 에서 숨어 있던 재정렬 버그 | 공유 변수를 원자·volatile·락으로 보호(DRF), 언어 모델로 추론 | x86 에 머물기(근본 해결 아님) |
| JVM 서비스의 지연 초기화 싱글턴 | 반쯤 만들어진 객체 공개 | `volatile` 이중 확인 잠금 또는 홀더 클래스 | 즉시 초기화 |
| 종료·설정 갱신 플래그 | 백그라운드 스레드가 변경을 못 봄 | `AtomicBoolean`·`volatile`, Node 워커는 `Atomics` | 채널·메시지로 종료 신호 |
| 저지연 거래·게임 엔진 | 락 없이 스레드 간 데이터 전달 | 단일 작성자 링 버퍼 + release/acquire | 락 기반 큐 |
| 읽기 복제본을 쓰는 웹 서비스 | 방금 쓴 값이 안 보임(같은 문제의 분산판) | 쓴 직후 읽기는 주 서버로, 세션 일관성 | 동기 복제(지연 증가) |

**이럴 땐 안 맞는다**
- 일반 애플리케이션 코드에서 relaxed·acquire 같은 세밀한 순서 조정 — 이득보다 검증 비용이 크다. 락·원자 클래스·동시성 컬렉션으로 DRF 만 지키면 된다.
- 단일 스레드 이벤트 루프 코드 — 메모리 모델이 아니라 `await` 사이 끼어들기를 봐야 한다.

**누가 매일 만나나** — 라이브러리·런타임·저지연 시스템 개발자는 직접 다루고, 일반 백엔드 개발자는 ARM 이전 후 간헐 버그를 조사하거나 리뷰에서 "이 필드는 volatile 이어야 하지 않나" 를 물을 때 만난다.

**면접·실무 단골 질문**
- Q. volatile 은 무엇을 보장하고 무엇을 못 하나? → 가시성과 순서(happens-before)는 주지만 `count++` 같은 복합 연산의 원자성은 못 준다.
- Q. DRF-SC 란? → 데이터 경합이 없는 프로그램은 순차 일관된 것처럼 동작한다는 정리.

## 실습 체크리스트

- [ ] data/ready 예제를 `Atomics` 없이(일반 TypedArray 접근)와 `Atomics` 로 각각 짜서 차이를 설명하기 (JIT 가 루프를 최적화하면 첫 번째가 멈출 수 있음)
- [ ] 채널 실험 코드에서 데이터 쓰기와 tail 갱신의 순서를 바꾸면 어떤 버그가 날지 설명하기
- [ ] 이중 확인 잠금이 volatile 없이 왜 깨지는지 재배치 순서로 그려 보기
- [ ] "DRF-SC" 를 한 문장으로 설명하기
- [ ] Java 를 공부한다면 [Java 10편: 스레드와 JMM](/java/notes/10-threads-jmm)의 JMM 내용과 이 노트를 비교하기
