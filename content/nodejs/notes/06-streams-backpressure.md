---
title: "스트림과 백프레셔 — Readable · Writable · Transform, highWaterMark, pipeline, 그리고 async iterator"
order: 6
level: 중급
chapter: "2부 · I/O 와 데이터"
summary: "큰 데이터를 메모리에 다 올리지 않고 흘려보내는 스트림의 네 종류, 내부 버퍼와 highWaterMark(Node 22 기본 64KB, objectMode 16개), write() 가 false 를 돌려주는 의미와 drain, 반환값을 무시하면 생산량 전체(32MB)가 버퍼에 쌓이고 pipeline 은 64KB 로 묶어 둔다는 실측, pipe 대신 pipeline 을 써야 하는 이유(에러·정리), Transform 작성법, for await 로 읽기, 웹 스트림과의 관계"
tags: [스트림, 백프레셔, highWaterMark, pipeline, Transform, drain, async iterator, Web Streams]
experiments: [node-stream-backpressure]
---

## 왜 스트림인가

1GB 파일을 압축해 업로드한다고 하자.

```js
// ❌ 1GB 를 메모리에 올렸다가 압축본 300MB 를 또 올린다
const data = await fs.readFile("big.log");
await upload(zlib.gzipSync(data));

// ✅ 64KB 씩 읽고 → 압축하고 → 보낸다. 메모리는 수백 KB
await pipeline(fs.createReadStream("big.log"), zlib.createGzip(), uploadStream());
```

스트림은 데이터를 **조각(청크)** 으로 흘려보내는 추상화다. 장점은 두 가지: **메모리가 데이터 크기와 무관**하고, **첫 바이트가 빨리 나간다**(전부 읽을 때까지 기다리지 않음).

| 종류 | 방향 | 예 |
|---|---|---|
| **Readable** | 읽기 | `fs.createReadStream`, HTTP 요청(서버 쪽), `process.stdin` |
| **Writable** | 쓰기 | `fs.createWriteStream`, HTTP 응답, `process.stdout` |
| **Duplex** | 둘 다(독립) | TCP 소켓 |
| **Transform** | 읽은 것을 바꿔 내보냄 | `zlib.createGzip`, `crypto.createHash`, CSV 파서 |

## 내부 버퍼와 highWaterMark

모든 스트림에는 **내부 버퍼**가 있고, `highWaterMark` 가 "이만큼 차면 그만" 의 기준이다.

| | 기본 highWaterMark (Node 22) |
|---|---|
| 바이트 스트림 | **64KB** (`stream.getDefaultHighWaterMark(false)` → 65536; Node 21 까지는 16KB) |
| objectMode | **16개** (객체 수) |
| `fs.createReadStream` | 64KB |

```bash
$ node -e 'const s=require("stream"); console.log(s.getDefaultHighWaterMark(false), s.getDefaultHighWaterMark(true))'
65536 16
```

highWaterMark 는 **상한이 아니라 신호 기준**이다. 넘어서도 데이터는 들어간다 — 그 사실을 알려 줄 뿐이다. 그래서 신호를 무시하면 무한히 쌓인다.

## 백프레셔 — 느린 쪽이 빠른 쪽을 멈추게 하는 약속

![스트림 백프레셔](/diagrams/node-backpressure.svg)

**Writable 쪽:**
```js
const ok = writable.write(chunk);   // false = 내 버퍼가 highWaterMark 를 넘었다. 그만 넣어라
if (!ok) await once(writable, "drain");   // 버퍼가 비면 'drain'
```

**Readable 쪽:** 소비자가 받지 못하면 Readable 의 버퍼가 차고, 차면 Readable 은 더 이상 원천(파일·소켓)에서 읽지 않는다. 소켓이라면 커널 수신 버퍼가 차고, TCP 윈도가 0 이 되어 **상대방 송신까지 멈춘다** — 백프레셔가 네트워크 끝까지 전파된다([Linux 네트워크 02](/linux-network/notes/02-ip-ports-sockets) 의 zero window).

### 실측 — 무시 vs 존중

