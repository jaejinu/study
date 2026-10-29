#!/usr/bin/env node
// 방금 고친 TS/JS 파일 하나만 ESLint — 전체 `pnpm lint` 를 기다리지 않고 바로 결과를 받는다.
// PostToolUse(Edit|Write|MultiEdit). 위반이 있으면 exit 2 로 stderr 를 Claude 에게 돌려준다(차단은 아님).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const file = input.tool_input?.file_path ?? input.tool_response?.filePath;
if (!file || !/\.(ts|tsx|mts|mjs|js)$/.test(file) || !fs.existsSync(file)) process.exit(0);

// 파일이 속한 워크트리의 eslint 를 쓴다 (루트 폴더와 main 워크트리가 다를 수 있다)
let root = path.dirname(path.resolve(file));
while (!fs.existsSync(path.join(root, "node_modules/.bin/eslint"))) {
  const up = path.dirname(root);
  if (up === root) process.exit(0);
  root = up;
}
const rel = path.relative(root, file);
if (rel.startsWith("..") || /(^|\/)(node_modules|\.next|\.claude)\//.test(rel)) process.exit(0);

try {
  execFileSync(path.join(root, "node_modules/.bin/eslint"), ["--no-warn-ignored", rel], { cwd: root, stdio: "pipe", timeout: 50_000 });
} catch (e) {
  if (e.status === 1) {
    process.stderr.write(`ESLint (${rel}):\n${e.stdout}`);
    process.exit(2);
  }
  // eslint 자체 오류·타임아웃은 작업을 막지 않는다
}
