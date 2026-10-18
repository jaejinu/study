---
title: "GC 기초와 G1 — 도달 가능성, 세대 가설, 리전, 혼합 GC, 일시정지 목표"
chapter: "5부 · GC 와 성능"
order: 17
level: 심화
summary: "가비지 컬렉션이 '무엇이 살아 있는가' 를 GC 루트에서의 도달 가능성으로 정하는 원리, 약한 세대 가설과 Young/Old 분리, 표시-복사-압축의 세 가지 방식, 세이프포인트와 STW, 카드 테이블·쓰기 장벽, 그리고 서버 기본 수집기 G1 의 리전·Young GC·동시 표시·혼합 GC·Full GC 와 -Xlog:gc 읽는 법"
tags: [GC, G1, 세대 가설, STW, 세이프포인트, 쓰기 장벽, 혼합 GC, Xlog]
experiments: [java-gc-compare]
---

자바 개발자는 `free` 를 쓰지 않는다. 대신 **가비지 컬렉터**가 "더 이상 닿을 수 없는 객체" 를 찾아 메모리를 회수한다. 편리함의 대가는 **멈춤(pause)** 과 **CPU** 다. 어떤 수집기를 고르고 어떻게 설정하느냐가 서비스의 p99 지연과 처리량을 정한다. 이 노트는 원리와 서버 기본 수집기 **G1** 을, [다음 노트](/java/notes/18-zgc-shenandoah-tuning)는 저지연 수집기와 튜닝을 다룬다.

## 무엇이 쓰레기인가 — 도달 가능성

GC 는 "안 쓰는 객체" 를 알 수 없다. 대신 **GC 루트에서 참조를 따라 닿을 수 있는 객체만 살아 있다**고 정의한다.

| GC 루트 | 예 |
|---|---|
| 스레드 스택의 지역 변수·인자 | 지금 실행 중인 메서드의 `list` |
| static 필드 | `static Map<> CACHE` |
| JNI 참조, 동기화에 쓰이는 객체 | 네이티브 코드가 잡은 객체 |
| 클래스 로더가 로딩한 클래스 | ([클래스 로더 누수](/java/notes/14-classloading-bytecode)의 원인) |

닿지 않으면 순환 참조여도 수거된다(참조 카운팅이 아니다). 반대로 **닿기만 하면 영원히 산다** — 자바 메모리 누수의 정체는 "static 캐시·리스너 목록·ThreadLocal 이 붙잡은 객체" 다.

## 약한 세대 가설 — 왜 Young 과 Old 를 나누나

> 대부분의 객체는 일찍 죽는다. 오래 산 객체는 계속 산다.

요청 처리 중 만든 DTO·문자열·반복자는 요청이 끝나면 죽는다. 그래서 새 객체는 작은 **Young** 영역에 두고 자주·빠르게 치운다. Young GC 는 **살아 있는 객체만 복사**하므로 비용이 쓰레기 양이 아니라 **생존 객체 양**에 비례한다 — 쓰레기가 99% 면 거의 공짜다. 몇 번 살아남은 객체(나이 임계값, 기본 최대 15)는 **Old** 로 승격된다.

## 세 가지 회수 방식

| 방식 | 하는 일 | 장점 | 단점 |
|---|---|---|---|
| 표시-청소(mark-sweep) | 살아 있는 것 표시, 나머지를 빈 목록에 | 이동 없음 | **단편화** — 큰 객체가 못 들어감 |
| 복사(copying) | 생존 객체를 빈 공간으로 복사 | 단편화 없음, 비용 ∝ 생존량 | 공간 절반이 늘 비어 있어야(Survivor 2개) |
| 표시-압축(mark-compact) | 표시 후 한쪽으로 몰아 넣기 | 단편화 없음, 공간 효율 | 모든 참조 갱신 — 비쌈 |

Young 은 복사, Old 는 표시-압축(또는 G1 처럼 리전 단위 복사)이 일반적이다.

## 세이프포인트와 Stop-The-World

