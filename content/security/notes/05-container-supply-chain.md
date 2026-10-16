---
title: 컨테이너·공급망 보안 — 이미지 스캔, 최소 이미지, non-root, SBOM, 서명
order: 5
level: 중급
summary: "공급망 공격이 무엇이고 왜 늘어나는지(SolarWinds·xz·npm 타이포스쿼팅), 의존성 고정과 락파일·프로비넌스, trivy 로 이미지·파일시스템·IaC 스캔, Dockerfile 하드닝(핀 고정 베이스·multi-stage·non-root·읽기 전용 루트·capabilities 드롭), distroless/alpine 의 트레이드오프, SBOM(CycloneDX/SPDX) 생성과 활용, cosign 서명·검증과 SLSA, 런타임 보안(seccomp·AppArmor·Falco), 이 프로젝트 Dockerfile 점검"
tags: [공급망, trivy, SBOM, cosign, SLSA, Dockerfile, non-root, distroless, seccomp, Falco]
experiments: [sec-image-scan, sec-falco-runtime]
---

## 공급망 공격 — 내 코드가 아니라 내가 가져온 것

앱 이미지 하나에 **내 코드는 1%**, 나머지는 베이스 OS 패키지 수백 개 + npm 의존성 수천 개 + 빌드 도구 + CI 액션. 공격자는 그 99% 를 노린다.

| 사례 | 수법 | 교훈 |
|---|---|---|
| **SolarWinds (2020)** | 빌드 서버 침투 → 서명된 정식 업데이트에 백도어 | 서명은 "빌드가 깨끗했다" 를 증명하지 않는다 → 빌드 **프로비넌스**(SLSA) |
| **xz-utils (2024)** | 2년에 걸친 사회공학으로 메인테이너 권한 → sshd 백도어 | 메인테이너 한 명의 오픈소스에 전 세계가 의존. 배포 전 탐지는 거의 운 |
| **event-stream (2018)** | 인기 npm 패키지를 넘겨받아 암호화폐 지갑 탈취 코드 삽입 | 전이 의존성(transitive) 이 수천 개 |
| **타이포스쿼팅** | `lodahs`, `crossenv` 같은 이름으로 설치 유도, postinstall 스크립트 | `npm install` 은 코드 실행이다 (`--ignore-scripts`) |
| **Codecov (2021)** | CI 업로더 스크립트 변조 → 환경 변수(시크릿) 수집 | `curl | bash` 는 매번 다른 코드를 실행한다 → 체크섬·핀 고정 |
| **GitHub Actions `tj-actions/changed-files` (2025)** | 태그를 악성 커밋으로 옮김 → 러너의 시크릿 덤프 | 액션은 **커밋 SHA 로 고정** — [GHA 노트](/github-actions/notes/04-monorepo-release-security) |

## 의존성 — 고정하고, 검증하고, 줄인다

- **락파일 커밋 + `pnpm install --frozen-lockfile`**: 락파일에는 각 패키지의 **integrity 해시**(sha512)가 있어 레지스트리가 바꿔치기해도 설치가 실패한다.
- **버전 핀**: `^1.2.3` 은 락파일이 고정하지만, `pnpm update` 한 번에 수백 개가 바뀐다. Renovate/Dependabot 으로 **작게 자주** 올리고 CI 로 검증.
- **설치 스크립트**: `pnpm config set ignore-scripts true` 를 기본으로 하고 필요한 것만 허용(pnpm 10+ 는 기본 차단, `onlyBuiltDependencies`).
- **감사**: `pnpm audit`, `trivy fs --scanners vuln .`(package-lock/pnpm-lock 읽음), GitHub Dependabot alerts. 경고가 수백 개면 **직접 의존성·도달 가능 여부**로 걸러야 지속 가능하다.
- **프로비넌스**: npm 의 `--provenance`(Sigstore 로 "이 패키지는 이 저장소의 이 워크플로에서 빌드됐다" 증명). `npm audit signatures` 로 확인.
- **줄이기**: 의존성 하나 = 메인테이너 N 명을 신뢰. `left-pad` 급은 직접 쓴다. `pnpm why <pkg>` 로 왜 들어왔는지 추적.

## 이미지 스캔 — trivy

