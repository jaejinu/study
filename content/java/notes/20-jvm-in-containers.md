---
title: "컨테이너 속 JVM — cgroup 인식, MaxRAMPercentage, CPU 수와 GC 선택, k8s requests/limits"
chapter: "5부 · GC 와 성능"
order: 20
level: 심화
summary: "JVM 이 컨테이너 메모리·CPU 한도를 어떻게 읽어 힙 크기·GC·스레드 수를 자동으로 정하는지(인체공학), 실측으로 본 256MB·1GB·2GB 컨테이너의 기본값과 SerialGC 함정, 힙이 넘칠 때(OutOfMemoryError)와 프로세스가 넘칠 때(OOMKilled 137)의 차이, CPU limit 과 스로틀링·GC 스레드·JIT, Kubernetes 에서 requests/limits 와 JVM 플래그를 맞추는 법"
tags: [컨테이너, cgroup, MaxRAMPercentage, OOMKilled, SerialGC, Kubernetes, CPU 스로틀링, 인체공학]
experiments: [java-container-memory, java-gc-compare]
---

JDK 8 초기의 JVM 은 컨테이너를 몰랐다. 64GB 호스트의 1GB 컨테이너에서 "물리 메모리 64GB → 힙 16GB" 로 잡았다가 바로 OOMKilled 됐다. JDK 10(8u191 백포트)부터 JVM 은 **cgroup** 을 읽어 컨테이너 한도를 자기 머신 크기로 본다. 문제는 그 다음이다 — **기본값이 서비스에 맞지 않는다**.

## JVM 인체공학(ergonomics) — 실측

[실험 `java-container-memory`](/java/lab/java-container-memory) 가 `eclipse-temurin:21-jdk` 를 다양한 한도로 띄워 `-XX:+PrintFlagsFinal` 을 읽은 결과(CPU 2개):

| 조건 | MaxHeapSize | MaxRAMPercentage | 선택된 GC |
|---|---|---|---|
| 256MB 컨테이너 (기본) | **126MB** | 25 | **Serial** |
| 1GB 컨테이너 (기본) | **256MB** | 25 | **Serial** |
| 256MB + `MaxRAMPercentage=75` | 192MB | 75 | Serial |
| 2GB 컨테이너 (기본) | 512MB | 25 | **G1** |

읽어야 할 것 세 가지:

1. **힙은 컨테이너의 25% 뿐**이다. 1GB 를 줬는데 힙 256MB. 나머지 750MB 는 대부분 놀고, 서비스는 힙이 모자라 GC 를 미친 듯이 한다. 그래서 `MaxRAMPercentage` 를 50~75 로 올리는 것이 **거의 모든 컨테이너 자바 서비스의 첫 설정**이다. (256MB 컨테이너만 50%·약 126MB — 아주 작은 메모리에선 다른 규칙이 적용된다.)
2. **2GB 미만이면 SerialGC**가 기본이다. JVM 은 "CPU 2개 이상 + 메모리 1792MB 이상" 이어야 서버급으로 보고 G1 을 고른다. 1GB 컨테이너의 웹 서비스가 단일 스레드 GC 로 수십 ms 씩 멈추는 이유([GC 비교 실측](/java/notes/18-zgc-shenandoah-tuning): Serial 최대 32ms vs G1 6.5ms). 명시적으로 `-XX:+UseG1GC` 를 준다.
3. CPU 수도 cgroup 의 `cpu.max`(쿼터)에서 계산된다 — 아래 CPU 절.

```bash
# 컨테이너에서 JVM 이 본 값 확인 (가장 먼저 할 일)
java -XX:+PrintFlagsFinal -version | grep -E ' MaxHeapSize | MaxRAMPercentage | UseSerialGC | UseG1GC | ActiveProcessorCount '
java -Xlog:os+container=info -version      # cgroup 버전·한도를 어떻게 읽었는지
```

## 두 종류의 메모리 부족 — 실측

같은 256MB 컨테이너(스왑 끔)에서 1MB 배열 400개를 쌓았다:

| 경우 | 힙 상한 | 쌓은 양 | 종료 코드 | OOMKilled | 남는 흔적 |
|---|---|---|---|---|---|
| 힙 상한 < 컨테이너 (기본) | 121MB | 96MB 에서 실패 | **1** | false | `java.lang.OutOfMemoryError: Java heap space` 스택 트레이스 |
| `-Xmx1g` > 컨테이너 256MB | 989MB | 192MB 에서 죽음 | **137** | **true** | 없음 (커널이 SIGKILL) |

