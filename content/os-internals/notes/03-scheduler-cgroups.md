---
title: "CPU 스케줄러와 cgroup — 누가 언제 CPU 를 얻고, 컨테이너 제한은 어떻게 동작하나"
order: 3
level: 중급
summary: "리눅스 스케줄러(CFS 에서 EEVDF 로)의 공정성 모델과 vruntime·nice·가중치, 실행 대기열과 로드, CPU 친화성·마이그레이션, cgroup v2 의 계층과 컨트롤러(cpu.weight·cpu.max·memory.max·memory.high·pids.max·io.max), CFS 대역폭 제어가 스로틀로 p99 를 만드는 원리, 메모리 한도와 OOM·memory.high 스로틀, Kubernetes requests/limits 가 cgroup 파일로 번역되는 방식과 QoS, 이 VM 실측(--cpus=0.5 는 51주기 중 51 스로틀·사용률 50%, --memory=64m 은 exit 137·oom_kill 1)"
tags: [스케줄러, CFS, EEVDF, nice, cgroup v2, cpu.max, cpu.weight, memory.max, 스로틀링, OOM, Kubernetes QoS]
experiments: [os-cgroup-limits, os-context-switch]
---

## 스케줄러가 푸는 문제

CPU 는 코어 수만큼만 동시에 일한다. 실행 가능한 task(R 상태)가 그보다 많으면 누군가 기다려야 한다. 스케줄러는 매 순간 **"다음에 누가 이 CPU 를 쓸까"** 를 고른다. 목표는 서로 충돌한다.

- **공정성** — 모두가 몫을 받는다.
- **응답성** — 대화형·I/O 위주 task 는 빨리 깨어나야 한다.
- **처리량** — 스위치를 너무 자주 하면 캐시가 식고 오버헤드가 늘어난다([컨텍스트 스위치](/os-internals/notes/01-processes-threads-context-switch)).

## CFS 와 EEVDF — "덜 쓴 쪽 먼저"

리눅스 2.6.23 부터 쓰인 **CFS**(Completely Fair Scheduler)의 핵심은 **vruntime**(가상 실행 시간)이다.

```
vruntime += 실제 실행 시간 × (기본 가중치 / 내 가중치)
다음 실행 = 실행 대기열에서 vruntime 이 가장 작은 task (레드-블랙 트리의 맨 왼쪽)
```

- 오래 잠들었던 task(I/O 대기)는 vruntime 이 적게 늘어 깨어나면 곧바로 실행된다 → 대화형 응답성.
- **nice** 값(−20 ~ +19)이 가중치를 정한다. nice 한 단계 차이 ≈ CPU 몫 10% 차이. nice 0 은 1024, nice 5 는 335.

리눅스 6.6 부터는 **EEVDF**(Earliest Eligible Virtual Deadline First)로 바뀌었다. 공정성 개념은 같지만 "자격(eligible)이 있는 task 중 가상 마감 시간이 가장 이른 것" 을 골라 지연 민감한 task 에 짧은 타임슬라이스를 줄 수 있다. 이 Mac 의 Docker VM 커널(6.12)도 EEVDF 다.

### 실행 대기열과 로드

```bash
cat /proc/loadavg                 # 1·5·15분 평균 (R + D 상태 수)
cat /proc/pressure/cpu            # PSI: CPU 를 기다리며 보낸 시간 비율 — 로드보다 정확
# some avg10=4.12 avg60=2.30 avg300=1.05 total=...
```

**PSI(Pressure Stall Information)** 는 "기다린 시간 비율" 이라 코어 수와 무관하게 해석된다. `some avg10=4.12` 는 최근 10초 중 4% 동안 누군가 CPU 를 기다렸다는 뜻이다. cgroup 별로도 있다(`/sys/fs/cgroup/<그룹>/cpu.pressure`).

### CPU 친화성과 마이그레이션

