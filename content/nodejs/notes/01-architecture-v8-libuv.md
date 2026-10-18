---
title: "Node.js 의 구조 — V8, libuv, 바인딩, 그리고 '단일 스레드' 의 정확한 의미"
order: 1
level: 기초
chapter: "1부 · 구조와 이벤트 루프"
summary: "Node.js 를 이루는 세 층(V8 자바스크립트 엔진, libuv 이벤트 루프·스레드 풀, C++ 바인딩과 내장 모듈), 자바스크립트는 한 스레드에서 돌지만 프로세스는 여러 스레드라는 사실, 어떤 작업이 OS 비동기(epoll)로 가고 어떤 작업이 스레드 풀(기본 4개)로 가는지, UV_THREADPOOL_SIZE 를 바꾸면 무엇이 달라지는지 실측, 그리고 이 사이트(Next.js 16 · Node 22)가 이 구조 위에서 어떻게 도는지"
tags: [Node.js, V8, libuv, 스레드 풀, UV_THREADPOOL_SIZE, 이벤트 루프, 바인딩, 단일 스레드]
experiments: [node-event-loop-order]
---

## Node.js 는 "언어" 가 아니라 "런타임" 이다

자바스크립트는 원래 브라우저 안에서만 돌았다. 브라우저에는 자바스크립트를 실행하는 **엔진**(Chrome 의 V8)과, 타이머·네트워크·DOM 같은 **바깥 세상과의 연결**(Web API)이 있다. Node.js 는 이 구조를 서버로 옮긴 것이다: **V8 엔진 + 파일·네트워크·프로세스를 다루는 C/C++ 계층 + 그 둘을 잇는 자바스크립트 표준 라이브러리**.

```
┌──────────────────────────────────────────────────────────┐
│ 여러분의 코드 · npm 패키지 (JS / TS)                         │
├──────────────────────────────────────────────────────────┤
│ Node.js 표준 라이브러리 (lib/*.js) — fs, net, http, stream… │
├──────────────────────────────────────────────────────────┤
│ C++ 바인딩 (src/*.cc) — JS 객체 ↔ C 함수 연결               │
├────────────────────────┬─────────────────────────────────┤
│ V8                      │ libuv                            │
│  - 파서·인터프리터·JIT   │  - 이벤트 루프                     │
│  - 힙과 GC               │  - OS 비동기 I/O (epoll/kqueue/IOCP)│
│  - 마이크로태스크 큐      │  - 스레드 풀 (기본 4개)            │
├────────────────────────┴─────────────────────────────────┤
│ 기타: OpenSSL(crypto·TLS), llhttp(HTTP 파서), zlib, c-ares(DNS), ICU │
└──────────────────────────────────────────────────────────┘
```

이 Mac 에서 확인한 버전:

```bash
$ node -p "process.versions"
{ node: '22.23.3', v8: '12.4.254.21-node.57', uv: '1.53.0', openssl: '3.0.x', llhttp: '9.x', zlib: '...', ... }
```

| 구성 요소 | 하는 일 | 알아 두면 좋은 점 |
|---|---|---|
| **V8** | 자바스크립트를 파싱·컴파일·실행, 객체를 힙에 두고 GC | 3부(09~11)에서 깊게. 메모리 한도(`--max-old-space-size`)는 V8 의 것 |
| **libuv** | 이벤트 루프, 소켓·파일·타이머·시그널·자식 프로세스의 비동기 처리, 스레드 풀 | 이벤트 루프의 "단계"(02 노트)는 libuv 의 구조 그대로 |
| **C++ 바인딩** | `fs.readFile` 같은 JS 함수가 결국 부르는 C++ 함수 | `process.binding` 은 막혔고 내부 전용 |
| **llhttp** | HTTP/1.1 파서(C 로 생성) | HTTP 파싱이 빠른 이유 |
| **OpenSSL** | TLS, `crypto` | `crypto.pbkdf2` 같은 무거운 연산은 스레드 풀에서 돈다 |
| **c-ares / getaddrinfo** | DNS | `dns.lookup` 은 스레드 풀, `dns.resolve` 는 c-ares(소켓) — 차이가 함정이 된다 |

