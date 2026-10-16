/**
 * OpenSearch 의 study-notes-v1 인덱스: 노트 섹션 청크 + nori 텍스트 필드 + 1024차원 kNN 벡터.
 * 색인은 증분 — 청크 텍스트 해시가 같으면 임베딩을 다시 계산하지 않는다.
 */
import { getNote, listNotes } from "@/lib/notes";
import { subjects } from "@/lib/subjects";
import { chunkNote, type Chunk } from "./chunk";
import { embed, pickEmbedModel } from "./embed";

export const OS_URL = process.env.OPENSEARCH_URL ?? "http://127.0.0.1:19200";
export const INDEX = process.env.STUDY_SEARCH_INDEX ?? "study-notes-v1";

export async function os<T = Record<string, unknown>>(method: string, path: string, body?: unknown, opts: { ndjson?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const r = await fetch(`${OS_URL}${path}`, {
    method,
    headers: { "Content-Type": opts.ndjson ? "application/x-ndjson" : "application/json" },
    body: body === undefined ? undefined : opts.ndjson ? (body as string) : JSON.stringify(body),
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 300)}`), { status: r.status });
  return (text ? JSON.parse(text) : {}) as T;
}

/** 기본 사전이 잘못 자르는 이 사이트의 합성어 (code-lab/search 실험과 같은 사전) */
const USER_DICT = ["복제본 복제 본", "파이프라인", "레이트리밋 레이트 리밋", "컨슈머", "프로듀서", "리밸런스", "페일오버", "오프셋", "스탬피드", "핫키 핫 키", "서킷브레이커 서킷 브레이커", "가비지컬렉션 가비지 컬렉션", "이벤트루프 이벤트 루프"];

function analysis(nori: boolean) {
  if (!nori) return { analyzer: { korean: { type: "standard" } } };
  const stoptags = ["E", "IC", "J", "MAG", "MAJ", "MM", "SP", "SSC", "SSO", "SC", "SE", "XPN", "XSA", "XSN", "XSV", "UNA", "NA", "VSV"];
  return {
    tokenizer: { nori_dict: { type: "nori_tokenizer", decompound_mode: "mixed", user_dictionary_rules: USER_DICT } },
    filter: { nori_pos: { type: "nori_part_of_speech", stoptags } },
    analyzer: { korean: { type: "custom", tokenizer: "nori_dict", filter: ["nori_readingform", "lowercase", "nori_pos"] } },
  };
}

export interface IndexMeta {
  model: string;
  dim: number;
  analyzer: "nori" | "standard";
  chunker: number;
}
/** 청킹 규칙을 바꾸면 올린다 — 전체 재색인 */
export const CHUNKER_VERSION = 1;

export async function readIndexMeta(): Promise<IndexMeta | null> {
  try {
    const m = await os<Record<string, { mappings: { _meta?: IndexMeta } }>>("GET", `/${INDEX}/_mapping`, undefined, { timeoutMs: 3000 });
    return m[INDEX]?.mappings._meta ?? null;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

async function createIndex(meta: IndexMeta) {
  const text = { type: "text", analyzer: "korean", fields: { std: { type: "text", analyzer: "standard" } } };
  await os("PUT", `/${INDEX}`, {
    settings: { index: { knn: true, number_of_shards: 1, number_of_replicas: 0 }, analysis: analysis(meta.analyzer === "nori") },
    mappings: {
      _meta: meta,
      properties: {
        cid: { type: "keyword" },
        subject: { type: "keyword" },
        slug: { type: "keyword" },
        level: { type: "keyword" },
        anchor: { type: "keyword" },
        href: { type: "keyword" },
        hash: { type: "keyword" },
        title: text,
        heading: text,
        body: text,
        vec: { type: "knn_vector", dimension: meta.dim, method: { name: "hnsw", engine: "lucene", space_type: "cosinesimil", parameters: { m: 16, ef_construction: 128 } } },
      },
    },
  });
}

export async function allChunks(): Promise<Chunk[]> {
  const out: Chunk[] = [];
  for (const s of subjects) {
    for (const m of await listNotes(s.id)) {
      const note = await getNote(s.id, m.slug);
      if (note) out.push(...chunkNote({ subject: s.id, slug: m.slug, title: note.title, summary: note.summary, level: note.level, tags: note.tags, content: note.content, headings: note.headings }));
    }
  }
  return out;
}

async function existingHashes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let after: unknown[] | undefined;
  for (;;) {
    const r = await os<{ hits: { hits: { _id: string; _source: { hash: string }; sort: unknown[] }[] } }>("POST", `/${INDEX}/_search`, {
      size: 2000,
      _source: ["hash"],
      sort: [{ cid: "asc" }],
      ...(after ? { search_after: after } : {}),
    });
    const hs = r.hits.hits;
    for (const h of hs) out.set(h._id, h._source.hash);
    if (hs.length < 2000) return out;
    after = hs[hs.length - 1].sort;
  }
}

async function bulk(lines: string[]) {
  if (!lines.length) return;
  const r = await os<{ errors: boolean; items: Record<string, { error?: unknown }>[] }>("POST", "/_bulk", lines.join("\n") + "\n", { ndjson: true, timeoutMs: 120_000 });
  if (r.errors) {
    const err = r.items.map((i) => Object.values(i)[0].error).find(Boolean);
    throw new Error(`bulk 오류: ${JSON.stringify(err).slice(0, 300)}`);
  }
}

export interface IndexStats {
  model: string;
  dim: number;
  analyzer: string;
  notes: number;
  chunks: number;
  embedded: number;
  deleted: number;
  unchanged: number;
  rebuilt: boolean;
  ms: number;
  embedMs: number;
  sizeBytes: number;
}

/** 전체 노트를 청크로 만들어 바뀐 것만 임베딩·색인하고, 사라진 청크는 지운다 */
export async function buildIndex(opts: { full?: boolean; batch?: number; log?: (s: string) => void } = {}): Promise<IndexStats> {
  const log = opts.log ?? (() => {});
  const t0 = performance.now();
  const model = await pickEmbedModel();
  if (!model) throw new Error("Ollama 에 임베딩 모델이 없습니다: ollama pull bge-m3 (또는 nomic-embed-text)");
  const [probe] = await embed(model, ["차원 확인"], "doc");
  const plugins = await os<{ component: string }[]>("GET", "/_cat/plugins?format=json");
  const nori = plugins.some((p) => p.component === "analysis-nori");
  const want: IndexMeta = { model, dim: probe.length, analyzer: nori ? "nori" : "standard", chunker: CHUNKER_VERSION };

  const cur = await readIndexMeta();
  const mismatch = !!cur && (cur.model !== want.model || cur.dim !== want.dim || cur.analyzer !== want.analyzer || cur.chunker !== want.chunker);
  if (cur && (opts.full || mismatch)) {
    log(`인덱스 재생성: ${JSON.stringify(cur)} → ${JSON.stringify(want)}`);
    await os("DELETE", `/${INDEX}`);
  }
  const rebuilt = !cur || !!opts.full || mismatch;
  if (rebuilt) await createIndex(want);

  const chunks = await allChunks();
  const have = rebuilt ? new Map<string, string>() : await existingHashes();
  const changed = chunks.filter((c) => have.get(c.id) !== c.hash);
  const keep = new Set(chunks.map((c) => c.id));
  const stale = [...have.keys()].filter((id) => !keep.has(id));
  log(`청크 ${chunks.length}개 (노트 ${new Set(chunks.map((c) => `${c.subject}/${c.slug}`)).size}편) · 새로/바뀐 ${changed.length} · 삭제 ${stale.length}`);

  const batch = opts.batch ?? 32;
  let embedMs = 0;
  for (let i = 0; i < changed.length; i += batch) {
    const part = changed.slice(i, i + batch);
    const te = performance.now();
    const vecs = await embed(model, part.map((c) => c.text), "doc");
    embedMs += performance.now() - te;
    await bulk(
      part.flatMap((c, j) => [
        JSON.stringify({ index: { _index: INDEX, _id: c.id } }),
        JSON.stringify({ cid: c.id, subject: c.subject, slug: c.slug, level: c.level, anchor: c.anchor, href: c.href, hash: c.hash, title: c.title, heading: c.heading, body: c.body, vec: vecs[j] }),
      ]),
    );
    if ((i / batch) % 10 === 0) log(`  ${Math.min(i + batch, changed.length)}/${changed.length} 임베딩·색인`);
  }
  await bulk(stale.map((id) => JSON.stringify({ delete: { _index: INDEX, _id: id } })));
  await os("POST", `/${INDEX}/_refresh`);
  const st = await os<{ indices: Record<string, { primaries: { store: { size_in_bytes: number } } }> }>("GET", `/${INDEX}/_stats/store`);
  return {
    model,
    dim: want.dim,
    analyzer: want.analyzer,
    notes: new Set(chunks.map((c) => `${c.subject}/${c.slug}`)).size,
    chunks: chunks.length,
    embedded: changed.length,
    deleted: stale.length,
    unchanged: chunks.length - changed.length,
    rebuilt,
    ms: Math.round(performance.now() - t0),
    embedMs: Math.round(embedMs),
    sizeBytes: st.indices[INDEX]?.primaries.store.size_in_bytes ?? 0,
  };
}
