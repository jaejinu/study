---
title: "락·세마포어·조건 변수·모니터 — 기다리게 해서 막는 법"
order: 3
level: 중급
summary: "뮤텍스와 스핀락의 차이와 선택 기준, futex 로 보는 '경합 없으면 사용자 공간, 경합하면 커널' 구조, 재진입 락·읽기-쓰기 락, 세마포어로 자원 개수 제한, 조건 변수와 가짜 깨어남·while 루프 규칙, 모니터(synchronized), 락 세분화와 경합 측정, 실험으로 보는 스핀락 vs 뮤텍스의 CPU 비용"
tags: [뮤텍스, 스핀락, futex, 세마포어, 조건 변수, 모니터, 읽기-쓰기 락, 락 경합]
experiments: [conc-cas-spinlock, conc-deadlock]
---

## 뮤텍스 — 가장 기본 도구

**뮤텍스(mutual exclusion lock)**: 한 번에 한 스레드만 잡을 수 있는 락. 잡지 못한 스레드는 기다린다. 질문은 **어떻게 기다리느냐**다.

| | 스핀락 | 블로킹 뮤텍스 |
|---|---|---|
| 기다리는 방식 | 루프를 돌며 계속 확인 (CPU 사용) | 커널에 재워 달라고 함 (CPU 반납) |
| 깨어나는 비용 | 0 (이미 돌고 있음) | 컨텍스트 스위치 (수 µs) |
| 유리할 때 | 임계 구역이 아주 짧고, 기다리는 스레드가 자기 코어를 가짐 | 임계 구역이 길거나, 스레드가 코어보다 많음 |
| 최악의 경우 | 락 주인이 선점당하면 다른 스레드들이 CPU 를 헛되이 태움 | 짧은 구간에도 매번 잠들었다 깸 |
| 쓰는 곳 | OS 커널 내부(인터럽트 문맥), 아주 짧은 구간 | 거의 모든 애플리케이션 |

[스핀락 vs 뮤텍스 실험](/concurrency/lab/conc-cas-spinlock)은 워커 수를 코어 수와 그 두 배로 바꿔 가며 두 락의 처리량과 **프로세스 CPU 시간**을 잰다. 코어보다 워커가 많을 때 스핀락은 기다리는 동안에도 코어를 태우므로 "CPU 시간 ÷ 벽시계 시간" 이 커진다. 실제 라이브러리(glibc pthread, Java 의 ReentrantLock, Rust parking_lot)는 **조금 돌다가 그래도 안 되면 잠드는** 적응형 전략을 쓴다.

### futex — 경합이 없으면 커널에 가지 않는다

리눅스 뮤텍스의 바닥에는 **futex**(fast userspace mutex)가 있다. 락 상태는 사용자 공간의 정수 하나이고, 커널은 "이 주소에서 기다리는 스레드 목록" 만 관리한다.

```
잠그기: CAS(state, 0 → 1) 성공 → 끝  (시스템 콜 0번 — 경합 없는 경우 대부분)
        실패 → state 를 2(대기자 있음)로 바꾸고 futex_wait(&state, 2) 로 잠듦
풀기:   state 를 1 줄였는데 0 이 아니었다 → 대기자가 있었다 → state=0; futex_wake(&state, 1)
```

실험의 뮤텍스가 정확히 이 구조다(Drepper 의 "Futexes Are Tricky" 3단계 상태). JavaScript 에서는 `Atomics.compareExchange` 가 CAS, `Atomics.wait` / `Atomics.notify` 가 futex_wait / futex_wake 에 해당한다. **경합 없는 락은 원자 연산 한 번 비용**이라는 것이 중요하다 — 락 자체가 느린 게 아니라 **경합**이 느리다.

## 재진입 락과 읽기-쓰기 락