스케줄러는 부하를 맞추려고 task 를 CPU 사이로 옮긴다(마이그레이션). 옮기면 캐시가 식는다. 실험 `os-context-switch` 에서 두 task 를 **한 CPU 에 고정**(taskset)하자 파이프 왕복이 16.5 → 1.4 µs 로 빨라진 것이 이 비용이다. 지연에 민감한 서비스는 `taskset`·`cpuset`·Kubernetes `static` CPU 관리자 정책으로 코어를 고정하기도 한다.

## cgroup v2 — 자원을 나누는 커널 장치

cgroup 은 프로세스 묶음에 자원 규칙을 거는 **계층 트리**다. v2 는 `/sys/fs/cgroup` 아래 하나의 통합 트리이고, 디렉터리 하나가 그룹 하나다.

```
/sys/fs/cgroup/
├── system.slice/
├── kubepods.slice/
│   ├── kubepods-burstable.slice/
│   │   └── kubepods-burstable-pod<uid>.slice/
│   │       └── cri-containerd-<id>.scope/      ← 컨테이너 하나
│   │           ├── cpu.max        cpu.weight   cpu.stat
│   │           ├── memory.max     memory.high  memory.current  memory.events
│   │           └── pids.max       io.max       cgroup.procs
```

컨테이너 안에서는 자기 cgroup 이 `/sys/fs/cgroup` 의 루트로 보인다(cgroup 네임스페이스). 그래서 `docker exec <컨테이너> cat /sys/fs/cgroup/cpu.max` 로 자기 한도를 읽을 수 있다 — 실험이 그렇게 읽는다. 네임스페이스와 함께 컨테이너를 만드는 원리는 [Docker 내부](/docker/notes/08-internals-namespaces-cgroups)와 [컨테이너는 결국 프로세스](/os-internals/notes/07-containers-are-processes)에서 다룬다.

### 주요 컨트롤러

| 파일 | 뜻 | Docker | Kubernetes |
|---|---|---|---|
| `cpu.weight` | 경쟁할 때 CPU 몫 비율 (1~10000, 기본 100) | `--cpu-shares` | **requests.cpu** |
| `cpu.max` | `쿼터 주기` — 주기마다 쓸 수 있는 상한(µs) | `--cpus` | **limits.cpu** |
| `memory.max` | 하드 상한. 넘으면 회수 → OOM | `--memory` | **limits.memory** |
| `memory.high` | 소프트 상한. 넘으면 회수 압박·스로틀 | — | (MemoryQoS 기능) |
| `memory.min/low` | 보호 — 회수에서 제외 | — | (MemoryQoS) |
| `pids.max` | 프로세스·스레드 수 상한 (포크 폭탄 방지) | `--pids-limit` | podPidsLimit |
| `io.max` | 장치별 IOPS·대역폭 상한 | `--device-read-bps` | — |

## CPU 제한의 두 얼굴: weight 와 max

![CFS 대역폭 제어](/diagrams/os-cfs-throttle.svg)

- **cpu.weight (requests)** 는 **경쟁할 때만** 의미가 있다. CPU 가 남으면 weight 가 작아도 마음껏 쓴다. 절대로 스로틀하지 않는다.
- **cpu.max (limits)** 는 남아 있어도 막는다. `50000 100000` 은 100 ms 주기마다 50 ms. 쿼터를 다 쓰면 **주기가 끝날 때까지 정지(throttled)**.

이것이 "평균 CPU 사용률은 20% 인데 p99 지연이 튄다" 의 대표 원인이다. 요청 하나가 순간적으로 60 ms 의 CPU 를 원하는데 쿼터가 50 ms 면, 나머지 10 ms 를 위해 다음 주기까지 50 ms 를 기다린다. 멀티스레드 앱(JVM, Go, Node 의 libuv 스레드 풀)은 여러 스레드가 한 주기의 쿼터를 **동시에** 소진해 더 빨리 걸린다.

```bash
# 컨테이너 스로틀 계기판
cat /sys/fs/cgroup/cpu.stat
# usage_usec 2541000  nr_periods 51  nr_throttled 51  throttled_usec 2604000
```

