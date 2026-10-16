import fs from "node:fs/promises";
import path from "node:path";

/** scripts/eval-ask.mts 가 쓰는 결과 형식 (reports/eval-ask.json) */
export interface EvalModelSummary {
  model: string;
  n: number;
  recall: number;
  judge: number;
  latencyP50Ms: number;
  latencyAvgMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errors: number;
}
export interface EvalItem {
  subject: string;
  note: string;
  q: string;
  model: string;
  recall: number;
  judge: number | null;
  ms: number;
  output: number;
  answer: string;
}
export interface EvalReport {
  at: string;
  seed: number;
  judge: string;
  baseUrl: string | null;
  models: EvalModelSummary[];
  items: EvalItem[];
}

export const EVAL_FILE = path.join(process.cwd(), "reports", "eval-ask.json");

export async function readEvalReport(): Promise<EvalReport | null> {
  try {
    return JSON.parse(await fs.readFile(EVAL_FILE, "utf8")) as EvalReport;
  } catch {
    return null;
  }
}
