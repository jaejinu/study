---
title: 이미지 최적화와 보안
order: 6
level: 중급
summary: 작은 베이스 이미지, 레이어 줄이기, 비루트 사용자, 비밀값 다루기, 취약점 스캔
tags: [alpine, distroless, 보안, non-root, secrets, scan]
experiments: [docker-image-layers]
---

## 작게 만들기

| 베이스 | 크기 | 특징 |
|---|---|---|
| `ubuntu:24.04` | ~78MB | 익숙한 도구, 큼 |
| `debian:bookworm-slim` | ~75MB | glibc, 호환성 좋음 |
| `node:22-slim` | ~200MB | Node 포함 debian-slim |
| `node:22-alpine` | ~130MB | musl libc. 네이티브 모듈 호환 주의 |
| `gcr.io/distroless/nodejs22` | ~130MB | 셸 없음. 디버깅 어렵지만 공격면 최소 |
| `scratch` | 0 | 정적 바이너리(Go, Rust)용 |

크기를 줄이는 방법:
1. **멀티스테이지**로 빌드 도구 제외 (가장 효과 큼).
2. `.dockerignore` 로 불필요한 파일 제외.
3. 패키지 매니저 캐시 삭제: `apk add --no-cache`, `apt-get install ... && rm -rf /var/lib/apt/lists/*`.
4. 개발 의존성 제외: `pnpm install --prod`, `npm ci --omit=dev`.
5. 레이어 분석: `docker image history`, 또는 `dive` 도구.

```bash
brew install dive
dive study:dev          # 레이어별 파일 변화와 낭비 공간 시각화
```

## 비루트로 실행

컨테이너 안의 root 는 커널을 공유하므로 탈출 취약점이 있으면 호스트 root 가 된다.

```dockerfile
# 공식 node 이미지에는 node 사용자(UID 1000)가 있다
RUN chown -R node:node /app
USER node
```
```bash
docker run --user 1000:1000 ...             # 실행 시 지정
docker run --read-only --tmpfs /tmp ...     # 루트 파일시스템 읽기 전용
docker run --cap-drop ALL --cap-add NET_BIND_SERVICE ...   # 권한 최소화
docker run --security-opt no-new-privileges ...
```

## 비밀값

- 이미지에 **절대** 비밀값을 넣지 말 것. `ENV API_KEY=...`, `COPY .env` 는 레이어에 영구히 남는다 (`docker history` 로 보인다).
- 런타임 주입: `-e`, `--env-file`, Compose `secrets:`, 오케스트레이터의 secret.
- 빌드 중에만 필요한 값(사설 레지스트리 토큰): `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install` — 레이어에 남지 않는다.

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t app .
```

## 취약점 스캔과 서명

```bash
docker scout cves study:dev              # Docker Scout
trivy image redis:8-alpine               # Aqua Trivy (brew install trivy)
```

- 베이스 이미지를 주기적으로 갱신하고 재빌드한다. 태그를 고정했더라도 같은 태그에 패치가 올라온다 (`docker pull` 필요).
- 공급망: 다이제스트 고정, 공식/검증된 퍼블리셔 이미지 사용, `cosign` 으로 서명 검증.

## 헬스체크

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
```

`docker ps` 의 STATUS 에 `(healthy)` 로 표시되고, Compose `depends_on.condition` 과 오케스트레이터가 이 상태로 트래픽을 제어한다.

## 리소스 제한

```bash
docker run --memory 512m --memory-swap 512m --cpus 1.5 ...
```

메모리 제한을 넘으면 OOM kill 된다. Node 는 컨테이너 제한을 자동 인식하지 못할 수 있으니 `--max-old-space-size` 를 맞춘다. Redis 는 `maxmemory` 를 컨테이너 제한보다 작게.

## 체크리스트

- [ ] 멀티스테이지 + `.dockerignore`
- [ ] 태그 고정 (`:22-alpine`, 가능하면 다이제스트)
- [ ] `USER` 비루트
- [ ] 비밀값은 런타임 주입, 빌드 시엔 `--mount=type=secret`
- [ ] `HEALTHCHECK` 정의
- [ ] 스캔 도구를 CI 에

