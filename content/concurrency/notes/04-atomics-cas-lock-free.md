---
title: "원자 연산·CAS·lock-free — 기다리지 않고 막는 법"
order: 4
level: 중급
summary: "하드웨어 원자 명령(fetch-add, exchange, compare-and-swap)이 하는 일, CAS 재시도 루프로 만드는 lock-free 갱신, lock-free·wait-free·obstruction-free 의 차이, ABA 문제와 버전 태그·해저드 포인터, 캐시 라인 경합과 거짓 공유, JavaScript Atomics·Java AtomicXxx·C++ std::atomic 대응, 그리고 같은 아이디어가 DB(낙관적 잠금)·Redis(WATCH)·이벤트 스토어(expected_version)로 확장되는 모습"
tags: [원자 연산, CAS, compare-and-swap, lock-free, wait-free, ABA, 거짓 공유, Atomics, 낙관적 동시성]
experiments: [conc-race-condition, conc-cas-spinlock, conc-channel-csp]
---

## 하드웨어가 제공하는 원자 명령

CPU 는 특정 연산을 **다른 코어가 끼어들 수 없게** 한 번에 수행하는 명령을 제공한다. 캐시 일관성 프로토콜(MESI)이 그 캐시 라인을 한 코어가 독점하게 만드는 방식이다.

| 연산 | 의미 | x86 | ARM64 | JavaScript | Java |
|---|---|---|---|---|---|
| load / store | 원자적 읽기·쓰기 (찢어지지 않음) | mov (정렬 시) | ldar / stlr | `Atomics.load/store` | `volatile`, `AtomicInteger.get/set` |
| fetch-and-add | 더하고 이전 값 반환 | `lock xadd` | `ldadd` (LSE) | `Atomics.add` | `getAndAdd` |
| exchange | 새 값으로 바꾸고 이전 값 반환 | `xchg` | `swp` | `Atomics.exchange` | `getAndSet` |
| compare-and-swap | 현재 값이 기대값이면 새 값으로, 실제 값을 반환 | `lock cmpxchg` | `cas` / LL/SC | `Atomics.compareExchange` | `compareAndSet` |

[경합 조건 실험](/concurrency/lab/conc-race-condition)에서 `Atomics.add` 만 정확했던 이유가 이것이다. 읽기-수정-쓰기 전체가 하나의 명령이다.

## CAS — 만능 재료

fetch-add 로는 "더하기" 만 되지만, **CAS 로는 어떤 갱신이든** 원자적으로 만들 수 있다. 패턴은 항상 같다: **읽고, 새 값을 계산하고, 그 사이 아무도 안 바꿨으면 쓴다. 바뀌었으면 처음부터.**

```js
// 최댓값 갱신 — fetch-add 로는 못 하지만 CAS 로는 된다
function atomicMax(a, i, v) {
  let cur = Atomics.load(a, i);
  while (v > cur) {
    const seen = Atomics.compareExchange(a, i, cur, v);   // cur 이면 v 로
    if (seen === cur) return;                              // 성공
    cur = seen;                                            // 누가 바꿨다 → 새 값으로 다시
  }
}
```

[스핀락 실험](/concurrency/lab/conc-cas-spinlock)의 락 획득도 CAS 한 줄이다: `while (Atomics.compareExchange(a, 0, 0, 1) !== 0) {}` — "0(풀림)이면 1(잠김)으로" 를 성공할 때까지.

## lock-free 의 정확한 의미

락을 안 쓴다고 lock-free 가 아니다. **진행 보장**의 정도로 구분한다.

| 단계 | 보장 | 예 |
|---|---|---|
| 블로킹 (락 기반) | 락 주인이 멈추면 모두 멈춘다 | 뮤텍스 |
| obstruction-free | 혼자 실행되면 끝난다 | 일부 STM |
| **lock-free** | 시스템 전체로는 누군가 반드시 진행한다 (개별 스레드는 굶을 수 있음) | CAS 재시도 루프 |
| wait-free | **모든** 스레드가 유한 단계 안에 끝난다 | fetch-add 카운터, 일부 큐 |

