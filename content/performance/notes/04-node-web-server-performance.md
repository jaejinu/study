---
title: "Node.js·웹 서버 성능 — 이벤트 루프, GC, 프로파일링, flame graph"
order: 4
level: 중급
summary: "Node 의 이벤트 루프 단계와 '한 요청의 동기 작업이 모두를 멈추는' 메커니즘, 이벤트 루프 지연 측정과 알림, CPU 작업 분리(worker_threads·큐·클러스터), V8 힙과 GC 의 지연 영향, --cpu-prof·0x·clinic 으로 flame graph 읽기, 힙 스냅샷으로 누수 찾기, 스트리밍·압축·keep-alive 같은 HTTP 레벨 최적화, Next.js 서버 특유의 병목"
tags: [Node.js, 이벤트 루프, worker_threads, GC, V8, 힙, flame graph, --cpu-prof, 0x, clinic, keep-alive, 스트리밍]
experiments: [perf-node-eventloop]
---

## 이벤트 루프 — 하나의 스레드가 모든 요청을 돌본다

Node 는 JavaScript 를 **단일 스레드**에서 실행하고, I/O(네트워크·파일·DNS)는 OS 의 비동기 API(epoll/kqueue)와 libuv 스레드 풀(기본 4개, 파일·DNS·압축·암호화)에 맡긴다. 그래서 I/O 대기는 공짜에 가깝지만 **JavaScript 가 CPU 를 쓰는 동안은 아무 콜백도 실행되지 않는다**.

```
┌─ timers ─────┐  setTimeout/setInterval 콜백
│  pending cb  │  이전 루프의 I/O 콜백
│  poll        │  새 I/O 이벤트 기다리고 콜백 실행 (여기서 대부분의 시간)
│  check       │  setImmediate
└─ close cb ───┘
  (각 단계 사이에 process.nextTick 큐와 Promise 마이크로태스크 큐를 비움)
```

핵심 결과: 요청 A 의 핸들러가 300ms 동안 JSON 을 파싱하면 그 300ms 동안 요청 B·C·D 의 응답도, 타이머도, 헬스체크도 멈춘다. **한 요청의 CPU 시간이 모든 요청의 꼬리 지연**이 된다. 이것이 Node 성능의 제1 법칙이다.

### 이벤트 루프 지연 측정

```ts
import { monitorEventLoopDelay } from "node:perf_hooks";
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
setInterval(() => console.log("loop lag p99", h.percentile(99) / 1e6, "ms"), 5000);
```

prom-client 의 `collectDefaultMetrics` 가 `nodejs_eventloop_lag_seconds`(p50/p99 등)를 내보낸다 — 이 앱에서는 `study_process_nodejs_eventloop_lag_p99_seconds`. **p99 > 50~100ms 에 알림**을 걸면 CPU 병목을 가장 먼저 알 수 있다. 전형적 원인: 큰 JSON 직렬화, 동기 파일 I/O(`fs.readFileSync`), 정규식 재앙(ReDoS), 큰 배열 정렬·map, bcrypt 동기 호출, 긴 템플릿 렌더링.

### CPU 작업 분리

| 방법 | 동작 | 언제 |
|---|---|---|
| **쪼개서 양보** | 작업을 N ms 단위로 나누고 `setImmediate`/`await` 로 루프에 양보 | 간단한 루프. 총 시간은 같고 꼬리만 개선 |
| **worker_threads** | 별도 V8 스레드에서 실행, 메시지/SharedArrayBuffer 로 교환 | CPU 집약 (이미지 처리, 압축, 암호화). `piscina` 풀 |
| **별도 프로세스/큐** | 작업을 큐(Redis Streams, Kafka)에 넣고 워커 프로세스가 처리 | 긴 작업, 재시도·관측 필요. [비동기 메시징](/architecture/notes/03-async-messaging-consistency) |
| **cluster / 멀티 프로세스** | 코어 수만큼 프로세스, 포트 공유 | 처리량 ↑. 하지만 **한 프로세스 안의 막힘은 그대로** — 꼬리 해결 아님 |
| **네이티브로** | Rust/C++ 애드온(napi-rs), WebAssembly | 극단적 CPU 작업 |

