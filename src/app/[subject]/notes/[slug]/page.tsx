import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { LevelBadge } from "@/components/ui";
import { experiments } from "@/experiments";
import { getLab } from "@/lab/registry";
import { getNote, listNotes } from "@/lib/notes";
import { getNoteChecks, getProgress, isRead } from "@/lib/progress";
import { ReadToggle } from "@/components/ProgressControls";
import { Flashcards } from "@/components/Flashcards";
import { loadQuiz } from "@/lib/quiz";
import { cardKey, getNoteTime, getQuizStats } from "@/lib/study";
import { StudyTimer } from "@/components/StudyTimer";
import { Toc, TocPanel } from "@/components/Toc";
import { RecentTracker } from "@/components/shell/recent";
import { NoteReader } from "@/components/NoteReader";
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
  const [note, all, read, checked, quiz, stats, studySeconds, progress] = await Promise.all([
    getNote(subject.id, slug),
    listNotes(subject.id),
    isRead(subject.id, slug),
    getNoteChecks(subject.id, slug),
    loadQuiz(subject.id),
    getQuizStats(subject.id),
    getNoteTime(subject.id, slug),
    getProgress(subject.id),
  ]);
  const cards = quiz.filter((c) => c.note === slug).map((c) => ({ ...c, key: cardKey(c.note, c.q) }));
  if (!note) notFound();
  logger.info("note.view", { subject: subject.id, slug, noteLevel: note.level });
  metrics.noteViews.inc({ subject: subject.id, level: note.level });
  const idx = all.findIndex((n) => n.slug === slug);
  const prev = all[idx - 1];
  const next = all[idx + 1];
  const base = `/${subject.id}/notes`;
  const readMinutes = Math.max(1, Math.round(note.content.replace(/```[\s\S]*?```/g, "").length / 650));

  // 이 노트와 연결된 실험 (모든 주제). redis 는 별도 레지스트리
  const related = note.experiments
    .map((eid) => {
      if (subject.id === "redis") {
        const e = experiments.find((x) => x.id === eid);
        return e ? { id: e.id, title: e.title, summary: e.summary, href: `/redis/lab/${e.id}` } : null;
      }
      const e = getLab(subject.id, eid);
      return e ? { id: e.id, title: e.title, summary: e.summary, href: `/${subject.id}/lab/${e.id}` } : null;
    })
    .filter((e): e is { id: string; title: string; summary: string; href: string } => e !== null);
  const checklistTotal = (note.content.match(/^\s*- \[[ xX]\]/gm) ?? []).length;

  return (
    <NoteReader location={{href:`${base}/${slug}`, title:note.title, subject:subject.name, chapter:idx+1}}><div className="reader-layout">
      <article className="min-w-0">
        <RecentTracker kind="note" subject={subject.id} href={`${base}/${slug}`} title={note.title} />
        <div className="mb-4 flex items-center gap-2 text-xs text-muted">
          <Link href={base} className="hover:text-foreground">
            {subject.name} 학습 노트
          </Link>
          <span>/</span>
          <span>
            {String(idx + 1).padStart(2, "0")} / {String(all.length).padStart(2, "0")}
          </span>
          <LevelBadge level={note.level} />
          {read && <span className="text-ok">✓ 읽음</span>}
        </div>
        <h1 className="text-[2rem] font-bold leading-tight tracking-tight">{note.title}</h1>
        <p className="mt-3 max-w-[78ch] text-[15.5px] leading-relaxed text-muted">{note.summary}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
          <span>읽는 데 약 {readMinutes}분</span>
          {related.length > 0 && (
            <a href="#note-practice" className="hover:text-foreground">
              ⚗ 실험 {related.length}개
            </a>
          )}
          {cards.length > 0 && (
            <a href="#note-quiz" className="hover:text-foreground">
              ? 퀴즈 {cards.length}장
            </a>
          )}
          {checklistTotal > 0 && (
            <span>
              ☑ 체크리스트 {checked.length}/{checklistTotal}
            </span>
          )}
        </div>

        {note.headings.length > 2 && (
          <details className="reader-mobile-toc mt-5 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm lg:hidden">
            <summary className="cursor-pointer select-none font-medium">목차 ({note.headings.filter((h) => h.depth === 2).length}개 섹션)</summary>
            <div className="mt-2">
              <Toc headings={note.headings} />
            </div>
          </details>
        )}

        <div className="mt-6">
          <Markdown content={note.content} checklist={{ subject: subject.id, slug, checked }} />
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
          <span className="text-sm text-muted">이 노트를 다 읽었다면</span>
          <ReadToggle subject={subject.id} slug={slug} initial={read} />
          <span className="ml-auto">
            <StudyTimer subject={subject.id} slug={slug} initialSeconds={studySeconds} />
          </span>
        </div>

        {(related.length > 0 || cards.length > 0) && (
          <section id="note-practice" className="mt-8 scroll-mt-16 rounded-xl border border-border bg-surface p-5">
            <h2 className="text-base font-semibold">이 노트로 연습하기</h2>
            <p className="mt-0.5 text-xs text-muted">읽은 내용을 직접 확인하고(실험), 기억에 남겼는지 점검합니다(퀴즈).</p>
            <div className={`mt-4 grid gap-4 ${related.length > 0 && cards.length > 0 ? "md:grid-cols-[minmax(0,1fr)_200px]" : ""}`}>
              {related.length > 0 && (
                <ul className="space-y-2">
                  {related.map((e) => {
                    const done = progress.labDone.includes(e.id);
                    return (
                      <li key={e.id}>
                        <Link href={e.href} className="flex gap-3 rounded-lg border border-border bg-background px-3 py-2.5 transition-colors hover:border-muted">
                          <span className={`mt-0.5 text-sm ${done ? "text-ok" : "text-accent"}`} aria-label={done ? "성공한 실험" : "아직 안 한 실험"}>
                            {done ? "✓" : "⚗"}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium">{e.title}</span>
                            <span className="clamp-2 mt-0.5 text-xs leading-relaxed text-muted">{e.summary}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
              {cards.length > 0 && (
                <a href="#note-quiz" className="flex flex-col justify-center rounded-lg border border-border bg-background px-4 py-3 text-center transition-colors hover:border-muted">
                  <span className="text-2xl font-bold">{cards.length}</span>
                  <span className="text-xs text-muted">복습 카드 · 아래에서 바로 풀기 ↓</span>
                </a>
              )}
            </div>
          </section>
        )}

        {cards.length > 0 && (
          <section id="note-quiz" className="mt-10 scroll-mt-16">
            <h2 className="mb-2 text-sm font-semibold">
              복습 퀴즈 <span className="text-muted">({cards.length}장)</span>
            </h2>
            <Flashcards cards={cards} subject={subject.id} stats={stats} defaultMode="order" />
          </section>
        )}

        <nav className="mt-10 grid gap-3 border-t border-border pt-5 text-sm sm:grid-cols-2" aria-label="이전·다음 노트">
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
            <Link href={`/${subject.id}`} className="rounded-lg border border-ok/40 bg-surface p-3 text-right transition-colors hover:border-ok">
              <span className="block text-[11px] text-ok">마지막 노트입니다 ✓</span>
              <span className="mt-0.5 block font-medium">{subject.name} 대시보드로</span>
            </Link>
          )}
        </nav>
      </article>

      <aside className="reader-aside">
        <div>
          <TocPanel headings={note.headings} />
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
    </div></NoteReader>
  );
}
