---
title: "비동기 패턴과 에러 처리 — 콜백에서 async/await 까지, 거부되지 않은 Promise, 취소, 동시성 제한"
order: 4
level: 중급
chapter: "1부 · 구조와 이벤트 루프"
summary: "에러 우선 콜백 → Promise → async/await 의 진화와 각각의 함정, Node 22 에서 처리되지 않은 Promise 거부가 프로세스를 즉시 종료시키는 이유(실측), Promise.all·allSettled·race·any 의 차이, AbortController 와 AbortSignal.timeout·any 로 하는 취소와 타임아웃, Promise.all 이 동시성 100 을 만드는 문제와 풀(pool)로 제한하기(실측 20ms vs 215ms), 재시도·백오프, EventEmitter 의 에러 이벤트"
tags: [비동기, Promise, async/await, unhandledRejection, AbortController, 타임아웃, 동시성 제한, 에러 처리]
experiments: []
---

## 세 세대의 비동기

### 1. 에러 우선 콜백

```js
fs.readFile("a.json", "utf8", (err, data) => {
  if (err) return handle(err);
  fs.readFile("b.json", "utf8", (err2, data2) => {   // 콜백 지옥
    ...
  });
});
```

규칙: 첫 인자는 에러, 콜백은 **정확히 한 번** 호출. 문제는 중첩, 그리고 콜백 안에서 던진 예외를 바깥 `try/catch` 가 못 잡는다는 것(이미 다른 스택이다).

### 2. Promise

```js
readFile("a.json").then(parse).then((a) => readFile(a.next)).catch(handle);
```

체인으로 평평해졌고, `.catch` 하나가 체인 전체의 에러를 받는다. 콜백 API 는 `util.promisify` 나 `fs/promises` 로 바꾼다.

### 3. async/await

```js
try {
  const a = JSON.parse(await readFile("a.json", "utf8"));
  const b = await readFile(a.next, "utf8");
} catch (e) { handle(e); }
```

동기 코드처럼 읽히고 `try/catch` 가 동작한다. 하지만 [03](/nodejs/notes/03-microtasks-nexttick) 에서 본 것처럼 `await` 지점마다 다른 코드가 끼어든다는 사실은 그대로다.

## 처리되지 않은 거부 — Node 22 에서는 프로세스가 죽는다

```bash
$ node -e 'Promise.reject(new Error("boom")); setTimeout(()=>console.log("살아 있음"),50)'
Error: boom
    at [eval]:1:16 ...
Node.js v22.23.3
$ echo $?
1                                                   # "살아 있음" 은 출력되지 않았다

$ node --unhandled-rejections=warn -e '...같은 코드...'
(node:23458) UnhandledPromiseRejectionWarning: Error: boom
$ echo $?
0                                                   # 경고만 하고 계속
```

Node 15 부터 기본값이 `throw` 다. 거부된 Promise 에 누구도 `.catch` 를 달지 않으면 마이크로태스크 처리 후 `unhandledRejection` 이 발생하고, 리스너가 없으면 **프로세스가 종료된다.**

| 모드 (`--unhandled-rejections=`) | 동작 |
|---|---|
| `throw` (기본) | 리스너 없으면 uncaught exception 처럼 종료 |
| `strict` | 리스너가 있어도 예외로 |
| `warn` | 경고만 |
| `none` | 조용히 무시 — 쓰지 말 것 |

자주 만드는 실수:

```js
// ❌ await 없이 fire-and-forget — 실패하면 프로세스가 죽는다
app.post("/x", (req, res) => { sendEmail(req.body); res.end("ok"); });

// ✅ 의도적으로 기다리지 않을 때는 catch 를 단다
sendEmail(req.body).catch((e) => logger.warn("email.failed", { e }));

// ❌ forEach 는 async 콜백을 기다리지 않는다 — 에러도 잡히지 않는다
items.forEach(async (it) => { await save(it); });
// ✅
for (const it of items) await save(it);           // 순차
await Promise.all(items.map((it) => save(it)));   // 병렬
```

전역 핸들러는 **로그와 정리 후 종료**를 위한 마지막 그물이다. 계속 실행하는 용도가 아니다 — 상태가 망가졌을 수 있다.

```js
process.on("unhandledRejection", (reason) => { logger.error("unhandled", { reason }); process.exitCode = 1; shutdown(); });
process.on("uncaughtException", (err) => { logger.error("uncaught", { err }); process.exit(1); });
```

## Promise 조합기

