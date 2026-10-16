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

## 실습 체크리스트

- [ ] `docker run --rm --cap-drop ALL redis:8-alpine redis-server --port 80` 이 실패하고 `--cap-add NET_BIND_SERVICE` 로 성공하는지
- [ ] `--read-only` 로 Redis 를 띄워 RDB 저장 실패를 보고 `--tmpfs /data` 로 해결
- [ ] `trivy image redis:8-alpine` 실행 (brew install trivy)
- [ ] 이 프로젝트 compose 의 Alloy 가 docker.sock 을 쓰는 이유와 대안 정리
