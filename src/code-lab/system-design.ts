import { createHash } from "node:crypto";
import type Redis from "ioredis";
import { Pool } from "pg";
import { createRedis, ensureConnected, getRedis } from "@/lib/redis";
import { listNotes } from "@/lib/notes";
import { subjects } from "@/lib/subjects";
import { PG_URL } from "./postgres";
import type { CodeExperiment } from "./types";

/**
 * 시스템 디자인 사례의 "핵심 부품" 을 작게 재현해 숫자로 확인한다.
 * 설계 면접에서 말로만 하던 트레이드오프(카운터 vs 해시, fan-out on write vs read, 트라이 vs 사전순 인덱스)를 잰다.
 */

async function requiresRedis(): Promise<string | null> {
  try {
    await ensureConnected(getRedis());
    return null;
  } catch {
    return "Redis(6379)에 연결할 수 없습니다. `pnpm redis:docker` 를 실행하세요.";
  }
}

const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function base62(n: bigint): string {
  if (n === BigInt(0)) return "0";
  let s = "";
  while (n > BigInt(0)) {
    s = B62[Number(n % BigInt(62))] + s;
    n /= BigInt(62);
  }
  return s;
}
function pct(xs: number[], p: number): number {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}
/** 시드 고정 난수 (재현 가능) */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
async function delPrefix(r: Redis, prefix: string) {
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 1000);
    cursor = next;
    if (keys.length) await r.unlink(...keys);
  } while (cursor !== "0");
}

