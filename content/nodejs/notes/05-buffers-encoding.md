---
title: "Buffer · 인코딩 · TypedArray — 바이트를 다루는 법과 힙 밖 메모리"
order: 5
level: 기초
chapter: "2부 · I/O 와 데이터"
summary: "Buffer 가 Uint8Array 의 하위 클래스이고 V8 힙 밖(external/arrayBuffers)에 산다는 사실(50MB 할당 시 heap 3MB · arrayBuffers 50MB 실측), 문자 수와 바이트 수의 차이(UTF-8 한글 3바이트), 청크 경계에서 멀티바이트 문자가 깨지는 문제와 StringDecoder, subarray 는 뷰이고 Buffer.from 은 복사라는 함정(실측), allocUnsafe 와 8KB 풀, base64·hex, 바이너리 프로토콜 읽기와 쓰기"
tags: [Buffer, Uint8Array, TypedArray, ArrayBuffer, UTF-8, 인코딩, StringDecoder, allocUnsafe]
experiments: [node-stream-backpressure]
---

## 문자열은 바이트가 아니다

네트워크·파일·암호화는 **바이트**를 주고받는다. 자바스크립트 문자열은 **UTF-16 코드 유닛**의 나열이다. 둘 사이를 오가는 도구가 `Buffer` 다.

```js
const b = Buffer.from("한글 ok", "utf8");
b;            // <Buffer ed 95 9c ea b8 80 20 6f 6b>
b.length;     // 9 바이트
"한글 ok".length;   // 5 문자(UTF-16 코드 유닛)
Buffer.byteLength("가나다");   // 9
Buffer.from("€").length;       // 3
```

| 개념 | 단위 | 예: "한글 ok" |
|---|---|---|
| `str.length` | UTF-16 코드 유닛 | 5 |
| `Buffer.byteLength(str)` | UTF-8 바이트 | 9 |
| 화면의 글자(grapheme) | 사람이 보는 글자 | 5 (이모지·결합 문자는 더 복잡: `Intl.Segmenter`) |

> **함정:** HTTP `Content-Length`, DB 컬럼 길이(VARCHAR 바이트 vs 문자), Redis 의 값 크기, 메시지 크기 제한은 **바이트**다. `str.length` 로 계산하면 한글에서 1/3 로 틀린다.

## 인코딩

| 인코딩 | 용도 | 주의 |
|---|---|---|
| `utf8` (기본) | 텍스트 | 잘못된 바이트는 U+FFFD(�)로 바뀐다 — 조용한 데이터 손상 |
| `latin1`/`binary` | 바이트 1:1 보존 | 텍스트가 아니라 "바이트를 그대로 담은 문자열" |
| `base64`, `base64url` | 바이너리를 텍스트로 (JSON·URL) | 크기 4/3 배. JWT 는 base64url |
| `hex` | 디버깅, 해시 출력 | 크기 2배 |
| `utf16le` | 윈도우 API | |

```js
Buffer.from("한글").toString("latin1");   // 'íê¸' — 인코딩을 잘못 고르면 이렇게 깨진다(모지바케)
crypto.createHash("sha256").update("x").digest("hex");
Buffer.from(JSON.stringify(obj)).toString("base64url");
```

## 청크 경계에서 글자가 깨진다 — 실측

스트림은 바이트를 **아무 데서나** 자른다. 한글 한 글자(3바이트)가 두 청크에 걸치면, 청크마다 `toString()` 하는 순간 깨진다.

```js
const parts = [Buffer.from([0xea, 0xb0]), Buffer.from([0x80])];   // '가' = ea b0 80
parts.map((p) => p.toString()).join("");     // '��'  ← 깨짐
Buffer.concat(parts).toString();             // '가'
const { StringDecoder } = require("node:string_decoder");
const d = new StringDecoder("utf8");
d.write(parts[0]) + d.write(parts[1]);       // '가'  ← 미완성 바이트를 다음 청크까지 들고 있는다
```

