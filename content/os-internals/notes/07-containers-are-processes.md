---
title: "심화 — 컨테이너는 결국 프로세스다: 네임스페이스·cgroup·capability·seccomp 로 다시 보기"
order: 7
level: 심화
summary: "앞의 노트(프로세스·메모리·스케줄러·cgroup·시스템 콜)를 모아 컨테이너를 커널 기능의 조합으로 다시 본다. 호스트에서 본 컨테이너 프로세스(PID·네임스페이스 inode), 권한을 쪼갠 capability 와 비트마스크 읽기, 시스템 콜을 거르는 seccomp, no_new_privs, --privileged 와 --pid=host 가 실제로 푸는 것(이 사이트 실험이 쓰는 이유와 위험), nsenter 로 컨테이너 안에 들어가기, VM 기반 격리(gVisor·Kata·Firecracker)와의 차이, study-redis 실측(uid 999·CapEff 0·seccomp 필터, 특권 컨테이너는 capability 41개·seccomp 없음)"
tags: [컨테이너, 네임스페이스, cgroup, capability, seccomp, no_new_privs, privileged, nsenter, gVisor, Firecracker]
experiments: [os-cgroup-limits, os-context-switch]
---

## "컨테이너" 라는 커널 객체는 없다

커널 소스에 container 라는 구조체는 없다. 컨테이너는 이 주제에서 다룬 기능들을 **한 프로세스에 함께 건 것**이다.

| 커널 기능 | 컨테이너에서의 역할 | 다룬 노트 |
|---|---|---|
| 프로세스·`clone()` | 컨테이너의 실체 | [프로세스·스레드](/os-internals/notes/01-processes-threads-context-switch) |
| **네임스페이스** | 무엇이 **보이는가** (PID, 네트워크, 마운트, 호스트명 …) | 이 노트, [Docker 내부](/docker/notes/08-internals-namespaces-cgroups) |
| **cgroup** | 얼마나 **쓸 수 있는가** (CPU, 메모리, PID 수) | [스케줄러·cgroup](/os-internals/notes/03-scheduler-cgroups) |
| overlayfs | 어떤 **파일**이 보이는가 | [파일시스템](/os-internals/notes/04-filesystem-io) |
| **capability** | 루트라도 **무엇을 할 수 있는가** | 이 노트 |
| **seccomp** | 어떤 **시스템 콜**을 부를 수 있는가 | 이 노트, [시스템 콜](/os-internals/notes/05-syscalls-interrupts) |
| LSM (AppArmor/SELinux) | 어떤 **객체**에 접근할 수 있는가 | [Kubernetes 보안](/security/notes/06-kubernetes-security) |

네임스페이스 7종과 런타임 계층(dockerd → containerd → runc)은 [Docker 내부 노트](/docker/notes/08-internals-namespaces-cgroups)에 정리돼 있다. 이 노트는 **보안 경계로서의** 나머지 절반(capability, seccomp, 특권)과, 이 사이트의 실험들이 왜 특권 컨테이너를 쓰는지에 집중한다.

## 호스트에서 보면 그냥 프로세스다

Docker Desktop 의 VM 에서 study-redis 를 호스트 PID 네임스페이스 쪽에서 보면:

```bash
P=$(docker inspect -f '{{.State.Pid}}' study-redis)       # 호스트(VM) 기준 PID
docker run --rm --privileged --pid=host alpine sh -c "
  grep -E '^(Name|Uid|CapEff|NoNewPrivs|Seccomp)' /proc/$P/status
  ls -l /proc/$P/ns"
```

```
Name:        redis-server
Uid:         999 999 999 999       ← 컨테이너 안에서도 root 가 아니다 (공식 이미지가 redis 사용자로 전환)
CapEff:      0000000000000000      ← 유효 capability 0개
NoNewPrivs:  1                     ← setuid 로 권한을 다시 얻을 수 없다
Seccomp:     2                     ← 필터 모드 (Docker 기본 프로파일)
ns/pid -> pid:[4026534189]         ← 호스트와 다른 PID 네임스페이스
ns/user -> user:[4026531837]       ← 호스트와 같은 user 네임스페이스 (UID 999 는 호스트의 999)
```

컨테이너 안에서 이 프로세스는 PID 1 이고, 호스트에서는 수천 번대 PID 다. `/proc/<pid>/ns/*` 의 inode 번호가 같은 두 프로세스는 같은 네임스페이스에 있다. 실험 `os-context-switch` 가 `/proc/<호스트PID>/task/*/status` 를 읽어 Redis 의 컨텍스트 스위치를 세는 것도 이 "호스트에서 보면 프로세스" 성질을 이용한다.

## capability — 루트를 쪼갠다

전통적인 유닉스는 "root(UID 0) 이면 전부, 아니면 거의 없음" 이었다. 리눅스는 root 의 권한을 **약 40개의 capability** 로 쪼갰다.

