---
title: "JIT 컴파일 — 인터프리터에서 C1·C2 로, 그리고 다시 되돌아가는 탈최적화"
chapter: "4부 · JVM 내부"
order: 15
level: 심화
summary: "JVM 이 바이트코드를 처음엔 해석하다가 자주 쓰이는 메서드를 C1(빠른 컴파일·프로파일링)과 C2(공격적 최적화)로 기계어로 바꾸는 계층 컴파일, 호출 횟수·백엣지 카운터와 OSR, 인라이닝·탈출 분석·루프 최적화, 가정이 깨질 때의 탈최적화, -XX:+PrintCompilation 읽는 법, 워밍업이 서비스 지연·벤치마크·배포에 주는 영향"
tags: [JIT, C1, C2, 계층 컴파일, 인라이닝, 탈출 분석, 탈최적화, OSR, 워밍업, JMH]
experiments: [java-jit-warmup]
---

[바이트코드](/java/notes/14-classloading-bytecode)는 처음엔 **인터프리터**가 한 명령어씩 해석한다. 느리지만 바로 시작할 수 있다. 그동안 JVM 은 어떤 메서드가 자주 불리는지, 어떤 분기를 타는지, 어떤 타입이 들어오는지를 **프로파일**로 모은다. 그리고 뜨거운 메서드를 골라 기계어로 컴파일한다. 핵심은 **실행 중에 얻은 정보로 컴파일한다**는 것이다 — 미리(AOT) 컴파일하는 C·Rust 는 알 수 없는 정보다.

## 실측 — 같은 메서드가 얼마나 빨라지나

[실험 `java-jit-warmup`](/java/lab/java-jit-warmup) 은 작은 계산 메서드 `work()` 를 2,000번씩 묶어 호출하며 묶음마다 **호출당 시간**을 잰다(CPU 2개 컨테이너).

| 모드 | 첫 묶음 | 다섯째 | 안정 상태 | 인터프리터 대비 |
|---|---|---|---|---|
| `-Xint` (인터프리터만) | 176ns | 244ns | 168ns | 1.0× |
| `-XX:TieredStopAtLevel=1` (C1 만) | 49ns | 17ns | 19ns | 8.8× |
| 기본 (인터프리터 → C1 → C2) | 109ns | 15ns | 15ns | **11.2×** |

```text
$ java -XX:+PrintCompilation Warmup 40 2000 | grep Warmup::work
15    5       3       Warmup::work (30 bytes)
15    6       4       Warmup::work (30 bytes)
15    5       3       Warmup::work (30 bytes)   made not entrant
  ↑ms  ↑ID   ↑단계
```

- 시작 15ms 만에 `work()` 가 **단계 3(C1, 프로파일링 포함)** 으로, 곧이어 **단계 4(C2)** 로 컴파일됐다.
- `made not entrant` — C2 코드가 준비되자 C1 코드(ID 5)에 **새로 들어오는 호출을 막고** 버렸다는 뜻.
- 첫 묶음 109ns → 안정 15ns. 이게 자바 서비스가 **배포 직후 느린** 이유의 축소판이다.

## 계층 컴파일의 다섯 단계

| 단계 | 누가 | 특징 |
|---|---|---|
| 0 | 인터프리터 | 프로파일 수집 시작 |
| 1 | C1 | 프로파일 없이 최적화 (단순 getter 처럼 프로파일이 쓸모없는 메서드) |
| 2 | C1 | 호출·백엣지 카운터만 |
| 3 | C1 | **전체 프로파일**(타입·분기·호출 지점)을 모으며 실행 — 가장 흔한 중간 단계 |
| 4 | C2 | 프로파일을 근거로 공격적 최적화. 가장 빠른 코드 |

전형적 경로는 `0 → 3 → 4`. C2 가 바쁘면 `0 → 2 → 3 → 4` 처럼 우회하기도 한다. 단계를 올리는 기준은 **호출 횟수**와 **백엣지(루프가 뒤로 점프한 횟수)** 카운터다(대략 C1 은 수백~2천 회, C2 는 1만 회 수준, 정확한 임계값은 `-XX:+PrintFlagsFinal | grep Tier` ).

