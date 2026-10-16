import fs from "node:fs/promises";
import path from "node:path";

export interface QuizCard {
  /** 관련 노트 slug */
  note: string;
  q: string;
  a: string;
}

const cache = new Map<string, { mtime: number; cards: QuizCard[] }>();

/** quiz.json 을 mtime 기준으로 캐시해 읽는다 */
export async function loadQuiz(subject: string): Promise<QuizCard[]> {
  if (!/^[a-z0-9-]+$/.test(subject)) return [];
  const file = path.join(process.cwd(), "content", subject, "quiz.json");
  try {
    const { mtimeMs } = await fs.stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtime === mtimeMs) return hit.cards;
    const cards = JSON.parse(await fs.readFile(file, "utf8")) as QuizCard[];
    cache.set(file, { mtime: mtimeMs, cards });
    return cards;
  } catch {
    return [];
  }
}
