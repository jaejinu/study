---
title: "심화 — 컨테이너의 실체: namespace, cgroup, overlayfs"
order: 8
level: 심화
summary: 컨테이너는 격리된 프로세스일 뿐임을 리눅스 원시 명령으로 확인한다. 7가지 namespace 의 역할, cgroup v2 로 CPU·메모리 제한이 걸리는 방식과 OOM·throttling, overlay2 의 레이어 합성과 copy-up, 런타임 계층(containerd·runc·OCI), 컨테이너 안에서 호스트 자원을 잘못 읽는 문제
tags: [namespace, cgroup, overlayfs, containerd, runc, OCI, 내부구조]
experiments: [docker-image-layers, docker-container-lifecycle]
---

## 컨테이너 = 프로세스 + 격리 + 제한 + 파일시스템

```
격리:      namespace  (무엇을 볼 수 있나)
제한:      cgroup     (얼마나 쓸 수 있나)
파일시스템: overlayfs  (이미지 레이어를 겹쳐 하나처럼)
보안:      capabilities, seccomp, AppArmor/SELinux (무엇을 할 수 있나)
```

호스트(리눅스)에서 보면 컨테이너 프로세스는 `ps` 에 보이는 보통 프로세스다. macOS 의 Docker Desktop 은 리눅스 VM 안에서 이 일을 하므로 아래 명령은 VM 안(특권 컨테이너로 진입)에서 실행한다.

```bash
docker run -d --name ns-demo redis:8-alpine
docker inspect -f '{{.State.Pid}}' ns-demo                   # VM 안 PID
# VM 으로 진입 (Docker Desktop)
docker run -it --rm --privileged --pid=host alpine nsenter -t 1 -m -u -n -i sh
ls -l /proc/<PID>/ns/                                         # 이 프로세스의 namespace inode 들
nsenter -t <PID> -n ip addr                                   # 그 컨테이너의 net namespace 안에서 명령 실행
```

## namespace 7가지

| namespace | 격리 대상 | 컨테이너에서 보이는 것 |
|---|---|---|
| **pid** | 프로세스 ID | 안에서 PID 1 = 메인 프로세스. 호스트 PID 와 다름 |
| **net** | 인터페이스·라우팅·iptables·포트 | 자기 `eth0`(veth 한쪽), `lo`. 127.0.0.1 은 자기 자신 |
| **mnt** | 마운트 포인트 | 자기 루트 파일시스템(overlay) |
| **uts** | 호스트명 | `--hostname` |
| **ipc** | 공유 메모리·세마포어 | |
| **user** | UID/GID 매핑 | rootless: 컨테이너 root = 호스트 일반 사용자 |
| **cgroup** | cgroup 루트 | |
| time | 시계 오프셋 (5.6+) | |

```bash
docker run --rm alpine ps aux                                  # PID 1 하나뿐
docker run --rm --pid=host alpine ps aux | head                 # 호스트 프로세스가 보임
docker run --rm --network=container:ns-demo alpine netstat -tln # 다른 컨테이너의 net namespace 공유 (사이드카 원리)
unshare --pid --fork --mount-proc sh -c 'ps aux'                # Docker 없이 namespace 만들기 (리눅스)
```

Kubernetes Pod 의 컨테이너들이 localhost 로 통신하는 이유: pause 컨테이너가 잡아 둔 **같은 net namespace** 를 공유한다.

## cgroup v2 — 자원 제한

```bash
docker run -d --name limited --memory 128m --cpus 0.5 redis:8-alpine
# VM 안: /sys/fs/cgroup/system.slice/docker-<id>.scope/
cat memory.max        # 134217728
cat cpu.max           # 50000 100000  (100ms 주기 중 50ms)
cat memory.current ; cat cpu.stat     # 실제 사용, nr_throttled
docker stats limited
```

- **메모리 limit 초과 → OOM kill**(exit 137). JVM/Node 는 cgroup 한도를 인식하도록(`-XX:MaxRAMPercentage`, `--max-old-space-size`). Redis 는 `maxmemory` 를 limit 보다 작게 ([Redis 튜닝](/redis/notes/19-performance-tuning)).
- **CPU limit 은 throttling**: 주기 안 할당량을 다 쓰면 남은 시간 동안 멈춤 → 지연 스파이크. `cpu.stat` 의 `nr_throttled`. 지연 민감 서비스는 limit 없이 requests 만 두는 선택도 흔하다(Kubernetes 에서도 같은 논쟁).
- cgroup v1 vs v2: 최신 배포판·Docker 는 v2(단일 계층). `docker info | grep -i cgroup`.