| 함수 | 끝나는 때 | 결과 | 하나가 실패하면 |
|---|---|---|---|
| `Promise.all` | 전부 성공 or 하나 실패 | 값 배열 | 즉시 거부 (나머지는 **계속 돈다** — 취소되지 않음) |
| `Promise.allSettled` | 전부 끝남 | `{status, value/reason}` 배열 | 상관없음 |
| `Promise.race` | 처음 settle 된 것 | 그 결과 | 처음이 실패면 거부 |
| `Promise.any` | 처음 성공한 것 | 그 값 | 전부 실패해야 `AggregateError` |

```js
const r = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("x"))]);
r.map((x) => x.status);   // ["fulfilled", "rejected"]
```

`Promise.all` 이 실패로 끝나도 **나머지 작업은 취소되지 않는다.** 실패 후에도 다른 요청들이 DB 에 계속 쓴다. 진짜로 멈추려면 취소 신호를 넘겨야 한다.

## 취소와 타임아웃 — AbortController

Node 의 표준 취소 장치는 브라우저와 같은 `AbortController`/`AbortSignal` 이다. `fetch`, `fs.readFile`, `stream.pipeline`, `setTimeout`(timers/promises), `events.once`, `child_process.exec` 가 모두 `signal` 옵션을 받는다.

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 50);                     // 사용자가 취소
const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(1000)]);   // 둘 중 먼저
try {
  await fetch("http://10.255.255.1/", { signal });     // 응답 없는 주소
} catch (e) {
  console.log(e.name);                                 // AbortError (사용자) / TimeoutError (1초)
}
```

| API | 용도 |
|---|---|
| `AbortSignal.timeout(ms)` | ms 뒤 자동 abort (`TimeoutError`) |
| `AbortSignal.any([...])` | 여러 신호 중 하나라도 (Node 20+) |
| `signal.throwIfAborted()` | 긴 루프 중간 점검 |
| `signal.addEventListener("abort", …)` | 직접 만든 비동기 작업에 연결 |

**타임아웃은 연쇄로 전파해야 한다.** 요청 전체 예산이 2초라면 하위 호출에 남은 시간을 넘긴다 — gRPC 의 데드라인 전파와 같은 원리. [API 설계 04](/api-design/notes/04-errors-retries-deadlines) 에서 실측으로 다뤘다.

```js
async function handler(req) {
  const signal = AbortSignal.timeout(2000);
  const user = await getUser(req.id, { signal });          // 같은 signal 공유
  const recs = await getRecs(user, { signal });            // 남은 시간 안에서만
}
```

## 동시성 제한 — 실측

`Promise.all(items.map(fn))` 은 **항목 수만큼 동시에** 시작한다. 1만 개면 소켓·DB 연결 1만 개다.

```js
const task = async () => { active++; peak = Math.max(peak, active); await sleep(20); active--; };

await Promise.all(Array.from({ length: 100 }, task));
// Promise.all 100: 20ms 최대 동시 100