실무에서는 `readable.setEncoding("utf8")` 을 쓰면 내부적으로 StringDecoder 가 붙는다. 로그 수집기·SSE 파서·CSV 파서를 직접 짤 때 이 버그가 자주 나온다. 이 사이트의 `AskPanel` 은 `TextDecoder.decode(value, { stream: true })` 로 같은 문제를 푼다(브라우저 쪽 같은 장치).

## Buffer 는 Uint8Array 다 — 뷰와 복사

```js
Buffer.prototype instanceof Uint8Array;   // true
```

`Buffer` 는 `Uint8Array` 의 하위 클래스이고, 바탕에는 `ArrayBuffer`(진짜 메모리 덩어리)가 있다. 여러 뷰가 같은 메모리를 볼 수 있다.

```js
const b = Buffer.alloc(10);
const s = b.subarray(2, 4);   // 뷰 — 메모리 공유
s[0] = 99;
b[2];                         // 99  ← 원본이 바뀌었다
const c = Buffer.from(b);     // 복사
c[2] = 1;
b[2];                         // 99  ← 원본 그대로
```

| 연산 | 복사? |
|---|---|
| `buf.subarray(a, b)`, `buf.slice(a, b)`(Buffer 에서는 subarray 와 같음 — deprecated) | ❌ 뷰 |
| `new Uint8Array(buf.buffer, buf.byteOffset, buf.length)` | ❌ 뷰 |
| `Buffer.from(buf)`, `Buffer.concat([...])`, `Uint8Array.prototype.slice` | ✅ 복사 |
| `buf.toString()` | ✅ 새 문자열 |

> **함정 1 (누수):** 1MB 응답 버퍼에서 10바이트 헤더만 `subarray` 로 잘라 캐시에 넣으면, **1MB 전체가 캐시에 붙잡힌다**(뷰가 원본 ArrayBuffer 를 참조). 오래 보관할 조각은 `Buffer.from(slice)` 로 복사한다. [11 메모리 누수](/nodejs/notes/11-memory-leaks).
> **함정 2 (byteOffset):** `buf.buffer` 는 Buffer 가 사는 **ArrayBuffer 전체**다. 작은 Buffer 는 8KB 풀에서 잘라 쓰므로 `buf.buffer` 가 8KB 이고 `byteOffset` 이 0 이 아니다. 다른 API(WebAssembly, `TextDecoder`)에 넘길 때 `buf.buffer` 만 넘기면 엉뚱한 바이트가 들어간다.

## alloc, allocUnsafe, 그리고 풀

```js
Buffer.alloc(n);          // 0 으로 채움 — 안전, 약간 느림
Buffer.allocUnsafe(n);    // 초기화 안 함 — 이전에 쓰던 메모리(다른 요청의 비밀번호!)가 보일 수 있다
Buffer.poolSize;          // 8192 — 4KB 이하 allocUnsafe/Buffer.from 은 공유 풀에서 잘라 줌
Buffer.allocUnsafe(8).byteOffset;   // 104 같은 값 — 풀 안의 위치
```

`allocUnsafe` 는 **즉시 전부 덮어쓸 때만**(파일 read 의 대상 버퍼 등) 쓴다. 실수로 안 쓴 부분을 응답에 실으면 메모리 내용이 유출된다(실제 CVE 가 있었다).

## 힙 밖 메모리 — 실측

Buffer 의 바이트는 **V8 힙 밖**에 있다. V8 힙에는 작은 래퍼 객체만 있다.

```bash
$ node -e 'const big = Buffer.alloc(50*1024*1024);
  console.log(process.memoryUsage().heapUsed>>20, "MB heap,", process.memoryUsage().arrayBuffers>>20, "MB arrayBuffers")'
3 MB heap, 50 MB arrayBuffers
```

