---
title: "진단 도구 — JFR·JMC·jcmd·jstat·힙 덤프·스레드 덤프·async-profiler"
chapter: "5부 · GC 와 성능"
order: 19
level: 심화
summary: "운영 중인 JVM 을 멈추지 않고 들여다보는 도구 상자: 모든 것의 입구인 jcmd, 상시 켜 둘 수 있는 저오버헤드 기록기 JFR 과 분석기 JMC, GC 상태를 초 단위로 보는 jstat, 메모리 누수의 증거 힙 덤프(MAT·지배자 트리), 멈춤·데드락의 증거 스레드 덤프, 세이프포인트 편향 없는 async-profiler 플레임 그래프 — 증상별로 어떤 도구를 꺼내는지"
tags: [JFR, JMC, jcmd, jstat, 힙 덤프, 스레드 덤프, async-profiler, MAT, 플레임 그래프]
experiments: [java-gc-compare, java-container-memory]
---

"느리다", "메모리가 샌다", "가끔 멈춘다" — 자바 서비스 장애의 세 증상이다. 다행히 JDK 에는 **운영 중인 프로세스를 멈추지 않고** 들여다보는 도구가 기본으로 들어 있다. 이 노트의 출력은 모두 Docker 의 `eclipse-temurin:21-jdk` 안에서 실제로 돌린 것이다.

## 증상 → 도구

| 증상 | 먼저 꺼낼 도구 | 보는 것 |
|---|---|---|
| CPU 가 높다 | async-profiler / JFR CPU 샘플 | 플레임 그래프의 넓은 꼭대기 |
| 응답이 느린데 CPU 는 낮다 | 스레드 덤프 3번(5초 간격), JFR 의 Socket/File/Monitor 이벤트 | 같은 곳에서 `BLOCKED`·`WAITING` 인 스레드 |
| 힙이 계속 자란다 | `jstat -gcutil`, 힙 덤프 2개 비교 | Full GC 후에도 Old 가 줄지 않음, 지배자 트리 |
| 가끔 수백 ms 멈춘다 | GC 로그, `-Xlog:safepoint`, JFR GC 이벤트 | 긴 Pause, Full GC, TTSP |
| 컨테이너가 OOMKilled | NMT, `container_memory_working_set_bytes` | 힙 밖 메모리([메모리 구조](/java/notes/16-memory-layout)) |
| 데드락 의심 | 스레드 덤프 (자동 탐지) | `Found one Java-level deadlock` |

## jcmd — 모든 진단의 입구

```bash
jcmd                          # 실행 중인 JVM 목록 (PID + 메인 클래스)
jcmd <pid> help               # 쓸 수 있는 명령 목록
```

실측(128MB 힙, 작은 프로그램):

```text
$ jcmd 79 VM.flags | tr ' ' '\n' | grep -E "UseSerialGC|MaxHeapSize|InitialHeapSize"
-XX:InitialHeapSize=8388608
-XX:MaxHeapSize=134217728
-XX:+UseSerialGC

$ jcmd 79 GC.heap_info
 def new generation   total 10432K, used 6365K
  eden space 9280K,  68% used
  from space 1152K,   0% used
  to   space 1152K,   0% used
 tenured generation   total 23104K, used 13860K
```

- `VM.flags` 로 **실제로 적용된** 플래그를 확인한다. 위에서 `UseSerialGC` 가 보인다 — 작은 컨테이너에서 G1 이 아니라는 증거([컨테이너 속 JVM](/java/notes/20-jvm-in-containers)).

| jcmd 명령 | 용도 |
|---|---|
| `VM.flags`, `VM.system_properties`, `VM.version` | 설정 확인 |
| `GC.heap_info`, `GC.class_histogram` | 힙 요약, 클래스별 인스턴스 수·바이트 (가벼운 누수 탐지) |
| `GC.heap_dump /tmp/h.hprof` | 힙 덤프 (멈춤 발생 — 힙 크기에 비례) |
| `Thread.print` | 스레드 덤프 (= jstack) |
| `JFR.start`, `JFR.dump`, `JFR.stop` | 비행 기록 제어 |
| `VM.native_memory summary` | NMT (시작 시 켜야 함) |
| `Compiler.queue`, `Compiler.codecache` | JIT 상태 |

> 컨테이너에서는 **같은 사용자·같은 네임스페이스**에서 실행해야 붙는다. `kubectl exec` 로 Pod 안에서 `jcmd` 를 실행하거나, JDK 가 없는 런타임 이미지면 `kubectl debug --target` 으로 JDK 가 든 에피머럴 컨테이너를 붙인다.

