import { randomUUID } from "node:crypto";
import { ensureConnected, getRedis } from "./redis";
import { assertWritable } from "./read-only";

/** 노트 메모·하이라이트 — Redis Hash `memo:<subject>/<slug>` (필드 = 메모 id, 값 = JSON) */
export interface Memo {
  id: string;
  subject: string;
  slug: string;
  /** 본문에서 고른 문장 (하이라이트 대상) */
  quote: string;
  text: string;
  at: number;
}

const key = (subject: string, slug: string) => `memo:${subject}/${slug}`;

export async function listNoteMemos(subject: string, slug: string): Promise<Memo[]> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    return Object.values(await r.hgetall(key(subject, slug)))
      .map((v) => JSON.parse(v) as Memo)
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

export async function listAllMemos(): Promise<Memo[]> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    const out: Memo[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", "memo:*", "COUNT", 200);
      cursor = next;
      for (const k of keys) for (const v of Object.values(await r.hgetall(k))) out.push(JSON.parse(v) as Memo);
    } while (cursor !== "0");
    return out.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function addMemo(subject: string, slug: string, quote: string, text: string): Promise<Memo> {
  assertWritable("메모");
  const r = getRedis();
  await ensureConnected(r);
  const memo: Memo = { id: randomUUID().slice(0, 8), subject, slug, quote: quote.slice(0, 500), text: text.slice(0, 4000), at: Date.now() };
  await r.hset(key(subject, slug), memo.id, JSON.stringify(memo));
  return memo;
}

export async function deleteMemo(subject: string, slug: string, id: string): Promise<void> {
  assertWritable("메모");
  const r = getRedis();
  await ensureConnected(r);
  await r.hdel(key(subject, slug), id);
}
