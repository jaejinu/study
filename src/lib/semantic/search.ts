/**
 * 하이브리드 검색: BM25(nori 형태소 + 표준 분석기) 와 kNN(bge-m3 임베딩) 을 RRF 로 합친다.
 *
 * - BM25 는 "MOVED", "XAUTOCLAIM" 처럼 정확한 용어에 강하고, 벡터는 "복제가 늦어지면?" ↔ "replication lag"
 *   처럼 표현이 달라도 뜻이 같은 질문에 강하다. 둘의 점수 척도가 달라 순위만으로 합친다(RRF).
 * - 가용성: OpenSearch·Ollama 중 하나라도 느리거나 꺼져 있으면 null 을 돌려 호출자가 키워드 검색으로 폴백한다.
 *   실패하면 30초 동안은 아예 시도하지 않는다(서킷 브레이커) — 매 요청이 타임아웃을 기다리지 않도록.
 */
import { embed } from "./embed";
import { INDEX, os, readIndexMeta, type IndexMeta } from "./store";
import { groupByNote, noteKeyOf, rrfFuse } from "./rrf";

/** 청크 목록 → 노트 키별 순위 (첫 등장 순서) */
function noteRankMap(ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of ids) {
    const k = noteKeyOf(id);
    if (!m.has(k)) m.set(k, m.size + 1);
  }
  return m;
}

export interface ChunkHit {
  id: string;
  subject: string;
  slug: string;
  title: string;
  level: string;
  heading: string;
  anchor: string;
  href: string;
  body: string;
  score: number;
}

export interface SemanticNoteHit extends ChunkHit {
  /** 노트 단위 RRF 점수 */
  noteScore: number;
  /** 이 노트에서 걸린 섹션 수 */
  matched: number;
  /** 대표 섹션의 목록별 청크 순위: [bm25, 벡터] */
  ranks: (number | null)[];
  /** 이 노트의 목록별 노트 순위 (같은 노트의 섹션은 한 번만 센다): [bm25, 벡터] */
  noteRanks: (number | null)[];
}

export interface SemanticResult {
  via: "hybrid" | "bm25";
  hits: SemanticNoteHit[];
  ms: number;
  model: string;
}

type Src = Omit<ChunkHit, "id" | "score">;
type Res = { hits: { hits: { _id: string; _score: number; _source: Src }[] } };

const SOURCE = ["subject", "slug", "title", "level", "heading", "anchor", "href", "body"];

function toHits(r: Res): ChunkHit[] {
  return r.hits.hits.map((h) => ({ id: h._id, score: h._score, ...h._source }));
}

export async function bm25Chunks(query: string, opts: { size?: number; subject?: string; signal?: AbortSignal; minimumShouldMatch?: string } = {}): Promise<ChunkHit[]> {
  const r = await os<Res>(
    "POST",
    `/${INDEX}/_search`,
    {
      size: opts.size ?? 50,
      _source: SOURCE,
      query: {
        bool: {
          must: [{ multi_match: { query, fields: ["title^3", "title.std^2", "heading^2", "heading.std^1.5", "body", "body.std^0.5"], type: "best_fields", tie_breaker: 0.3, ...(opts.minimumShouldMatch ? { minimum_should_match: opts.minimumShouldMatch } : {}) } }],
          filter: opts.subject ? [{ term: { subject: opts.subject } }] : [],
        },
      },
    },
    { signal: opts.signal },
  );
  return toHits(r);
}

export async function knnChunks(vector: number[], opts: { size?: number; subject?: string; signal?: AbortSignal } = {}): Promise<ChunkHit[]> {
  const size = opts.size ?? 50;
  const r = await os<Res>(
    "POST",
    `/${INDEX}/_search`,
    {
      size,
      _source: SOURCE,
      query: { knn: { vec: { vector, k: size, ...(opts.subject ? { filter: { term: { subject: opts.subject } } } : {}) } } },
    },
    { signal: opts.signal },
  );
  return toHits(r);
}

let meta: { at: number; value: IndexMeta | null } | null = null;
let downUntil = 0;

/** 인덱스의 임베딩 모델 정보 (60초 캐시). 질의도 색인과 같은 모델로 임베딩해야 한다 */
export async function indexMeta(): Promise<IndexMeta | null> {
  if (meta && Date.now() - meta.at < 60_000) return meta.value;
  const value = await readIndexMeta();
  meta = { at: Date.now(), value };
  return value;
}

