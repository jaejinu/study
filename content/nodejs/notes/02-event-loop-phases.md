---
title: "이벤트 루프의 단계 — timers · pending · poll · check · close, 그리고 setTimeout 과 setImmediate"
order: 2
level: 기초
chapter: "1부 · 구조와 이벤트 루프"
summary: "libuv 이벤트 루프가 한 바퀴에 거치는 여섯 단계와 각 단계에서 실행되는 콜백, poll 단계가 '기다리는 곳' 인 이유와 기다리는 시간의 계산, setTimeout(0) 과 setImmediate 의 순서가 메인 모듈에서는 실행마다 바뀌고 I/O 콜백 안에서는 항상 immediate 가 먼저인 이유(실측 40회), 타이머가 정확하지 않은 이유, 루프가 끝나는 조건(ref/unref), 루프를 막지 않는 코드를 쓰는 법"
tags: [이벤트 루프, libuv, setTimeout, setImmediate, poll, timers, check, unref]
experiments: [node-event-loop-order]
---

## 이벤트 루프는 "무한 while 문" 이다

이벤트 루프는 신비한 것이 아니다. libuv 의 `uv_run()` 은 대략 이렇게 생긴 반복문이다.

```c
while (루프에 살아 있는 핸들·요청이 있다) {
  uv__update_time(loop);        // 현재 시각 캐시
  uv__run_timers(loop);         // ① timers
  uv__run_pending(loop);        // ② pending callbacks
  uv__run_idle(loop);           //    idle, prepare (내부용)
  uv__run_prepare(loop);
  uv__io_poll(loop, timeout);   // ③ poll — 여기서 '기다린다'
  uv__run_check(loop);          // ④ check
  uv__run_closing_handles(loop);// ⑤ close callbacks
}
```

![이벤트 루프의 단계](/diagrams/node-event-loop.svg)

| 단계 | 실행되는 콜백 | 예 |
|---|---|---|
| **timers** | 만료된 `setTimeout`·`setInterval` | `setTimeout(fn, 10)` 이 10ms 지났으면 여기서 |
| **pending callbacks** | 지난 바퀴에서 미룬 일부 시스템 콜백 | TCP `ECONNREFUSED` 같은 오류 보고 |
| idle, prepare | 내부용 | — |
| **poll** | **I/O 이벤트 콜백** — 소켓 데이터, 파일 읽기 완료(스레드 풀) | `fs.readFile` 콜백, `socket.on('data')` |
| **check** | `setImmediate` | 이름 그대로 "poll 직후 바로" |
| **close callbacks** | `'close'` 이벤트 | `socket.on('close')` |

그리고 **각 단계의 콜백 하나가 끝날 때마다** nextTick 큐와 마이크로태스크(Promise) 큐를 비운다 — 이건 다음 노트 [03 마이크로태스크와 nextTick](/nodejs/notes/03-microtasks-nexttick) 의 주제다.

## poll 단계 — 루프가 "쉬는" 곳

poll 단계는 `epoll_wait()`(리눅스)·`kevent()`(macOS) 를 호출해 **I/O 이벤트가 올 때까지 잔다**. 그런데 얼마나 오래 잘까?

| 상황 | poll 이 기다리는 시간 |
|---|---|
| `setImmediate` 가 대기 중 | 0 (안 기다림 — check 단계로 바로 가야 하니까) |
| 가장 가까운 타이머가 15ms 뒤 | 최대 15ms |
| 타이머·immediate 없음 | 무한 (I/O 가 올 때까지) |
| 루프에 살아 있는 핸들 없음 | 루프 종료 → 프로세스 종료 |

그래서 **아무 일도 없는 Node 서버는 CPU 0% 로 epoll_wait 에서 자고 있다.** [운영체제 내부 05](/os-internals/notes/05-syscalls-interrupts) 의 strace 실험에서 Redis 가 epoll_wait 에 대부분의 시간을 보낸 것과 같은 모습이다 — Redis 도 같은 모양의 이벤트 루프다.

## setTimeout(fn, 0) vs setImmediate(fn) — 실측

가장 유명한 퀴즈다. 실험 `node-event-loop-order` 가 자식 프로세스를 20번씩 띄워 실제로 집계했다.

```js
setTimeout(() => log("timeout"), 0);
setImmediate(() => log("immediate"));

fs.readFile(__filename, () => {         // I/O 콜백 안에서 다시
  setTimeout(() => log("timeout"), 0);
  setImmediate(() => log("immediate"));
});
```

이 Mac 에서 나온 결과:

| 조건 | timeout 먼저 | immediate 먼저 |
|---|---|---|
| 메인 모듈, 바로 루프 진입 (CJS 20 + ESM 20) | **29** | **11** |
| 메인 모듈, 루프 진입 전 2ms CPU 사용 | 20 | 0 |
| I/O 콜백 안 (60회) | 0 | **60** |

### 왜 메인 모듈에서는 바뀌나

