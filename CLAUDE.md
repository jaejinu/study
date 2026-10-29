# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

개인 학습 사이트(한국어). 응답·노트·커밋 메시지 모두 한국어.

## 작업 위치 — 가장 중요

- 커밋·푸시는 **main 워크트리 `~/dev/study/.claude/worktrees/main` 에서만**. 루트 `~/dev/study` 는 Codex 가 `design/focused-study-ui` 브랜치로 쓰는 폴더라 건드리지 않는다(`guard-bash` 훅이 main 외 커밋을 막는다).
- `main` 푸시 = Vercel 프로덕션 배포(https://jaejinu-study.vercel.app, `STUDY_READ_ONLY=1`, 리전 icn1). 공개판은 읽기 전용이라 학습 기록이 저장되지 않는다 — 기록은 로컬(localhost:3000)에만 쌓인다.
- 저장소를 iCloud 폴더(`~/Documents`, `~/Desktop`) 안에 두지 않는다 — `이름 2.md` 충돌 사본이 생긴다. docker compose 는 `--project-directory ~/dev/study` 를 붙인다(셸 PWD 가 옛 경로로 남는 경우가 있음).

## 검증 (CI 와 같은 순서)

```bash
pnpm lint
pnpm exec tsc --noEmit -p tsconfig.json   # 타입 검사 스크립트는 없다
pnpm test                                 # Redis 필요: REDIS_URL (기본 6379)
pnpm exec vitest run tests/content.test.ts   # 파일 하나만
```

- 포매터(Prettier/Biome) 없음 — 주변 코드 스타일을 따른다.
- `tests/content.test.ts` 가 콘텐츠의 유일한 안전망이다(노트 로더는 YAML 오류를 삼켜서 노트가 조용히 사라진다). 훅의 빠른 검사는 부분 집합일 뿐, 최종 판정은 `pnpm test`.
- e2e: `pnpm e2e` 는 이미 떠 있는 서버(`E2E_BASE_URL`, 기본 **3310**)를 친다. 빌드부터 하려면 `pnpm build && E2E_START=1 pnpm e2e`.
- 읽기 전용 모드 확인: `STUDY_READ_ONLY=1` 은 빌드·런타임 **둘 다** 필요.

## 콘텐츠·실험 규칙

- 노트: `content/<subject>/notes/NN-slug.md`, 퀴즈 `quiz.json`, 용어 `content/glossary.json`. 주제·트랙 등록은 `src/lib/subjects.ts` — 주제 id 는 전역 라우트(`search`, `glossary`, `graph`, `assistant`, `review`, `path` …)와 겹치면 안 된다.
- frontmatter `title`/`summary` 에 `: ` 가 있으면 반드시 따옴표.
- 노트 작성·수정은 `study-note` 스킬, 실험은 `study-lab` 스킬을 따른다.
- 실험 등록: Redis `src/experiments/*.ts`(각 파일이 vitest 테스트가 됨), 셸 `src/shell-lab/<subject>.ts`, 코드 `src/code-lab/<subject>.ts`, 전체는 `src/lab/registry.ts`.
- 장애 주입 실험은 `src/lib/deadman.ts` 의 `armUnpause`/`armRestart`/`armRedisConfigRestore` 를 먼저 걸고 `finally` 에서 `disarm()` — 빠뜨리면 중단 시 Redis 가 멈춘 채 남는다.
- 노트를 추가·수정하면 의미 검색 색인 갱신: `pnpm search:up && pnpm search:index`.

## 건드리면 안 되는 것

- Redis 볼륨과 `backups/` 는 사용자의 학습 기록(`progress:*`, `quiz:stats:*`, `study:*`, `lab:runs:*`, `memo:*`)이다. `FLUSHALL`, `compose down -v`, 볼륨 삭제 금지.
- 포트: 다른 프로젝트(`ticketing`)가 6390/6391/3100/4317/9092 를 쓴다. 새 포트는 기존 것(README 의 포트 표)과 겹치지 않게. compose 는 항상 `-p study`.
- `AGENTS.md` 는 `next dev` 가 다시 쓰는 파일이라 diff 가 생겨도 정상.

## 커밋

- 메시지: 한국어 한 줄 요약(무엇을 왜), 본문 선택. 단계마다 커밋·푸시하고 CI 를 확인한다.
