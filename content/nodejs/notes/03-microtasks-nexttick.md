---
title: "마이크로태스크와 nextTick — Promise 잡 큐, queueMicrotask, 그리고 nextTick 기아"
order: 3
level: 중급
chapter: "1부 · 구조와 이벤트 루프"
summary: "이벤트 루프 단계와 별개로 콜백 하나가 끝날 때마다 비워지는 두 개의 큐(nextTick 큐, V8 마이크로태스크 큐), CommonJS 에서는 nextTick 이 먼저지만 ES 모듈 최상위에서는 Promise 가 먼저 도는 이유(실측), await 가 실제로 무엇으로 번역되는지, 마이크로태스크로는 I/O 에 양보할 수 없다는 사실(실측), nextTick·Promise 재귀가 루프를 굶기는 기아 현상, 언제 무엇을 써야 하는지"
tags: [마이크로태스크, nextTick, Promise, queueMicrotask, await, 기아, ESM, CommonJS]
experiments: [node-event-loop-order]
---

## 큐가 두 층이다

[02 이벤트 루프의 단계](/nodejs/notes/02-event-loop-phases) 의 여섯 단계는 **매크로태스크**(타이머, I/O, immediate)를 다룬다. 그 사이사이에 두 개의 큐가 더 있다.

| 큐 | 누가 관리 | 무엇이 들어가나 |
|---|---|---|
| **nextTick 큐** | Node (JS 구현) | `process.nextTick(fn)` |
| **마이크로태스크 큐** | V8 | Promise 의 `then/catch/finally` 콜백, `await` 이후의 이어 실행, `queueMicrotask(fn)` |

규칙은 하나다: **JS 콜백 하나가 끝나면(스택이 비면), 다음 매크로태스크로 가기 전에 nextTick 큐를 다 비우고, 이어서 마이크로태스크 큐를 다 비운다.** 비우는 도중 새로 들어온 것도 같이 비운다.

![마이크로태스크와 nextTick](/diagrams/node-microtasks.svg)

```js
setTimeout(() => log("timeout"), 0);
setImmediate(() => log("immediate"));
process.nextTick(() => log("nextTick"));
Promise.resolve().then(() => log("promise"));
queueMicrotask(() => log("microtask"));
log("sync");
```

## CommonJS 와 ES 모듈에서 순서가 다르다 — 실측

실험 `node-event-loop-order` 가 같은 코드를 `.cjs` 와 `.mjs` 로 각각 20번씩 돌렸다.

| 모듈 형식 | 동기 코드 직후 순서 (20/20 일정) |
|---|---|
| CommonJS (`.cjs`) | `sync → nextTick → promise → microtask` |
| ES 모듈 (`.mjs`) | `sync → promise → microtask → nextTick` |

교과서에서 "nextTick 이 Promise 보다 먼저" 라고 배웠다면 반만 맞다. 이유는 **ES 모듈의 최상위 코드가 이미 마이크로태스크 안에서 실행되기** 때문이다. ESM 로더는 모듈 평가를 Promise 로 진행한다. 최상위 코드가 끝나는 시점은 "어떤 마이크로태스크의 중간" 이고, V8 은 그 마이크로태스크 큐를 끝까지 비운다. 그동안 promise·microtask 가 실행되고, 마이크로태스크 처리가 끝난 뒤에야 Node 가 nextTick 큐를 본다.

CommonJS 의 최상위 코드는 일반 함수 호출이라, 끝난 직후 Node 가 nextTick 큐 → 마이크로태스크 큐 순서로 비운다.

> **교훈:** nextTick 과 Promise 의 상대 순서에 의존하지 말라. 같은 파일이 확장자만 바뀌어도(혹은 번들러가 형식을 바꿔도) 순서가 뒤집힌다. 이 사이트는 Next.js 가 ESM 으로 번들한다.

## await 는 무엇으로 번역되나

```js
async function f() {
  log("A");
  await g();        // g() 의 Promise 가 settle 되면
  log("B");         // 이 줄부터는 '마이크로태스크' 로 이어서 실행
}
```

`await x` 는 대략 `Promise.resolve(x).then(나머지)` 다. 그래서:

- `await` 뒤의 코드는 **같은 동기 실행 안에서** 이어지지 않는다. 최소 한 번 마이크로태스크를 거친다.
- 이미 해결된 값(`await 1`)도 마찬가지로 한 번은 큐를 거친다.
- 두 `async` 함수의 `await` 지점 사이에 다른 코드가 끼어들 수 있다 — JS 의 경합은 **여기서** 생긴다.

```js
let balance = 100;
async function withdraw(n) {
  const cur = balance;          // 읽고
  await audit(n);               // ← 여기서 다른 withdraw 가 끼어들 수 있다
  balance = cur - n;            // 쓰기 — 낡은 값 기준!
}
await Promise.all([withdraw(30), withdraw(30)]);   // balance = 70 (기대 40)
```