## "Node 는 단일 스레드다" 의 정확한 의미

흔히 듣는 이 말은 **반만 맞다**.

- **자바스크립트 코드는 한 스레드(메인 스레드)에서만 실행된다.** 같은 순간에 두 개의 JS 함수가 동시에 돌지 않는다. 그래서 JS 끼리는 락이 필요 없다(경합은 `await` 경계에서만 생긴다 — [동시성 프로그래밍](/concurrency) 참고).
- **프로세스는 여러 스레드다.** V8 은 GC·JIT 컴파일을 위한 헬퍼 스레드를, libuv 는 스레드 풀을 따로 띄운다.

```bash
$ node -e "setTimeout(()=>{},60000)" & sleep 1; ps -M $! | wc -l     # macOS: 스레드 수
# 보통 7~11 — 메인 1 + V8 플랫폼 워커 여러 개 + libuv 스레드 풀 4(첫 사용 시) + 시그널/inspector
```

리눅스라면 `ls /proc/<pid>/task | wc -l` 로 같은 것을 본다. [운영체제 내부 01](/os-internals/notes/01-processes-threads-context-switch) 에서 다룬 "스레드 = 스케줄링 단위" 그대로다.

그래서 정확한 문장은 이렇다: **"Node 는 자바스크립트를 단일 스레드 이벤트 루프로 실행하고, 블로킹될 수 있는 일은 OS 의 비동기 기능이나 스레드 풀에 맡긴다."**

## I/O 는 어디로 가는가 — OS 비동기 vs 스레드 풀

이게 Node 성능을 이해하는 핵심이다. libuv 는 일의 종류에 따라 두 경로를 쓴다.

| 경로 | 어떤 일 | 원리 |
|---|---|---|
| **OS 비동기 (epoll·kqueue)** | TCP·UDP 소켓, 파이프, TTY, 시그널, 자식 프로세스 | 커널에 "준비되면 알려 줘" 를 등록하고 이벤트 루프가 기다린다. 스레드가 늘지 않는다 — 소켓 10만 개도 한 스레드 |
| **스레드 풀 (기본 4개)** | `fs.*`(파일), `dns.lookup`, `crypto.pbkdf2/scrypt/randomBytes(큰 것)`, `zlib`(비동기 압축), 일부 네이티브 애드온 | OS 가 비동기 API 를 제대로 주지 않거나(일반 파일), CPU 가 무거운 일. 워커 스레드가 블로킹으로 처리하고 결과를 루프에 돌려준다 |

epoll 이 어떻게 "준비된 것만" 알려 주는지는 [운영체제 내부 05](/os-internals/notes/05-syscalls-interrupts) 에, 소켓 자체는 [Linux 네트워크 02](/linux-network/notes/02-ip-ports-sockets) 에 있다.

### 스레드 풀이 4개라서 생기는 일 — 실측

`crypto.pbkdf2`(20만 회 반복, 한 번에 수십 ms)를 동시에 8개 던져 보자. 스레드 풀이 4개면 4개씩 두 번에 나뉘어 끝난다.

```js
// tp.cjs
const crypto = require("node:crypto");
const n = 8, t0 = performance.now(); let done = 0;
for (let i = 0; i < n; i++)
  crypto.pbkdf2("pw", "salt", 200000, 64, "sha512", () => {
    done++; process.stdout.write(`${i}:${Math.round(performance.now() - t0)}ms `);
    if (done === n) console.log(`\ntotal ${Math.round(performance.now() - t0)}ms`);
  });
```

이 Mac(18코어)에서 실제로 돌린 결과:

```bash
$ node tp.cjs                       # 기본 UV_THREADPOOL_SIZE=4
3:44ms 1:47ms 2:47ms 0:48ms 6:87ms 7:88ms 4:88ms 5:91ms
total 91ms
$ UV_THREADPOOL_SIZE=8 node tp.cjs
0:45ms 1:45ms 3:49ms 2:52ms 4:55ms 7:57ms 6:58ms 5:58ms
total 58ms
```

