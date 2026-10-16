---
title: 심화 — 컨테이너 보안 강화
order: 10
level: 심화
summary: 위협 모델(이미지·런타임·호스트·공급망), rootless 와 user namespace, capabilities 최소화, seccomp/AppArmor, 읽기 전용 루트와 tmpfs, 시크릿 주입, 네트워크 격리, 이미지 스캔·서명·정책, 런타임 탐지(Falco), 컨테이너별 감사 체크리스트
tags: [보안, rootless, capabilities, seccomp, AppArmor, 시크릿, 서명, Falco]
experiments: [docker-container-lifecycle]
---

## 위협 모델

| 층 | 위협 | 예 |
|---|---|---|
| 이미지 | 취약한 패키지, 악성 베이스, 비밀 포함 | 오래된 openssl, `ENV API_KEY` |
| 런타임 | 컨테이너 탈출, 권한 상승, 다른 컨테이너 공격 | root + 위험 capability, docker.sock 마운트 |
| 호스트 | 데몬 API 노출, 커널 취약점 | `-H tcp://0.0.0.0:2375` |
| 공급망 | 변조된 이미지·의존성 | 태그 덮어쓰기, typosquatting |
| 데이터 | 볼륨·로그의 민감 정보 | 평문 비밀번호 |

**docker.sock 을 마운트한 컨테이너는 호스트 root 와 같다.** 이 프로젝트의 Alloy 가 로그 수집을 위해 `:ro` 로 마운트한다 — 읽기 전용 마운트라도 API 로 컨테이너 생성이 가능하므로 운영에선 로그 파일 경로 마운트나 docker-socket-proxy 를 쓴다.

## 비루트와 user namespace

```dockerfile
RUN addgroup -S app && adduser -S app -G app
USER app
```
```bash
docker run --user 1000:1000 …              # 실행 시 강제
docker run --userns-remap …                # 데몬 설정: 컨테이너 root → 호스트 비특권 UID
```
**Rootless Docker/Podman**: 데몬 자체가 일반 사용자로 실행 — 탈출해도 호스트 root 가 아니다. 1024 미만 포트·일부 스토리지 드라이버 제약.

## capabilities 최소화

root 라도 전능하지 않다. Docker 기본 집합(CHOWN, NET_BIND_SERVICE, KILL, SETUID …)에서 더 줄인다.

```bash
docker run --cap-drop ALL --cap-add NET_BIND_SERVICE nginx          # 80 포트만 필요
docker run --cap-drop ALL redis:8-alpine                             # Redis 는 아무것도 필요 없음
docker run --security-opt no-new-privileges …                        # setuid 로 권한 상승 금지
docker run --rm --cap-drop ALL alpine sh -c 'apk add -q libcap; capsh --print'
```
절대 주지 말 것: `SYS_ADMIN`(사실상 root), `--privileged`. CI 의 DinD 가 요구하면 Kaniko/BuildKit rootless 대안.

## seccomp · AppArmor

- **seccomp**: 시스템 콜 허용 목록. Docker 기본 프로파일이 `mount`, `reboot`, `kexec_load` 등 위험 콜을 막는다. `--security-opt seccomp=profile.json` 으로 더 좁힌다. `strace -c` 로 앱이 쓰는 콜을 수집해 프로파일 생성.
- **AppArmor/SELinux**: 파일·네트워크 접근 정책. 기본 `docker-default`. Kubernetes 는 `securityContext.appArmorProfile`.
- 강한 격리가 필요하면 gVisor(`--runtime=runsc`) — 커널 공격면 자체를 줄인다.

## 파일시스템과 시크릿

```bash
docker run --read-only --tmpfs /tmp --tmpfs /run -v data:/data app     # 루트 읽기 전용, 쓰기는 명시된 곳만
```
- 시크릿은 이미지·ENV 에 넣지 않는다. 런타임 파일 마운트(`/run/secrets`, Compose `secrets:`, Kubernetes Secret 볼륨) 또는 시크릿 관리자(Vault, KMS). ENV 는 `docker inspect`·자식 프로세스·크래시 덤프에 노출.
- 빌드 시 비밀은 `--mount=type=secret` ([BuildKit 노트](/docker/notes/09-buildkit-multiplatform)).
- 로거에서 마스킹 ([로그 노트](/observability/notes/05-logging-loki)).

## 네트워크 격리

- 컨테이너 간 통신은 **필요한 것만**: 사용자 정의 네트워크를 서비스 묶음별로, DB 는 앱 네트워크에만.
- `-p 127.0.0.1:…` 로 호스트 루프백에만 공개(이 프로젝트의 모든 포트). `0.0.0.0` 공개는 Docker 가 iptables 규칙을 직접 넣어 호스트 방화벽을 우회할 수 있다.
- `--icc=false` 로 기본 브리지 컨테이너 간 통신 차단. 송신 제한은 egress 프록시 또는 NetworkPolicy ([k8s 네트워크 노트](/kubernetes/notes/12-network-policy-mesh)).