| `process.memoryUsage()` | 무엇 |
|---|---|
| `heapUsed` / `heapTotal` | V8 힙 (JS 객체) |
| `external` | V8 가 아는 힙 밖 메모리 (Buffer 포함) |
| `arrayBuffers` | 그중 ArrayBuffer·Buffer |
| `rss` | 프로세스 전체 (OS 관점) |

의미:
- `--max-old-space-size` 는 **힙만** 제한한다. Buffer 50MB 는 그 한도와 무관하다 — 컨테이너 메모리 한도에는 걸린다.
- 힙 스냅샷에서 Buffer 는 작게 보이지만 실제로는 큰 메모리를 붙잡는다(실험 `node-leak-detect` 의 Session 이 그랬다 — 얕은 크기 48바이트, 실제로는 4KB payload).
- 실험 `node-stream-backpressure` 에서 백프레셔를 무시하자 **RSS 가 32.3MB** 늘었다. 그 32MB 는 대부분 힙 밖 Buffer 다.

## 바이너리 프로토콜 읽고 쓰기

```js
// 길이 접두 프레임: [4바이트 길이 BE][페이로드]
function encode(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}
function* decode(chunks) {
  let buf = Buffer.alloc(0);
  for (const c of chunks) {
    buf = Buffer.concat([buf, c]);                       // 실무에선 복사를 줄이는 링 버퍼
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0);
      yield JSON.parse(buf.subarray(4, 4 + n).toString());
      buf = buf.subarray(4 + n);
    }
  }
}
```

| 메서드 | 의미 |
|---|---|
| `readUInt32BE/LE`, `readInt16LE`, `readBigUInt64BE` | 정수 읽기 (엔디언 명시) |
| `writeDoubleLE` 등 | 쓰기 |
| `DataView` | TypedArray 표준 방식 — 브라우저 공유 코드 |

TCP 는 메시지 경계를 보장하지 않는다. 한 번의 `data` 이벤트에 메시지 반 개나 세 개가 올 수 있다 — 그래서 위처럼 **프레이밍**이 필요하다. Redis 의 RESP, Kafka 의 프로토콜, gRPC 의 길이 접두가 모두 같은 해법이다([Redis 06 파이프라이닝](/redis/notes/06-pipelining) 에서 RESP 를 봤다).

## TypedArray 가족

| 타입 | 원소 | 용도 |
|---|---|---|
| `Uint8Array` / `Buffer` | 바이트 | 범용 |
| `Int32Array`, `Float64Array` | 숫자 | 수치 계산, 벡터(임베딩) |
| `BigInt64Array` | 64비트 정수 | |
| `SharedArrayBuffer` + TypedArray | 스레드 공유 메모리 | 워커 간 공유 + `Atomics` — [12](/nodejs/notes/12-workers-cluster-child-process) |

임베딩 벡터(384차원 float)를 JSON 숫자 배열로 저장하면 원소당 10~20바이트지만 `Float32Array` 바이트로 저장하면 4바이트다. Redis 벡터 검색이 `FLOAT32` 바이트 블롭을 받는 이유다([Redis 15](/redis/notes/15-redis8-modules)).

## 인코딩별 크기와 비교 — 실측

```bash
$ node b64.mjs
{ raw: 3000, hex: 6000, base64: 4000, base64url: 4000 }
false false
ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
```

| 표현 | 3000 바이트가 차지하는 문자 수 | 배율 |
|---|---|---|
| hex | 6000 | 2배 |
| base64 / base64url | 4000 | 4/3배 |

토큰·서명을 비교할 때 `===` 나 `buf.equals` 는 처음 다른 바이트에서 바로 멈춘다. 응답 시간 차이로 맞은 접두어 길이가 새어 나갈 수 있다. 비밀 값 비교에는 `crypto.timingSafeEqual` 을 쓴다. 단, 길이가 다르면 예외를 던지므로 길이를 먼저 맞추거나 양쪽을 해시한 뒤 비교한다.

## 예시로 보기 — 이 프로젝트에서

