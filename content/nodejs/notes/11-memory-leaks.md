---
title: "심화 — 메모리 누수 찾기: 힙 스냅샷 비교, 네 가지 누수 경로, WeakMap · WeakRef · FinalizationRegistry"
order: 11
level: 심화
chapter: "3부 · V8 과 메모리"
summary: "누수는 GC 가 못 치우는 것이 아니라 우리가 놓지 않은 참조라는 정의, 전역 캐시·이벤트 리스너·타이머·클로저의 네 가지 누수 경로, 부하 전후 힙 스냅샷 두 장을 비교해 처리량에 비례해 늘어나는 생성자를 찾는 방법(요청 2,000건에 Session·onConfig 클로저·Buffer 가 정확히 2,000개씩 증가, 리스너 3,000개 실측), 얕은 크기와 유지 크기, 운영 중 누수 탐지(RSS 추세, Mark-Compact 후 크기), WeakMap·WeakRef·FinalizationRegistry 의 올바른 쓰임"
tags: [메모리 누수, 힙 스냅샷, retained size, WeakMap, WeakRef, FinalizationRegistry, EventEmitter, 클로저]
experiments: [node-leak-detect, node-gc-heap]
---

## 누수의 정의

자바스크립트에는 `free` 가 없다. GC 는 **루트(전역, 스택, 활성 핸들)에서 닿지 않는 객체**를 치운다. 그러니 누수란:

> **더 이상 필요 없는데 루트에서 여전히 닿는 객체.**

GC 는 정확하다. 문제는 늘 "누군가 아직 참조하고 있다" 이다. 누수를 찾는 일은 곧 **그 참조 경로(retainer path)를 찾는 일**이다.

증상은 [10 GC 와 힙](/nodejs/notes/10-gc-heap) 의 언어로 말하면: **Mark-Compact 뒤에도 Old 크기가 줄지 않고 계단처럼 오른다** → GC 가 점점 잦아지고 길어진다 → 지연이 늘고 → 결국 FATAL ERROR 나 OOMKilled.

## 네 가지 누수 경로

| 경로 | 예 | 고치기 |
|---|---|---|
| **무한히 크는 캐시** | `const cache = new Map(); cache.set(req.id, result)` | 크기·TTL 상한(LRU), 또는 키 수명이 객체와 같으면 WeakMap |
| **해제하지 않은 이벤트 리스너** | 요청마다 `emitter.on("config", handler)` | `off`, `once`, `{ signal }` 로 묶어 한 번에 해제 |
| **끄지 않은 타이머·인터벌** | `setInterval(poll, 1000)` 를 연결마다 | `clearInterval`, 연결 종료 시 정리 |
| **클로저가 붙잡은 큰 객체** | 콜백이 `req` 전체를 캡처해 오래 보관 | 필요한 값만 꺼내서 캡처 |

그 밖에: 모듈 수준 배열에 계속 push, 작은 `subarray` 로 큰 Buffer 를 붙잡기([05](/nodejs/notes/05-buffers-encoding)), 끝나지 않는 Promise 체인(영원히 pending 인 Promise 가 콜백을 붙잡음), 전역에 실수로 만든 변수.

## 실측 — 스냅샷 두 장 비교

실험 `node-leak-detect` 는 요청 처리를 흉내 낸 코드를 돌린다.

```js
const cache = new Map();                    // '잠깐' 담는다던 캐시
class Session { constructor(id) { this.id = id; this.payload = Buffer.alloc(4096); } }
function handle(id) {
  const s = new Session(id);
  cache.set(id, s);                         // 누수 1: 지우지 않음
  const onConfig = () => s.id;              // 클로저가 s 를 붙잡음
  bus.on("config", onConfig);               // 누수 2: 해제하지 않음
}
```

요청 1,000건 처리 → `v8.writeHeapSnapshot()` → 2,000건 더 → 또 스냅샷. 스냅샷 JSON 의 노드를 생성자별로 세어 차이를 냈다.

**누수 버전 — 두 스냅샷 사이에 늘어난 생성자 상위:**

| 생성자 | 개수 증가 | 얕은 크기 증가 |
|---|---|---|
| Object | 2,514 | 98 KB |
| system / Context | 2,001 | 78 KB |
| Buffer | 2,001 | 188 KB |
| ArrayBuffer | 2,000 | 172 KB |
| (closure) onConfig | **2,000** | 109 KB |
| Session | **2,000** | 94 KB |

