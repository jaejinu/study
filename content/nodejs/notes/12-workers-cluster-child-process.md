---
title: "worker_threads · cluster · child_process — 언제 무엇을 쓰나, 그리고 공유 메모리"
order: 12
level: 중급
chapter: "4부 · 병렬성·성능·운영"
summary: "CPU 를 여러 코어로 쓰는 세 가지 방법의 차이(같은 프로세스의 스레드, 같은 포트를 나눠 쓰는 프로세스들, 아무 프로그램이나 띄우는 자식 프로세스), fib(33)×4 가 메인 스레드 79ms·워커 4개 37ms 라는 실측과 워커 시작 비용 11.8ms·자식 Node 49ms, 64MB 를 복사로 보내면 58.7ms·transfer 로 보내면 0.1ms, SharedArrayBuffer 에서 일반 ++ 은 40만 중 148,626 만 남고 Atomics.add 는 정확히 40만이라는 실측, cluster 의 라운드로빈 분배(400요청 100·100·100·100), 쿠버네티스 시대에 cluster 를 덜 쓰는 이유"
tags: [worker_threads, cluster, child_process, SharedArrayBuffer, Atomics, transfer, 병렬성, CPU 바운드]
experiments: []
---

## 문제 — 코어는 18개인데 JS 는 하나에서 돈다

[01](/nodejs/notes/01-architecture-v8-libuv) 에서 본 것처럼 JS 는 메인 스레드 하나에서 돈다. I/O 대기는 문제가 아니지만, **CPU 를 오래 쓰는 일**(이미지 처리, 압축, 큰 JSON, 해시, 머신러닝 추론)은 그동안 모든 요청을 멈춘다. 이 Mac 의 `os.availableParallelism()` 은 18 — 17개 코어가 놀고 있다.

선택지는 셋이다.

| | worker_threads | cluster | child_process |
|---|---|---|---|
| 단위 | 같은 프로세스 안의 **스레드** | 같은 프로그램의 **프로세스 여러 개** | **아무 프로그램**의 프로세스 |
| V8 힙 | 스레드마다 별도 (격리) | 프로세스마다 별도 | 별도 |
| 메모리 공유 | ✅ `SharedArrayBuffer` | ❌ | ❌ |
| 통신 | `postMessage` (구조적 복제·transfer) | IPC 메시지 | stdin/stdout, IPC(`fork`) |
| 시작 비용 (실측) | **11.8ms** | 자식 Node 수준 | `node -e 0` **49ms** |
| 한 쪽이 죽으면 | 워커만 (`error` 이벤트) | 그 프로세스만 | 그 프로세스만 |
| 주 용도 | **CPU 작업 오프로드** | 서버를 코어 수만큼 복제 | 외부 도구 실행, 격리 실행 |

## worker_threads — 실측

```js
const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));
// 메인 스레드에서 4번
for (let i = 0; i < 4; i++) fib(33);
// 워커 4개에서 동시에
await Promise.all(Array.from({ length: 4 }, () => new Promise((res) => {
  const w = new Worker(`const fib=…; require("node:worker_threads").parentPort.postMessage(fib(33))`, { eval: true });
  w.once("message", res);
})));
```

```
메인 스레드에서 fib(33)×4: 79ms / 워커 4개 병렬: 37ms (cpus=18)
```

4배가 아니라 2.1배인 이유: 워커 4개의 **시작 비용**(각각 V8 아이솔레이트·이벤트 루프 생성, 약 12ms)이 포함됐기 때문이다. 일이 짧으면 워커를 매번 만드는 비용이 이득을 먹는다. 그래서 실무에서는 **워커 풀**(piscina 같은 라이브러리)을 미리 띄워 재사용한다.

### 데이터를 보내는 세 가지 방법 — 실측

| 방법 | 64MB ArrayBuffer | 보낸 뒤 원본 |
|---|---|---|
| `postMessage(buf)` — 구조적 복제(복사) | **58.7ms** | 그대로 (`byteLength` 67108864) |
| `postMessage(buf, [buf])` — **transfer** | **0.1ms** | **분리됨** (`byteLength` 0) |
| `SharedArrayBuffer` | 0 (복사 없음) | 양쪽이 동시에 봄 |

transfer 는 메모리 소유권을 넘긴다 — 복사가 없는 대신 보낸 쪽에서는 더 이상 쓸 수 없다. 큰 이미지·파일 버퍼를 워커로 넘길 때 쓴다. 일반 객체(`{a:1}`)는 항상 복제된다(함수·클래스 인스턴스의 프로토타입은 사라진다).

### 공유 메모리와 경합 — 실측

```js
const sab = new SharedArrayBuffer(4); const ia = new Int32Array(sab);
// 워커 4개가 각각 10만 번 증가
ia[0]++;                  // 일반 증가
Atomics.add(ia, 0, 1);    // 원자 증가
```

| 방식 | 기대값 | 실제 |
|---|---|---|
| 일반 `ia[0]++` | 400,000 | **148,626** |
| `Atomics.add` | 400,000 | **400,000** |

