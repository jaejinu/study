---
title: "심화 — V8 실행 파이프라인: Ignition · Sparkplug · Maglev · TurboFan, 히든 클래스, 인라인 캐시, 탈최적화"
order: 9
level: 심화
chapter: "3부 · V8 과 메모리"
summary: "자바스크립트가 파싱 → 바이트코드(Ignition) → 기준선 기계어(Sparkplug) → 최적화 기계어(Maglev·TurboFan)로 단계적으로 빨라지는 원리와 타입 피드백, 같은 모양의 객체가 히든 클래스(맵)를 공유하고 인라인 캐시가 프로퍼티 접근을 상수 시간으로 만드는 과정, 모양이 4개를 넘으면 메가모픽이 되어 같은 루프가 13.6ms→53.2ms 로 느려지는 실측, 숫자 함수에 문자열을 넣자 'not a Smi' 로 탈최적화되는 --trace-deopt 실측, 성능을 위해 실제로 지킬 만한 규칙"
tags: [V8, JIT, Ignition, Sparkplug, Maglev, TurboFan, 히든 클래스, 인라인 캐시, 탈최적화, Smi]
experiments: [node-gc-heap]
---

## 자바스크립트는 어떻게 빨라지나 — 단계적 컴파일

자바스크립트는 타입이 정해져 있지 않다. `a + b` 는 숫자 덧셈일 수도, 문자열 이어 붙이기일 수도, 객체의 `valueOf` 호출일 수도 있다. V8 은 이 문제를 **"일단 느리게 실행하면서 관찰하고, 자주 쓰이는 코드만 관찰 결과에 맞춰 빠른 기계어로 바꾼다"** 로 푼다.

![V8 파이프라인과 GC 세대](/diagrams/node-v8-gc.svg)

| 단계 | 무엇 | 속도 | 언제 |
|---|---|---|---|
| **파서** | 소스 → AST. 함수 본문은 처음 호출될 때까지 미루기도 함(lazy parsing) | — | 로딩 |
| **Ignition** | AST → **바이트코드** → 인터프리터로 실행. 실행하며 **타입 피드백** 수집 | 기준 | 처음부터 |
| **Sparkplug** | 바이트코드를 거의 그대로 기계어로 (최적화 없음, 매우 빠른 컴파일) | 약간 빠름 | 조금 뜨거워지면 |
| **Maglev** | 피드백을 이용한 중간 수준 최적화 컴파일러 | 빠름 | 더 뜨거워지면 (Node 22 의 V8 12.4 에서는 플래그 기본값이 `--no-maglev`) |
| **TurboFan** | 공격적 최적화: 인라이닝, 탈출 분석, 타입 특화 | 가장 빠름 | 아주 뜨겁고 타입이 안정적일 때 |

이 Mac 의 Node 22 에서 확인:

```bash
$ node --v8-options | grep -A1 -E "^\s+--(maglev|sparkplug|turbofan) "
  --maglev     default: --no-maglev
  --sparkplug  default: --sparkplug
  --turbofan   default: --turbofan

$ node --trace-opt -e 'function f(x){return x*2} for(let i=0;i<2e5;i++) f(i)' 2>&1 | grep -oE "target (SPARKPLUG|MAGLEV|TURBOFAN)" | sort | uniq -c
   6 target TURBOFAN
```

뜨거운 함수 `f` 와 그 루프(OSR — 실행 중인 루프를 그 자리에서 최적화본으로 바꾸는 *on-stack replacement*)가 TurboFan 으로 올라갔다. 이 버전에서는 Maglev 가 꺼져 있어 Sparkplug 다음이 바로 TurboFan 이다(최신 V8·Chrome 에서는 Maglev 가 켜져 있다 — 버전마다 다르다는 것이 요점이다).

## 타입 피드백과 Smi

Ignition 은 연산마다 **"지금까지 이 자리에 어떤 타입이 왔는가"** 를 기록한다. 예를 들어 `x * 2` 의 `x` 에 계속 작은 정수가 오면 TurboFan 은 "정수 곱셈 + 오버플로 검사" 만 하는 기계어를 만든다.

V8 은 작은 정수를 **Smi**(small integer, 31/32비트)로 포인터 안에 직접 담는다. 객체 할당이 없어 매우 빠르다. 실수나 큰 정수는 **HeapNumber**(힙에 할당된 상자)가 된다.

최적화된 코드는 **가정**을 깔고 있다. 가정이 깨지면?

## 탈최적화(deopt) — 실측

```js
function add(a, b) { return a + b; }
for (let i = 0; i < 1e6; i++) add(i, i);   // 정수만 → TurboFan 이 "Smi 덧셈" 으로 최적화
add("x", 1);                                // 문자열! 가정 깨짐
for (let i = 0; i < 1e5; i++) add(i, i);
```

```bash
$ node --trace-deopt deopt.cjs 2>&1 | grep bailout
[bailout (kind: deopt-eager, reason: Insufficient type feedback for call): begin. deoptimizing <JSFunction (sfi = …)> … <Code TURBOFAN> …]
[bailout (kind: deopt-eager, reason: not a Smi): begin. deoptimizing <JSFunction add (sfi = …)> … <Code TURBOFAN> …]
```

