import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { LevelBadge } from "@/components/ui";
import { experiments } from "@/experiments";
import { getNote, listNotes } from "@/lib/notes";
import { getNoteChecks, isRead } from "@/lib/progress";
import { ReadToggle } from "@/components/ProgressControls";
import { Flashcards } from "@/components/Flashcards";
import { loadQuiz } from "@/lib/quiz";
import { cardKey, getNoteTime, getQuizStats } from "@/lib/study";
import { StudyTimer } from "@/components/StudyTimer";
import { Toc } from "@/components/Toc";
import { logger } from "@/lib/log";
import { metrics } from "@/lib/metrics";
import { getSubject } from "@/lib/subjects";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ subject: string; slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { subject, slug } = await params;
  const note = await getNote(subject, slug);
  return { title: note?.title ?? "노트" };
}

export default async function NotePage({ params }: Props) {
  const { subject: id, slug } = await params;
  const subject = getSubject(id);
  if (!subject) notFound();
  const [note, all, read, checked, quiz, stats, studySeconds] = await Promise.all([getNote(subject.id, slug), listNotes(subject.id), isRead(subject.id, slug), getNoteChecks(subject.id, slug), loadQuiz(subject.id), getQuizStats(subject.id), getNoteTime(subject.id, slug)]);
  const cards = quiz.filter((c) => c.note === slug).map((c) => ({ ...c, key: cardKey(c.note, c.q) }));
  if (!note) notFound();
  logger.info("note.view", { subject: subject.id, slug, noteLevel: note.level });
  metrics.noteViews.inc({ subject: subject.id, level: note.level });
  const idx = all.findIndex((n) => n.slug === slug);
  const prev = all[idx - 1];
  const next = all[idx + 1];
  const related = subject.id === "redis" ? note.experiments.map((eid) => experiments.find((e) => e.id === eid)).filter((e) => e !== undefined) : [];
  const base = `/${subject.id}/notes`;
  const readMinutes = Math.max(1, Math.round(note.content.replace(/```[\s\S]*?```/g, "").length / 650));

  return (
    <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[minmax(0,1fr)_230px]">
      <article>
        <div className="mb-4 flex items-center gap-2 pt-8 text-xs text-muted md:pt-0">
          <Link href={base} className="hover:text-foreground">
            {subject.name} 학습 노트
          </Link>
          <span>/</span>
          <span>{String(idx + 1).padStart(2, "0")}</span>
          <LevelBadge level={note.level} />
          {read && <span className="text-ok">✓ 읽음</span>}
        </div>
        <h1 className="text-[2rem] font-bold leading-tight tracking-tight">{note.title}</h1>
        <p className="mt-3 max-w-[78ch] text-[15.5px] leading-relaxed text-muted">{note.summary}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
          <span>읽는 데 약 {readMinutes}분</span>
          {note.experiments.length > 0 && <span>⚗ 실험 {note.experiments.length}개</span>}
          {cards.length > 0 && <span>? 퀴즈 {cards.length}장</span>}
        </div>
        <div className="mt-6">
          <Markdown content={note.content} checklist={{ subject: subject.id, slug, checked }} />
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
          <span className="text-sm text-muted">이 노트를 다 읽었다면</span>
          <ReadToggle subject={subject.id} slug={slug} initial={read} />
          <span className="ml-auto"><StudyTimer subject={subject.id} slug={slug} initialSeconds={studySeconds} /></span>
        </div>

        {cards.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-2 text-sm font-semibold">
              복습 퀴즈 <span className="text-muted">({cards.length}장)</span>
            </h2>
            <Flashcards cards={cards} subject={subject.id} stats={stats} defaultMode="order" />
          </section>
        )}

        {related.length > 0 && (
          <section className="mt-10 rounded-lg border border-accent/30 bg-accent-soft/40 p-4">
            <h2 className="mb-2 text-sm font-semibold text-accent">⚗ 이 노트와 관련된 실험</h2>
            <ul className="space-y-1.5">
              {related.map((e) => (
                <li key={e.id}>
                  <Link href={`/redis/lab/${e.id}`} className="text-sm hover:underline">
                    {e.title}
                  </Link>
                  <span className="ml-2 text-xs text-muted">{e.summary}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <nav className="mt-10 grid gap-3 border-t border-border pt-5 text-sm sm:grid-cols-2">
          {prev ? (
            <Link href={`${base}/${prev.slug}`} className="rounded-lg border border-border bg-surface p-3 transition-colors hover:border-muted">
              <span className="block text-[11px] text-muted">← 이전 노트</span>
              <span className="mt-0.5 block font-medium">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`${base}/${next.slug}`} className="rounded-lg border border-border bg-surface p-3 text-right transition-colors hover:border-muted">
              <span className="block text-[11px] text-muted">다음 노트 →</span>
              <span className="mt-0.5 block font-medium">{next.title}</span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>

      <aside className="hidden lg:block">
        <div className="sticky top-8">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">이 노트의 목차</div>
          <div className="max-h-[calc(100vh-8rem)] overflow-y-auto pr-1">
            <Toc headings={note.headings} />
          </div>
          {note.tags.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-1.5">
              {note.tags.map((t) => (
                <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