### OSR — 루프 도중에 바꿔 타기

`main` 처럼 한 번만 호출되지만 안에서 10억 번 도는 루프는 호출 카운터로는 영원히 뜨거워지지 않는다. 그래서 **백엣지 카운터**가 임계값을 넘으면 루프 **실행 도중에** 컴파일된 코드로 갈아탄다(On-Stack Replacement). `PrintCompilation` 에 `%` 가 붙은 줄이 OSR 이다. 마이크로벤치마크가 "main 안의 루프" 를 재면 이상한 숫자가 나오는 이유 — OSR 코드는 일반 컴파일 코드와 최적화 결과가 다르다.

## C2 가 하는 일

| 최적화 | 무엇 | 효과 |
|---|---|---|
| **인라이닝** | 호출되는 메서드 본문을 호출한 쪽에 펼쳐 넣음 (기본 35바이트 이하는 항상, 뜨거우면 325바이트까지) | 호출 비용 제거 + **다른 모든 최적화의 전제** (경계를 넘어 분석 가능) |
| 단형 호출 최적화 | 인터페이스·가상 호출인데 프로파일상 늘 같은 구현 클래스 → 직접 호출로 바꾸고 타입 검사 하나만 | `List.size()` 가 `ArrayList.size()` 로 |
| 탈출 분석 | 객체가 메서드 밖으로 안 나가면 힙 할당 대신 **스칼라 치환**(필드를 레지스터에) | `new Point(x,y)` 가 할당 0 회 → GC 부담 감소 |
| 락 제거·병합 | 탈출 안 하는 객체의 `synchronized` 제거, 인접 락 병합 | `StringBuffer` 지역 사용이 공짜 |
| 루프 최적화 | 불변식 끌어올리기, 범위 검사 제거, 언롤링, **벡터화(SIMD)** | 배열 루프가 C 수준 |
| 널 검사·분기 제거 | 프로파일상 한 번도 안 탄 분기를 "흔하지 않은 함정(trap)" 으로 | 빠른 경로만 남긴다 |

> **인라이닝이 왜 1순위인가:** `getX()` 하나 펼치는 것 자체보다, 펼친 뒤에 탈출 분석·상수 전파·범위 검사 제거가 메서드 경계를 넘어 일어나는 게 크다. 그래서 거대한 메서드(325바이트 초과)는 "인라이닝 못 함" 으로 성능이 뚝 떨어진다. `-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining` 으로 `too big` 사유를 볼 수 있다.

## 탈최적화(deoptimization) — 가정이 깨질 때

C2 의 최적화는 **추측**에 기대는 게 많다("이 호출은 늘 ArrayList", "이 분기는 안 탄다", "이 클래스엔 하위 클래스가 없다"). 추측이 깨지면 컴파일된 코드를 버리고 **인터프리터로 되돌아간다**.

```text
  120  42  4  com.x.Svc::price (88 bytes)
 5402  42  4  com.x.Svc::price (88 bytes)   made not entrant    ← 새 하위 클래스 로딩·처음 보는 타입
 5410  57  3  com.x.Svc::price (88 bytes)                      ← C1 부터 다시
 6100  58  4  com.x.Svc::price (88 bytes)                      ← 새 프로파일로 다시 C2
```

운영에서 "트래픽 패턴이 바뀐 직후 잠깐 느려진다", "기능 플래그를 켜자 p99 가 튀었다가 돌아왔다" 의 정체가 이것이다. 빈번하면(`-Xlog:deoptimization=debug`) 다형성이 너무 큰 호출 지점(**메가모픽**: 3개 이상 구현 클래스)이 원인일 때가 많다.

## 워밍업이 운영에 주는 영향