// ---------------------------------------------------------------- 1. URL 단축기
export const sdUrlShortener: CodeExperiment = {
  id: "sd-url-shortener",
  subject: "system-design",
  title: "URL 단축기: 카운터 vs 해시로 짧은 코드를 만들고, 리다이렉트를 Redis 캐시로 받으면 얼마나 빨라지나",
  category: "사례",
  summary: "URL 5만 개에 대해 Redis INCR 카운터 + base62(충돌 0, 길이 3자, 순서가 드러남)와 SHA-256 앞 n 자(4·5·6자에서 실제 충돌 수 vs 생일 문제 기대값)를 비교한다. 리다이렉트는 PostgreSQL 인덱스 조회와 Redis GET 의 p50·p99 를 재고, 지프 분포 트래픽에서 캐시 크기별 적중률을 계산한다",
  notes: ["02-url-shortener", "01-design-method"],
  description: `
URL 단축기의 핵심 결정은 둘이다. **코드를 어떻게 만드나**(충돌·길이·예측 가능성)와 **읽기를 어떻게 빠르게 하나**(쓰기 1 : 읽기 100 이상).
카운터는 충돌이 없고 짧지만 다음 코드를 예측할 수 있고 카운터가 단일 지점이 된다. 해시는 분산에 강하지만 짧게 자르면 **생일 문제**로 충돌한다. 기대 충돌 수 ≈ n²/(2·62^L).
읽기는 인기 링크에 몰린다(지프 분포). 작은 캐시로도 적중률이 높게 나오는 이유를 숫자로 본다.
`,
  code: `// 카운터 방식
const id = await redis.incr("url:seq");          // 1, 2, 3 …
const code = base62(BigInt(id) + 238328n);        // 3자부터 시작
// 해시 방식
const code = base62(BigInt("0x" + sha256(url).slice(0, 16))).slice(0, 6);
// 기대 충돌 ≈ n² / (2 · 62^L)  → n=50,000, L=4 이면 약 85개
// 리다이렉트
GET url:<code>  → 없으면 select long from urls where code = $1 → SET url:<code> EX 3600`,
  requires: async () => (await requiresRedis()) ?? (await new Pool({ connectionString: PG_URL, max: 1, connectionTimeoutMillis: 3000 }).query("select 1").then(() => null).catch(() => "PostgreSQL(15432)이 필요합니다 — `pnpm pg:up`.")),
  async run({ rec, k }) {
    const r = getRedis();
    await ensureConnected(r);
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const N = 50_000;
    const urls = Array.from({ length: N }, (_, i) => `https://example.com/articles/${i}?ref=lab&q=${(i * 7919) % 100_003}`);
    const seq = k("seq"), cachePrefix = k("url:"), table = k("urls");
    try {
      await r.del(seq);
      const t0 = performance.now();
      const pipe = r.pipeline();
      for (let i = 0; i < N; i++) pipe.incr(seq);
      const ids = (await pipe.exec())!.map(([, v]) => Number(v));
      const counterCodes = ids.map((id) => base62(BigInt(id) + BigInt(238328))); // 62^3 부터 → 최소 4자
      const ctrMs = Math.round(performance.now() - t0);
      const lens = new Map<number, number>();
      for (const c of counterCodes) lens.set(c.length, (lens.get(c.length) ?? 0) + 1);
      rec.steps.push({ cmd: `카운터: INCR ×${N.toLocaleString()} (파이프라인) → base62`, result: `${ctrMs}ms · 고유 ${new Set(counterCodes).size.toLocaleString()} · 길이 분포 ${JSON.stringify(Object.fromEntries(lens))} · 연속 코드 예: ${counterCodes.slice(0, 3).join(", ")}`, ms: ctrMs });
      rec.check("카운터는 충돌이 0 이다", new Set(counterCodes).size === N);

      const rows: string[][] = [];
      for (const L of [4, 5, 6]) {
        const codes = urls.map((u) => base62(BigInt("0x" + createHash("sha256").update(u).digest("hex").slice(0, 16))).padStart(11, "0").slice(-L));
        const collisions = N - new Set(codes).size;
        const expected = (N * N) / (2 * Math.pow(62, L));
        rows.push([`SHA-256 → base62 ${L}자`, collisions.toLocaleString(), expected.toFixed(1), (Math.pow(62, L) / 1e6).toFixed(1) + "M"]);
      }
      rec.steps.push({ cmd: "해시 방식: 코드 길이별 실제 충돌 vs 생일 문제 기대값 (n=50,000)", result: rows.map((x) => `${x[0]}: 충돌 ${x[1]} (기대 ${x[2]}, 공간 ${x[3]})`), ms: 0 });
      const c4 = Number(rows[0][1].replace(/,/g, ""));
      rec.check("4자 해시는 수십 건 충돌한다 → 충돌 시 재시도·길이 늘리기 필요", c4 > 20 && c4 < 200, c4);

      await pool.query(`drop table if exists ${table}`);
      await pool.query(`create table ${table} (code text primary key, long_url text not null)`);
      await pool.query(`insert into ${table} select * from unnest($1::text[], $2::text[])`, [counterCodes, urls]);
      const hot = counterCodes.slice(0, 2000);
      const mset = r.pipeline();
      for (let i = 0; i < hot.length; i++) mset.set(cachePrefix + hot[i], urls[i], "EX", 300);
      await mset.exec();
      const timeIt = async (fn: (c: string) => Promise<unknown>) => {
        const lat: number[] = [];
        for (const c of hot) {
          const t = performance.now();
          await fn(c);
          lat.push(performance.now() - t);
        }
        return { p50: pct(lat, 50), p99: pct(lat, 99) };
      };
      await timeIt((c) => pool.query(`select long_url from ${table} where code = $1`, [c]));
      const db = await timeIt((c) => pool.query(`select long_url from ${table} where code = $1`, [c]));
      const cache = await timeIt((c) => r.get(cachePrefix + c));
      rec.steps.push({ cmd: "리다이렉트 조회 2,000회 (순차)", result: [`PostgreSQL 기본 키 조회: p50 ${db.p50.toFixed(3)}ms · p99 ${db.p99.toFixed(3)}ms`, `Redis GET: p50 ${cache.p50.toFixed(3)}ms · p99 ${cache.p99.toFixed(3)}ms`], ms: 0 });
      // 로컬 단독 실행에선 둘 다 왕복 지연이 지배해 차이가 작고 부하에 따라 뒤집힐 수 있다 → 단언하지 않고 기록만 한다
      rec.note(`캐시 경로 p50 ${cache.p50.toFixed(3)}ms vs DB ${db.p50.toFixed(3)}ms — 로컬 단독 실행에선 차이가 작다. 캐시의 진짜 가치는 동시 부하에서 DB 연결·CPU 를 보호하는 것.`);

      const rand = rng(42);
      const zipfIndex = (s: number) => {
        // 근사 지프: 역변환 (거듭제곱 분포)
        const u = rand();
        return Math.min(N - 1, Math.floor(Math.pow(N, Math.pow(u, s)) - 1));
      };
      const reqs = Array.from({ length: 200_000 }, () => zipfIndex(1));
      const hits: string[][] = [];
      for (const size of [500, 2500, 5000, 25000]) {
        const lru = new Map<number, true>();
        let hit = 0;
        for (const i of reqs) {
          if (lru.has(i)) {
            hit++;
            lru.delete(i);
          } else if (lru.size >= size) lru.delete(lru.keys().next().value!);
          lru.set(i, true);
        }
        hits.push([`${size.toLocaleString()} (${((size / N) * 100).toFixed(0)}%)`, `${((hit / reqs.length) * 100).toFixed(1)}%`]);
      }
      rec.steps.push({ cmd: "지프 분포 트래픽 20만 요청 — LRU 캐시 크기(전체 링크 대비)별 적중률", result: hits.map(([a, b]) => `캐시 ${a}: 적중 ${b}`), ms: 0 });
      rec.check("링크의 10% 만 캐시해도 적중률이 50% 를 넘는다 (인기 쏠림)", parseFloat(hits[2][1]) > 50, hits[2]);
    } finally {
      await r.del(seq);
      await delPrefix(r, cachePrefix);
      await pool.query(`drop table if exists ${table}`).catch(() => {});
      await pool.end();
    }
  },
};

