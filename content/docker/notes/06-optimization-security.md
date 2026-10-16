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
