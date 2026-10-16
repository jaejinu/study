---
title: "모듈 시스템 — CommonJS 와 ES 모듈, 패키지 exports 해석, 순환 참조, 동적 import, require(esm)"
order: 8
level: 중급
chapter: "2부 · I/O 와 데이터"
summary: "require 가 하는 일(해석→로딩→래퍼 함수 실행→캐시)과 ESM 이 하는 일(정적 분석→링크→평가)의 근본적 차이, 파일 형식을 정하는 규칙(.mjs·.cjs·package.json type), package.json exports 의 조건부 내보내기와 캡슐화(ERR_PACKAGE_PATH_NOT_EXPORTED 실측), 순환 참조가 CJS 에서는 미완성 객체를, ESM 에서는 TDZ ReferenceError 를 만든다는 실측, Node 22 의 require(esm), 동적 import, 듀얼 패키지 위험, 번들러가 하는 일"
tags: [모듈, CommonJS, ESM, require, import, exports, 순환 참조, 동적 import, require(esm)]
experiments: []
---

## 두 개의 모듈 시스템

| | CommonJS (CJS) | ES 모듈 (ESM) |
|---|---|---|
| 문법 | `require()`, `module.exports` | `import`, `export` |
| 로딩 | **동기**, 실행 중에 | **비동기**, 실행 전에 그래프 전체를 분석 |
| 바인딩 | 값의 **복사**(exports 객체의 그 순간 상태) | **살아 있는 참조**(live binding) |
| 최상위 `await` | ❌ | ✅ |
| `__dirname`, `require` | ✅ | ❌ (`import.meta.dirname`, `import.meta.url`) |
| 조건부 로딩 | `if (x) require(...)` 자유 | 정적 `import` 는 최상위만. 조건부는 `await import()` |
| 트리 셰이킹 | 어렵다 | 정적 구조라 가능 |
| 표준 | Node 고유 | 언어 표준 (브라우저와 같음) |

### require 가 하는 일

```
require("./util")
  1. 해석: 경로 → 절대 파일명 (.js .json .node, index.js, node_modules 탐색)
  2. 캐시 확인: require.cache[파일명] 있으면 그 exports 반환  ← 두 번째부터는 여기서 끝
  3. 로딩: 파일 읽기 (동기 fs)
  4. 래핑: (function (exports, require, module, __filename, __dirname) { …코드… })
  5. 실행 → module.exports 를 캐시에 저장하고 반환
```

래퍼 함수 덕분에 모듈마다 스코프가 따로 생기고, `__dirname` 같은 "전역 같은 지역 변수" 가 생긴다. 캐시 때문에 같은 모듈은 **한 번만 실행**된다 — 모듈 수준 변수가 사실상 싱글턴이다.

### ESM 이 하는 일

```
1. 구성: 진입 파일부터 import 문을 정적으로 따라가 모듈 그래프 전체를 만든다 (파싱만, 실행 안 함)
2. 링크: 각 모듈의 export 이름에 메모리 칸을 만들고 import 를 그 칸에 연결 (live binding)
3. 평가: 의존성 깊은 쪽부터 실행 (최상위 await 가 있으면 그 지점에서 기다림)
```

실행 전에 그래프 전체를 알기 때문에 **없는 이름을 import 하면 실행 전에 에러**가 난다(SyntaxError). CJS 는 실행해 봐야 `undefined` 를 알게 된다.

## 파일 형식은 어떻게 정해지나

| 조건 | 형식 |
|---|---|
| `.mjs` | ESM |
| `.cjs` | CJS |
| `.js` + 가장 가까운 `package.json` 에 `"type": "module"` | ESM |
| `.js` + `"type"` 없음 또는 `"commonjs"` | CJS |
| `--input-type=module`, `--experimental-detect-module` | 명령줄 지정 |

[03 마이크로태스크](/nodejs/notes/03-microtasks-nexttick) 에서 같은 코드가 `.cjs`/`.mjs` 로 nextTick 순서가 바뀐 것은 이 차이 때문이었다.

## package.json exports — 진입점과 캡슐화

```json
{
  "name": "demo-pkg",
  "type": "module",
  "exports": {
    ".": { "import": "./dist/index.mjs", "require": "./dist/index.cjs" },
    "./util": "./dist/util.mjs"
  }
}
```

실측:

