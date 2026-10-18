---
title: Docker 란 무엇인가
order: 1
level: 기초
summary: 컨테이너가 VM 과 다른 점, 이미지·컨테이너·레지스트리의 관계, Docker 가 해결하는 문제
tags: [개요, 컨테이너, 이미지, 레지스트리, VM]
experiments: [docker-container-lifecycle]
---

## 해결하려는 문제

"내 컴퓨터에서는 되는데요." 애플리케이션은 코드만으로 돌아가지 않는다. 런타임 버전, 시스템 라이브러리, 환경 변수, 설정 파일이 모두 맞아야 한다.
Docker 는 이 **전체 실행 환경을 하나의 이미지로 포장**해서 어디서든 같은 방식으로 실행하게 해 준다.

## 컨테이너 vs 가상 머신

| | 가상 머신 | 컨테이너 |
|---|---|---|
| 격리 단위 | 하드웨어 가상화, 게스트 OS 전체 | 프로세스. 호스트 커널 공유 |
| 크기 | 수 GB | 수십 MB ~ 수백 MB |
| 시작 시간 | 수십 초 ~ 분 | 밀리초 ~ 초 |
| 오버헤드 | 큼 (OS 하나 더) | 거의 없음 |
| 격리 강도 | 강함 | 상대적으로 약함 (커널 공유) |

컨테이너는 리눅스 커널 기능 위에 서 있다.
- **namespaces**: 프로세스가 보는 세계(PID, 네트워크, 마운트, 사용자)를 분리
- **cgroups**: CPU·메모리 사용량 제한
- **union filesystem** (overlay2): 이미지 레이어를 겹쳐서 하나의 파일시스템처럼

macOS/Windows 에서는 리눅스 커널이 없으므로 Docker Desktop 이 **경량 리눅스 VM** 을 하나 띄우고 그 안에서 컨테이너를 돌린다. 그래서 파일 마운트 성능이 리눅스보다 느리다.

## 세 가지 핵심 개념

```
Dockerfile  --build-->  Image  --run-->  Container
                          |
                     push / pull
                          |
                       Registry (Docker Hub, GHCR, ECR ...)
```

- **이미지(Image)**: 읽기 전용 템플릿. 파일시스템 레이어들 + 실행 방법(메타데이터). 클래스에 비유.
- **컨테이너(Container)**: 이미지를 실행한 인스턴스. 이미지 위에 쓰기 가능한 얇은 레이어가 얹힌다. 객체에 비유.
- **레지스트리(Registry)**: 이미지 저장소. `docker pull redis:8-alpine` 은 Docker Hub 의 `library/redis` 저장소에서 `8-alpine` 태그를 받는다.

이미지 이름 구조: `[registry/][namespace/]repository[:tag|@digest]`
```
redis                        = docker.io/library/redis:latest
ghcr.io/myorg/api:1.4.2
redis@sha256:ab12...         # 태그 대신 다이제스트로 고정
```

## Docker 의 구성 요소

- **Docker CLI** (`docker`): 사용자가 치는 명령.
- **Docker 데몬** (`dockerd`): 이미지 빌드, 컨테이너 실행을 실제로 수행. CLI 는 REST API 로 데몬과 통신한다.
- **containerd / runc**: 데몬 아래에서 실제 컨테이너 생명주기를 관리하는 저수준 런타임. Kubernetes 는 Docker 없이 containerd 를 직접 쓴다.

## 무엇에 쓰나

1. **개발 환경 통일**: 팀원 모두 같은 DB·캐시 버전을 `docker compose up` 한 번으로.
2. **배포 단위**: 빌드된 이미지를 그대로 스테이징·운영에. "빌드 한 번, 어디서나 실행".
3. **CI**: 깨끗한 환경에서 테스트.
4. **격리된 실험**: 이 프로젝트처럼 Redis 를 설치하지 않고 바로 띄워 보기.

## 이 노트 시리즈의 실습 방식

Docker 는 터미널에서 직접 명령을 치며 배우는 것이 가장 빠르다. 각 노트의 **실습** 블록을 그대로 따라 하자.
설치가 안 되어 있다면:

```bash
brew install --cask docker    # Docker Desktop (GUI 포함)
# 또는
brew install orbstack         # 더 가볍고 빠름, 명령 호환
docker version                # Client 와 Server 둘 다 나오면 준비 완료
```

대시보드의 환경 점검 카드가 데몬 연결 여부와 실행 중인 컨테이너를 보여준다.

## 컨테이너는 "가벼운 VM" 이 아니라 "격리된 프로세스" 다

