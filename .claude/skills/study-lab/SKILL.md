---
name: study-lab
description: 학습 사이트에 실험(실험실 lab)을 추가하거나 고치고, 헤드리스로 돌려 PASS 를 확인할 때 쓴다. 셸 실험(docker·k8s·nginx 등)과 코드 실험(kafka·postgres·nodejs 등)의 구조, 장애 주입 시 데드맨 스위치, 포트 규칙을 다룬다.
---

# 실험 만들기

실험은 노트의 "증거"다. 노트에서 말한 수치·동작을 사용자가 버튼 한 번으로 재현할 수 있어야 한다.

## 어느 쪽에 넣나

| 종류 | 위치 | 쓰는 경우 | 헤드리스 실행 |
|---|---|---|---|
| Redis | `src/experiments/*.ts` | Redis 명령 동작 | `pnpm test` (tests/experiments.test.ts) |
| 셸 | `src/shell-lab/<주제>.ts` (`ShellExperiment`) | docker·kubectl·curl·nginx 등 CLI | `pnpm exec tsx scripts/run-shell-lab.mts <주제> [id]` |
| 코드 | `src/code-lab/<주제>.ts` (`CodeExperiment`) | 라이브러리로 직접 (kafka, pg, opensearch, 런타임) | `pnpm exec tsx scripts/run-code-lab.mts <주제> [id]` |

새 주제면 `src/lab/registry.ts` 의 `SHELL`/`CODE` 집합과 `types.ts` 의 주제 유니온에 추가한다.

## 실험 한 개의 형태

- `id` 는 전역 유일 (`<주제약어>-<무엇>`, 예: `java-virtual-threads`)
- `title`·`category`·`summary`·`description`(무엇을 보게 되는가)·`code`(화면에 보여 줄 핵심 코드)·`notes`(연결 노트 slug)
- 셸: `ctx.sh(bin, args)` 로 실행·기록, `ctx.check(label, ok, detail)` 로 **기대값을 단언**, `ctx.poll` 로 수렴 대기, `ctx.table`·`ctx.measure` 로 수치 표시
- 코드: `requires()` 가 의존 서비스가 꺼져 있으면 이유 문자열을 돌려줘 FAIL 대신 "필요: pnpm kafka:up" 같은 안내가 뜨게 한다
- 만든 리소스(컨테이너·토픽·테이블·키)는 실험 접두어(`ctx.k(name)`)를 쓰고 끝에서 정리한다

## 장애 주입은 데드맨 스위치 필수

컨테이너 pause·stop, Redis 설정 변경처럼 원복이 필요한 실험은 중단되면 study-redis 가 멈춘 채 남는다 (실제로 3시간 사고가 있었다).

```ts
const dm = armUnpause("study-redis", 90);          // src/lib/deadman.ts — 또는 armRestart / armRedisConfigRestore
try { /* 장애 주입 + 관찰 */ } finally { dm.disarm(); /* 정상 원복 */ }
```

## 포트

이 프로젝트 포트: 6379, 6381-6383, 26381-26383, 7001-7006, 19092, 15432, 18083, 19090, 19093, 13000, 13001, 13100, 13200, 14317/14318, 12346, 18080, 18443, 3200, 19091, 19100. 사용자의 다른 프로젝트(ticketing)가 6390/6391/3100/4317/9092 를 쓰므로 새 포트는 겹치지 않게. compose 는 항상 `-p study`.

## 완료 조건

1. 헤드리스로 **PASS** (의존 서비스는 `pnpm kafka:up` / `pg:up` / `cdc:up` / `obs:up` 등으로 켠다)
2. 노트 frontmatter `experiments` 에 id 연결, `pnpm vitest run tests/content.test.ts` 통과
3. 서버리스(Vercel 읽기 전용)에서 네이티브 모듈은 실행 시점에만 `await import()` — 최상위 import 하면 노트 페이지까지 500 이 난다 (DuckDB 사고)