일반 `++` 는 "읽기 → 더하기 → 쓰기" 세 단계라, 두 스레드가 같은 값을 읽고 같은 값을 쓰면 하나가 사라진다(lost update). **JS 에도 진짜 데이터 경합이 생기는 유일한 지점**이 SharedArrayBuffer 다. `Atomics` 는 원자 연산(`add`, `compareExchange`)과 대기·깨우기(`wait`/`notify`)를 제공한다 — 락·CAS·메모리 모델은 [동시성 프로그래밍](/concurrency) 주제가 깊게 다룬다.

## cluster — 실측

```js
if (cluster.isPrimary) for (let i = 0; i < 4; i++) cluster.fork();
else http.createServer(handler).listen(18999);   // 워커들이 '같은 포트' 를 listen
```

새 연결 400개(keep-alive 끔)를 보낸 결과:

```
schedulingPolicy: RR 분배: [ 100, 100, 100, 100 ]
```

주 프로세스가 연결을 accept 하고 **라운드로빈**으로 워커에 넘긴다(윈도우 제외 기본 `SCHED_RR`). `SCHED_NONE` 이면 OS 가 나눠 주는데, 한 워커에 쏠리기 쉽다.

| 장점 | 단점 |
|---|---|
| 코어 수만큼 처리량 | 프로세스 간 상태 공유 없음 — 세션·캐시는 Redis 로 |
| 한 워커가 죽어도 나머지는 산다 | 주 프로세스가 단일 장애점 |
| 무중단 재시작(워커 하나씩 교체) | 메모리 = 워커 수 × 프로세스 크기 |

### 쿠버네티스 시대의 cluster

컨테이너 환경에서는 cluster 대신 **Pod(=프로세스 하나)를 여러 개** 띄우는 경우가 많다.

| | cluster | Pod 복제 |
|---|---|---|
| 분배 | 주 프로세스 | Service·로드밸런서 |
| 스케일 | 코드에서 | HPA |
| 장애 격리 | 프로세스 | Pod·노드 |
| 관측 | 워커별 메트릭 합치기 번거로움 | Pod 별로 자연스럽게 |
| CPU 제한 | 한 컨테이너에 여러 코어 필요 | Pod 당 1코어 근처가 깔끔 |

규칙: **Pod 하나에 Node 프로세스 하나**, 수평 확장은 HPA. 이 사이트의 `k8s/web.yaml` 도 Pod 당 Next.js 프로세스 하나(`requests: { cpu: 100m }`)를 두고 복제본으로 늘린다. JS 실행은 한 코어만 쓰므로 Node Pod 에 CPU limit 을 여러 코어로 주는 것은 대개 낭비다(GC·스레드 풀 몫으로 조금 넘는 정도면 충분). [Kubernetes 14 스케줄링·오토스케일링](/kubernetes/notes/14-scheduling-autoscaling-deep), [성능 공학 07](/performance/notes/07-capacity-planning).

## child_process

| 함수 | 셸 | 출력 | 용도 |
|---|---|---|---|
| `spawn(cmd, args)` | ❌ | **스트림** | 오래 돌거나 출력이 큰 것 |
| `execFile(file, args)` | ❌ | 버퍼에 모음(`maxBuffer`) | 짧은 명령 |
| `exec(cmdline)` | ✅ `/bin/sh -c` | 버퍼 | 파이프·리다이렉트 필요할 때 — **셸 주입 위험** |
| `fork(module)` | ❌ | IPC 채널 | 다른 Node 스크립트와 메시지로 대화 |

```js
// ❌ 사용자 입력이 셸로 들어간다 — "x; rm -rf ~" 를 넣으면?
exec(`git log ${userInput}`);
// ✅ 인자는 배열로 — 셸이 해석하지 않는다
execFile("git", ["log", userInput]);
```

자식 프로세스의 `error` 이벤트(실행 파일 없음 ENOENT), `exit` 의 code·signal, 그리고 **부모가 죽을 때 자식 처리**(`detached`, 프로세스 그룹 kill)를 신경 써야 한다.

## 무엇을 고를까

| 상황 | 선택 |
|---|---|
| 요청 처리 중 가끔 무거운 계산 (썸네일, PDF, 해시) | **워커 풀** |
| 큰 데이터를 계산과 공유 | 워커 + SharedArrayBuffer/transfer |
| 서버 처리량을 코어 수만큼 | 컨테이너면 Pod 복제, 아니면 cluster(또는 PM2) |
| 외부 바이너리(ffmpeg, git, docker) | `spawn`/`execFile` |
| 신뢰할 수 없는 코드 실행 | 자식 프로세스 + `--permission`([14](/nodejs/notes/14-operations-security)) 또는 컨테이너 — 워커는 같은 프로세스라 격리가 약하다 |
| 서버를 절대 멈추면 안 되는 위험한 코드 | 자식 프로세스 |

### 워커는 만들지 말고 재사용한다 — 실측

워커 하나 시작에는 새 V8 아이솔레이트와 이벤트 루프를 만드는 비용이 든다. 아주 작은 작업 100개를 두 방식으로 처리했다.