- 첫 번째는 **JVM 이 스스로 실패를 보고**한다. `-XX:+HeapDumpOnOutOfMemoryError` 로 덤프를 남길 수 있고, `-XX:+ExitOnOutOfMemoryError` 로 깔끔히 재시작시킬 수 있다.
- 두 번째는 **커널 OOM 킬러**([OS 노트 02](/os-internals/notes/02-virtual-memory-page-cache))가 cgroup `memory.max` 초과로 프로세스를 죽인다. 자바는 아무것도 모른다. k8s 에선 `Last State: Terminated, Reason: OOMKilled, Exit Code: 137` 만 남는다.
- 그래서 원칙: **힙 상한 + 힙 밖 메모리 < 컨테이너 한도**. 힙 밖은 [메모리 구조](/java/notes/16-memory-layout)대로 수십~수백 MB.

> 힙을 다 쓰지도 않았는데 OOMKilled 라면 → 힙 밖이다. NMT(`jcmd <pid> VM.native_memory summary`)로 메타스페이스·스레드·다이렉트 버퍼·코드 캐시를 본다. glibc 아레나 증식이면 `MALLOC_ARENA_MAX=2`.

## CPU — 쿼터, 스로틀링, 그리고 JVM 의 계산

| cgroup 설정 | JVM 이 보는 CPU 수 |
|---|---|
| `--cpus=2` (cpu.max = 200000 100000) | 2 |
| `--cpus=0.5` | **1** (올림) |
| k8s `limits.cpu: 1500m` | 2 |
| limit 없음, requests 만 | 노드 전체 코어 수 (JDK 19 부터 `cpu.shares` 는 무시) |

이 숫자로 GC 스레드(`ParallelGCThreads`), JIT 컴파일러 스레드, `ForkJoinPool.commonPool()` 크기, `availableProcessors()` 를 쓰는 모든 스레드 풀이 정해진다.

**함정 1 — CPU limit 이 없으면** JVM 은 노드 64코어를 보고 GC 스레드 40여 개, 공용 풀 63개를 만든다. 실제로 쓸 수 있는 CPU 는 requests 만큼인데. 스레드끼리 경쟁해 오히려 느려진다 → `-XX:ActiveProcessorCount=N` 으로 고정.

**함정 2 — CPU limit 이 너무 빠듯하면** [CFS 스로틀링](/os-internals/notes/03-scheduler-cgroups)에 걸린다. GC·JIT 스레드가 동시에 도는 순간 100ms 주기의 쿼터를 다 써서 **앱 스레드가 주기 끝까지 멈춘다** — GC 로그에는 짧은 멈춤인데 응답은 수십 ms 늦는 현상. [JIT 워밍업 실험](/java/lab/java-jit-warmup)의 곡선이 중간에 튀는 것(15ns → 36·48ns)도 CPU 2개를 C2 컴파일러와 나눠 쓴 결과다.

## Kubernetes 에서 맞추는 법

```yaml
resources:
  requests: { cpu: "1",    memory: "1Gi" }
  limits:   {              memory: "1Gi" }     # 메모리는 requests = limits (Guaranteed 에 가깝게)
env:
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:MaxRAMPercentage=70
      -XX:+UseG1GC
      -XX:ActiveProcessorCount=2
      -XX:+ExitOnOutOfMemoryError
      -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps
      -Xlog:gc*:file=/dumps/gc.log:time,uptime:filecount=5,filesize=20m
```

| 결정 | 권장 | 이유 |
|---|---|---|
| 메모리 limit | requests 와 같게 | JVM 은 한도까지 힙을 쓰도록 설계 — 노드 압박 시 축출 우선순위도 낮아짐 |
| 힙 비율 | 60~75% (스레드·Netty 많으면 낮게) | 힙 밖 몫 |
| CPU limit | 없음 또는 넉넉히 + `ActiveProcessorCount` 명시 | 스로틀링으로 인한 꼬리 지연 회피 (조직 정책에 따라) |
| GC | 2GB 미만이어도 G1 명시 | SerialGC 기본값 회피 |
| OOM 시 | `ExitOnOutOfMemoryError` | 반쯤 죽은 상태로 살아 있지 않게 — k8s 가 재시작 |
| 플래그 위치 | `JAVA_TOOL_OPTIONS` | 이미지 수정 없이, 그리고 JVM 이 시작 로그에 "Picked up …" 으로 남김 |

