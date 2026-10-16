/**
 * Ollama 임베딩 클라이언트 (POST /api/embed, 입력 배열 일괄 처리).
 * 기본 모델 bge-m3(1024차원, 다국어·한국어 강함). 없으면 nomic-embed-text(768) 로 폴백.
 * keep_alive 로 모델을 메모리에 붙잡아 둔다 — 첫 로드는 4초 남짓 걸려 검색 타임아웃(1.5초)을 넘기기 때문.
 */
export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
export const EMBED_MODELS = [process.env.STUDY_EMBED_MODEL ?? "bge-m3", "nomic-embed-text"].filter((m, i, a) => a.indexOf(m) === i);

/** 모델별 접두어 (nomic 은 질의·문서 접두어를 요구한다) */
function prefix(model: string, kind: "query" | "doc") {
  if (model.startsWith("nomic-embed-text")) return kind === "query" ? "search_query: " : "search_document: ";
  return "";
}

export async function embed(model: string, texts: string[], kind: "query" | "doc", opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<number[][]> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const r = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts.map((t) => prefix(model, kind) + t), keep_alive: "30m", truncate: true }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (!r.ok) throw new Error(`embed ${model} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { embeddings: number[][] };
  return j.embeddings;
}

/** 설치된 임베딩 모델 중 첫 번째 (bge-m3 → nomic-embed-text 순). 없으면 null */
export async function pickEmbedModel(): Promise<string | null> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { models: { name: string }[] };
    const names = j.models.map((m) => m.name);
    return EMBED_MODELS.find((m) => names.some((n) => n === m || n === `${m}:latest`)) ?? null;
  } catch {
    return null;
  }
}
