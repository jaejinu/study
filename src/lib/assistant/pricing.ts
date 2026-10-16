/** 추정 단가 (USD / 1M tokens). 정확한 값은 공식 가격표를 따르며, 환경 변수로 덮어쓸 수 있다. */
const DEFAULT: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-5-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

export const MODELS = Object.keys(DEFAULT);
export const DEFAULT_MODEL = process.env.ASSISTANT_MODEL ?? "claude-sonnet-5-5";

export function estimateCost(model: string, usage: { input: number; output: number; cacheWrite: number; cacheRead: number }): number {
  const p = DEFAULT[model] ?? DEFAULT["claude-sonnet-5-5"];
  return (usage.input * p.input + usage.output * p.output + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead) / 1_000_000;
}