실험 `perf-node-eventloop` 는 첫 번째 방법의 효과를 숫자로 보여 준다(아래).

## V8 힙과 GC

V8 은 **세대별 GC**: 새 객체는 Young(Scavenge, 빠르고 잦음, 1~수 ms), 살아남으면 Old(Mark-Sweep-Compact, 느리고 드묾, 수십~수백 ms — 대부분 병렬·증분이지만 일부는 stop-the-world). GC 멈춤은 이벤트 루프 지연으로 나타난다.

- 힙 크기 기본 상한은 시스템 메모리에 따라(보통 2~4GB). 컨테이너에서 메모리 limit 보다 커지면 OOM kill 전에 GC 폭주(thrashing) → `--max-old-space-size=<MB>` 를 limit 의 ~75% 로.
- 할당을 줄이는 것이 GC 를 줄인다: 요청마다 큰 객체 복사, 문자열 연결 폭발, 클로저 캡처. 스트리밍으로 큰 응답을 조각내면 피크 메모리가 준다.
- 지표: `nodejs_heap_size_used_bytes`, `nodejs_gc_duration_seconds`(kind 별). **힙이 계단식으로 오르기만 하면 누수**.

### 힙 스냅샷으로 누수 찾기

```
node --inspect server.js   → Chrome DevTools Memory 탭 → Heap snapshot 두 번(부하 전/후) → Comparison, "Objects allocated between"
또는: process 에 SIGUSR2 → v8.writeHeapSnapshot()  (운영에서는 신중히 — 수 초 멈춤)
```

흔한 누수: 전역 Map 캐시에 TTL 없음, 이벤트 리스너 누적(`EventEmitter` 의 MaxListenersExceededWarning 이 힌트), 닫지 않은 타이머·스트림, 요청별 로거에 큰 컨텍스트 보관, 모듈 스코프의 배열에 push.

## 프로파일링 — 어디서 CPU 를 쓰나

### --cpu-prof

```
node --cpu-prof --cpu-prof-dir=./prof server.js       # 종료 시 .cpuprofile 생성
# Chrome DevTools → Performance/JavaScript Profiler 에서 로드, 또는 speedscope.app 에 드롭
```

운영 중인 프로세스는 `node --inspect` + DevTools Profiler, 또는 `SIGUSR1` 로 인스펙터 활성화. 샘플링이라 오버헤드는 수 %.

### flame graph 읽는 법

- **가로 폭 = 그 함수(와 자식)가 차지한 샘플 비율**. 세로 = 호출 스택 깊이. 색은 의미 없음(0x 는 핫 함수를 진하게).
- **넓은 평평한 꼭대기(plateau)** 를 찾는다 — 자식 없이 스스로 CPU 를 쓰는 함수. 거기가 최적화 대상.
- 넓지만 자식이 많은 중간층은 "경유지" 일 뿐. `JSON.stringify`, `(garbage collector)`, `(program)` 이 꼭대기면 각각 직렬화·GC·네이티브(I/O 대기 아님, 실제 CPU).
- 도구: **0x**(`npx 0x -- node server.js` → 부하 → Ctrl-C → HTML), **clinic**(`clinic doctor`: 이벤트 루프·GC·CPU 진단 요약, `clinic flame`, `clinic bubbleprof`: 비동기 지연 흐름).
- 운영 지속 프로파일링: Pyroscope(Grafana), Parca — 1분 단위 flame graph 를 시계열로. [LLM 관측](/observability/notes/08-llm-observability) 의 토큰 비용처럼 "언제부터 이 함수가 넓어졌나" 를 본다.

### 비동기 병목은 flame graph 에 안 보인다

`await redis.get()` 으로 **기다리는** 시간은 CPU 를 안 쓰니 flame graph 에 없다. 그건 **트레이스**(span 길이)로 본다([트레이싱](/observability/notes/06-tracing-otel)). 순서: 트레이스로 "느린 요청의 시간이 CPU 인지 대기인지" 가르고 → CPU 면 프로파일러, 대기면 다운스트림.