실험 `node-stream-backpressure`: 64KB × 512 = 32MB 를, 청크마다 1ms 걸리는 느린 Writable 에 보낸다.

| 방식 | 최대 내부 버퍼 | RSS 증가 | 소요 |
|---|---|---|---|
| `write()` 반환값 무시 | **32 MB** (33,554,432 바이트 = 전부) | 32.3 MB | 642ms |
| `pipeline()` | **0.1 MB** (65,536 = highWaterMark 한 개) | 26 MB* | 646ms |

\* pipeline 쪽 RSS 증가는 "동시에 살아 있는" 데이터가 아니라 다 쓴 Buffer 가 아직 GC 되지 않은 것이다. 무시한 쪽은 32MB 가 **실제로 참조 중**이라 GC 해도 줄지 않는다. 데이터가 32MB 가 아니라 32GB 였다면 무시한 쪽은 OOM, pipeline 은 똑같이 64KB 로 돈다.

소요 시간은 둘 다 소비자 속도에 묶여 같다. **백프레셔는 속도가 아니라 메모리 상한을 지키는 장치**다.

## pipe 대신 pipeline

```js
// ❌ 에러가 전파되지 않고, 한쪽이 실패해도 다른 쪽이 닫히지 않아 파일 핸들·소켓이 샌다
src.pipe(gzip).pipe(dest);

// ✅ 어디서 에러가 나든 전체를 정리(destroy)하고 하나의 Promise 로 알려 준다
import { pipeline } from "node:stream/promises";
await pipeline(src, gzip, dest, { signal });
```

| | `.pipe()` | `pipeline()` |
|---|---|---|
| 백프레셔 | ✅ | ✅ |
| 에러 전파 | ❌ 각 스트림에 직접 | ✅ 하나로 |
| 실패 시 나머지 destroy | ❌ | ✅ |
| 취소 (`signal`) | ❌ | ✅ |
| async 함수·제너레이터를 단계로 | ❌ | ✅ |

`pipeline` 은 async 제너레이터를 중간 단계로 받는다 — Transform 클래스를 만들 필요가 거의 없다.

```js
await pipeline(
  fs.createReadStream("access.log"),
  async function* (source) {               // 줄 단위 변환
    let rest = "";
    for await (const chunk of source) {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const l of lines) if (l.includes(" 500 ")) yield l + "\n";
    }
    if (rest.includes(" 500 ")) yield rest;
  },
  fs.createWriteStream("errors.log"),
);
```

`for await` 는 소비자가 다음 청크를 요청할 때만 읽으므로 백프레셔가 자동으로 걸린다.

## Transform 직접 만들기

```js
import { Transform } from "node:stream";
const upper = new Transform({
  transform(chunk, enc, cb) { cb(null, chunk.toString().toUpperCase()); },   // 바이트 → 바이트
  flush(cb) { cb(); },                                                        // 끝에 남은 것 내보내기
});

// 객체 스트림: 줄 → JSON 객체
const parse = new Transform({
  readableObjectMode: true,
  transform(line, _e, cb) { try { cb(null, JSON.parse(line)); } catch (e) { cb(e); } },
});
```

규칙: `cb` 를 **정확히 한 번** 부른다. `this.push()` 로 여러 개를 내보낼 수도 있다. 에러는 `cb(err)` — `throw` 하면 안 된다(비동기 콜백이라 잡히지 않는다).

## 읽기 모드 두 가지

| 모드 | 진입 | 특징 |
|---|---|---|
| **paused** (기본) | — | `read()` 로 당겨 감 |
| **flowing** | `on('data')`, `pipe`, `resume()` | 데이터가 밀려옴 — 리스너가 느려도 계속 옴 |

`on('data')` 로 받으면서 비동기 처리를 하면 백프레셔가 없다:

```js
// ❌ 각 청크마다 DB 저장을 시작만 하고 다음 청크가 계속 온다 → 동시 저장 수천 개
readable.on("data", async (c) => { await db.insert(c); });

// ✅ 하나씩
for await (const c of readable) await db.insert(c);
```

## 웹 스트림과의 관계

