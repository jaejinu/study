---
title: "프로파일링과 진단 — --cpu-prof, inspector, perf_hooks, monitorEventLoopDelay, diagnostics_channel, flame graph 읽기"
order: 13
level: 심화
chapter: "4부 · 병렬성·성능·운영"
summary: "느린 Node 서버를 진단하는 순서(지연 지표 → 이벤트 루프 지연 → CPU 프로파일 → 힙 → I/O), --cpu-prof 로 만든 프로파일의 self time 이 sortMany 67.7%·GC 8.4% 로 나오는 실측과 직접 집계하는 법, 샘플링 간격과 정확도, node:inspector 로 실행 중인 프로세스를 프로파일링하기, monitorEventLoopDelay 로 200ms 블로킹이 p99 210ms 로 보이는 실측, perf_hooks 의 mark·measure·timerify·gc 항목, diagnostics_channel 로 http 서버·클라이언트 요청을 코드 수정 없이 관찰하기(실측), flame graph 를 읽는 규칙, clinic·0x·연속 프로파일링"
tags: [프로파일링, cpu-prof, inspector, flame graph, perf_hooks, monitorEventLoopDelay, diagnostics_channel, 진단]
experiments: [node-event-loop-order]
---

## 진단 순서

"Node 서버가 느리다" 는 대개 셋 중 하나다: **메인 스레드가 바쁘다(CPU)**, **기다리고 있다(I/O·하류)**, **GC 가 바쁘다(메모리)**. 순서대로 좁힌다.

| 단계 | 질문 | 도구 |
|---|---|---|
| 1 | 무엇이, 얼마나 느린가 | 지연 분포(p50·p99) — 메트릭·트레이스 |
| 2 | 메인 스레드가 막히나 | **이벤트 루프 지연** (`monitorEventLoopDelay`) |
| 3 | 막힌다면 어떤 코드가 | **CPU 프로파일** (`--cpu-prof`, inspector) |
| 4 | GC 때문인가 | `--trace-gc`, gc 메트릭 ([10](/nodejs/notes/10-gc-heap)) |
| 5 | 안 막히는데 느리다면 | 하류 I/O — 트레이스의 스팬, `diagnostics_channel`, DB·Redis 지연 |

이벤트 루프 지연이 낮은데 응답이 느리면 Node 는 범인이 아니다 — 기다리는 상대를 찾아야 한다([관측성 06 트레이싱](/observability/notes/06-tracing-otel)).

## 이벤트 루프 지연 — 실측

```js
const { monitorEventLoopDelay } = require("node:perf_hooks");
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
setTimeout(() => { const t = Date.now(); while (Date.now() - t < 200); }, 100);   // 200ms 블로킹 한 번
setTimeout(() => { h.disable(); console.log(`p50=${h.percentile(50)/1e6}ms p99=${h.percentile(99)/1e6}ms`); }, 600);
```

```
p50=11.0ms p99=210.5ms max=210.5ms
```

`monitorEventLoopDelay` 는 libuv 타이머가 **예정보다 얼마나 늦게 실행됐는지**를 히스토그램(ns)으로 모은다. p50 은 해상도(10ms) 수준, 블로킹 한 번이 p99·max 를 210ms 로 만들었다. 운영 지표로는 **p99 와 max** 를 본다.

이 사이트는 prom-client 기본 메트릭으로 같은 값을 내보낸다:

```bash
$ curl -s localhost:3310/api/metrics | grep -o '^study_process_nodejs_eventloop_lag_seconds[a-z_]*' | sort -u
study_process_nodejs_eventloop_lag_seconds
```

## CPU 프로파일 — 실측

V8 의 샘플링 프로파일러는 **일정 간격으로 실행 중인 스택을 찍는다**. 같은 스택이 많이 찍힌 함수가 CPU 를 쓴 함수다.

```js
// prof.cjs
function slowJson() { …JSON.stringify 300번… }
function sortMany() { …30만 개 난수 정렬… }
for (let r = 0; r < 5; r++) { slowJson(); sortMany(); }
```