| 방식 | 100개 처리 시간 (2회) |
|---|---|
| 작업마다 `new Worker` → `terminate` | 1374ms · 1605ms |
| 워커 하나를 만들어 메시지로 반복 | 12ms · 22ms |

약 100배 차이다. 실제로는 CPU 코어 수만큼 워커를 미리 띄워 두고 작업 큐로 나눠 주는 **워커 풀**을 쓴다. piscina 같은 라이브러리가 이 일을 한다. 작업 하나가 수 밀리초 이하라면 메시지 직렬화 비용 때문에 워커로 보내는 것 자체가 손해일 수 있으니, 메인 스레드에서 잰 시간과 비교하고 결정한다.

## 예시로 보기 — 이 프로젝트에서

- **실험은 자식 프로세스로.** 이 사이트의 실험 프레임워크 전체가 `child_process` 위에 있다. 셸 실험의 `ctx.sh()` 는 `execFile` 로 docker·kubectl·k6 를 부르고(`src/shell-lab/runner.ts`), Node 주제 실험(`src/code-lab/nodejs.ts`)은 `execFile(process.execPath, [lab.mjs])` 로 **별도 Node** 를 띄운다. 이 주제의 실험들은 일부러 이벤트 루프를 막고 힙을 터뜨리는데, 워커로 돌렸다면 힙 OOM 이 같은 프로세스(사이트)를 죽였을 것이다. 49ms 시작 비용은 그 안전을 위한 값이다.
- **데드맨 스위치는 detached 자식.** `src/lib/deadman.ts` 의 `spawn("sh", ["-c", "sleep N; 원복"], { detached: true, stdio: "ignore" })` 는 부모와 다른 **프로세스 그룹**에 자식을 만든다. 실험이 강제 종료돼도(부모 Node 가 죽어도) sleep 은 살아남아 Redis 를 unpause 한다. 정상 종료 때는 `process.kill(-pid)` — 음수 PID 는 **프로세스 그룹 전체**(sh + sleep)에 신호를 보낸다.
- **셸 주입 방지.** 셸 실험은 거의 모두 `ctx.sh("docker", ["pause", "study-redis"])` 처럼 인자 배열을 쓴다. 사용자 입력이 섞이는 곳이 없지만, 습관 자체가 방어다.

## 실전에서는 어디에 쓰이나

> 메인 스레드를 막는 CPU 작업이나 외부 프로그램 실행이 필요할 때 등장한다. 무엇을 스레드·프로세스·Pod 중 어느 단위로 나눌지가 핵심 결정이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 썸네일·PDF 생성 | 요청 처리 중 무거운 계산 | 워커 풀(piscina) 재사용 | 큐 + 별도 작업 서비스 |
| 대용량 버퍼 분석 | 워커로 넘길 때의 복사 비용 | `postMessage(buf, [buf])` transfer | SharedArrayBuffer + Atomics |
| 사내 배포·CI 봇 | git·docker·kubectl 실행 | `execFile`/`spawn` 에 인자 배열 | SDK·API 직접 호출 |
| 온라인 코드 실행·플러그인 | 신뢰할 수 없는 코드 격리 | 자식 프로세스 + `--permission`, 컨테이너 | 원격 샌드박스 |
| 컨테이너 없는 단일 서버 | 코어 수만큼 처리량 | cluster (또는 PM2) | k8s 라면 Pod 복제 + HPA |

**이럴 땐 안 맞는다**
- 수 ms 이하의 작은 작업을 워커로 — 시작·메시지 직렬화 비용이 이득을 먹는다. 메인 스레드에서 처리한다.
- 사용자 입력이 섞인 `exec` — 셸 주입. `execFile` 의 인자 배열.
- k8s 의 Pod 하나에 cluster 로 여러 코어 — 관측·스케일이 번거롭다. Pod 당 프로세스 하나.

**누가 매일 만나나** — 백엔드 개발자가 CPU 작업을 요청 경로에서 떼어낼 때, 플랫폼 엔지니어가 CLI 도구를 감싸는 내부 서비스를 만들 때.

**면접·실무 단골 질문**
- Q. worker_threads 와 cluster 의 차이 → 같은 프로세스의 스레드(메모리 공유 가능) vs 같은 포트를 나눠 쓰는 프로세스들.
- Q. 쿠버네티스에서 cluster 를 덜 쓰는 이유 → 분배·스케일·장애 격리를 Service·HPA·Pod 가 맡는다.

## 실습 체크리스트

- [ ] fib(33)×8 을 메인 스레드·워커 매번 생성·워커 풀(재사용)로 비교
- [ ] 64MB ArrayBuffer 를 복제/transfer 로 보내고 시간과 원본 상태 확인
- [ ] SharedArrayBuffer 에서 일반 `++` 와 `Atomics.add` 결과 비교
- [ ] cluster 로 워커 4개를 띄우고 `SCHED_NONE` 과 `SCHED_RR` 의 분배 비교
- [ ] `exec` 에 `; echo pwned` 를 섞어 셸 주입을 재현하고 `execFile` 로 막기