Node 18+ 에는 브라우저와 같은 **Web Streams**(`ReadableStream`, `WritableStream`, `TransformStream`)가 있다. `fetch` 의 `res.body`, Next.js 라우트 핸들러의 응답이 이것이다.

```js
import { Readable } from "node:stream";
const nodeReadable = Readable.fromWeb(res.body);       // Web → Node
const webReadable = Readable.toWeb(fs.createReadStream("x"));   // Node → Web
```

Web Streams 는 `highWaterMark` 대신 **queuing strategy**, `drain` 대신 `controller.desiredSize`·`writer.ready` Promise 로 같은 백프레셔를 표현한다.

## 읽기 쪽 버퍼 — 실측

쓰기만이 아니라 Readable 도 highWaterMark 까지만 미리 읽는다. 소비자가 읽지 않으면 `_read()` 호출이 멈춘다.

```bash
$ node om.mjs
objectMode produced before consume: 16 readableLength 16 hwm 16
bytes 1KB chunks buffered: 65536 hwm 65536
```

| 스트림 | 소비 전에 미리 만든 양 | 기준 |
|---|---|---|
| objectMode | 객체 16개 | 개수 |
| 바이트 | 1KB 청크 64개 (65,536 바이트) | 바이트 |

objectMode 의 16 은 **개수**라서, 객체 하나가 10MB 짜리 행이면 160MB 를 미리 읽는다. DB 커서·대용량 JSON 행을 objectMode 로 흘릴 때는 highWaterMark 를 1~4 로 줄이는 것이 안전하다.

## 예시로 보기 — 이 프로젝트에서

- **SSE 응답은 Web ReadableStream 이다.** `src/app/api/ask/route.ts` 는 `new ReadableStream({ async start(controller) { … controller.enqueue(encoder.encode(…)) } })` 로 응답을 만든다. 모델 토큰이 올 때마다 enqueue 하고, Next.js 가 이를 HTTP 응답 소켓으로 흘린다. 다만 `start()` 안에서 계속 enqueue 하는 방식이라 **소비자가 느려도 멈추지 않는다** — 토큰 속도가 느려 문제가 없지만, 수 MB 를 밀어 넣는 스트림이라면 `pull()` 기반으로 바꿔 `desiredSize` 를 존중해야 한다.
- **실험 출력 캡처.** 셸 실험 러너의 `execFile` 은 자식 출력 전체를 `maxBuffer`(16MB) 까지 메모리에 모은다 — 스트림이 아니다. k6 같은 큰 출력은 그 한도에 걸릴 수 있다. 진짜 큰 출력을 다룬다면 `spawn` 의 `stdout` 스트림으로 바꿔 줄 단위로 처리해야 한다.
- **로그.** `src/lib/log.ts` 는 `fs.createWriteStream(LOG_FILE, { flags: "a" })` 를 한 번 열어 두고 `fileStream()?.write(line + "\n")` 으로 쓴다 — 줄마다 open/close 하는 `appendFile` 보다 훨씬 싸다. 다만 `write()` 의 반환값을 보지 않으므로, 디스크가 밀리는 상황에서 로그가 폭주하면 내부 버퍼에 쌓인다. 개인 사이트의 로그량이면 문제없지만, 고부하 서비스라면 반환값이 false 일 때 로그를 버리거나 샘플링하는 정책(pino 의 비동기 전송처럼)이 필요하다 — 로그 때문에 서비스가 OOM 나는 것은 흔한 사고다([관측성 05](/observability/notes/05-logging-loki)).

## 실습 체크리스트

- [ ] 실험 `node-stream-backpressure` 를 돌려 두 방식의 최대 버퍼·RSS 비교
- [ ] `write()` 반환값을 보고 `drain` 을 기다리는 버전을 손으로 작성
- [ ] `src.pipe(dest)` 에서 src 에 에러를 일으켜 dest 가 닫히지 않는 것을 확인하고 `pipeline` 으로 고치기
- [ ] async 제너레이터 단계로 로그 파일에서 500 줄만 골라 쓰기
- [ ] `Readable.fromWeb(await fetch(url).then(r => r.body))` 로 큰 파일을 디스크에 스트리밍 저장
