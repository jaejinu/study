// 사용: pnpm search:eval   (먼저 pnpm search:up · pnpm search:index)
// 검색 방법 4가지(키워드 · BM25 · 벡터 · 하이브리드)를 같은 질의로 비교하고 reports/search-eval.json 에 남긴다.
//  - quiz: 퀴즈 카드 질문 100개(시드 고정 무작위) → 정답 = 그 카드의 노트
//  - paraphrase: 노트 어휘를 일부러 피한 일상 표현 질문 → 정답 = 손으로 고른 노트(들)
// 지표: recall@1, recall@5, MRR@10(노트 단위), 지연 p50/p95
import fs from "node:fs/promises";
import path from "node:path";
import { subjects } from "../src/lib/subjects";
import { listNotes } from "../src/lib/notes";
import { loadQuiz } from "../src/lib/quiz";
import { searchSmart } from "../src/lib/search";
import { bm25Chunks, embedQuery, indexMeta, knnChunks, semanticSearch, type ChunkHit } from "../src/lib/semantic/search";
import { groupByNote, rrfFuse } from "../src/lib/semantic/rrf";

const PARAPHRASE: { q: string; rel: string[] }[] = [
  { q: "캐시 서버가 재시작되면 데이터가 다 날아가나?", rel: ["redis/04-persistence"] },
  { q: "여러 서버가 같은 작업을 동시에 못 하게 막으려면", rel: ["redis/09-distributed-lock"] },
  { q: "API 호출 횟수를 사용자별로 제한하고 싶다", rel: ["redis/10-rate-limiting", "api-design/06-gateway-auth-ratelimit"] },
  { q: "인기 상품 캐시가 한꺼번에 만료돼서 DB 가 터졌다", rel: ["redis/08-caching-patterns", "architecture/10-cache-layers-cdn"] },
  { q: "메시지를 정확히 한 번만 처리하는 게 가능한가", rel: ["kafka/04-delivery-guarantees", "messaging/04-delivery-guarantees-delay", "data-engineering/05-stream-processing"] },
  { q: "소비자를 늘렸는데 처리량이 안 늘어난다", rel: ["kafka/03-consumer-groups", "kafka/02-topics-partitions"] },
  { q: "DB 변경을 다른 서비스로 안전하게 흘려보내는 법", rel: ["kafka/08-cdc-outbox-debezium"] },
  { q: "쿼리가 느린데 인덱스를 타는지 어떻게 확인해?", rel: ["postgres/02-indexes-explain", "postgres/07-query-optimization-deep"] },
  { q: "두 트랜잭션이 서로를 기다리며 멈췄다", rel: ["postgres/04-locks-deadlocks", "concurrency/06-deadlock-livelock-starvation"] },
  { q: "같은 행을 동시에 읽고 쓰면 어떤 값이 보이나", rel: ["postgres/03-mvcc-isolation", "db-internals/06-mvcc-gc-comparison"] },
  { q: "파드가 계속 재시작되는 원인 찾기", rel: ["kubernetes/08-ops-debugging"] },
  { q: "트래픽에 따라 서버 대수를 자동으로 늘리고 줄이기", rel: ["kubernetes/14-scheduling-autoscaling-deep", "kubernetes/07-deploy-resources"] },
  { q: "새 버전을 일부 사용자에게만 먼저 내보내기", rel: ["kubernetes/13-gitops-progressive-delivery", "sre/06-capacity-release-change", "service-mesh/06-canary-traffic-split"] },
  { q: "에러 예산을 얼마나 빨리 쓰는지로 알림 보내기", rel: ["sre/03-burn-rate-alerting", "observability/11-slo-dashboard-burn-rate"] },
  { q: "장애가 끝난 뒤 누구 탓 하지 않고 원인 정리하기", rel: ["sre/05-incident-postmortem"] },
  { q: "요청 하나가 여러 서비스를 거치는 경로를 보고 싶다", rel: ["observability/06-tracing-otel"] },
  { q: "서버 시계가 서로 달라서 이벤트 순서가 꼬인다", rel: ["distributed-systems/02-time-and-order"] },
  { q: "노드 과반이 동의해야 값이 확정되는 방식", rel: ["distributed-systems/05-consensus"] },
  { q: "다른 서비스가 죽어도 우리 서비스는 버티게 하려면", rel: ["architecture/04-resilience", "chaos/03-resilience-patterns-verified"] },
  { q: "컨테이너는 결국 리눅스에서 무엇인가", rel: ["os-internals/07-containers-are-processes"] },
  { q: "메모리가 남는데 같은 파일 읽기가 두 번째엔 왜 빠르지", rel: ["os-internals/02-virtual-memory-page-cache"] },
  { q: "보안 연결을 맺는 데 왕복이 몇 번 필요한가", rel: ["network-protocols/03-tls13-handshake"] },
  { q: "패킷이 조금만 유실돼도 처리량이 크게 떨어지는 이유", rel: ["network-protocols/04-congestion-control", "network-protocols/05-loss-latency-throughput"] },
  { q: "돈이 오간 기록을 절대 틀리지 않게 남기기", rel: ["architecture/09-payments-ledger-consistency"] },
  { q: "고객사마다 데이터를 나눠서 한 시스템으로 서비스하기", rel: ["architecture/08-multitenancy-saas"] },
];
const NONSENSE = ["오늘 점심 메뉴 추천해줘", "ㅁㄴㅇㄹ ㅋㅋㅋ", "고양이 사료 브랜드 비교", "축구 경기 결과 알려줘", "주말 등산 코스"];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noteKey = (href: string) => /^\/([a-z0-9-]+)\/notes\/([a-z0-9-]+)/.exec(href)?.slice(1, 3).join("/") ?? href;

