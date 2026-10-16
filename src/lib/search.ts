import { listNotes, getNote } from "./notes";
import { subjects } from "./subjects";
import { experiments } from "@/experiments";
import { listLab } from "@/lab/registry";

export interface SearchHit {
  kind: "note" | "lab";
  subject: string;
  subjectName: string;
  title: string;
  href: string;
  score: number;
  snippet: string;
}

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetAround(text: string, terms: string[], width = 140): string {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    idx = lower.indexOf(t);
    if (idx >= 0) break;
  }
  if (idx < 0) return text.slice(0, width).replace(/\s+/g, " ") + (text.length > width ? "…" : "");
  const start = Math.max(0, idx - width / 3);
  const end = Math.min(text.length, idx + width);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
}

/** 모든 주제의 노트 본문과 실험 제목/설명을 단순 점수로 검색한다 */
export async function searchAll(query: string, limit = 40): Promise<SearchHit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  const hasAll = (hay: string) => terms.every((t) => hay.includes(t));

  for (const s of subjects) {
    const metas = await listNotes(s.id);
    for (const m of metas) {
      const note = await getNote(s.id, m.slug);
      if (!note) continue;
      const body = note.content.replace(/```[\s\S]*?```/g, (b) => b.replace(/\n/g, " "));
      const hayTitle = `${m.title} ${m.summary} ${m.tags.join(" ")}`.toLowerCase();
      const hayBody = body.toLowerCase();
      if (!hasAll(hayTitle + " " + hayBody)) continue;
      let score = 0;
      for (const t of terms) {
        if (m.title.toLowerCase().includes(t)) score += 10;
        if (m.summary.toLowerCase().includes(t)) score += 5;
        if (m.tags.some((x) => x.toLowerCase().includes(t))) score += 6;
        score += Math.min(10, (hayBody.match(new RegExp(esc(t), "g")) ?? []).length);
      }
      hits.push({ kind: "note", subject: s.id, subjectName: s.name, title: m.title, href: `/${s.id}/notes/${m.slug}`, score, snippet: snippetAround(body, terms) });
    }
    const labs = s.id === "redis" ? experiments.map((e) => ({ id: e.id, title: e.title, summary: e.summary, description: e.description, href: `/redis/lab/${e.id}` })) : listLab(s.id).map((e) => ({ ...e, href: `/${s.id}/lab/${e.id}` }));
    for (const e of labs) {
      const hay = `${e.title} ${e.summary} ${e.description}`.toLowerCase();
      if (!hasAll(hay)) continue;
      let score = 0;
      for (const t of terms) {
        if (e.title.toLowerCase().includes(t)) score += 8;
        if (e.summary.toLowerCase().includes(t)) score += 4;
        score += Math.min(5, (hay.match(new RegExp(esc(t), "g")) ?? []).length);
      }
      hits.push({ kind: "lab", subject: s.id, subjectName: s.name, title: `⚗ ${e.title}`, href: e.href, score, snippet: snippetAround(e.summary + " " + e.description, terms) });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
