---
title: "심화 — 운영과 보안: graceful shutdown, 권한 모델, 의존성 공급망, 시크릿, Next.js 서버 운영"
order: 14
level: 심화
chapter: "4부 · 병렬성·성능·운영"
summary: "SIGTERM 에 아무 처리를 하지 않으면 진행 중이던 요청이 끊기고(종료 코드 143, 응답 없음) server.close 로 기다리면 끝까지 응답한다는 실측과 쿠버네티스 종료 순서(preStop·readiness·grace period), 종료 코드의 의미(0·1·134·137·143), Node 권한 모델 --permission 으로 파일 읽기·쓰기·자식 프로세스가 ERR_ACCESS_DENIED 로 막히는 실측, npm 공급망 위험(설치 스크립트·타이포스쿼팅·의존성 혼동)과 락파일·감사·자동 업데이트, 환경 변수와 시크릿, 프로덕션 설정(NODE_ENV·힙·non-root), Next.js standalone 서버 운영 체크리스트"
tags: [graceful shutdown, SIGTERM, 종료 코드, 권한 모델, permission, 공급망, npm, 시크릿, 운영, Next.js]
experiments: []
---

## SIGTERM — 끊긴 요청 vs 끝까지 처리 — 실측

배포·스케일 인·노드 교체 때 프로세스는 **SIGTERM** 을 받는다. Node 의 기본 동작은 **즉시 종료**다.

```js
// gs.cjs — 요청 하나 처리에 1초
const srv = http.createServer((q, r) => setTimeout(() => r.end("done"), 1000)).listen(18998);
if (graceful) process.on("SIGTERM", () => {
  srv.close(() => process.exit(0));          // 새 연결 거부, 진행 중 요청은 끝날 때까지 기다림
  srv.closeIdleConnections();                 // 유휴 keep-alive 연결은 바로 닫기
  setTimeout(() => process.exit(1), 10_000).unref();   // 그래도 안 끝나면 10초 뒤 강제
});
```

요청을 보내고 0.2초 뒤 `kill -TERM` 을 보낸 결과:

| 모드 | 진행 중이던 요청 | 종료 코드 |
|---|---|---|
| 처리 없음 | **응답 없음** (`http=000`, 연결 끊김) | **143** (128 + SIGTERM 15) |
| graceful | **200 "done"** | 0 |

배포할 때마다 진행 중이던 요청이 끊긴다면 이것이 원인이다.

### graceful shutdown 의 순서

```js
let shuttingDown = false;
process.on("SIGTERM", async () => {
  if (shuttingDown) return; shuttingDown = true;
  setReady(false);                         // 1. readiness 를 실패로 → 로드밸런서가 새 트래픽을 그만 보냄
  await sleep(5_000);                      // 2. LB·kube-proxy 가 엔드포인트를 지울 시간
  server.close();                          // 3. 새 연결 거부, 진행 중 요청 완료 대기
  server.closeIdleConnections();
  await Promise.allSettled([queue.drain(), redis.quit(), pg.end()]);   // 4. 백그라운드 작업·연결 정리
  process.exit(0);
});
```

**쿠버네티스에서의 함정:** Pod 삭제 시 "엔드포인트에서 제거" 와 "SIGTERM 전송" 이 **동시에** 일어난다. SIGTERM 을 받자마자 닫으면, 아직 엔드포인트 목록을 갱신하지 못한 kube-proxy·Ingress 가 몇 초간 계속 요청을 보내 502 가 난다. 그래서 `preStop: sleep 5` 또는 위 2단계의 대기를 둔다. 전체는 `terminationGracePeriodSeconds`(기본 30초) 안에 끝나야 하고, 넘으면 SIGKILL(137). [네트워크 프로토콜 06 연결 드레이닝](/network-protocols/notes/06-load-balancing-cdn), [장애 실험실](/chaos) 의 Pod kill 실험이 같은 이야기다.

## 종료 코드 읽기

| 코드 | 의미 | 흔한 원인 |
|---|---|---|
| 0 | 정상 | |
| 1 | 처리되지 않은 예외·거부 | [04](/nodejs/notes/04-async-patterns-errors) 의 unhandledRejection |
| 134 | SIGABRT | **V8 힙 OOM** (FATAL ERROR — [10](/nodejs/notes/10-gc-heap) 에서 재현) |
| 137 | SIGKILL | **컨테이너 메모리 초과(OOMKilled)**, grace period 초과 |
| 143 | SIGTERM | 종료 처리기가 없음 |