CAS 루프는 lock-free 다. 한 스레드의 CAS 가 실패했다는 것은 **다른 스레드가 성공했다**는 뜻이므로 전체는 진행한다. 하지만 경합이 심하면 특정 스레드가 계속 지는 기아가 가능하다.

lock-free 의 진짜 장점은 속도가 아니라 **견고함**이다. 락을 쥔 스레드가 선점·페이지 폴트·GC 로 멈춰도 다른 스레드가 막히지 않는다. 우선순위 역전(6편)과 시그널 핸들러 안의 데드락도 없다. 대신 설계·검증이 어렵다 — 직접 만들지 말고 검증된 구현(Java 의 `ConcurrentLinkedQueue`, `LongAdder`, Rust 의 crossbeam)을 쓰는 것이 원칙이다.

## ABA 문제

CAS 는 "값이 같은가" 만 본다. **A → B → A 로 바뀌었다 돌아온 경우**를 구별하지 못한다.

```
lock-free 스택: top → [A] → [B] → [C]
스레드 1: pop 하려고 top=A, next=B 를 읽음 … (멈춤)
스레드 2: pop A, pop B, push A (A 노드 재사용)   → top → [A] → [C]
스레드 1: CAS(top, A → B) 성공!   → top → [B]   ← B 는 이미 해제된 노드
```

| 해법 | 아이디어 |
|---|---|
| 버전 태그 | 포인터와 함께 카운터를 저장해 CAS 를 (포인터, 버전) 쌍으로 (double-width CAS, Java `AtomicStampedReference`) |
| 해저드 포인터 | "지금 이 노드를 보고 있다" 고 공표해, 보는 동안 해제·재사용 금지 |
| 에포크 기반 회수 | 모든 스레드가 지나간 시대의 노드만 해제 (crossbeam-epoch) |
| GC 언어 | 참조가 남아 있으면 재사용되지 않아 포인터 ABA 는 크게 줄어든다 (값 ABA 는 여전히 가능) |

DB 의 낙관적 잠금에서 `version` 컬럼을 쓰는 이유도 같다. 값이 같아졌어도 버전은 다르다.

## 캐시 라인 경합과 거짓 공유

원자 연산은 해당 **캐시 라인(보통 64바이트)** 을 한 코어가 독점해야 한다. 여러 코어가 같은 라인을 번갈아 쓰면 라인이 코어 사이를 오가며(cache line ping-pong) 단일 스레드보다 느려질 수 있다. 실험의 Atomics.add 시간이 그 비용이다.

**거짓 공유(false sharing)**: 서로 다른 변수인데 **같은 캐시 라인**에 있으면, 각자 자기 변수만 써도 라인 경합이 생긴다.

```js
// 워커마다 지역 카운터를 공유 배열에 두는 경우
const counters = new Int32Array(sab);   // counters[0], counters[1] … 이 같은 64바이트 라인에 있다
// 워커 i 는 counters[i] 만 쓰지만 라인을 서로 빼앗는다 → 느림
// 해법: 간격을 둔다 — counters[i * 16] (Int32 16개 = 64바이트)
```

Java 는 `@Contended`, `LongAdder`(셀을 나눠 경합 분산 후 합산)가 이 문제를 다룬다. **공유 카운터 하나보다 스레드별 셀 + 합산**이 빠른 이유다.

## 언어별 대응

| 하고 싶은 것 | JavaScript | Java | C++ |
|---|---|---|---|
| 원자 정수 | `Int32Array(SharedArrayBuffer)` + `Atomics.*` | `AtomicInteger`, `AtomicLong`, `LongAdder` | `std::atomic<int>` |
| CAS | `Atomics.compareExchange` | `compareAndSet`, `VarHandle.compareAndSet` | `compare_exchange_strong/weak` |
| 기다리기·깨우기 | `Atomics.wait / notify` | `LockSupport.park / unpark` | `atomic::wait / notify` (C++20) |
| 메모리 순서 지정 | 항상 순차 일관 (seq_cst) | `volatile`, `VarHandle` 의 acquire/release/opaque | `memory_order_*` 6가지 |

