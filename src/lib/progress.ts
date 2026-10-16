import { ensureConnected, getRedis } from "./redis";

/**
 * 학습 진행률은 이 앱의 Redis 에 저장한다 (Redis 자료구조 활용 예).
 *   progress:read                     Set   읽은 노트 "subject/slug"
 *   progress:checks:<subject>/<slug>  Hash  체크한 항목 line → "1"
 *   progress:lab                      Set   성공한 실험 "subject/id"
 */
export interface SubjectProgress {
  read: string[];
  checks: Record<string, number[]>;
  labDone: string[];
}

const EMPTY: SubjectProgress = { read: [], checks: {}, labDone: [] };

export async function getProgress(subject: string): Promise<SubjectProgress> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    const [readAll, labAll] = await Promise.all([r.smembers("progress:read"), r.smembers("progress:lab")]);
    const read = readAll.filter((k) => k.startsWith(`${subject}/`)).map((k) => k.slice(subject.length + 1));
    const labDone = labAll.filter((k) => k.startsWith(`${subject}/`)).map((k) => k.slice(subject.length + 1));
    const checks: Record<string, number[]> = {};
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", `progress:checks:${subject}/*`, "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        const slug = key.slice(`progress:checks:${subject}/`.length);
        checks[slug] = Object.keys(await r.hgetall(key)).map(Number);
      }
    } while (cursor !== "0");
    return { read, checks, labDone };
  } catch {
    return EMPTY;
  }
}

/** 첫 화면용: 주제별 읽은 노트 수를 SMEMBERS 한 번으로 (주제마다 getProgress 를 부르면 Redis 왕복이 주제 수 × 3 이 된다) */
export async function getReadCounts(): Promise<Record<string, number>> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    const counts: Record<string, number> = {};
    for (const k of await r.smembers("progress:read")) {
      const subject = k.slice(0, k.indexOf("/"));
      counts[subject] = (counts[subject] ?? 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

export async function getNoteChecks(subject: string, slug: string): Promise<number[]> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    return Object.keys(await r.hgetall(`progress:checks:${subject}/${slug}`)).map(Number);
  } catch {
    return [];
  }
}

export async function isRead(subject: string, slug: string): Promise<boolean> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    return (await r.sismember("progress:read", `${subject}/${slug}`)) === 1;
  } catch {
    return false;
  }
}

export async function setRead(subject: string, slug: string, on: boolean): Promise<void> {
  const r = getRedis();
  await ensureConnected(r);
  if (on) await r.sadd("progress:read", `${subject}/${slug}`);
  else await r.srem("progress:read", `${subject}/${slug}`);
}

export async function setCheck(subject: string, slug: string, line: number, on: boolean): Promise<void> {
  const r = getRedis();
  await ensureConnected(r);
  const key = `progress:checks:${subject}/${slug}`;
  if (on) await r.hset(key, String(line), "1");
  else await r.hdel(key, String(line));
}

export async function markLabDone(subject: string, id: string): Promise<void> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    await r.sadd("progress:lab", `${subject}/${id}`);
  } catch {
    /* 진행률 저장 실패는 무시 */
  }
}