| 상황 | 문제 | 대응 |
|---|---|---|
| 롤링 배포 직후 | 새 Pod 이 인터프리터 속도로 실제 트래픽을 받아 p99 급등 | readiness 전에 **워밍업 요청**, 느린 시작(slow start) 로드밸런싱, 카나리 비율 천천히 |
| 오토스케일 | 스케일 아웃한 Pod 이 처음엔 느려 오히려 더 스케일 | 스케일 기준에 여유, 시작 시간 단축(CDS·[CRaC](/java/notes/24-operations-observability)) |
| 짧은 작업(CLI·서버리스) | 끝날 때까지 C2 에 도달 못 함 | C1 만(`TieredStopAtLevel=1`, 위 표에서 첫 묶음이 더 빠름) 또는 GraalVM 네이티브 |
| CPU 제한 컨테이너 | JIT 컴파일러 스레드가 앱과 CPU 를 다툼 | [컨테이너 속 JVM](/java/notes/20-jvm-in-containers) 의 CPU 인식, `-XX:CICompilerCount` |

## 벤치마크를 제대로 재려면 — JMH

직접 `System.nanoTime()` 으로 재면 거의 항상 틀린다: 워밍업 전 측정, 결과를 안 쓰는 코드를 C2 가 **통째로 지움(dead code elimination)**, 상수 접기, OSR. [성능 측정 방법론](/performance/notes/02-measurement-methodology)의 함정이 JVM 에서 특히 심하다. **JMH** 가 표준이다.

```java
@BenchmarkMode(Mode.AverageTime) @OutputTimeUnit(TimeUnit.NANOSECONDS)
@Warmup(iterations = 5) @Measurement(iterations = 5) @Fork(2)
public class WorkBench {
  int x = 42;                                  // 상수 접기 방지: final 아닌 필드
  @Benchmark public int work() { return Warmup.work(x); }   // 반환해서 DCE 방지
  // 반환이 어렵다면 Blackhole.consume(v)
}
```

`@Fork` 가 중요하다. 같은 JVM 안에서 여러 벤치를 돌리면 앞 벤치의 프로파일이 뒤 벤치의 최적화를 오염시킨다(메가모픽화).

## 코드 캐시 — 컴파일된 코드가 사는 곳

JIT 결과물은 [코드 캐시](/java/notes/16-memory-layout)(기본 240MB 예약)에 저장된다. 꽉 차면 JVM 은 **컴파일을 멈추고** 경고를 남긴다:

```text
CodeCache is full. Compiler has been disabled.
Try increasing the code cache size using -XX:ReservedCodeCacheSize=
```

이후 새로 뜨거워진 메서드는 영원히 인터프리터로 돈다 — "며칠 운영하면 점점 느려진다" 의 드문 원인이다. 거대한 앱(수만 클래스)이나 클래스를 계속 생성하는 앱에서 생긴다. `jcmd <pid> Compiler.codecache` 와 Micrometer 의 `jvm_memory_used_bytes{id="CodeHeap 'non-profiled nmethods'"}` 로 본다.

| 확인 | 명령 |
|---|---|
| 컴파일 대기열 | `jcmd <pid> Compiler.queue` |
| 코드 캐시 사용 | `jcmd <pid> Compiler.codecache` |
| 누적 JIT 시간 | `jstat -compiler <pid>` (Compiled·Failed·Time) |
| 탈최적화 이벤트 | JFR `jdk.Deoptimization`, `-Xlog:deoptimization=debug` |

## 예시로 보기 — 이 프로젝트에서

- [실험 `java-jit-warmup`](/java/lab/java-jit-warmup) 의 기본 모드 곡선은 `109 → 20 → 17 → 36 → 15 …` 처럼 중간에 튄다. 컨테이너 CPU 2개 위에서 **C2 컴파일러 스레드가 앱 스레드와 CPU 를 나눠 쓰기** 때문이다. 같은 일이 CPU limit 이 걸린 k8s Pod 에서 배포 직후에 일어난다([CPU 스로틀링](/os-internals/notes/03-scheduler-cgroups)).
- Node.js 의 V8 도 같은 구조다(Ignition 인터프리터 → Sparkplug/Maglev → TurboFan, 그리고 탈최적화). [성능 공학 노트 04](/performance/notes/04-node-web-server-performance)의 "같은 함수가 처음엔 느리다" 는 관찰과 같은 현상이며, 두 런타임 비교는 [Node.js 09편: V8 파이프라인](/nodejs/notes/09-v8-pipeline) 주제에서 이어진다.
- 연속 프로파일러([관측성 노트 10](/observability/notes/10-continuous-profiling))로 자바 서비스를 보면, 배포 직후 몇 분은 `Interpreter`·`C2 CompilerThread` 프레임이 크게 보이다가 사라진다.