이 차이가 Docker 를 이해하는 출발점이다. 컨테이너 안에서 `redis-server` 를 실행하면, 호스트(리눅스) 입장에서는 **그냥 프로세스 하나**가 늘어난 것이다. 커널은 하나뿐이고, 그 프로세스에게 "보이는 세계" 와 "쓸 수 있는 자원" 만 줄여 놓았을 뿐이다.

```bash
# 호스트(또는 Docker Desktop VM)에서 보면 컨테이너 프로세스가 그대로 보인다
docker run -d --name ps-demo redis:8-alpine
docker top ps-demo
# UID   PID    PPID   C  STIME  TTY  TIME      CMD
# 999   41237  41215  0  10:02  ?    00:00:00  redis-server *:6379

# 컨테이너 안에서 보면 자기가 PID 1 이다 (PID 네임스페이스)
docker exec ps-demo ps
# PID   USER     TIME  COMMAND
#     1 redis     0:00 redis-server *:6379
docker rm -f ps-demo
```

같은 프로세스가 바깥에서는 41237, 안에서는 1 이다. 이것이 **네임스페이스**다. 커널이 "이 프로세스에게는 PID 번호를 이렇게 보여 줘라" 라고 테이블을 따로 두는 것이다.

| 커널 기능 | 무엇을 격리/제한 | 컨테이너에서 보이는 효과 |
|---|---|---|
| PID 네임스페이스 | 프로세스 번호 공간 | 안에서 자기가 PID 1, 다른 컨테이너 프로세스 안 보임 |
| NET 네임스페이스 | 네트워크 인터페이스·라우팅·포트 | 컨테이너마다 `eth0`, 같은 6379 포트를 여러 컨테이너가 사용 |
| MNT 네임스페이스 | 마운트 테이블 | 이미지 파일시스템이 `/` 로 보임 |
| UTS 네임스페이스 | 호스트 이름 | `hostname` 이 컨테이너 ID |
| IPC / USER 네임스페이스 | 공유 메모리, UID 매핑 | (USER 는 rootless 모드에서 핵심) |
| cgroup | CPU·메모리·PID 수·I/O 사용량 | `--memory 512m` 을 넘으면 OOMKilled |
| seccomp / capabilities | 쓸 수 있는 시스템 콜·권한 | `mount`, `reboot` 같은 위험한 호출 차단 |

이 세 묶음(네임스페이스로 **보이는 것**, cgroup 으로 **쓰는 양**, seccomp·capability 로 **할 수 있는 일**)을 합친 것이 컨테이너다. 내부를 더 깊게는 [Docker 내부 — 네임스페이스와 cgroup](/docker/notes/08-internals-namespaces-cgroups), 커널 관점은 [운영체제 내부 — 컨테이너는 결국 프로세스](/os-internals/notes/07-containers-are-processes) 와 [스케줄러와 cgroup](/os-internals/notes/03-scheduler-cgroups) 에서 다룬다.

### 그래서 생기는 결과들

- **시작이 빠르다**: 부팅할 OS 가 없다. `fork` + `exec` + 네임스페이스 설정이 전부라 수십~수백 ms.
- **커널 버전은 호스트 것**: 컨테이너 안에서 `uname -r` 을 치면 호스트 커널이 나온다. "Ubuntu 컨테이너" 는 Ubuntu 의 **유저 공간(파일들)** 이지 Ubuntu 커널이 아니다.
- **격리 강도는 커널이 한계**: 커널 취약점 하나로 컨테이너 밖으로 탈출할 수 있다. 다른 고객의 코드를 실행하는 서비스가 gVisor·Firecracker 같은 더 강한 경계를 쓰는 이유다 ([보안 — 컨테이너와 공급망](/security/notes/05-container-supply-chain)).
- **리눅스 바이너리만 돈다**: macOS 의 Docker Desktop 은 그래서 리눅스 VM 을 하나 띄운다. Apple Silicon 에서는 이 VM 이 arm64 라 `linux/amd64` 이미지는 에뮬레이션(Rosetta/QEMU)으로 느리게 돈다 → [BuildKit 과 멀티 플랫폼](/docker/notes/09-buildkit-multiplatform).

## docker run 한 줄이 실제로 하는 일

```
docker CLI ──REST(/var/run/docker.sock)──▶ dockerd
   dockerd: 이미지 확인/pull → 컨테이너 설정(JSON) 생성 → 네트워크·볼륨 준비
   dockerd ──gRPC──▶ containerd: 스냅샷(overlay) 준비, 태스크 생성
   containerd ──▶ containerd-shim ──▶ runc: 네임스페이스·cgroup 설정 후 exec(앱)
   runc 는 종료되고 shim 이 남아 컨테이너 프로세스의 부모 역할(로그·종료 코드 수집)
```