단일 스레드라 데이터 경합(data race)은 없지만 **논리적 경합(race condition)은 있다.** 같은 패턴이 이벤트 소싱의 낙관적 동시성 문제다 — [이벤트 소싱 03](/event-sourcing/notes/03-event-store), 일반론은 [동시성 프로그래밍](/concurrency).

## 마이크로태스크로는 양보할 수 없다 — 실측

"긴 작업 중간에 `await` 를 넣으면 다른 일이 끼어들겠지" 는 **틀렸다.** 마이크로태스크 큐는 같은 단계 안에서 다 비워지므로, 타이머·I/O 는 끼어들지 못한다.

```js
let ran = false; setTimeout(() => (ran = true), 0);
(async () => {
  const t = Date.now(); while (Date.now() - t < 5) {}           // 타이머가 만료되도록
  for (let i = 0; i < 1000; i++) await Promise.resolve();
  console.log("await Promise.resolve 1000번 후 timeout 실행됨?", ran);
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  console.log("setImmediate 양보 후?", ran);
})();
```

```bash
await Promise.resolve 1000번 후 timeout 실행됨? false
setImmediate 양보 후? true
```

`await` 를 천 번 해도 타이머는 실행되지 않았다. **진짜 양보는 매크로태스크로**(setImmediate, setTimeout) 해야 한다. 이게 [02](/nodejs/notes/02-event-loop-phases) 의 `processInChunks` 가 `setImmediate` 를 쓰는 이유다.

## 기아(starvation) — 실측

큐를 "끝까지" 비운다는 규칙은 위험하다. nextTick 이나 Promise 가 자기 자신을 계속 등록하면 루프가 다음 단계로 못 간다.

```js
let n = 0; const t0 = Date.now();
setTimeout(() => console.log(`timeout 실행 — 그 사이 nextTick ${n}번, ${Date.now()-t0}ms`), 0);
function tick() { if (++n < 1e6) process.nextTick(tick); }
tick();
```

```bash
timeout 실행 — 그 사이 nextTick 1000000번, 34ms
timeout 실행 — 그 사이 Promise 1000000번, 16ms     # 같은 실험을 Promise.resolve().then 으로
```

백만 번이 다 끝날 때까지 0ms 타이머가 기다렸다. 백만에서 멈추게 했으니 34ms 지만, **멈추는 조건이 없으면 영원히** 타이머도 I/O 도 처리되지 않는다 — 서버는 CPU 100% 로 응답하지 않는다. 재귀적인 비동기 처리(스트림 직접 구현, 재시도 루프)에서 실제로 일어난다.

## 무엇을 언제 쓰나

| 원하는 것 | 쓸 것 | 이유 |
|---|---|---|
| 지금 함수가 끝난 직후, I/O 보다 먼저 | `queueMicrotask` / Promise | 표준(브라우저와 같음), 예측 가능 |
| API 를 일관되게 비동기로 (동기로 돌려줄 수 있어도) | `queueMicrotask` 또는 `process.nextTick` | "때로는 동기, 때로는 비동기" 인 API(Zalgo)를 피한다 |
| 생성자 안에서 만든 EventEmitter 의 이벤트를, 호출자가 리스너를 단 뒤에 | `process.nextTick` | Node 코어의 관용구 |
| I/O 에 양보 | `setImmediate` | 다음 check 단계 |
| 일정 시간 뒤 | `setTimeout` | |
| 브라우저와 공유하는 코드 | `queueMicrotask` | nextTick 은 Node 전용 |

Node 문서 자체가 새 코드에는 `queueMicrotask` 를 권한다. `process.nextTick` 은 코어 내부와 오래된 관용구 용도로 남아 있다.

### Zalgo 예

```js
// ❌ 캐시에 있으면 동기, 없으면 비동기 — 호출자의 코드 순서가 상황마다 달라진다
function get(key, cb) {
  if (cache.has(key)) return cb(null, cache.get(key));
  db.get(key, cb);
}
// ✅ 항상 비동기
function get(key, cb) {
  if (cache.has(key)) return queueMicrotask(() => cb(null, cache.get(key)));
  db.get(key, cb);
}
```

## 실행 순서를 손으로 예측해 보기

```js
console.log(1);
setTimeout(() => console.log(2), 0);
Promise.resolve().then(() => {
  console.log(3);
  process.nextTick(() => console.log(4));
  Promise.resolve().then(() => console.log(5));
});
process.nextTick(() => console.log(6));
setImmediate(() => console.log(7));
console.log(8);
```

CommonJS 기준 풀이:
1. 동기: `1`, `8`
2. nextTick 큐: `6`
3. 마이크로태스크 큐: `3` (그 안에서 nextTick 4 와 Promise 5 등록) → 같은 큐 계속 비움: `5`
4. 마이크로태스크가 비었으니 nextTick 큐를 다시 확인: `4`
5. 루프: timers(`2`) 와 check(`7`) — 순서는 02 노트대로 실행마다 다를 수 있다

