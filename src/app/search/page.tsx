import Link from "next/link";
import { PageHeader, Badge } from "@/components/ui";
import { searchAll } from "@/lib/search";
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

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = q.trim() ? await searchAll(q) : [];
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="검색" subtitle="모든 주제의 노트 본문과 실험을 찾습니다. 여러 단어는 모두 포함된 것만 보여줍니다." />
      <form action="/search" className="mb-6 flex gap-2">
        <input name="q" defaultValue={q} placeholder="예: 파이프라인, 격리 수준, MOVED, 롤링 업데이트" autoFocus className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-muted" />
        <button className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white">검색</button>
      </form>
      {q.trim() && <p className="mb-3 text-xs text-muted">{hits.length}건</p>}
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
              <p className="mt-1 text-sm text-muted">
                <Highlight text={h.snippet} terms={terms} />
              </p>
            </li>
          );
        })}
      </ul>
      {q.trim() && hits.length === 0 && <p className="text-sm text-muted">결과가 없습니다. 더 짧은 단어로 시도해 보세요.</p>}
    </div>
  );
}