type Variant = { name: string; k: number; weights: [number, number]; minVec: number; bonus: number; msm: boolean };
function fuse(bmAll: ChunkHit[], bmMsm: ChunkHit[], kn: ChunkHit[], v: Variant): string[] {
  const bm = v.msm ? bmMsm : bmAll;
  const bmIds = new Set(bm.map((h) => h.id));
  const knn = kn.filter((h) => bmIds.has(h.id) || h.score >= v.minVec);
  const fused = rrfFuse([bm.map((h) => h.id), knn.map((h) => h.id)], v.k, v.weights);
  return groupByNote(fused, 10, v.bonus).map((g) => g.noteKey);
}
const group = (hits: ChunkHit[]) => groupByNote(hits, 10).map((g) => g.noteKey);

function rankOf(list: string[], rel: string[]) {
  const i = list.findIndex((k) => rel.includes(k));
  return i < 0 ? null : i + 1;
}
function summarize(ranks: (number | null)[], lat: number[]) {
  const n = ranks.length;
  const s = [...lat].sort((a, b) => a - b);
  const pct = (p: number) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null);
  return {
    n,
    recall1: +(ranks.filter((r) => r === 1).length / n).toFixed(3),
    recall5: +(ranks.filter((r) => r !== null && r <= 5).length / n).toFixed(3),
    mrr: +(ranks.reduce<number>((a, r) => a + (r ? 1 / r : 0), 0) / n).toFixed(3),
    p50ms: pct(0.5),
    p95ms: pct(0.95),
  };
}

/** BM25 에서 질의어의 일정 비율 이상이 맞아야 후보로 (대화체 질의의 일반 동사 잡음 줄이기) */
const MSM = "2<60%";
/** src/lib/semantic/search.ts 의 현재 기본값과 같은 조합 */
const CURRENT = `k=10 w=1/1 minVec=0.76 bonus=0.3 msm=${MSM}`;
const meta = await indexMeta();
if (!meta) throw new Error("study-notes-v1 인덱스가 없습니다: pnpm search:index");

// 퀴즈 카드 100개 (노트가 실제로 있는 카드만, 시드 42)
const pool: { q: string; rel: string[] }[] = [];
for (const s of subjects) {
  const slugs = new Set((await listNotes(s.id)).map((n) => n.slug));
  for (const c of await loadQuiz(s.id)) if (slugs.has(c.note)) pool.push({ q: c.q, rel: [`${s.id}/${c.note}`] });
}
const rnd = mulberry32(42);
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const sets = { quiz: pool.slice(0, 100), paraphrase: PARAPHRASE };

// 워밍업 (모델 로드·캐시)
await embedQuery(meta.model, "워밍업", { timeoutMs: 30_000 });
await searchSmart("워밍업", 10);

const variants: Variant[] = [];
for (const k of [5, 10, 30, 60])
  for (const weights of [[1, 1], [1, 1.5], [1, 2], [1, 3], [1.5, 1]] as [number, number][])
    for (const minVec of [0, 0.76])
      for (const bonus of [0, 0.3])
        for (const msm of [false, true]) variants.push({ name: `k=${k} w=${weights.join("/")} minVec=${minVec} bonus=${bonus} msm=${msm ? MSM : "-"}`, k, weights, minVec, bonus, msm });