| 대처 | 설명 |
|---|---|
| 지연 민감 서비스는 CPU limit 을 빼거나 넉넉히 | requests 로 몫은 보장하고 상한은 두지 않는 운영이 흔하다 |
| 스로틀 메트릭 알림 | `rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m]) > 0.25` |
| 런타임에 코어 수 알려 주기 | Go `GOMAXPROCS`, JVM `-XX:ActiveProcessorCount` 를 limit 에 맞춤 — 그래야 스레드가 쿼터를 한꺼번에 태우지 않는다 |

[성능 — 시스템 수준](/performance/notes/06-system-level)이 같은 현상을 지연 쪽에서 다룬다.

## 메모리 제한: max 는 죽이고, high 는 조인다

- **memory.max** 를 넘으려 하면 커널은 먼저 그 cgroup 의 페이지 캐시를 회수하고, 그래도 안 되면 cgroup 안에서 OOM 킬러를 돌린다 → SIGKILL, exit 137, Kubernetes `OOMKilled`.
- **memory.high** 를 넘으면 죽이지 않고 **할당할 때마다 회수를 강제**해 느리게 만든다. 죽는 것보다 느려지는 것이 나은 워크로드에 쓴다.
- `memory.events` 의 계기판: `high`(high 초과 횟수), `max`(max 에 부딪친 횟수), `oom`(한도 도달로 OOM 발생), `oom_kill`(실제로 죽인 수).

> **주의:** 메모리 한도에는 **페이지 캐시도 포함**된다. 파일을 많이 쓰는 컨테이너는 캐시 때문에 한도에 닿지만, 캐시는 회수 가능하므로 대개 OOM 까지 가지 않는다. 대신 회수가 잦아 I/O 가 느려질 수 있다([가상 메모리·페이지 캐시](/os-internals/notes/02-virtual-memory-page-cache)).

## Kubernetes 는 cgroup 파일을 쓸 뿐이다

| Pod 설정 | cgroup | QoS |
|---|---|---|
| requests = limits (CPU·메모리 모두) | weight + max + memory.max | **Guaranteed** — 축출 마지막 |
| requests < limits, 또는 일부만 | weight (+ max) | **Burstable** |
| 아무것도 없음 | 최소 weight, 상한 없음 | **BestEffort** — 축출 1순위 |

```bash
# kind 노드 안에서 Pod 의 cgroup 직접 보기
docker exec study-control-plane sh -c 'cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/*/cri-containerd-*/cpu.max | head'
```

QoS 와 축출 순서의 운영 관점은 [Kubernetes 스케줄링·오토스케일 심화](/kubernetes/notes/14-scheduling-autoscaling-deep)에, 비용 관점은 [Kubernetes 비용](/finops/notes/03-kubernetes-cost)에 있다.

## 예시로 보기 — 이 프로젝트에서

실험 `os-cgroup-limits` 는 cgroup 의 두 얼굴을 직접 건드린다.

**CPU** — 무한 루프 컨테이너를 `--cpus=0.5` 로 띄우고 5초간 `cpu.stat` 를 봤다.

| 항목 | 값 |
|---|---|
| `cpu.max` | `50000 100000` |
| nr_periods / nr_throttled | 51 / **51** (100%) |
| 실제 CPU 사용 | 2,541 ms / 벽시계 5,092 ms = **50%** |
| throttled_usec | 2,604 ms — 나머지 절반은 멈춰 있었다 |

**메모리** — `--memory=64m` 컨테이너에서 200 MiB 를 잡으려 하자:

| 항목 | 값 |
|---|---|
| `memory.max` | 67108864 |
| 프로세스 종료 코드 | **137** (128 + SIGKILL 9) |
| `memory.events` oom_kill | 0 → **1** |
| `memory.events` max | 0 → 512 (한도에 부딪친 횟수) |
| `memory.peak` | 64.0 MiB |

그리고 제한 없이 띄운 **study-redis** 의 cgroup 은 `cpu.max = max 100000`, `memory.max = max` — 무제한이다. Redis 가 VM 메모리를 다 쓸 때까지 아무도 막지 않는다. 운영에서는 컨테이너 한도와 Redis 의 `maxmemory`(한도의 70~80%, fork 여유 고려)를 함께 둔다([Redis 메모리·성능](/redis/notes/12-memory-performance)).