**전체 비교:**

| 버전 | 힙 1 → 2 | 힙 노드 수 1 → 2 | 리스너 | 캐시 크기 |
|---|---|---|---|---|
| 누수 | 8 → 16.9 MB | 54,476 → 75,598 | **3,000** | **3,000** |
| 고침 (`cache.delete` + `bus.off`) | 3.7 → 4.1 MB | 47,478 → 54,626 | 0 | 0 |

읽는 법:
- **처리한 요청 수(2,000)와 정확히 같은 수만큼 늘어난 생성자**가 범인이다: `Session`, `onConfig` 클로저, 그리고 Session 이 가진 `Buffer`·`ArrayBuffer`. `system / Context` 2,001 은 클로저마다 생기는 스코프(컨텍스트) 객체다 — 클로저 누수의 지문이다.
- 고친 버전도 노드 수가 7,148 늘었지만 Session 은 0 이다. 그 증가분은 첫 스냅샷을 집계하며 만든 문자열·Map 같은 **측정 자체의 잔여물**이다. 그래서 "총량이 늘었다" 가 아니라 "**처리량에 비례해 느는 생성자**" 를 본다.

### 얕은 크기 vs 유지 크기

`Session` 하나의 얕은 크기(self size)는 48바이트 남짓이다. 표에서 Session 2,000개 = 94KB. 작아 보인다. 하지만 Session 이 붙잡은 `payload` Buffer(4KB, 힙 밖)까지 합치면 **유지 크기(retained size)** 는 개당 4KB 가 넘는다 — 2,000개면 8MB. 힙이 8 → 16.9MB 로 거의 9MB 늘어난 것과 맞는다.

| 크기 | 의미 | DevTools 열 |
|---|---|---|
| Shallow size | 객체 자신 | Shallow Size |
| Retained size | 이 객체가 사라지면 함께 회수될 전부 | Retained Size |

누수를 쫓을 때는 **Retained Size 로 정렬**해야 한다.

## DevTools 로 찾는 절차

1. `node --inspect app.js` → Chrome `chrome://inspect` → Memory 탭.
   (운영에서는 `kill -USR2` 대신 `--heapsnapshot-signal=SIGUSR2` 플래그나 `v8.writeHeapSnapshot()` 을 관리용 엔드포인트로.)
2. 기준 스냅샷 → 부하(요청 수천 건) → **GC 강제**(휴지통 버튼) → 두 번째 스냅샷.
3. 두 번째를 선택하고 보기를 **Comparison**, 기준을 첫 스냅샷으로 → **# Delta** 정렬.
4. 늘어난 생성자를 펼쳐 개별 객체 선택 → 아래 **Retainers** 패널에서 루트까지의 경로를 따라 올라간다. `Map` → `cache` → `(global)` 처럼 "누가 붙잡았나" 가 보인다.

> 스냅샷을 찍는 동안 프로세스는 **멈추고**, 힙 크기만큼 메모리를 더 쓴다. 1GB 힙이면 수 초 멈추고 2GB 가 필요할 수 있다. 운영에서는 트래픽을 뺀 인스턴스에서 찍는다.

### 리스너 누수의 경보

```bash
$ node -e 'const e=new (require("events"))(); for(let i=0;i<11;i++) e.on("x",()=>{})'
(node:…) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 x listeners added to [EventEmitter]. MaxListeners is 10.
```

Node 는 같은 이벤트에 리스너가 10개를 넘으면 경고한다. 이 경고를 `setMaxListeners(0)` 으로 끄는 것은 누수를 숨기는 일인 경우가 많다(실험 코드가 일부러 끈 것처럼). `--trace-warnings` 로 어디서 등록했는지 찾는다.

## 운영 중 누수 탐지

| 신호 | 어디서 |
|---|---|
| RSS 가 배포 후 계단처럼 오르고 내려오지 않음 | `process_resident_memory_bytes` |
| 힙 사용량의 **바닥**(GC 직후 값)이 오름 | `nodejs_heap_size_used_bytes` 의 최솟값 추세 |
| major GC 빈도·시간 증가 | `nodejs_gc_duration_seconds{kind="major"}` |
| 일정 주기로 OOMKilled → 재시작 | k8s `restartCount`, 이벤트 |
| 이벤트 루프 지연 증가 | GC 멈춤이 길어짐 |

