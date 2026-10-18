---
title: "JVM 메모리 구조 — 힙·메타스페이스·스레드 스택·코드 캐시·다이렉트 메모리와 TLAB"
chapter: "4부 · JVM 내부"
order: 16
level: 심화
summary: "자바 프로세스의 메모리가 힙(Young·Old)과 힙 밖(메타스페이스·코드 캐시·스레드 스택·GC 자료구조·다이렉트 버퍼·malloc)으로 나뉘는 구조, 객체 헤더·압축 포인터로 계산하는 객체 크기, TLAB 으로 빠른 할당, -Xmx 만 보면 안 되는 이유와 NMT(Native Memory Tracking)로 실제 사용량을 읽는 법, RSS·컨테이너 한도와의 관계"
tags: [JVM, 힙, 메타스페이스, TLAB, 압축 포인터, NMT, 다이렉트 메모리, RSS]
experiments: [java-container-memory]
---

"`-Xmx512m` 인데 프로세스가 800MB 를 쓴다" — 자바 운영에서 가장 흔한 질문이다. 답은 간단하다. **힙은 자바 프로세스 메모리의 일부일 뿐**이다. 이 노트는 그 나머지가 무엇이고 어떻게 재는지를 다룬다. [컨테이너 속 JVM](/java/notes/20-jvm-in-containers)에서 OOMKilled 를 이해하는 기초다.

![JVM 메모리 구조](/diagrams/java-jvm-memory.svg)

## 영역별 정리

| 영역 | 무엇이 있나 | 크기 조절 | 넘치면 |
|---|---|---|---|
| **힙 – Young (Eden + Survivor 2개)** | 새로 만든 객체. 대부분 여기서 죽는다 | `-Xmn`, `NewRatio` (G1 은 자동) | Young GC |
| **힙 – Old** | 여러 번 살아남은 객체 | `-Xmx` 의 나머지 | Old/혼합 GC → Full GC → `OutOfMemoryError: Java heap space` |
| **메타스페이스** | 클래스 메타데이터(메서드·필드 정보, 상수 풀) | `-XX:MaxMetaspaceSize` (기본 무제한) | `OutOfMemoryError: Metaspace` |
| 압축 클래스 공간 | 메타스페이스 중 클래스 포인터가 가리키는 부분 | `CompressedClassSpaceSize` (기본 1GB **예약**) | `Compressed class space` |
| **코드 캐시** | [JIT](/java/notes/15-jit-compilation) 이 만든 기계어 | `ReservedCodeCacheSize` (기본 240MB) | JIT 중단 경고 → 인터프리터로 느려짐 |
| **스레드 스택** | 스레드마다 호출 프레임·로컬 변수 | `-Xss` (기본 1MB 예약, 실제 사용분만 커밋) | `StackOverflowError` / 스레드 생성 실패 |
| GC 자료구조 | 카드 테이블, 리멤버드 셋, 표시 비트맵 | 수집기·힙 크기에 비례 (G1 은 힙의 수 %) | — |
| **다이렉트 버퍼** | `ByteBuffer.allocateDirect`, Netty, NIO | `-XX:MaxDirectMemorySize` (기본 = Xmx) | `OutOfMemoryError: Direct buffer memory` |
| 기타 네이티브 | JNI, zlib, glibc malloc 아레나, NMT 자신 | 직접 제어 어려움 | 컨테이너 OOMKilled |

### 실측 — NMT 로 본 128MB 힙 프로세스

```text
$ java -XX:NativeMemoryTracking=summary -XX:+UnlockDiagnosticVMOptions -XX:+PrintNMTStatistics -Xmx128m Lam 10
Total: reserved=1572983508, committed=62800596
-        Java Heap (reserved=134217728, committed=36102144)
-            Class (reserved=1073883326, committed=338110)
-           Thread (reserved=23016768,   committed=709952)
-             Code (reserved=253710080,  committed=7806720)
-               GC (reserved=466098,     committed=146610)
-           Symbol (reserved=1171726,    committed=1171726)
-  Shared class space (reserved=16777216, committed=13303808)
-        Metaspace (reserved=67133088,   committed=614048)
```