## JFR — 운영에서 상시 켜 두는 비행 기록기

Java Flight Recorder 는 JVM 안에 내장된 이벤트 기록기다. 기본 설정의 오버헤드가 **1% 안팎**이라 운영에서 항상 켜 둘 수 있다. 장애가 나면 **지난 몇 분** 을 덤프해 사후 분석한다(비행기 블랙박스).

```bash
# 시작 시
java -XX:StartFlightRecording=duration=3s,filename=/w/rec.jfr ...
# 운영: 계속 기록하며 디스크에 최근 1시간·500MB 만 유지
java -XX:StartFlightRecording=disk=true,maxage=1h,maxsize=500m,dumponexit=true,filename=/dumps/ ...
# 문제 순간에
jcmd <pid> JFR.dump name=1 filename=/tmp/incident.jfr
```

실측 — 3초 기록:

```text
$ jfr summary rec.jfr
 Duration: 3 s
 Event Type                              Count  Size (bytes)
 jdk.BooleanFlag                           498         14658
 jdk.TenuringDistribution                   60           548
 jdk.ObjectAllocationSample                 30           390
 jdk.OldObjectSample                        26           754
 ...
$ jfr print --events jdk.GarbageCollection rec.jfr
jdk.GarbageCollection {
  startTime = 19:45:05.803
  duration = 0.820 ms
  gcId = 10
  name = "DefNew"
  cause = "Allocation Failure"
  longestPause = 0.820 ms
}
```

| JFR 이벤트 | 답하는 질문 |
|---|---|
| `jdk.ExecutionSample` | CPU 를 어디서 쓰나 (메서드 샘플링) |
| `jdk.ObjectAllocationSample` | 누가 메모리를 많이 할당하나 |
| `jdk.OldObjectSample` | 오래 사는(누수 후보) 객체는 어디서 할당됐나 |
| `jdk.GarbageCollection`, `jdk.GCPhasePause` | GC 멈춤과 원인 |
| `jdk.JavaMonitorEnter`, `jdk.ThreadPark` | 락 경합 — 누가 얼마나 기다렸나 |
| `jdk.SocketRead`, `jdk.FileRead` | I/O 대기 (임계값 넘는 것만) |
| `jdk.VirtualThreadPinned` | 가상 스레드가 캐리어에 묶인 지점 |

JFR 파일은 **JDK Mission Control(JMC)** GUI 로 열거나 `jfr print --json` 으로 뽑아 스크립트로 분석한다. JFR 이벤트를 Prometheus 로 흘리는 JFR Streaming(`RecordingStream`)도 있다.

## jstat — GC 를 초 단위로

```text
$ jstat -gcutil <pid> 500 3
  S0     S1     E      O      M     CCS    YGC   YGCT    FGC   FGCT    CGC  CGCT    GCT
  0.00   0.00  35.30  59.99  65.42  24.08     5  0.003     2  0.002     -     -   0.006
```

| 열 | 의미 |
|---|---|
| E, O, M | Eden·Old·Metaspace 사용률(%) |
| YGC/YGCT, FGC/FGCT | Young·Full GC 횟수/누적 초 |
| GCT | GC 누적 시간 |

**누수 판별법**: Full GC(FGC 증가) 직후의 O 값을 시간에 따라 기록한다. **바닥이 계속 올라가면 누수**, 톱니 모양으로 같은 바닥에 돌아오면 정상.

## 힙 덤프 — 누수의 증거

```bash
jcmd <pid> GC.heap_dump /dumps/heap-$(date +%s).hprof    # live 객체만(먼저 Full GC)
java -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps ...
```

Eclipse MAT 로 열어 볼 것:

| 개념 | 의미 |
|---|---|
| **얕은 크기(shallow)** | 객체 자신의 크기 |
| **유지 크기(retained)** | 이 객체가 사라지면 함께 회수될 크기 — 누수는 이것으로 찾는다 |
| **지배자 트리** | 유지 크기 순으로 "누가 메모리를 붙잡고 있나" |
| **GC 루트까지 경로** | 왜 회수되지 않나 — 대개 static 필드·ThreadLocal·리스너 |

두 시점(예: 1시간 간격)의 덤프에서 **늘어난 클래스**를 비교하는 것이 가장 확실하다. 힙 덤프는 **힙 크기만큼의 디스크**와 **STW 멈춤**이 필요하다 — 32GB 힙이면 수십 초. 컨테이너에선 덤프 경로를 볼륨으로, 그리고 [개인정보가 그대로 들어 있으니](/security/notes/04-secrets-management) 다루는 절차가 필요하다.

## 스레드 덤프 — 멈춤의 증거