- 기본값에서는 **45ms 대 4개, 88ms 대 4개** — 정확히 두 묶음이다. 뒤의 4개는 앞 4개가 스레드를 비울 때까지 **큐에서 기다렸다**.
- 8 로 늘리면 거의 동시에 끝난다.

> **함정:** 파일 읽기·DNS lookup·암호 해시·압축이 **같은 4개 스레드를 나눠 쓴다.** 대용량 파일 복사가 진행 중이면 `dns.lookup` 이 밀려 HTTP 요청이 느려지는 일이 실제로 생긴다. `UV_THREADPOOL_SIZE` 는 **프로세스 시작 전에** 환경 변수로만 바꿀 수 있다(최대 1024). 첫 사용 때 풀이 만들어지기 때문에, 코드 안에서 `process.env` 를 바꾸면 늦을 수 있다.

### dns.lookup vs dns.resolve

| | `dns.lookup` | `dns.resolve*` |
|---|---|---|
| 구현 | OS 의 `getaddrinfo` (블로킹) → 스레드 풀 | c-ares, UDP 소켓 → OS 비동기 |
| `/etc/hosts`·nsswitch | 존중 | 무시 (DNS 서버에 직접) |
| 쓰는 곳 | `http.get`, `net.connect` 의 기본 | 직접 호출할 때만 |

`http.get("http://api.example.com")` 은 내부적으로 `dns.lookup` 을 쓰므로 **스레드 풀을 소비한다.** DNS 가 느린 환경에서 요청이 몰리면 스레드 풀이 막힌다. 해결책은 캐싱 리졸버(`cacheable-lookup`)나 `lookup` 옵션 교체. DNS 자체는 [Linux 네트워크 03](/linux-network/notes/03-dns).

## 한 번의 요청이 지나가는 길

`http.createServer` 로 받은 요청에서 파일을 읽어 응답하는 흐름을 따라가 보자.

```
1. 커널: 클라이언트 SYN → accept 큐 (Linux 네트워크 02)
2. libuv: epoll 이 "listen 소켓 읽기 가능" 을 알림 → 루프의 poll 단계
3. C++: accept() → 새 소켓을 epoll 에 등록
4. llhttp: 데이터가 오면 HTTP 파싱 → JS 의 'request' 이벤트
5. JS(메인 스레드): 핸들러 실행 → fs.readFile 호출
6. libuv: 스레드 풀 워커가 open/read/close (블로킹)
7. 워커 완료 → 루프에 알림 → poll 단계에서 JS 콜백 실행
8. JS: res.end(data) → libuv 가 소켓에 write (가능하면 즉시, 아니면 epoll 로 대기)
```

메인 스레드가 **바쁜 순간은 4·5·7·8 의 JS 실행 시간뿐**이다. 나머지 기다림은 커널과 스레드 풀이 한다. 그래서 Node 는 I/O 대기가 많은 서버에 강하고, **JS 에서 CPU 를 오래 쓰는 순간 모든 요청이 멈춘다.**

### 메인 스레드를 막으면 — 실측

`monitorEventLoopDelay` 로 이벤트 루프 지연을 재면서 200ms 동안 동기 루프를 돌려 보았다.

```js
const { monitorEventLoopDelay } = require("node:perf_hooks");
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
setTimeout(() => { const t = Date.now(); while (Date.now() - t < 200); }, 100);  // 200ms 블로킹
setTimeout(() => { h.disable(); console.log(`p50=${(h.percentile(50)/1e6).toFixed(1)}ms p99=${(h.percentile(99)/1e6).toFixed(1)}ms`); }, 600);
```

```bash
p50=11.0ms p99=210.5ms max=210.5ms
```

평소 지연은 해상도(10ms) 수준인데, 한 번의 200ms 블로킹이 **p99 를 210ms 로** 만든다. 서버라면 그 200ms 동안 들어온 모든 요청이 같이 기다렸다는 뜻이다. 이 지표를 운영에서 보는 법은 [13 프로파일링과 진단](/nodejs/notes/13-profiling-diagnostics), 성능 관점은 [성능 공학 04](/performance/notes/04-node-web-server-performance).