| 읽는 법 | |
|---|---|
| **reserved** | 주소 공간만 잡아 둔 것(1.5GB). 실제 메모리가 아니다 |
| **committed** | OS 에 실제로 요청한 것(63MB). RSS 와 컨테이너 한도에 영향을 주는 쪽 |
| Class reserved 1GB | 압축 클래스 공간을 1GB 예약 — "자바가 1.5GB 를 먹는다" 는 오해의 원천 |
| Code reserved 253MB | 코드 캐시 예약. 작은 프로그램은 7.8MB 만 커밋 |

운영 중인 프로세스는 `-XX:NativeMemoryTracking=summary` 로 켜 두고 `jcmd <pid> VM.native_memory summary` 로 본다(오버헤드 5~10%, 기본은 꺼짐 — 위 `jcmd` 실측에서 "Native memory tracking is not enabled" 가 그 뜻). 시간에 따른 증가는 `VM.native_memory baseline` 후 `summary.diff` 로.

## 객체는 몇 바이트인가 — 헤더와 압축 포인터

64비트 JVM 에서 객체 = **헤더(마크 워드 8B + 클래스 포인터 4B) + 필드 + 8바이트 정렬 패딩**.

| 객체 | 크기 | 계산 |
|---|---|---|
| `new Object()` | 16B | 12B 헤더 + 4B 패딩 |
| `Integer` | 16B | 12B + int 4B |
| `Long` | 24B | 12B + long 8B = 20B → 24B |
| `int[0]` | 16B | 헤더 12B + 길이 4B |
| `byte[256]` | 272B | 16B + 256B |
| `long[64]` | 528B | 16B + 512B |
| `String "hello"` (Latin-1) | 24B + 21B 배열 → 약 48B | String 객체 + byte[] |

- **압축 OOP**: 힙이 32GB 미만이면 객체 참조를 4바이트로 저장한다(8바이트 정렬이라 32비트 × 8 = 32GB 표현 가능). **힙을 31GB → 33GB 로 늘리면 참조가 8바이트가 돼 오히려 담을 수 있는 객체가 줄 수 있다.** 큰 힙은 32GB 미만이거나 확 크게(48GB+).
- `List<Integer>` 100만 개 ≈ (Integer 16B + 참조 4B) × 100만 + 배열 = **약 20MB**, `int[]` 100만 개는 4MB. 박싱 비용이 5배다.
- JDK 24 의 **Compact Object Headers**(JEP 450, 실험적)는 헤더를 8바이트로 줄여 작은 객체가 많은 앱의 힙을 10~20% 줄인다.

정확한 측정은 **JOL**(Java Object Layout): `System.out.println(ClassLayout.parseClass(Point.class).toPrintable())`.

## TLAB — 할당이 왜 이렇게 싼가

여러 스레드가 Eden 에 동시에 할당하면 경합이 생긴다. 그래서 JVM 은 스레드마다 Eden 의 일부를 **TLAB**(Thread-Local Allocation Buffer)으로 떼어 주고, 그 안에서는 **포인터 하나를 더하는 것(bump-the-pointer)** 만으로 할당한다 — 몇 ns, `malloc` 보다 훨씬 싸다.

```text
TLAB:  [ obj1 | obj2 | obj3 |  ← top          end ]
new byte[256]:  top += 272  (경계 검사 하나)
TLAB 이 차면 새 TLAB 을 받는다 (이때만 동기화)
```

그래서 자바에서 짧게 사는 객체를 많이 만드는 것은 생각보다 싸다. 비싼 것은 **살아남는 객체**다 — 복사·승격·Old 의 표시 비용이 생긴다([GC 기초](/java/notes/17-gc-basics-g1)). JFR 의 `jdk.ObjectAllocationSample`·`ObjectAllocationOutsideTLAB` 이벤트로 TLAB 밖 할당(큰 객체)을 찾는다([진단 도구](/java/notes/19-diagnostic-tools)).

## 스레드 스택과 스레드 수