## 이미지 공급망

1. 신뢰할 수 있는 베이스(공식/검증 퍼블리셔, distroless/chainguard 같은 최소 이미지).
2. 다이제스트 고정 + 자동 갱신 PR.
3. CI 스캔: `trivy image --severity HIGH,CRITICAL --exit-code 1`.
4. 서명(cosign) 과 배포 시 검증 정책(Kyverno `verifyImages`).
5. SBOM 보관 — 취약점 공개 시 영향 범위 즉시 파악.
6. 레지스트리: push 는 CI 만, 태그 불변(immutable tags).

## 런타임 탐지

- **Falco**: eBPF 커널 이벤트로 "컨테이너에서 셸 실행", "민감 파일 읽기", "예상 밖 아웃바운드" 탐지.
- 감사: `docker events`, Kubernetes audit log, 호스트 auditd.
- 이상 징후 메트릭: 재시작, 새 프로세스, CPU 급증(크립토마이닝).

## 체크리스트 (컨테이너 하나마다)

- [ ] 비루트 사용자, `no-new-privileges`
- [ ] `--cap-drop ALL` + 필요한 것만
- [ ] 읽기 전용 루트 + tmpfs
- [ ] 메모리·CPU·PID 제한(`--pids-limit`)
- [ ] 포트는 루프백/내부 네트워크만
- [ ] 시크릿은 파일/관리자, ENV 금지
- [ ] 최소 베이스, 다이제스트 고정, 스캔 통과, 서명
- [ ] docker.sock·`--privileged` 없음
- [ ] 로그에 비밀 없음

## seccomp 프로파일은 실제로 무엇을 막나

Docker 기본 seccomp 프로파일은 **허용 목록** 방식으로 300여 개 시스템 콜 중 위험한 40~50개를 막는다.

| 막히는 호출(일부) | 왜 위험한가 |
|---|---|
| `mount`, `umount2`, `pivot_root` | 파일시스템 재구성 → 탈출 경로 |
| `kexec_load`, `reboot` | 호스트 커널 교체·재부팅 |
| `bpf`, `perf_event_open` | 커널 안 코드 실행·관측(특권 도구 전용) |
| `ptrace` | 다른 프로세스 메모리 조작 |
| `unshare`(일부 플래그), `setns` | 새 네임스페이스·다른 네임스페이스 진입 |
| `keyctl`, `add_key` | 커널 키링 — 네임스페이스화 안 됨 |

```bash
docker run --rm alpine unshare --map-root-user --user sh -c 'id'
# unshare: unshare(0x10000000): Operation not permitted   ← seccomp 가 막음
docker run --rm --security-opt seccomp=unconfined alpine unshare --map-root-user --user sh -c 'id'
# uid=0(root) ...                                         ← 해제하면 됨 (하지 말 것)
```

eBPF·perf 실험이 `--privileged` 를 요구하는 이유가 바로 `bpf`·`perf_event_open` 이 막혀 있기 때문이다. 그래서 그런 실험 컨테이너는 **실험 중에만, 일회용(`--rm`)으로** 띄운다 — [eBPF 란](/ebpf/notes/01-what-is-ebpf).

### 프로파일 좁히기 절차

1. 앱을 평소처럼 돌리며 쓰는 시스템 콜을 수집한다: `strace -f -c`, 또는 eBPF 로 `tracepoint:raw_syscalls:sys_enter` 집계.
2. 그 목록만 허용하는 JSON 프로파일을 만든다(`defaultAction: SCMP_ACT_ERRNO`).
3. 스테이징에서 `SCMP_ACT_LOG` 로 먼저 돌려 빠진 호출을 찾는다.
4. Kubernetes 에서는 `securityContext.seccompProfile: { type: Localhost, localhostProfile: ... }` 또는 Security Profiles Operator.

## 컨테이너 탈출의 대표 경로와 차단

| 경로 | 조건 | 차단 |
|---|---|---|
| docker.sock 마운트 | 소켓 접근 | 마운트 금지, docker-socket-proxy 로 API 제한 |
| `--privileged` | 모든 capability·장치 | 금지, 필요한 cap 만 |
| `SYS_ADMIN` cap | mount 등 | 금지 |
| 호스트 경로 마운트(`/`, `/etc`, `/var/run`) | 쓰기 권한 | 최소 경로 + `:ro` |
| `--pid=host` / `--net=host` | 호스트 프로세스·네트워크 접근 | 관측 도구 외 금지 |
| 커널 취약점 | 비패치 커널 | 커널 업데이트, gVisor·Kata |
| root + 쓰기 가능 루트 FS | 바이너리 변조 | 비루트, `--read-only` |

