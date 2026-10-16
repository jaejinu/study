import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { executeTool, SYSTEM_PROMPT } from "@/lib/assistant/tools";
import { estimateOpenAICost, OPENAI_MODEL, OPENAI_MODELS, openaiClient, openaiConfigured, openaiTools, type OpenAIMessage } from "@/lib/assistant/openai";
import { getNote } from "@/lib/notes";
import { searchHybrid } from "@/lib/search";
import { getSubject } from "@/lib/subjects";
import { logger } from "@/lib/log";
import { metrics } from "@/lib/metrics";
import { aiDisabledResponse, isAiEnabled } from "@/lib/read-only";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type ClientMessage = { role: "user" | "assistant"; content: string };
type PageContext = { pathname?: string; selection?: string };

const ASK_PROMPT = `
당신은 지금 사용자가 보고 있는 화면 옆에 떠 있는 "AI 에게 묻기" 패널이다. 답은 짧고 정확하게, 마크다운(짧은 목록·표·코드)으로.
답변 원칙:
1. 먼저 **이 사이트의 내용**(아래 현재 페이지 본문, search_notes/get_note 결과)을 근거로 답하고 관련 노트를 [제목](경로) 링크로 인용한다.
2. 사이트에 없는 내용이 필요하면 일반 지식으로 보충하되, 그 부분은 "**사이트 밖 내용:**" 으로 시작하는 단락에 둔다. 모르면 모른다고 한다.
3. 사용자가 "지금 이 부분" 처럼 현재 페이지를 가리키면 아래 본문/선택 텍스트를 가리키는 것이다.
4. 실험이 질문에 답이 되면 propose_experiment 로 제안한다(실행은 사용자가 한다).
`;

type Source = { title: string; href: string; subject: string; kind: "current" | "related" };

async function pageContext(ctx: PageContext, question: string): Promise<{ text: string; sources: Source[] }> {
  const parts: string[] = [];
  const sources: Source[] = [];
  const m = /^\/([a-z0-9-]+)(?:\/notes\/([a-z0-9-]+))?/.exec(ctx.pathname ?? "");
  const subject = m ? getSubject(m[1]) : undefined;
  if (subject) parts.push(`현재 주제: ${subject.name} (${subject.id}) — ${subject.tagline}`);
  if (m?.[2] && subject) {
    const note = await getNote(subject.id, m[2]);
    if (note) {
      parts.push(`현재 노트: [${note.title}](/${subject.id}/notes/${m[2]}) (${note.level})\n요약: ${note.summary}\n\n--- 노트 본문 (앞 14000자) ---\n${note.content.slice(0, 14000)}`);
      sources.push({ title: note.title, href: `/${subject.id}/notes/${m[2]}`, subject: subject.name, kind: "current" });
    }
  } else if (ctx.pathname) parts.push(`현재 경로: ${ctx.pathname}`);
  if (ctx.selection?.trim()) parts.push(`사용자가 화면에서 선택한 텍스트:\n"""${ctx.selection.trim().slice(0, 2000)}"""`);
  // 모델이 툴을 안 쓰거나 검색어를 틀려도 근거가 있도록, 질문으로 관련 노트를 미리 찾아 붙인다 (검색 증강)
  // 하이브리드(BM25+벡터) 검색은 노트의 "가장 잘 맞는 섹션" 과 그 앵커를 준다. OpenSearch 가 꺼져 있으면 키워드 검색으로 폴백
  const found = await searchHybrid(question, { limit: 6, snippetWidth: 480 });
  const hits = found.hits.filter((h) => h.kind === "note" && !(m?.[2] && h.href.split("#")[0].endsWith(`/${m[2]}`))).slice(0, 5);
  const label = (h: (typeof hits)[number]) => `${h.title}${h.section ? ` § ${h.section}` : ""}`;
  if (hits.length) parts.push(`질문과 관련된 이 사이트의 노트 섹션 (${found.via === "keyword" ? "키워드" : "의미+키워드"} 검색 · 근거로 쓰고 링크로 인용):\n${hits.map((h) => `- [${label(h)}](${h.href}) — ${h.subjectName}: ${h.snippet}`).join("\n")}`);
  for (const h of hits) sources.push({ title: label(h), href: h.href, subject: h.subjectName, kind: "related" });
  logger.info("ask.grounding", { via: found.via, ms: found.ms, hits: hits.length });
  return { text: parts.join("\n\n"), sources };
}