## 크기 줄이기 — 실제 숫자로

같은 Next.js 앱을 단계적으로 줄였을 때의 전형적인 흐름이다(이 프로젝트 `study:dev` 기준 근사값).

| 단계 | 이미지 크기 | 바뀐 것 |
|---|---|---|
| `FROM node:22` + `COPY . .` + `pnpm install` + `pnpm build` | ~2.1GB | 베이스·devDependencies·소스·`.next/cache`·`.git` 전부 |
| `.dockerignore` 추가 | ~1.6GB | `.git`, `node_modules`(호스트), `.next` 제외 |
| `node:22-alpine` 베이스 | ~1.1GB | Debian → musl |
| 멀티스테이지 + `output: "standalone"` | ~250MB | 런타임에 필요한 파일만 |
| `--prod` 의존성만 / standalone 추적 | ~180MB | 추적되지 않은 패키지 제거 |
| distroless 런타임 | ~160MB | 셸·패키지 매니저 제거 |

가장 큰 효과는 언제나 **멀티스테이지**다. 나머지는 수십 MB 단위의 다듬기다. 크기는 곧 **풀 시간**(배포·오토스케일 속도)이고 **공격면**(CVE 수)이다. `trivy image` 로 각 단계의 취약점 수를 같이 세 보면 줄어드는 정도가 크기보다 더 극적이다 — [컨테이너·공급망 보안](/security/notes/05-container-supply-chain) 의 실험 `sec-image-scan`.

## 왜 비루트인가 — 탈출 시나리오로 보기

컨테이너 안의 root(UID 0)는 user namespace 를 쓰지 않는 한 **호스트의 UID 0 과 같은 숫자**다. 커널은 숫자로 권한을 판단한다.

```
시나리오: 이미지에 root 로 도는 웹앱, 원격 코드 실행 취약점
1) 공격자가 컨테이너 안에서 셸 획득 (UID 0)
2) 볼륨으로 마운트된 호스트 디렉터리에 쓰기 → 호스트 파일 변조 (UID 0 이라 권한 통과)
3) 커널 취약점(예: 과거 Dirty Pipe)으로 네임스페이스 탈출 → 호스트 root
비루트(UID 1000)였다면: 2) 는 디렉터리 권한에 막히고, 3) 은 훨씬 어려움
```

| 설정 | 막아 주는 것 | 비용 |
|---|---|---|
| `USER 1000` | 파일 권한 우회, 많은 권한 상승 경로 | 1024 미만 포트 바인드 불가(앱은 3000 등 사용) |
| `--cap-drop ALL` | raw 소켓, chown, 마운트 등 | 필요한 것만 다시 add |
| `no-new-privileges` | setuid 바이너리로 권한 재획득 | 거의 없음 |
| `--read-only` | 실행 파일 변조·웹셸 설치 | 쓰기 경로를 tmpfs/볼륨으로 명시 |
| `--pids-limit 200` | fork 폭탄 | 정상 프로세스 수 산정 |

이 옵션들의 내부 원리(capability, seccomp, no_new_privs)는 [운영체제 내부 — 컨테이너는 결국 프로세스](/os-internals/notes/07-containers-are-processes), 정책 강제는 [컨테이너 보안 강화](/docker/notes/10-security-hardening).

## 비밀값이 이미지에 남는 경로 4가지

| 실수 | 왜 남나 | 확인 | 대신 |
|---|---|---|---|
| `ENV API_KEY=...` | 이미지 config 에 저장 | `docker image inspect -f '{{.Config.Env}}'` | 런타임 `-e`/시크릿 파일 |
| `COPY .env .` 후 `RUN rm .env` | 이전 레이어에 그대로 | `docker save` 후 레이어 tar 열기 | `.dockerignore` 에 `.env*` |
| `ARG NPM_TOKEN` 으로 넘김 | `docker history` 에 보임 | `docker history --no-trunc` | `RUN --mount=type=secret` |
| `RUN git clone https://user:token@...` | 명령 문자열이 history 에 | `docker history --no-trunc` | `--mount=type=ssh` |