결과: `1 8 6 3 5 4 (2 7 또는 7 2)`. 실제로 세 번 돌린 결과:

```bash
$ node pred.cjs   →  1 8 6 3 5 4 7 2
$ node pred.cjs   →  1 8 6 3 5 4 2 7
$ node pred.cjs   →  1 8 6 3 5 4 2 7
$ node pred.mjs   →  1 8 3 5 6 4 7 2        # ESM 은 Promise(3,5)가 nextTick(6)보다 먼저
```

앞 여섯 개는 항상 같고, 2·7 은 실행마다 바뀐다. ESM 에서는 위 표대로 nextTick 6 이 3·5 뒤로 밀린다.

## 예시로 보기 — 이 프로젝트에서

- **서버 액션은 Promise 체인이다.** `src/actions/study.ts` 의 `recordQuizAction` 은 `await recordQuiz()` → Redis HGET → HSET 을 차례로 기다린다. 각 `await` 마다 마이크로태스크 경계가 있고, 그 사이 다른 요청의 코드가 실행된다. 같은 카드에 대한 두 요청이 동시에 오면 `prevRaw` 를 둘 다 같은 값으로 읽어 하나가 덮어쓸 수 있다 — 개인용 사이트라 허용하지만, 정확해야 한다면 Redis 의 원자 연산(Lua, WATCH)이 필요하다. [Redis 05 트랜잭션·Lua](/redis/notes/05-transactions-lua).
- **SSE 스트림의 `for await`.** `src/app/api/ask/route.ts` 의 `for await (const chunk of res)` 는 청크마다 마이크로태스크로 이어지고, 청크가 아직 안 왔으면 진짜로 I/O 를 기다린다(소켓 데이터 = poll 단계). 그래서 스트리밍 중에도 다른 요청이 처리된다.
- **데드맨 스위치의 `disarm`.** `process.kill(-pid)` 는 동기 호출이라 마이크로태스크와 무관하게 즉시 실행된다. 반대로 `finally` 블록 안의 `await exec("docker", ["unpause", …])` 는 자식 프로세스 종료(이벤트)를 기다리는 진짜 비동기다.

## 실전에서는 어디에 쓰이나

> 마이크로태스크 규칙은 "await 를 넣었는데 왜 다른 일이 안 끼어드나", "동시 요청에서만 값이 틀린다", "번들 후 순서가 바뀌었다" 같은 버그에서 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 포인트·잔액 처리 | `await` 사이 끼어들기로 갱신 유실 | 읽기-쓰기를 직렬화(뮤텍스 Promise)하거나 원자 연산으로 | DB 트랜잭션, Redis Lua |
| 대용량 데이터 처리 API | `await` 만으로는 I/O 에 양보가 안 됨 | 청크 사이 `setImmediate` 로 양보 | 워커 스레드 |
| SDK·라이브러리 개발 | 때로 동기·때로 비동기인 콜백(Zalgo) | `queueMicrotask` 로 항상 비동기 | Promise 반환 API |
| 재시도 루프·스트림 직접 구현 | nextTick·Promise 재귀로 루프 기아 | 재귀 지점을 매크로태스크로 | 표준 스트림·라이브러리 |
| CJS → ESM 전환 프로젝트 | 확장자만 바꿨는데 실행 순서 변화 | nextTick·Promise 상대 순서에 의존하지 않게 수정 | — |

**이럴 땐 안 맞는다**
- 긴 CPU 작업 중간의 `await Promise.resolve()` 로 "양보" — 마이크로태스크라 타이머·I/O 가 못 끼어든다. `setImmediate` 나 워커.
- 새 코드에서 `process.nextTick` — 브라우저와 공유할 수 없고 기아 위험이 있다. `queueMicrotask`.

**누가 매일 만나나** — 백엔드 개발자가 동시 요청에서만 재현되는 데이터 꼬임을 디버깅할 때, 라이브러리 작성자가 이벤트 발행 시점을 설계할 때.

**면접·실무 단골 질문**
- Q. 단일 스레드인데 경합이 생기나 → 데이터 경합은 없지만 `await` 경계에서 논리적 경합(race condition)은 생긴다.
- Q. nextTick 과 Promise 중 무엇이 먼저 → CommonJS 는 nextTick, ESM 최상위는 Promise. 순서에 의존하지 않는다.

## 실습 체크리스트

- [ ] 위 "손으로 예측" 코드를 `.cjs` 와 `.mjs` 로 각각 돌려 순서 차이 확인
- [ ] `await Promise.resolve()` 와 `await new Promise(r => setImmediate(r))` 의 양보 차이 재현
- [ ] nextTick 재귀로 타이머가 굶는 것을 재현하고, `setImmediate` 재귀로 바꿔 해결
- [ ] `withdraw` 경합 예제를 돌려 잔액이 틀리는 것을 확인하고, 직렬화(뮤텍스 Promise)로 고치기
- [ ] Zalgo API 를 하나 만들고 `queueMicrotask` 로 고치기