```bash
trivy image redis:8-alpine                              # OS 패키지 + 언어 의존성 취약점
trivy image --severity HIGH,CRITICAL --ignore-unfixed study:dev
trivy image --scanners secret,misconfig study:dev       # 레이어 안의 키, 설정 실수
trivy fs .                                              # 소스 트리(락파일, Dockerfile, k8s yaml, tf)
trivy config k8s/                                       # IaC 설정 검사 (privileged, runAsRoot…)
trivy image --format cyclonedx -o sbom.json study:dev   # SBOM
trivy sbom sbom.json                                    # SBOM 만으로 재스캔 (이미지 없이, 매일 cron)
```

- 스캐너는 **알려진 CVE** 와 **설치된 버전**을 대조한다. 설계 결함·로직 버그는 못 본다.
- `--ignore-unfixed`: 수정판이 없는 취약점은 내가 할 수 있는 게 없다(베이스 이미지 메인테이너의 몫). CI 게이트는 보통 "**수정판이 있는 HIGH/CRITICAL**" 만 막는다 — 실험 `sec-image-scan` 의 마지막 단계.
- 오탐·수용은 `.trivyignore` 에 **사유와 만료일**과 함께.
- **매일 재스캔**: 어제 깨끗한 이미지가 오늘 CRITICAL 이 된다(새 CVE 공개). 레지스트리 스캔(Harbor, ECR) 또는 SBOM 기반 cron.
- 대안: grype(+syft), Snyk, Docker Scout, Clair.

## Dockerfile 하드닝

이 프로젝트의 `Dockerfile` 을 기준으로:

```dockerfile
# 1. 베이스를 다이제스트로 고정 — 태그는 움직인다
FROM node:22-alpine@sha256:... AS builder
# 2. 빌드 도구는 builder 에만, 런타임엔 결과물만 (multi-stage)
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM node:22-alpine@sha256:...
ENV NODE_ENV=production
WORKDIR /app
# 3. 결과물만 복사, 소유자는 non-root
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# 4. non-root 로 실행 (node 이미지의 uid 1000)
USER node
EXPOSE 3000
# 5. HEALTHCHECK, 시그널 처리(tini 또는 Node 가 직접)
CMD ["node", "server.js"]
```

| 항목 | 왜 |
|---|---|
| **다이제스트 핀** | `node:22-alpine` 태그는 매주 바뀐다. 재현 불가 + 공급망 변조 창. Renovate 가 다이제스트도 갱신해 준다 |
| **multi-stage** | 컴파일러·devDependencies·소스가 런타임 이미지에 없음 → 공격 표면·크기 ↓ |
| **`.dockerignore`** | `.env`, `.git`, `node_modules` 가 `COPY . .` 로 들어가지 않게. **시크릿 유출 1위 경로** |
| **`USER` non-root** | 컨테이너 탈출·커널 취약점 시 호스트 root 가 되는 것을 막는 첫 방벽. 1000 번대 uid |
| **`--ignore-scripts`** | postinstall 공급망 공격 차단 |
| **빌드 시크릿** | `RUN --mount=type=secret,id=npmrc` — `ARG TOKEN` 은 이미지 히스토리에 남는다 |
| **레이블** | `org.opencontainers.image.source/revision` — 어디서 왔는지 추적 |

런타임(compose/k8s)에서 더:

```yaml
# k8s securityContext
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true          # 쓰기는 emptyDir 볼륨에만 (/tmp, .next/cache)
  capabilities: { drop: ["ALL"] }       # NET_BIND_SERVICE 가 필요하면 그것만 add
  seccompProfile: { type: RuntimeDefault }
```

`docker run --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000 ...` 이 같은 뜻. [Docker 하드닝 노트](/docker/notes/10-security-hardening) 가 각 플래그를 실험한다.

## 베이스 이미지 선택

