import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export interface NoteMeta {
  slug: string;
  title: string;
  order: number;
  summary: string;
  tags: string[];
  /** 관련 실험 id 목록 */
  experiments: string[];
  level: "기초" | "중급" | "심화";
  /** 먼저 읽을 노트 ("subject/slug") — frontmatter prereq */
  prereq: string[];
}

export interface Note extends NoteMeta {
  content: string;
  headings: { depth: number; text: string; id: string }[];
}

const notesDir = (subject: string) => path.join(process.cwd(), "content", subject, "notes");

/** 마크다운 인라인 문법을 걷어낸 제목 텍스트 (rehype 가 보는 텍스트와 같게) */
function headingText(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [텍스트](링크) → 텍스트
    .replace(/(\*\*|__|\*|_|`)/g, (m) => (m === "_" ? "_" : "")) // 강조·코드 표시 제거 (단어 속 _ 는 유지)
    .trim();
}

/**
 * rehype-slug 가 쓰는 github-slugger 와 같은 규칙.
 * 소문자 → 문자·숫자·결합 문자·연결 문장부호(_)·하이픈·공백 외 제거 → 공백을 '하나씩' - 로.
 * (예전엔 연속 공백을 - 하나로 합쳐서 "A — B" 가 "a--b" 와 어긋나 목차 링크가 동작하지 않았다)
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

function extractHeadings(md: string) {
  const out: Note["headings"] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of md.split("\n")) {
    if (line.trim().startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = headingText(m[2]);
    // github-slugger 처럼 같은 slug 가 다시 나오면 -1, -2 … (모든 제목 수준을 문서 순서대로 센다)
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n}`;
    if (m[1].length === 2 || m[1].length === 3) out.push({ depth: m[1].length, text, id });
  }
  return out;
}

function toMeta(slug: string, data: Record<string, unknown>): NoteMeta {
  return {
    slug,
    title: String(data.title ?? slug),
    order: Number(data.order ?? 999),
    summary: String(data.summary ?? ""),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    experiments: Array.isArray(data.experiments) ? data.experiments.map(String) : [],
    level: (data.level as NoteMeta["level"]) ?? "기초",
    prereq: Array.isArray(data.prereq) ? data.prereq.map(String) : [],
  };
}

/**
 * 파일 수정 시각(mtime) 기준 메모리 캐시. 첫 화면이 29개 주제 × 노트 수백 편의 frontmatter 를 매 요청 다시 읽지 않도록.
 * 파일이 바뀌면 mtime 이 달라져 자동으로 다시 읽는다 (개발 중 편집도 즉시 반영).
 */
const metaCache = new Map<string, { mtime: number; meta: NoteMeta }>();
const noteCache = new Map<string, { mtime: number; note: Note }>();

export async function listNotes(subject: string): Promise<NoteMeta[]> {
  const dir = notesDir(subject);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const metas = await Promise.all(
    files.map(async (f) => {
      const file = path.join(dir, f);
      const { mtimeMs } = await fs.stat(file);
      const hit = metaCache.get(file);
      if (hit && hit.mtime === mtimeMs) return hit.meta;
      const { data } = matter(await fs.readFile(file, "utf8"));
      const meta = toMeta(f.replace(/\.md$/, ""), data);
      metaCache.set(file, { mtime: mtimeMs, meta });
      return meta;
    }),
  );
  return metas.sort((a, b) => a.order - b.order);
}

export async function getNote(subject: string, slug: string): Promise<Note | null> {
  if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-z0-9-]+$/.test(subject)) return null;
  try {
    const file = path.join(notesDir(subject), `${slug}.md`);
    const { mtimeMs } = await fs.stat(file);
    const hit = noteCache.get(file);
    if (hit && hit.mtime === mtimeMs) return hit.note;
    const { data, content } = matter(await fs.readFile(file, "utf8"));
    const note = { ...toMeta(slug, data), content, headings: extractHeadings(content) };
    noteCache.set(file, { mtime: mtimeMs, note });
    return note;
  } catch {
    return null;
  }
}