## 프로세스 하나에 담긴 것들

| 항목 | 확인 | 의미 |
|---|---|---|
| `process.memoryUsage()` | `rss, heapTotal, heapUsed, external, arrayBuffers` | rss 는 OS 가 본 전체, heap 은 V8 힙, external 은 힙 밖(Buffer 등) |
| `process.resourceUsage()` | 사용자/시스템 CPU, 컨텍스트 스위치 | [OS 내부 01](/os-internals/notes/01-processes-threads-context-switch) 의 voluntary/nonvoluntary 와 같은 값 |
| `process.getActiveResourcesInfo()` | `['TCPServerWrap','Timeout',...]` | 이벤트 루프를 살려 두는 핸들 목록 — "왜 프로세스가 안 끝나지?" 의 답 |
| `process.hrtime.bigint()` | 단조 시계(ns) | 측정은 `Date.now()` 대신 이것 또는 `performance.now()` |

```bash
$ node -e "setInterval(()=>{},1000); console.log(process.getActiveResourcesInfo())"
[ 'Timeout' ]                         # 이게 남아 있는 한 프로세스는 끝나지 않는다
$ node -e "setInterval(()=>{},1000).unref(); console.log(process.getActiveResourcesInfo())"
[]                                     # unref → 루프를 붙잡지 않음, 즉시 종료
```

## 예시로 보기 — 이 프로젝트에서

이 사이트는 **Next.js 16 서버 = Node 22 프로세스 하나**다. 위의 구조가 그대로 보인다.

- **Redis 연결은 소켓 하나**다. `src/lib/redis.ts` 의 `getRedis()` 는 ioredis 클라이언트를 `globalThis.__redisClient` 에 하나만 만든다. 모든 요청이 그 TCP 연결 하나를 공유하고, libuv 가 epoll 로 응답을 기다린다 — 스레드 풀은 쓰지 않는다. `enableOfflineQueue: false`, `connectTimeout: 1500` 은 Redis 가 없을 때 요청이 영원히 기다리지 않게 하는 설정이다.
- **노트 파일은 스레드 풀로 읽힌다.** `src/lib/notes.ts` 의 `fs.readFile`·`fs.stat` 은 모두 스레드 풀 작업이다. 첫 화면이 주제 34개의 노트 수백 개를 읽을 때 4개 스레드가 나눠 일한다. 그래서 이 파일에는 **mtime 캐시**(`metaCache`, `noteCache`)가 있다 — 파일이 안 바뀌었으면 `stat` 한 번으로 끝내고 `readFile`·YAML 파싱을 건너뛴다. 이 캐시로 첫 화면이 220ms → 70ms 가 됐다.
- **실험은 자식 프로세스로 돈다.** 이 주제의 실험(`src/code-lab/nodejs.ts`)은 `execFile(process.execPath, …)` 로 별도 Node 를 띄운다. 이벤트 루프를 막거나 힙을 터뜨리는 코드를 서버 프로세스에서 돌리면 사이트 전체가 멈추기 때문이다. 12 노트에서 이 선택을 다시 다룬다.
- **이벤트 루프 지연은 이미 수집되고 있다.** `src/lib/metrics.ts` 의 `collectDefaultMetrics({ prefix: "study_process_" })` 는 `study_process_nodejs_eventloop_lag_seconds` 를 `/api/metrics` 로 내보낸다. Grafana 에서 이 값이 튀면 누군가 메인 스레드를 막은 것이다.

## 실전에서는 어디에 쓰이나 — Node.js 지도