134 와 137 은 둘 다 "메모리" 지만 대처가 다르다: 134 는 힙 상한 또는 누수, 137 은 컨테이너 한도·힙 밖 메모리·힙 상한 설정 누락.

## 권한 모델 — 실측

Node 20+ 의 `--permission` 은 프로세스가 할 수 있는 일을 허용 목록으로 제한한다(Node 22 에서 안정화 단계).

```bash
$ node --permission --allow-fs-read="$PWD/*" -e '
  try { fs.readFileSync("/etc/hosts") } catch (e) { console.log("읽기:", e.code) }
  try { fs.writeFileSync("x.txt", "a") } catch (e) { console.log("쓰기:", e.code) }
  try { require("child_process").execSync("ls") } catch (e) { console.log("자식:", e.code) }
  console.log("has fs.write?", process.permission.has("fs.write"))'
읽기: ERR_ACCESS_DENIED          # 허용 경로 밖
쓰기: ERR_ACCESS_DENIED          # 쓰기는 허용 안 함
자식: ERR_ACCESS_DENIED          # 자식 프로세스 금지
has fs.write? false
```

| 플래그 | 허용 |
|---|---|
| `--allow-fs-read=<경로>` / `--allow-fs-write=<경로>` | 파일 |
| `--allow-child-process` | 자식 프로세스 |
| `--allow-worker` | 워커 스레드 |
| `--allow-addons`, `--allow-wasi` | 네이티브 애드온, WASI |

한계: 네트워크는 아직 제한하지 않고, 이미 열린 파일 디스크립터·심볼릭 링크 등 우회 여지가 있다. **보안 경계라기보다 심층 방어 한 겹**이다 — 신뢰할 수 없는 코드는 컨테이너·샌드박스로 격리한다([보안 01](/security/notes/01-security-mindset-threat-modeling)).

## 의존성 공급망

`node_modules` 의 수백 개 패키지는 모두 **여러분 프로세스의 권한으로** 실행된다.

| 위협 | 예 | 방어 |
|---|---|---|
| 설치 스크립트 | `postinstall` 이 설치 시 임의 코드 실행 | `npm ci --ignore-scripts`, pnpm 의 `onlyBuiltDependencies` 허용 목록 |
| 타이포스쿼팅 | `expresss`, `cross-env` 대신 `crossenv` | 추가 시 이름 확인, 다운로드 수·유지자 확인 |
| 계정 탈취 | 인기 패키지 유지자 토큰 유출 → 악성 버전 | 락파일 고정, 자동 업데이트에 지연(쿨다운), 출처 증명(provenance) |
| 의존성 혼동 | 사내 패키지 이름을 공개 레지스트리에 선점 | 스코프(`@company/x`) + 레지스트리 고정 |
| 알려진 취약점 | 오래된 버전 | `npm audit`/`pnpm audit`, trivy, 자동 업데이트 PR |

**락파일은 필수**다(`pnpm-lock.yaml`·`package-lock.json`). CI 는 `pnpm install --frozen-lockfile`(=`npm ci`)로 락파일과 다르면 실패하게 한다. 이미지·SBOM·서명은 [보안 05 공급망](/security/notes/05-container-supply-chain).

## 환경 변수와 시크릿

| 하지 말 것 | 이유 |
|---|---|
| 시크릿을 코드·이미지에 넣기 | 이미지 레이어·git 기록에 영원히 남는다 |
| `console.log(process.env)` | 로그 시스템으로 시크릿이 흘러간다 |
| `.env` 를 커밋 | `.env.example` 만 커밋하고 실제 값은 시크릿 관리자에서 |
| 클라이언트 번들에 서버 시크릿 | Next.js 는 `NEXT_PUBLIC_` 접두어 변수만 브라우저로 — 실수로 붙이면 공개된다 |

Node 20.6+ 는 `node --env-file=.env app.js` 로 dotenv 없이 읽는다. 운영에서는 쿠버네티스 Secret·외부 시크릿 관리자에서 주입한다([보안 04](/security/notes/04-secrets-management)). 시크릿 회전 시 프로세스가 재시작 없이 새 값을 읽어야 한다면 환경 변수가 아니라 파일 마운트·API 로 받아야 한다.

