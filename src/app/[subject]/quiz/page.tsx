import { notFound } from "next/navigation";
import { Flashcards } from "@/components/Flashcards";
import { PageHeader } from "@/components/ui";
import { listNotes } from "@/lib/notes";
import { loadQuiz } from "@/lib/quiz";
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
  const [cards, notes] = await Promise.all([loadQuiz(id), listNotes(id)]);
  const withTitles = cards.map((c) => ({ ...c, noteTitle: notes.find((n) => n.slug === c.note)?.title }));
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={`${subject.name} 퀴즈`} subtitle={`플래시카드 ${cards.length}장. 질문을 읽고 답을 떠올린 뒤 뒤집어 확인하세요. 각 카드는 관련 노트로 이어집니다.`} />
      <Flashcards cards={withTitles} subject={id} />
    </div>
  );
}
