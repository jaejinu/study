import { ensureConnected, getRedis } from "@/lib/redis";
import { isReadOnly } from "@/lib/read-only";

/**
 * 연습 기록 (이 앱의 Redis)
 *   practice:explain:<subject>/<slug>   List  최근 10회 {at, score, section}
 *   practice:interview:<subject>        List  최근 5회 세션 요약 {at, level, turns, summary, notes}
 */
export interface ExplainRecord {
  at: number;
  score: number;
  section?: string;
}
export interface InterviewRecord {
  at: number;
  level: string;
  turns: number;
  summary: string;
  notes: string[];
}

async function push(key: string, value: unknown, keep: number) {
  if (isReadOnly()) return; // 공개판: 연습 기록을 서버에 남기지 않는다
  const r = getRedis();
  await ensureConnected(r);
  await r.multi().lpush(key, JSON.stringify(value)).ltrim(key, 0, keep - 1).exec();
}

async function list<T>(key: string): Promise<T[]> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    return (await r.lrange(key, 0, -1)).map((s) => JSON.parse(s) as T);
  } catch {
    return [];
  }
}

export const explainKey = (subject: string, slug: string) => `practice:explain:${subject}/${slug}`;
export const interviewKey = (subject: string) => `practice:interview:${subject}`;

export async function saveExplain(subject: string, slug: string, rec: ExplainRecord) {
  try {
    await push(explainKey(subject, slug), rec, 10);
  } catch {
    /* 기록 실패는 피드백에 영향 없음 */
  }
}
export const getExplainHistory = (subject: string, slug: string) => list<ExplainRecord>(explainKey(subject, slug));

export async function saveInterview(subject: string, rec: InterviewRecord) {
  try {
    await push(interviewKey(subject), rec, 5);
  } catch {
    /* ignore */
  }
}
export const getInterviewHistory = (subject: string) => list<InterviewRecord>(interviewKey(subject));

/** /practice 메인: 모든 주제의 최근 기록 */
export async function recentPractice(limit = 8): Promise<{ explain: (ExplainRecord & { subject: string; slug: string })[]; interview: (InterviewRecord & { subject: string })[] }> {
  const r = getRedis();
  const explain: (ExplainRecord & { subject: string; slug: string })[] = [];
  const interview: (InterviewRecord & { subject: string })[] = [];
  try {
    await ensureConnected(r);
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", "practice:*", "COUNT", 200);
      cursor = next;
      for (const k of keys) {
        const rows = (await r.lrange(k, 0, 0)).map((s) => JSON.parse(s));
        if (!rows[0]) continue;
        if (k.startsWith("practice:explain:")) {
          const [subject, slug] = k.slice("practice:explain:".length).split("/");
          explain.push({ ...rows[0], subject, slug });
        } else if (k.startsWith("practice:interview:")) interview.push({ ...rows[0], subject: k.slice("practice:interview:".length) });
      }
    } while (cursor !== "0");
  } catch {
    /* Redis 없음 */
  }
  return { explain: explain.sort((a, b) => b.at - a.at).slice(0, limit), interview: interview.sort((a, b) => b.at - a.at).slice(0, limit) };
}