```bash
$ node --input-type=module -e 'import { who } from "demo-pkg"; console.log(who)'
esm
$ node -e 'console.log(require("demo-pkg").who)'
cjs
$ node --input-type=module -e 'import("demo-pkg/dist/internal.mjs").catch(e=>console.log(e.code))'
ERR_PACKAGE_PATH_NOT_EXPORTED
```

- **조건부 내보내기:** `import` 로 부르면 `import` 조건, `require` 면 `require` 조건. `node`, `default`, `types`(TypeScript), 사용자 정의 조건(`--conditions=development`)도 있다. 순서가 중요하다 — 위에서부터 첫 일치.
- **캡슐화:** `exports` 에 없는 경로는 **가져올 수 없다**. 내부 파일을 깊게 import 하던 코드가 패키지 업데이트 후 깨지는 이유가 이것이다. 패키지 작성자에게는 공개 API 를 명시할 수단이다.

## 순환 참조 — 실측

`a` 가 `b` 를 불러오고 `b` 가 `a` 를 불러오면?

**CommonJS:** 미완성 객체를 받는다.
```js
// a.cjs                                 // b.cjs
exports.a1 = 1;                          const a = require("./a.cjs");
const b = require("./b.cjs");            console.log("b 에서 본 a =", a);
console.log("a 에서 본 b.done =", b.done);   exports.done = true;
exports.done = true;
```
```bash
$ node a.cjs
b 에서 본 a = { a1: 1 }            # a 는 아직 실행 중 — 그때까지 채운 것만 보인다
a 에서 본 b.done = true
(node:…) Warning: Accessing non-existent property … of module exports inside circular dependency
```

**ESM:** 아직 초기화되지 않은 바인딩에 접근하면 TDZ 에러.
```js
// a.mjs                                  // b.mjs
import { b } from "./b.mjs";              import { a } from "./a.mjs";
export const a = "A";                     export const b = "B";
console.log("a.mjs: b =", b);             console.log("b.mjs: a =", a);
```
```bash
$ node a.mjs
b.mjs: ReferenceError Cannot access 'a' before initialization
a.mjs: b = B
```

| | CJS | ESM |
|---|---|---|
| 순환 시 | 부분적으로 채워진 exports (조용히 undefined) | ReferenceError (시끄럽게) |
| 함수 선언 | 호이스팅돼 쓸 수 있는 경우가 많다 | 함수 선언은 링크 시점에 초기화돼 사용 가능, `const`·`class` 는 TDZ |

해결: 순환을 끊는다(공통 부분을 제3의 모듈로), 또는 사용 시점을 늦춘다(함수 안에서 참조). 이 사이트에서도 실제로 이 문제가 있었다 — 아래 "예시로 보기".

## require(esm) — Node 22

예전에는 CJS 에서 ESM 을 `require` 할 수 없었다(`ERR_REQUIRE_ESM`). Node 22.12+ 에서는 **최상위 await 가 없는 ESM 은 require 할 수 있다.**

```bash
$ node -e 'const m = require("./esm-lib.mjs"); console.log(Object.keys(m), m.default())'
[ '__esModule', 'default', 'x' ] hi
```

최상위 `await` 가 있는 모듈은 여전히 `ERR_REQUIRE_ASYNC_MODULE` 이다(동기 require 로는 기다릴 수 없으니까).

## 동적 import

```js
const { default: heavy } = await import("./heavy.mjs");    // 필요할 때만 로딩
const mod = await import(`./plugins/${name}.mjs`);          // 이름이 실행 시 정해질 때
```

- CJS 에서도 쓸 수 있다(ESM 을 불러오는 정식 방법).
- 처음 한 번 로딩 비용, 이후 캐시.
- 순환 의존을 끊는 데도 쓴다 — 사용 시점까지 import 를 미룬다.

## 듀얼 패키지 위험

같은 패키지를 `import` 로도 `require` 로도 쓰면 **두 벌**이 로드될 수 있다(ESM 판, CJS 판). 그러면:

- 모듈 수준 싱글턴(캐시, 연결 풀)이 두 개가 된다.
- `instanceof` 가 실패한다(서로 다른 클래스).

라이브러리는 한쪽을 다른 쪽의 얇은 래퍼로 만들어 상태를 한 곳에 두는 식으로 피한다.

## 번들러가 하는 일