플랫폼 스레드 하나 = OS 스레드 하나 + 스택(`-Xss` 1MB **예약**, 쓴 만큼 커밋). 스레드 1,000개면 예약은 1GB 지만 커밋은 보통 수십~수백 KB × 1,000. 문제는 **스레드 수 자체**다.

| 증상 | 원인 |
|---|---|
| `OutOfMemoryError: unable to create native thread` | 힙이 아니라 OS 한도(ulimit -u, 컨테이너 pids.max, 메모리) |
| `StackOverflowError` | 깊은 재귀, 거대한 스택 프레임 |
| 스레드 덤프에 수천 개 `WAITING` | 무한 스레드 풀, 커넥션마다 스레드 |

JDK 21 **가상 스레드**는 스택을 힙의 객체로 두고 필요할 때만 OS 스레드에 올린다(1~3부의 동시성 내용은 [Java 목차](/java/notes)). 수십만 개를 만들어도 네이티브 메모리가 거의 늘지 않는다.

## 다이렉트 메모리 — 힙 밖의 함정

Netty·gRPC·Kafka 클라이언트·NIO 파일 채널은 GC 가 옮기지 않는 **다이렉트 버퍼**를 쓴다(커널과 복사 없이 주고받기 위해). 이 메모리는:

- 힙 그래프·힙 덤프에 **작은 `DirectByteBuffer` 객체로만** 보인다(실제 수 MB 는 네이티브).
- 그 작은 객체가 GC 될 때만 해제된다 → 힙이 한가하면 GC 가 안 돌아 다이렉트 메모리가 쌓인다.
- 기본 상한이 `-Xmx` 와 같아서, 힙 1GB + 다이렉트 1GB = 컨테이너 1.5GB 를 넘어 OOMKilled.

`-XX:MaxDirectMemorySize` 를 명시하고, Netty 는 `io.netty.maxDirectMemory`·풀 메트릭(`netty_allocator_*`)을 본다.

## RSS = 힙 + 힙 밖 — 컨테이너에서의 계산

```text
컨테이너 한도 1GB 의 대략적 예산
  힙 (-Xmx / MaxRAMPercentage)      600MB
  메타스페이스 (Spring 앱)           120MB
  코드 캐시                           50MB
  스레드 200 × 스택                   ~60MB (사용분)
  GC 자료구조 (G1)                    ~40MB
  다이렉트 버퍼 (Netty)               ~64MB
  glibc 아레나·JNI·기타               ~50MB
  ───────────────────────────────────────
  합계                               ~984MB   ← 여유 없음
```

그래서 경험칙은 **힙 = 컨테이너의 50~75%**. [실험 `java-container-memory`](/java/lab/java-container-memory)는 256MB 컨테이너에서 힙(121MB)을 넘기면 자바 `OutOfMemoryError`(종료 1), `-Xmx1g` 로 컨테이너를 넘기면 **커널 OOM 킬러(137)** 로 끝나는 것을 보여 준다. 두 번째는 힙 덤프도 스택 트레이스도 남지 않는다.

> glibc malloc 아레나: 스레드가 많은 JVM 에서 네이티브 할당이 스레드별 아레나(64MB 단위)로 흩어져 RSS 가 계속 자라는 현상. `MALLOC_ARENA_MAX=2` 환경 변수나 jemalloc 으로 완화한다.

## 예시로 보기 — 이 프로젝트에서

- [운영체제 노트 02](/os-internals/notes/02-virtual-memory-page-cache)의 **RSS·VSZ·예약 vs 커밋** 구분이 그대로 JVM 의 reserved/committed 다. NMT 의 Total reserved 1.5GB 는 VSZ, committed 63MB 가 RSS 에 가깝다.
- 이 사이트의 [Redis 메모리 노트](/redis/notes/12-memory-performance)가 `used_memory` 와 `used_memory_rss`(+ 단편화)를 구분하듯, 자바도 "힙 사용량" 과 "프로세스 RSS" 를 **둘 다** 대시보드에 둬야 한다. Prometheus 에선 `jvm_memory_used_bytes{area="heap"}` 와 `process_resident_memory_bytes`(또는 k8s 의 `container_memory_working_set_bytes`)를 같은 패널에.
- Node.js 도 같다: `heapUsed` 는 V8 힙, `rss` 는 Buffer·네이티브 애드온까지([Node.js 10편: GC 와 힙](/nodejs/notes/10-gc-heap)).