1. `setTimeout(fn, 0)` 은 실제로 **1ms 타이머**다. Node 는 0 을 1 로 바꾼다(브라우저와 같은 규칙).
2. 메인 스크립트가 끝나고 루프가 시작된다. 첫 **timers** 단계에서 "1ms 가 지났나?" 를 본다.
3. 스크립트 실행·루프 준비에 1ms 이상 걸렸다면 → 타이머가 만료 → **timeout 먼저**.
4. 1ms 가 안 지났다면 → timers 는 건너뛰고 poll → **check 에서 immediate 먼저** → 다음 바퀴에 timeout.

즉 **순서는 기계의 속도와 그 순간의 부하**에 달려 있다. 2ms 동안 CPU 를 잡아 두면 20/20 이 timeout 먼저가 되는 것이 그 증거다.

### 왜 I/O 콜백 안에서는 항상 immediate 인가

I/O 콜백은 **poll 단계**에서 실행된다. 루프의 순서는 poll → **check** → close → (다음 바퀴) timers 이므로, poll 안에서 등록한 immediate 는 바로 다음 check 단계에서, timeout 은 다음 바퀴 timers 에서 돈다. 예외가 없다.

> **교훈:** "타이머 0 이면 다음 틱에 돈다" 같은 순서에 기대는 코드는 버그다. 순서가 중요하면 명시적으로 이어 붙여라(Promise 체인, 콜백 안에서 다음 일 시작). "I/O 를 끝낸 뒤 가능한 한 빨리" 는 `setImmediate` 가 정답이다.

## 타이머는 정확하지 않다

`setTimeout(fn, 100)` 은 **"100ms 뒤에 실행"** 이 아니라 **"100ms 가 지난 뒤 가장 빠른 timers 단계에서 실행"** 이다.

```js
const t0 = performance.now();
setTimeout(() => console.log("늦음:", Math.round(performance.now() - t0 - 100), "ms"), 100);
const t = Date.now(); while (Date.now() - t < 300);   // 메인 스레드 300ms 점유
// 늦음: 200 ms 안팎 — 타이머는 만료됐지만 루프가 돌아오지 못했다
```

| 지연 원인 | 설명 |
|---|---|
| 메인 스레드 점유 | 동기 JS 가 끝나야 루프가 돈다 |
| 다른 콜백이 많음 | 한 단계의 큐를 다 처리해야 다음 단계 |
| 타이머 병합 | libuv 는 같은 만료 시각의 타이머를 한 번에 처리 — 해상도는 ms |
| 시스템 슬립·CPU 스로틀링 | 컨테이너 CPU 제한([OS 내부 03](/os-internals/notes/03-scheduler-cgroups))에 걸리면 수십 ms 단위로 늦는다 |

`setInterval(fn, 1000)` 도 마찬가지로 **누적 오차**가 생긴다. 정확한 주기가 필요하면 다음 실행 시각을 매번 계산해 `setTimeout` 을 다시 건다.

## 루프는 언제 끝나나 — ref 와 unref

루프는 **"살아 있는(referenced) 핸들"** 이 하나라도 있으면 계속 돈다. 서버 소켓, 타이머, 자식 프로세스, 열린 파일 스트림이 모두 핸들이다.

```js
const t = setInterval(report, 60_000);
t.unref();          // 이 타이머 때문에 프로세스가 살아 있지는 않게
```

| 메서드 | 의미 | 쓰는 곳 |
|---|---|---|
| `handle.unref()` | 이 핸들은 루프를 붙잡지 않는다 | 메트릭 보고 타이머, 하트비트 |
| `handle.ref()` | 다시 붙잡는다 | |
| `handle.hasRef()` | 현재 상태 | |

**예: 이 사이트의 데드맨 스위치.** `src/lib/deadman.ts` 는 장애 실험 직전에 `spawn("sh", ["-c", "sleep N; 원복"], { detached: true, stdio: "ignore" })` 로 자식을 띄우고 **`child.unref()`** 를 부른다. unref 가 없으면 부모 Node 가 그 자식이 끝날 때까지(N 초) 종료하지 못한다. detached 는 부모가 죽어도 자식이 같이 죽지 않게(새 프로세스 그룹), unref 는 부모가 자식을 기다리지 않게 — 두 가지가 함께 있어야 "부모와 수명이 독립된 원복 장치" 가 된다.

## 루프를 막지 않는 코드

| 하지 말 것 | 대신 |
|---|---|
| `fs.readFileSync` 를 요청 처리 중에 | `await fs.promises.readFile` (시작 시 설정 로딩은 Sync 도 괜찮다) |
| 큰 `JSON.parse`/`JSON.stringify`(수십 MB) | 스트리밍 파서, 워커 스레드, 애초에 데이터 줄이기 |
| 큰 배열을 한 번에 정렬·변환 | 나눠서 `setImmediate` 로 양보, 또는 워커([12](/nodejs/notes/12-workers-cluster-child-process)) |
| 동기 암호화 `crypto.pbkdf2Sync` | 비동기판(스레드 풀) |
| 정규식 폭주(ReDoS) | 입력 길이 제한, 안전한 정규식 |