```bash
docker history --no-trunc study:dev | grep -iE "token|password|secret|key=" || echo "no obvious secrets"
```

비밀값이 한 번이라도 레지스트리에 푸시됐다면 **이미지를 지워도 끝이 아니다**. 누가 이미 받았을 수 있으므로 비밀값 자체를 **회전**해야 한다 — [시크릿 관리](/security/notes/04-secrets-management).

## 리소스 제한과 런타임 인식

컨테이너에 `--memory 512m` 을 줘도 프로세스가 그걸 알아서 맞추는 것은 아니다. 런타임마다 cgroup 을 읽는 방식이 다르다.

| 런타임 | cgroup 메모리 인식 | 권장 |
|---|---|---|
| Node.js 20+ | 힙 기본 상한을 cgroup 기준으로 일부 반영 | `--max-old-space-size` 를 제한의 70~75% 로 명시 |
| JVM 10+ | 자동 인식(`UseContainerSupport`) | `-XX:MaxRAMPercentage=75` |
| Go 1.19+ | GC 목표 메모리 수동(`GOMEMLIMIT`) | `GOMEMLIMIT` 와 `GOMAXPROCS`(또는 automaxprocs) |
| Redis | 인식 안 함 | `maxmemory` 를 제한보다 확실히 작게(fork 여유 포함) |
| Python | 인식 안 함 | 워커 수·배치 크기로 조절 |

CPU 도 같다. `--cpus 1` 인데 앱이 `nproc`(호스트 코어 수, 예: 10)을 보고 스레드 10개를 만들면 **CFS 스로틀링**으로 p99 가 튄다. 실험 `os-cgroup-limits` 에서 `--cpus=0.5` 컨테이너가 측정한 거의 모든 주기에서 스로틀된 것을 확인할 수 있다 — [스케줄러와 cgroup](/os-internals/notes/03-scheduler-cgroups).

## 예시로 보기 — 이 프로젝트 이미지 점검표

| 항목 | 현재 `Dockerfile` | 판정 |
|---|---|---|
| 멀티스테이지 | builder → runtime | ✓ |
| 베이스 | `node:22-alpine` 태그 | 다이제스트 고정은 미적용 |
| `.dockerignore` | `.git`, `node_modules`, `.next`, `.env*` 제외 | ✓ |
| 비루트 | `USER node` | ✓ |
| HEALTHCHECK | `wget` 로 `/` | ✓ (단, `/` 는 무거운 페이지 — 가벼운 `/api/health` 권장) |
| 비밀값 | 없음(런타임 `REDIS_URL` 환경 변수) | ✓ |
| 읽기 전용 루트 | 미적용 | Next 는 `.next/cache` 쓰기 필요 → tmpfs 로 가능 |
| 스캔 | CI 에 없음 | `trivy image --exit-code 1 --severity CRITICAL` 추가 후보 |

```bash
docker run --rm --read-only --tmpfs /app/.next/cache --tmpfs /tmp -p 127.0.0.1:3201:3000 \
  -e REDIS_URL=redis://host.docker.internal:6379 study:dev
```

## 운영·관측 포인트

- 레지스트리별 이미지 크기·풀 시간 추이를 본다. 갑자기 커지면 누군가 `.dockerignore` 를 깼다.
- `docker scout quickview` / `trivy` 결과를 CI 아티팩트로 남겨 **베이스 갱신 PR** 의 근거로 쓴다.
- 운영 이미지는 **불변 태그**(덮어쓰기 금지) + 다이제스트 배포. 같은 태그가 다른 내용을 가리키면 롤백이 거짓말이 된다.

## 실습 체크리스트

- [ ] 같은 앱으로 위 "크기 줄이기" 표의 단계 2~4개를 직접 재현해 크기·`trivy` 취약점 수를 함께 기록
- [ ] `docker history --no-trunc` 와 `image inspect` 로 비밀값 노출 경로 4가지 중 하나를 일부러 만들어 찾아보기
- [ ] `--read-only --tmpfs /app/.next/cache` 로 `study:dev` 실행