```bash
$ node --cpu-prof prof.cjs
$ ls *.cpuprofile
CPU.20261017.063333.37608.0.001.cpuprofile
```

`.cpuprofile` 은 JSON 이다: `nodes`(호출 트리, 각자 `callFrame`), `samples`(샘플마다 노드 id), `timeDeltas`(샘플 간격). 직접 집계하면:

```js
const self = new Map(); const byId = new Map(p.nodes.map((n) => [n.id, n]));
p.samples.forEach((id, i) => { const k = byId.get(id).callFrame.functionName || "(anonymous)"; self.set(k, (self.get(k) ?? 0) + p.timeDeltas[i]); });
```

```
샘플 324 개, 평균 간격 1447 µs
sortMany: 67.7%
(anonymous): 12.3%          ← sort 비교 함수, Array.from 콜백 (익명 화살표 함수)
(garbage collector): 8.4%   ← GC 도 프로파일에 보인다
slowJson: 7.8%
compileForInternalLoader: 2.0%
```

| 읽는 법 | |
|---|---|
| **self time** | 그 함수 **자신이** 실행 중이던 샘플 — 최적화 대상 |
| **total time** | 자신 + 자식 — "이 경로가 비싸다" |
| `(garbage collector)` | GC 비율이 10~20% 를 넘으면 할당·수명 문제 ([10](/nodejs/notes/10-gc-heap)) |
| `(program)` | 네이티브 코드·V8 내부 |
| `(idle)` | 이벤트 루프가 쉬는 중 — 서버에선 높을수록 좋다 |
| 익명 함수가 상위 | 함수에 이름을 붙이면 프로파일이 읽힌다 |

샘플링 간격(기본 약 1ms, `--cpu-prof-interval` 로 µs 단위 지정)보다 짧게 사는 함수는 놓친다. 샘플 수가 적으면(수백 개) 비율의 오차가 크다 — 충분히 오래 찍는다.

### 실행 중인 서버를 프로파일링

```js
import { Session } from "node:inspector/promises";
const s = new Session(); s.connect();
await s.post("Profiler.enable");
await s.post("Profiler.start");
// … 30초 운영 트래픽 …
const { profile } = await s.post("Profiler.stop");
await fs.writeFile("prod.cpuprofile", JSON.stringify(profile));
```

재시작 없이 관리용 엔드포인트로 켰다 끌 수 있다. `.cpuprofile` 은 Chrome DevTools(Performance → Load profile)나 **speedscope.app** 에서 flame graph 로 본다. 또는 `node --inspect` 로 띄우고 `chrome://inspect` 에서 직접 기록.

> 운영에서 `--inspect` 를 **외부 인터페이스에 열면 원격 코드 실행**이 된다(디버거는 아무 JS 나 실행할 수 있다). `127.0.0.1` 에만 바인딩하고 SSH 터널로 접속한다.

## flame graph 읽기

```
┌───────────────────────── main ─────────────────────────┐
├──── handleRequest ────────────┬──── gcAndIdle ──────────┤
├─ parseBody ─┬─ renderJson ────┤                         │
│             ├─ JSON.stringify ┤  ← 넓고 평평한 꼭대기 = self time 큰 곳
```

| 규칙 | |
|---|---|
| **가로 폭 = 시간 비율** | 시간 순서가 아니다(icicle·flame 둘 다) |
| 세로 = 호출 깊이 | |
| **넓고 평평한 꼭대기** | 자기 일을 많이 한 함수 — 여기부터 |
| 좁고 높은 탑 | 깊은 호출, 그 자체는 비싸지 않을 수 있다 |
| 같은 함수가 여러 곳에 | 여러 경로에서 불림 — "left heavy" 로 합쳐 보기 |

도구: `0x`(flame graph 바로 생성), `clinic flame`/`clinic doctor`(이벤트 루프·GC·I/O 를 함께 진단), 그리고 운영 상시 수집은 Pyroscope·Parca 같은 **연속 프로파일링**([관측성 10](/observability/notes/10-continuous-profiling), [eBPF 06](/ebpf/notes/06-profiling-continuous)).

## perf_hooks — 코드 안에서 재기