객체를 옮기려면 그 객체를 가리키는 모든 참조를 고쳐야 한다. 그동안 앱 스레드가 객체를 만지면 안 되므로 **모든 스레드를 안전한 지점(세이프포인트)에 세운다** — STW. 멈춤 시간 = 세이프포인트 도달 시간 + GC 작업 시간.

> 세이프포인트는 GC 만 쓰는 게 아니다(탈최적화, 스레드 덤프, 일부 `jcmd`). 그리고 **카운트 루프(int 인덱스 루프)엔 세이프포인트 검사가 없을 수 있어**, 거대한 루프 하나가 다른 모든 스레드의 GC 를 기다리게 만드는 "세이프포인트 도달 지연(TTSP)" 이 생긴다. `-Xlog:safepoint` 의 `Reaching safepoint` 시간이 길면 이것이다.

## 쓰기 장벽과 카드 테이블

Young GC 는 Young 만 훑고 싶다. 그런데 **Old 의 객체가 Young 객체를 가리키면** 그것도 루트로 봐야 한다. Old 전체를 훑으면 Young GC 가 의미 없으므로, 참조 필드에 쓸 때마다 **쓰기 장벽**(JIT 이 넣는 짧은 코드)이 "이 Old 영역(카드, 512B)이 더러워졌다" 고 표시한다. Young GC 는 더러운 카드만 훑는다. G1 은 리전마다 "누가 나를 가리키나" 의 **리멤버드 셋**을 둔다 — 이 자료구조가 [힙 밖 메모리](/java/notes/16-memory-layout)의 GC 항목이다.

## G1 — 서버 기본 수집기

JDK 9 부터 서버급 머신(CPU 2개 이상, 메모리 1792MB 이상)의 기본. 작은 컨테이너에선 기본이 **Serial** 로 바뀐다는 함정은 [컨테이너 속 JVM](/java/notes/20-jvm-in-containers)에서 실측한다.

![G1 리전과 사이클](/diagrams/java-gc-g1-regions.svg)

| 개념 | 설명 |
|---|---|
| **리전** | 힙을 같은 크기(1~32MB, 약 2048개가 되게 자동) 칸으로 나눔. 각 리전이 Eden·Survivor·Old·Humongous 역할을 그때그때 맡는다 |
| **Young GC** | 모든 Eden·Survivor 리전의 생존 객체를 빈 리전으로 복사(evacuation). 항상 STW, 병렬 |
| **동시 표시** | 힙 점유가 IHOP(기본 45%, 적응형)을 넘으면 앱과 **함께** Old 의 생존 객체 표시. 짧은 STW(Remark·Cleanup) |
| **혼합 GC** | Young + **쓰레기가 많은 Old 리전 일부**를 함께 복사. 일시정지 목표 안에 들도록 몇 번에 나눔 |
| **Humongous** | 리전 크기의 절반 이상인 객체는 연속 리전에 직접 할당. 많으면 단편화·이른 GC |
| **일시정지 목표** | `-XX:MaxGCPauseMillis=200`(기본). G1 은 이 목표에 맞춰 Young 크기·혼합 GC 대상 수를 조절 — **보장이 아니라 목표** |
| **Full GC** | 복사할 빈 리전이 없으면(`to-space exhausted`) 전체를 STW 로 압축. 수백 ms~초. G1 운영에서 가장 피하고 싶은 것 |

"Garbage-First" 라는 이름은 **쓰레기가 가장 많은(=살아 있는 게 가장 적은) 리전부터** 치워 같은 시간에 최대한 많이 회수한다는 뜻이다.

## -Xlog:gc 읽기 — 실측

[실험 `java-gc-compare`](/java/lab/java-gc-compare)(256MB 힙, CPU 2개, 짧게 사는 `byte[256]` 2천만 개 + 오래 사는 `long[64]` 일부):

```text
# G1
[0.023s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 14M->2M(256M) 0.894ms
[0.035s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 26M->4M(256M) 0.538ms
[0.038s][info][gc] GC(2) Pause Young (Normal) (G1 Evacuation Pause) 67M->8M(256M) 0.900ms
#                 ↑ 종류              ↑ 원인                  ↑ 전→후(힙 크기)  ↑ 멈춤

# Serial (비교)
[0.027s][info][gc] GC(0) Pause Young (Allocation Failure) 69M->5M(247M) 1.572ms
```

