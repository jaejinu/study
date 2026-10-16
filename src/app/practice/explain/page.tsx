import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, LevelBadge } from "@/components/ui";
import { ExplainForm } from "@/components/practice/ExplainForm";
import { getNote, listNotes } from "@/lib/notes";
import { getSubject, subjects } from "@/lib/subjects";
import { extractConcepts, splitSections } from "@/lib/practice/core";
import { openaiConfigured, NO_KEY_MESSAGE } from "@/lib/practice/llm";
import { getExplainHistory } from "@/lib/practice/store";

export const dynamic = "force-dynamic";
export const metadata = { title: "설명해 보기" };

export default async function ExplainPage({ searchParams }: { searchParams: Promise<{ subject?: string; slug?: string }> }) {
  const { subject: sid, slug } = await searchParams;
  const configured = openaiConfigured();
  const subject = sid ? getSubject(sid) : undefined;

  if (!subject) {
    const withNotes = (await Promise.all(subjects.map(async (s) => ({ s, n: (await listNotes(s.id)).length })))).filter((x) => x.n > 0);
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="설명해 보기" subtitle="설명할 주제를 고르세요. 노트를 내 말로 설명하면 빠진 개념과 틀린 주장을 노트 근거와 함께 짚어 줍니다." />
        {!configured && <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-[13.5px]">{NO_KEY_MESSAGE}</div>}
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
          {withNotes.map(({ s, n }) => (
            <Link key={s.id} href={`/practice/explain?subject=${s.id}`} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:border-muted">
              <span className={`grid h-6 w-6 place-items-center rounded text-[11px] font-bold text-white ${s.color}`}>{s.mark}</span>
              <span className="flex-1">{s.name}</span>
              <span className="text-[11px] text-muted">{n}편</span>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  if (!slug) {
    const notes = await listNotes(subject.id);
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title={`설명해 보기 · ${subject.name}`} subtitle="설명할 노트를 고르세요." />
        <Link href="/practice/explain" className="mb-3 inline-block text-[13px] text-muted hover:text-foreground">
          ← 다른 주제
        </Link>
        <ul className="space-y-1.5">
          {notes.map((n) => (
            <li key={n.slug}>
              <Link href={`/practice/explain?subject=${subject.id}&slug=${n.slug}`} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:border-muted">
                <span className="flex-1">{n.title}</span>
                <LevelBadge level={n.level} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const note = await getNote(subject.id, slug);
  if (!note) notFound();
  const sections = splitSections(note.content).map((s) => ({ id: s.id, title: s.title }));
  const concepts = extractConcepts({ content: note.content, tags: note.tags });
  const history = await getExplainHistory(subject.id, slug);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <Link href="/practice" className="hover:text-foreground">AI 학습 모드</Link>
        <span>/</span>
        <Link href={`/practice/explain?subject=${subject.id}`} className="hover:text-foreground">{subject.name}</Link>
        <LevelBadge level={note.level} />
      </div>
      <PageHeader title={`설명해 보기 · ${note.title}`} subtitle={note.summary} />
      {!configured && <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-[13.5px]">{NO_KEY_MESSAGE}</div>}
      <details className="mb-4 text-[12.5px] text-muted">
        <summary className="cursor-pointer">채점에 쓰는 핵심 개념 체크리스트 ({concepts.length}개, 노트 전체 기준) — 먼저 보면 연습 효과가 줄어듭니다</summary>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {concepts.map((c) => (
            <span key={c} className="rounded bg-surface-2 px-1.5 py-0.5">{c}</span>
          ))}
        </div>
      </details>
      <ExplainForm subject={subject.id} slug={slug} noteTitle={note.title} sections={sections} initialHistory={history} configured={configured} />
    </div>
  );
}