| capability | 할 수 있는 일 | 컨테이너 기본 |
|---|---|---|
| `CAP_NET_BIND_SERVICE` | 1024 미만 포트 바인드 | ✅ |
| `CAP_CHOWN`, `CAP_SETUID`, `CAP_KILL` … | 파일 소유자 변경, UID 전환, 시그널 | ✅ |
| `CAP_NET_ADMIN` | 라우팅·iptables·인터페이스 설정 | ❌ |
| `CAP_SYS_ADMIN` | 마운트, 네임스페이스 생성, 수많은 관리 작업 — "새로운 root" | ❌ |
| `CAP_SYS_PTRACE` | 다른 프로세스 추적 (strace, 디버거) | ❌ |
| `CAP_BPF`, `CAP_PERFMON` | eBPF 프로그램 로드, perf 이벤트 | ❌ |

`CapEff` 는 16진 비트마스크다. 이 VM 에서 직접 읽은 값:

| 컨테이너 | CapEff | 해석 |
|---|---|---|
| 일반 `docker run alpine` (root) | `00000000a80425fb` | 기본 14개 |
| study-redis 의 redis-server (uid 999) | `0000000000000000` | 0개 — 비루트 프로세스는 capability 가 없다 |
| `docker run --privileged alpine` | `000001ffffffffff` | **41개 전부** |

```bash
# 비트마스크를 이름으로 (libcap 의 capsh)
capsh --decode=00000000a80425fb
```

운영 원칙은 "전부 버리고 필요한 것만": `--cap-drop=ALL --cap-add=NET_BIND_SERVICE`. Kubernetes 의 Pod Security Standards `restricted` 프로파일이 `drop: [ALL]` 을 요구하는 이유다([Kubernetes 보안](/security/notes/06-kubernetes-security), [컨테이너·공급망](/security/notes/05-container-supply-chain)).

## seccomp — 시스템 콜 목록을 거른다

capability 가 "무엇을 할 수 있나" 라면 seccomp 는 "어떤 시스템 콜을 부를 수 있나" 다. 커널 안에서 BPF 필터가 시스템 콜 번호(와 인자)를 보고 허용·거부·로그를 정한다.

- Docker 기본 프로파일은 300여 개 시스템 콜 중 **약 40~50개를 막는다**: `mount`, `reboot`, `kexec_load`, `bpf`, `perf_event_open`, `keyctl`, `add_key`, 그리고 최근 버전은 `io_uring_*` 까지.
- `/proc/<pid>/status` 의 `Seccomp: 2` 가 필터 모드다(0 = 없음).
- 커스텀 프로파일: 앱이 실제로 쓰는 시스템 콜만 허용하면 공격 표면이 크게 준다. eBPF·strace 로 실제 사용 목록을 뽑아 만든다([bpftrace](/ebpf/notes/02-bpftrace-one-liners)).

**no_new_privs** 는 "이 프로세스와 자식은 setuid 바이너리로 권한을 다시 얻을 수 없다" 는 플래그다. seccomp 필터를 비루트가 걸려면 필수이고, Kubernetes `allowPrivilegeEscalation: false` 가 이것을 켠다. study-redis 의 `NoNewPrivs: 1` 이 그 상태다.

## --privileged 와 --pid=host 가 실제로 푸는 것

이 사이트의 OS·eBPF 실험은 다음처럼 컨테이너를 띄운다.

```bash
docker run --rm --privileged --pid=host study-os-tools:local perf bench sched pipe     # os-context-switch
docker run --rm --privileged -v lab-os-pagecache:/data … 'echo 3 > /proc/sys/vm/drop_caches'   # os-page-cache
docker run --rm --privileged --pid=host study-bpftrace:local -e '…'                    # eBPF 실험
```

| 옵션 | 푸는 것 | 실험에 필요한 이유 |
|---|---|---|
| `--privileged` | capability 전부, seccomp 해제, `/dev` 의 모든 장치, `/proc/sys`·`/sys` 쓰기 가능, AppArmor 해제 | `drop_caches` 쓰기, `perf_event_open`, `bpf()` |
| `--pid=host` | 호스트 PID 네임스페이스 공유 | 다른 컨테이너(study-redis)의 `/proc/<pid>` 를 보려고 |

> **주의:** 특권 컨테이너는 **사실상 호스트 root** 다. `/dev` 의 디스크를 마운트할 수 있고, 커널 모듈을 올리거나 eBPF 로 모든 프로세스를 볼 수 있다. 이 사이트에서는 "로컬 VM 을 관측하는 학습 도구" 라서 쓰는 것이고, 운영 클러스터에서 특권 Pod 는 노드 에이전트(CNI, CSI, Falco, eBPF 관측 도구)처럼 **꼭 필요한 DaemonSet 에만** 허용하고 나머지는 정책으로 막는다. Falco 가 "특권 컨테이너 시작" 을 기본 규칙으로 알리는 이유다([런타임 탐지](/ebpf/notes/05-security-falco-tetragon)).

최소 권한으로 줄이면: `perf` 는 `--cap-add=PERFMON`(+ `kernel.perf_event_paranoid` 조정), bpftrace 는 `--cap-add=BPF --cap-add=PERFMON` 과 seccomp 프로파일 조정으로 대부분 가능하다. 학습용 실험이 `--privileged` 를 쓰는 것은 단순함을 택한 것이다.