| 수집기 | GC 멈춤 횟수 | 최대 | p99 | 합계 | 전체 실행 |
|---|---|---|---|---|---|
| Serial | 80 | 31.95ms | 31.95ms | 216.9ms | 356ms |
| **G1** | 104 | **6.49ms** | 6.30ms | 176.2ms | 335ms |
| ZGC | 222 | 1.35ms | 1.32ms | 33.5ms | 572ms |

- G1 의 Young GC 는 `67M → 8M` 을 1ms 미만에 끝냈다 — 쓰레기가 많을수록 싸다(생존 객체만 복사).
- G1 은 Serial 보다 멈춤 횟수는 많지만 **최대 멈춤이 5배 짧고**, 전체 시간도 비슷하다.
- 상세 로그는 `-Xlog:gc*:file=gc.log:time,uptime,level,tags` (단계별 시간·리전 수). GCViewer·GCEasy 같은 도구로 시각화한다.

## 흔한 G1 문제와 대처

| 증상(로그) | 원인 | 대처 |
|---|---|---|
| `to-space exhausted` → `Pause Full` | 생존 객체를 옮길 빈 리전 부족 | 힙 증가, `G1ReservePercent` 증가, 할당률 감소 |
| `Pause Young (Concurrent Start) (G1 Humongous Allocation)` 잦음 | 거대 객체 할당 | 리전 크기 증가(`G1HeapRegionSize`), 큰 배열 재사용 |
| 혼합 GC 가 끝없이 반복 | Old 에 살아 있는 객체가 많은데 힙이 작음 | 힙 증가, 캐시 크기 축소 |
| 멈춤이 목표(200ms)를 계속 넘음 | 생존 객체가 너무 많음(큰 캐시), CPU 부족 | 목표를 현실적으로, CPU 확보, 객체 수 줄이기 |
| GC 는 짧은데 앱이 멈춤 | 세이프포인트 도달 지연(TTSP) | `-Xlog:safepoint` 확인 |

## 참조의 종류 — GC 와 협상하는 법

| 참조 | 회수 시점 | 쓰임 |
|---|---|---|
| 강한(strong) | 닿을 수 있는 한 절대 회수 안 됨 | 일반 변수 |
| `SoftReference` | 메모리가 부족해질 때 | 메모리에 민감한 캐시 (그러나 회수 시점이 예측 불가 → 실제로는 크기 제한 캐시가 낫다) |
| `WeakReference` | 다음 GC 에서 강한 참조가 없으면 | `WeakHashMap`, 리스너 목록 — 누수 방지 |
| `PhantomReference` + `Cleaner` | 회수된 뒤 알림 | 네이티브 자원 해제 (`finalize()` 의 대체 — finalize 는 JDK 18 에서 폐기 예정) |

> `finalize()` 를 쓰는 객체는 회수가 최소 한 사이클 늦어지고 별도 스레드가 처리해, 많아지면 메모리가 밀린다. 자원 정리는 `try-with-resources` 와 `Cleaner` 로.

## 예시로 보기 — 이 프로젝트에서

- [DB 내부 노트 06](/db-internals/notes/06-mvcc-gc-comparison)의 PostgreSQL VACUUM·LSM 컴팩션과 자바 GC 는 같은 문제를 푼다: "쓰지 않는 공간을 언제, 누가, 얼마나 멈추고 회수하나". 복사 vs 제자리 회수, 백그라운드 vs 정지의 트레이드오프가 같다.
- [Redis 노트 12](/redis/notes/12-memory-performance)의 액티브 디프래그도 "살아 있는 객체를 옮겨 단편화를 줄이기" — GC 의 압축과 같은 발상이다.
- 관측: Micrometer 는 `jvm_gc_pause_seconds`(히스토그램, cause·action 레이블)를 내보낸다. 이 사이트의 [Grafana·알림](/observability/notes/04-grafana-alerting) 방식대로 `histogram_quantile(0.99, rate(jvm_gc_pause_seconds_bucket[5m]))` 패널과 "GC 시간 비율이 10% 초과" 알림을 둔다([운영과 관측](/java/notes/24-operations-observability)).

