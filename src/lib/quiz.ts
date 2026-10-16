import fs from "node:fs/promises";
import path from "node:path";

export interface QuizCard {
  /** 관련 노트 slug */
  note: string;
  q: string;
  a: string;
}

export async function loadQuiz(subject: string): Promise<QuizCard[]> {
  if (!/^[a-z0-9-]+$/.test(subject)) return [];
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), "content", subject, "quiz.json"), "utf8")) as QuizCard[];
  } catch {
    return [];
  }
}
