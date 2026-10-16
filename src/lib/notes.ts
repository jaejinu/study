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
}

export interface Note extends NoteMeta {
  content: string;
  headings: { depth: number; text: string; id: string }[];
}

const notesDir = (subject: string) => path.join(process.cwd(), "content", subject, "notes");

export function slugify(text: string): string {
  // rehype-slug 와 동일한 규칙(github-slugger)에 가깝게: 소문자, 공백→-, 특수문자 제거(한글 유지)
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function extractHeadings(md: string) {
  const out: Note["headings"] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (line.trim().startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) out.push({ depth: m[1].length, text: m[2].trim(), id: slugify(m[2]) });
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
  };
}

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
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      const { data } = matter(raw);
      return toMeta(f.replace(/\.md$/, ""), data);
    }),
  );
  return metas.sort((a, b) => a.order - b.order);
}

export async function getNote(subject: string, slug: string): Promise<Note | null> {
  if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-z0-9-]+$/.test(subject)) return null;
  try {
    const raw = await fs.readFile(path.join(notesDir(subject), `${slug}.md`), "utf8");
    const { data, content } = matter(raw);
    return { ...toMeta(slug, data), content, headings: extractHeadings(content) };
  } catch {
    return null;
  }
}