## overlay2 — 레이어 합성

```
merged (컨테이너가 보는 루트) = upper (컨테이너 쓰기 레이어) ⊕ lower (이미지 레이어들, 읽기 전용)
```

```bash
docker inspect -f '{{json .GraphDriver.Data}}' ns-demo | jq     # LowerDir, UpperDir, MergedDir
docker diff ns-demo                                              # A(추가) C(변경) D(삭제)
```

- 읽기는 위에서 아래로 처음 찾은 파일. 쓰기는 **copy-up**(하위 파일을 upper 로 복사 후 수정) — 큰 파일을 조금만 바꿔도 전체 복사.
- 삭제는 **whiteout** 파일(`.wh.<name>`) — [레이어 실험](/docker/lab/docker-image-layers)에서 본 것.
- 작은 파일을 많이 쓰는 워크로드(DB)는 overlay 보다 볼륨이 빠르다.

## 런타임 계층

```
docker CLI ─▶ dockerd (API, 이미지, 네트워크, 볼륨)
              └─▶ containerd (컨테이너 생명주기, 이미지 저장, 스냅샷터)
                    └─▶ containerd-shim ─▶ runc (OCI 런타임: namespace/cgroup 만들고 프로세스 exec 후 종료)
```

- **OCI**: 이미지 명세(레이어 tar + config JSON) 와 런타임 명세(config.json). Docker 이미지 = OCI 이미지 → Kubernetes(containerd), Podman 에서 그대로.
- shim 덕분에 dockerd 를 재시작해도 컨테이너가 살아 있다(`live-restore`).
- 대안 런타임: gVisor(runsc, 사용자 공간 커널), Kata(경량 VM), Firecracker(microVM — Lambda, Vercel Sandbox).

```bash
docker info | grep -iE "runtime|cgroup|storage"
ctr --namespace moby containers list          # containerd 직접 보기 (VM 안)
```

## 컨테이너 안에서 "호스트" 자원을 잘못 읽는 문제

- `nproc`, `free -m` 은 호스트 값(namespace 가 아니라 cgroup 이 제한하므로). 앱이 "코어 32개" 로 스레드 풀을 만들면 throttling. 런타임이 cgroup 을 읽게 하거나(`GOMAXPROCS`, JVM 10+ 자동) 명시 설정.
- 시간대·로케일은 이미지에 없음 → `TZ` 환경 변수.
- `/proc/sys` 일부는 읽기 전용 → `--sysctl net.core.somaxconn=4096`.

## 직접 만들어 보는 "미니 컨테이너"

Docker 없이 리눅스 명령만으로 컨테이너의 핵심을 재현하면 구성 요소가 확실히 보인다(Docker Desktop VM 안에서, 또는 리눅스 호스트에서).

```bash
# 1) 루트 파일시스템 준비: alpine 이미지를 디렉터리로 풀기
mkdir -p /tmp/mini/rootfs && docker export $(docker create alpine) | tar -x -C /tmp/mini/rootfs

# 2) 새 네임스페이스들 + 루트 바꾸기
unshare --pid --fork --mount --uts --net --ipc --mount-proc=/tmp/mini/rootfs/proc \
  chroot /tmp/mini/rootfs /bin/sh -c 'hostname mini; hostname; ps; ip link'
# mini
# PID USER TIME COMMAND
#   1 root  0:00 /bin/sh -c ...      ← 자기가 PID 1
# 1: lo: <LOOPBACK> ...              ← 네트워크는 lo 뿐 (veth 를 안 꽂았으니)

# 3) cgroup 으로 메모리 제한 걸기 (cgroup v2)
mkdir /sys/fs/cgroup/mini && echo 50M > /sys/fs/cgroup/mini/memory.max
echo $$ > /sys/fs/cgroup/mini/cgroup.procs    # 현재 셸을 cgroup 에 넣고 위 unshare 를 실행
```

| 직접 한 것 | Docker 에서 대응하는 부분 |
|---|---|
| `docker export` + tar | 이미지 레이어 → overlay 스냅샷(containerd snapshotter) |
| `unshare` | runc 의 `clone(CLONE_NEWPID|CLONE_NEWNET|...)` |
| `chroot` | runc 의 `pivot_root`(chroot 보다 안전) |
| cgroup 디렉터리 쓰기 | runc 가 `/sys/fs/cgroup/.../docker-<id>.scope` 생성 |
| (안 한 것) veth + 브리지 | dockerd/CNI 의 네트워크 설정 |
| (안 한 것) seccomp·capability | runc 가 OCI `config.json` 대로 적용 |