`reason: not a Smi` — 최적화된 `add` 가 "a 는 Smi" 라고 가정했는데 문자열이 왔다. V8 은 그 자리에서 **최적화 코드를 버리고 인터프리터로 돌아간다**(deoptimize). 이후 다시 피드백을 모아(이제는 문자열도 섞였으니 더 일반적인 코드로) 재최적화한다.

| deopt 원인 (흔한 것) | 예 |
|---|---|
| `not a Smi` / `not a HeapNumber` | 숫자 함수에 문자열·undefined |
| `wrong map` | 다른 모양의 객체가 들어옴 (아래) |
| `out of bounds` | 배열 범위 밖 접근, 구멍 난 배열 |
| `Insufficient type feedback` | 아직 실행된 적 없는 분기 |
| `division by zero`, `minus zero` | 정수 가정 깨짐 |

deopt 한 번은 큰일이 아니다. **같은 함수가 최적화 ↔ 탈최적화를 반복**하면(deopt loop) 느려진다. 운영에서 갑자기 느려진 핫 함수를 `--trace-deopt` 로 보면 원인이 나온다.

## 히든 클래스(맵)와 인라인 캐시

자바스크립트 객체는 사전(dictionary)처럼 보이지만, V8 은 **같은 모양(같은 프로퍼티를 같은 순서로)** 의 객체에 **히든 클래스**(V8 내부 이름: Map)를 붙여 C 구조체처럼 다룬다.

```js
function P(x, y) { this.x = x; this.y = y; }   // 모든 P 는 같은 맵 — x 는 오프셋 0, y 는 오프셋 1
const a = new P(1, 2), b = new P(3, 4);         // a, b 는 같은 히든 클래스
```

프로퍼티를 읽는 자리(`p.x`)마다 **인라인 캐시(IC)** 가 있다. 처음 `p.x` 를 실행할 때 "맵 M 이면 오프셋 0" 을 기억해 두고, 다음부터는 맵만 비교하고 바로 읽는다.

| IC 상태 | 그 자리에 온 맵 수 | 비용 |
|---|---|---|
| monomorphic | 1 | 맵 비교 한 번 — 가장 빠름 |
| polymorphic | 2~4 | 몇 번 비교 |
| **megamorphic** | 5 이상 | 전역 해시 캐시 조회 — 훨씬 느림, 최적화도 어렵다 |

### 실측 — 모양 수에 따른 같은 루프의 시간

```js
function sum(arr) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i].x; return s; }
// shapes 개의 서로 다른 모양({s0, x}, {s1, x}, …)을 섞은 100만 개 배열을 20번 순회
```

| 모양 수 | 시간 | IC 상태 |
|---|---|---|
| 1 | **13.6ms** | monomorphic |
| 2 | 20.7ms | polymorphic |
| 4 | **53.2ms** | polymorphic(한계) |
| 8 | 44.9ms | megamorphic |
| 16 | 46.0ms | megamorphic |

같은 `.x` 읽기가 모양이 하나일 때보다 **3~4배** 느려졌다. 4 이상에서 비슷하게 머무는 것은 megamorphic 경로(전역 캐시)로 넘어갔기 때문이다.

> 처음 실측으로 `{x,y}`·`{y,x}`·`{x,y,z}`·`{x,w,y}` 네 모양을 섞었을 때는 mono 55ms vs poly 49ms 로 차이가 없었다. 그 배열은 **같은 모양끼리 연속**이 아니라 섞였어도, 원소의 접근이 메모리·캐시 효과에 더 크게 좌우됐다. 마이크로벤치마크는 측정 조건 하나로 결론이 뒤집힌다 — [성능 공학 02](/performance/notes/02-measurement-methodology) 의 경고 그대로다.

### 모양을 깨는 코드

```js
const o = {};            // 빈 맵 M0
o.a = 1;                 // M0 → M1 전이
o.b = 2;                 // M1 → M2
const p = {};
p.b = 2; p.a = 1;        // 순서가 다르면 다른 맵! (M0 → M3 → M4)
delete o.a;              // delete → '사전 모드'로 떨어질 수 있다 — 느린 해시 테이블
```

## 실제로 지킬 만한 규칙

마이크로 최적화보다 **알고리즘·I/O·할당 줄이기**가 먼저다. 그래도 핫 경로에서는:

| 규칙 | 이유 |
|---|---|
| 객체는 생성자/리터럴에서 **모든 필드를 같은 순서로** 초기화 | 맵 공유, monomorphic IC |
| `delete obj.x` 대신 `obj.x = undefined` (또는 새 객체) | 사전 모드 방지 |
| 핫 함수에 다양한 타입을 섞지 말기 (`number` 함수에 문자열) | deopt 방지 |
| 배열은 같은 종류 원소로, 구멍(`arr[1000]=1`) 만들지 말기 | 원소 종류(packed SMI/DOUBLE/ELEMENTS) 유지 |
| `arguments`, `eval`, `with` 피하기 | 최적화 방해 |
| 거대한 `switch`/함수 하나보다 작은 함수 여러 개 | 인라이닝·최적화 단위 |
| `try/catch` 는 이제 괜찮다 | 예전(크랭크샤프트 시절) 미신 |