export async function POST(req: Request) {
  const disabled = aiDisabledResponse();
  if (disabled) return disabled;
  if (!openaiConfigured()) {
    return Response.json({ error: "OPENAI_API_KEY 가 설정되어 있지 않습니다. `OPENAI_API_KEY=sk-... pnpm dev` 로 실행하거나, Ollama 를 쓰려면 `OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen2.5:0.5b`." }, { status: 400 });
  }
  let body: { messages: ClientMessage[]; model?: string; context?: PageContext };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const model = body.model && OPENAI_MODELS.includes(body.model) ? body.model : OPENAI_MODEL;
  const history = (body.messages ?? []).slice(-16).map((m) => ({ role: m.role, content: String(m.content).slice(0, 6000) }));
  if (history.length === 0 || history[history.length - 1].role !== "user") return Response.json({ error: "마지막 메시지는 user 여야 합니다" }, { status: 400 });

  const client = openaiClient();
  const tracer = trace.getTracer("study-ask");
  const encoder = new TextEncoder();
  const usage = { input: 0, output: 0, cached: 0 };
  const { text: context, sources } = await pageContext(body.context ?? {}, history[history.length - 1].content);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      await tracer.startActiveSpan("ask.chat", { attributes: { "gen_ai.system": "openai", "gen_ai.request.model": model, "gen_ai.operation.name": "chat", "study.ask.pathname": body.context?.pathname ?? "" } }, async (span) => {
        const tStart = performance.now();
        // 모델에 준 근거를 먼저 보낸다 — 모델이 링크를 빼먹어도 사용자는 근거를 볼 수 있다
        send({ type: "sources", items: sources });
        let firstToken = 0;
        let toolCalls = 0;
        const messages: OpenAIMessage[] = [
          { role: "system", content: `${SYSTEM_PROMPT}\n${ASK_PROMPT}\n\n=== 현재 화면 컨텍스트 ===\n${context || "(없음)"}` },
          ...history.map((m) => ({ role: m.role, content: m.content }) as OpenAIMessage),
        ];
        try {
          for (let iter = 0; iter < 5; iter++) {
            const res = await client.chat.completions.create({ model, messages, tools: openaiTools, stream: true, stream_options: { include_usage: true } });
            let text = "";
            const calls = new Map<number, { id: string; name: string; args: string }>();
            let finish: string | null = null;
            for await (const chunk of res as AsyncIterable<ChatCompletionChunk>) {
              if (chunk.usage) {
                usage.input += chunk.usage.prompt_tokens ?? 0;
                usage.output += chunk.usage.completion_tokens ?? 0;
                usage.cached += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
              }
              const choice = chunk.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) finish = choice.finish_reason;
              const delta = choice.delta;
              if (delta?.content) {
                if (!firstToken) {
                  firstToken = performance.now();
                  metrics.llmLatency.observe({ model, phase: "ttft" }, (firstToken - tStart) / 1000);
                }
                text += delta.content;
                send({ type: "text", text: delta.content });
              }
              for (const tc of delta?.tool_calls ?? []) {
                const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name += tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                calls.set(tc.index, cur);
              }
            }
            if (calls.size === 0 || finish === "stop") {
              if (text) messages.push({ role: "assistant", content: text });
              break;
            }
            const toolList = [...calls.values()];
            messages.push({ role: "assistant", content: text || null, tool_calls: toolList.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) });
            for (const c of toolList) {
              toolCalls++;
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(c.args || "{}") as Record<string, unknown>;
              } catch {
                /* 빈 입력 */
              }
              send({ type: "tool_start", name: c.name, input });
              const t0 = performance.now();
              const out = await tracer.startActiveSpan(`tool.${c.name}`, async (ts) => {
                const r = await executeTool(c.name, input);
                ts.setAttributes({ "gen_ai.tool.name": c.name, "study.tool.error": !!r.isError });
                ts.end();
                return r;
              });
              metrics.llmToolCalls.inc({ tool: c.name, outcome: out.isError ? "error" : "ok" });
              send({ type: "tool_result", name: c.name, ms: Math.round(performance.now() - t0), isError: !!out.isError, preview: JSON.stringify(out.result).slice(0, 300), proposal: out.proposal });
              messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out.result).slice(0, 16000) });
            }
          }
          metrics.llmTokens.inc({ model, kind: "input" }, usage.input);
          metrics.llmTokens.inc({ model, kind: "output" }, usage.output);
          metrics.llmTokens.inc({ model, kind: "cache_read" }, usage.cached);
          const cost = estimateOpenAICost(model, usage);
          metrics.llmCost.inc({ model }, cost);
          const totalMs = performance.now() - tStart;
          metrics.llmLatency.observe({ model, phase: "total" }, totalMs / 1000);
          span.setAttributes({ "gen_ai.usage.input_tokens": usage.input, "gen_ai.usage.output_tokens": usage.output, "study.llm.cost_usd": cost, "study.llm.tool_calls": toolCalls });
          logger.info("ask.chat", { model, ...usage, costUsd: Number(cost.toFixed(5)), toolCalls, ttftMs: firstToken ? Math.round(firstToken - tStart) : null, totalMs: Math.round(totalMs), pathname: body.context?.pathname });
          send({ type: "usage", model, ...usage, costUsd: cost, ttftMs: firstToken ? Math.round(firstToken - tStart) : null, totalMs: Math.round(totalMs), toolCalls });
          send({ type: "done" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          span.recordException(e as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          logger.error("ask.chat.failed", { model, error: msg });
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
  if (!isAiEnabled()) return Response.json({ configured: false, disabled: true, model: OPENAI_MODEL, models: [], baseUrl: null });
  return Response.json({ configured: openaiConfigured(), model: OPENAI_MODEL, models: OPENAI_MODELS, baseUrl: process.env.OPENAI_BASE_URL ?? null });
}