직렬 await 는 가장 흔한 대기 낭비다:

```ts
const a = await getA(); const b = await getB();      // 지연 = A + B
const [a, b] = await Promise.all([getA(), getB()]);   // 지연 = max(A, B)
```

## HTTP 레벨 최적화

| 기법 | 효과 | 주의 |
|---|---|---|
| **keep-alive**(클라이언트·업스트림 양쪽) | TCP/TLS 핸드셰이크 제거(수십 ms → 0). Node 19+ 의 `http.globalAgent` 는 기본 keep-alive | 업스트림(Redis·PG·외부 API) 커넥션 풀도 같은 원리 |
| **압축**(gzip/brotli) | 대역폭 ↓, 모바일에서 체감 | CPU 비용 — 큰 응답만, 정적 자원은 빌드 시 미리. 보통 **Nginx 가** 한다([Nginx](/nginx/notes/03-cache-tls-ratelimit)) |
| **스트리밍 응답** | TTFB ↓, 메모리 피크 ↓ (SSE, React 스트리밍 SSR) | 중간 프록시의 버퍼링 끄기(`X-Accel-Buffering: no`) |
| **ETag/Cache-Control** | 재요청 304, CDN 캐시 | 개인화 응답엔 `private`/`no-store` |
| 응답 크기 | 필요한 필드만, 페이지네이션 | JSON 직렬화는 CPU 다 |
| HTTP/2·3 | 다중화, 헤더 압축 | 프록시가 종단 |

## Next.js 서버에서 흔한 병목

- **SSR 렌더링은 CPU**: 큰 페이지의 React 렌더는 수십 ms 의 동기 작업 → 많은 요청이 겹치면 이벤트 루프 지연. 정적 생성·캐시(`revalidate`), 스트리밍, 컴포넌트 분할로 줄인다.
- **서버 컴포넌트의 직렬 await**: 상위에서 `await` 하면 하위 전부 대기. `Promise.all` 또는 `Suspense` 경계로 병렬.
- **개발 서버 ≠ 운영**: Turbopack dev 는 요청마다 컴파일·HMR 오버헤드가 있고 사실상 직렬에 가깝다. 성능 측정은 **반드시 `next build && next start`**(또는 standalone) 에서.
- 커넥션: Redis(ioredis) 는 커넥션 1개로 파이프라인되므로 풀이 필요 없지만, PG 는 풀(`pg.Pool`) 크기가 처리량 상한([데이터 접근 병목](/performance/notes/05-data-access-bottlenecks)).
- 로깅: 요청마다 큰 객체를 JSON 직렬화하면 그 자체가 CPU. 샘플링·레벨 조절([로그](/observability/notes/05-logging-loki)).

## 예시로 보기 — 이 프로젝트에서

실험 `perf-node-eventloop` 의 실제 결과(같은 총 계산량 ≈ 300ms):

| 방식 | 총 소요 | 루프 지연 p50 | p99 | max |
|---|---|---|---|---|
| 동기 300ms × 1 | ~330ms | ~1ms | ~300ms | ~300ms |
| 5ms × 60, 사이에 setImmediate | ~340ms | ~5ms | ~6ms | ~7ms |
| 1ms × 300 | ~360ms | ~1ms | ~2ms | ~3ms |

총 시간은 거의 같은데 **최대 지연이 300ms → 7ms → 3ms**. 처리량은 바뀌지 않았고 "그 동안 다른 요청이 얼마나 기다리는가" 만 바뀌었다 — 꼬리 지연 문제다. 운영에서는 `worker_threads` 나 큐로 아예 빼는 게 정석이지만, 원리는 이 표 하나다.

`perf-k6-arrival-rate` 에서 개발 서버가 ~37 req/s 에서 포화한 것도 같은 이유다: `/api/metrics` 의 서비스 시간 ~27ms 가 대부분 CPU(레지스트리 직렬화 + 개발 모드 오버헤드)라 1/0.027 ≈ 37. 운영 빌드에서 `node --cpu-prof` 로 돌리고 0x 로 보면 어느 함수가 넓은지 바로 보인다.