## 실전에서는 어디에 쓰이나

> 쿠버네티스 위의 서비스가 "평균 CPU 는 낮은데 p99 가 튄다" 거나 "Pod 가 OOMKilled 로 재시작된다" 면, 거의 항상 이 노트의 cgroup `cpu.max`·`memory.max` 가 원인 후보에 오른다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| JVM·Go 로 된 결제 API | CPU limit 스로틀로 p99 급증 | 스로틀 비율 알림, `GOMAXPROCS`·`ActiveProcessorCount` 를 limit 에 맞춤 | CPU limit 제거하고 requests 로 몫만 보장 |
| 여러 팀이 노드를 공유하는 사내 플랫폼 | 이웃 Pod 의 CPU 독점 | requests(`cpu.weight`)로 경쟁 시 몫 보장, QoS 등급 설계 | 팀별 전용 노드 풀 |
| 실시간 게임 서버·저지연 트레이딩 | 마이그레이션·캐시 식음으로 지연 흔들림 | CPU Manager static·`cpuset` 으로 코어 고정 | 큰 전용 인스턴스 |
| 배치·ML 학습 작업과 온라인 서비스 혼재 | 배치가 메모리를 다 먹어 서비스 OOM | 배치에 `memory.high` 로 느려지게, 서비스는 Guaranteed QoS | 배치를 별도 클러스터로 |

**이럴 땐 안 맞는다**
- 지연 민감 서비스에 빡빡한 CPU limit — 평균이 아니라 순간 버스트가 스로틀된다. requests 만 두거나 limit 을 넉넉히 준다.
- 페이지 캐시가 큰 컨테이너의 메모리 limit 을 RSS 만 보고 정하기 — 한도에는 캐시도 포함된다. 회수가 잦아 I/O 가 느려질 수 있다.

**누가 매일 만나나** — 백엔드 개발자는 매니페스트의 requests/limits 를 정할 때, SRE 는 `container_cpu_cfs_throttled_periods_total` 알림과 `OOMKilled` 이벤트를 볼 때, FinOps·플랫폼 엔지니어는 requests 대비 실사용으로 노드 비용을 맞출 때 만난다.

**면접·실무 단골 질문**
- Q. CPU requests 와 limits 는 커널에서 무엇이 되나? → requests 는 `cpu.weight`(경쟁 시 비율, 스로틀 없음), limits 는 `cpu.max`(주기당 쿼터, 넘으면 주기 끝까지 정지).
- Q. exit 137 의 의미는? → 128 + SIGKILL(9). 컨테이너면 대개 cgroup `memory.max` 초과로 OOM 킬러가 죽인 것이다. `memory.events` 의 `oom_kill` 로 확인한다.

## 실습 체크리스트

- [ ] 실험 `os-cgroup-limits` 를 돌려 스로틀 비율과 실제 사용률을 기록하고, `--cpus=1.5` 로 바꾸면 어떻게 될지 예측한 뒤 직접 확인하기
- [ ] `cat /proc/pressure/cpu` 를 VM 에서 읽고(`docker run --rm --privileged alpine cat /proc/pressure/cpu`), 벤치마크 중 값이 어떻게 변하는지 보기
- [ ] `nice -n 10` 과 `nice -n 0` 무한 루프 두 개를 같은 CPU 에 고정해(`taskset -c 0`) 사용률이 어떻게 나뉘는지 `top` 으로 보기
- [ ] kind 노드에서 web Pod 의 cgroup 디렉터리를 찾아 `cpu.weight`·`cpu.max`·`memory.max` 를 매니페스트의 requests/limits 와 대조하기
- [ ] `memory.high` 를 32m 로 건 컨테이너(`docker run --memory-reservation` 은 다른 것이니 주의)에서 메모리를 늘리면 죽지 않고 느려지는지 확인해 보기 (cgroup 파일 직접 쓰기, 특권 필요)