// ---------------------------------------------------------------- 2. 뉴스피드 fan-out
export const sdFeedFanout: CodeExperiment = {
  id: "sd-feed-fanout",
  subject: "system-design",
  title: "뉴스피드: fan-out on write vs on read vs 하이브리드 — 셀럽이 있는 멱법칙 그래프에서 쓰기·읽기 비용을 잰다",
  category: "사례",
  summary: "사용자 1만 명, 팔로워 수가 멱법칙인 합성 그래프(셀럽 몇 명이 수천 팔로워)에서 게시물 2,000개를 올린다. 쓰기 시 팬아웃은 팔로워 타임라인(Redis LIST)에 푸시, 읽기 시 팬아웃은 팔로이들의 최근 글을 모아 병합, 하이브리드는 셀럽만 읽기 시 병합한다. 쓰기 횟수·최악 게시 비용·타임라인 읽기 명령 수·p50/p99 를 표로 비교한다",
  notes: ["04-news-feed", "01-design-method"],
  description: `
타임라인을 **언제 만들까**가 뉴스피드 설계의 전부다.
- **쓰기 시(push)**: 글을 쓰면 모든 팔로워의 타임라인에 넣는다. 읽기는 LRANGE 한 번으로 빠르지만, 팔로워 100만인 셀럽 글 하나가 100만 쓰기다.
- **읽기 시(pull)**: 읽을 때 팔로우하는 사람들의 최근 글을 모아 병합한다. 쓰기는 싸지만 읽기가 팔로이 수만큼 비싸다.
- **하이브리드**: 일반 사용자는 push, 셀럽은 pull. 팔로워 수 임계값이 설계 변수다.
`,
  code: `// push: 게시 시
for (const f of followers(author)) { LPUSH tl:<f> postId; LTRIM tl:<f> 0 199 }
// pull: 조회 시
for (const a of followees(user)) LRANGE posts:<a> 0 9   → 시간순 병합 → 상위 50
// 하이브리드: followers(author) > THRESHOLD 이면 push 하지 않고, 조회 때 셀럽 글만 pull 해서 병합`,
  requires: requiresRedis,
  async run({ rec, k }) {
    const r = createRedis();
    await ensureConnected(r);
    const P = k("");
    const U = 10_000, FOLLOWS = 20, POSTS = 2_000, CELEB_T = 1_000;
    try {
      const rand = rng(7);
      // 선호적 연결: 인기 있는 사람이 더 팔로우된다 (멱법칙)
      const weight = Array.from({ length: U }, (_, i) => 1 / Math.pow(i + 1, 1.1));
      const cum: number[] = [];
      weight.reduce((a, w, i) => ((cum[i] = a + w), a + w), 0);
      const total = cum[U - 1];
      const pick = () => {
        const x = rand() * total;
        let lo = 0, hi = U - 1;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (cum[m] < x) lo = m + 1;
          else hi = m;
        }
        return lo;
      };
      const followees: number[][] = Array.from({ length: U }, () => []);
      const followers: number[][] = Array.from({ length: U }, () => []);
      for (let u = 0; u < U; u++) {
        const set = new Set<number>();
        while (set.size < FOLLOWS) {
          const v = pick();
          if (v !== u) set.add(v);
        }
        for (const v of set) {
          followees[u].push(v);
          followers[v].push(u);
        }
      }
      const fc = followers.map((f) => f.length).sort((a, b) => b - a);
      const celebs = new Set(followers.map((f, i) => [f.length, i]).filter(([n]) => n > CELEB_T).map(([, i]) => i));
      rec.steps.push({ cmd: `그래프: 사용자 ${U.toLocaleString()} · 1인당 팔로우 ${FOLLOWS} · 간선 ${(U * FOLLOWS).toLocaleString()}`, result: `팔로워 수 상위 5: ${fc.slice(0, 5).join(", ")} · 중앙값 ${fc[U >> 1]} · 셀럽(>${CELEB_T}) ${celebs.size}명`, ms: 0 });

      const authors = Array.from({ length: POSTS }, () => (rand() < 0.2 ? pick() : Math.floor(rand() * U)));
      // 작성자별 글 목록 (pull 용) — 모든 방식이 공통으로 가진다
      const pp = r.pipeline();
      authors.forEach((a, i) => pp.lpush(`${P}posts:${a}`, i));
      await pp.exec();

      const push = async (onlyNonCeleb: boolean) => {
        let writes = 0, worst = 0;
        const t0 = performance.now();
        for (let i = 0; i < POSTS; i++) {
          const a = authors[i];
          if (onlyNonCeleb && celebs.has(a)) continue;
          const p = r.pipeline();
          for (const f of followers[a]) {
            p.lpush(`${P}tl${onlyNonCeleb ? "h" : "w"}:${f}`, i);
            p.ltrim(`${P}tl${onlyNonCeleb ? "h" : "w"}:${f}`, 0, 199);
          }
          writes += followers[a].length;
          worst = Math.max(worst, followers[a].length);
          if (followers[a].length) await p.exec();
        }
        return { writes, worst, ms: Math.round(performance.now() - t0) };
      };
      const w = await push(false);
      const h = await push(true);

      const readers = Array.from({ length: 300 }, () => Math.floor(rand() * U));
      const read = async (mode: "write" | "read" | "hybrid") => {
        const lat: number[] = [];
        let cmds = 0;
        for (const u of readers) {
          const t = performance.now();
          if (mode === "write") {
            await r.lrange(`${P}tlw:${u}`, 0, 49);
            cmds += 1;
          } else {
            const src = mode === "read" ? followees[u] : followees[u].filter((v) => celebs.has(v));
            const p = r.pipeline();
            if (mode === "hybrid") p.lrange(`${P}tlh:${u}`, 0, 49);
            for (const v of src) p.lrange(`${P}posts:${v}`, 0, 9);
            const res = (await p.exec())!.flatMap(([, v]) => (v as string[]).map(Number));
            res.sort((a, b) => b - a).slice(0, 50);
            cmds += src.length + (mode === "hybrid" ? 1 : 0);
          }
          lat.push(performance.now() - t);
        }
        return { cmds: cmds / readers.length, p50: pct(lat, 50), p99: pct(lat, 99) };
      };
      await read("write");
      const rw = await read("write"), rr = await read("read"), rh = await read("hybrid");
      const pullWrites = POSTS;
      rec.steps.push({
        cmd: `게시물 ${POSTS.toLocaleString()}개 게시 + 타임라인 ${readers.length}개 조회`,
        result: [
          `쓰기 시 팬아웃: 타임라인 쓰기 ${w.writes.toLocaleString()}회 (게시 1건 최악 ${w.worst.toLocaleString()}회) · ${w.ms}ms | 조회 명령 ${rw.cmds.toFixed(1)}개 · p50 ${rw.p50.toFixed(2)}ms · p99 ${rw.p99.toFixed(2)}ms`,
          `읽기 시 팬아웃: 쓰기 ${pullWrites.toLocaleString()}회(작성자 목록만) | 조회 명령 ${rr.cmds.toFixed(1)}개 · p50 ${rr.p50.toFixed(2)}ms · p99 ${rr.p99.toFixed(2)}ms`,
          `하이브리드(셀럽 ${celebs.size}명만 pull): 쓰기 ${h.writes.toLocaleString()}회 (최악 ${h.worst.toLocaleString()}회) · ${h.ms}ms | 조회 명령 ${rh.cmds.toFixed(1)}개 · p50 ${rh.p50.toFixed(2)}ms · p99 ${rh.p99.toFixed(2)}ms`,
        ],
        ms: w.ms + h.ms,
      });
      rec.check("쓰기 시 팬아웃은 셀럽 글 한 건이 수천 번의 쓰기가 된다", w.worst > CELEB_T, w.worst);
      rec.check("하이브리드는 게시 1건의 최악 쓰기를 셀럽 임계값 이하로 묶는다", h.worst <= CELEB_T, h.worst);
      rec.check("하이브리드 조회 명령 수는 읽기 시 팬아웃보다 훨씬 적다", rh.cmds < rr.cmds / 2, { hybrid: rh.cmds, pull: rr.cmds });
      rec.note("실서비스에선 셀럽 글을 별도 캐시(최근 N개)에 두고, 비활성 사용자에겐 push 를 건너뛰며(로그인 시 재구성), 팬아웃은 큐 워커가 비동기로 한다.");
    } finally {
      await delPrefix(r, P);
      r.disconnect();
    }
  },
};

