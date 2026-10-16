import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureConnected, getRedis } from "@/lib/redis";
import type { CodeExperiment } from "./types";

/**
 * 외부 API 없이 동작하는 "가짜 임베딩": 단어를 해시해 고정 차원 벡터에 누적하고 정규화한다 (hashing trick).
 * 의미는 모르지만 같은 단어를 공유하는 문서가 가까워져, 벡터 검색의 역학(인덱스·KNN·코사인·임계값)을 실험할 수 있다.
 * 실제 서비스는 text-embedding 모델(1536차원 등)로 바꾸기만 하면 된다.
 */
export const DIM = 1024;

function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[`*#_\-\[\]().,:;!?/\\"'{}<>|=+]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  // 한국어는 조사가 붙어 "파이프라인으로" ≠ "파이프라인" 이 되므로 문자 3-gram 도 함께 쓴다 (서브워드 토크나이저의 축소판)
  const grams: string[] = [];
  for (const w of words) {
    grams.push(w, w, w); // 단어 자체에 가중치 3
    if (w.length >= 4) for (let i = 0; i + 3 <= w.length; i++) grams.push(`#${w.slice(i, i + 3)}`);
  }
  return grams;
}

export function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const tok of tokenize(text)) {
    const h = createHash("md5").update(tok).digest();
    const idx = h.readUInt16BE(0) % DIM;
    const sign = h[2] & 1 ? 1 : -1;
    v[idx] += sign;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

export function toBytes(vec: number[]): Buffer {
  const b = Buffer.alloc(vec.length * 4);
  vec.forEach((x, i) => b.writeFloatLE(x, i * 4));
  return b;
}

export function cosine(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

async function requiresSearch(): Promise<string | null> {
  try {
    const r = getRedis();
    await ensureConnected(r);
    const list = (await r.call("MODULE", "LIST")) as unknown[][];
    if (!list.some((m) => String(m[1]).toLowerCase() === "search")) return "Redis Search 모듈이 없습니다 (벡터 검색은 Redis 8 의 Search 모듈 기능). `pnpm redis:docker` 로 Docker 의 Redis 8 에 연결하세요.";
    return null;
  } catch (e) {
    return `Redis 에 연결할 수 없습니다: ${(e as Error).message}`;
  }
}

/** 모든 주제의 노트를 (제목 + 요약 + 본문 일부) 로 읽어 문서 목록을 만든다 */
async function loadDocs(): Promise<{ id: string; title: string; subject: string; text: string }[]> {
  const root = path.join(process.cwd(), "content");
  const out: { id: string; title: string; subject: string; text: string }[] = [];
  for (const subject of await fs.readdir(root)) {
    const dir = path.join(root, subject, "notes");
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      const title = /^title:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? f;
      const summary = /^summary:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? "";
      const body = raw.replace(/^---[\s\S]*?---/, "").slice(0, 1500);
      out.push({ id: `${subject}/${f.replace(/\.md$/, "")}`, title, subject, text: `${title} ${summary} ${body}` });
    }
  }
  return out;
}

export const vectorSearchRedis: CodeExperiment = {
  id: "vector-search-redis",
  subject: "ai-systems",
  title: "벡터 검색: 노트 전체를 임베딩해 Redis HNSW 인덱스로 KNN 질의",
  category: "벡터 검색",
  summary: "모든 학습 노트를 1024차원 벡터로 만들어 Redis Hash 에 넣고, FT.CREATE … VECTOR HNSW 인덱스로 '가장 비슷한 노트 5개' 를 찾는다. 하이브리드(필터 + KNN) 질의와 거리 점수 해석까지",
  notes: ["02-embeddings-vector-search", "03-rag-design"],
  description: `
벡터 검색은 "의미가 비슷한 것" 을 찾는 기술이다. 텍스트를 숫자 벡터(임베딩)로 바꾸고, 질의 벡터와 **코사인 거리**가 가까운 순으로 돌려준다.
이 실험은 외부 API 없이 **해싱 기반 가짜 임베딩**(같은 단어를 공유하면 가까워짐)을 쓴다. 실제 서비스에선 임베딩 모델 호출로 바꾸면 나머지는 동일하다.

- 인덱스: \`FT.CREATE idx ON HASH PREFIX 1 doc: SCHEMA vec VECTOR HNSW 6 TYPE FLOAT32 DIM 1024 DISTANCE_METRIC COSINE subject TAG title TEXT\`
- KNN: \`FT.SEARCH idx "*=>[KNN 5 @vec $q AS score]" PARAMS 2 q <bytes> SORTBY score DIALECT 2\`
- 하이브리드: \`"@subject:{redis} =>[KNN 3 @vec $q]"\` — 필터 후 KNN (pre-filter)

사전 준비: Redis 8 (Search 모듈) — \`pnpm redis:docker\`
`,
  code: `FT.CREATE idx:notes ON HASH PREFIX 1 doc: SCHEMA \\
  vec VECTOR HNSW 6 TYPE FLOAT32 DIM 1024 DISTANCE_METRIC COSINE \\
  subject TAG title TEXT
HSET doc:redis/06-pipelining title "파이프라인" subject redis vec "<64 float32 bytes>"
FT.SEARCH idx:notes "*=>[KNN 5 @vec $q AS score]" PARAMS 2 q "<bytes>" SORTBY score RETURN 2 title score DIALECT 2
FT.SEARCH idx:notes "@subject:{kafka} =>[KNN 3 @vec $q AS score]" PARAMS 2 q "<bytes>" SORTBY score DIALECT 2
FT.INFO idx:notes`,
  requires: requiresSearch,
  async run({ rec, k }) {
    const r = getRedis();
    const idx = k("idx");
    const prefix = k("doc:");
    const docs = await loadDocs();
    try {
      await r.call("FT.DROPINDEX", idx, "DD").catch(() => {});
      await rec.measure(`FT.CREATE ${idx} (HNSW, DIM ${DIM}, COSINE) + TAG subject + TEXT title`, () =>
        r.call("FT.CREATE", idx, "ON", "HASH", "PREFIX", "1", prefix, "SCHEMA", "vec", "VECTOR", "HNSW", "6", "TYPE", "FLOAT32", "DIM", String(DIM), "DISTANCE_METRIC", "COSINE", "subject", "TAG", "title", "TEXT"),
      );
      await rec.measure(`노트 ${docs.length}개 임베딩 + HSET (파이프라인)`, async () => {
        const p = r.pipeline();
        for (const d of docs) p.hset(`${prefix}${d.id}`, { title: d.title, subject: d.subject, vec: toBytes(embed(d.text)) });
        await p.exec();
        return docs.length;
      });
      await rec.sleep(200);
      const info = (await r.call("FT.INFO", idx)) as unknown[];
      const numDocs = Number(info[info.indexOf("num_docs") + 1]);
      rec.check(`인덱스에 ${numDocs}개 문서`, numDocs === docs.length, numDocs);

      const queries = ["파이프라인으로 RTT 를 줄여 처리량을 올린다", "컨슈머 그룹 오프셋 리밸런스 LAG", "트랜잭션 격리 수준 MVCC 스냅샷"];
      for (const q of queries) {
        const res = (await r.call("FT.SEARCH", idx, "*=>[KNN 5 @vec $q AS score]", "PARAMS", "2", "q", toBytes(embed(q)), "SORTBY", "score", "RETURN", "3", "title", "subject", "score", "DIALECT", "2")) as unknown[];
        const rows = parseSearch(res);
        rec.steps.push({ cmd: `KNN 5  질의: "${q}"`, result: rows.map((x) => `${(1 - Number(x.score)).toFixed(3)}  [${x.subject}] ${x.title}`), ms: 0 });
      }
      const top = parseSearch((await r.call("FT.SEARCH", idx, "*=>[KNN 1 @vec $q AS score]", "PARAMS", "2", "q", toBytes(embed(queries[0])), "SORTBY", "score", "RETURN", "2", "title", "score", "DIALECT", "2")) as unknown[]);
      rec.check("'파이프라인' 질의의 1위는 Redis 파이프라인 노트", /파이프라인/.test(top[0]?.title ?? ""), top[0]?.title);

      rec.note("하이브리드: subject 태그로 먼저 거르고 KNN");
      const hybrid = parseSearch((await r.call("FT.SEARCH", idx, "@subject:{kafka} =>[KNN 3 @vec $q AS score]", "PARAMS", "2", "q", toBytes(embed("메시지 순서 보장 키")), "SORTBY", "score", "RETURN", "3", "title", "subject", "score", "DIALECT", "2")) as unknown[]);
      rec.steps.push({ cmd: `@subject:{kafka} =>[KNN 3]  질의: "메시지 순서 보장 키"`, result: hybrid.map((x) => `${(1 - Number(x.score)).toFixed(3)}  [${x.subject}] ${x.title}`), ms: 0 });
      rec.check("결과는 모두 kafka 주제", hybrid.length > 0 && hybrid.every((x) => x.subject === "kafka"));
      rec.note("score 는 코사인 '거리'(0 이 같음). 유사도 = 1 - score. 실제 임베딩 모델은 의미까지 잡지만, 거리 해석과 인덱스 역학은 같다");
    } finally {
      await r.call("FT.DROPINDEX", idx, "DD").catch(() => {});
    }
  },
};

function parseSearch(res: unknown[]): Record<string, string>[] {
  // Redis 8 기본(RESP2) 형식: ["attributes",[],"format","STRING","results",[["id",key,"extra_attributes",[k,v,...]],...],...]
  if (res.includes("results")) {
    const results = res[res.indexOf("results") + 1] as unknown[][];
    return results.map((row) => {
      const attrs = row[row.indexOf("extra_attributes") + 1] as string[];
      const o: Record<string, string> = { id: String(row[1]) };
      for (let i = 0; i < attrs.length; i += 2) o[attrs[i]] = attrs[i + 1];
      return o;
    });
  }
  const out: Record<string, string>[] = [];
  for (let i = 1; i < res.length; i += 2) {
    const attrs = res[i + 1] as string[];
    const o: Record<string, string> = { id: String(res[i]) };
    for (let j = 0; j < attrs.length; j += 2) o[attrs[j]] = attrs[j + 1];
    out.push(o);
  }
  return out;
}

export const semanticCache: CodeExperiment = {
  id: "semantic-cache",
  subject: "ai-systems",
  title: "시맨틱 캐시: 비슷한 질문이면 LLM 을 다시 부르지 않는다",
  category: "비용·지연",
  summary: "질문 임베딩을 Redis 에 저장하고, 새 질문이 임계값 안에 있으면 캐시된 답을 반환. 정확 일치 캐시(해시)와 시맨틱 캐시의 적중률·지연·오탐을 비교",
  notes: ["05-prompt-cache-cost-latency", "02-embeddings-vector-search"],
  description: `
같은 뜻의 질문은 표현이 조금 달라도 같은 답이면 된다. **시맨틱 캐시**는 질문의 임베딩을 저장해 두고, 새 질문과의 코사인 유사도가 임계값(예: 0.9) 이상이면 LLM 호출 없이 캐시된 답을 돌려준다.
- 정확 일치 캐시(SHA256 키)는 글자 하나만 달라도 miss.
- 임계값이 낮으면 **오탐**(다른 질문에 엉뚱한 답) — 정확성이 중요한 도메인에선 위험. 임계값과 TTL, 무효화 전략이 설계의 핵심.
- 이 실험의 임베딩은 어휘(문자 3-gram) 기반이라 임계값을 0.6 으로 낮췄다. 실제 임베딩 모델은 의미를 반영하므로 0.9 안팎을 쓴다.
이 실험은 LLM 을 "느린 결정적 함수(300ms)" 로 흉내 낸다.
`,
  code: `# 정확 일치
GET cache:exact:<sha256(prompt)>
# 시맨틱
FT.SEARCH idx:cache "*=>[KNN 1 @vec $q AS score]" PARAMS 2 q <bytes> RETURN 2 answer score DIALECT 2
#   score < 0.1 (유사도 > 0.9) 이면 answer 반환, 아니면 LLM 호출 후
HSET cache:sem:<id> question "..." answer "..." vec <bytes>
EXPIRE cache:sem:<id> 3600`,
  requires: requiresSearch,
  async run({ rec, k }) {
    const r = getRedis();
    const idx = k("idx");
    const prefix = k("sem:");
    let llmCalls = 0;
    const fakeLlm = async (q: string) => {
      llmCalls++;
      await new Promise((res) => setTimeout(res, 300));
      return `답변(${createHash("md5").update(tokenize(q).sort().join(" ")).digest("hex").slice(0, 6)})`;
    };
    try {
      await r.call("FT.DROPINDEX", idx, "DD").catch(() => {});
      await r.call("FT.CREATE", idx, "ON", "HASH", "PREFIX", "1", prefix, "SCHEMA", "vec", "VECTOR", "FLAT", "6", "TYPE", "FLOAT32", "DIM", String(DIM), "DISTANCE_METRIC", "COSINE", "question", "TEXT");
      const THRESHOLD = 0.6; // 가짜(어휘 기반) 임베딩이라 낮게. 실제 임베딩 모델이면 0.9 안팎
      let hits = 0;
      const ask = async (q: string) => {
        const t0 = performance.now();
        const exactKey = `${k("exact")}:${createHash("sha256").update(q).digest("hex")}`;
        const exact = await r.get(exactKey);
        if (exact) {
          hits++;
          return { source: "exact-hit", answer: exact, ms: Math.round(performance.now() - t0) };
        }
        const res = (await r.call("FT.SEARCH", idx, "*=>[KNN 1 @vec $q AS score]", "PARAMS", "2", "q", toBytes(embed(q)), "RETURN", "3", "question", "answer", "score", "DIALECT", "2")) as unknown[];
        const rows = parseSearch(res);
        const best = rows[0];
        const sim = best ? 1 - Number(best.score) : 0;
        if (best && sim >= THRESHOLD) {
          hits++;
          return { source: `semantic-hit (유사도 ${sim.toFixed(3)}, 원질문 "${best.question}")`, answer: best.answer, ms: Math.round(performance.now() - t0) };
        }
        const answer = await fakeLlm(q);
        await r.set(exactKey, answer, "EX", 3600);
        await r.hset(`${prefix}${createHash("md5").update(q).digest("hex")}`, { question: q, answer, vec: toBytes(embed(q)) });
        await r.expire(`${prefix}${createHash("md5").update(q).digest("hex")}`, 3600);
        return { source: `miss → LLM (best 유사도 ${sim.toFixed(3)})`, answer, ms: Math.round(performance.now() - t0) };
      };
      const questions = [
        "Redis 파이프라인은 왜 빠른가요",
        "Redis 파이프라인은 왜 빠른가요",
        "Redis 의 파이프라인이 빠른 이유는 왜 인가요",
        "왜 Redis 파이프라인은 빠른가요?",
        "Kafka 컨슈머 그룹의 리밸런스는 언제 일어나나요",
        "PostgreSQL 데드락은 어떻게 감지되나요",
        "Kafka 컨슈머 그룹 리밸런스는 언제 발생하나요",
      ];
      await rec.sleep(100);
      for (const q of questions) {
        const a = await ask(q);
        rec.steps.push({ cmd: `ask("${q}")`, result: `${a.source} · ${a.ms}ms · ${a.answer}`, ms: a.ms });
        await rec.sleep(60);
      }
      rec.check(`질문 ${questions.length}개 중 LLM 호출 ${llmCalls}회, 캐시 적중 ${hits}회 (호출 ${Math.round((1 - llmCalls / questions.length) * 100)}% 절감)`, llmCalls <= 4 && hits >= 3, { llmCalls, hits });
      rec.note("2번째는 정확 일치. 4번째(어순만 바뀜)와 7번째(조사·어미 변화)는 시맨틱 적중. 3번째는 어휘 차이가 커서 이 가짜 임베딩으로는 miss — 실제 임베딩 모델은 의미를 보므로 적중한다.");
      rec.note("실제 임베딩 모델에선 '파이프라인은 왜 느린가요' 도 0.9 근처가 될 수 있다 — 임계값을 높이거나, 답이 질문에 민감한 도메인(수치·고유명사)에선 시맨틱 캐시를 쓰지 않는다");
    } finally {
      await r.call("FT.DROPINDEX", idx, "DD").catch(() => {});
      let cursor = "0";
      do {
        const [next, keys] = await r.scan(cursor, "MATCH", `${k("exact")}:*`, "COUNT", 200);
        cursor = next;
        if (keys.length) await r.del(...keys);
      } while (cursor !== "0");
    }
  },
};

export const ragMini: CodeExperiment = {
  id: "rag-mini",
  subject: "ai-systems",
  title: "미니 RAG: 청킹 → 인덱싱 → 검색 → 프롬프트 조립",
  category: "RAG",
  summary: "노트를 문단 단위로 청킹해 벡터 인덱스에 넣고, 질문에 대해 top-k 청크를 찾아 근거가 포함된 프롬프트를 만든다. 청크 크기·k·중복 제거가 결과에 미치는 영향",
  notes: ["03-rag-design", "02-embeddings-vector-search"],
  description: `
RAG(Retrieval-Augmented Generation)는 LLM 에게 **근거 문서를 함께 보여주는** 기법이다. 핵심은 LLM 이 아니라 **검색 품질**이다.
1. 청킹: 문서를 검색 단위로 자른다 (문단/제목 기준, 200~500 토큰, 약간의 겹침)
2. 인덱싱: 청크 임베딩 + 메타데이터(출처, 제목)
3. 검색: 질문 임베딩으로 top-k, 필요하면 키워드 검색과 섞기(hybrid) 와 재정렬(rerank)
4. 조립: 시스템 프롬프트 + 근거 청크(출처 표시) + 질문 → LLM
5. 생성·인용: 답에 출처를 붙이고, 근거에 없으면 "모른다" 고 하게

이 실험은 LLM 호출 없이 4단계까지 수행하고 완성된 프롬프트를 보여준다. (ANTHROPIC_API_KEY 가 있어도 비용을 쓰지 않도록 호출하지 않는다)
`,
  code: `# 1. 청킹: 노트를 '## 제목' 단위로 분할, 300자 초과 시 추가 분할
# 2. 인덱싱
FT.CREATE idx:chunks ON HASH PREFIX 1 chunk: SCHEMA vec VECTOR HNSW 6 TYPE FLOAT32 DIM 1024 DISTANCE_METRIC COSINE doc TAG heading TEXT
HSET chunk:<n> doc "redis/08-caching-patterns" heading "Cache Stampede" text "..." vec <bytes>
# 3. 검색 (top-k, 같은 문서에서 최대 2개)
FT.SEARCH idx:chunks "*=>[KNN 8 @vec $q AS score]" PARAMS 2 q <bytes> RETURN 3 doc heading text SORTBY score DIALECT 2
# 4. 프롬프트
system: "아래 근거만 사용해 답하고 [출처] 를 붙여라. 근거에 없으면 모른다고 답하라."
user:   "<근거 1..k>\\n\\n질문: ..."`,
  requires: requiresSearch,
  async run({ rec, k }) {
    const r = getRedis();
    const idx = k("idx");
    const prefix = k("chunk:");
    const docs = await loadDocs();
    const chunks: { doc: string; heading: string; text: string }[] = [];
    for (const d of docs) {
      const [subject, slug] = d.id.split("/");
      const raw = await fs.readFile(path.join(process.cwd(), "content", subject, "notes", `${slug}.md`), "utf8").then((s) => s.replace(/^---[\s\S]*?---/, ""));
      const sections = raw.split(/\n(?=## )/);
      for (const sec of sections) {
        const heading = /^## (.+)/.exec(sec)?.[1] ?? d.title;
        const body = sec.replace(/^## .+\n/, "").trim();
        if (body.length < 40) continue;
        for (let i = 0; i < body.length; i += 450) chunks.push({ doc: d.id, heading, text: body.slice(Math.max(0, i - 50), i + 450) });
      }
    }
    try {
      await r.call("FT.DROPINDEX", idx, "DD").catch(() => {});
      await r.call("FT.CREATE", idx, "ON", "HASH", "PREFIX", "1", prefix, "SCHEMA", "vec", "VECTOR", "HNSW", "6", "TYPE", "FLOAT32", "DIM", String(DIM), "DISTANCE_METRIC", "COSINE", "doc", "TAG", "heading", "TEXT");
      await rec.measure(`청킹: 노트 ${docs.length}개 → 청크 ${chunks.length}개 (## 섹션 단위, 450자, 50자 겹침)`, async () => {
        const p = r.pipeline();
        chunks.forEach((c, i) => p.hset(`${prefix}${i}`, { doc: c.doc, heading: c.heading, text: c.text, vec: toBytes(embed(`${c.heading} ${c.text}`)) }));
        await p.exec();
        return chunks.length;
      });
      await rec.sleep(300);
      const question = "캐시가 동시에 만료되어 DB 로 요청이 몰리는 문제를 어떻게 막나요?";
      const res = (await r.call("FT.SEARCH", idx, "*=>[KNN 8 @vec $q AS score]", "PARAMS", "2", "q", toBytes(embed(question)), "RETURN", "4", "doc", "heading", "text", "score", "SORTBY", "score", "DIALECT", "2")) as unknown[];
      const rows = parseSearch(res);
      rec.steps.push({ cmd: `검색 top-8  질문: "${question}"`, result: rows.map((x) => `${(1 - Number(x.score)).toFixed(3)}  ${x.doc} › ${x.heading}`), ms: 0 });
      // 같은 문서 최대 2개, 상위 4개
      const perDoc: Record<string, number> = {};
      const picked = rows.filter((x) => (perDoc[x.doc] = (perDoc[x.doc] ?? 0) + 1) <= 2).slice(0, 4);
      rec.check("근거에 캐싱 패턴(stampede) 노트가 포함됨", picked.some((x) => /caching|cache|stampede/i.test(`${x.doc} ${x.heading}`)), picked.map((x) => `${x.doc} › ${x.heading}`));
      const context = picked.map((x, i) => `[${i + 1}] (${x.doc} › ${x.heading})\n${x.text.replace(/\s+/g, " ").slice(0, 300)}…`).join("\n\n");
      const prompt = `system: 아래 근거만 사용해 한국어로 답하라. 문장 끝에 [번호] 로 출처를 표시하라. 근거에 없으면 "근거 없음" 이라고 답하라.\n\nuser:\n${context}\n\n질문: ${question}`;
      rec.steps.push({ cmd: "조립된 프롬프트 (LLM 에 보낼 내용)", result: prompt, ms: 0 });
      rec.note(`프롬프트 길이 ${prompt.length}자 ≈ ${Math.round(prompt.length / 2.5)} 토큰. 청크 수·길이가 곧 비용과 지연이다.`);
      rec.note("개선 여지: (1) 실제 임베딩 모델 (2) BM25 키워드 검색과 RRF 로 합치기 (3) cross-encoder 재정렬 (4) 질문 재작성(HyDE) (5) 답변의 근거성 평가");
    } finally {
      await r.call("FT.DROPINDEX", idx, "DD").catch(() => {});
    }
  },
};
