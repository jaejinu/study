import { getNote, listNotes } from "@/lib/notes";
import { loadQuiz } from "@/lib/quiz";
import { getSubject } from "@/lib/subjects";
import { hasQuestion, LEVELS, mulberry32, visibleTurn, type Level } from "@/lib/practice/core";
import { chatStream, NO_KEY_MESSAGE, openaiConfigured } from "@/lib/practice/llm";
import { answerTurn, INTERVIEW_FINISH, interviewStart, interviewSystem } from "@/lib/practice/prompts";
import { saveInterview } from "@/lib/practice/store";
import type { OpenAIMessage } from "@/lib/assistant/openai";
import { logger } from "@/lib/log";
import { aiDisabledResponse } from "@/lib/read-only";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Msg = { role: "user" | "assistant"; content: string };

/** 시드로 같은 노트 묶음을 고른다 — 턴마다 같은 근거로 면접이 이어지게 */
async function pickContext(subject: string, level: Level, seed: number) {
  const notes = await listNotes(subject);
  const pool = notes.filter((n) => n.level === level);
  const base = pool.length >= 2 ? pool : notes;
  const rnd = mulberry32(seed);
  const chosen = [...base].map((n) => ({ n, r: rnd() })).sort((a, b) => a.r - b.r).slice(0, 3).map((x) => x.n);
  const quiz = await loadQuiz(subject);
  const parts: string[] = [];
  for (const m of chosen) {
    const note = await getNote(subject, m.slug);
    if (!note) continue;
    const body = note.content.replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n");
    parts.push(`### ${note.title}\n${note.summary}\n${body.slice(0, 1600)}`);
  }
  // 같은 시드면 같은 순서 (턴마다 같은 질문 은행), 시드가 바뀌면 첫 질문도 바뀐다
  const cards = quiz
    .filter((c) => chosen.some((m) => m.slug === c.note))
    .map((c) => ({ c, r: rnd() }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c)
    .slice(0, 8);
  const bank = cards.map((c) => `- Q: ${c.q}\n  A: ${c.a}`).join("\n");
  return { context: parts.join("\n\n").slice(0, 6000), bank, cards, questions: cards.map((c) => c.q), notes: chosen.map((n) => ({ title: n.title, href: `/${subject}/notes/${n.slug}` })) };
}

export async function POST(req: Request) {
  const disabled = aiDisabledResponse();
  if (disabled) return disabled;
  if (!openaiConfigured()) return Response.json({ error: NO_KEY_MESSAGE }, { status: 400 });
  let body: { subject?: string; level?: string; seed?: number; action?: "start" | "answer" | "finish"; messages?: Msg[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const subject = getSubject(String(body.subject ?? ""));
  if (!subject) return Response.json({ error: "잘못된 주제" }, { status: 400 });
  const level = (LEVELS as readonly string[]).includes(String(body.level)) ? (body.level as Level) : "중급";
  const action = body.action ?? "answer";
  const seed = Number.isFinite(body.seed) ? Number(body.seed) : 1;
  const history = (body.messages ?? []).slice(-12).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 3000) }) as Msg);
  if (action === "answer" && history.at(-1)?.role !== "user") return Response.json({ error: "답변이 비어 있습니다" }, { status: 400 });

  const { context, bank, cards, questions, notes } = await pickContext(subject.id, level, seed);
  // 작은 모델은 인사만 하고 질문을 빠뜨리기 쉽다 — 첫 질문은 서버가 질문 은행에서 정하고, 응답에 질문이 없으면 다음 은행 질문을 덧붙인다
  const asked = history.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
  const nextQ = questions.find((q) => !asked.includes(q)) ?? questions[0];
  const messages: OpenAIMessage[] = [{ role: "system", content: interviewSystem({ subjectName: subject.name, level, context, bank }) }, ...history];
  if (action === "start") messages.push({ role: "user", content: interviewStart(nextQ) });
  if (action === "answer") {
    // 작은 모델이 평가를 건너뛰고 다음 질문으로 넘어가지 않도록, 마지막 답을 형식 지시로 감싸고 직전 질문의 모범 답(있으면)을 붙인다
    const lastQ = history.filter((m) => m.role === "assistant").at(-1)?.content ?? "";
    const ref = cards.find((c) => lastQ.includes(c.q));
    messages[messages.length - 1] = { role: "user", content: answerTurn(history.at(-1)!.content, ref?.a) };
  }
  if (action === "finish") messages.push({ role: "user", content: INTERVIEW_FINISH });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      send({ type: "meta", notes, level });
      try {
        // 첫 질문은 모델 없이 질문 은행에서 바로 낸다 — 작은 모델은 시작 인사에서 정답(때로는 틀린 답)을 먼저 말해 버린다
        if (action === "start" && nextQ) {
          send({ type: "text", text: `${subject.name} ${level} 면접을 시작하겠습니다. 답이 막히면 아는 데까지 말해 보세요.\n\n**첫 질문:** ${nextQ}` });
          logger.info("practice.interview.start", { subject: subject.id, level, seed, notes: notes.map((n) => n.href) });
          send({ type: "done", model: "question-bank", input: 0, output: 0, ms: 0 });
          return;
        }
        // 답변 턴은 보여 줄 부분만 흘려보낸다 (visibleTurn: 되풀이·모범 답 노출·장황한 꼬리 제거)
        let acc = "";
        let sent = "";
        const flush = (done: boolean) => {
          const vis = visibleTurn(acc, done);
          if (vis.length > sent.length && vis.startsWith(sent)) {
            send({ type: "text", text: vis.slice(sent.length) });
            sent = vis;
          }
        };
        const onDelta = action === "finish" ? (t: string) => send({ type: "text", text: t }) : (t: string) => ((acc += t), flush(false));
        const r = await chatStream(`interview_${action}`, messages, onDelta, { maxTokens: action === "finish" ? 600 : 320, frequencyPenalty: 0.3 });
        if (action !== "finish") {
          flush(true);
          if (nextQ && !hasQuestion(sent)) send({ type: "text", text: `\n\n**꼬리 질문:** ${nextQ}` });
        }
        if (action === "finish") {
          const turns = history.filter((m) => m.role === "user").length;
          await saveInterview(subject.id, { at: Date.now(), level, turns, summary: r.text.slice(0, 1500), notes: notes.map((n) => n.href) });
          logger.info("practice.interview.finish", { subject: subject.id, level, turns });
        }
        send({ type: "done", model: r.model, input: r.input, output: r.output, ms: r.ms });
      } catch (e) {
        send({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