| 단계 | 누가 | 실패하면 보이는 메시지 |
|---|---|---|
| 데몬 연결 | CLI → dockerd | `Cannot connect to the Docker daemon at unix:///var/run/docker.sock` |
| 이미지 확보 | dockerd → 레지스트리 | `pull access denied`, `manifest unknown`, `no matching manifest for linux/arm64` |
| 파일시스템 준비 | containerd snapshotter | `no space left on device` |
| 네트워크·포트 | dockerd (iptables/vpnkit) | `port is already allocated` |
| 프로세스 실행 | runc | `exec format error`(아키텍처 불일치), `executable file not found in $PATH` |

메시지가 **어느 층**에서 나왔는지 알면 디버깅 시간이 반으로 준다. 예를 들어 `exec format error` 는 이미지 문제(arm64 머신에서 amd64 전용 바이너리)지 네트워크 문제가 아니다.

### 소켓 = 루트 권한

CLI 와 데몬은 `/var/run/docker.sock` 유닉스 소켓으로 통신한다. 이 소켓에 쓸 수 있으면 `docker run -v /:/host --privileged ...` 로 호스트 전체를 조작할 수 있다. 그래서 **`docker` 그룹 = root** 이고, 컨테이너에 docker.sock 을 마운트하는 것(CI 러너에서 흔함)은 호스트를 넘겨주는 것과 같다.

## 이미지 다이제스트와 멀티 아키텍처 매니페스트

태그는 **움직이는 포인터**, 다이제스트는 **내용 해시**다.

```bash
docker buildx imagetools inspect redis:8-alpine
# Name:      docker.io/library/redis:8-alpine
# MediaType: application/vnd.oci.image.index.v1+json
# Digest:    sha256:…(인덱스)
# Manifests:
#   Name: …@sha256:…   Platform: linux/amd64
#   Name: …@sha256:…   Platform: linux/arm64
#   …
```

`redis:8-alpine` 하나가 실제로는 **이미지 인덱스**이고, 그 안에 아키텍처별 매니페스트가 들어 있다. `docker pull` 은 내 플랫폼(Apple Silicon 이면 `linux/arm64`)에 맞는 것을 고른다. 그래서 같은 태그가 내 맥과 CI(amd64)에서 서로 다른 바이트를 받는다. 운영 배포에서 "어제와 같은 이미지" 를 보장하려면 `image@sha256:…` 로 고정한다.

## Docker 대안과 생태계 지도

| 도구 | 성격 | 언제 |
|---|---|---|
| Docker Engine / Desktop | 데몬 + CLI + 빌드(BuildKit) | 대부분의 개발·CI |
| Podman | 데몬 없음, rootless 기본, `docker` 와 거의 같은 CLI | 데몬 없는 환경, 보안 정책상 root 데몬 금지 |
| containerd + nerdctl | Docker 아래층을 직접 | Kubernetes 노드, 가벼운 런타임 |
| OrbStack / Colima | macOS 용 VM 관리자 | Docker Desktop 대체(가벼움) |
| BuildKit / buildx | 빌더 | 병렬·캐시·멀티 플랫폼 빌드 |
| Kubernetes(CRI) | 오케스트레이터, Docker 없이 containerd 사용 | 운영 배포 |

"Kubernetes 가 Docker 를 버렸다" 는 말은 **dockershim 을 제거했다**는 뜻이다. Docker 로 만든 이미지는 OCI 표준이라 containerd 위에서 그대로 돈다.

## 예시로 보기 — 이 프로젝트에서

이 저장소는 Docker 를 세 가지 방식으로 쓴다.

1. **의존 서비스 띄우기**: `docker-compose.yml` 의 `redis`(기본), `kafka`, `postgres`, `observability`(Prometheus·Grafana·Loki·Tempo), `search`(OpenSearch), `mq`(RabbitMQ·NATS) 등을 **프로파일**로 나눠 필요한 것만 올린다 — [Compose](/docker/notes/05-compose).
2. **앱 자체를 이미지로**: 루트 `Dockerfile` 이 멀티스테이지로 Next.js standalone 산출물만 담은 `study:dev` 를 만든다 — [이미지와 Dockerfile](/docker/notes/03-images-dockerfile).
3. **실험 도구**: 셸 실험이 `docker pause`(장애 주입), 특권 컨테이너(bpftrace·perf), 일회용 컨테이너(`--rm`)를 쓴다. 컨테이너가 "그냥 프로세스" 라서 가능한 일들이다.

```bash
docker compose ps --format "table {{.Name}}\t{{.Image}}\t{{.Status}}"
docker info --format '{{.OSType}} {{.Architecture}} kernel={{.KernelVersion}} cgroup={{.CgroupVersion}}'
# linux aarch64 kernel=6.12.x-linuxkit cgroup=2   ← Docker Desktop 의 리눅스 VM 정보
```