## nsenter — 이미 있는 네임스페이스로 들어가기

`docker exec` 는 내부적으로 대상 프로세스의 네임스페이스에 새 프로세스를 넣는 것이다. 같은 일을 커널 도구로:

```bash
P=$(docker inspect -f '{{.State.Pid}}' study-redis)
# 네트워크 네임스페이스만 빌려서 — 컨테이너 안에 도구가 없어도 호스트(또는 디버그 컨테이너)의 도구로
docker run --rm --privileged --pid=host nicolaka/netshoot nsenter -t $P -n ss -tlnp
```

셸도 없는 distroless 이미지를 디버깅할 때 쓰는 기법이고, Kubernetes 의 `kubectl debug --target=<container>` 가 이 아이디어(같은 PID 네임스페이스를 공유하는 임시 컨테이너)다([Kubernetes 운영·디버깅](/kubernetes/notes/08-ops-debugging)).

## 프로세스 격리의 한계, 그리고 VM 격리

컨테이너들은 **커널 하나를 공유**한다. 커널 취약점 하나가 모든 컨테이너의 경계를 무너뜨릴 수 있다. 그래서 신뢰할 수 없는 코드(멀티테넌트 SaaS, CI 러너, 사용자 코드 실행)에는 더 강한 격리를 쓴다.

| 방식 | 원리 | 비용 |
|---|---|---|
| 일반 컨테이너 | 네임스페이스 + cgroup + seccomp | 거의 0 |
| user 네임스페이스 (rootless) | 컨테이너 root = 호스트의 비특권 UID | 거의 0, 일부 기능 제약 |
| **gVisor** | 유저 공간에 커널을 다시 구현해 시스템 콜을 가로챔 | 시스템 콜이 많은 워크로드에서 느림 |
| **Kata / Firecracker** | 컨테이너마다 경량 VM (자기 커널) | 시작 수백 ms, 메모리 오버헤드 수십 MiB |

이 Mac 의 Docker Desktop 자체가 "VM 하나 + 그 안의 컨테이너들" 구조다. 그래서 실험의 `drop_caches` 나 cgroup 설정은 Mac 이 아니라 **VM 커널**에 영향을 준다 — 그리고 kind 노드와 compose 컨테이너가 같은 커널을 공유하기 때문에 kind 안의 Falco 가 compose 컨테이너의 이벤트까지 본다([런타임 탐지 실험](/security/lab)).

## 예시로 보기 — 이 프로젝트의 실험을 "커널 기능" 으로 읽기

| 실험 | 쓰는 커널 기능 | 컨테이너 옵션 |
|---|---|---|
| `os-context-switch` | 스케줄러, `/proc/<pid>/task/*/status`, perf 이벤트 | `--privileged`, `--pid=host` |
| `os-page-cache` | 페이지 캐시, `drop_caches`, O_DIRECT | `--privileged`, named volume(ext4) |
| `os-cgroup-limits` | cgroup v2 `cpu.max`·`memory.max`·`memory.events`, OOM 킬러 | `--cpus`, `--memory` (특권 불필요) |
| `ebpf-*` | BPF 검증기·맵·tracepoint | `--privileged`, `--pid=host` |
| `sec-k8s-rbac` | (커널 아님) API 서버 인가 | — |

`os-cgroup-limits` 만 특권이 필요 없다는 점에 주목하자. 한도를 **거는** 것은 런타임의 일이고, 컨테이너는 자기 cgroup 파일을 **읽을** 수만 있으면 된다. 반대로 커널 전체를 관측·조작하는 실험은 경계를 넘어야 한다 — 그 경계가 바로 이 노트의 주제다.

> 이어서 읽기: [Docker 란 무엇인가](/docker/notes/01-docker-overview) — Docker 가 이 커널 기능들을 감싸는 방식

## 실습 체크리스트

- [ ] study-redis 의 `/proc/<호스트PID>/status` 에서 Uid·CapEff·Seccomp·NoNewPrivs 를 읽고, 같은 값을 `docker run --rm alpine` 과 `--privileged` 컨테이너와 비교하기
- [ ] `capsh --decode` 로 기본 capability 14개의 이름을 확인하기 (`docker run --rm alpine sh -c 'apk add -q libcap && capsh --decode=00000000a80425fb'`)
- [ ] `docker run --rm --cap-drop=ALL alpine chown 1 /tmp` 가 `Operation not permitted` 로 실패하고 `--cap-add=CHOWN` 하나로 성공하는 것 확인하기. 같은 조건에서 `ping` 은 왜 되는지(ICMP 데이터그램 소켓과 `net.ipv4.ping_group_range`) 찾아보기
- [ ] `os-page-cache` 실험의 `--privileged` 를 빼고 `drop_caches` 쓰기가 어떤 에러로 실패하는지 수동으로 확인하기
- [ ] `kubectl debug` 로 web Pod 에 임시 컨테이너를 붙여 같은 PID 네임스페이스의 프로세스를 보기