**재진입(reentrant) 락**: 같은 스레드가 이미 쥔 락을 다시 잡아도 막히지 않고 카운트만 올린다. 락을 쥔 메서드가 같은 락을 쓰는 다른 메서드를 부를 때 필요하다. Java 의 `synchronized` 와 `ReentrantLock` 이 재진입이고, 기본 pthread 뮤텍스는 아니다(같은 스레드가 두 번 잡으면 자기 자신과 데드락).

**읽기-쓰기 락(RW lock)**: 읽기끼리는 동시에, 쓰기는 혼자.

| 상황 | 읽기-쓰기 락 효과 |
|---|---|
| 읽기 99%, 쓰기 1%, 읽기 구간이 김 | 큰 이득 |
| 읽기 구간이 매우 짧음 | 락 자체 관리 비용이 더 커서 손해일 수 있음 |
| 쓰기가 잦음 | 쓰기 대기자가 읽기에 계속 밀려 **기아** (공정 정책 필요) |

자주 읽고 드물게 바꾸는 설정·캐시는 락 대신 **불변 스냅샷 + 참조 교체**(copy-on-write)가 더 단순하고 빠른 경우가 많다.

## 세마포어 — 개수를 센다

**세마포어**: 정수 카운터 + 대기열. `acquire()` 는 카운터를 1 줄이고 0 이면 기다린다, `release()` 는 1 올리고 기다리는 쪽을 깨운다. 뮤텍스가 "한 명만" 이라면 세마포어는 "**N 명까지**" 다.

| 쓰임 | 예 |
|---|---|
| 동시성 제한 | 외부 API 동시 호출 최대 10개, 다운로드 동시 4개 |
| 자원 풀 | DB 커넥션 풀 크기 = 세마포어 초기값 |
| 벌크헤드 | 의존성별 동시 요청 상한 ([장애 실험실 03](/chaos/notes/03-resilience-patterns-verified)) |
| 생산자-소비자 | 빈 칸 수·찬 칸 수 세마포어 두 개로 유한 버퍼 |

```ts
// Node 에서 동시성 10 으로 제한 (p-limit 같은 라이브러리가 하는 일)
let active = 0; const waiters: (() => void)[] = [];
async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 10) await new Promise<void>((r) => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}
```

## 조건 변수 — "조건이 될 때까지" 기다리기

락은 "들어가도 되나" 만 다룬다. "큐에 항목이 생길 때까지", "버퍼에 빈 칸이 생길 때까지" 처럼 **상태에 대한 조건**을 기다리려면 조건 변수가 필요하다.

```java
lock.lock();
try {
  while (queue.isEmpty()) notEmpty.await();   // 락을 풀고 잠들었다가, 깨면 다시 락을 잡는다
  item = queue.poll();
  notFull.signal();
} finally { lock.unlock(); }
```

세 가지 규칙:

1. **조건 확인은 항상 락 안에서.** 확인과 대기 사이에 신호가 오면 놓친다(lost wake-up).
2. **if 가 아니라 while.** 깨어났다고 조건이 참이라는 보장이 없다. 다른 스레드가 먼저 가져갔을 수도 있고, OS 가 이유 없이 깨우기도 한다(spurious wakeup).
3. **signal vs broadcast**: 한 명만 진행할 수 있으면 signal, 상태가 크게 바뀌었으면 broadcast(notifyAll).

[CSP 채널 실험](/concurrency/lab/conc-channel-csp)의 링 버퍼가 바로 "비었으면 기다림, 찼으면 기다림" 을 Atomics.wait 로 구현한 것이다 — 기다리기 전에 값을 다시 확인하는 루프 구조를 보라.

## 모니터 — 락과 조건을 객체에 묶기

**모니터**: 공유 데이터 + 그 데이터를 다루는 메서드 + 락 하나 + 조건 변수를 한 묶음으로. 메서드에 들어가면 자동으로 락이 잡힌다. Java 의 모든 객체가 모니터이고 `synchronized`, `wait()`, `notify()` 가 그 인터페이스다. 장점은 "락을 잊고 데이터를 만지는" 실수를 구조로 막는 것이다.

