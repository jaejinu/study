import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getNote, listNotes } from "@/lib/notes";
import { subjects } from "@/lib/subjects";
import { embed, DIM } from "./ai";
import type { CodeExperiment } from "./types";

const run = promisify(execFile);
export const OS_URL = process.env.OPENSEARCH_URL ?? "http://127.0.0.1:19200";

type Json = Record<string, unknown>;

/** OpenSearch REST 호출. 본문은 JSON, 실패하면 상태·에러 본문을 담은 예외 */
export async function os<T = Json>(method: string, path: string, body?: unknown, opts: { ndjson?: boolean; timeout?: number } = {}): Promise<T> {
  const r = await fetch(`${OS_URL}${path}`, {
    method,
    headers: { "Content-Type": opts.ndjson ? "application/x-ndjson" : "application/json" },
    body: body === undefined ? undefined : opts.ndjson ? (body as string) : JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeout ?? 30_000),
  });
  const text = await r.text();
  const json = text ? (JSON.parse(text) as T) : ({} as T);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
  return json;
}

export async function requiresOpenSearch(): Promise<string | null> {
  try {
    const h = await os<{ status: string }>("GET", "/_cluster/health", undefined, { timeout: 4000 });
    if (h.status === "red") return "OpenSearch 클러스터 상태가 red 입니다 (docker logs study-opensearch).";
    return null;
  } catch {
    return `OpenSearch(${OS_URL})에 연결할 수 없습니다. \`pnpm search:up\` 을 실행한 뒤 1분쯤 기다리세요.`;
  }
}

async function hasNori(): Promise<boolean> {
  const plugins = await os<{ component: string }[]>("GET", "/_cat/plugins?format=json");
  return plugins.some((p) => p.component === "analysis-nori");
}

/** nori 플러그인이 없으면 컨테이너에 설치하고 재시작한다 (1~2분) */
async function ensureNori(rec: { note: (t: string) => void; measure: <T>(l: string, f: () => Promise<T>) => Promise<T> }): Promise<boolean> {
  if (await hasNori()) return true;
  rec.note("analysis-nori 플러그인이 없어 설치한다: docker exec study-opensearch bin/opensearch-plugin install analysis-nori && docker restart");
  try {
    await rec.measure("opensearch-plugin install analysis-nori", () => run("docker", ["exec", "study-opensearch", "bin/opensearch-plugin", "install", "--batch", "analysis-nori"], { timeout: 180_000 }));
    await rec.measure("docker restart study-opensearch + 준비 대기", async () => {
      await run("docker", ["restart", "study-opensearch"], { timeout: 60_000 });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          await os("GET", "/_cluster/health", undefined, { timeout: 3000 });
          return "ready";
        } catch {
          /* 아직 */
        }
      }
      throw new Error("재시작 후 OpenSearch 가 준비되지 않음");
    });
    return hasNori();
  } catch (e) {
    rec.note(`nori 설치 실패 (${(e as Error).message.slice(0, 120)}) — 표준 분석기로 진행`);
    return false;
  }
}

interface Doc {
  id: string;
  subject: string;
  subjectName: string;
  slug: string;
  title: string;
  level: string;
  tags: string[];
  summary: string;
  body: string;
}

async function loadAllNotes(): Promise<Doc[]> {
  const docs: Doc[] = [];
  for (const s of subjects) {
    for (const m of await listNotes(s.id)) {
      const n = await getNote(s.id, m.slug);
      if (!n) continue;
      docs.push({ id: `${s.id}/${m.slug}`, subject: s.id, subjectName: s.name, slug: m.slug, title: n.title, level: n.level, tags: n.tags, summary: n.summary, body: n.content.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>|\-]/g, " ").replace(/\s+/g, " ").slice(0, 20_000) });
    }
  }
  return docs;
}

/** 이 프로젝트 도메인의 사용자 사전: nori 가 "복제본" 을 "복+제본(책 제본)" 으로 자르는 것처럼, 기본 사전이 모르는 합성어를 알려 준다 */
export const USER_DICT = ["복제본 복제 본", "복제본의 복제 본 의", "파이프라인", "레이트리밋 레이트 리밋", "컨슈머", "프로듀서", "리밸런스", "페일오버", "오프셋", "스탬피드", "핫키 핫 키"];