Next.js(Turbopack)·esbuild·webpack 은 모듈 그래프를 따라가 하나(또는 몇 개)의 파일로 합친다. Node 의 해석 규칙(exports 조건, `"type"`)을 흉내 내지만 완벽하지 않다 — 특히 **네이티브 애드온(.node)** 은 번들할 수 없다.

## 모듈 캐시 — 한 번만 평가된다 — 실측

같은 모듈을 여러 번 불러도 평가는 한 번뿐이고 같은 객체가 돌아온다. 모듈 수준 변수가 사실상 싱글턴이 되는 이유다.

```bash
$ node main.cjs
evaluated
same object: true            # require 두 번 → 같은 module.exports
evaluated                    # require.cache 에서 지운 뒤 다시 require
after delete same: false
$ node x.mjs                 # import("./e.mjs") 두 번, "./e.mjs?v=2" 한 번
esm evaluated
esm evaluated                # 쿼리 문자열이 다르면 다른 모듈로 취급
true false true true         # 같은 URL 은 같은 객체 · 다른 URL 은 다른 인스턴스 · import.meta.dirname/filename 사용 가능
```

| | CommonJS | ES 모듈 |
|---|---|---|
| 캐시 키 | 해석된 파일 경로 | URL (쿼리 포함) |
| 캐시 지우기 | `delete require.cache[path]` | 공식 방법 없음 (URL 을 바꾸는 꼼수뿐) |
| 현재 파일 위치 | `__filename`, `__dirname` | `import.meta.filename`, `import.meta.dirname` (Node 20.11+) |

개발 서버의 HMR 이 ESM 에서 까다로운 이유가 이 캐시 차이다. 운영 코드에서 캐시를 지워 "다시 읽기" 를 구현하면 이전 인스턴스를 붙잡은 참조가 남아 누수가 되기 쉽다([11](/nodejs/notes/11-memory-leaks)).

## 예시로 보기 — 이 프로젝트에서

- **번들하면 안 되는 패키지.** `next.config.ts` 의 `serverExternalPackages: ["ioredis", "@duckdb/node-api", "@duckdb/node-bindings", "@clickhouse/client"]` 는 "이 패키지들은 번들하지 말고 런타임에 Node 의 `require` 로 불러라" 라는 뜻이다. DuckDB 는 네이티브 바인딩(`.node` 파일)을 플랫폼별 패키지(`@duckdb/node-bindings-darwin-arm64`)로 찾는데, Turbopack 이 이를 번들하려다 엉뚱한 플랫폼(`darwin-x64`)을 찾지 못해 **사이트 전체가 500** 이 된 적이 있다. 이 한 줄로 해결했다.
- **순환 참조를 동적 import 로 끊기.** `src/code-lab/ai-agents.ts` 는 `@/lib/assistant/tools`·`@/lib/search` 를 **`run()` 안에서** `await import()` 한다. 이 모듈들이 실험 레지스트리(`@/code-lab`)를 다시 import 하기 때문이다 — 정적 import 로 바꾸면 `code-lab/index.ts → ai-agents.ts → tools.ts → lab/registry.ts → code-lab/index.ts` 순환이 생겨, 레지스트리가 초기화되기 전에 접근하는 TDZ 에러가 난다. `src/shell-lab/platform-engineering.ts` 도 같은 이유로 레지스트리를 동적으로 부른다.
- **ESM 앱, 혼재된 의존성.** 이 앱의 코드는 ESM(TS → 번들)이지만 의존성 중에는 CJS 가 많다(ioredis, pg). 번들러와 Node 가 그 사이를 이어 준다. 실험 스크립트(`scripts/run-code-lab.mts`)는 `.mts` 라 tsx 가 ESM 으로 실행한다.

## 실습 체크리스트

- [ ] 같은 코드를 `.cjs`/`.mjs` 로 만들어 `__dirname`·`import.meta.dirname`·최상위 await 차이 확인
- [ ] 위 순환 참조 예제를 CJS·ESM 으로 각각 재현
- [ ] 작은 패키지에 `exports` 조건부 내보내기를 만들고 내부 경로 import 가 막히는 것 확인
- [ ] `require("./x.mjs")` 가 되는 경우와 최상위 await 때문에 안 되는 경우 비교
- [ ] `node --trace-warnings` 로 순환 참조 경고의 출처 찾기
