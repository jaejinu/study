import { notFound } from "next/navigation";
import { Flashcards } from "@/components/Flashcards";
import { PageHeader } from "@/components/ui";
import { listNotes } from "@/lib/notes";
import { loadQuiz } from "@/lib/quiz";
import { cardKey, getQuizStats, summarizeReview } from "@/lib/study";
import { getSubject } from "@/lib/subjects";

type Props = { params: Promise<{ subject: string }> };

export async function generateMetadata({ params }: Props) {
  const { subject } = await params;
  return { title: `${getSubject(subject)?.name ?? ""} 퀴즈` };
}

export default async function QuizPage({ params }: Props) {
  const { subject: id } = await params;
  const subject = getSubject(id);
  if (!subject) notFound();
  const [cards, notes, stats] = await Promise.all([loadQuiz(id), listNotes(id), getQuizStats(id)]);
  const withTitles = cards.map((c) => ({ ...c, key: cardKey(c.note, c.q), noteTitle: notes.find((n) => n.slug === c.note)?.title }));
  const review = summarizeReview(withTitles.map((c) => c.key), stats);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={`${subject.name} 퀴즈`} subtitle={`플래시카드 ${cards.length}장. 질문을 읽고 답을 떠올린 뒤 뒤집어 확인하세요. 맞고 틀림은 라이트너 상자(1·3·7·14일)로 기록되어 틀린 카드가 먼저 돌아옵니다.`} />
      <div className="mb-4 flex flex-wrap gap-2 text-[13px]">
        <span className={`rounded border px-2 py-1 ${review.due > 0 ? "border-warn/40 bg-warn/10 text-warn" : "border-border text-muted"}`}>복습 기한 지남 {review.due}장</span>
        <span className="rounded border border-border px-2 py-1 text-muted">처음 보는 카드 {review.unseen}장</span>
        <span className="rounded border border-ok/30 px-2 py-1 text-ok">안정(상자 3+) {review.stable}장</span>
      </div>
      <Flashcards cards={withTitles} subject={id} stats={stats} />
    </div>
  );
}
