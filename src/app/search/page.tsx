import Link from "next/link";
import { PageHeader, Badge } from "@/components/ui";
import { searchHybrid, type SearchVia } from "@/lib/search";
import { getSubject } from "@/lib/subjects";

export const dynamic = "force-dynamic";
export const metadata = { title: "검색" };

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) => (terms.some((t) => t.toLowerCase() === part.toLowerCase()) ? <mark key={i} className="rounded bg-warn/30 px-0.5 text-foreground">{part}</mark> : <span key={i}>{part}</span>))}
    </>
  );
}

const VIA: Record<SearchVia, { label: string; title: string }> = {
  hybrid: { label: "의미 + 키워드", title: "OpenSearch BM25(nori) 와 bge-m3 벡터 검색을 RRF 로 합친 결과 — 표현이 달라도 뜻이 가까운 섹션을 찾습니다" },
  bm25: { label: "키워드 (OpenSearch)", title: "임베딩 모델(Ollama)이 응답하지 않아 BM25 만 사용했습니다" },
  keyword: { label: "키워드", title: "OpenSearch 가 꺼져 있어 메모리 키워드 검색으로 찾았습니다 (pnpm search:up && pnpm search:index 로 의미 검색 켜기)" },
};

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const result = q.trim() ? await searchHybrid(q, { limit: 30, labs: 10, maxRank: 10 }) : null;
  const hits = result?.hits ?? [];
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="검색" subtitle="모든 주제의 노트와 실험을 찾습니다. 단어가 달라도 뜻이 가까운 섹션을 찾아 그 위치로 데려갑니다 (자연어 질문도 됩니다)." />
      <form action="/search" className="mb-6 flex gap-2">
        <input name="q" defaultValue={q} placeholder="예: 파이프라인, 격리 수준, MOVED, 롤링 업데이트" autoFocus className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-muted" />
        <button className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-contrast">검색</button>
      </form>
      {result && (
        <p className="mb-3 flex items-center gap-2 text-xs text-muted">
          <span>{hits.length}건</span>
          <span className="rounded border border-border px-1.5 py-0.5" title={VIA[result.via].title}>
            {VIA[result.via].label}
          </span>
          <span className="font-mono">{result.ms}ms</span>
        </p>
      )}
      <ul className="space-y-2">
        {hits.map((h) => {
          const s = getSubject(h.subject);
          return (
            <li key={h.href} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-center gap-2">
                <span className={`grid h-5 w-5 place-items-center rounded text-[10px] font-bold text-white ${s?.color ?? "bg-surface-2"}`}>{s?.mark}</span>
                <Link href={h.href} className="font-medium hover:underline">
                  <Highlight text={h.title} terms={terms} />
                </Link>
                <Badge>{h.kind === "note" ? "노트" : "실험"}</Badge>
                <span className="ml-auto text-[11px] text-muted">{h.subjectName}</span>
              </div>
              {h.section && (
                <Link href={h.href} className="mt-1 block text-[12.5px] text-info hover:underline">
                  § {h.section}
                </Link>
              )}
              <p className="mt-1 text-sm text-muted">
                <Highlight text={h.snippet} terms={terms} />
              </p>
            </li>
          );
        })}
      </ul>
      {q.trim() && hits.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-6 py-8 text-center text-sm">
          <p className="font-medium">‘{q}’ 에 맞는 노트·실험이 없습니다</p>
          <p className="mt-1 text-muted">더 짧은 단어(예: 조사 빼기)나 영어 용어로 다시 찾아보세요. 정의가 궁금하면 용어집, 설명이 필요하면 AI 에게 물어볼 수 있습니다.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/glossary" className="rounded-md border border-border bg-surface px-3 py-1.5 hover:border-muted">
              📖 용어집
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