Kubernetes 에서는 이 목록이 **Pod Security Standards(restricted)** 로 한 번에 강제된다 — [Kubernetes 보안](/security/notes/06-kubernetes-security).

## Rootless 의 실제 동작

Rootless Docker 는 **user namespace** 로 컨테이너의 UID 0 을 호스트의 내 UID(예: 501)에, 컨테이너 UID 1~65535 를 `/etc/subuid` 범위(예: 100000~165535)에 매핑한다.

```
컨테이너 안            호스트
UID 0     (root)  →   UID 501   (나)
UID 999   (redis) →   UID 100998
```

탈출해도 호스트에서는 일반 사용자다. 대가:
- 1024 미만 포트 바인드 불가(`net.ipv4.ip_unprivileged_port_start` 조정 가능).
- overlay 대신 fuse-overlayfs 등으로 I/O 가 느릴 수 있다.
- 네트워크가 slirp4netns/pasta 로 처리되어 처리량이 낮다.

## 보안 감사 자동화

```bash
# 실행 중인 컨테이너의 위험 설정 한 번에 훑기
docker ps -q | xargs docker inspect -f \
'{{.Name}} priv={{.HostConfig.Privileged}} user={{.Config.User}} ro={{.HostConfig.ReadonlyRootfs}} caps+={{.HostConfig.CapAdd}} pidmode={{.HostConfig.PidMode}} binds={{.HostConfig.Binds}}'
```

| 도구 | 하는 일 |
|---|---|
| `docker bench security` | CIS Docker Benchmark 항목 점검(데몬·호스트·컨테이너) |
| `trivy config`, `hadolint` | Dockerfile·compose 의 나쁜 설정 정적 검사 |
| `trivy image`, `docker scout` | 이미지 CVE |
| Falco | 런타임 이상 행위 |

## 예시로 보기 — 이 프로젝트 컨테이너 감사 결과

위 `inspect` 명령을 이 프로젝트의 compose 서비스에 돌리면 대략 이렇게 나온다.

| 컨테이너 | 사용자 | 특이 설정 | 평가 |
|---|---|---|---|
| study-redis | 빈 값(이미지 기본) | 설정 `:ro`, 포트 루프백 | redis 이미지는 엔트리포인트가 redis 사용자로 강등 — 실제 프로세스는 999 |
| study-alloy | root | **docker.sock 마운트** | 로그 수집 때문. 운영이면 socket-proxy 나 파일 경로 수집 |
| study-grafana | 472 | 익명 Admin 허용 | 로컬 전용이라 허용, 운영 금지 |
| study-web(app) | node(1000) | HEALTHCHECK | 양호, `--read-only` 는 미적용 |
| 실험용 `study-bpftrace`, `study-os-tools` | root | `--privileged --pid=host` | 실험 중에만, `--rm` 일회용 |

마지막 줄은 의도된 예외다. 특권 컨테이너는 Falco 의 "특권 컨테이너 실행" 규칙에 걸리는 것이 정상이고, 그 알림을 보고 "이건 실험이다" 라고 판단할 수 있어야 한다 — 실험 `sec-falco-runtime`.

## 운영·관측 포인트

- 보안 설정 위반은 배포 전에 막는다: CI 의 `hadolint`·`trivy config`, 클러스터의 어드미션(Kyverno·PSA).
- 런타임 신호: Falco 알림, `docker events` 의 `exec_start`(누가 운영 컨테이너에 exec 했나), 예상 밖 아웃바운드 연결.
- 예외(특권·호스트 마운트)는 **목록으로 관리**하고 이유·소유자를 적는다. 예외가 늘어나는 것 자체가 지표다.

## 실습 체크리스트

- [ ] `docker run --rm --cap-drop ALL redis:8-alpine redis-server --port 80` 이 실패하고 `--cap-add NET_BIND_SERVICE` 로 성공하는지
- [ ] `--read-only` 로 Redis 를 띄워 RDB 저장 실패를 보고 `--tmpfs /data` 로 해결
- [ ] `trivy image redis:8-alpine` 실행 (brew install trivy)
- [ ] 이 프로젝트 compose 의 Alloy 가 docker.sock 을 쓰는 이유와 대안 정리
- [ ] 기본 seccomp 에서 `unshare --user` 가 막히는 것 확인(해제 비교는 일회용 컨테이너에서만)
- [ ] 위 `docker inspect` 감사 명령을 이 프로젝트 컨테이너에 돌려 표 채우기
- [ ] `hadolint Dockerfile` 로 이 프로젝트 Dockerfile 정적 검사
