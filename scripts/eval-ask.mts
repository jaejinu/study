// 사용: OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 pnpm tsx scripts/eval-ask.mts [모델,모델...]
//   기본 모델: qwen2.5:1.5b,qwen2.5:3b  · 심판(EVAL_JUDGE): 목록의 마지막(가장 큰) 모델 · 문항 수 EVAL_N=30 · 시드 EVAL_SEED=42
//   OpenAI 키가 있으면: OPENAI_API_KEY=sk-... pnpm tsx scripts/eval-ask.mts gpt-5-mini,gpt-5-nano
// 결과: reports/eval-ask.json (gitignore) — /practice 의 "모델 비교" 카드가 읽는다.
import fs from "node:fs/promises";
import path from "node:path";
import { subjects } from "../src/lib/subjects";
import { loadQuiz, type QuizCard } from "../src/lib/quiz";
import { searchSmart } from "../src/lib/search";
import { chatOnce } from "../src/lib/practice/llm";
import { keywordRecall, sampleGolden } from "../src/lib/practice/core";
import type { EvalItem, EvalModelSummary, EvalReport } from "../src/lib/practice/eval";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY 가 필요합니다. 로컬: OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1");
  process.exit(1);
}
const models = (process.argv[2] ?? process.env.EVAL_MODELS ?? "qwen2.5:1.5b,qwen2.5:3b").split(",").map((s) => s.trim()).filter(Boolean);
const judge = process.env.EVAL_JUDGE ?? models[models.length - 1];
const N = Number(process.env.EVAL_N ?? 30);
const SEED = Number(process.env.EVAL_SEED ?? 42);

// "AI 에게 묻기" 와 같은 원칙 (사이트 근거 우선, 사이트 밖 내용 구분) + 같은 검색 증강(searchSmart 상위 노트)
const ASK_PROMPT = `당신은 "Study" 학습 사이트의 "AI 에게 묻기" 패널이다. 답은 짧고 정확하게(5문장 이내), 한국어 마크다운으로.
1. 먼저 아래 "관련 노트" 를 근거로 답하고 관련 노트를 [제목](경로) 링크로 인용한다.
2. 사이트에 없는 내용이 필요하면 일반 지식으로 보충하되 "사이트 밖 내용:" 으로 구분한다. 모르면 모른다고 한다.`;

async function askContext(question: string): Promise<string> {
  const hits = (await searchSmart(question, 5)).filter((h) => h.kind === "note");
  return hits.length ? `질문과 관련된 이 사이트의 노트 (근거로 쓰고 링크로 인용):\n${hits.map((h) => `- [${h.title}](${h.href}) — ${h.subjectName}: ${h.snippet}`).join("\n")}` : "(관련 노트 없음)";
}

const JUDGE_SYSTEM = `당신은 채점관이다. 질문, 모범 답안, 학생 답안을 보고 학생 답안이 모범 답안의 핵심을 얼마나 정확히 담았는지 0~10 정수로 채점한다.
10: 핵심을 모두 정확히, 7: 대부분 맞고 사소한 누락, 4: 일부만 맞음, 1: 거의 틀림, 0: 무관하거나 틀림. 모범 답안과 모순되는 주장은 크게 감점.
반드시 JSON 한 개만: {"score": 정수, "reason": "한 문장"}`;

async function judgeScore(q: string, gold: string, answer: string): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chatOnce("eval.judge", [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: `질문: ${q}\n\n모범 답안: ${gold}\n\n학생 답안:\n${answer.slice(0, 2500)}` },
      ], { model: judge, json: true, maxTokens: 200, temperature: 0 });
      const m = /"score"\s*:\s*"?(\d+(?:\.\d+)?)/.exec(r.text);
      if (m) return Math.max(0, Math.min(10, Number(m[1])));
    } catch (e) {
      console.warn("  심판 오류:", (e as Error).message);
    }
  }
  return null;
}