이 앱의 `/api/metrics` 에는 `study_process_nodejs_eventloop_lag_p99_seconds`, `study_process_nodejs_gc_duration_seconds`, `study_process_nodejs_heap_size_used_bytes` 가 이미 있다. Grafana 에 패널을 추가하고 k6 부하 중 어떻게 움직이는지 보자 — 이벤트 루프 지연이 먼저 오르고, 그 다음 HTTP p99 가 따라온다.

> 함께 읽기: [시스템 수준 — CPU·메모리·디스크·네트워크, 컨테이너 제한과 스로틀링](/performance/notes/06-system-level)

## 실전에서는 어디에 쓰이나

> Node.js·Next.js 서버에서 "평균은 괜찮은데 가끔 수백 ms 씩 전부 멈춘다" 는 증상이 나오면 이 노트의 이벤트 루프·GC·프로파일링이 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| Node BFF·API 게이트웨이 | 큰 JSON 직렬화가 다른 요청까지 멈춤 | 이벤트 루프 지연 p99 알림, 응답 크기 축소, 스트리밍 | 멀티스레드 런타임(Go 등)으로 재작성 |
| 이미지·PDF 생성 서비스 | CPU 집약 작업이 루프를 독점 | `worker_threads` 풀(piscina) 또는 큐 + 워커 프로세스 | 별도 서비스로 분리 |
| Next.js SSR 커머스 상품 페이지 | 렌더링 CPU 와 직렬 await | 정적 생성·`revalidate` 캐시, `Promise.all`·Suspense 로 병렬 | CDN 캐시 |
| 컨테이너 위 Node 서비스 | limit 근처 GC 폭주·OOM kill | `--max-old-space-size` 를 limit 의 ~75%, 힙 스냅샷 비교로 누수 추적 | 메모리 limit 만 상향 |
| 운영 중 원인 불명 CPU 증가 | 어느 함수가 넓어졌나 | `--cpu-prof`·0x flame graph, Pyroscope 연속 프로파일링 | 코드에 타이밍 로그 추가 |

**이럴 땐 안 맞는다**
- 영상 인코딩·대량 수치 계산처럼 CPU 가 본업인 일을 메인 스레드에서 → 구조적으로 맞지 않는다. 네이티브 애드온, 다른 런타임, 별도 워커 서비스로.
- `cluster` 로 프로세스를 늘려 꼬리 지연을 해결하려는 것 → 처리량만 늘고 한 프로세스 안의 막힘은 그대로다.

**누가 매일 만나나** — Node 백엔드·풀스택 개발자가 Grafana 의 이벤트 루프 지연 패널이 튀는 것을 볼 때, 온콜이 계단식 힙 그래프와 OOM kill 알림을 받을 때.

**면접·실무 단골 질문**
- Q. 단일 스레드인 Node 가 어떻게 동시 요청을 처리하나? → I/O 는 OS 비동기 API·libuv 에 맡기고 JS 는 콜백만 실행한다. 그래서 CPU 작업이 길면 모두 멈춘다.
- Q. flame graph 에서 무엇을 찾나? → 자식 없이 스스로 CPU 를 쓰는 넓은 plateau. 대기 시간은 flame graph 가 아니라 트레이스로 본다.

## 실습 체크리스트

- [ ] `perf-node-eventloop` 를 돌리고 5ms 와 1ms 분할의 트레이드오프(총 시간 vs 최대 지연)를 설명한다
- [ ] 운영 빌드를 `node --cpu-prof` 로 띄워 k6 부하를 준 뒤 speedscope 에서 가장 넓은 plateau 를 찾는다
- [ ] Grafana 에 이벤트 루프 지연 p99 와 GC 시간 패널을 추가하고, 부하 중 HTTP p99 와의 선후 관계를 본다
- [ ] 직렬 await 를 `Promise.all` 로 바꿀 수 있는 서버 컴포넌트를 하나 찾아 트레이스로 전후를 비교한다
- [ ] 10분 soak 중 힙 그래프가 계단인지 톱니인지 보고, 계단이면 힙 스냅샷 비교로 원인을 찾는다
