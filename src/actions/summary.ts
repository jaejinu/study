"use server";

import { listNotes } from "@/lib/notes";
import { getProgress, getReadCounts } from "@/lib/progress";
import { loadQuiz } from "@/lib/quiz";
import { cardKey, getQuizStats, summarizeReview } from "@/lib/study";
import { getSubject, subjects } from "@/lib/subjects";

export interface ProgressSummary {
  /** 현재 주제(있으면) 또는 전체 */
  scope: "subject" | "all";
  read: number;
  total: number;
  due: number;
}

/** 상단 바 진행률 요약. 주제 안이면 그 주제, 밖이면 전체 노트 기준. Redis 가 없으면 0 */
export async function progressSummaryAction(subjectId: string | null): Promise<ProgressSummary> {
  const subject = subjectId ? getSubject(subjectId) : undefined;
  if (subject) {
    const [notes, progress, quiz, stats] = await Promise.all([listNotes(subject.id), getProgress(subject.id), loadQuiz(subject.id), getQuizStats(subject.id)]);
    const due = summarizeReview(
      quiz.map((c) => cardKey(c.note, c.q)),
      stats,
    ).due;
    return { scope: "subject", read: notes.filter((n) => progress.read.includes(n.slug)).length, total: notes.length, due };
  }
  const [counts, totals] = await Promise.all([getReadCounts(), Promise.all(subjects.map((s) => listNotes(s.id).then((n) => n.length)))]);
  return { scope: "all", read: Object.values(counts).reduce((a, b) => a + b, 0), total: totals.reduce((a, b) => a + b, 0), due: 0 };
}