## 운영·관측 포인트

- `docker system df` 로 이미지·컨테이너·볼륨·빌드 캐시가 차지하는 디스크를 주기적으로 본다. Docker Desktop VM 디스크가 차면 모든 컨테이너가 이상하게 실패한다.
- 컨테이너 메트릭은 cgroup 파일에서 나온다. `docker stats` 의 MEM USAGE 는 페이지 캐시를 일부 포함하므로 앱 RSS 보다 크게 보일 수 있다.
- 로그 드라이버 기본값은 `json-file` 이고 **크기 제한이 없다**. 오래 도는 컨테이너는 `--log-opt max-size=10m --log-opt max-file=3` 을 준다.

## 실전에서는 어디에 쓰이나 — Docker 지도

> Docker 는 "애플리케이션과 실행 환경을 하나의 불변 이미지로 묶어 어디서나 같은 방식으로 띄우는" 표준 포장 단위다. 개발 PC 에서 CI, 운영 클러스터까지 같은 이미지가 흘러간다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 신규 입사자가 하루 만에 로컬 개발 환경 구성 | DB·캐시·브로커를 `compose up` 한 번으로 | [Docker Compose — 여러 컨테이너를 한 파일로](/docker/notes/05-compose) |
| 웹 서비스 배포 파이프라인(빌드 → 스테이징 → 운영) | 이미지 한 번 빌드해 태그·다이제스트로 승격 | [이미지와 Dockerfile](/docker/notes/03-images-dockerfile) |
| 모노레포 CI 의 빌드 시간·캐시 비용 | BuildKit 캐시, 멀티 플랫폼 빌드 | [심화 — BuildKit, buildx, 멀티플랫폼, 캐시 전략](/docker/notes/09-buildkit-multiplatform) |
| DB·메시지 브로커를 컨테이너로 운영 | 볼륨으로 데이터 보존, 네트워크 분리 | [볼륨과 네트워크](/docker/notes/04-volumes-networks) |
| 새벽 장애: 컨테이너가 재시작 루프 | 종료 코드·로그·nsenter 로 원인 추적 | [운영 명령과 디버깅](/docker/notes/07-ops-debugging) |
| 핀테크·공공의 보안 심사 | 비루트·capability 최소화·이미지 스캔 | [심화 — 컨테이너 보안 강화](/docker/notes/10-security-hardening) |
| 컨테이너 메모리 제한과 JVM·Node 힙 튜닝 | cgroup 이 실제로 세는 것 | [심화 — 컨테이너의 실체: namespace, cgroup, overlayfs](/docker/notes/08-internals-namespaces-cgroups) |
| 이미지 크기·풀 시간 줄이기 | 멀티스테이지, 작은 베이스 | [이미지 최적화와 보안](/docker/notes/06-optimization-security) |

**회사 규모에 따라**
- 스타트업: 단일 VM 이나 PaaS 에 이미지를 올리고 Compose 로 개발·소규모 운영까지 해결한다.
- 성장기: CI 에서 이미지를 빌드·스캔·서명해 레지스트리에 쌓고, 운영은 Kubernetes·ECS 같은 오케스트레이터로 옮긴다.
- 대규모 조직: 플랫폼 팀이 승인된 베이스 이미지·빌드 템플릿을 제공하고, 운영 노드에서는 Docker 데몬 대신 containerd 가 이미지를 실행한다.

**이럴 땐 안 맞는다**
- 다른 고객의 신뢰할 수 없는 코드를 돌리는 경우 — 커널을 공유하므로 gVisor·Firecracker 같은 더 강한 격리 경계를 쓴다.
- 데스크톱 GUI 앱이나 커널 모듈처럼 호스트 커널·하드웨어에 강하게 묶인 소프트웨어 — 패키지 설치나 VM 이 낫다.

**누가 매일 만나나** — 백엔드 개발자는 로컬 의존 서비스를 띄울 때, 플랫폼·SRE 는 CI 빌드 실패와 운영 컨테이너 재시작을 조사할 때 매일 만난다.

## 실습 체크리스트

- [ ] `docker top` 과 `docker exec ... ps` 로 같은 프로세스의 PID 가 안팎에서 다른 것 확인
- [ ] `docker info` 로 커널 버전·cgroup 버전·아키텍처 확인, 컨테이너 안 `uname -r` 과 비교
- [ ] `docker buildx imagetools inspect redis:8-alpine` 으로 아키텍처별 매니페스트 보기
- [ ] `docker system df` 로 디스크 사용량 확인