// ---------------------------------------------------------------- 3. 검색 자동완성
type Trie = { c: Map<string, Trie>; top: [string, number][] };

export const sdAutocomplete: CodeExperiment = {
  id: "sd-autocomplete",
  subject: "system-design",
  title: "검색 자동완성: 이 사이트 노트의 제목·태그로 사전을 만들고 Redis 사전순 인덱스·접두사별 상위 K·메모리 트라이를 비교한다",
  category: "사례",
  summary: "모든 주제 노트의 제목 단어와 태그로 가중치 있는 사전을 만든다. (A) ZSET 하나에 사전순으로 넣고 ZRANGEBYLEX 로 접두사 검색(인기순 아님), (B) 접두사마다 상위 10개를 미리 계산한 ZSET(인기순, 키가 많음), (C) 노드마다 상위 10개를 캐시한 메모리 트라이의 질의 지연과 메모리를 표로 비교한다",
  notes: ["07-search-autocomplete", "01-design-method"],
  description: `
자동완성은 **타이핑마다** 호출되므로 p99 가 수 ms 안이어야 하고, 결과는 **인기순**이어야 한다.
- 사전순 인덱스는 저장이 작지만 접두사 뒤를 훑어 인기순으로 다시 정렬해야 한다.
- 접두사별 상위 K 를 미리 계산하면 조회는 한 번이지만 저장이 접두사 수 × K 로 늘고, 갱신(가중치 변경)이 비싸다.
- 트라이는 메모리 안에서 가장 빠르지만 서버마다 복제·재구성이 필요하다.
`,
  code: `# (A) 사전순 인덱스
ZADD ac:lex 0 "kafka" 0 "kubernetes" …
ZRANGEBYLEX ac:lex "[ku" "[ku\\xff" LIMIT 0 10        # 사전순 → 앱에서 가중치로 재정렬
# (B) 접두사별 상위 K
ZADD ac:p:ku 42 "kubernetes" 7 "kubectl" …        # 접두사마다 키 하나, 상위 10개만 유지
ZREVRANGE ac:p:ku 0 9`,
  requires: requiresRedis,
  async run({ rec, k }) {
    const r = getRedis();
    await ensureConnected(r);
    const P = k("");
    try {
      const freq = new Map<string, number>();
      let notes = 0;
      for (const s of subjects) {
        for (const n of await listNotes(s.id)) {
          notes++;
          const words = [...n.title.toLowerCase().split(/[\s·—,:()/"'+]+/), ...n.tags.map((t) => t.toLowerCase())];
          for (const w of words) if (w.length >= 2) freq.set(w, (freq.get(w) ?? 0) + 1);
        }
      }
      const dict = [...freq.entries()];
      rec.steps.push({ cmd: `사전 만들기: 노트 ${notes}편의 제목 단어 + 태그`, result: `용어 ${dict.length.toLocaleString()}개 · 상위 5: ${[...dict].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, c]) => `${w}(${c})`).join(", ")}`, ms: 0 });

      const lexKey = `${P}lex`;
      const pa = r.pipeline();
      for (const [w] of dict) pa.zadd(lexKey, 0, w);
      await pa.exec();
      const prefixes = new Map<string, [string, number][]>();
      for (const [w, c] of dict) {
        const chars = [...w];
        for (let i = 1; i <= Math.min(chars.length, 8); i++) {
          const p = chars.slice(0, i).join("");
          const arr = prefixes.get(p) ?? [];
          arr.push([w, c]);
          prefixes.set(p, arr);
        }
      }
      const pb = r.pipeline();
      for (const [p, arr] of prefixes) {
        const top = arr.sort((a, b) => b[1] - a[1]).slice(0, 10);
        pb.zadd(`${P}p:${p}`, ...top.flatMap(([w, c]) => [c, w]));
      }
      await pb.exec();

      const root: Trie = { c: new Map(), top: [] };
      for (const [w, c] of dict) {
        let node = root;
        for (const ch of w) {
          let next = node.c.get(ch);
          if (!next) node.c.set(ch, (next = { c: new Map(), top: [] }));
          node = next;
          node.top.push([w, c]);
          if (node.top.length > 20) node.top = node.top.sort((a, b) => b[1] - a[1]).slice(0, 10);
        }
      }
      const finalize = (n: Trie) => {
        n.top = n.top.sort((a, b) => b[1] - a[1]).slice(0, 10);
        for (const ch of n.c.values()) finalize(ch);
      };
      finalize(root);

      const queries = [...prefixes.keys()].filter((p) => [...p].length <= 3);
      const sample = Array.from({ length: 1000 }, (_, i) => queries[(i * 7919) % queries.length]);
      const bench = async (fn: (q: string) => Promise<string[]> | string[]) => {
        const lat: number[] = [];
        let last: string[] = [];
        for (const q of sample) {
          const t = performance.now();
          last = await fn(q);
          lat.push(performance.now() - t);
        }
        return { p50: pct(lat, 50), p99: pct(lat, 99), last };
      };
      const A = await bench(async (q) => {
        const lo = Buffer.from("[" + q), hi = Buffer.concat([Buffer.from("[" + q), Buffer.from([0xff])]);
        const words = await r.zrangebylex(lexKey, lo, hi, "LIMIT", 0, 200);
        return words.sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0)).slice(0, 10);
      });
      const B = await bench((q) => r.zrevrange(`${P}p:${q}`, 0, 9));
      const C = await bench((q) => {
        let n: Trie | undefined = root;
        for (const ch of q) n = n?.c.get(ch);
        return (n?.top ?? []).map(([w]) => w);
      });
      const memLex = Number(await r.memory("USAGE", lexKey));
      let memPrefix = 0, keys = 0;
      for (const p of [...prefixes.keys()].slice(0, 2000)) {
        memPrefix += Number(await r.memory("USAGE", `${P}p:${p}`)) || 0;
        keys++;
      }
      const memPrefixAll = Math.round((memPrefix / keys) * prefixes.size);
      const mem = process.memoryUsage().heapUsed;
      rec.steps.push({
        cmd: `접두사 질의 1,000회 (1~3글자 접두사 ${queries.length.toLocaleString()}종에서)`,
        result: [
          `(A) 사전순 ZSET 1개: p50 ${A.p50.toFixed(3)}ms · p99 ${A.p99.toFixed(3)}ms · 메모리 ${(memLex / 1024).toFixed(0)}KB · 인기순 정렬은 앱에서`,
          `(B) 접두사별 상위 10 ZSET ${prefixes.size.toLocaleString()}개: p50 ${B.p50.toFixed(3)}ms · p99 ${B.p99.toFixed(3)}ms · 메모리 약 ${(memPrefixAll / 1024).toFixed(0)}KB`,
          `(C) 메모리 트라이(노드별 상위 10): p50 ${C.p50.toFixed(4)}ms · p99 ${C.p99.toFixed(4)}ms · (프로세스 힙 ${(mem / 1048576).toFixed(0)}MB 중 일부)`,
        ],
        ms: 0,
      });
      rec.check("(B) 와 (C) 는 같은 인기순 상위 10 을 돌려준다", JSON.stringify(B.last) === JSON.stringify(C.last), { B: B.last, C: C.last });
      rec.check("(B) 접두사별 인덱스는 (A) 보다 메모리를 몇 배 더 쓴다", memPrefixAll > memLex * 2, { lex: memLex, prefix: memPrefixAll });
      rec.check("(C) 트라이 질의가 가장 빠르다 (네트워크 왕복 없음)", C.p50 < B.p50, { trie: C.p50, redis: B.p50 });
      rec.note("실서비스: 로그로 집계한 인기 질의를 주기적으로 오프라인 빌드해 (B) 또는 (C) 를 교체하고, 앞 1~2글자처럼 뜨거운 접두사는 CDN·브라우저 캐시에 둔다. 오타·초성 검색은 검색 엔진(n-gram, nori) 쪽 일이다.");
    } finally {
      await delPrefix(r, P);
    }
  },
};