JavaScript 의 Atomics 는 모두 순차 일관이라 단순하지만 세밀한 최적화는 없다. 메모리 순서는 [5편](/concurrency/notes/05-memory-model-visibility)에서.

## 같은 아이디어, 더 큰 층

CAS 는 "**내가 본 것이 아직 그대로면 바꾼다**" 이다. 이 아이디어는 메모리 밖에서도 똑같이 쓰인다.

| 층 | CAS 의 모양 |
|---|---|
| 메모리 | `compareExchange(addr, expected, new)` |
| SQL 낙관적 잠금 | `UPDATE t SET …, version = version + 1 WHERE id = $1 AND version = $2` — 영향 행 0 이면 재시도 |
| Redis | `WATCH key` → `MULTI … EXEC` (그 사이 key 가 바뀌면 EXEC 가 nil) |
| 이벤트 스토어 | `expected_version` 과 unique(stream, version) — [이벤트 소싱 03](/event-sourcing/notes/03-event-store) |
| HTTP | `If-Match: <ETag>` — 다르면 412 Precondition Failed |
| 분산 KV | etcd 의 트랜잭션 `if mod_revision == N then put` |

[이벤트 소싱 낙관적 동시성 실험](/event-sourcing/lab/es-optimistic-concurrency)은 버전 검사 없이 20건을 동시에 출금하면 잔액이 음수가 되고, 버전 비교(CAS) + 재시도로 정확히 10건만 성공하는 것을 보여 준다. 스레드 위의 CAS 와 구조가 같다.

## 예시로 보기 — 이 프로젝트에서

[CSP 채널 실험](/concurrency/lab/conc-channel-csp)의 링 버퍼는 lock-free 다. 생산자만 tail 을, 소비자만 head 를 쓴다(단일 작성자). 그래서 CAS 도 필요 없이 원자적 load/store 만으로 안전하다 — **쓰는 쪽을 하나로 제한하면 동기화가 훨씬 쉬워진다**는 lock-free 설계의 핵심 원리다. Kafka 파티션이 소비자 하나에게만 할당되는 것도 같은 원리다([Kafka 03](/kafka/notes/03-consumer-groups)).

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| 원자 연산 두 개를 이어 붙임 | 사이에 끼어들어 결과가 틀림 | CAS 루프 하나로 묶거나 락 |
| CAS 실패 후 옛 값으로 재시도 | 영원히 실패 | 실패 시 반환된 현재 값으로 다시 계산 |
| 경합 심한 곳에 스핀 CAS | CPU 만 태우고 진행 느림 | 백오프, 셀 분산(LongAdder), 락 |
| 포인터 CAS 에 버전 없음 | ABA 로 해제된 노드 참조 | 버전 태그·해저드 포인터, 검증된 라이브러리 |
| 스레드별 카운터를 붙여 배치 | 거짓 공유로 느림 | 캐시 라인 간격(패딩) |
| 직접 만든 lock-free 자료구조 | 미묘한 버그, 검증 불가 | 표준 라이브러리 사용, 모델 검사·스트레스 테스트 |

## 실습 체크리스트

- [ ] 위 `atomicMax` 를 워커 4개로 돌려 결과가 항상 정확한지 확인하기
- [ ] 워커별 카운터를 `counters[i]` 와 `counters[i * 16]` 두 배치로 두고 처리 시간을 비교해 거짓 공유를 확인하기
- [ ] ABA 시나리오를 그림으로 그리고 버전 태그가 왜 막는지 설명하기
- [ ] SQL 낙관적 잠금(`WHERE version = $2`)과 Redis WATCH 를 각각 써서 같은 카운터를 동시에 갱신해 보기
- [ ] lock-free 와 wait-free 의 차이를 "누가 굶을 수 있는가" 로 설명하기