const bySubject: Record<string, QuizCard[]> = {};
for (const s of subjects) bySubject[s.id] = await loadQuiz(s.id);
const golden = sampleGolden(bySubject, N, SEED);
console.log(`골든셋 ${golden.length}문항 (주제 ${new Set(golden.map((g) => g.subject)).size}개, 시드 ${SEED}) · 모델 ${models.join(", ")} · 심판 ${judge}`);

const contexts = new Map<string, string>();
for (const g of golden) contexts.set(g.q, await askContext(g.q));

const items: EvalItem[] = [];
const usage = new Map<string, { input: number; output: number; cost: number; errors: number }>();
for (const model of models) {
  const u = { input: 0, output: 0, cost: 0, errors: 0 };
  usage.set(model, u);
  // 예열: 첫 호출의 모델 로딩 시간이 지연에 섞이지 않게
  await chatOnce("eval.warmup", [{ role: "user", content: "ok" }], { model, maxTokens: 1 }).catch(() => null);
  for (const [i, g] of golden.entries()) {
    let answer = "";
    let ms = 0;
    let output = 0;
    try {
      const r = await chatOnce("eval.answer", [
        { role: "system", content: `${ASK_PROMPT}\n\n=== 현재 화면 컨텍스트 ===\n${contexts.get(g.q)}` },
        { role: "user", content: g.q },
      ], { model, maxTokens: 400, temperature: 0 });
      answer = r.text;
      ms = r.ms;
      output = r.output;
      u.input += r.input;
      u.output += r.output;
      u.cost += r.costUsd;
    } catch (e) {
      u.errors++;
      console.warn(`  [${model}] 오류:`, (e as Error).message);
    }
    items.push({ subject: g.subject, note: g.note, q: g.q, model, recall: answer ? keywordRecall(answer, g.a) : 0, judge: null, ms: Math.round(ms), output, answer });
    process.stdout.write(`\r  ${model} ${i + 1}/${golden.length}`);
  }
  process.stdout.write("\n");
}

console.log(`심판(${judge}) 채점 중…`);
for (const [i, it] of items.entries()) {
  const g = golden.find((x) => x.q === it.q && x.subject === it.subject)!;
  it.judge = it.answer ? await judgeScore(it.q, g.a, it.answer) : 0;
  process.stdout.write(`\r  ${i + 1}/${items.length}`);
}
process.stdout.write("\n");

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const p50 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const summaries: EvalModelSummary[] = models.map((model) => {
  const rows = items.filter((r) => r.model === model);
  const ok = rows.filter((r) => r.answer);
  const u = usage.get(model)!;
  return {
    model,
    n: rows.length,
    recall: Math.round(avg(rows.map((r) => r.recall)) * 1000) / 1000,
    judge: Math.round(avg(rows.filter((r) => r.judge !== null).map((r) => r.judge!)) * 100) / 100,
    latencyP50Ms: Math.round(p50(ok.map((r) => r.ms))),
    latencyAvgMs: Math.round(avg(ok.map((r) => r.ms))),
    inputTokens: u.input,
    outputTokens: u.output,
    costUsd: Number(u.cost.toFixed(5)),
    errors: u.errors,
  };
});

const report: EvalReport = { at: new Date().toISOString(), seed: SEED, judge, baseUrl: process.env.OPENAI_BASE_URL ?? null, models: summaries, items };
const file = path.join(process.cwd(), "reports", "eval-ask.json");
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, JSON.stringify(report, null, 2));
console.table(summaries.map((s) => ({ 모델: s.model, 재현율: `${(s.recall * 100).toFixed(1)}%`, 심판: s.judge, p50초: (s.latencyP50Ms / 1000).toFixed(2), 평균초: (s.latencyAvgMs / 1000).toFixed(2), 입력토큰: s.inputTokens, 출력토큰: s.outputTokens, 오류: s.errors })));
console.log(`저장: ${path.relative(process.cwd(), file)}`);
process.exit(0);