## 실전에서는 어디에 쓰이나

> GC 는 자바 서비스의 p99 지연과 메모리 누수 두 가지 모두의 무대다. 대부분의 서버가 기본 수집기 G1 위에서 돌기 때문에, G1 로그를 읽을 줄 알면 "가끔 느려지는" 장애의 상당수를 설명할 수 있다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 API(G1, 힙 수 GB) | 가끔 튀는 수백 ms 지연 | GC 로그에서 `to-space exhausted`·`Pause Full` 확인 → 힙 증설, 캐시 크기 제한 | 저지연 수집기(ZGC) |
| 로컬 캐시를 static 맵으로 둔 서비스 | Full GC 뒤에도 Old 가 안 줄어듦(누수) | GC 루트(static·ThreadLocal·리스너) 경로 추적, 크기·TTL 제한 캐시로 교체 | 외부 캐시(Redis) |
| 대용량 파일·이미지 처리 | Humongous 할당으로 이른 GC·단편화 | 큰 배열 재사용, `G1HeapRegionSize` 조정 | 스트리밍 처리, 오프힙 버퍼 |
| 네이티브 자원을 쥔 라이브러리 | `finalize` 지연으로 자원·메모리가 밀림 | try-with-resources, `Cleaner` | 명시적 close API 제공 |
| 운영 대시보드·알림 | GC 가 지연에 주는 영향을 숫자로 | `jvm_gc_pause_seconds` p99 패널, GC 시간 비율 10% 초과 알림 | APM 의 GC 뷰 |
| 큰 카운트 루프가 있는 계산 코드 | GC 는 짧은데 앱이 오래 멈춤(TTSP) | `-Xlog:safepoint` 의 도달 시간 확인 | 긴 루프를 작은 단위로 나누기 |

**이럴 땐 안 맞는다**
- 메모리 누수를 힙 증설로 덮기: 시간만 번다 → 힙 덤프로 원인을 제거([진단 도구](/java/notes/19-diagnostic-tools)).
- `SoftReference` 로 캐시 만들기: 회수 시점을 예측할 수 없다 → 크기 제한 캐시(Caffeine).
- 1ms 단위 지연 요구: G1 의 일시정지 목표는 보장이 아니다 → ZGC([다음 노트](/java/notes/18-zgc-shenandoah-tuning)).

**누가 매일 만나나** — SRE 가 p99 스파이크를 GC 로그·`jvm_gc_pause_seconds` 와 대조할 때, 백엔드 개발자가 캐시·대용량 처리 코드를 리뷰할 때 만난다.

**면접·실무 단골 질문**
- Q. GC 가 있는데 왜 메모리 누수가 생기나? → GC 는 GC 루트에서 닿는가로 판단한다. static 캐시·ThreadLocal·리스너가 붙잡은 객체는 영원히 산다.
- Q. 세대별 GC 의 근거는? → 약한 세대 가설 — 대부분 객체는 일찍 죽는다. Young GC 는 생존 객체만 복사하므로 쓰레기가 많을수록 싸다.

## 실습 체크리스트

- [ ] 실험 `java-gc-compare` 를 돌려 G1 의 최대 멈춤과 Serial 의 최대 멈춤을 비교
- [ ] `-Xlog:gc*` 로 G1 의 Young·Concurrent·Mixed 단계가 각각 언제 나오는지 찾기
- [ ] `-Xmx64m` 처럼 힙을 좁혀 `to-space exhausted`·`Pause Full` 을 재현
- [ ] 리전 크기의 절반보다 큰 배열을 반복 할당해 `Humongous Allocation` 원인 GC 보기
- [ ] static `List` 에 계속 추가하는 코드로 Old 가 자라는 것을 `jstat -gcutil` 로 관찰
- [ ] 다음: [ZGC·Shenandoah 와 GC 튜닝](/java/notes/18-zgc-shenandoah-tuning)