큰 작업을 나눠 양보하는 패턴:

```js
async function processInChunks(items, fn, chunk = 1000) {
  for (let i = 0; i < items.length; i += chunk) {
    for (const it of items.slice(i, i + chunk)) fn(it);
    await new Promise((r) => setImmediate(r));   // 루프에 한 바퀴 양보 → I/O 처리 가능
  }
}
```

`await Promise.resolve()` 로는 **양보가 안 된다**는 점에 주의하라 — 마이크로태스크는 같은 단계 안에서 바로 실행되므로 I/O 가 끼어들 틈이 없다. 이유는 다음 노트에서.

## 예시로 보기 — 이 프로젝트에서

- **SSE 스트리밍과 루프.** `src/app/api/ask/route.ts` 는 OpenAI 응답을 `for await (const chunk of res)` 로 받아 `controller.enqueue` 로 브라우저에 흘린다. 청크 하나하나가 소켓 데이터 이벤트(poll 단계)이고, 그 사이 루프는 다른 요청을 처리한다. 응답이 20초 걸려도 다른 사용자의 페이지 요청이 막히지 않는 이유다.
- **실험 실행은 길어도 루프는 자유롭다.** 셸 실험의 `ctx.sh()` 는 `execFile` 로 자식 프로세스를 띄우고 종료를 이벤트로 받는다. 1분짜리 k6 실험이 도는 동안에도 사이트는 정상적으로 응답한다. 반대로 `node-gc-heap` 의 객체 300만 개 루프를 서버 안에서 돌렸다면 그 100ms 동안 모든 요청이 멈췄을 것이다.
- **메트릭 수집 타이머.** prom-client 의 기본 메트릭 수집은 스크레이프 시점에 계산되고, 이벤트 루프 지연 측정은 `monitorEventLoopDelay`(libuv 타이머 기반)로 한다 — 측정 자체가 루프를 거의 쓰지 않는다.

## 실전에서는 어디에 쓰이나

> 이벤트 루프의 단계는 "타이머가 늦게 돈다", "요청 하나가 느리면 전부 느려진다", "프로세스가 안 끝난다" 같은 증상을 설명할 때 쓰인다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 API 서버 | 큰 배열 변환이 다른 요청까지 막음 | 청크로 나눠 `setImmediate` 로 양보 | 워커 스레드로 오프로드 |
| 실시간 게임·채팅 서버 | 주기 타이머의 누적 오차 | 다음 실행 시각을 매번 계산해 `setTimeout` | 정밀 주기가 필요한 부분은 다른 런타임 |
| 메트릭·하트비트 보고 | 보조 타이머가 종료를 막음 | `timer.unref()` | 명시적 종료 처리 |
| 배치 스크립트·CLI | 일이 끝났는데 프로세스가 안 끝남 | 살아 있는 핸들(서버·타이머·스트림) 찾아 닫기 | 강제 `process.exit` (정리 누락 위험) |
| 장애 실험 원복 장치 | 부모와 수명이 독립된 자식 | `detached` + `child.unref()` | 별도 스케줄러·잡 |

**이럴 땐 안 맞는다**
- `setTimeout(0)` 과 `setImmediate` 의 순서에 기대는 로직 — 메인 모듈에선 실행마다 바뀐다. Promise 체인이나 콜백으로 순서를 명시한다.
- ms 단위로 정확해야 하는 타이밍 — 타이머는 "지난 뒤 가장 빠른 timers 단계" 에 돈다. 정밀 스케줄러나 하드웨어 타이머.

**누가 매일 만나나** — 백엔드 개발자가 "요청 하나 때문에 p99 가 튄다" 를 추적할 때, SRE 가 이벤트 루프 지연 메트릭이 튄 시점을 볼 때.

**면접·실무 단골 질문**
- Q. `setTimeout(fn, 0)` 과 `setImmediate` 중 무엇이 먼저 → 메인 모듈에선 불확정, I/O 콜백 안에선 항상 immediate.
- Q. 요청이 없는 Node 서버는 CPU 를 쓰나 → poll 단계의 `epoll_wait`·`kevent` 에서 잔다.

## 실습 체크리스트

- [ ] 실험 `node-event-loop-order` 를 여러 번 돌려 "바로 진입" 행의 비율이 바뀌는지 보기
- [ ] `setTimeout(fn, 100)` 뒤에 300ms 동기 루프를 넣고 실제 지연 측정
- [ ] `setInterval` 하나만 있는 스크립트에서 `unref()` 를 넣었다 뺐다 하며 종료 여부 확인
- [ ] 위 `processInChunks` 를 `await Promise.resolve()` 버전과 비교해 그 사이 `setTimeout(…, 0)` 이 실행되는지 확인
- [ ] 이 사이트의 `/api/metrics` 에서 `study_process_nodejs_eventloop_lag_seconds` 찾기