function analyzers(nori: boolean) {
  if (!nori) return { analysis: { analyzer: { korean: { type: "standard" }, korean_raw: { type: "standard" } } } };
  // E=어미, J=조사, SP/SSC/SSO/SC/SE=기호, XS*=접미사, VSV=동사 어간 결합 등 검색에 쓸모없는 품사를 버린다
  const stoptags = ["E", "IC", "J", "MAG", "MAJ", "MM", "SP", "SSC", "SSO", "SC", "SE", "XPN", "XSA", "XSN", "XSV", "UNA", "NA", "VSV"];
  return {
    analysis: {
      tokenizer: {
        nori_raw: { type: "nori_tokenizer", decompound_mode: "mixed" },
        nori_dict: { type: "nori_tokenizer", decompound_mode: "mixed", user_dictionary_rules: USER_DICT },
      },
      filter: { nori_pos: { type: "nori_part_of_speech", stoptags } },
      analyzer: {
        korean_raw: { type: "custom", tokenizer: "nori_raw", filter: ["nori_readingform", "lowercase", "nori_pos"] },
        korean: { type: "custom", tokenizer: "nori_dict", filter: ["nori_readingform", "lowercase", "nori_pos"] },
      },
    },
  };
}

async function bulk(index: string, docs: { id: string; doc: unknown }[]) {
  const lines = docs.flatMap((d) => [JSON.stringify({ index: { _index: index, _id: d.id } }), JSON.stringify(d.doc)]).join("\n") + "\n";
  const r = await os<{ took: number; errors: boolean; items: { index: { error?: unknown } }[] }>("POST", "/_bulk?refresh=true", lines, { ndjson: true, timeout: 120_000 });
  if (r.errors) throw new Error(`bulk 오류: ${JSON.stringify(r.items.find((i) => i.index.error)?.index.error).slice(0, 200)}`);
  return `${docs.length} docs, took ${r.took}ms`;
}

type Hit = { _id: string; _score: number; _source: Partial<Doc> };
type SearchRes = { took: number; hits: { total: { value: number }; hits: Hit[] } };

