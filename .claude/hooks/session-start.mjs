#!/usr/bin/env node
// SessionStart — 세션 시작 시 이 저장소에서 지켜야 할 것을 맥락으로 넣는다 (stdout 이 Claude 에게 전달된다)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const git = (...a) => {
  try {
    return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const branch = git("branch", "--show-current");
const dirty = git("status", "--porcelain").split("\n").filter(Boolean).length;
const lines = [`[study] ${dir} · 브랜치 ${branch || "?"} · 변경 파일 ${dirty}개`];
if (branch && branch !== "main") lines.push(`- 이 폴더는 '${branch}' 브랜치다. 커밋·푸시는 main 워크트리에서만 한다 (guard-bash 훅이 막는다).`);
const home = os.homedir();
if (dir.startsWith(`${home}/Documents/`) || dir.startsWith(`${home}/Desktop/`) || dir.includes("/Mobile Documents/")) {
  lines.push("- 경고: iCloud 동기화 폴더 안이다. ' 2' 충돌 사본이 생길 수 있다 — ~/dev 같은 동기화 밖으로 옮기는 것이 좋다.");
}
lines.push("- 응답은 한국어. 노트는 예시·표·'예시로 보기 — 이 프로젝트에서'·심화·체크리스트까지 깊게. 스킬: study-note · study-lab · study-verify · study-deploy-check");
process.stdout.write(lines.join("\n") + "\n");
