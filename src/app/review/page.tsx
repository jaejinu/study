import Link from "next/link";
import { Flashcards, type Card } from "@/components/Flashcards";
import { listNotes } from "@/lib/notes";
import { getReadKeys } from "@/lib/progress";
import { loadQuiz } from "@/lib/quiz";
import { cardKey, getQuizStatsMany } from "@/lib/study";
import { retrievability, type QuizStat } from "@/lib/study-shared";
import { subjects } from "@/lib/subjects";

export const dynamic = "force-dynamic";
export const metadata = { title: "오늘의 복습" };

const NEW_PER_DAY = 20;

/**
 * 모든 주제에서 오늘 복습할 카드를 모은다.
 *  1) 기한이 지난 카드 — 회상 확률이 낮은(잊어 가는) 순
 *  2) 새 카드 — 읽음으로 표시한 노트의 카드 중 아직 안 본 것, 하루 20장까지
 */
function nowMs() {
  return Date.now();
}

export default async function ReviewPage() {
  const now = nowMs();
  const [allStats, read] = await Promise.all([getQuizStatsMany(subjects.map((s) => s.id)), getReadKeys()]);
  const due: (Card & { r: number })[] = [];
  const fresh: Card[] = [];
  const stats: Record<string, QuizStat> = {};
  let totalCards = 0;
  for (const s of subjects) {
    const [quiz, notes] = await Promise.all([loadQuiz(s.id), listNotes(s.id)]);
    totalCards += quiz.length;
    const titles = new Map(notes.map((n) => [n.slug, n.title]));
    for (const c of quiz) {
      const key = cardKey(c.note, c.q);
      const st = allStats[s.id]?.[key];
      const card: Card = { ...c, key, subject: s.id, subjectName: s.name, noteTitle: titles.get(c.note) };
      if (st) {
        stats[key] = st;
        if (st.due <= now) due.push({ ...card, r: retrievability(st, now) });
      } else if (read.has(`${s.id}/${c.note}`)) fresh.push(card);
    }
  }
  due.sort((a, b) => a.r - b.r);
  const cards: Card[] = [...due, ...fresh.slice(0, NEW_PER_DAY)];

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight">오늘의 복습</h1>
      <p className="mt-1 text-sm text-muted">
        모든 주제에서 기한이 된 카드 <b className="text-foreground">{due.length}</b>장(잊어 가는 순)과, 읽은 노트의 새 카드 <b className="text-foreground">{Math.min(NEW_PER_DAY, fresh.length)}</b>장(하루 {NEW_PER_DAY}장까지). 답을 본 뒤 기억한 정도로 평가하면 FSRS 가 카드마다 다음 복습일을 정합니다.
      </p>
      <div className="mt-6">
        {cards.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <p className="font-medium">오늘 복습할 카드가 없습니다 🎉</p>
            <p className="mt-1 text-sm text-muted">
              노트를 읽고 &ldquo;읽음&rdquo; 으로 표시하면 그 노트의 카드가 새 카드로 들어옵니다. 전체 카드 {totalCards}장.
            </p>
            <Link href="/path" className="mt-4 inline-block text-sm text-info hover:underline">
              학습 경로에서 다음 노트 고르기 →
            </Link>
          </div>
        ) : (
          <Flashcards cards={cards} subject={cards[0].subject ?? "redis"} stats={stats} defaultMode="order" />
        )}
      </div>
    </div>
  );
}
