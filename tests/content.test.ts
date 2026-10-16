import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { experiments } from "@/experiments";
import { findExperiment, listLab } from "@/lab/registry";
import { learningPaths, subjects } from "@/lib/subjects";

/**
 * 콘텐츠 무결성 검사 (Redis 없이 돈다).
 * 노트 로더(listNotes)는 YAML 오류를 삼키고 빈 목록을 돌려주므로, 깨진 frontmatter 가 "노트가 사라지는" 조용한 장애가 된다.
 * 여기서 모든 노트·퀴즈·용어집·링크·실험 id 를 엄격하게 검사한다.
 */
const ROOT = process.cwd();
const CONTENT = path.join(ROOT, "content");
const LEVELS = new Set(["기초", "중급", "심화"]);

type NoteFile = { subject: string; slug: string; file: string; data: Record<string, unknown>; body: string };

function loadNotes(): { notes: NoteFile[]; errors: string[] } {
  const notes: NoteFile[] = [];
  const errors: string[] = [];
  for (const s of subjects) {
    const dir = path.join(CONTENT, s.id, "notes");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const file = path.join(dir, f);
      try {
        const { data, content } = matter(fs.readFileSync(file, "utf8"));
        notes.push({ subject: s.id, slug: f.replace(/\.md$/, ""), file: path.relative(ROOT, file), data, body: content });
      } catch (e) {
        errors.push(`${path.relative(ROOT, file)}: frontmatter YAML 오류 — ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  return { notes, errors };
}

const { notes, errors: parseErrors } = loadNotes();
const noteKey = new Set(notes.map((n) => `${n.subject}/${n.slug}`));
const subjectIds = new Set<string>(subjects.map((s) => s.id));
const labIds = new Map<string, Set<string>>(subjects.map((s) => [s.id, new Set(s.id === "redis" ? experiments.map((e) => e.id) : listLab(s.id).map((e) => e.id))]));

describe("주제 정의", () => {
  it("주제 id 가 전역 라우트(src/app 의 폴더)와 겹치지 않는다", () => {
    const routes = fs
      .readdirSync(path.join(ROOT, "src/app"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("[") && !d.name.startsWith("(") && !d.name.startsWith("_"))
      .map((d) => d.name)
      .filter((r) => r !== "redis"); // redis 는 주제 전용 페이지를 가진 의도된 예외
    expect(subjects.map((s) => s.id).filter((id) => routes.includes(id))).toEqual([]);
  });
  it("주제 id 가 중복되지 않는다", () => {
    expect(subjects.length).toBe(subjectIds.size);
  });
  it("학습 경로에 모든 주제가 정확히 한 번 나온다", () => {
    const steps = learningPaths.flatMap((p) => p.steps);
    expect(steps.length).toBe(new Set(steps).size);
    expect([...subjectIds].filter((id) => !steps.includes(id as never))).toEqual([]);
  });
  it("선수 주제는 실제 주제이고, 학습 경로에서 순환하지 않는다", () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string, stack: string[]): void => {
      if (stack.includes(id)) {
        bad.push(`순환: ${[...stack, id].join(" → ")}`);
        return;
      }
      if (seen.has(id)) return;
      seen.add(id);
      for (const p of subjects.find((s) => s.id === id)?.prereq ?? []) {
        if (!subjectIds.has(p)) bad.push(`${id}: 선수 '${p}' 없음`);
        else visit(p, [...stack, id]);
      }
    };
    for (const s of subjects) visit(s.id, []);
    expect(bad).toEqual([]);
  });
});

describe("노트 frontmatter", () => {
  it("모든 노트의 YAML 이 파싱된다", () => {
    expect(parseErrors).toEqual([]);
  });
  it("필수 필드와 값 형식", () => {
    const bad: string[] = [];
    for (const n of notes) {
      const d = n.data;
      if (typeof d.title !== "string" || !d.title.trim()) bad.push(`${n.file}: title 없음`);
      if (typeof d.summary !== "string" || !d.summary.trim()) bad.push(`${n.file}: summary 없음`);
      if (typeof d.order !== "number") bad.push(`${n.file}: order 가 숫자가 아님`);
      if (!LEVELS.has(String(d.level))) bad.push(`${n.file}: level '${String(d.level)}' (기초|중급|심화)`);
      if (d.tags !== undefined && !Array.isArray(d.tags)) bad.push(`${n.file}: tags 가 배열이 아님`);
      if (d.experiments !== undefined && !Array.isArray(d.experiments)) bad.push(`${n.file}: experiments 가 배열이 아님`);
      for (const p of (d.prereq as string[] | undefined) ?? []) if (!noteKey.has(p)) bad.push(`${n.file}: prereq '${p}' 노트 없음`);
    }
    expect(bad).toEqual([]);
  });
  it("같은 주제 안에서 order 가 겹치지 않는다", () => {
    const dup: string[] = [];
    for (const s of subjects) {
      const seen = new Map<number, string>();
      for (const n of notes.filter((x) => x.subject === s.id)) {
        const o = n.data.order as number;
        if (seen.has(o)) dup.push(`${s.id}: order ${o} — ${seen.get(o)} / ${n.slug}`);
        seen.set(o, n.slug);
      }
    }
    expect(dup).toEqual([]);
  });
  it("experiments 에 적힌 id 가 실제 실험이다 (다른 주제의 실험을 증거로 참조해도 된다)", () => {
    const missing: string[] = [];
    for (const n of notes) {
      for (const id of (n.data.experiments as string[] | undefined) ?? []) if (!findExperiment(id, n.subject)) missing.push(`${n.file}: ${id}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("노트 본문 링크", () => {
  it("내부 노트 링크(/<주제>/notes/<slug>)가 모두 존재한다", () => {
    const broken: string[] = [];
    for (const n of notes) {
      for (const m of n.body.matchAll(/\]\(\/([a-z0-9-]+)\/notes\/([a-z0-9-]+)(?:#[^)]*)?\)/g)) {
        if (!noteKey.has(`${m[1]}/${m[2]}`)) broken.push(`${n.file} → /${m[1]}/notes/${m[2]}`);
      }
    }
    expect(broken).toEqual([]);
  });
  it("실험 링크(/<주제>/lab/<id>)가 모두 존재한다", () => {
    const broken: string[] = [];
    for (const n of notes) {
      for (const m of n.body.matchAll(/\]\(\/([a-z0-9-]+)\/lab\/([a-z0-9-]+)\)/g)) {
        if (!labIds.get(m[1])?.has(m[2])) broken.push(`${n.file} → /${m[1]}/lab/${m[2]}`);
      }
    }
    expect(broken).toEqual([]);
  });
  it("다이어그램(/diagrams/*.svg)이 public 에 있다", () => {
    const broken: string[] = [];
    for (const n of notes) {
      for (const m of n.body.matchAll(/\]\(\/diagrams\/([^)\s]+)\)/g)) {
        if (!fs.existsSync(path.join(ROOT, "public/diagrams", m[1]))) broken.push(`${n.file} → /diagrams/${m[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("퀴즈", () => {
  it("모든 카드가 note·q·a 를 갖고, note 가 실제 노트다", () => {
    const bad: string[] = [];
    for (const s of subjects) {
      const f = path.join(CONTENT, s.id, "quiz.json");
      if (!fs.existsSync(f)) continue;
      let cards: unknown;
      try {
        cards = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch (e) {
        bad.push(`${s.id}/quiz.json: JSON 오류 ${(e as Error).message}`);
        continue;
      }
      if (!Array.isArray(cards)) {
        bad.push(`${s.id}/quiz.json: 배열이 아님`);
        continue;
      }
      cards.forEach((c: { note?: string; q?: string; a?: string }, i) => {
        if (!c.q || !c.a) bad.push(`${s.id}/quiz.json[${i}]: q/a 없음`);
        if (!c.note || !noteKey.has(`${s.id}/${c.note}`)) bad.push(`${s.id}/quiz.json[${i}]: note '${c.note}' 없음`);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("용어집", () => {
  const glossary = JSON.parse(fs.readFileSync(path.join(CONTENT, "glossary.json"), "utf8")) as { term: string; subject: string; def: string; link?: string }[];
  it("용어가 중복되지 않는다", () => {
    const seen = new Set<string>();
    const dup = glossary.filter((g) => (seen.has(g.term) ? true : (seen.add(g.term), false))).map((g) => g.term);
    expect(dup).toEqual([]);
  });
  it("subject 가 실제 주제이고 link 가 실제 노트·실험이다", () => {
    const bad: string[] = [];
    for (const g of glossary) {
      if (!subjectIds.has(g.subject)) bad.push(`${g.term}: subject '${g.subject}'`);
      if (!g.def?.trim()) bad.push(`${g.term}: def 없음`);
      const m = g.link?.match(/^\/([a-z0-9-]+)\/(notes|lab)\/([a-z0-9-]+)/);
      if (g.link && m) {
        const ok = m[2] === "notes" ? noteKey.has(`${m[1]}/${m[3]}`) : !!labIds.get(m[1])?.has(m[3]);
        if (!ok) bad.push(`${g.term}: link ${g.link}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