```text
$ jcmd <pid> Thread.print
"main" #1 [81] prio=5 cpu=138.44ms elapsed=1.83s ... waiting on condition
"C2 CompilerThread0" #9 [89] daemon cpu=119.79ms elapsed=1.82s ... waiting on condition
"C1 CompilerThread0" #10 [90] daemon cpu=95.66ms elapsed=1.82s ...
```

- 2초 된 작은 프로그램에서도 **JIT 컴파일러 스레드가 main 만큼 CPU 를 썼다**(C2 120ms, C1 96ms). [JIT 워밍업](/java/notes/15-jit-compilation)의 비용이 보인다.
- 읽는 법: 상태(`RUNNABLE`·`BLOCKED`·`WAITING`·`TIMED_WAITING`)와 스택 맨 위. **5초 간격으로 3번** 떠서 같은 스택에 머문 스레드를 찾는다. `BLOCKED (on object monitor)` 가 많으면 락 경합, `WAITING` 이 `HikariPool.getConnection` 에 몰려 있으면 커넥션 풀 고갈.
- 데드락은 덤프 맨 끝에 JVM 이 직접 알려 준다: `Found one Java-level deadlock: "T1" waiting to lock monitor 0x… which is held by "T2"`.

## async-profiler — 편향 없는 CPU·할당 프로파일

JFR 의 메서드 샘플링·전통적 프로파일러는 **세이프포인트에서만** 샘플을 찍어, 세이프포인트가 없는 핫 루프를 놓치는 편향이 있다. async-profiler 는 리눅스 `perf_events` 와 JVM 내부 API(AsyncGetCallTrace)로 **아무 순간에나** 샘플을 찍고, 커널 스택·네이티브 프레임까지 하나의 플레임 그래프로 그린다.

```bash
asprof -d 30 -e cpu   -f /tmp/cpu.html   <pid>   # CPU 플레임 그래프
asprof -d 30 -e alloc -f /tmp/alloc.html <pid>   # 할당
asprof -d 30 -e lock  -f /tmp/lock.html  <pid>   # 락 경합
asprof -d 30 -e wall  -f /tmp/wall.html  <pid>   # 벽시계 — 대기 포함 (느린데 CPU 낮을 때)
```

컨테이너에선 `perf_event_paranoid`·seccomp 때문에 `-e itimer` 로 대체해야 할 수 있다. 원리는 [eBPF 프로파일링](/ebpf/notes/06-profiling-continuous), 상시 수집은 [연속 프로파일링](/observability/notes/10-continuous-profiling)(Pyroscope 자바 에이전트가 async-profiler 를 쓴다).

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 [Redis 콘솔·모니터](/redis/notes/14-ops-commands) 가 `INFO`·`SLOWLOG` 로 서버를 들여다보듯, `jcmd` 는 JVM 의 `INFO` 다. "운영 중에 안전하게 볼 수 있는 명령" 과 "멈춤을 일으키는 명령(힙 덤프 ≈ Redis `KEYS *`)" 을 구분하는 감각이 같다.
- [SRE 포스트모템](/sre/notes/05-incident-postmortem)의 타임라인 재구성에 JFR 덤프가 가장 강력한 증거다 — 메트릭은 "언제", JFR 은 "어느 스레드가 어느 메서드에서" 를 말한다.
- Node 진단 도구(`--cpu-prof`, heap snapshot, `--inspect`)와 1:1 대응이 된다: JFR ≈ `--cpu-prof`+trace events, 힙 덤프 ≈ heap snapshot, jcmd ≈ inspector 프로토콜([Node.js 13편: 진단 도구](/nodejs/notes/13-profiling-diagnostics)).

## 실습 체크리스트

- [ ] `jcmd <pid> VM.flags` 로 실제 GC 와 MaxHeapSize 를 확인
- [ ] `-XX:StartFlightRecording` 으로 30초 기록하고 `jfr print --events jdk.GarbageCollection` 으로 가장 긴 멈춤 찾기
- [ ] static 리스트에 계속 쌓는 프로그램으로 `jstat -gcutil` 의 Old 바닥이 올라가는 것을 관찰
- [ ] 힙 덤프를 MAT 로 열어 지배자 트리 1위와 GC 루트 경로 확인
- [ ] 두 스레드가 락을 반대 순서로 잡는 데드락을 만들고 `Thread.print` 의 자동 탐지 메시지 보기
- [ ] async-profiler `-e wall` 과 `-e cpu` 플레임 그래프를 비교
- [ ] 다음: [컨테이너 속 JVM](/java/notes/20-jvm-in-containers)