async function pool(n, jobs) {
  const it = jobs[Symbol.iterator]();
  await Promise.all(Array.from({ length: n }, async () => { for (const j of it) await j(); }));
}
await pool(10, Array.from({ length: 100 }, () => task));
// 풀 10: 215ms 최대 동시 10
```

| 방식 | 시간 | 최대 동시 |
|---|---|---|
| `Promise.all` | 20ms | 100 |
| 풀 10 | 215ms | 10 |

빠른 쪽이 좋아 보이지만, 상대가 DB(연결 풀 20개)나 외부 API(초당 50 제한)라면 100 동시 요청은 거절·대기열·장애를 만든다. **동시성은 하류의 용량에 맞춘다.** [PostgreSQL 05](/postgres/notes/05-operations) 의 연결 고갈, [장애 실험실](/chaos) 의 `chaos-pg-connection-exhaustion` 이 그 결과를 보여 준다.

위 `pool` 은 이터레이터 하나를 여러 워커가 나눠 꺼내는 10줄짜리 구현이다. 실무에서는 `p-limit`, `p-map` 을 쓴다.

## 재시도와 백오프

```js
async function retry(fn, { retries = 3, base = 100, signal } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= retries || !isRetryable(e)) throw e;
      const delay = Math.random() * base * 2 ** i;          // 지수 백오프 + 풀 지터
      await setTimeout(delay, undefined, { signal });        // node:timers/promises
    }
  }
}
```

지터가 없으면 동시에 실패한 클라이언트들이 동시에 재시도해 복구 중인 서버를 다시 쓰러뜨린다(재시도 폭풍). 실측은 [장애 실험실 03](/chaos/notes/03-resilience-patterns-verified).

## EventEmitter 의 'error'

```js
const s = net.connect(1, "127.0.0.1");     // 리스너 없이
// → 'error' 이벤트에 리스너가 없으면 throw → uncaughtException → 종료
s.on("error", (e) => logger.warn("conn", { code: e.code }));
```

EventEmitter 는 `'error'` 이벤트만 특별 취급한다: **리스너가 없으면 던진다.** 소켓·스트림·자식 프로세스마다 `on("error")` 를 다는 것이 습관이 되어야 한다. 이벤트를 Promise 로 받을 때는 `events.once(emitter, "ready", { signal })` 이 error 이벤트도 거부로 바꿔 준다.

## 예시로 보기 — 이 프로젝트에서

- **Redis 클라이언트의 error 리스너.** `src/lib/redis.ts` 는 클라이언트를 만들자마자 `client.on("error", () => {})` 를 단다. Redis 가 꺼진 상태에서 리스너가 없으면 재연결 실패마다 `'error'` 가 던져져 **Next.js 서버가 죽는다.** 주석의 "로그 폭주 방지" 는 덤이다.
- **실패해도 되는 작업은 삼킨다.** `src/lib/lab-history.ts` 의 `recordLabRun` 은 `try { … } catch { }` 로 감싸져 있다. 실험 이력 저장이 실패해도 실험 결과 응답은 나가야 한다. 반대로 `recordQuiz` 는 에러를 던져 서버 액션이 `{ ok: false }` 를 돌려주게 한다 — 사용자가 "저장 실패" 를 알아야 하기 때문이다.
- **타임아웃이 있는 fetch.** 환경 점검(`src/lib/env-checks.ts`)의 `fetchText` 는 `AbortSignal.timeout(2500)` 을 건다. 꺼진 서비스에 대한 요청이 대시보드 렌더링을 몇십 초씩 붙잡지 않게 하는 장치다.
- **동시성 제한이 필요한 곳.** 첫 화면은 34개 주제를 `Promise.all` 로 동시에 처리한다. 주제 수가 적고 각 작업이 캐시된 파일 읽기라 괜찮지만, 각 작업이 외부 API 호출이었다면 풀로 제한했어야 한다.

## 실전에서는 어디에 쓰이나

> 비동기 에러 처리와 취소는 "배포 후 프로세스가 갑자기 죽는다", "우리 배치가 하류 서비스를 쓰러뜨렸다" 같은 사고의 단골 원인이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 API | 기다리지 않은 이메일 발송 실패로 프로세스 종료 | `.catch` 로 로그, 또는 큐로 분리 | 아웃박스 + 워커 |
| BFF·API 게이트웨이 | 하위 호출이 전체 시간 예산을 넘김 | `AbortSignal.timeout` 을 하위 호출에 같은 signal 로 전파 | 서비스 메시 타임아웃 |
| 데이터 이관·크롤링 배치 | `Promise.all` 로 동시 수천 요청 | `p-limit` 같은 풀로 하류 용량에 맞춘 동시성 | 큐 + 고정 워커 수 |
| AI 서비스 LLM 호출 | 일시 오류·레이트리밋 응답 | 재시도 가능한 오류만 지수 백오프 + 지터 | 서킷 브레이커 |
| 여러 소스를 모으는 대시보드 | 일부가 실패해도 나머지는 표시 | `Promise.allSettled` | 소스별 캐시 |

**이럴 땐 안 맞는다**
- `unhandledRejection` 전역 핸들러로 계속 실행 — 상태가 망가졌을 수 있다. 로그·정리 후 종료하고 재시작에 맡긴다.
- `Promise.all` 의 실패를 "취소" 로 믿기 — 나머지 작업은 계속 돈다. signal 을 넘겨 실제로 멈춘다.

**누가 매일 만나나** — 백엔드 개발자가 외부 API·DB 를 부르는 모든 코드에서, SRE 가 종료 코드 1 로 재시작되는 Pod 의 로그를 볼 때.

**면접·실무 단골 질문**
- Q. `items.forEach(async …)` 의 문제 → 기다리지 않고 에러도 잡히지 않는다. `for…of` 또는 `Promise.all(map)`.
- Q. `Promise.all`·`allSettled`·`any` 의 차이 → 하나 실패 시 즉시 거부 / 전부의 결과 / 첫 성공.

## 실습 체크리스트

- [ ] 거부를 처리하지 않는 스크립트를 기본값과 `--unhandled-rejections=warn` 으로 돌려 종료 코드 비교
- [ ] `items.forEach(async …)` 가 기다리지 않는 것을 재현하고 `for…of` 로 고치기
- [ ] `AbortSignal.any([사용자, timeout])` 으로 fetch 를 취소하고 에러 이름(AbortError/TimeoutError) 구분
- [ ] 위 `pool` 을 써서 동시성 1·10·100 의 시간과 최대 동시를 표로 만들기
- [ ] 소켓에 error 리스너 없이 연결 실패를 일으켜 프로세스가 죽는 것을 확인
