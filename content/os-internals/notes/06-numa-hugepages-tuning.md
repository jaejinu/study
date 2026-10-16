---
title: "심화 — NUMA, huge page, io_uring, 그리고 커널 튜닝의 원칙"
order: 6
level: 심화
summary: "멀티 소켓 서버의 NUMA 와 원격 메모리 접근 비용·numactl·자동 밸런싱, TLB 와 huge page(명시적 HugeTLB vs Transparent Huge Pages), THP 가 Redis·DB 의 지연 스파이크와 fork 메모리 폭증을 만드는 이유와 Redis 의 disable-thp, io_uring 의 링·SQPOLL·고정 버퍼와 보안 트레이드오프, 자주 만지는 sysctl(overcommit·swappiness·dirty_*·somaxconn·syn backlog·파일 디스크립터·포트 범위)의 의미와 근거 있는 튜닝 절차, 이 VM 실측(THP=always 인데 Redis 는 THP_enabled 0, Kafka·OpenSearch 는 수백 MiB 가 huge page)"
tags: [NUMA, huge page, THP, TLB, io_uring, sysctl, overcommit, somaxconn, 커널 튜닝, Redis]
experiments: [os-cgroup-limits, os-page-cache]
---

## 튜닝 전에: 측정, 가설, 한 번에 하나

커널 튜닝은 블로그 글의 sysctl 목록을 복사하는 일이 아니다. 기본값은 대부분의 워크로드에 합리적이고, 잘못 바꾼 값은 오래 숨어 있다가 장애로 나타난다.

1. **증상을 수치로**: p99 지연, 처리량, PSI(`/proc/pressure/*`), 컨텍스트 스위치, 페이지 폴트.
2. **원인 가설**: "TLB 미스가 많다", "SYN 큐가 넘친다" — 관측 도구로 확인([USE 방법론](/performance/notes/02-measurement-methodology), [eBPF 도구](/ebpf/notes/03-bcc-libbpf-tools)).
3. **한 번에 하나** 바꾸고 같은 부하로 다시 잰다([k6 부하 테스트](/performance/notes/03-k6-load-testing)).
4. **기록**: 왜 바꿨는지 IaC·설정 파일 주석에. 3년 뒤 누군가 그 값을 지우거나 의심할 수 있게.

이 노트는 그 가설 목록에 자주 오르는 네 가지를 다룬다.

## NUMA — 메모리에도 거리가 있다

소켓(CPU 칩)이 둘 이상인 서버는 각 소켓이 **자기 메모리**를 가진다. 다른 소켓의 메모리에 접근하면 소켓 간 링크를 지나 **1.5~2배 느리다**. 이 구조가 NUMA(Non-Uniform Memory Access)다.

```
┌──── 노드 0 ────┐      소켓 간 링크       ┌──── 노드 1 ────┐
│ CPU 0~31       │ ◀────────────────────▶ │ CPU 32~63      │
│ 메모리 256 GiB │   원격 접근: 지연 ↑     │ 메모리 256 GiB │
└────────────────┘                        └────────────────┘
```

```bash
numactl --hardware              # 노드, CPU, 메모리, 노드 간 거리
numastat -p <pid>               # 프로세스 메모리가 어느 노드에 있나
numactl --cpunodebind=0 --membind=0 redis-server   # 한 노드에 묶기
```

| 상황 | 대처 |
|---|---|
| 큰 단일 프로세스(DB, Redis)가 두 노드에 흩어짐 | 노드에 고정하거나 인스턴스를 노드 수만큼 띄우기 |
| 자동 밸런싱(`kernel.numa_balancing`)이 페이지를 계속 옮김 | 지연 민감 워크로드에서 끄는 경우가 있다 — 측정 후 |
| 컨테이너 | Kubernetes Topology Manager + CPU Manager(static) 로 같은 노드의 CPU·메모리·NIC 정렬 |

> **참고:** 이 Mac 의 Docker VM 커널은 NUMA 지원 자체가 꺼져 있어(`/sys/devices/system/node` 디렉터리가 없다) NUMA 효과를 재 볼 수 없다. 클라우드의 큰 인스턴스(예: 96 vCPU 이상)는 대부분 2 노드다.

## huge page — TLB 한 칸을 넓게