const report: Record<string, unknown> = { date: new Date().toISOString(), model: meta.model, dim: meta.dim, analyzer: meta.analyzer, sets: {} };
const varScores = new Map<string, number[]>();
const topVecScores: number[] = [];

for (const [name, qs] of Object.entries(sets)) {
  const r = { keyword: [] as (number | null)[], bm25: [] as (number | null)[], vector: [] as (number | null)[], hybrid: [] as (number | null)[] };
  const lat = { keyword: [] as number[], bm25: [] as number[], vector: [] as number[], hybrid: [] as number[] };
  const vr = new Map<string, (number | null)[]>();
  const misses: { q: string; rel: string[]; hybridTop3: string[] }[] = [];
  for (const { q, rel } of qs) {
    let t = performance.now();
    const kw = (await searchSmart(q, 10)).filter((h) => h.kind === "note").map((h) => noteKey(h.href));
    lat.keyword.push(performance.now() - t);
    t = performance.now();
    const bm = await bm25Chunks(q, { size: 50 });
    lat.bm25.push(performance.now() - t);
    const bmMsm = await bm25Chunks(q, { size: 50, minimumShouldMatch: MSM });
    t = performance.now();
    const v = await embedQuery(meta.model, q, { timeoutMs: 10_000 });
    const kn = await knnChunks(v, { size: 50 });
    lat.vector.push(performance.now() - t);
    topVecScores.push(kn[0]?.score ?? 0);
    t = performance.now();
    const hy = await semanticSearch(q, { limit: 10, timeoutMs: 10_000 });
    lat.hybrid.push(performance.now() - t);
    const hyKeys = (hy?.hits ?? []).map((h) => `${h.subject}/${h.slug}`);
    r.keyword.push(rankOf(kw, rel));
    r.bm25.push(rankOf(group(bm), rel));
    r.vector.push(rankOf(group(kn), rel));
    r.hybrid.push(rankOf(hyKeys, rel));
    if (rankOf(hyKeys, rel) !== 1) misses.push({ q, rel, hybridTop3: hyKeys.slice(0, 3) });
    for (const va of variants) {
      const arr = vr.get(va.name) ?? [];
      arr.push(rankOf(fuse(bm, bmMsm, kn, va), rel));
      vr.set(va.name, arr);
    }
  }
  const methods = Object.fromEntries(Object.keys(r).map((m) => [m, summarize(r[m as keyof typeof r], lat[m as keyof typeof lat])]));
  for (const [vn, ranks] of vr) varScores.set(vn, [...(varScores.get(vn) ?? []), summarize(ranks, []).mrr]);
  (report.sets as Record<string, unknown>)[name] = { methods, misses: misses.slice(0, 15) };
  console.log(`\n[${name}] n=${qs.length}`);
  console.table(methods);
}

// 튜닝 그리드: 두 세트 MRR 평균
const ranked = [...varScores.entries()].map(([name, [a, b]]) => ({ name, quizMRR: a, paraMRR: b, avg: +((a + b) / 2).toFixed(3) })).sort((x, y) => y.avg - x.avg);
report.tuning = { top: ranked.slice(0, 8), current: ranked.find((x) => x.name === CURRENT) };
console.log("\n[튜닝 그리드 상위 8 (quiz·paraphrase MRR 평균)]");
console.table(ranked.slice(0, 8).map((x) => ({ ...x })));
console.log("현재 기본값:", report.tuning);

// 벡터 유사도 보정: 진짜 질문 vs 엉뚱한 질문의 kNN 1위 점수
const nonsense: { q: string; top: number }[] = [];
for (const q of NONSENSE) {
  const kn = await knnChunks(await embedQuery(meta.model, q, { timeoutMs: 10_000 }), { size: 5 });
  nonsense.push({ q, top: +(kn[0]?.score ?? 0).toFixed(3) });
}
const sv = [...topVecScores].sort((a, b) => a - b);
report.vectorCalibration = { realTop1: { min: +sv[0].toFixed(3), p10: +sv[Math.floor(sv.length * 0.1)].toFixed(3), median: +sv[Math.floor(sv.length / 2)].toFixed(3) }, nonsense };
console.log("\n[벡터 점수 보정]", JSON.stringify(report.vectorCalibration));

await fs.mkdir("reports", { recursive: true });
await fs.writeFile(path.join("reports", "search-eval.json"), JSON.stringify(report, null, 2));
console.log("\n→ reports/search-eval.json");
process.exit(0);