TypeScript 로 타입을 고정하면 V8 이 보는 타입도 대체로 일관돼 위 규칙이 자연스럽게 지켜진다 — TS 의 타입 자체가 V8 에 전달되는 것은 아니다.

## 관찰 도구

| 플래그 | 보여 주는 것 |
|---|---|
| `--trace-opt` | 어떤 함수가 어떤 단계로 최적화되나 |
| `--trace-deopt` | 탈최적화와 이유 |
| `--allow-natives-syntax` + `%OptimizeFunctionOnNextCall(f)`, `%GetOptimizationStatus(f)` | 실험용(운영 금지) |
| `--prof` + `node --prof-process` | 틱 샘플링 — JIT 함수 이름 포함 |
| `--cpu-prof` | Chrome DevTools 형식 프로파일 ([13](/nodejs/notes/13-profiling-diagnostics)) |

## 예시로 보기 — 이 프로젝트에서

- **노트 메타는 같은 모양이다.** `src/lib/notes.ts` 의 `toMeta()` 는 모든 노트 메타 객체를 같은 필드(`slug, title, order, summary, tags, experiments, level, prereq, chapter`)를 같은 순서로 채운다. frontmatter 에 `chapter` 가 없으면 `undefined` 를 넣지, 필드를 빼지 않는다. 첫 화면이 수백 개 메타를 `filter`·`map` 할 때 IC 가 monomorphic 으로 유지된다.
- **실험 결과 Step 의 모양.** `src/lib/trace.ts` 의 기록은 항상 `{ cmd, result, ms, note?, error? }` 이다. `note`·`error` 가 있었다 없었다 하므로 엄밀히는 두세 가지 모양이 섞인다 — 수백 개 수준이라 아무 문제가 없지만, 수백만 개를 다루는 코드라면 항상 모든 필드를 채우는 편이 낫다.
- **로그 객체.** `src/lib/log.ts` 는 `{ ...fields, ts, level, msg, service, ...trace }` 로 매번 다른 필드 조합의 객체를 만든다 — 로그 객체는 바로 `JSON.stringify` 되고 버려지는 짧은 수명이라 맵이 많아도 괜찮다. 수명이 긴 캐시 객체와 짧은 로그 객체는 기준이 다르다.

## 실전에서는 어디에 쓰이나

> V8 최적화 지식은 핫 경로가 이유 없이 느려졌을 때, CPU 프로파일에서 특정 함수가 튈 때 쓰인다. 대부분의 서비스에서는 알고리즘·I/O 다음의 마지막 단계다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 고처리량 변환·직렬화 서비스 | 핫 루프의 객체 모양이 제각각 | 생성자·리터럴에서 모든 필드를 같은 순서로 | 스키마 기반 직렬화 라이브러리 |
| 실시간 게임 서버 로직 | 숫자 함수에 다른 타입이 섞여 탈최적화 반복 | `--trace-deopt` 로 원인 찾고 타입 고정 | 핫 경로만 WebAssembly·네이티브 |
| 라이브러리·프레임워크 개발 | 다양한 입력 모양으로 megamorphic IC | 입력을 한 모양으로 정규화, 핫 함수 분리 | — |
| Node 업그레이드 후 성능 회귀 | 컴파일러 단계 변화의 영향 확인 | `--trace-opt`·`--prof` 로 전후 비교 | 벤치마크 CI |

**이럴 땐 안 맞는다**
- I/O 대기가 대부분인 일반 API — 히든 클래스보다 쿼리·왕복·할당이 먼저다. 프로파일로 확인한 뒤에.
- 마이크로벤치마크 하나로 결론 — 측정 조건 하나에 결과가 뒤집힌다(본문의 첫 실측처럼).

**누가 매일 만나나** — 성능 엔지니어·런타임 담당이 CPU 프로파일 상위 함수를 파고들 때, 라이브러리 작성자가 핫 경로를 다듬을 때. 일반 백엔드 개발자는 가끔 만난다.

**면접·실무 단골 질문**
- Q. 히든 클래스와 인라인 캐시 → 같은 모양 객체가 맵을 공유하고, IC 는 맵 비교만으로 오프셋을 바로 읽는다.
- Q. 탈최적화는 언제 일어나나 → 최적화 가정(Smi, 맵)이 깨질 때. 반복되면 deopt loop 로 느려진다.

## 실습 체크리스트

- [ ] `--trace-opt` 로 뜨거운 함수가 TurboFan 으로 올라가는 것 확인
- [ ] 숫자 함수에 문자열을 한 번 넣고 `--trace-deopt` 로 `not a Smi` 확인
- [ ] 모양 1·2·4·8·16 개 객체 배열로 같은 `.x` 합계 루프의 시간 비교
- [ ] `delete` 를 쓴 객체와 안 쓴 객체의 프로퍼티 접근 속도 비교
- [ ] `node --prof` + `--prof-process` 로 가장 많이 샘플된 함수 찾기