`chroot` 대신 `pivot_root` 를 쓰는 이유: chroot 는 루트가 바뀐 프로세스가 `..` 를 따라 탈출하는 고전 기법이 있고, pivot_root 는 마운트 네임스페이스 안에서 옛 루트를 아예 떼어 낸다.

## OCI 번들을 직접 보기

runc 가 받는 입력은 `rootfs/` 디렉터리 + `config.json` 하나다. 이것이 **OCI 런타임 명세**의 전부다.

```bash
mkdir -p /tmp/bundle/rootfs && cd /tmp/bundle
docker export $(docker create alpine) | tar -x -C rootfs
runc spec                     # 기본 config.json 생성
grep -A3 '"namespaces"' config.json   # pid, network, ipc, uts, mount
grep -A2 '"capabilities"' config.json # bounding/effective 집합
runc run demo                 # 이게 컨테이너다
```

containerd 는 이미지에서 이 번들을 만들어 runc 에 넘긴다. Kubernetes 도 같은 번들로 끝난다. 그래서 Docker 로 만든 이미지가 어디서나 돈다.

## 메모리 회계 — cgroup 이 세는 것

cgroup v2 `memory.current` 는 **anon(프로세스 힙·스택) + file(페이지 캐시) + kernel(소켓 버퍼·slab)** 을 모두 센다.

| 항목 | 예 | 제한에 걸리면 |
|---|---|---|
| anon | Redis 데이터, Node 힙 | 회수 불가 → OOM kill |
| file(페이지 캐시) | 로그 파일 쓰기, RDB 읽기 | 커널이 먼저 회수(깨끗한 캐시) |
| kernel | 많은 TCP 연결의 버퍼 | 회수 어려움 |

그래서 `docker stats` 의 사용량이 limit 근처여도 대부분이 캐시라면 위험하지 않을 수 있고, 반대로 anon 이 꽉 차면 즉시 OOM 이다. `memory.events` 의 `high`/`max`/`oom_kill` 카운터로 실제로 압박이 있었는지 확인한다. 페이지 캐시 동작 자체는 [가상 메모리와 페이지 캐시](/os-internals/notes/02-virtual-memory-page-cache), 실험 `os-page-cache`.

## PID 1 의 특별한 책임

컨테이너의 PID 1 은 리눅스에서 init 이 하는 두 가지를 떠맡는다.

1. **신호 기본 동작 없음**: 커널은 PID 1 에게 핸들러가 없는 SIGTERM·SIGINT 를 **무시**한다. 앱이 핸들러를 등록하지 않으면 `docker stop` 이 10초 기다렸다 SIGKILL 한다(종료 코드 137).
2. **좀비 수거**: 고아 프로세스는 PID 1 의 자식이 된다. PID 1 이 `wait()` 를 안 하면 좀비가 쌓여 `--pids-limit` 에 걸린다.

```bash
docker run -d --name z alpine sh -c 'while true; do (sleep 1 &) ; sleep 0.1; done'
docker exec z ps -o pid,stat,comm | grep -c Z      # 좀비(Z) 증가
docker rm -f z
docker run -d --init --name z2 alpine sh -c '...'  # tini 가 PID 1 이 되어 수거
```

`--init`(tini), Kubernetes 의 `shareProcessNamespace` + pause 컨테이너가 이 역할을 한다.

## 예시로 보기 — 이 프로젝트의 실험들이 쓰는 내부 기능

| 실험 | 쓰는 커널 기능 | 이 노트의 어느 부분 |
|---|---|---|
| `docker-image-layers` | overlay2 레이어·whiteout | overlay2 |
| `chaos-redis-hang`, `alert-pipeline-redis-down` | cgroup **freezer**(`docker pause`) | cgroup |
| `os-cgroup-limits` | `cpu.max` 스로틀·`memory.max` OOM | cgroup v2 |
| `ebpf-*`, `os-context-switch` | `--privileged --pid=host` 로 VM 의 PID 네임스페이스 공유 | namespace |
| `sec-k8s-networkpolicy` | Pod 의 net 네임스페이스 + Calico | namespace |
| `sec-falco-runtime` | eBPF 가 **커널 단위**로 보므로 kind 노드·compose 컨테이너 모두 관측 | 런타임 계층 |