## 프로덕션 설정 체크리스트

| 항목 | 값 | 이유 |
|---|---|---|
| `NODE_ENV=production` | | 프레임워크·라이브러리가 개발용 검사·경고를 끔 |
| `--max-old-space-size` | 컨테이너 한도의 70~75% | 134 대신 예측 가능한 동작, 137 방지 |
| `--enable-source-maps` | TS·번들 앱 | 에러 스택이 원본 줄을 가리킴 (약간의 비용) |
| non-root 사용자 | `USER node` | 탈출 시 피해 축소 |
| 처리되지 않은 거부 | 기본 `throw` 유지 | 망가진 상태로 계속 돌지 않게 |
| 이벤트 루프 지연·힙·GC 메트릭 | prom-client 기본 메트릭 | [13](/nodejs/notes/13-profiling-diagnostics) |
| keep-alive 타임아웃 | LB 보다 길게 | 502 방지 ([07](/nodejs/notes/07-network-http)) |
| SIGTERM 처리 | 위 순서 | 배포 중 요청 유실 방지 |
| `--inspect` | 운영에서 끄거나 127.0.0.1 만 | 원격 코드 실행 |

## 예시로 보기 — 이 프로젝트에서

- **Dockerfile.** 런타임 단계가 `FROM node:22-alpine`, `ENV NODE_ENV=production`, `USER node`, `CMD ["node", "server.js"]`(Next.js standalone 서버)다. `node` 를 직접 PID 1 로 실행하므로 SIGTERM 을 Node 가 받는다 — `npm start` 로 감싸면 npm 이 신호를 제대로 전달하지 않는 문제가 있었다. 다만 PID 1 은 좀비를 거두지 않으니 자식 프로세스를 많이 띄우는 앱이라면 `--init`(tini)을 쓴다([Docker 08](/docker/notes/08-internals-namespaces-cgroups)).
- **개선 여지 두 가지.** `k8s/web.yaml` 은 `limits: { memory: 512Mi }` 지만 `--max-old-space-size` 가 없고, `preStop` 도 없다. 이 노트의 체크리스트대로 `NODE_OPTIONS=--max-old-space-size=384` 와 `lifecycle.preStop: { exec: { command: ["sleep", "5"] } }` 를 넣는 것이 다음 단계다. readiness/liveness 가 둘 다 `/`(노트 렌더링 페이지)를 보는데, 무거운 페이지 대신 가벼운 전용 헬스 경로가 낫다.
- **공급망 방어는 CI 에 있다.** `.github/workflows/ci.yml` 의 security 잡이 actionlint(SHA 고정 액션)와 trivy(취약점·시크릿, 실패 조건)를 돌리고, `.github/dependabot.yml` 이 npm 의존성 업데이트 PR 을 만든다. CI 설치는 `pnpm install --frozen-lockfile` 이다.
- **시크릿.** `.env.example` 만 저장소에 있고, OpenAI 키는 환경 변수로만 들어온다(`src/lib/assistant/openai.ts` 의 `process.env.OPENAI_API_KEY`). 서버 라우트에서만 읽고 `NEXT_PUBLIC_` 이 아니므로 브라우저로 가지 않는다.
- **실험이 만든 자식 프로세스.** 장애 실험의 데드맨 스위치(`src/lib/deadman.ts`)는 서버가 SIGTERM 으로 내려가도 살아남도록 detached 로 만든다 — 종료 처리와 "원복은 반드시" 사이의 균형이다.

## 실습 체크리스트

- [ ] 위 `gs.cjs` 로 SIGTERM 처리 유무에 따른 진행 중 요청 결과와 종료 코드 비교
- [ ] `--permission` 으로 파일 읽기·쓰기·자식 프로세스가 막히는 것 확인
- [ ] `pnpm audit` 와 `pnpm why <패키지>` 로 이 저장소의 취약 의존성과 경로 찾기
- [ ] `node --env-file=.env.example -e 'console.log(process.env.REDIS_URL)'`
- [ ] `k8s/web.yaml` 에 `preStop` 과 `NODE_OPTIONS` 를 넣고 롤링 배포 중 k6 로 오류율 비교
