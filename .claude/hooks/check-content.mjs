#!/usr/bin/env node
// 콘텐츠 빠른 검사 — tests/content.test.ts 의 핵심만 바뀐 파일에 대해 즉시 돌린다.
// 노트 로더는 YAML 오류를 삼키고 노트를 조용히 숨기므로, 깨진 frontmatter 를 쓰는 순간 잡는다.
//   post : PostToolUse(Edit|Write) — 방금 쓴 파일 하나
//   stop : Stop — git 이 보기에 바뀐 content/ 파일 전부 (Bash 로 쓴 파일까지)
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2] ?? "post";
const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (mode === "stop" && input.stop_hook_active) process.exit(0); // 한 번 막았으면 두 번 막지 않는다

const ROOT = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
let matter = null;
try {
  matter = createRequire(path.join(ROOT, "package.json"))("gray-matter");
} catch {}

const LEVELS = new Set(["기초", "중급", "심화"]);
const rel = (f) => path.relative(ROOT, path.resolve(ROOT, f)).split(path.sep).join("/");
const noteExists = (s, slug) => fs.existsSync(path.join(ROOT, "content", s, "notes", `${slug}.md`));

function checkNote(file) {
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!raw.startsWith("---")) return ["frontmatter(---) 로 시작해야 한다"];
  if (!matter) return [];
  let d, body;
  try {
    ({ data: d, content: body } = matter(raw));
  } catch (e) {
    return [`frontmatter YAML 오류 — ${String(e.message).split("\n")[0]} (title·summary 에 ': ' 가 있으면 따옴표로 감싼다)`];
  }
  const errs = [];
  for (const k of ["title", "summary"]) if (typeof d[k] !== "string" || !d[k].trim()) errs.push(`${k} 가 비었다`);
  if (typeof d.order !== "number") errs.push("order 는 숫자");
  if (!LEVELS.has(String(d.level))) errs.push(`level '${d.level}' — 기초|중급|심화`);
  if (d.tags !== undefined && !Array.isArray(d.tags)) errs.push("tags 는 배열");
  if (d.experiments !== undefined && !Array.isArray(d.experiments)) errs.push("experiments 는 배열");
  if (d.chapter !== undefined && (typeof d.chapter !== "string" || !d.chapter.trim())) errs.push("chapter 는 비어 있지 않은 문자열");
  for (const p of d.prereq ?? []) if (!noteExists(...String(p).split("/"))) errs.push(`prereq '${p}' 노트 없음`);
  for (const m of body.matchAll(/\]\(\/([a-z0-9-]+)\/notes\/([a-z0-9-]+)(?:#[^)]*)?\)/g)) if (!noteExists(m[1], m[2])) errs.push(`깨진 노트 링크 /${m[1]}/notes/${m[2]}`);
  for (const m of body.matchAll(/\]\((\/diagrams\/[^)\s#]+)/g)) if (!fs.existsSync(path.join(ROOT, "public", m[1]))) errs.push(`없는 다이어그램 ${m[1]}`);
  return errs;
}

function checkJson(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
  } catch (e) {
    return [`JSON 파싱 오류 — ${e.message}`];
  }
  if (!Array.isArray(data)) return ["최상위는 배열이어야 한다"];
  const errs = [];
  if (file === "content/glossary.json") {
    const seen = new Set();
    for (const g of data) {
      if (!g.term || !g.subject || !g.def) errs.push(`term·subject·def 누락: ${JSON.stringify(g).slice(0, 80)}`);
      if (seen.has(g.term)) errs.push(`중복 용어 '${g.term}' — 다른 주제 쪽은 '용어 (주제)' 처럼 이름을 바꾼다`);
      seen.add(g.term);
      const m = /^\/([a-z0-9-]+)\/notes\/([a-z0-9-]+)/.exec(g.link ?? "");
      if (m && !noteExists(m[1], m[2])) errs.push(`'${g.term}' link 의 노트 없음: ${g.link}`);
    }
  } else {
    const subject = file.split("/")[1];
    for (const [i, c] of data.entries()) {
      if (!c.note || !c.q || !c.a) errs.push(`#${i} note·q·a 누락`);
      else if (!noteExists(subject, c.note)) errs.push(`#${i} note '${c.note}' 가 ${subject} 노트에 없다`);
    }
  }
  return errs.slice(0, 15);
}

function check(file) {
  if (/ 2(\.[^/]*)?$/.test(file)) return ["iCloud·Finder 충돌 사본(' 2') — 원본과 비교 후 지운다"];
  if (/^content\/[a-z0-9-]+\/notes\/[^/]+\.md$/.test(file)) return checkNote(file);
  if (/^content\/(?:glossary|[a-z0-9-]+\/quiz)\.json$/.test(file)) return checkJson(file);
  return [];
}

let files = [];
if (mode === "post") {
  const f = input.tool_input?.file_path;
  if (f && fs.existsSync(f)) files = [rel(f)];
} else {
  try {
    const out = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "-uall", "--", "content"], { encoding: "utf8" });
    files = out.split("\n").filter((l) => l && !l.startsWith(" D") && !l.startsWith("D ")).map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop());
  } catch {}
}

const report = [];
for (const f of files) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  const errs = check(f);
  if (errs.length) report.push(`${f}\n${errs.map((e) => `  - ${e}`).join("\n")}`);
}
if (report.length) {
  process.stderr.write(`콘텐츠 검사 실패 (고친 뒤 \`pnpm vitest run tests/content.test.ts\` 로 전체 확인):\n${report.join("\n")}\n`);
  process.exit(2);
}
process.exit(0);
