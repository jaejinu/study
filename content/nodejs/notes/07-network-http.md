---
title: "네트워크와 HTTP — net · http 서버, keep-alive, 에이전트 풀, fetch(undici), 그리고 연결 수의 함정"
order: 7
level: 중급
chapter: "2부 · I/O 와 데이터"
summary: "net 모듈의 TCP 서버·클라이언트와 이벤트, http 서버가 요청을 처리하는 흐름과 타임아웃 세 가지(keepAliveTimeout·headersTimeout·requestTimeout), 클라이언트 keep-alive 가 순차 300요청을 95ms→17ms·연결 300개→1개로 바꾸는 실측, fetch(undici) 전역 디스패처가 연결 수를 제한하지 않아 300 동시 요청에서 accept 큐(somaxconn 128)를 넘쳐 73건이 ECONNRESET 로 실패한 실측과 maxSockets 로 막는 법, 로드밸런서 뒤 keep-alive 타임아웃 불일치로 생기는 502"
tags: [net, http, keep-alive, http.Agent, fetch, undici, 연결 풀, somaxconn, keepAliveTimeout, 502]
experiments: []
---

## TCP — net 모듈

```js
import net from "node:net";
const server = net.createServer((sock) => {
  sock.setNoDelay(true);                 // Nagle 끄기 — 작은 응답의 지연 제거
  sock.setKeepAlive(true, 30_000);       // TCP keepalive(죽은 연결 감지) — HTTP keep-alive 와 다르다
  sock.on("data", (buf) => sock.write(buf));   // 에코
  sock.on("error", (e) => {});           // 리스너 필수 (04 노트)
}).listen(9000, "127.0.0.1", 511);       // backlog 511 요청 (실제 상한은 OS somaxconn)
```

| 이벤트 | 의미 |
|---|---|
| `connection` (서버) | accept 됨 |
| `data` | 바이트 도착 — **메시지 경계 없음**(05 노트의 프레이밍) |
| `end` | 상대가 쓰기를 닫음(FIN) — 이쪽은 아직 쓸 수 있다(half-close) |
| `close` | 완전히 닫힘 |
| `error` | ECONNRESET, EPIPE, ETIMEDOUT … |

`listen` 의 backlog 와 accept 큐는 [Linux 네트워크 02](/linux-network/notes/02-ip-ports-sockets) 의 그 큐다. Node 가 511 을 요청해도 **OS 의 somaxconn 이 상한**이다 — 이 Mac 은 128 이다. 아래 fetch 실측에서 이 숫자가 그대로 드러난다.

## HTTP 서버가 요청을 처리하는 흐름

```js
const server = http.createServer(async (req, res) => {
  // req: Readable (본문), res: Writable
  let body = ""; for await (const c of req) body += c;     // 본문은 스트림으로 온다
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
```

1. 소켓 데이터 → **llhttp** 가 파싱 → 헤더가 끝나면 `request` 이벤트 (본문은 아직 안 왔을 수 있다)
2. 핸들러가 `req` 를 읽고 `res` 에 쓴다
3. `res.end()` 후 keep-alive 면 소켓을 다음 요청을 위해 남긴다

### 서버 타임아웃 세 가지

```bash
$ node -e 'const s=require("http").createServer(); console.log(s.keepAliveTimeout, s.headersTimeout, s.requestTimeout)'
5000 60000 300000
```

| 설정 | 기본 | 의미 | 왜 중요 |
|---|---|---|---|
| `keepAliveTimeout` | 5초 | 요청 사이 유휴 연결을 닫기까지 | **로드밸런서보다 짧으면 502** (아래) |
| `headersTimeout` | 60초 | 헤더 수신 완료까지 | Slowloris(헤더를 조금씩 보내 연결 묶기) 방어 |
| `requestTimeout` | 300초 | 요청 전체 수신까지 | 느린 업로드 공격 방어 |
| `server.timeout` | 0 (없음) | 소켓 유휴 | |

## 클라이언트 keep-alive — 실측

HTTP/1.1 은 연결을 재사용할 수 있다(keep-alive). 재사용하지 않으면 요청마다 TCP 3-way 핸드셰이크(+TLS 면 핸드셰이크 한 번 더)를 한다.

```js
async function seq(agent, n = 300) {
  for (let i = 0; i < n; i++)
    await new Promise((res) => http.get({ port, agent }, (r) => { r.resume(); r.on("end", res); }));
}
await seq(new http.Agent({ keepAlive: false }));
await seq(new http.Agent({ keepAlive: true }));
```

| 순차 300요청 (로컬 서버) | 시간 | 서버가 받은 새 연결 |
|---|---|---|
| `keepAlive: false` | 95ms | **300** |
| `keepAlive: true` | 17ms | **1** |

로컬호스트라 RTT 가 거의 0 인데도 5.6배 차이다. 실제 네트워크(RTT 20ms)에서는 핸드셰이크 한 번이 20ms 이므로 차이가 훨씬 크다. TLS 까지 더하면 [네트워크 프로토콜 03](/network-protocols/notes/03-tls13-handshake) 의 핸드셰이크 비용이 요청마다 붙는다.

