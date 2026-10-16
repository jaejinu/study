import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { toolDefinitions } from "./tools";

/**
 * "AI 에게 묻기" 패널의 OpenAI 설정.
 *  - OPENAI_API_KEY (필수), OPENAI_MODEL (기본 gpt-5-mini), OPENAI_BASE_URL (OpenAI 호환 서버: Ollama `http://localhost:11434/v1` 등)
 *  - Ollama 를 쓰면 키는 아무 값이나 (`OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen2.5:0.5b`)
 */
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";
export const OPENAI_MODELS = Array.from(new Set([OPENAI_MODEL, "gpt-5", "gpt-5-mini", "gpt-5-nano"]));

export function openaiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export function openaiClient(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined });
}

/** Anthropic 형식의 툴 정의를 OpenAI function 형식으로 */
export const openaiTools: ChatCompletionTool[] = toolDefinitions.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description ?? "", parameters: t.input_schema as Record<string, unknown> },
}));

/** 추정 단가 (USD / 1M tokens). 캐시된 입력은 보통 90% 할인 */
const PRICE: Record<string, { input: number; output: number; cached: number }> = {
  "gpt-5": { input: 1.25, output: 10, cached: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cached: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cached: 0.005 },
};
export function estimateOpenAICost(model: string, usage: { input: number; output: number; cached: number }): number {
  const p = PRICE[model] ?? (process.env.OPENAI_BASE_URL ? { input: 0, output: 0, cached: 0 } : PRICE["gpt-5-mini"]);
  return ((usage.input - usage.cached) * p.input + usage.cached * p.cached + usage.output * p.output) / 1_000_000;
}

export type OpenAIMessage = ChatCompletionMessageParam;