## 실전에서는 어디에 쓰이나

> JIT 는 "배포 직후 느리다", "트래픽 패턴이 바뀌자 잠깐 p99 가 튄다", "벤치마크 숫자가 이상하다" 의 배후다. 롤링 배포와 오토스케일이 잦은 컨테이너 환경에서 특히 자주 만난다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 롤링 배포가 잦은 커머스 API | 새 Pod 이 인터프리터 속도로 실트래픽을 받아 p99 급등 | readiness 전 워밍업 요청, LB slow start, 카나리 비율 천천히 | CDS·CRaC 로 시작 단축 |
| 트래픽 급증 시 오토스케일 | 새 Pod 이 처음엔 느려 오히려 더 스케일 | 스케일 기준에 여유, 워밍업 시간을 고려한 안정화 창 | 이벤트 전 미리 확장 |
| 서버리스 함수·CLI·짧은 배치 | 끝날 때까지 C2 에 도달하지 못함 | `-XX:TieredStopAtLevel=1`(C1 만) | GraalVM 네이티브 이미지 |
| CPU limit 이 작은 k8s Pod | JIT 컴파일 스레드가 앱과 CPU 를 다툼 | CPU 한도에 여유, `-XX:CICompilerCount` 조정 | 기동 구간만 넉넉한 CPU |
| 라이브러리·핫 패스 성능 비교 | `nanoTime` 측정이 죽은 코드 제거·OSR 로 왜곡 | JMH + `@Fork`·`@Warmup` | 운영 프로파일러로 실측 |
| 며칠 지나면 점점 느려지는 대형 앱 | 코드 캐시가 가득 차 컴파일 중단 | `jcmd Compiler.codecache` 확인, `ReservedCodeCacheSize` 상향 | 런타임 클래스 생성 줄이기 |

**이럴 땐 안 맞는다**
- JIT 를 노려 코드를 비틀기(메서드 쪼개기·`final` 남발): 측정 없이는 효과가 없거나 반대다 → JMH 로 확인된 핫 패스만 손댄다.
- 몇 초 안에 끝나는 작업에서 "JVM 은 결국 빨라진다" 를 기대하기: C2 에 닿기 전에 끝난다 → C1 만 쓰거나 네이티브 이미지.

**누가 매일 만나나** — SRE·플랫폼 엔지니어가 배포 직후의 지연 스파이크를 해석하고 readiness·워밍업을 설계할 때, 성능 엔지니어가 벤치마크를 짤 때 만난다.

**면접·실무 단골 질문**
- Q. 자바 서비스는 왜 배포 직후 느린가? → 인터프리터로 시작해 프로파일을 모은 뒤 C1 → C2 로 컴파일하기 때문이다. 클래스 로딩까지 겹친다.
- Q. 탈최적화란? → C2 의 추측(늘 같은 구현 클래스, 안 타는 분기)이 깨지면 컴파일된 코드를 버리고 인터프리터로 돌아가는 것. 메가모픽 호출 지점이 흔한 원인이다.

## 실습 체크리스트

- [ ] 실험 `java-jit-warmup` 을 돌려 세 모드의 안정 상태 시간 비율을 확인
- [ ] `-XX:+PrintCompilation` 출력에서 내 메서드의 `3 → 4` 전이와 `made not entrant` 를 찾기
- [ ] 메서드를 일부러 400바이트 이상으로 키워 `-XX:+PrintInlining` 에 `too big` 이 뜨는지 보기
- [ ] `new Point(x, y)` 를 루프에서 만들고 반환하지 않는 코드와 반환하는 코드의 GC 횟수를 `-Xlog:gc` 로 비교(탈출 분석)
- [ ] JMH 프로젝트를 만들어 `@Fork(0)` 과 `@Fork(2)` 결과 차이 보기
- [ ] 다음: [메모리 구조](/java/notes/16-memory-layout) — 컴파일된 코드는 코드 캐시, 객체는 힙, 클래스는 메타스페이스