| 베이스 | 크기 | 패키지 수(≈취약점 후보) | 디버깅 | 비고 |
|---|---|---|---|---|
| `node:22` (Debian) | ~1.1GB | 수백 | 쉬움 | 개발용 |
| `node:22-slim` | ~200MB | 수십 | 보통 | 균형 |
| `node:22-alpine` | ~130MB | 적음 | 보통 | musl — 일부 네이티브 모듈 호환 문제, DNS 동작 차이 |
| **distroless** (`gcr.io/distroless/nodejs22`) | ~130MB | **셸도 패키지 관리자도 없음** | 어려움(`:debug` 태그, 임시 컨테이너) | 공격자가 들어와도 할 수 있는 게 없다 |
| Chainguard/Wolfi | 작음 | 0-CVE 지향, 매일 재빌드 | 보통 | 유료 지원 |
| scratch | 0 | 0 | 없음 | Go 정적 바이너리 |

실험 `sec-image-scan` 의 표에서 패키지 수와 취약점 수의 상관을 본다. **셸이 없는 이미지**는 역방향 셸·`curl | sh` 식 2차 공격을 원천 차단한다 — Falco 의 "컨테이너에서 셸 실행" 알림이 아예 불가능해진다.

## SBOM — 무엇이 들어 있는지의 목록

SBOM(Software Bill of Materials)은 이미지/아티팩트의 **구성 요소 목록**(패키지명·버전·라이선스·해시)이다. 형식은 **CycloneDX** 와 **SPDX**.

```bash
trivy image --format cyclonedx -o sbom.cdx.json study:dev
syft study:dev -o spdx-json > sbom.spdx.json
jq '.components | length' sbom.cdx.json
jq '.components[] | select(.name=="next") | .version' sbom.cdx.json
```

쓸모:
- **새 CVE 가 나왔을 때** "우리 중 누가 log4j 를 쓰나" 를 이미지를 다시 풀지 않고 SBOM 검색으로 수 초 안에.
- 라이선스 준수(GPL 혼입 탐지).
- 규제(미국 행정명령 14028, EU CRA) 가 공급업체에 요구.
- 서명과 묶어 **증명(attestation)** 으로 레지스트리에 첨부: `cosign attest --predicate sbom.cdx.json --type cyclonedx study:dev`.

## 서명과 프로비넌스 — cosign 과 SLSA

**서명**: "이 다이제스트의 이미지는 우리가 만들었다". **프로비넌스**: "어떤 소스·빌더·워크플로에서 만들었다".

```bash
# keyless 서명 (Sigstore: OIDC 신원 + 투명성 로그 Rekor) — CI 에서
cosign sign ghcr.io/jaejinu/study@sha256:...
# 검증: 이 저장소의 main 브랜치 워크플로가 서명했는가
cosign verify ghcr.io/jaejinu/study@sha256:... \
  --certificate-identity-regexp 'https://github.com/jaejinu/study/.github/workflows/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

- **태그가 아니라 다이제스트**에 서명한다. 태그는 움직인다. 배포 매니페스트도 `image: study@sha256:...` 로.
- **SLSA 레벨**: L1 프로비넌스 존재 → L2 서명된 프로비넌스 → L3 격리된 빌더(변조 불가). GitHub 의 `actions/attest-build-provenance` 로 L3 급 프로비넌스를 쉽게.
- **클러스터에서 강제**: Kyverno `verifyImages` 또는 Sigstore policy-controller 가 "서명 없는 이미지는 Pod 생성 거부" — [06 노트](/security/notes/06-kubernetes-security) 의 어드미션.
- 레지스트리 자체도: 프라이빗, 풀 전용 토큰, 이미지 불변 태그(immutable tags).

## 런타임 보안 — 떠 있는 동안

| 계층 | 도구 | 하는 일 |
|---|---|---|
| 시스템 콜 필터 | **seccomp** (`RuntimeDefault`) | 300여 syscall 중 위험한 44개(`mount`, `ptrace`, `kexec`…) 차단 |
| 강제 접근 제어 | AppArmor / SELinux | 프로세스가 접근 가능한 파일·네트워크 프로파일 |
| 권한 | capabilities drop, no-new-privileges, non-root | setuid 바이너리·권한 상승 차단 |
| **탐지** | **Falco** (eBPF) | "컨테이너에서 셸이 떴다", "/etc/shadow 읽음", "예상 밖 아웃바운드 연결", "ptrace 시도" 를 **규칙**으로 알림 |
| 격리 강화 | gVisor, Kata, Firecracker | 커널 공유 자체를 줄임(멀티테넌트·신뢰 못 하는 코드) |

Falco 는 이 프로젝트의 관심사(관측)와 딱 맞는다: 이벤트를 JSON 으로 내보내 **Loki 에 넣고**, falco-exporter 로 **Prometheus 메트릭**(규칙별 카운트) → Alertmanager. `pnpm k8s:falco` 가 kind-study 에 Falco(modern eBPF 드라이버, Docker Desktop 의 6.12 커널에서 동작) + Falcosidekick 을 설치하고, 실험 `sec-falco-runtime` 이 web Pod 에서 `/etc/shadow` 읽기와 tty 셸 실행을 재현해 `Read sensitive file untrusted`·`Terminal shell in container` 이벤트를 Pod·네임스페이스·프로세스 트리 필드와 함께 보여 준다.

직접 설치해 보고 알게 된 것: kind 노드와 compose 컨테이너는 **같은 Docker Desktop 커널**을 쓰므로 kind 안의 Falco 가 `study-postgres` 의 healthcheck(`pg_isready` 가 perl 로 `/etc/shadow` 를 읽는다)까지 잡는다. eBPF 는 커널 단위라 '내 클러스터' 경계를 모른다. 운영에서 Falco 를 켜면 처음 며칠은 이런 **정상 노이즈를 예외 규칙으로 깎는 일**이 대부분이다 — 그게 바로 탐지 규칙의 튜닝 연습이다.

```yaml
# Falco 규칙 예
- rule: Terminal shell in container
  condition: spawned_process and container and shell_procs and proc.tty != 0
  output: "셸 실행 (user=%user.name container=%container.name cmd=%proc.cmdline)"
  priority: WARNING