"재시작하면 괜찮아진다" 는 누수의 전형이다. 주기적 재시작은 진통제일 뿐이다. 연속 프로파일링의 힙 프로파일([관측성 10](/observability/notes/10-continuous-profiling))을 켜 두면 어느 함수가 할당한 메모리가 남는지 시간축으로 볼 수 있다.

## WeakMap · WeakRef · FinalizationRegistry

```js
const wm = new WeakMap(), m = new Map();
let k1 = {}, k2 = {};
wm.set(k1, Buffer.alloc(1e6)); m.set(k2, Buffer.alloc(1e6));
k1 = null; k2 = null; gc();
m.size;     // 1 — Map 은 키를 강하게 붙잡는다 (1MB 계속 살아 있음)
            // WeakMap 은 키가 사라지면 값도 회수 대상
```

| 도구 | 하는 일 | 쓸 곳 |
|---|---|---|
| `WeakMap` / `WeakSet` | 키를 약하게 참조. 키 객체가 죽으면 항목도 사라짐. 순회·크기 불가 | **객체에 부가 데이터 붙이기**(요청 객체별 메타, DOM 노드별 상태) |
| `WeakRef` | 객체를 약하게 참조. `deref()` 가 `undefined` 일 수 있음 | 재계산 가능한 큰 캐시 |
| `FinalizationRegistry` | 객체가 회수된 **뒤 언젠가** 콜백 | 네이티브 자원 정리의 보조 수단 |

```bash
# --expose-gc 로 확인한 결과
회수됨: tmp 객체
WeakRef deref: undefined(회수됨)
```

> **주의:** FinalizationRegistry 콜백은 **언제 불릴지, 불리기는 할지 보장되지 않는다.** 파일·소켓 닫기 같은 필수 정리를 맡기면 안 된다 — 명시적 `close()`/`using`(명시적 자원 관리)이 정답이다. WeakMap 의 키는 문자열·숫자가 될 수 없다(객체만). "요청 ID 문자열로 캐시" 는 WeakMap 으로 해결되지 않고 LRU 가 필요하다.

## 예시로 보기 — 이 프로젝트에서

- **실험 결과의 지문 읽기.** 이 사이트의 `node-leak-detect` 실험 페이지를 열어 "누수 버전: 늘어난 생성자 상위" 표를 보라. `(closure) onConfig` 와 `system / Context` 가 같은 수로 늘어난 것이 "리스너 클로저 누수" 의 지문이다. 운영에서 같은 모양이 보이면 `on(...)` 호출부를 찾으면 된다.
- **이 사이트의 리스너 관리.** `src/components/StudyTimer.tsx` 는 `useEffect` 안에서 `window.addEventListener` 로 활동 이벤트를 달고, **cleanup 함수에서 같은 리스너를 removeEventListener** 한다. 노트 페이지를 오가며 리스너가 쌓이지 않는 이유다(브라우저 쪽이지만 원리는 같다). `AskPanel` 의 `keydown`·`selectionchange` 리스너도 같은 방식이다.
- **서버 쪽 싱글턴.** `src/lib/redis.ts` 가 클라이언트를 `globalThis` 에 하나만 두는 이유 중 하나가 누수 방지다. Next.js 개발 모드는 HMR 로 모듈을 다시 평가하는데, 모듈 수준 `new Redis()` 였다면 파일을 저장할 때마다 연결이 하나씩 새고 `connected_clients` 가 늘어난다.
- **상한 있는 이력.** 실험 실행 이력(`src/lib/lab-history.ts`)은 Redis Stream 에 `MAXLEN ~ 50` 으로 쓴다. 이력이 무한히 쌓이지 않게 하는 같은 원칙을 저장소 쪽에 적용한 것이다.

## 실습 체크리스트

- [ ] 실험 `node-leak-detect` 를 돌려 누수·고침 버전의 생성자 증가 표 비교
- [ ] 같은 코드를 `node --inspect` 로 띄워 DevTools Comparison 뷰와 Retainers 경로 확인
- [ ] `setMaxListeners(0)` 를 지우고 `--trace-warnings` 로 경고 출처 찾기
- [ ] Map 캐시를 `lru-cache`(max·ttl)로 바꿔 스냅샷 증가가 멈추는지 확인
- [ ] `--expose-gc` 로 WeakMap/Map 의 회수 차이 재현
