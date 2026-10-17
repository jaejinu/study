#!/usr/bin/env node
// PreToolUse(Bash) — 이 저장소의 작업 규칙을 명령 실행 전에 지킨다.
//  1) 커밋·푸시는 main 브랜치에서만 (원래 폴더는 Codex 가 design/* 브랜치로 쓴다)
//  2) 학습 기록(Redis 볼륨·backups)을 날리는 명령은 사람에게 확인
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const cmd = String(input.tool_input?.command ?? "");
const cwd = input.cwd || process.cwd();

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
}

const DESTRUCTIVE = [
  [/docker\s+compose\b[^|;&]*\bdown\b[^|;&]*\s(?:-v|--volumes)\b/, "compose down -v 는 study-redis 볼륨(읽음·퀴즈·학습 시간 기록)까지 지운다"],
  [/docker\s+volume\s+(?:rm|prune)\b/, "Docker 볼륨 삭제 — 학습 기록이 든 볼륨일 수 있다"],
  [/docker\s+system\s+prune\b[^|;&]*--volumes/, "볼륨까지 정리하는 system prune"],
  [/\bflushall\b/i, "FLUSHALL 은 학습 기록 키(progress·quiz·study:*)를 모두 지운다"],
  [/\brm\s+-\w*r\w*[^|;&]*[\s/](?:content|backups)(?:\/|\s|$)/, "content/ 또는 backups/(학습 기록 백업) 삭제"],
  [/git\s+push\b[^|;&]*\s(?:-f|--force)\b/, "강제 푸시 — main 은 Vercel 운영 배포와 연결돼 있다"],
];
for (const [re, why] of DESTRUCTIVE) if (re.test(cmd)) decide("ask", `확인 필요: ${why}`);

// git commit / git push 가 어느 폴더에서 도는지: `git -C <dir>` > 앞쪽 `cd <dir> &&` > 세션 cwd
if (/\bgit\b[^|;&]*\s(?:commit|push)\b/.test(cmd)) {
  const unq = (s) => s.replace(/^["']|["']$/g, "");
  const gitC = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd);
  const cd = /(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(cmd);
  const dir = path.resolve(cwd, unq(gitC?.[1] ?? cd?.[1] ?? "."));
  let branch = "";
  try {
    branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    process.exit(0); // git 저장소가 아니면 관여하지 않는다
  }
  if (branch && branch !== "main") {
    decide("deny", `커밋·푸시는 main 브랜치(main 전용 워크트리)에서만 한다. 지금 ${dir} 는 '${branch}' — 원래 폴더는 Codex 가 쓰는 브랜치다. main 워크트리로 옮겨서 다시 실행할 것.`);
  }
}
process.exit(0);
