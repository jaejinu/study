import { createHash } from "node:crypto";
import { ensureConnected, getRedis } from "./redis";
import { BOX_INTERVALS, type QuizStat } from "./study-shared";

export { BOX_INTERVALS, fmtDuration, type QuizStat } from "./study-shared";

/**
 * 학습 기록 (이 앱의 Redis 에 저장)
 *   quiz:stats:<subject>          Hash   cardKey → JSON QuizStat   (라이트너 상자 기반 간격 반복)
 *   study:time:<subject>/<slug>   String 누적 학습 초
 *   study:day:<YYYY-MM-DD>        Hash   subject → 누적 초 (일별 집계, 60일 보존)
 */

export function cardKey(note: string, q: string): string {
  return createHash("sha1").update(`${note}\n${q}`).digest("hex").slice(0, 12);
}

export async function getQuizStats(subject: string): Promise<Record<string, QuizStat>> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    const raw = await r.hgetall(`quiz:stats:${subject}`);
    const out: Record<string, QuizStat> = {};
    for (const [k, v] of Object.entries(raw)) {
      try {
        out[k] = JSON.parse(v) as QuizStat;
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function recordQuiz(subject: string, key: string, right: boolean): Promise<QuizStat> {
  const r = getRedis();
  await ensureConnected(r);
  const field = `quiz:stats:${subject}`;
  const prevRaw = await r.hget(field, key);
  const prev: QuizStat = prevRaw ? (JSON.parse(prevRaw) as QuizStat) : { right: 0, wrong: 0, streak: 0, box: 0, due: 0, last: 0 };
  const now = Date.now();
  const box = right ? Math.min(prev.box + 1, BOX_INTERVALS.length - 1) : 0;
  const next: QuizStat = {
    right: prev.right + (right ? 1 : 0),
    wrong: prev.wrong + (right ? 0 : 1),
    streak: right ? prev.streak + 1 : 0,
    box,
    due: now + BOX_INTERVALS[box],
    last: now,
  };
  await r.hset(field, key, JSON.stringify(next));
  return next;
}

export interface ReviewSummary {
  total: number;
  /** 한 번도 안 본 카드 */
  unseen: number;
  /** 복습 시각이 지난 카드 */
  due: number;
  /** 상자 3 이상 */
  stable: number;
}

export function summarizeReview(keys: string[], stats: Record<string, QuizStat>, now = Date.now()): ReviewSummary {
  let unseen = 0, due = 0, stable = 0;
  for (const k of keys) {
    const s = stats[k];
    if (!s) unseen++;
    else {
      if (s.due <= now) due++;
      if (s.box >= 3) stable++;
    }
  }
  return { total: keys.length, unseen, due, stable };
}

function day(ts = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function addStudyTime(subject: string, slug: string, seconds: number): Promise<number> {
  const r = getRedis();
  await ensureConnected(r);
  const dayKey = `study:day:${day()}`;
  const [total] = await Promise.all([r.incrby(`study:time:${subject}/${slug}`, seconds), r.hincrby(dayKey, subject, seconds), r.expire(dayKey, 60 * 86_400)]);
  return total;
}

export async function getNoteTime(subject: string, slug: string): Promise<number> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    return Number((await r.get(`study:time:${subject}/${slug}`)) ?? 0);
  } catch {
    return 0;
  }
}

export interface WeeklyStudy {
  days: { date: string; label: string; seconds: number; bySubject: Record<string, number> }[];
  bySubject: Record<string, number>;
  totalSeconds: number;
}

export async function getWeeklyStudy(daysBack = 7): Promise<WeeklyStudy> {
  const r = getRedis();
  const days: WeeklyStudy["days"] = [];
  const bySubject: Record<string, number> = {};
  let totalSeconds = 0;
  const labels = ["일", "월", "화", "수", "목", "金", "토"];
  labels[5] = "금";
  try {
    await ensureConnected(r);
    for (let i = daysBack - 1; i >= 0; i--) {
      const ts = Date.now() - i * 86_400_000;
      const date = day(ts);
      const raw = await r.hgetall(`study:day:${date}`);
      const rec: Record<string, number> = {};
      let sum = 0;
      for (const [s, v] of Object.entries(raw)) {
        rec[s] = Number(v);
        sum += Number(v);
        bySubject[s] = (bySubject[s] ?? 0) + Number(v);
      }
      totalSeconds += sum;
      days.push({ date, label: labels[new Date(ts).getDay()], seconds: sum, bySubject: rec });
    }
  } catch {
    /* Redis 없음 */
  }
  return { days, bySubject, totalSeconds };
}

export async function getSubjectStudySeconds(subject: string): Promise<number> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    let cursor = "0";
    let total = 0;
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", `study:time:${subject}/*`, "COUNT", 100);
      cursor = next;
      if (keys.length) total += (await r.mget(...keys)).reduce((a, v) => a + Number(v ?? 0), 0);
    } while (cursor !== "0");
    return total;
  } catch {
    return 0;
  }
}
