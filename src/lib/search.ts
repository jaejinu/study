import { listNotes, getNote } from "./notes";
import { subjects } from "./subjects";
import { experiments } from "@/experiments";
import { listLab } from "@/lab/registry";
import { semanticSearch } from "./semantic/search";

export interface SearchHit {
  kind: "note" | "lab";
  subject: string;
  subjectName: string;
  title: string;
  href: string;
  score: number;
  snippet: string;
  /** 하이브리드 검색: 가장 잘 맞은 섹션 제목 (href 는 그 섹션 앵커) */
  section?: string;
}

/** 어떤 방법으로 찾았는가 — hybrid(BM25+벡터 RRF) · bm25(임베딩 실패 시 OpenSearch 만) · keyword(OpenSearch 불가 시 메모리 검색) */
export type SearchVia = "hybrid" | "bm25" | "keyword";

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
function queryTerms(query: string, mode: "all" | "any"): string[] {
  return query
    .toLowerCase()
    .replace(/[?!.,;:()"'“”‘’`]/g, " ")
    .split(/\s+/)
    .map((t) => (mode === "any" ? stripJosa(t) : t))
    .filter((t) => (mode === "any" ? t.length >= 2 && !STOP.has(t) : t.length > 0));
}

export async function searchAll(query: string, limit = 40, mode: "all" | "any" = "all", kinds: "all" | "lab" = "all"): Promise<SearchHit[]> {
  const terms = queryTerms(query, mode);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  const hasAll = (hay: string) => (mode === "all" ? terms.every((t) => hay.includes(t)) : terms.some((t) => hay.includes(t)));

  for (const s of subjects) {
    const metas = kinds === "lab" ? [] : await listNotes(s.id);
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

/**
 * 실험만 키워드로 — 실험은 의미 검색 색인 대상이 아니다.
 * AND 로 찾고, 검색어가 2개 이하인 짧은 질의만 OR 로 넓힌다 (긴 자연어 질문을 OR 로 찾으면 "서버가" 같은 말 하나로 엉뚱한 실험이 붙는다).
 */
export async function searchLabs(query: string, limit = 4, subject?: string): Promise<SearchHit[]> {
  if (limit <= 0) return [];
  const pick = (hs: SearchHit[]) => hs.filter((h) => !subject || h.subject === subject);
  const strict = pick(await searchAll(query, 40, "all", "lab"));
  if (strict.length >= limit || queryTerms(query, "any").length > 2) return strict.slice(0, limit);
  const seen = new Set(strict.map((h) => h.href));
  const loose = pick(await searchAll(query, 40, "any", "lab")).filter((h) => !seen.has(h.href));
  return [...strict, ...loose].slice(0, limit);
}

export interface HybridSearchResult {
  hits: SearchHit[];
  via: SearchVia;
  ms: number;
  /** 하이브리드일 때 임베딩 모델 */
  model?: string;
}

/**
 * 의미 기반 하이브리드 검색 (OpenSearch BM25 + bge-m3 kNN → RRF, 노트별 최고 섹션).
 * OpenSearch/Ollama 가 꺼져 있거나 timeoutMs(기본 1.5초) 안에 못 답하면 searchSmart 로 폴백한다.
 * labs > 0 이면 실험을 키워드로 찾아 뒤에 붙인다.
 */
export async function searchHybrid(
  query: string,
  opts: { limit?: number; subject?: string; labs?: number; snippetWidth?: number; timeoutMs?: number; maxRank?: number } = {},
): Promise<HybridSearchResult> {
  const t0 = performance.now();
  const limit = opts.limit ?? 10;
  const [sem, labs] = await Promise.all([semanticSearch(query, { limit, subject: opts.subject, timeoutMs: opts.timeoutMs }), searchLabs(query, opts.labs ?? 0, opts.subject)]);
  if (sem) {
    const terms = queryTerms(query, "any");
    // 꼬리 자르기: 노트가 BM25·벡터 중 적어도 한 목록에서 maxRank 위 안이어야 한다.
    // (RRF 점수 비율로 자르면 한 목록에서만 상위인 정답 — 예: "MOVED" 의 Redis Cluster — 이 잘린다)
    const kept = opts.maxRank ? sem.hits.filter((h) => h.noteRanks.some((r) => r !== null && r <= opts.maxRank!)) : sem.hits;
    const notes = kept.map<SearchHit>((h) => ({
      kind: "note",
      subject: h.subject,
      subjectName: subjects.find((s) => s.id === h.subject)?.name ?? h.subject,
      title: h.title,
      href: h.href,
      score: h.noteScore,
      snippet: snippetAround(h.body, terms, opts.snippetWidth ?? 140),
      section: h.anchor ? h.heading : undefined,
    }));
    return { hits: [...notes, ...labs], via: sem.via, ms: Math.round(performance.now() - t0), model: sem.model };
  }
  const kw = (await searchSmart(query, opts.subject ? limit * 4 : limit)).filter((h) => h.kind === "note" && (!opts.subject || h.subject === opts.subject)).slice(0, limit);
  if (opts.snippetWidth) {
    // 근거 검색(AI 에게 묻기)은 더 긴 발췌가 필요하다
    const terms = queryTerms(query, "any");
    for (const h of kw) {
      const [, subject, slug] = /^\/([a-z0-9-]+)\/notes\/([a-z0-9-]+)/.exec(h.href) ?? [];
      const note = subject ? await getNote(subject, slug) : null;
      if (note) h.snippet = snippetAround(note.content.replace(/```[\s\S]*?```/g, " "), terms, opts.snippetWidth);
    }
  }
  return { hits: [...kw, ...labs], via: "keyword", ms: Math.round(performance.now() - t0) };
}