> **주의:** `r.resume()` 처럼 **응답 본문을 끝까지 소비해야** 소켓이 풀로 돌아간다. 본문을 읽지 않고 버리면 소켓이 묶여 풀이 고갈된다 — 흔한 누수다.

### http.Agent 옵션

| 옵션 | 기본 | 의미 |
|---|---|---|
| `keepAlive` | Node 19+ 전역 에이전트는 `true` | 연결 재사용 |
| `maxSockets` | Infinity | 호스트당 최대 동시 연결 — **넘으면 큐에서 대기** |
| `maxFreeSockets` | 256 | 유휴로 보관할 수 |
| `timeout` | — | 소켓 유휴 타임아웃 |
| `scheduling` | `lifo` | 최근 쓴 소켓 우선(따뜻한 연결) |

## fetch(undici) 와 연결 수 — 실측

Node 18+ 의 전역 `fetch` 는 **undici** 로 구현돼 있고, 전역 디스패처(Agent)를 쓴다. keep-alive 는 기본으로 켜져 있다.

```bash
fetch 순차 300: 66ms, 새 연결 2개        # 재사용 잘 된다
```

그런데 동시 요청을 보내면 이야기가 다르다. 기본 디스패처는 **호스트당 연결 수를 제한하지 않는다.**

```js
await Promise.allSettled(Array.from({ length: n }, () => fetch(url).then((r) => r.text())));
```

| 방식 | 동시 요청 | 실패 | 새 연결 |
|---|---|---|---|
| fetch (기본) | 100 | 0 | 100 |
| fetch (기본) | **300** | **73** (`ECONNRESET` at connect) | 128 |
| `http.Agent({ keepAlive: true, maxSockets: 50 })` | 300 | 0 | 50 |

300개 동시 fetch 가 연결 300개를 **한꺼번에** 열려고 했고, 서버의 accept 큐가 **somaxconn 128** 에서 넘쳐 커널이 RST 를 보냈다. Node 서버 코드는 아무 잘못이 없는데 클라이언트에서 `fetch failed` 가 터진다.

해결:
```js
import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 50, keepAliveTimeout: 10_000 }));   // 호스트당 50
// 또는 요청 단위로 동시성 제한 (04 노트의 pool)
```

**교훈:** "연결 풀" 은 성능 장치이기 전에 **하류를 보호하는 장치**다. 동시성 제한이 없는 클라이언트는 상대 서버(그리고 커널 큐)를 쓰러뜨린다.

## 로드밸런서 뒤의 502 — keep-alive 타임아웃 불일치

흔한 운영 사고:

```
클라이언트 → ALB/Nginx (유휴 60초) → Node (keepAliveTimeout 5초)
```

1. LB 가 Node 와의 연결을 재사용하려고 들고 있다.
2. Node 는 5초 유휴 후 연결을 닫는다(FIN).
3. **같은 순간** LB 가 그 연결로 새 요청을 보낸다 → Node 는 이미 닫음 → RST → LB 는 **502**.

규칙: **업스트림(Node)의 keepAliveTimeout 이 LB 의 유휴 타임아웃보다 길어야 한다.**

```js
server.keepAliveTimeout = 65_000;   // LB(60초)보다 길게
server.headersTimeout = 66_000;     // keepAliveTimeout 보다 길게 (예전 버전 버그 회피)
```

Nginx 를 앞에 둔다면 `upstream { keepalive 16; keepalive_timeout 60s; }` 와 Node 쪽 값을 맞춘다 — [Nginx 02](/nginx/notes/02-reverse-proxy-lb).

## 응답을 스트리밍할 때

```js
res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
const t = setInterval(() => res.write(`data: ${Date.now()}\n\n`), 1000);
req.on("close", () => clearInterval(t));   // 클라이언트가 떠나면 정리 — 없으면 타이머·소켓 누수
```

- 프록시가 버퍼링하지 않게 `X-Accel-Buffering: no`(Nginx).
- 클라이언트 연결이 끊긴 것을 `req.on("close")` 나 `AbortSignal` 로 감지해 **하류 작업도 취소**한다(LLM 호출 같은 비싼 작업).

## 요청 타임아웃과 취소 — 실측

fetch 에는 기본 타임아웃이 없다(정확히는 undici 의 headersTimeout·bodyTimeout 300초). 상대가 응답하지 않으면 그만큼 기다리며 연결과 메모리를 붙잡는다. 호출마다 `signal` 을 준다.

```js
await fetch(url, { signal: AbortSignal.timeout(200) });   // 서버는 2초 뒤에 응답
```

```text
TimeoutError The operation was aborted due to timeout 202ms
server saw close: true
```

| 관찰 | 의미 |
|---|---|
| 202ms 에 `TimeoutError` | 사용자 취소(`AbortError`)와 이름이 달라 구분해서 재시도 여부를 정할 수 있다 |
| 서버 쪽 `req.on("close")` 발생 | 클라이언트가 연결을 끊었다. 서버도 이 신호로 DB 쿼리 등 남은 일을 멈춰야 한다 |

