import Link from "next/link";
import { experiments } from "@/experiments";
import { listNotes } from "@/lib/notes";
import { listLab } from "@/lab/registry";
import { getReadCounts } from "@/lib/progress";
import { subjects } from "@/lib/subjects";
import { loadQuiz } from "@/lib/quiz";
import { cardKey, getQuizStats, getWeeklyStudy, summarizeReview } from "@/lib/study";
import { WeeklyStudyCard } from "@/components/WeeklyStudy";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [counts, weekly, readCounts] = await Promise.all([
    Promise.all(
      subjects.map(async (s) => {
        const [notes, quiz, stats] = await Promise.all([listNotes(s.id), loadQuiz(s.id), getQuizStats(s.id)]);
        return {
          id: s.id,
          notes: notes.length,
          experiments: s.id === "redis" ? experiments.length : listLab(s.id).length,
          due: summarizeReview(quiz.map((c) => cardKey(c.note, c.q)), stats).due,
        };
      }),
    ),
    getWeeklyStudy(),
    getReadCounts(),
  ]);
  const dueBySubject = Object.fromEntries(counts.map((c) => [c.id, c.due]));
  return (
    <div className="mx-auto max-w-5xl pt-10 md:pt-16">
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">무엇을 공부할까요?</h1>
        <p className="mt-3 text-muted">주제를 고르면 목차 순서의 학습 노트와 실습 환경이 열립니다.</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {subjects.map((s) => {
          const c = counts.find((x) => x.id === s.id)!;
          return (
            <Link
              key={s.id}
              href={`/${s.id}`}
              className="group flex flex-col rounded-xl border border-border bg-surface p-6 transition-all hover:-translate-y-0.5 hover:border-muted hover:shadow-lg hover:shadow-black/30"
            >
              <div className="flex items-center gap-3">
                <span className={`grid h-12 w-12 place-items-center rounded-lg text-xl font-bold text-white ${s.color}`}>{s.mark}</span>
                <div>
                  <div className="text-xl font-semibold">{s.name}</div>
                  <div className="text-sm text-muted">{s.tagline}</div>
                </div>
              </div>
              <p className="mt-4 flex-1 text-sm leading-relaxed text-muted">{s.description}</p>
              <div className="mt-5 flex gap-4 border-t border-border pt-4 text-xs text-muted">
                <span>
                  노트 <span className="font-mono text-foreground">{c.notes}</span>편
                  {(readCounts[c.id] ?? 0) > 0 && <span className="text-ok"> · {readCounts[c.id]}편 읽음</span>}
                </span>
                {c.experiments > 0 && (
                  <span>
                    실험 <span className="font-mono text-foreground">{c.experiments}</span>개
                  </span>
                )}
                {c.due > 0 && <span className="text-warn">복습 {c.due}장</span>}
                <span className="ml-auto text-info group-hover:underline">시작하기 →</span>
              </div>
            </Link>
          );
        })}
      </div>
      <div className="mt-8">
        <WeeklyStudyCard weekly={weekly} dueBySubject={dueBySubject} />
      </div>
      <div className="mt-8 flex justify-center gap-3 text-sm">
        <Link href="/assistant" className="rounded-md border border-accent/40 bg-accent-soft px-3 py-1.5 hover:border-accent">🤖 AI 도우미</Link>
        <Link href="/search" className="rounded-md border border-border bg-surface px-3 py-1.5 hover:border-muted">🔍 검색</Link>
        <Link href="/glossary" className="rounded-md border border-border bg-surface px-3 py-1.5 hover:border-muted">📖 용어집</Link>
        <Link href="/graph" className="rounded-md border border-border bg-surface px-3 py-1.5 hover:border-muted">🕸 링크 그래프</Link>
      </div>
      <p className="mt-6 text-center text-xs text-muted">
        주제를 추가하려면 <code>src/lib/subjects.ts</code> 에 항목을 넣고 <code>content/&lt;id&gt;/notes</code> 에 노트를 작성하세요.
      </p>
    </div>
  );
}