## 락을 쓸 때의 설계 원칙

| 원칙 | 이유 |
|---|---|
| 임계 구역을 짧게 | 락 안에서 I/O·네트워크 호출 금지 — 경합 시간이 곧 대기 시간 |
| 불변식 단위로 | "확인 + 행동" 을 같은 구간에 (2편) |
| 락 순서를 정하라 | 두 락 이상을 잡는다면 항상 같은 순서로 (6편 데드락) |
| 세분화는 측정 후 | 큰 락 하나 → 키별 락(락 스트라이핑)은 경합이 실제로 보일 때 |
| 락 안에서 콜백 금지 | 남의 코드가 다른 락을 잡으면 순서가 깨진다 |

### 경합을 측정하라

| 런타임 | 어디서 보나 |
|---|---|
| Java | JFR 의 `jdk.JavaMonitorEnter`, jstack 의 BLOCKED 스레드, async-profiler 의 lock 모드 |
| Linux 일반 | `perf lock`, [eBPF](/ebpf/notes/03-bcc-libbpf-tools) 의 off-CPU 분석 |
| PostgreSQL | `pg_stat_activity.wait_event_type = 'Lock'`, `pg_locks` |
| Redis | 단일 스레드라 락 대신 SLOWLOG 의 긴 명령이 "락" 역할 |

## 예시로 보기 — 이 프로젝트에서

| 이 사이트의 장치 | 동시성 도구로 보면 |
|---|---|
| [Redis 분산 락](/redis/notes/09-distributed-lock) (SET NX PX) | 네트워크 너머의 뮤텍스 — 단, 주인이 죽으면 TTL 로 풀린다 |
| PostgreSQL 커넥션 풀(`pg.Pool`) | 세마포어 — 풀 크기를 넘는 요청은 대기열에서 기다린다 |
| 장애 실험의 벌크헤드 | 의존성별 세마포어 |
| [PG 행 잠금 실험](/postgres/notes/04-locks-deadlocks) | DB 가 관리하는 락과 대기 그래프 |

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| 락 해제를 finally 밖에서 | 예외가 나면 락이 영원히 잡힘 | `try { … } finally { unlock() }` 또는 언어의 스코프 락 |
| 락 안에서 네트워크·DB 호출 | 그 지연만큼 모든 대기자가 멈춤 | 데이터 준비는 락 밖, 락 안은 메모리 갱신만 |
| 조건 변수를 if 로 기다림 | 가짜 깨어남·선점으로 조건이 거짓인데 진행 | while 루프 |
| 락 없이 "읽기만" 함 | 반쯤 갱신된 값을 읽음 (가시성·찢어짐) | 읽기도 같은 락 또는 원자 변수 ([05](/concurrency/notes/05-memory-model-visibility)) |
| 서로 다른 객체로 락 | 상호 배제가 안 됨 (각자 다른 락) | 보호 대상마다 락 하나를 명확히 |
| 세마포어 release 누락 | 허가가 새어 결국 0 → 모두 대기 | finally, 타임아웃이 있는 acquire |

## 실습 체크리스트

- [ ] [스핀락 vs 뮤텍스 실험](/concurrency/lab/conc-cas-spinlock)을 돌려 워커가 코어의 두 배일 때 두 락의 "CPU ÷ 벽시계" 를 비교하기
- [ ] 실험 코드의 futex 뮤텍스에서 상태 2(대기자 있음)가 왜 필요한지 설명하기 (없으면 풀 때마다 notify 시스템 콜)
- [ ] 위 `withLimit` 를 써서 동시 요청을 10개로 제한하고, 제한 없을 때와 지연 분포를 비교하기
- [ ] 조건 변수 코드에서 while 을 if 로 바꾸면 어떤 버그가 나는지 시나리오로 적어 보기
- [ ] 자기 코드에서 락 안에 I/O 가 있는 곳을 찾아 밖으로 빼기