서버에서 상위 요청이 끊겼는데 하위 호출을 계속하면 아무도 받지 않을 결과에 자원을 쓴다. 요청 단위 AbortController 를 만들어 `req.on("close")` 에서 abort 하고 하위 fetch·쿼리에 전파하는 것이 데드라인 전파다([API 설계 04](/api-design/notes/04-errors-retries-deadlines)).

## 예시로 보기 — 이 프로젝트에서

- **환경 점검의 fetch 와 타임아웃.** `src/lib/env-checks.ts` 의 `fetchText` 는 Prometheus·Loki·OpenSearch 등을 `fetch(url, { signal: AbortSignal.timeout(2500) })` 로 찌른다. 대시보드 하나가 서비스 3~4개를 동시에 확인하므로 연결 수는 작지만, 꺼진 서비스가 2.5초 이상 렌더링을 잡지 못한다.
- **AI 에게 묻기의 스트림 정리.** `AskPanel` 의 "중단" 버튼은 `AbortController.abort()` 로 fetch 를 끊는다. 서버 쪽 `route.ts` 는 스트림이 닫혀도 진행 중인 OpenAI 호출을 계속 기다리는데, 여기에 `req.signal` 을 OpenAI 호출로 넘기면 사용자가 떠난 뒤의 토큰 비용까지 아낄 수 있다(개선 여지).
- **Redis 는 HTTP 가 아니지만 같은 원리.** ioredis 는 연결 하나에 명령을 파이프라인처럼 실어 보낸다 — keep-alive 의 극단적인 형태다. 반대로 `createRedis()` 로 만든 별도 연결을 닫지 않으면 연결이 샌다(Redis 의 `connected_clients` 가 계속 증가).
- **브로커 벤치의 동시성.** 메시징 실험이 1만 메시지를 500개 묶음으로 보낸 것도 같은 이유다 — 한 번에 1만 개를 동시에 보내면 클라이언트 버퍼와 서버 큐가 넘친다.

## 실전에서는 어디에 쓰이나

> 서비스 간 HTTP 호출이 많은 백엔드라면 keep-alive·연결 풀·타임아웃 설정이 곧 장애 예방이다. 로드밸런서 뒤 502 와 연결 폭주가 대표 사고다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| ALB·Nginx 뒤의 Node API | 간헐적 502 | `keepAliveTimeout` 을 LB 유휴 타임아웃보다 길게 | LB 유휴 타임아웃을 줄임 |
| 마이크로서비스 간 호출 | 요청마다 TCP·TLS 핸드셰이크 | keep-alive 에이전트로 연결 재사용 | gRPC(HTTP/2 다중화) |
| 외부 API 를 대량으로 부르는 배치 | 동시 fetch 가 상대 accept 큐를 넘김 | undici `Agent({ connections })` 로 호스트당 상한 | 요청 단위 동시성 풀 |
| AI 챗 SSE 서버 | 사용자가 떠난 뒤에도 LLM 호출 계속 | `req.on("close")` 에서 abort 해 하류 취소 | — |
| 공개 웹 서버 | Slowloris·느린 업로드 | `headersTimeout`·`requestTimeout` | 앞단 프록시가 버퍼링·차단 |

**이럴 땐 안 맞는다**
- 타임아웃 없는 fetch 로 외부 호출 — 기본 수 분 동안 연결과 메모리를 붙잡는다. 호출마다 `signal` 을 준다.
- 응답 본문을 읽지 않고 버리기 — 소켓이 풀로 돌아가지 않아 고갈된다. 끝까지 소비하거나 명시적으로 버린다.

**누가 매일 만나나** — 백엔드 개발자가 서비스 간 클라이언트를 설정할 때, SRE·네트워크 엔지니어가 LB 502 나 `ECONNRESET` 을 조사할 때.

**면접·실무 단골 질문**
- Q. LB 뒤에서 502 가 간헐적으로 나는 이유 → 업스트림이 keep-alive 연결을 먼저 닫아, LB 가 재사용하던 연결에 RST.
- Q. HTTP keep-alive 와 TCP keepalive 의 차이 → 연결 재사용 vs 죽은 연결 감지.

## 실습 체크리스트

- [ ] `keepAlive: false/true` 로 순차 요청 300개의 시간·새 연결 수 측정
- [ ] fetch 300개 동시 요청을 재현하고 `sysctl kern.ipc.somaxconn`(macOS)·`net.core.somaxconn`(리눅스)와 실패 수 비교
- [ ] undici `Agent({ connections: 50 })` 로 같은 부하가 실패 없이 끝나는지 확인
- [ ] 응답 본문을 읽지 않는 클라이언트로 소켓 풀이 고갈되는 것 재현
- [ ] 서버 `keepAliveTimeout` 을 1초로 줄이고 Nginx(18080) 뒤에서 부하를 걸어 502 가 나는지 관찰