> 실무에서 Node.js 는 주로 "I/O 를 많이 기다리는 서버" 를 맡는다. API·BFF·실시간 연결·SSR 처럼 대기가 길고 계산이 짧은 일에 강하고, 메인 스레드를 오래 잡는 계산에는 약하다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 웹 프론트의 BFF·SSR 서버 | 이벤트 루프, 메인 스레드를 막지 않는 코드 | [이벤트 루프의 단계](/nodejs/notes/02-event-loop-phases) |
| 채팅·알림·LLM 응답 스트리밍 | 스트림과 백프레셔, SSE | [스트림과 백프레셔](/nodejs/notes/06-streams-backpressure) |
| 여러 서비스를 부르는 API 게이트웨이 | keep-alive, 연결 풀, 타임아웃 | [네트워크와 HTTP](/nodejs/notes/07-network-http) |
| 외부 API 를 대량 호출하는 배치 | 동시성 제한, 재시도·취소 | [비동기 패턴과 에러 처리](/nodejs/notes/04-async-patterns-errors) |
| 이미지·PDF 생성 같은 CPU 작업 | 워커 풀, 자식 프로세스 | [worker_threads · cluster · child_process](/nodejs/notes/12-workers-cluster-child-process) |
| 컨테이너에서 OOMKilled 반복 | 힙 상한, 컨테이너 메모리 | [GC 와 힙 구조](/nodejs/notes/10-gc-heap) |
| "가끔 느린" 운영 서버 | 이벤트 루프 지연, CPU 프로파일 | [프로파일링과 진단](/nodejs/notes/13-profiling-diagnostics) |
| 배포 중 요청 끊김·의존성 사고 | graceful shutdown, 공급망 | [운영과 보안](/nodejs/notes/14-operations-security) |

**회사 규모에 따라**
- 스타트업: 프론트와 같은 언어(TypeScript)로 맞추려고 Node 서버 하나에 API·SSR·간단한 작업을 함께 둔다.
- 성장기: CPU 작업을 워커·별도 서비스로 떼고, 컨테이너 여러 개로 수평 확장하며 이벤트 루프 지연·힙 메트릭을 대시보드에 올린다.
- 대규모 조직: BFF·실시간·SSR 계층에 Node 를 두고 핵심 도메인은 다른 언어 서비스와 섞는다. 플랫폼 팀이 Node 버전·베이스 이미지·종료 처리·관측 계측을 표준으로 제공한다.

**이럴 땐 안 맞는다**
- 요청마다 CPU 를 오래 쓰는 계산(영상 인코딩, 대규모 수치 연산, 모델 학습) — 메인 스레드가 막힌다. Go·Rust·JVM 서비스나 네이티브 라이브러리를 쓰는 별도 서비스로 뗀다.
- 공유 메모리를 많이 쓰는 복잡한 멀티스레드 처리 — SharedArrayBuffer 는 바이트 배열뿐이라 제한적이다. 스레드 모델이 강한 언어.

**누가 매일 만나나** — 풀스택·백엔드 개발자가 API·SSR 서버를 만들 때, SRE 가 이벤트 루프 지연·힙 알림이나 종료 코드 134·137 을 볼 때, 플랫폼 팀이 Node 베이스 이미지와 런타임 업그레이드를 관리할 때.

## 정리

| 질문 | 답 |
|---|---|
| JS 는 몇 개의 스레드에서 도나? | 하나(메인). 워커 스레드를 따로 만들지 않는 한 |
| 소켓 I/O 는 스레드를 쓰나? | 아니다. epoll/kqueue 로 커널이 알려 준다 |
| 파일 I/O 는? | 스레드 풀(기본 4) |
| 스레드 풀이 꽉 차면? | 다음 작업은 큐에서 기다린다 — 파일·DNS·crypto·zlib 가 서로를 막는다 |
| 무엇이 Node 를 느리게 하나? | 메인 스레드에서 오래 도는 JS(동기 CPU 작업) |

## 실습 체크리스트

- [ ] `node -p process.versions` 로 V8·libuv·OpenSSL 버전 확인
- [ ] 위 `tp.cjs` 를 `UV_THREADPOOL_SIZE=1,4,8,16` 으로 돌려 total 시간이 어떻게 바뀌는지 표로 정리
- [ ] `ps -M <pid>`(macOS) 또는 `/proc/<pid>/task`(리눅스)로 Node 프로세스의 스레드 수 세기
- [ ] `process.getActiveResourcesInfo()` 로 "프로세스가 안 끝나는 이유" 찾아 보기 (setInterval, 열린 서버)
- [ ] 실험 `node-event-loop-order` 를 돌리고 다음 노트로