// ---------------------------------------------------------------- 1. 노트 색인 + 분석기 + BM25
export const searchIndexNotes: CodeExperiment = {
  id: "search-index-notes",
  subject: "opensearch",
  title: "이 사이트의 노트 전체를 색인하고, 표준 분석기와 nori 형태소 분석기가 한국어를 어떻게 다르게 자르는지 본다",
  category: "역색인",
  summary: "노트 전편을 OpenSearch 에 bulk 색인(표준·nori 두 필드), _analyze 로 같은 문장의 토큰을 비교, '복제 지연' 같은 질의가 두 분석기에서 몇 건·어떤 점수로 걸리는지, explain 으로 BM25 점수가 어떻게 만들어지는지 읽는다. nori 가 없으면 설치한다(1~2분)",
  notes: ["01-inverted-index-analyzers", "03-query-dsl-bm25", "07-korean-and-ranking"],
  description: `
검색 엔진은 문서를 받으면 **분석기**(토크나이저 + 필터)로 토큰을 만들고, 토큰 → 문서 목록의 **역색인**을 쌓는다. 질의도 같은 분석기를 거쳐 토큰이 되고, 역색인에서 그 토큰을 가진 문서를 찾아 **BM25** 로 점수를 매긴다.
그래서 분석기가 곧 검색 품질이다. 표준 분석기는 공백·기호로만 자르므로 한국어는 "복제본의"·"복제를"·"복제가" 가 전부 다른 토큰이 돼 "복제" 로 검색하면 안 걸린다. **nori** 는 형태소로 잘라 "복제" 라는 어간을 남기고 조사를 버린다.
이 실험은 이 사이트의 노트를 전부 색인해 그 차이를 숫자로 본다.
`,
  code: `PUT /lab-notes  { "settings": { "analysis": { "analyzer": { "korean": { "tokenizer": "nori_tokenizer", "filter": ["nori_readingform","lowercase","nori_part_of_speech"] } } } },
                  "mappings": { "properties": { "body": { "type": "text", "analyzer": "korean", "fields": { "std": { "type": "text", "analyzer": "standard" } } } } } }
POST /_bulk  { "index": { "_index": "lab-notes", "_id": "kafka/08-cdc" } }\\n{ "title": "...", "body": "..." }
GET  /lab-notes/_analyze  { "analyzer": "korean",   "text": "복제본의 지연을 모니터링한다" }   # 복제, 본, 지연, 모니터링, 하
GET  /lab-notes/_analyze  { "analyzer": "standard", "text": "복제본의 지연을 모니터링한다" }   # 복제본의, 지연을, 모니터링한다
GET  /lab-notes/_search   { "query": { "match": { "body": "복제 지연" } } }        # nori 필드
GET  /lab-notes/_search   { "query": { "match": { "body.std": "복제 지연" } } }    # 표준 필드
GET  /lab-notes/_explain/kafka%2F05-internals-storage-replication  { "query": { "match": { "body": "복제 지연" } } }`,
  requires: requiresOpenSearch,
  async run({ rec }) {
    const index = "lab-notes";
    const nori = await ensureNori(rec);
    rec.steps.push({ cmd: "GET /_cat/plugins", result: nori ? "analysis-nori 있음 → korean 분석기 = nori" : "nori 없음 → korean 분석기 = standard (비교 무의미)", ms: 0 });
    await os("DELETE", `/${index}`).catch(() => {});
    await rec.measure(`PUT /${index} (korean + standard 두 분석기, body/title 멀티필드)`, () =>
      os("PUT", `/${index}`, {
        settings: { number_of_shards: 1, number_of_replicas: 0, ...analyzers(nori) },
        mappings: {
          properties: {
            subject: { type: "keyword" },
            subjectName: { type: "keyword" },
            slug: { type: "keyword" },
            level: { type: "keyword" },
            tags: { type: "keyword" },
            title: { type: "text", analyzer: "korean", fields: { std: { type: "text", analyzer: "standard" } } },
            summary: { type: "text", analyzer: "korean" },
            body: { type: "text", analyzer: "korean", fields: { std: { type: "text", analyzer: "standard" } } },
          },
        },
      }),
    );
    const docs = await loadAllNotes();
    await rec.measure(`POST /_bulk — 노트 ${docs.length}편 (총 ${(docs.reduce((a, d) => a + d.body.length, 0) / 1000).toFixed(0)}K자)`, () => bulk(index, docs.map((d) => ({ id: d.id, doc: d }))));
    const stats = await os<{ indices: Record<string, { primaries: { docs: { count: number }; store: { size_in_bytes: number }; segments: { count: number } } }> }>("GET", `/${index}/_stats/docs,store,segments`);
    const st = stats.indices[index].primaries;
    rec.steps.push({ cmd: `GET /${index}/_stats`, result: { docs: st.docs.count, storeMB: (st.store.size_in_bytes / 1e6).toFixed(1), segments: st.segments.count }, ms: 0 });
    rec.check(`문서 ${docs.length}건이 색인됐다`, st.docs.count === docs.length, st.docs.count);

    rec.note("같은 문장을 두 분석기에 넣어 토큰을 비교한다");
    const sentence = "복제본의 지연을 모니터링한다. 파이프라인으로 왕복 시간을 줄였다";
    const tok = async (analyzer: string) => (await os<{ tokens: { token: string }[] }>("POST", `/${index}/_analyze`, { analyzer, text: sentence })).tokens.map((t) => t.token);
    const std = await tok("standard");
    const raw = await tok("korean_raw");
    const kor = await tok("korean");
    rec.steps.push({ cmd: `_analyze "${sentence}"`, result: { standard: std, "nori(기본 사전)": raw, "nori(+사용자 사전)": kor }, ms: 0 });
    if (nori) {
      rec.check("표준 분석기는 '복제본의'·'지연을' 처럼 조사가 붙은 채 토큰이 된다", std.includes("복제본의") && std.includes("지연을"));
      rec.check("기본 사전 nori 는 '복제본' 을 '복 + 제본(책 제본)' 으로 잘못 자른다 — 사전이 모르는 합성어", raw.includes("제본") && !raw.includes("복제"), raw);
      rec.check("사용자 사전(복제본 복제 본)을 주면 '복제' 가 토큰으로 남고 조사·어미는 사라진다", ["복제", "지연", "모니터링", "왕복", "시간"].every((w) => kor.includes(w)) && !kor.includes("지연을"), kor);
      rec.note("형태소 분석기는 사전이 전부다. 도메인 용어(복제본, 레이트리밋, 핫키)는 user_dictionary 로 가르쳐야 하고, 바꾸면 리인덱스가 필요하다 (노트 07).");
    }

    rec.note("질의 '복제 지연' 을 nori 필드(body)와 표준 필드(body.std)에 각각 — 걸리는 문서 수와 상위 3건");
    const search = async (field: string, q: string) => os<SearchRes>("POST", `/${index}/_search`, { size: 3, query: { match: { [field]: q } }, _source: ["title", "subject"] });
    const q = "복제 지연";
    const [a, b] = await Promise.all([search("body", q), search("body.std", q)]);
    const fmt = (r: SearchRes) => ({ hits: r.hits.total.value, took: `${r.took}ms`, top: r.hits.hits.map((h) => `${h._score.toFixed(2)} ${h._source.subject}/${h._source.title}`) });
    rec.steps.push({ cmd: `match body(${nori ? "nori" : "standard"}) "${q}"`, result: fmt(a), ms: a.took });
    rec.steps.push({ cmd: `match body.std(standard) "${q}"`, result: fmt(b), ms: b.took });
    if (nori) rec.check("형태소 분석 필드가 더 많은 문서를 찾는다 (조사가 붙은 변형까지 매치)", a.hits.total.value > b.hits.total.value, `${a.hits.total.value} vs ${b.hits.total.value}`);
    rec.check("상위 결과에 복제를 다루는 노트(Redis 11 / Kafka 05 / PG 05 / 분산 04)가 있다", a.hits.hits.some((h) => /replication|replica|복제/.test(`${h._id} ${h._source.title}`)), a.hits.hits.map((h) => h._id));

    rec.note("explain: 상위 문서의 점수가 어떤 텀의 tf·idf·길이 보정으로 만들어졌는지");
    const top = a.hits.hits[0];
    const ex = await os<{ explanation: { value: number; details: { value: number; description: string; details: { description: string; value: number; details?: { description: string; value: number }[] }[] }[] } }>("POST", `/${index}/_explain/${encodeURIComponent(top._id)}`, { query: { match: { body: q } } });
    const terms = ex.explanation.details.map((d) => {
      const term = /weight\((?:body:)?(\S+)\s/.exec(d.description)?.[1] ?? d.description.slice(0, 30);
      const inner = d.details[0]?.details ?? [];
      const idf = inner.find((x) => x.description.startsWith("idf"))?.value;
      const tfn = inner.find((x) => x.description.startsWith("tf"))?.value;
      return { term, score: Number(d.value.toFixed(3)), idf: idf !== undefined ? Number(idf.toFixed(3)) : undefined, tf: tfn !== undefined ? Number(tfn.toFixed(3)) : undefined };
    });
    rec.steps.push({ cmd: `GET /_explain/${top._id}`, result: { total: Number(ex.explanation.value.toFixed(3)), terms }, ms: 0 });
    rec.check("문서 점수 = 질의 텀별 점수의 합 (BM25)", Math.abs(terms.reduce((s, t) => s + t.score, 0) - ex.explanation.value) < 0.01);
    rec.note(`idf 가 큰 텀 = 드문 텀이 점수를 좌우한다. 희귀한 '${terms.sort((x, y) => (y.idf ?? 0) - (x.idf ?? 0))[0]?.term}' 가 '${terms[terms.length - 1]?.term}' 보다 한 번 등장할 때 더 큰 점수.`);

    rec.note("주제 필터 + 하이라이트: filter 절은 점수에 영향 없이 후보만 줄인다 (캐시됨)");
    const filtered = await os<{ took: number; hits: { hits: (Hit & { highlight?: Record<string, string[]> })[] } }>("POST", `/${index}/_search`, {
      size: 2,
      query: { bool: { must: { match: { body: "장애 복구" } }, filter: [{ term: { subject: "kafka" } }] } },
      highlight: { fields: { body: { fragment_size: 80, number_of_fragments: 1 } } },
      _source: ["title"],
    });
    rec.steps.push({ cmd: `bool{must: match "장애 복구", filter: subject=kafka} + highlight`, result: filtered.hits.hits.map((h) => ({ title: h._source.title, score: h._score.toFixed(2), snippet: h.highlight?.body?.[0]?.replace(/<\/?em>/g, "**") })), ms: filtered.took });
    rec.check("filter 로 kafka 노트만 남는다", filtered.hits.hits.every((h) => h._id.startsWith("kafka/")));
    rec.note(`인덱스 ${index} 는 남겨 둔다 — OpenSearch Dashboards 없이도 curl localhost:19200/${index}/_search?q=... 로 계속 실험할 수 있다.`);
  },
};

// ---------------------------------------------------------------- 2. 하이브리드 (BM25 + kNN + RRF)
export const searchHybridRrf: CodeExperiment = {
  id: "search-hybrid-rrf",
  subject: "opensearch",
  title: "하이브리드 검색: BM25 와 kNN 벡터 검색의 순위가 어떻게 다르고, RRF 로 합치면 무엇이 올라오는가",
  category: "하이브리드",
  summary: "노트를 텍스트 + 1024차원 벡터(knn_vector, HNSW)로 색인하고 같은 질의를 BM25·kNN 으로 각각 돌린 뒤 RRF(k=60)로 합친 순위를 표로 비교. OpenSearch 의 hybrid 질의 + normalization 파이프라인(min-max, 가중 합)도 실행해 본다",
  notes: ["05-hybrid-search-rag", "03-query-dsl-bm25"],
  description: `
BM25 는 **정확한 단어**에 강하고(식별자·에러 코드·고유명사), 벡터 검색은 **의미**에 강하다(동의어·다른 표현). 둘은 실패하는 질의가 다르므로 합치면 둘 다보다 낫다 — 그것이 하이브리드 검색이고 RAG 검색기의 기본값이다.
합치는 가장 단순하고 튼튼한 방법이 **RRF**(Reciprocal Rank Fusion): 각 목록에서의 **순위**만 보고 \`Σ 1/(k+rank)\` 를 더한다. 점수 스케일이 다른 두 시스템을 정규화 없이 섞을 수 있다.
벡터는 ai-systems 실험과 같은 결정적 가짜 임베딩(해싱 트릭)이라 의미를 모른다 — 역학(인덱스·kNN·융합)을 보는 실험이다. 진짜 임베딩 모델로 바꾸면 벡터 쪽 품질이 올라간다.
`,
  code: `PUT /lab-hybrid { "settings": { "index.knn": true }, "mappings": { "properties": {
  "text": { "type": "text" }, "vec": { "type": "knn_vector", "dimension": 1024, "method": { "name": "hnsw", "space_type": "cosinesimil", "engine": "lucene" } } } } }
POST /lab-hybrid/_search { "query": { "match": { "text": "메시지 순서 보장" } } }                       # BM25
POST /lab-hybrid/_search { "query": { "knn": { "vec": { "vector": [...], "k": 10 } } } }            # kNN
# RRF: score(d) = Σ_lists 1 / (60 + rank_list(d))
PUT /_search/pipeline/hybrid { "phase_results_processors": [{ "normalization-processor": { "normalization": { "technique": "min_max" }, "combination": { "technique": "arithmetic_mean", "parameters": { "weights": [0.5, 0.5] } } } }] }
POST /lab-hybrid/_search?search_pipeline=hybrid { "query": { "hybrid": { "queries": [ { "match": {...} }, { "knn": {...} } ] } } }`,
  requires: requiresOpenSearch,
  async run({ rec }) {
    const index = "lab-hybrid";
    const nori = await hasNori();
    await os("DELETE", `/${index}`).catch(() => {});
    await rec.measure(`PUT /${index} (text + knn_vector ${DIM}d HNSW cosine, lucene 엔진)`, () =>
      os("PUT", `/${index}`, {
        settings: { number_of_shards: 1, number_of_replicas: 0, "index.knn": true, ...analyzers(nori) },
        mappings: {
          properties: {
            subject: { type: "keyword" },
            title: { type: "text", analyzer: "korean" },
            text: { type: "text", analyzer: "korean" },
            vec: { type: "knn_vector", dimension: DIM, method: { name: "hnsw", space_type: "cosinesimil", engine: "lucene", parameters: { ef_construction: 128, m: 16 } } },
          },
        },
      }),
    );
    const docs = await loadAllNotes();
    await rec.measure(`bulk ${docs.length}편 (제목+요약+태그 텍스트, 가짜 임베딩 벡터)`, () =>
      bulk(index, docs.map((d) => {
        const text = `${d.title} ${d.summary} ${d.tags.join(" ")}`;
        return { id: d.id, doc: { subject: d.subject, title: d.title, text, vec: embed(text) } };
      })),
    );

    const queries = ["메시지 순서 보장 키", "장애 났을 때 자동으로 되돌리기", "비밀번호 유출 막기"];
    const K = 60;
    for (const q of queries) {
      const bm = await os<SearchRes>("POST", `/${index}/_search`, { size: 10, query: { multi_match: { query: q, fields: ["title^2", "text"] } }, _source: ["title", "subject"] });
      const kn = await os<SearchRes>("POST", `/${index}/_search`, { size: 10, query: { knn: { vec: { vector: embed(q), k: 10 } } }, _source: ["title", "subject"] });
      const rrf = new Map<string, { score: number; title: string; bm?: number; kn?: number }>();
      bm.hits.hits.forEach((h, i) => rrf.set(h._id, { score: 1 / (K + i + 1), title: `${h._source.subject}/${h._source.title}`, bm: i + 1 }));
      kn.hits.hits.forEach((h, i) => {
        const e = rrf.get(h._id) ?? { score: 0, title: `${h._source.subject}/${h._source.title}` };
        e.score += 1 / (K + i + 1);
        e.kn = i + 1;
        rrf.set(h._id, e);
      });
      const fused = [...rrf.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 5);
      rec.steps.push({
        cmd: `질의 "${q}"`,
        result: {
          BM25: bm.hits.hits.slice(0, 5).map((h, i) => `${i + 1}. ${h._source.subject}/${h._source.title} (${h._score.toFixed(2)})`),
          kNN: kn.hits.hits.slice(0, 5).map((h, i) => `${i + 1}. ${h._source.subject}/${h._source.title} (${h._score.toFixed(3)})`),
          RRF: fused.map(([, v], i) => `${i + 1}. ${v.title} (rrf ${v.score.toFixed(4)}, bm25 #${v.bm ?? "-"}, knn #${v.kn ?? "-"})`),
        },
        ms: bm.took + kn.took,
      });
      if (q === queries[0]) {
        rec.check("RRF 상위 5 안에 두 목록 모두에 있는 문서(양쪽 합의)가 1위다", fused[0]?.[1].bm !== undefined && fused[0]?.[1].kn !== undefined, fused[0]);
        rec.note(bm.hits.hits[0]?._id !== kn.hits.hits[0]?._id ? "BM25 1위와 kNN 1위가 다르다 — 두 검색기는 다른 것을 본다" : "이 질의는 두 검색기의 1위가 같다 — 합의가 강한 질의");
      }
    }
    rec.note("RRF 는 점수를 보지 않고 순위만 본다. 한쪽에만 있는 문서는 1/(60+rank) 하나, 양쪽에 있는 문서는 둘을 더해 위로 올라온다 — '두 검색기가 동의하는 문서' 가 이긴다.");

    rec.note("OpenSearch 내장 하이브리드: normalization-processor 가 두 질의의 점수를 min-max 로 0~1 에 맞춘 뒤 가중 평균한다");
    try {
      await os("PUT", "/_search/pipeline/lab-hybrid", {
        description: "BM25 + kNN min-max 정규화 후 0.5:0.5 가중 평균",
        phase_results_processors: [{ "normalization-processor": { normalization: { technique: "min_max" }, combination: { technique: "arithmetic_mean", parameters: { weights: [0.5, 0.5] } } } }],
      });
      const q = queries[0];
      const hy = await os<SearchRes>("POST", `/${index}/_search?search_pipeline=lab-hybrid`, { size: 5, query: { hybrid: { queries: [{ multi_match: { query: q, fields: ["title^2", "text"] } }, { knn: { vec: { vector: embed(q), k: 10 } } }] } }, _source: ["title", "subject"] });
      rec.steps.push({ cmd: `POST /_search?search_pipeline=lab-hybrid  hybrid{match, knn} "${q}"`, result: hy.hits.hits.map((h, i) => `${i + 1}. ${h._source.subject}/${h._source.title} (${h._score.toFixed(3)})`), ms: hy.took });
      rec.check("정규화된 점수는 0~1 사이다", hy.hits.hits.every((h) => h._score >= 0 && h._score <= 1.0001));
      rec.note("min-max 는 각 목록의 1위가 1.0 이 된다. 한쪽 목록이 '다 비슷하게 나쁜' 경우에도 1위가 1.0 이 되는 게 약점 — 그래서 RRF 를 더 많이 쓴다. 가중치(weights)는 도메인 평가 세트로 정한다.");
    } catch (e) {
      rec.note(`내장 hybrid 질의 실패 (neural-search 플러그인 필요): ${(e as Error).message.slice(0, 120)}`);
    }
    await os("DELETE", "/_search/pipeline/lab-hybrid").catch(() => {});
  },
};

// ---------------------------------------------------------------- 3. 샤드·리프레시
export const searchShardsRefresh: CodeExperiment = {
  id: "search-shards-refresh",
  subject: "opensearch",
  title: "샤드 수와 refresh_interval 이 색인·검색 지연과 '문서가 보이는 시점' 을 어떻게 바꾸는가",
  category: "운영",
  summary: "같은 문서 3,000건을 샤드 1개·3개 인덱스에 넣어 색인 시간·검색 p50 을 비교하고, refresh_interval 5s 인덱스에서 문서가 검색에 보이기까지의 지연, refresh=wait_for 와 -1(수동 리프레시) 의 차이를 측정한다",
  notes: ["02-mapping-shards-replicas", "06-operations"],
  description: `
OpenSearch 인덱스는 **샤드**(독립 Lucene 인덱스)로 나뉜다. 샤드가 많으면 쓰기와 큰 검색이 병렬화되지만, 작은 인덱스를 여러 샤드로 쪼개면 모든 검색이 샤드 수만큼 분산·병합 비용을 치른다 — 단일 노드에서는 특히 손해다.
또 하나의 핵심은 **near-real-time**: 색인한 문서는 **refresh**(기본 1초마다) 가 새 세그먼트를 열어야 검색에 보인다. \`refresh_interval\` 을 늘리면 색인 처리량이 오르지만 지연이 생기고, \`refresh=wait_for\` 는 그 리프레시를 기다려 준다.
`,
  code: `PUT /lab-shards-1 { "settings": { "number_of_shards": 1, "number_of_replicas": 0 } }
PUT /lab-shards-3 { "settings": { "number_of_shards": 3, "number_of_replicas": 0 } }
POST /_bulk ...                                     # 같은 3,000건
GET  /lab-shards-1/_search?q=text:alpha             # took 비교
PUT  /lab-refresh { "settings": { "refresh_interval": "5s" } }
POST /lab-refresh/_doc/1 { "text": "hello" }        # 바로 검색하면 0건
POST /lab-refresh/_doc/2?refresh=wait_for { ... }   # 리프레시를 기다려 돌아온다
PUT  /lab-refresh/_settings { "refresh_interval": "-1" }   # 수동 리프레시 (대량 색인 시)
POST /lab-refresh/_refresh`,
  requires: requiresOpenSearch,
  async run({ rec }) {
    const N = 3000;
    const words = ["alpha", "beta", "gamma", "delta", "redis", "kafka", "postgres", "latency", "replica", "shard"];
    const docsFor = (i: number) => ({ id: String(i), doc: { n: i, text: Array.from({ length: 30 }, (_, j) => words[(i * 7 + j * 3) % words.length]).join(" "), grp: `g${i % 10}` } });
    const results: Record<string, { indexMs: number; searchP50: number; segments: number }> = {};
    for (const shards of [1, 3]) {
      const index = `lab-shards-${shards}`;
      await os("DELETE", `/${index}`).catch(() => {});
      await os("PUT", `/${index}`, { settings: { number_of_shards: shards, number_of_replicas: 0, refresh_interval: "1s" }, mappings: { properties: { text: { type: "text" }, grp: { type: "keyword" }, n: { type: "integer" } } } });
      const t0 = performance.now();
      await rec.measure(`bulk ${N}건 → ${index} (샤드 ${shards})`, () => bulk(index, Array.from({ length: N }, (_, i) => docsFor(i))));
      const indexMs = Math.round(performance.now() - t0);
      const tooks: number[] = [];
      for (let i = 0; i < 20; i++) {
        const r = await os<SearchRes>("POST", `/${index}/_search`, { size: 10, query: { bool: { must: { match: { text: words[i % words.length] } }, filter: { term: { grp: `g${i % 10}` } } } } });
        tooks.push(r.took);
      }
      tooks.sort((a, b) => a - b);
      const seg = await os<{ indices: Record<string, { primaries: { segments: { count: number } } }> }>("GET", `/${index}/_stats/segments`);
      results[`샤드 ${shards}`] = { indexMs, searchP50: tooks[10], segments: seg.indices[index].primaries.segments.count };
    }
    rec.steps.push({ cmd: "샤드 1 vs 3 (단일 노드, 3,000건)", result: results, ms: 0 });
    rec.note(`단일 노드에서는 샤드를 늘려도 병렬 이득이 거의 없고 세그먼트·병합 오버헤드만 는다. 검색 p50: 샤드1 ${results["샤드 1"].searchP50}ms vs 샤드3 ${results["샤드 3"].searchP50}ms. 샤드 수는 '노드 수 × 코어' 와 '샤드당 10~50GB' 를 기준으로 정한다.`);

    const index = "lab-refresh";
    await os("DELETE", `/${index}`).catch(() => {});
    await os("PUT", `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: "5s" } });
    const count = async () => (await os<{ count: number }>("GET", `/${index}/_count`)).count;
    const t1 = performance.now();
    await os("POST", `/${index}/_doc/1`, { text: "hello" });
    const immediate = await count();
    rec.steps.push({ cmd: "POST /_doc/1 → 즉시 GET /_count", result: immediate, ms: 0 });
    rec.check("refresh 전에는 색인된 문서가 검색에 보이지 않는다 (0건)", immediate === 0, immediate);
    const visibleAfter = await rec.measure("문서가 검색에 보일 때까지 폴링", async () => {
      for (let i = 0; i < 80; i++) {
        if ((await count()) === 1) return `${Math.round(performance.now() - t1)}ms`;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("8초 안에 보이지 않음");
    });
    rec.check("refresh_interval 5s 안에 보인다", parseInt(visibleAfter) <= 6500, visibleAfter);
    const t2 = performance.now();
    await os("POST", `/${index}/_doc/2?refresh=wait_for`, { text: "world" });
    const wf = Math.round(performance.now() - t2);
    rec.steps.push({ cmd: "POST /_doc/2?refresh=wait_for", result: { waitedMs: wf, countAfter: await count() }, ms: wf });
    rec.check("wait_for 는 리프레시를 기다렸다가 돌아오므로 바로 보인다", (await count()) === 2);
    await os("PUT", `/${index}/_settings`, { index: { refresh_interval: "-1" } });
    await os("POST", `/${index}/_doc/3`, { text: "never" });
    await new Promise((r) => setTimeout(r, 1500));
    const noRefresh = await count();
    rec.steps.push({ cmd: "refresh_interval=-1 로 바꾸고 POST /_doc/3, 1.5초 후 _count", result: noRefresh, ms: 0 });
    rec.check("-1 이면 수동 _refresh 전까지 영원히 안 보인다", noRefresh === 2);
    await os("POST", `/${index}/_refresh`);
    rec.check("POST /_refresh 후 보인다", (await count()) === 3);
    rec.note("대량 색인(리인덱스·백필) 때는 refresh_interval=-1, replicas=0 으로 넣고 끝나면 되돌리는 것이 정석. 실시간성이 필요한 쓰기 경로만 wait_for.");
    for (const i of ["lab-shards-1", "lab-shards-3", index]) await os("DELETE", `/${i}`).catch(() => {});
  },
};
