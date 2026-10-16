"use server";

import fs from "node:fs/promises";
import path from "node:path";
import { searchSmart, type SearchHit } from "@/lib/search";

export interface PaletteHit {
  kind: "note" | "lab" | "term";
  subject: string;
  title: string;
  href: string;
  snippet: string;
}

/** 커맨드 팔레트용 즉시 검색: 노트·실험(searchSmart — 모든 단어 일치가 없으면 OR 폴백, 조사 제거) + 용어집 */
export async function paletteSearchAction(q: string): Promise<PaletteHit[]> {
  const query = q.trim().slice(0, 80);
  if (query.length < 1) return [];
  const [hits, glossary] = await Promise.all([
    searchSmart(query, 10),
    fs
      .readFile(path.join(process.cwd(), "content", "glossary.json"), "utf8")
      .then((raw) => JSON.parse(raw) as { term: string; subject: string; def: string; link?: string }[])
      .catch(() => []),
  ]);
  const lower = query.toLowerCase();
  const terms = glossary
    .filter((g) => g.term.toLowerCase().includes(lower))
    .slice(0, 4)
    .map<PaletteHit>((g) => ({ kind: "term", subject: g.subject, title: g.term, href: g.link ?? "/glossary", snippet: g.def }));
  const rest = hits.map<PaletteHit>((h: SearchHit) => ({ kind: h.kind, subject: h.subject, title: h.title, href: h.href, snippet: h.snippet }));
  return [...terms, ...rest].slice(0, 14);
}
