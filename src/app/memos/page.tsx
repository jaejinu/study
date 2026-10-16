import Link from "next/link";
import { listAllMemos } from "@/lib/memos";
import { listNotes } from "@/lib/notes";
import { getSubject } from "@/lib/subjects";

export const dynamic = "force-dynamic";
export const metadata = { title: "내 메모" };

export default async function MemosPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const all = await listAllMemos();
  const term = q.trim().toLowerCase();
  const memos = term ? all.filter((m) => `${m.quote} ${m.text}`.toLowerCase().includes(term)) : all;
  const titles = new Map<string, string>();
  for (const subject of new Set(memos.map((m) => m.subject))) for (const n of await listNotes(subject)) titles.set(`${subject}/${n.slug}`, n.title);
  const groups = new Map<string, typeof memos>();
  for (const m of memos) groups.set(m.subject, [...(groups.get(m.subject) ?? []), m]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight">내 메모</h1>
      <p className="mt-1 text-sm text-muted">노트에서 드래그해 남긴 메모와 하이라이트 {all.length}개. 학습 기록 백업에 함께 저장됩니다.</p>
      <form className="mt-4">
        <input name="q" defaultValue={q} placeholder="메모 검색…" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-muted" />
      </form>
      {memos.length === 0 ? (
        <p className="mt-8 text-sm text-muted">{all.length ? "검색 결과가 없습니다." : "아직 메모가 없습니다. 노트 본문에서 문장을 드래그해 보세요."}</p>
      ) : (
        [...groups.entries()].map(([subject, list]) => (
          <section key={subject} className="mt-8">
            <h2 className="mb-2 font-semibold">{getSubject(subject)?.name ?? subject}</h2>
            <ul className="space-y-2">
              {list.map((m) => (
                <li key={m.id} className="rounded-lg border border-border bg-surface px-4 py-3 text-[14px]">
                  <Link href={`/${m.subject}/notes/${m.slug}`} className="text-[12.5px] text-info hover:underline">
                    {titles.get(`${m.subject}/${m.slug}`) ?? m.slug}
                  </Link>
                  {m.quote && <div className="mt-1 border-l-2 border-warn pl-2 text-[13px] text-muted">“{m.quote}”</div>}
                  {m.text && <div className="mt-1 whitespace-pre-wrap">{m.text}</div>}
                  <div className="mt-1 text-[11px] text-muted">{new Date(m.at).toLocaleString("ko-KR")}</div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