```

## 예시로 보기 — 이 프로젝트 점검

| 항목 | 현재 | 판정 |
|---|---|---|
| 베이스 | `node:22-alpine` (태그) | 다이제스트 핀 권장 |
| multi-stage | 있음(builder → runtime standalone) | ✓ |
| non-root | `USER node` | ✓ (실험에서 `docker image inspect --format '{{.Config.User}}'` 로 확인) |
| `.dockerignore` | 확인 필요 — `.env*`, `.git`, `logs/` 포함 여부 | 점검 |
| 스캔 | CI 에 없음 | `aquasecurity/trivy-action` 추가, `--ignore-unfixed --severity CRITICAL --exit-code 1` |
| SBOM/서명 | 없음 | ghcr 푸시 시 cosign keyless + attest |
| k8s securityContext | `k8s/` 의 web Deployment 확인 | `runAsNonRoot`, `readOnlyRootFilesystem`(Next 는 `.next/cache` 쓰기 필요 → emptyDir), `drop ALL` |
| 런타임 | `pnpm k8s:falco` (Falco + Falcosidekick) | 실험 `sec-falco-runtime` 으로 알림 확인, 다음은 sidekick → Loki 출력 연결 |

`redis:8-alpine` 은 `USER` 가 비어 있어 **root 로 뜬다**(이미지 안에 `redis` 사용자는 있다). compose 에 `user: "999:1000"` 과 볼륨 권한을 맞추면 non-root 가 된다 — 실험이 이 점을 지적한다.

## 실습 체크리스트

- [ ] 실험 `sec-image-scan` 결과 표에서 CRITICAL 수와 수정판 비율, 실행 사용자 확인
- [ ] `trivy image --scanners secret study:dev` 와 `trivy config k8s/` 돌려 보기
- [ ] `Dockerfile` 의 베이스를 다이제스트로 핀 고정하고 `docker build` 가 같은 결과를 내는지 확인
- [ ] `.dockerignore` 에 `.env*`, `.git`, `logs` 가 있는지 보고 없으면 추가, `docker history` 로 레이어에 들어간 파일 확인
- [ ] `cosign sign --key`(로컬 키) 로 `study:dev` 에 서명하고 `cosign verify` 가 다이제스트 변경 시 실패하는지 보기
- [ ] CI 워크플로에 trivy 게이트 추가(처음엔 `--exit-code 0` 로 리포트만)
- [ ] (심화) kind 에 Falco 설치 → `docker exec`/`kubectl exec` 로 셸을 띄워 알림이 Loki/Grafana 에 보이는지
