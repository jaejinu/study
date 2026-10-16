import Link from "next/link";
import { listNotes } from "@/lib/notes";
import { getReadCounts } from "@/lib/progress";
import { subjects } from "@/lib/subjects";
import { loadQuiz } from "@/lib/quiz";
import {
  cardKey,
  getQuizStats,
  getWeeklyStudy,
  summarizeReview,
} from "@/lib/study";
import { WeeklyStudyCard } from "@/components/WeeklyStudy";
import { ContinueLearning } from "@/components/ContinueLearning";
export const dynamic = "force-dynamic";
export default async function Home() {
  const [all, weekly, reads] = await Promise.all([
    Promise.all(
      subjects.map(async (s) => {
        const [notes, quiz, stats] = await Promise.all([
          listNotes(s.id),
          loadQuiz(s.id),
          getQuizStats(s.id),
        ]);
        return {
          ...s,
          notes,
          due: summarizeReview(
            quiz.map((c) => cardKey(c.note, c.q)),
            stats,
          ).due,
        };
      }),
    ),
    getWeeklyStudy(),
    getReadCounts(),
  ]);
  const first = all.find((s) => s.notes.length > 0)!;
  const due = all.reduce((sum, s) => sum + s.due, 0),
    review = all.find((s) => s.due > 0) ?? first;
  const active = [...all]
    .filter((s) => s.notes.length)
    .sort((a, b) => (reads[b.id] ?? 0) - (reads[a.id] ?? 0))
    .slice(0, 4);
  return (
    <div className="study-home">
      <p className="eyebrow">YOUR LEARNING SPACE</p>
      <h1 className="home-title">오늘도, 하나의 개념을 깊이.</h1>
      <p className="home-intro">
        읽고, 직접 실험하고, 나의 지식으로 남기는 시간.
      </p>
      {first && (
        <ContinueLearning
          first={{
            href: `/${first.id}/notes/${first.notes[0].slug}`,
            title: first.notes[0].title,
            subject: first.name,
            chapter: 1,
            progress: 0,
          }}
        />
      )}
      <div className="home-actions">
        <Link id="review" className="home-action" href={`/${review.id}/quiz`}>
          <h2>
            기억을 단단하게 <span className="float-right text-accent">↗</span>
          </h2>
          <p>
            {due > 0
              ? `오늘 복습할 카드 ${due}장이 기다리고 있어요.`
              : "퀴즈로 방금 배운 내용을 확인해 보세요."}
          </p>
        </Link>
        <Link className="home-action" href="/redis/lab">
          <h2>
            직접 해보면 더 선명하게{" "}
            <span className="float-right text-accent">↗</span>
          </h2>
          <p>코드를 실행하고, 결과를 살펴보며 이해해 보세요.</p>
        </Link>
      </div>
      <section className="mb-10">
        <div className="section-heading">
          <h2>학습 중인 주제</h2>
          <Link href="/subjects">전체 {subjects.length}개 주제 보기 →</Link>
        </div>
        {active.map((s) => {
          const read = Math.min(reads[s.id] ?? 0, s.notes.length),
            pct = (read / s.notes.length) * 100;
          return (
            <Link className="subject-row" href={`/${s.id}`} key={s.id}>
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-accent-soft text-sm font-semibold text-accent">
                {s.mark}
              </span>
              <div className="subject-title">
                <h3>{s.name}</h3>
                <p>{s.tagline}</p>
              </div>
              <span className="text-xs text-muted">
                {read} / {s.notes.length}
              </span>
              <div
                className="subject-meter"
                aria-label={`${s.name} ${Math.round(pct)}% 완료`}
              >
                <span style={{ width: `${pct}%` }} />
              </div>
              <span className="text-muted">→</span>
            </Link>
          );
        })}
      </section>
      <section id="activity">
        <WeeklyStudyCard
          weekly={weekly}
          dueBySubject={Object.fromEntries(all.map((s) => [s.id, s.due]))}
        />
      </section>
    </div>
  );
}