마지막 항목이 흥미롭다. kind 의 Kubernetes 노드도 결국 Docker 컨테이너이고, compose 의 Redis 도 같은 VM 커널 위의 프로세스라, 커널을 보는 도구에게는 "다른 클러스터" 라는 경계가 없다.

## 운영·관측 포인트

- cAdvisor(kubelet 내장)가 cgroup 파일을 읽어 `container_memory_working_set_bytes`, `container_cpu_cfs_throttled_periods_total` 같은 메트릭을 낸다. 이 노트의 파일들이 그 메트릭의 원천이다 — [Kubernetes 모니터링 스택](/kubernetes/notes/10-monitoring-stack).
- working_set = usage − 비활성 파일 캐시. Kubernetes 가 OOM·축출 판단에 쓰는 값이라 `docker stats` 와 숫자가 다를 수 있다.

## 실전에서는 어디에 쓰이나

> namespace·cgroup·overlayfs·런타임 계층은 "컨테이너 안과 밖의 숫자가 다르다", "제한을 줬는데 왜 느리거나 죽나" 를 설명해야 할 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| Kubernetes 위 JVM·Go 서비스 | 호스트 코어 수로 스레드를 만들어 스로틀링 | cgroup `cpu.max` 기준으로 `GOMAXPROCS`·JVM 컨테이너 지원 설정 | CPU limit 없이 requests 만 두기 |
| 메모리 알림이 잦은 캐시 서버 | 사용량이 limit 근처인데 진짜 위험한지 판단 | `memory.stat` 의 anon/file 분리, `memory.events` 의 oom_kill | 무조건 limit 상향 — 비용만 는다 |
| 사이드카 패턴(프록시·로그 수집기) | 앱과 같은 localhost 로 통신 | net namespace 공유(`--network=container:`, Pod) | 별도 서비스로 분리해 네트워크 호출 |
| 서버리스·코드 실행 샌드박스 | 남의 코드를 커널 공유 없이 격리 | gVisor·Kata·Firecracker 같은 대체 런타임 | 일반 runc 컨테이너 — 신뢰된 코드에만 |
| 장시간 도는 워커 컨테이너 | 좀비 누적으로 PID 한도 도달 | `--init`(tini) 또는 PID 1 에서 자식 수거 | 앱이 직접 `wait()` 구현 |

**이럴 땐 안 맞는다**
- 매일 운영을 `unshare`·`runc` 로 직접 하는 것 — 원리 이해와 디버깅용이다. 운영은 Docker·containerd 같은 상위 도구에 맡긴다.
- 컨테이너 격리만으로 멀티테넌트 보안 경계를 삼는 것 — 커널 공유가 한계다. VM·microVM 경계를 더한다.

**누가 매일 만나나** — SRE 와 플랫폼 엔지니어는 `container_cpu_cfs_throttled_periods_total`·working_set 메트릭을 해석할 때, 성능 담당 백엔드 개발자는 컨테이너 안 `nproc`·`free` 가 호스트 값을 보여 줄 때 만난다.

**면접·실무 단골 질문**
- Q. 컨테이너와 VM 의 격리 차이 → 컨테이너는 namespace·cgroup 으로 격리된 프로세스, 커널은 호스트와 공유한다.
- Q. Kubernetes Pod 안 컨테이너들이 localhost 로 통신하는 이유 → pause 컨테이너가 잡은 같은 net namespace 를 공유한다.

## 실습 체크리스트

- [ ] `docker run --pid=host` 로 호스트 프로세스가 보이는 것과 기본 격리 비교
- [ ] `--memory 32m` 으로 Redis 를 띄우고 큰 값을 넣어 OOM(exit 137) 재현, `docker inspect` 의 OOMKilled 확인
- [ ] `--cpus 0.2` 로 벤치마크를 돌려 throttling 이 지연에 미치는 영향 보기
- [ ] `docker diff` 로 컨테이너 쓰기 레이어 변화 확인
- [ ] `--network=container:` 로 사이드카처럼 다른 컨테이너의 포트를 localhost 로 접근
- [ ] `unshare --pid --fork --mount-proc` + `chroot` 로 미니 컨테이너를 만들어 PID 1 확인
- [ ] `runc spec` 으로 config.json 을 열어 namespaces·capabilities 항목 읽기
- [ ] 좀비 생성 컨테이너를 `--init` 없이/있이 띄워 비교
