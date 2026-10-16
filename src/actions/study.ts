"use server";

import { logger } from "@/lib/log";
import { metrics } from "@/lib/metrics";
import { addStudyTime, recordQuiz } from "@/lib/study";
import type { Grade, QuizStat } from "@/lib/study-shared";

const ID = /^[a-z0-9-]+$/;
const KEY = /^[a-f0-9]{12}$/;

export async function recordQuizAction(subject: string, key: string, answer: Grade | boolean): Promise<{ ok: boolean; stat?: QuizStat; error?: string }> {
  if (!ID.test(subject) || !KEY.test(key)) return { ok: false, error: "잘못된 식별자" };
  const grade: Grade = typeof answer === "boolean" ? (answer ? 3 : 1) : answer;
  if (![1, 2, 3, 4].includes(grade)) return { ok: false, error: "잘못된 평가" };
  const right = grade >= 2;
  try {
    const stat = await recordQuiz(subject, key, grade);
    metrics.quizAnswers.inc({ subject, result: right ? "right" : "wrong" });
    logger.info("quiz.answer", { subject, key, grade, stability: stat.stability, difficulty: stat.difficulty });
    return { ok: true, stat };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 노트를 읽는 동안 클라이언트가 30초마다 호출한다 (탭이 보이고 활동이 있을 때만) */
export async function studyHeartbeatAction(subject: string, slug: string, seconds: number): Promise<{ ok: boolean; total?: number }> {
  if (!ID.test(subject) || !ID.test(slug) || !Number.isInteger(seconds) || seconds <= 0 || seconds > 120) return { ok: false };
  try {
    const total = await addStudyTime(subject, slug, seconds);
    metrics.studySeconds.inc({ subject }, seconds);
    return { ok: true, total };
  } catch {
    return { ok: false };
  }
}
