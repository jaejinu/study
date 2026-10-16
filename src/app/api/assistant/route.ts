import Anthropic from "@anthropic-ai/sdk";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { executeTool, SYSTEM_PROMPT, toolDefinitions } from "@/lib/assistant/tools";
import { DEFAULT_MODEL, estimateCost, MODELS } from "@/lib/assistant/pricing";
import { logger } from "@/lib/log";
import { metrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type ClientMessage = { role: "user" | "assistant"; content: string };

/**
 * 학습 도우미 채팅 (SSE 스트리밍 + 툴 루프). AI 노트 01·04 의 구조를 그대로 구현한다.
 *  - 프롬프트 캐시: 시스템 프롬프트 + 툴 정의에 cache_control
 *  - 툴 루프: stop_reason=tool_use 면 서버에서 실행 후 재호출 (최대 6회)
 *  - propose_experiment 는 부작용 없이 제안만 → 클라이언트가 승인 버튼을 보여준다
 *  - 관측: span 속성(gen_ai.*), 토큰·비용·TTFT 메트릭, 구조화 로그
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ANTHROPIC_API_KEY 가 설정되어 있지 않습니다. `ANTHROPIC_API_KEY=sk-ant-... pnpm dev` 로 실행하세요." }, { status: 400 });
  }
  let body: { messages: ClientMessage[]; model?: string };
  try {
    body = (await req.json()) as { messages: ClientMessage[]; model?: string };
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const model = MODELS.includes(body.model ?? "") ? (body.model as string) : DEFAULT_MODEL;
  const history = (body.messages ?? []).slice(-20).map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
  if (history.length === 0 || history[history.length - 1].role !== "user") return Response.json({ error: "마지막 메시지는 user 여야 합니다" }, { status: 400 });

  const client = new Anthropic({ apiKey });
  const tracer = trace.getTracer("study-assistant");
  const encoder = new TextEncoder();
  const usageTotal = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      await tracer.startActiveSpan("assistant.chat", { attributes: { "gen_ai.system": "anthropic", "gen_ai.request.model": model, "gen_ai.operation.name": "chat" } }, async (span) => {
        const tStart = performance.now();
        let firstToken = 0;
        let toolCalls = 0;
        // Anthropic 메시지 배열 (툴 호출 왕복 포함)
        const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
        try {
          for (let iter = 0; iter < 6; iter++) {
            const s = client.messages.stream({
              model,
              max_tokens: 1500,
              system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              tools: toolDefinitions.map((t, i) => (i === toolDefinitions.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t)),
              messages,
            });
            s.on("text", (delta) => {
              if (!firstToken) {
                firstToken = performance.now();
                metrics.llmLatency.observe({ model, phase: "ttft" }, (firstToken - tStart) / 1000);
              }
              send({ type: "text", text: delta });
            });
            const final = await s.finalMessage();
            const u = final.usage;
            usageTotal.input += u.input_tokens;
            usageTotal.output += u.output_tokens;
            usageTotal.cacheWrite += u.cache_creation_input_tokens ?? 0;
            usageTotal.cacheRead += u.cache_read_input_tokens ?? 0;
            metrics.llmTokens.inc({ model, kind: "input" }, u.input_tokens);
            metrics.llmTokens.inc({ model, kind: "output" }, u.output_tokens);
            metrics.llmTokens.inc({ model, kind: "cache_write" }, u.cache_creation_input_tokens ?? 0);
            metrics.llmTokens.inc({ model, kind: "cache_read" }, u.cache_read_input_tokens ?? 0);

            messages.push({ role: "assistant", content: final.content });
            if (final.stop_reason !== "tool_use") break;

            const results: Anthropic.ToolResultBlockParam[] = [];
            for (const block of final.content) {
              if (block.type !== "tool_use") continue;
              toolCalls++;
              const input = (block.input ?? {}) as Record<string, unknown>;
              send({ type: "tool_start", name: block.name, input });
              const t0 = performance.now();
              const out = await tracer.startActiveSpan(`tool.${block.name}`, async (ts) => {
                const r = await executeTool(block.name, input);
                ts.setAttributes({ "gen_ai.tool.name": block.name, "study.tool.error": !!r.isError });
                ts.end();
                return r;
              });
              metrics.llmToolCalls.inc({ tool: block.name, outcome: out.isError ? "error" : "ok" });
              send({ type: "tool_result", name: block.name, ms: Math.round(performance.now() - t0), isError: !!out.isError, preview: JSON.stringify(out.result).slice(0, 300), proposal: out.proposal });
              results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out.result).slice(0, 20000), is_error: !!out.isError });
            }
            messages.push({ role: "user", content: results });
          }
          const cost = estimateCost(model, usageTotal);
          metrics.llmCost.inc({ model }, cost);
          const totalMs = performance.now() - tStart;
          metrics.llmLatency.observe({ model, phase: "total" }, totalMs / 1000);
          span.setAttributes({
            "gen_ai.usage.input_tokens": usageTotal.input,
            "gen_ai.usage.output_tokens": usageTotal.output,
            "gen_ai.usage.cache_read_input_tokens": usageTotal.cacheRead,
            "study.llm.cost_usd": cost,
            "study.llm.tool_calls": toolCalls,
            "study.llm.ttft_ms": firstToken ? Math.round(firstToken - tStart) : 0,
          });
          logger.info("assistant.chat", { model, ...usageTotal, costUsd: Number(cost.toFixed(5)), toolCalls, ttftMs: firstToken ? Math.round(firstToken - tStart) : null, totalMs: Math.round(totalMs) });
          send({ type: "usage", model, ...usageTotal, costUsd: cost, ttftMs: firstToken ? Math.round(firstToken - tStart) : null, totalMs: Math.round(totalMs), toolCalls });
          send({ type: "done" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          span.recordException(e as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          logger.error("assistant.chat.failed", { model, error: msg });
          send({ type: "error", message: msg });
        } finally {
          span.end();
          controller.close();
        }
      });
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

export async function GET() {
  return Response.json({ configured: !!process.env.ANTHROPIC_API_KEY, model: DEFAULT_MODEL, models: MODELS });
}