- **SSE 청크 디코딩.** `src/components/AskPanel.tsx` 는 `res.body.getReader()` 로 바이트 청크를 받아 `new TextDecoder().decode(value, { stream: true })` 로 문자열을 만들고, `\n\n` 으로 이벤트를 자른다. `{ stream: true }` 가 바로 StringDecoder 역할 — 한글 답변이 청크 경계에서 깨지지 않는 이유다.
- **카드 키 해시.** `src/lib/study.ts` 의 `cardKey` 는 `createHash("sha1").update(...).digest("hex").slice(0, 12)` — 바이트 해시를 hex 문자열로 바꿔 Redis Hash 필드 이름으로 쓴다.
- **실험 결과의 바이트 수.** 실험 `node-stream-backpressure` 의 `maxBuffered` 는 `writable.writableLength`(바이트)다. 무시한 쪽 33,554,432 = 정확히 64KB × 512.

## 실전에서는 어디에 쓰이나

> 바이트 다루기는 업로드, 바이너리 프로토콜, 서명 검증, 스트리밍 텍스트 파싱처럼 "문자열이 아닌 데이터" 가 오가는 곳에서 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| AI 챗 응답 스트리밍 파서 | 청크 경계에서 한글이 깨짐 | `StringDecoder`, `setEncoding`, `TextDecoder({ stream: true })` | 줄 단위로 모은 뒤 디코딩 |
| 결제·웹훅 서명 검증 | 비교 시간 차이로 서명 정보 유출 | HMAC 결과를 `crypto.timingSafeEqual` 로 비교 | 검증 라이브러리 |
| IoT·게임 서버 TCP 프로토콜 | 메시지 경계가 없는 스트림 | 길이 접두 프레이밍, `readUInt32BE` | Protobuf·gRPC |
| 크기 제한이 있는 메시지 API | 문자 수로 계산해 한도 초과 | `Buffer.byteLength` 로 바이트 계산 | 서버 측 검증 |
| AI 임베딩 저장 | 벡터를 JSON 숫자 배열로 두면 큼 | `Float32Array` 바이트로 저장 | 벡터 DB 클라이언트 |

**이럴 땐 안 맞는다**
- 응답에 실릴 수 있는 버퍼에 `allocUnsafe` — 이전 메모리 내용이 샐 수 있다. `alloc` 을 쓰거나 즉시 전부 덮어쓴다.
- 큰 버퍼에서 잘라낸 작은 조각을 캐시에 오래 보관 — 원본 전체가 붙잡힌다. `Buffer.from` 으로 복사한다.

**누가 매일 만나나** — 백엔드 개발자가 업로드·다운로드·서명 검증을 구현할 때, 보안 담당이 토큰 비교 코드를 리뷰할 때, SRE 가 RSS 는 큰데 힙은 작은 프로세스를 볼 때.

**면접·실무 단골 질문**
- Q. 힙 상한을 줬는데 컨테이너가 OOM 나는 이유 → Buffer 는 V8 힙 밖(`arrayBuffers`)이라 `--max-old-space-size` 에 안 잡힌다.
- Q. `subarray` 와 `Buffer.from` 의 차이 → 메모리를 공유하는 뷰 vs 복사.

## 실습 체크리스트

- [ ] 한글·이모지 문자열의 `length` 와 `Buffer.byteLength` 비교
- [ ] 멀티바이트 문자를 두 Buffer 로 쪼개 깨지는 것과 StringDecoder 로 고쳐지는 것 확인
- [ ] `subarray` 로 자른 조각을 수정해 원본이 바뀌는 것 확인, `Buffer.from` 과 비교
- [ ] 50MB Buffer 를 만들고 `process.memoryUsage()` 의 heapUsed·arrayBuffers 비교
- [ ] 위 길이 접두 encode/decode 로 메시지 3개를 임의 위치에서 잘라 넣어도 정확히 복원되는지 테스트
