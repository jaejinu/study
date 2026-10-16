import Link from "next/link";
import { experiments } from "@/experiments";
import { listNotes, type NoteMeta } from "@/lib/notes";
import { listLab } from "@/lab/registry";
import { getProgress, getReadCounts } from "@/lib/progress";
import { subjects, subjectsByTrack } from "@/lib/subjects";
import { loadQuiz } from "@/lib/quiz";
import { cardKey, getQuizStats, getWeeklyStudy, summarizeReview } from "@/lib/study";
import { WeeklyStudyCard } from "@/components/WeeklyStudy";
import { ContinueLearning, type NextUp } from "@/components/home/ContinueLearning";
import { DensityToggle, TrackSection, type TrackData } from "@/components/home/TrackGrid";

export const dynamic = "force-dynamic";

/** 처음 온 사람에게 권하는 시작점 */
const STARTERS: { subject: string; slug: string }[] = [
  { subject: "redis", slug: "01-redis-overview" },
  { subject: "docker", slug: "01-docker-overview" },
  { subject: "observability", slug: "01-three-pillars" },
];

export default async function Home() {
  const [rows, weekly, readCounts] = await Promise.all([
    Promise.all(
      subjects.map(async (s) => {
        const [notes, quiz, stats] = await Promise.all([listNotes(s.id), loadQuiz(s.id), getQuizStats(s.id)]);
        return {
          id: s.id,
          notes,
          experiments: s.id === "redis" ? experiments.length : listLab(s.id).length,
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
  const notesOf = (id: string): NoteMeta[] => rows.find((r) => r.id === id)?.notes ?? [];

  // 다음에 읽을 노트: 읽기 시작한 주제 중 많이 읽은 순으로 3개, 각 주제의 첫 안 읽은 노트
  const started = Object.entries(readCounts)
    .filter(([id, n]) => n > 0 && n < notesOf(id).length)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const nextUp: NextUp[] = (
    await Promise.all(
      started.map(async ([id, n]): Promise<NextUp | null> => {
        const read = (await getProgress(id)).read;
        const next = notesOf(id).find((m) => !read.includes(m.slug));
        return next ? { subject: id, slug: next.slug, title: next.title, level: next.level, read: n, total: notesOf(id).length } : null;
      }),
    )
  ).filter((x): x is NextUp => x !== null);
  const starters: NextUp[] = STARTERS.map(({ subject, slug }): NextUp | null => {
    const list = notesOf(subject);
    const m = list.find((x) => x.slug === slug) ?? list[0];
    return m ? { subject, slug: m.slug, title: m.title, level: m.level, read: 0, total: list.length } : null;
  }).filter((x): x is NextUp => x !== null);

  const tracks: TrackData[] = subjectsByTrack().map(({ track, subjects: list }) => ({
    id: track.id,
    name: track.name,
    desc: track.desc,
    cards: list.map((s) => {
      const r = rows.find((x) => x.id === s.id)!;
      return { id: s.id, name: s.name, tagline: s.tagline, description: s.description, mark: s.mark, color: s.color, notes: r.notes.length, read: readCounts[s.id] ?? 0, experiments: r.experiments, due: r.due };
    }),
  }));
  const totalNotes = rows.reduce((a, r) => a + r.notes.length, 0);
  const totalLabs = rows.reduce((a, r) => a + r.experiments, 0);
  const dueBySubject = Object.fromEntries(rows.map((r) => [r.id, r.due]));

  return (
    <div className="mx-auto max-w-5xl pt-2 md:pt-6">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight md:text-[2.1rem]">전체 학습 주제</h1>
          <p className="mt-2 text-[15px] text-muted">
            {subjects.length}개 주제 · 노트 {totalNotes}편 · 실험 {totalLabs}개. 주제를 고르면 목차 순서의 학습 노트와 실험실이 열립니다.
          </p>
        </div>
        <DensityToggle />
      </div>

      <ContinueLearning nextUp={nextUp} starters={starters} />

      {tracks.map((t) => (
        <TrackSection key={t.id} track={t} />
      ))}

      <div className="mt-8">
        <WeeklyStudyCard weekly={weekly} dueBySubject={dueBySubject} />
      </div>
      <div className="mt-8 flex flex-wrap justify-center gap-3 text-sm">
        <Link href="/assistant" className="rounded-md border border-accent/40 bg-accent-soft px-3 py-1.5 hover:border-accent">
          🤖 AI 도우미
        </Link>
        <Link href="/search" className="rounded-md border border-border bg-surface px-3 py-1.5 hover:border-muted">
          🔍 검색
        </Link>
        <Link href="/glossary" className="rounded-md border border-border bg-surface px-3 py-1.5 hover:border-muted">
          📖 용어집
        </Link>
        <Link href="/graph" className="rounded-md border border-border bg-surface px-3 py-1.5 hover:border-muted">
          🕸 링크 그래프
        </Link>
      </div>
    </div>
  );
}
