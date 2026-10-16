import { getNote } from "@/lib/notes";
import { extractConcepts, groundFeedback, parseFeedback, splitSections, type Feedback } from "@/lib/practice/core";
import { chatOnce, NO_KEY_MESSAGE, openaiConfigured } from "@/lib/practice/llm";
import { EXPLAIN_SYSTEM, explainUser, JSON_RETRY } from "@/lib/practice/prompts";
import { getExplainHistory, saveExplain } from "@/lib/practice/store";
import type { OpenAIMessage } from "@/lib/assistant/openai";
import { logger } from "@/lib/log";
import { aiDisabledResponse } from "@/lib/read-only";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ID = /^[a-z0-9-]+$/;

/** 설명해 보기: 학습자의 설명을 노트와 비교해 구조화된 피드백(JSON)을 돌려준다 */
export async function POST(req: Request) {
  const disabled = aiDisabledResponse();
  if (disabled) return disabled;
  if (!openaiConfigured()) return Response.json({ error: NO_KEY_MESSAGE }, { status: 400 });
  let body: { subject?: string; slug?: string; section?: string; explanation?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const { subject = "", slug = "", section } = body;
  const explanation = String(body.explanation ?? "").trim().slice(0, 4000);
  if (!ID.test(subject) || !ID.test(slug)) return Response.json({ error: "잘못된 노트" }, { status: 400 });
  if (explanation.length < 20) return Response.json({ error: "설명을 조금 더 써 주세요 (20자 이상)." }, { status: 400 });
  const note = await getNote(subject, slug);
  if (!note) return Response.json({ error: "노트를 찾을 수 없습니다" }, { status: 404 });

  const sec = section ? splitSections(note.content).find((s) => s.id === section) : undefined;
  const concepts = extractConcepts({ content: note.content, tags: note.tags, section: sec?.id });
  const context = (sec ? `## ${sec.title}\n${sec.body}` : note.content).replace(/```[\s\S]*?```/g, (b) => (b.length > 600 ? `${b.slice(0, 600)}\n…\n\`\`\`` : b)).slice(0, 7000);
  const messages: OpenAIMessage[] = [
    { role: "system", content: EXPLAIN_SYSTEM },
    { role: "user", content: explainUser({ title: note.title, section: sec?.title, concepts, context, explanation }) },
  ];
  try {
    const first = await chatOnce("explain", messages, { json: true, maxTokens: 900 });
    let fb: Feedback | null = parseFeedback(first.text);
    let raw = first.text;
    let attempts = 1;
    let ms = first.ms;
    if (!fb) {
      const retry = await chatOnce("explain_retry", [...messages, { role: "assistant", content: first.text }, { role: "user", content: JSON_RETRY }], { json: true, maxTokens: 900 });
      fb = parseFeedback(retry.text);
      raw = retry.text;
      attempts = 2;
      ms += retry.ms;
    }
    if (fb) {
      fb = groundFeedback(fb, concepts, explanation, sec ? sec.body : note.content);
      await saveExplain(subject, slug, { at: Date.now(), score: fb.score, section: sec?.title });
    }
    logger.info("practice.explain.result", { subject, slug, section: sec?.title, ok: !!fb, score: fb?.score, attempts });
    return Response.json({ ok: true, feedback: fb, raw: fb ? undefined : raw, concepts, attempts, ms, model: first.model, history: await getExplainHistory(subject, slug) });
  } catch (e) {
    logger.error("practice.explain.failed", { subject, slug, error: (e as Error).message });
    return Response.json({ error: `모델 호출 실패: ${(e as Error).message}` }, { status: 502 });
  }
}