[가상 메모리 노트](/os-internals/notes/02-virtual-memory-page-cache)에서 본 TLB 는 수천 칸 정도다. 4 KiB 페이지면 TLB 가 덮는 범위가 수십 MiB 에 불과해, 수십 GiB 를 랜덤 접근하는 프로그램(DB, JVM 힙, 인메모리 캐시)은 TLB 미스와 페이지 테이블 탐색에 시간을 쓴다. 2 MiB 페이지는 한 칸이 512배를 덮는다.

| 방식 | 어떻게 | 장점 | 단점 |
|---|---|---|---|
| **명시적 HugeTLB** | `vm.nr_hugepages` 로 미리 예약, 앱이 요청(`MAP_HUGETLB`, PG `huge_pages=on`) | 예측 가능, 단편화 걱정 없음 | 예약분은 다른 용도로 못 씀, 설정 필요 |
| **THP** (Transparent Huge Pages) | 커널이 자동으로 4 KiB 들을 2 MiB 로 합침 (`khugepaged`) | 앱 수정 없음 | 합치는·쪼개는 비용, 메모리 낭비, **지연 스파이크** |

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled   # always | madvise | never
cat /sys/kernel/mm/transparent_hugepage/defrag    # 할당 시 압축(compaction)을 얼마나 기다리나
grep AnonHugePages /proc/meminfo                  # THP 로 쓰이는 양
```

### 왜 Redis 와 DB 는 THP 를 싫어하나

1. **fork 와 COW**: Redis 가 BGSAVE 로 fork 한 뒤 부모가 1바이트를 쓰면, 4 KiB 페이지면 4 KiB 가 복사되지만 THP 면 **2 MiB 가 통째로** 복사된다. 쓰기가 흩어진 워크로드에선 fork 중 메모리가 급증하고 복사 지연이 생긴다([Redis 영속성](/redis/notes/04-persistence)).
2. **할당 지연**: `defrag=always` 면 2 MiB 를 만들려고 할당 경로에서 메모리 압축을 기다린다 — 수 ms 스파이크.
3. **메모리 부풀림**: 드문드문 쓰는 2 MiB 영역도 전부 물리 메모리를 잡는다.

그래서 Redis 는 오래전부터 "THP 를 never 로" 경고를 띄웠고, 최근 버전은 **자기 프로세스만** THP 를 끈다(`disable-thp yes`, 내부적으로 `prctl(PR_SET_THP_DISABLE)`). 시스템 설정을 바꾸지 않아도 되게 된 것이다.

반대로 JVM(Kafka, OpenSearch)은 큰 힙에서 THP 의 이득을 보는 경우가 많다(`-XX:+UseTransparentHugePages` 는 madvise 모드에서 힙에만 요청). 정답은 워크로드마다 다르고, `madvise` 모드(원하는 프로그램만 요청)가 가장 무난한 시스템 기본값이다.

## io_uring 더 깊이

[시스템 콜 노트](/os-internals/notes/05-syscalls-interrupts)에서 본 두 링 위에 몇 가지 장치가 더 있다.

| 기능 | 효과 |
|---|---|
| **SQPOLL** | 커널 스레드가 제출 큐를 폴링 → 제출에 시스템 콜 0. 대신 CPU 하나를 계속 씀 |
| 고정 버퍼·고정 파일 | 매 요청의 페이지 고정·fd 조회 비용 제거 |
| 링크된 요청 | "읽고 나서 쓰기" 같은 의존 순서를 커널 안에서 |
| 멀티샷 accept/recv | 한 번 제출로 여러 이벤트 |

언제 쓸 만한가: 초당 수십만 I/O 의 스토리지 엔진, 프록시, 메시지 브로커. 보통의 웹 서버는 epoll 로 충분하고, io_uring 의 보안 이력(커널 취약점의 상당 비율) 때문에 컨테이너 런타임·관리형 환경에서 막혀 있는 경우가 많다. 도입은 "막혀 있지 않은가, 정말 시스템 콜이 병목인가" 두 질문에 예라고 답한 뒤다.

## 자주 만지는 sysctl

| 키 | 기본 | 언제 바꾸나 | 주의 |
|---|---|---|---|
| `vm.overcommit_memory` | 0 | Redis 처럼 큰 프로세스가 fork 할 때 1 | 1 이면 실제 부족은 OOM 으로 드러난다 |
| `vm.swappiness` | 60 | 지연 민감 서버에서 1~10 (스왑 회피) | 0 은 "절대 금지" 가 아니다 — 버전마다 의미가 다름 |
| `vm.dirty_ratio` / `dirty_background_ratio` | 20 / 10 | 메모리가 아주 큰 서버에서 바이트 단위(`dirty_bytes`)로 상한 | 너무 크면 플러시 폭풍으로 쓰기 정지 |
| `net.core.somaxconn` | 4096 (5.4+) | 연결 폭주가 있는 서버 | 앱의 listen backlog 도 같이 (Redis `tcp-backlog`, Nginx `backlog=`) |
| `net.ipv4.tcp_max_syn_backlog` | 1024 등 | SYN 플러드·연결 폭주 | SYN 쿠키와 함께 |
| `net.ipv4.ip_local_port_range` | 32768–60999 | 아웃바운드 연결이 매우 많은 프록시 | TIME_WAIT 고갈과 함께 진단([Linux 네트워크](/linux-network/notes/06-kernel-stack-ebpf-performance)) |
| `fs.file-max`, `ulimit -n` | 크다 / 1024 | 연결 수만 개 서버는 **ulimit**(프로세스별)이 먼저 걸린다 | systemd `LimitNOFILE`, 컨테이너 `--ulimit` |
| `kernel.pid_max` | 4194304 | 스레드 수십만 | cgroup `pids.max` 와 별개 |

> **핵심:** 컨테이너 안에서 `sysctl` 을 바꾸면 대부분은 **호스트 커널 전체**의 값이다(네임스페이스로 분리된 `net.*` 일부 제외). Kubernetes 는 "안전한 sysctl" 만 Pod 단위로 허용하고 나머지는 노드 설정(DaemonSet, 노드 이미지)으로 한다.

## 예시로 보기 — 이 프로젝트에서

이 Mac 의 Docker VM 에서 직접 읽은 값:

| 항목 | 값 | 해석 |
|---|---|---|
| `transparent_hugepage/enabled` | `[always]` | 시스템 기본이 THP 항상 |
| `transparent_hugepage/defrag` | `[madvise]` | 할당 시 압축은 요청한 프로그램만 |
| VM 전체 AnonHugePages | 약 5.1 GiB | 누군가는 huge page 를 많이 쓰고 있다 |
| study-redis `disable-thp` | `yes` → `THP_enabled: 0`, AnonHugePages 0 | Redis 가 **자기만** THP 를 끔 |
| study-kafka AnonHugePages | 약 320 MiB | JVM 힙이 THP 로 |
| study-opensearch AnonHugePages | 약 210 MiB | JVM 힙이 THP 로 |
| `vm.overcommit_memory` | 1 | Docker Desktop 이 이미 Redis 친화적으로 설정 — 그래서 Redis 의 overcommit 경고가 없다 |
| `net.core.somaxconn` / Redis `tcp-backlog` | 4096 / 511 | Redis 의 백로그가 커널 상한보다 작아 문제없음 |
| NUMA | 커널에 NUMA 정보 없음 (`/sys/devices/system/node` 없음) | 단일 노드 VM — NUMA 효과 없음 |

한 VM 안에서 같은 THP=always 설정을 두고 Redis 는 끄고 JVM 은 쓰는 모습 — "워크로드별로 다르다" 가 말이 아니라 실제 설정으로 보인다.

실험 `os-cgroup-limits` 에서 본 것처럼 제한 없이 띄운 study-redis 의 `memory.max` 는 `max` 다. 튜닝의 첫걸음은 커널 노브가 아니라 **한도를 명시하는 것**이다: 컨테이너 메모리 한도 + Redis `maxmemory`(한도의 70~80%, fork 여유) + `maxmemory-policy`.

## 실습 체크리스트

- [ ] `docker exec study-redis redis-cli config get disable-thp` 와 `/proc/1/status` 의 `THP_enabled` 를 확인하고, 다른 JVM 컨테이너의 AnonHugePages 와 비교하기
- [ ] Redis 에 키를 많이 넣고(예: 100만 개) BGSAVE 를 하며 `INFO memory` 의 RSS 와 `latest_fork_usec` 를 기록하기
- [ ] VM 의 `vm.swappiness`·`vm.dirty_ratio`·`net.core.somaxconn` 을 읽고 이 프로젝트 워크로드에 바꿀 근거가 있는지 판단해 보기 (바꾸지 말고 판단만)
- [ ] `ulimit -n` 을 컨테이너 안에서 확인하고, 연결 1만 개 테스트 시 먼저 걸리는 한도가 무엇인지 예측하기
- [ ] 클라우드의 2소켓 인스턴스를 가정하고 Redis 인스턴스를 어떻게 배치할지(노드당 1개? 고정?) 근거와 함께 적기
