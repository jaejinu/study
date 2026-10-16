import { trace } from "@opentelemetry/api";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { estimateOpenAICost, OPENAI_MODEL, openaiClient, openaiConfigured, type OpenAIMessage } from "@/lib/assistant/openai";
import { logger } from "@/lib/log";
import { metrics } from "@/lib/metrics";

/** AI 학습 모드의 LLM 호출 — ask 라우트와 같은 OpenAI 호환 클라이언트·메트릭·로그·span 을 쓴다 */
export { openaiConfigured, OPENAI_MODEL };
/** 설명·면접만 다른 모델로 (예: 로컬에서 대화는 1.5B, 채점·면접은 3B) — 없으면 OPENAI_MODEL */
export const PRACTICE_MODEL = process.env.PRACTICE_MODEL ?? OPENAI_MODEL;

export const NO_KEY_MESSAGE =
  "OPENAI_API_KEY 가 설정되어 있지 않습니다. `OPENAI_API_KEY=sk-... pnpm dev` 로 실행하거나, 로컬 모델(Ollama)을 쓰려면 `OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen2.5:1.5b pnpm dev`.";

type Sampling = { maxTokens?: number; temperature?: number; frequencyPenalty?: number };

/**
 * 샘플링 파라미터는 로컬 OpenAI 호환 서버(Ollama 등, OPENAI_BASE_URL 설정)에만 보낸다.
 * OpenAI 의 gpt-5 계열(추론 모델)은 temperature·max_tokens 를 거부하고, 출력 상한이 추론 토큰까지 먹어 빈 답이 나올 수 있다.
 */
function sampling(o: Sampling, defaults: Required<Pick<Sampling, "maxTokens" | "temperature">>) {
  if (!process.env.OPENAI_BASE_URL) return {};
  return { temperature: o.temperature ?? defaults.temperature, max_tokens: o.maxTokens ?? defaults.maxTokens, ...(o.frequencyPenalty ? { frequency_penalty: o.frequencyPenalty } : {}) };
}

export interface ChatResult {
  text: string;
  model: string;
  input: number;
  output: number;
  ms: number;
  costUsd: number;
}

function record(feature: string, model: string, usage: { input: number; output: number; cached: number }, ms: number, ttftMs?: number) {
  metrics.llmTokens.inc({ model, kind: "input" }, usage.input);
  metrics.llmTokens.inc({ model, kind: "output" }, usage.output);
  const cost = estimateOpenAICost(model, usage);
  metrics.llmCost.inc({ model }, cost);
  metrics.llmLatency.observe({ model, phase: "total" }, ms / 1000);
  if (ttftMs !== undefined) metrics.llmLatency.observe({ model, phase: "ttft" }, ttftMs / 1000);
  logger.info(`practice.${feature}`, { model, ...usage, costUsd: Number(cost.toFixed(5)), ms: Math.round(ms), ttftMs: ttftMs === undefined ? undefined : Math.round(ttftMs) });
  return cost;
}

/** 스트리밍 없이 한 번 호출 (설명해 보기 피드백, 평가 스크립트) */
export async function chatOnce(feature: string, messages: OpenAIMessage[], opts: { model?: string; json?: boolean } & Sampling = {}): Promise<ChatResult> {
  const model = opts.model ?? PRACTICE_MODEL;
  const tracer = trace.getTracer("study-practice");
  return tracer.startActiveSpan(`practice.${feature}`, { attributes: { "gen_ai.system": "openai", "gen_ai.request.model": model, "gen_ai.operation.name": "chat" } }, async (span) => {
    const t0 = performance.now();
    try {
      const res = await openaiClient().chat.completions.create({
        model,
        messages,
        ...sampling(opts, { temperature: 0.2, maxTokens: 900 }),
        ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
      });
      const usage = { input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0, cached: res.usage?.prompt_tokens_details?.cached_tokens ?? 0 };
      const ms = performance.now() - t0;
      const costUsd = record(feature, model, usage, ms);
      span.setAttributes({ "gen_ai.usage.input_tokens": usage.input, "gen_ai.usage.output_tokens": usage.output });
      return { text: res.choices[0]?.message?.content ?? "", model, input: usage.input, output: usage.output, ms: Math.round(ms), costUsd };
    } finally {
      span.end();
    }
  });
}

/** SSE 로 텍스트 델타를 흘려보내는 스트리밍 호출 (면접 모드) */
export async function chatStream(feature: string, messages: OpenAIMessage[], onDelta: (t: string) => void, opts: { model?: string } & Sampling = {}): Promise<ChatResult> {
  const model = opts.model ?? PRACTICE_MODEL;
  const tracer = trace.getTracer("study-practice");
  return tracer.startActiveSpan(`practice.${feature}`, { attributes: { "gen_ai.system": "openai", "gen_ai.request.model": model, "gen_ai.operation.name": "chat" } }, async (span) => {
    const t0 = performance.now();
    let first = 0;
    let text = "";
    const usage = { input: 0, output: 0, cached: 0 };
    try {
      const res = await openaiClient().chat.completions.create({ model, messages, stream: true, stream_options: { include_usage: true }, ...sampling(opts, { temperature: 0.4, maxTokens: 700 }) });
      for await (const chunk of res as AsyncIterable<ChatCompletionChunk>) {
        if (chunk.usage) {
          usage.input += chunk.usage.prompt_tokens ?? 0;
          usage.output += chunk.usage.completion_tokens ?? 0;
          usage.cached += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }
        const d = chunk.choices?.[0]?.delta?.content;
        if (d) {
          if (!first) first = performance.now();
          text += d;
          onDelta(d);
        }
      }
      const ms = performance.now() - t0;
      const costUsd = record(feature, model, usage, ms, first ? first - t0 : undefined);
      span.setAttributes({ "gen_ai.usage.input_tokens": usage.input, "gen_ai.usage.output_tokens": usage.output });
      return { text, model, input: usage.input, output: usage.output, ms: Math.round(ms), costUsd };
    } finally {
      span.end();
    }
  });
}
