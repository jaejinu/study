---
name: study-verify
description: 학습 사이트 변경을 커밋·푸시하기 전에 검증하고 규칙대로 커밋할 때 쓴다. main 워크트리 규칙, 깨끗한 복사본 검증(여러 에이전트가 공유 파일을 동시에 고칠 때), tsc·vitest·eslint, CI·e2e 확인까지.
---

# 검증하고 커밋하기

## 규칙

- 커밋·푸시는 **main 브랜치(main 전용 워크트리 `.claude/worktrees/main`)에서만**. 저장소 루트 폴더는 Codex 가 `design/*` 브랜치로 쓴다 — `guard-bash` 훅이 다른 브랜치의 커밋을 막는다.
- 커밋 메시지는 한국어 한 줄 요약 + 필요한 경우 본문, 끝에 `Co-Authored-By` 줄.
- main 에 push 하면 **Vercel 운영 배포**(읽기 전용 공개판)와 CI 가 돈다. 단계마다 작게 커밋·푸시한다.

## 기본 검증

```bash
git branch --show-current            # main 인지
find . -path ./node_modules -prune -o -name "* 2*" -print   # iCloud 충돌 사본 (있으면 원본과 비교 후 삭제)
npx tsc --noEmit
pnpm test                            # vitest (콘텐츠 무결성 포함)
pnpm lint
```

UI 를 건드렸으면 `pnpm e2e`(Playwright + axe), 관측 규칙을 건드렸으면 `pnpm obs:check`(promtool), 실험이면 해당 헤드리스 러너.

## 여러 에이전트가 동시에 작업 중일 때 — 깨끗한 복사본 검증

작업 트리에 다른 기능의 미완성 변경이 섞여 있으면, 내 기능만으로 빌드되는지 따로 확인한다.

```bash
C=$(mktemp -d)            # 스크래치패드 아래가 좋다
git archive HEAD | tar -x -C "$C"
ln -s "$PWD/node_modules" "$C/node_modules"
# 이 기능의 파일만 복사 (zsh 는 $VAR 를 단어 분할하지 않으니 경로를 직접 나열)
tar -cf - src/a.ts content/x/notes/01-y.md | tar -x -C "$C"     # macOS cp 엔 --parents 가 없다
(cd "$C" && npx tsc --noEmit && pnpm vitest run && pnpm lint)
```

`next build` 까지 돌릴 땐 심볼릭 링크 대신 `cp -Rc node_modules "$C"/` (APFS 클론) — Turbopack 은 루트 밖 node_modules 를 거부한다.

공유 파일(Sidebar, TopBar, CommandPalette, package.json, subjects.ts)에 여러 기능의 줄이 섞여 있으면: 이 기능 줄만 남긴 버전으로 잠시 바꿔 `git add` → 원래 전체 버전으로 되돌린다.

## 푸시 후

```bash
gh run list --branch main --limit 4          # CI · e2e
```

배포 확인은 `study-deploy-check` 스킬.
