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

/** 자연어 질문에서 검색에 쓸모없는 말 */
const STOP = new Set(["이", "그", "저", "것", "수", "좀", "더", "왜", "뭐", "뭐야", "무엇", "어떻게", "설명", "설명해", "알려", "알려줘", "해줘", "줘", "있어", "있나", "하는", "하면", "대해", "대한", "관련", "노트", "내용", "부분", "the", "a", "an", "is", "what", "how", "why", "and", "or", "to", "of"]);

/** "파이프라인은" → "파이프라인" (자연어 질문용, 한 글자 조사만 보수적으로) */
const JOSA = ["에서", "으로", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만"];
function stripJosa(t: string): string {
  if (!/[가-힣]$/.test(t)) return t;
  for (const j of JOSA) if (t.length - j.length >= 2 && t.endsWith(j)) return t.slice(0, -j.length);
  return t;
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

/**
 * 모든 주제의 노트 본문과 실험 제목/설명을 단순 점수로 검색한다.
 * 기본은 모든 단어 포함(AND). mode="any" 면 하나라도 포함(OR)하고 많이 맞을수록 점수가 높다 — 자연어 질문·오타에 쓴다.
 */
export async function searchAll(query: string, limit = 40, mode: "all" | "any" = "all"): Promise<SearchHit[]> {
  const terms = query
    .toLowerCase()
    .replace(/[?!.,;:()"'“”‘’`]/g, " ")
    .split(/\s+/)
    .map((t) => (mode === "any" ? stripJosa(t) : t))
    .filter((t) => (mode === "any" ? t.length >= 2 && !STOP.has(t) : t.length > 0));
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  const hasAll = (hay: string) => (mode === "all" ? terms.every((t) => hay.includes(t)) : terms.some((t) => hay.includes(t)));

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
      const all = hayTitle + " " + hayBody;
      score += terms.filter((t) => all.includes(t)).length * 8;
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

/** AND 로 찾고 없으면 OR 로 다시 찾는다 */
export async function searchSmart(query: string, limit = 8): Promise<SearchHit[]> {
  const strict = await searchAll(query, limit, "all");
  if (strict.length >= Math.min(3, limit)) return strict;
  const loose = await searchAll(query, limit * 2, "any");
  const seen = new Set(strict.map((h) => h.href));
  return [...strict, ...loose.filter((h) => !seen.has(h.href))].slice(0, limit);
}