```js
import { performance, PerformanceObserver } from "node:perf_hooks";
performance.mark("q-start");
await db.query(sql);
performance.mark("q-end");
performance.measure("db.query", "q-start", "q-end");

new PerformanceObserver((list) => {
  for (const e of list.getEntries()) metrics.observe(e.name, e.duration);
}).observe({ entryTypes: ["measure", "gc", "function"] });

const timedParse = performance.timerify(parse);   // 호출마다 'function' 항목
```

| 항목 종류 | 무엇 |
|---|---|
| `measure` | 두 mark 사이 |
| `gc` | GC 마다 종류(`detail.kind`)·시간 — 실험 `node-gc-heap` 이 이것으로 Scavenge 31회를 셌다 |
| `function` | `timerify` 한 함수 호출 |
| `http`, `http2`, `dns`, `net` | 코어 모듈 타이밍 |

`performance.now()` 는 단조 시계(ms, 소수)라 시간 측정에 `Date.now()` 대신 쓴다 — 시스템 시계가 NTP 로 바뀌어도 거꾸로 가지 않는다.

## diagnostics_channel — 코드 수정 없이 관찰 — 실측

Node 코어와 라이브러리가 **이름 붙은 채널**에 이벤트를 발행한다. 구독하면 계측 코드를 대상에 넣지 않고도 볼 수 있다. OpenTelemetry 자동 계측·APM 에이전트가 이걸 쓴다.

```js
import dc from "node:diagnostics_channel";
for (const ch of ["http.server.request.start", "http.server.response.finish", "http.client.request.start"])
  dc.subscribe(ch, (msg) => seen.push(ch));
// 서버를 띄우고 fetch 한 번, http.get 한 번
```

```
http.server.request.start, http.server.response.finish, http.client.request.start
```

`fetch`(undici)도 `undici:request:create` 같은 자기 채널을 낸다. `pg`·`ioredis` 같은 라이브러리 계측은 `require` 를 가로채는 방식(OTel instrumentation)이 여전히 흔하다.

## 예시로 보기 — 이 프로젝트에서

- **실행 중인 사이트를 프로파일링하는 실험.** 관측성 주제의 `obs-cpu-profile`(`src/code-lab/observability.ts`)은 위 inspector 코드 그대로 **이 사이트 프로세스 자신**을 2초 프로파일링하고 self time 상위 표와 `logs/cpu-profile-*.cpuprofile` 을 남긴다. 그 파일을 speedscope 에 끌어다 놓으면 flame graph 가 된다.
- **트레이스는 OTel 로.** `src/instrumentation.ts` 는 `@vercel/otel` 의 `registerOTel` 에 `IORedisInstrumentation`·`PgInstrumentation` 을 넘긴다. Redis 명령·SQL 이 스팬이 되어 Tempo 로 간다 — 진단 순서 5단계("기다리는 상대")를 이걸로 본다. 로그 줄의 `trace_id`(`src/lib/log.ts`)로 로그 ↔ 트레이스를 오간다.
- **이벤트 루프 지연 경보.** `study_process_nodejs_eventloop_lag_seconds` 가 Grafana 에 있으니, p99 가 100ms 를 넘으면 알리는 규칙을 [관측성 09 알림 파이프라인](/observability/notes/09-alerting-pipeline) 의 규칙 파일에 추가하는 것이 자연스러운 다음 단계다.

## 실습 체크리스트

- [ ] `node --cpu-prof` 로 위 `prof.cjs` 를 프로파일링하고 speedscope 에서 flame graph 열기
- [ ] 프로파일 JSON 을 직접 집계해 self time 상위 5개 뽑기
- [ ] 익명 함수에 이름을 붙이고 프로파일의 `(anonymous)` 비율 변화 확인
- [ ] `monitorEventLoopDelay` 로 50·200·1000ms 블로킹의 p99 확인
- [ ] `diagnostics_channel` 로 http 서버 요청 시작·끝을 구독해 요청별 처리 시간 로그 남기기
- [ ] 실험 `obs-cpu-profile` 을 돌리고 저장된 `.cpuprofile` 을 열어 보기
