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

## 실습 체크리스트

- [ ] `docker run --pid=host` 로 호스트 프로세스가 보이는 것과 기본 격리 비교
- [ ] `--memory 32m` 으로 Redis 를 띄우고 큰 값을 넣어 OOM(exit 137) 재현, `docker inspect` 의 OOMKilled 확인
- [ ] `--cpus 0.2` 로 벤치마크를 돌려 throttling 이 지연에 미치는 영향 보기
- [ ] `docker diff` 로 컨테이너 쓰기 레이어 변화 확인
- [ ] `--network=container:` 로 사이드카처럼 다른 컨테이너의 포트를 localhost 로 접근