export async function embedQuery(model: string, query: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<number[]> {
  const [v] = await embed(model, [query], "query", { timeoutMs: opts.timeoutMs ?? 1500, signal: opts.signal });
  return v;
}

export interface SemanticOptions {
  limit?: number;
  subject?: string;
  /** 전체 제한 시간 — 넘으면 null (호출자 폴백) */
  timeoutMs?: number;
  /** RRF k (기본 10 — pnpm search:eval 그리드에서 60 보다 퀴즈 질의 MRR 이 높았다) */
  k?: number;
  /** [bm25, vector] 가중치 */
  weights?: [number, number];
  /** 목록별 후보 수 */
  candidates?: number;
  /** 노트 점수에 두 번째로 좋은 섹션 점수를 더하는 비율 (여러 섹션이 맞는 노트를 우대) */
  sectionBonus?: number;
  /**
   * BM25 minimum_should_match. 대화체 질문("~하려면", "막으려면")의 일반 동사가 엉뚱한 노트를 끌어오지 않도록
   * 질의어의 60% 이상이 맞는 청크만 BM25 후보로 삼는다 (질의어 2개 이하면 전부). 평가에서 일상 표현 MRR 0.50 → 0.67.
   */
  minimumShouldMatch?: string;
  /**
   * 벡터에서만 걸린 청크의 최소 유사도 (lucene cosinesimil 점수 = (1+cos)/2).
   * 뜻이 전혀 다른 질의("ㅁㄴㅇㄹ")에도 kNN 은 항상 k 개를 돌려주므로, 키워드 근거가 없는 약한 후보는 버린다.
   */
  minVectorScore?: number;
}

export async function semanticSearch(query: string, opts: SemanticOptions = {}): Promise<SemanticResult | null> {
  const q = query.trim().slice(0, 300);
  if (!q || Date.now() < downUntil) return null;
  const t0 = performance.now();
  const ctrl = new AbortController();
  const budget = opts.timeoutMs ?? 1500;
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    const m = await indexMeta();
    if (!m) throw new Error(`인덱스 ${INDEX} 없음 (pnpm search:index)`);
    const cand = opts.candidates ?? 50;
    // 임베딩은 예산의 60% 안에 끝나야 한다 — 모델 콜드 로드(4초+)면 포기하고 BM25 만으로 답한다
    const vecP = embedQuery(m.model, q, { timeoutMs: Math.round(budget * 0.6), signal: ctrl.signal }).catch(() => null);
    const bmP = bm25Chunks(q, { size: cand, subject: opts.subject, signal: ctrl.signal, minimumShouldMatch: opts.minimumShouldMatch ?? "2<60%" });
    const vector = await vecP;
    const [bm, kn] = await Promise.all([bmP, vector ? knnChunks(vector, { size: cand, subject: opts.subject, signal: ctrl.signal }) : Promise.resolve(null)]);
    const minVec = opts.minVectorScore ?? 0.76;
    const bmIds = new Set(bm.map((h) => h.id));
    const knn = kn ? kn.filter((h) => bmIds.has(h.id) || h.score >= minVec) : [];
    const byId = new Map<string, ChunkHit>([...knn, ...bm].map((h) => [h.id, h]));
    const fused = rrfFuse([bm.map((h) => h.id), knn.map((h) => h.id)], opts.k ?? 10, opts.weights);
    const groups = groupByNote(
      fused.map((f) => ({ id: f.id, score: f.score, ranks: f.ranks })),
      opts.limit ?? 10,
      opts.sectionBonus ?? 0.3,
    );
    const bmNotes = noteRankMap(bm.map((h) => h.id));
    const vecNotes = noteRankMap(knn.map((h) => h.id));
    const hits = groups.map<SemanticNoteHit>((g) => ({
      ...byId.get(g.best.id)!,
      noteScore: g.score,
      matched: g.matched,
      ranks: g.best.ranks,
      noteRanks: [bmNotes.get(g.noteKey) ?? null, vecNotes.get(g.noteKey) ?? null],
    }));
    return { via: vector ? "hybrid" : "bm25", hits, ms: Math.round(performance.now() - t0), model: m.model };
  } catch {
    downUntil = Date.now() + 30_000;
    meta = null;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 테스트·평가용: 서킷 브레이커 초기화 */
export function resetSemanticBreaker() {
  downUntil = 0;
  meta = null;
}