[Kubernetes 리소스 노트](/kubernetes/notes/07-deploy-resources)의 QoS 와 [스케줄링·오토스케일링](/kubernetes/notes/14-scheduling-autoscaling-deep)도 함께 본다. HPA 를 CPU 기준으로 걸 때, 자바는 **워밍업 중 JIT 때문에 CPU 가 높다** — 새 Pod 이 뜨자마자 또 스케일 아웃하는 진동이 생길 수 있어 안정화 창(`stabilizationWindowSeconds`)을 둔다.

## 이미지 자체

| 선택 | 내용 |
|---|---|
| 베이스 | `eclipse-temurin:21-jre` (JDK 보다 작음) · distroless java · jlink 로 만든 최소 런타임 |
| 레이어 | Spring Boot `layertools`/`extract` 로 의존성·앱 레이어 분리 → [빌드 캐시](/docker/notes/03-images-dockerfile) 적중 |
| 진단 | JRE 이미지엔 `jcmd` 가 없다 → `kubectl debug` 로 JDK 에피머럴 컨테이너 |
| 사용자 | non-root ([컨테이너 보안](/security/notes/05-container-supply-chain)) |
| 시작 시간 | AppCDS 아카이브를 이미지에 굽기, CRaC([운영 노트](/java/notes/24-operations-observability)) |

## 장애 사례 — "메모리를 두 배로 줬는데 더 자주 죽는다"

1GB → 2GB 로 컨테이너 한도를 올렸는데 OOMKilled 가 오히려 늘었다. 원인을 따라가 보면:

| 단계 | 일어난 일 |
|---|---|
| 1 | 2GB 가 되자 JVM 이 서버급으로 판단 → **SerialGC 에서 G1 으로 자동 전환**, 힙도 256MB → 512MB |
| 2 | 그런데 운영자가 예전에 넣어 둔 `-Xmx1800m` 이 `JAVA_TOOL_OPTIONS` 에 남아 있었다 |
| 3 | G1 의 리멤버드 셋·표시 비트맵(힙 밖)과 Netty 다이렉트 버퍼(기본 상한 = Xmx = 1.8GB)가 더해짐 |
| 4 | 힙 1.8GB + 힙 밖 400MB 이상 → 2GB 한도 초과 → 137 |

해결: `-Xmx` 를 지우고 `MaxRAMPercentage=65`, `-XX:MaxDirectMemorySize=256m` 명시, NMT 로 힙 밖 실측. **한도를 바꿀 때마다 JVM 이 고른 값이 바뀐다**는 것을 잊지 말 것 — 그래서 위 표의 플래그들을 명시해 인체공학에 맡기지 않는 편이 운영에서 예측 가능하다.

## 예시로 보기 — 이 프로젝트에서

- [OS 노트 03 의 실험 `os-cgroup-limits`](/os-internals/notes/03-scheduler-cgroups)는 같은 cgroup 을 OS 관점에서 본다: `--cpus=0.5` 에서 51주기 중 51번 스로틀, `--memory=64m` 에서 exit 137. 이 노트의 실험은 같은 현상을 **JVM 이 어떻게 해석하는가** 관점으로 본다 — 두 노트를 나란히 읽으면 "컨테이너는 결국 cgroup" 이 손에 잡힌다.
- 이 저장소의 앱은 Node 지만 같은 질문을 가진다: Node 의 `--max-old-space-size` 기본값도 컨테이너 한도와 맞춰야 한다([Node.js 10편: GC 와 힙](/nodejs/notes/10-gc-heap)).
- 관측: `container_memory_working_set_bytes` (k8s, OOMKilled 판정 기준) 와 `jvm_memory_used_bytes{area="heap"}` 를 한 패널에 그리면 "힙 밖" 이 두 선의 차이로 보인다. 컨테이너 한도의 90% 알림을 둔다([k8s 관측](/observability/notes/07-kubernetes-observability)).

## 실습 체크리스트

- [ ] 실험 `java-container-memory` 를 돌려 1GB 컨테이너의 기본 힙(256MB)과 GC(Serial)를 확인
- [ ] `-Xlog:os+container=info` 로 JVM 이 읽은 cgroup 한도 출력 보기
- [ ] 힙 OOM 과 컨테이너 OOMKilled 를 둘 다 재현하고 `docker inspect` 의 ExitCode·OOMKilled 비교
- [ ] `--cpus=0.5` 컨테이너에서 `availableProcessors()` 와 `ParallelGCThreads` 확인
- [ ] 내 서비스의 k8s 매니페스트에 `MaxRAMPercentage`·GC·`ActiveProcessorCount` 가 명시돼 있는지 점검
- [ ] 다음: 6부 [Gradle·Maven 과 의존성](/java/notes/21-build-dependencies)