## 실전에서는 어디에 쓰이나

> "`-Xmx` 는 512MB 인데 컨테이너가 OOMKilled 됐다" — 컨테이너에 자바를 올리는 팀이라면 한 번은 겪는다. 힙 밖 메모리를 알아야 메모리 한도·대시보드·장애 원인을 제대로 잡는다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 쿠버네티스 위 Spring Boot 서비스 | 힙은 여유인데 OOMKilled(137) | 힙 = 한도의 50~75%, 나머지는 메타스페이스·스레드·다이렉트·코드 캐시 몫 | 한도를 넉넉히(비용 증가) |
| Netty·gRPC 게이트웨이, Kafka 클라이언트 | 다이렉트 버퍼가 쌓여 RSS 증가 | `-XX:MaxDirectMemorySize` 명시, Netty 풀 메트릭 확인 | 힙 버퍼 사용(복사 비용) |
| 큰 힙을 쓰는 캐시·검색 서비스 | 힙을 32GB 넘기자 오히려 담을 수 있는 양 감소 | 32GB 미만 유지(압축 OOP), 넘길 거면 확 크게 | 오프힙 캐시, Redis 로 분리 |
| 대량 데이터 처리 배치 | 박싱 컬렉션으로 메모리가 몇 배 | 원시 배열·원시 컬렉션, JOL 로 객체 크기 측정 | 스트리밍 처리로 한꺼번에 올리지 않기 |
| 스레드가 많은 레거시 서버 | `unable to create native thread`, RSS 지속 증가 | 스레드 풀 상한, `MALLOC_ARENA_MAX=2`, 가상 스레드 | jemalloc |
| 운영 대시보드 | 힙 문제인지 힙 밖 문제인지 구분 | `jvm_memory_used_bytes{area="heap"}` 와 `container_memory_working_set_bytes` 를 한 패널에, 필요 시 NMT | APM 의 메모리 뷰 |

**이럴 땐 안 맞는다**
- NMT 를 모든 운영 인스턴스에 상시 켜기: 오버헤드가 5~10% 다 → 조사 대상 인스턴스에서만 켠다.
- reserved 를 실제 사용량으로 읽기: 주소 공간 예약일 뿐이다 → committed 와 RSS 를 본다.

**누가 매일 만나나** — SRE·플랫폼 엔지니어가 OOMKilled 이벤트를 조사하고 리소스 한도를 정할 때, 백엔드 개발자가 메모리 한도를 바꾸는 PR 을 낼 때 만난다.

**면접·실무 단골 질문**
- Q. 프로세스 메모리가 `-Xmx` 보다 큰 이유는? → 메타스페이스·코드 캐시·스레드 스택·GC 자료구조·다이렉트 버퍼·기타 네이티브 할당이 힙 밖에 있다.
- Q. 힙을 32GB 이상으로 늘릴 때 주의할 점은? → 압축 OOP 가 꺼져 참조가 8바이트가 되므로, 늘린 만큼 담지 못하거나 오히려 줄 수 있다.

## 실습 체크리스트

- [ ] `-XX:NativeMemoryTracking=summary` 로 내 앱을 띄우고 reserved 와 committed 의 차이가 가장 큰 영역 찾기
- [ ] `jcmd <pid> VM.native_memory baseline` → 부하 → `summary.diff` 로 늘어난 영역 확인
- [ ] JOL 로 `Long`, `String`, 내 도메인 객체의 크기를 재고 박싱 비용 계산
- [ ] 실험 `java-container-memory` 의 두 실패(OutOfMemoryError vs OOMKilled)를 재현하고 종료 코드 비교
- [ ] `-Xmx31g` 와 `-Xmx33g` 에서 `-XX:+PrintFlagsFinal | grep UseCompressedOops` 비교
- [ ] 다음: [GC 기초와 G1](/java/notes/17-gc-basics-g1)
