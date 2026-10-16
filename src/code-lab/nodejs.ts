import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodeExperiment } from "./types";

/**
 * Node.js 주제 실험. 실험 본체는 모두 **자식 Node 프로세스**에서 돈다.
 * 이 사이트의 서버(Next.js)도 Node 라서, 이벤트 루프를 막거나 힙을 터뜨리는 코드를 같은 프로세스에서 돌리면 사이트가 멈춘다.
 * 자식은 결과를 마지막 줄에 JSON 으로 찍고, 부모는 그 줄만 파싱한다.
 */

interface RunOut {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  ms: number;
  json: unknown;
}

async function runNode(source: string, flags: string[] = [], timeoutMs = 60_000, ext: "mjs" | "cjs" = "mjs"): Promise<RunOut> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "node-lab-"));
  const file = path.join(dir, `lab.${ext}`);
  await fs.writeFile(file, source);
  const t0 = performance.now();
  try {
    return await new Promise<RunOut>((resolve) => {
      execFile(process.execPath, [...flags, file], { cwd: dir, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: "" } }, (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; signal?: string | null }) | null;
        const code = e && typeof e.code === "number" ? e.code : e ? null : 0;
        const signal = e?.signal ?? null;
        const last = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        let json: unknown = null;
        try {
          json = JSON.parse(last);
        } catch {
          /* 마지막 줄이 JSON 이 아님 (크래시 등) */
        }
        resolve({ code, signal, stdout, stderr, ms: Math.round(performance.now() - t0), json });
      });
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

// ---------------------------------------------------------------- 1. 이벤트 루프 실행 순서
const ORDER_BODY = `
const busy = BUSY;
const main = [];
setTimeout(() => main.push("timeout"), 0);
setImmediate(() => main.push("immediate"));
process.nextTick(() => main.push("nextTick"));
Promise.resolve().then(() => main.push("promise"));
queueMicrotask(() => main.push("microtask"));
main.push("sync");
// busy > 0 이면 루프 시작 전에 그만큼 CPU 를 잡아 1ms 타이머가 확실히 만료되게 한다
if (busy) { const t = performance.now(); while (performance.now() - t < busy); }
fs.readFile(SELF, () => {
  const io = [];
  setTimeout(() => io.push("timeout"), 0);
  setImmediate(() => io.push("immediate"));
  setTimeout(() => console.log(JSON.stringify({ main, io })), 20);
});
`;
const orderSrc = (kind: "esm" | "cjs", busy: number) =>
  (kind === "esm" ? 'import fs from "node:fs";\n' : 'const fs = require("node:fs");\n') +
  ORDER_BODY.replace("BUSY", String(busy)).replace("SELF", kind === "esm" ? "new URL(import.meta.url)" : "__filename");

export const nodeEventLoopOrder: CodeExperiment = {
  id: "node-event-loop-order",
  subject: "nodejs",
  title: "이벤트 루프 실행 순서: nextTick·Promise·setTimeout(0)·setImmediate 는 어떤 순서로 도는가",
  category: "이벤트 루프",
  summary: "자식 Node 프로세스를 20번씩 띄워 메인 모듈과 I/O 콜백 안에서 setTimeout(0)·setImmediate·nextTick·Promise·queueMicrotask 의 실행 순서를 집계한다. 메인 모듈의 timeout/immediate 순서는 루프 진입 시점에 따라 달라지고, I/O 콜백 안에서는 immediate 가 항상 먼저임을 확인",
  notes: ["02-event-loop-phases", "03-microtasks-nexttick"],
  description: `
"setTimeout(fn, 0) 과 setImmediate(fn) 중 무엇이 먼저냐" 의 정답은 **어디서 불렀느냐에 따라 다르다** 이다.
- 메인 모듈에서: setTimeout(0) 은 실제로 1ms 타이머다. 루프가 timers 단계에 들어갈 때 1ms 가 지났으면 timeout 이 먼저, 아니면 check 단계의 immediate 가 먼저. 그래서 **기계 부하에 따라 바뀐다**.
- I/O 콜백 안에서: poll 단계 다음이 check 단계라 **immediate 가 항상 먼저**다.
- 마이크로태스크: 동기 코드가 끝나면 nextTick 큐를 먼저 비우고, 그다음 Promise(마이크로태스크) 큐를 비운다.
이 실험은 순서를 20번씩 재서 표로 보여 준다. 실험은 자식 프로세스에서 돌아 이 사이트의 이벤트 루프에는 영향이 없다.
`,
  code: `setTimeout(() => log("timeout"), 0);
setImmediate(() => log("immediate"));
process.nextTick(() => log("nextTick"));
Promise.resolve().then(() => log("promise"));
log("sync");
// 출력 예: sync → nextTick → promise → (timeout ↔ immediate 순서는 실행마다 다를 수 있음)

fs.readFile(__filename, () => {
  setTimeout(() => log("timeout"), 0);
  setImmediate(() => log("immediate"));   // I/O 콜백 안: 항상 immediate → timeout
});`,
  async run({ rec }) {
    const N = 20;
    type O = { main: string[]; io: string[] };
    const tally = async (kind: "esm" | "cjs", busy: number) => (await Promise.all(Array.from({ length: N }, () => runNode(orderSrc(kind, busy), [], 30_000, kind === "esm" ? "mjs" : "cjs")))).map((r) => r.json as O);
    const cjs = await rec.measure(`CommonJS(.cjs) 자식 프로세스 ${N}개 — 바로 루프 진입`, () => tally("cjs", 0));
    const esm = await rec.measure(`ES 모듈(.mjs) 자식 프로세스 ${N}개 — 바로 루프 진입`, () => tally("esm", 0));
    const busy = await rec.measure(`CommonJS 자식 프로세스 ${N}개 — 루프 진입 전 2ms CPU 사용`, () => tally("cjs", 2));
    const first = (arr: string[]) => (arr.indexOf("timeout") < arr.indexOf("immediate") ? "timeout" : "immediate");
    const count = (runs: O[], who: string) => runs.filter((r) => first(r.main) === who).length;
    const micro = (runs: O[]) => [...new Set(runs.map((r) => r.main.slice(0, 4).join(" → ")))];
    rec.steps.push({ cmd: "동기 코드 직후 마이크로태스크 순서", result: { CommonJS: micro(cjs), "ES 모듈": micro(esm) }, ms: 0 });
    rec.steps.push({
      cmd: "메인 모듈의 timeout/immediate 중 먼저 실행된 쪽",
      result: { "CJS 바로 진입": { timeout: count(cjs, "timeout"), immediate: count(cjs, "immediate") }, "ESM 바로 진입": { timeout: count(esm, "timeout"), immediate: count(esm, "immediate") }, "CJS 2ms 지연 후": { timeout: count(busy, "timeout"), immediate: count(busy, "immediate") } },
      ms: 0,
    });
    rec.check("CommonJS: sync → nextTick → promise → microtask (nextTick 큐가 Promise 큐보다 먼저) — 40/40", [...cjs, ...busy].every((r) => r.main.slice(0, 4).join(",") === "sync,nextTick,promise,microtask"));
    rec.check("ES 모듈: sync → promise → microtask → nextTick (모듈 평가 자체가 마이크로태스크 안에서 돌아 Promise 가 먼저 비워진다) — 20/20", esm.every((r) => r.main.slice(0, 4).join(",") === "sync,promise,microtask,nextTick"));
    rec.check("루프 진입 전에 1ms 이상 지나면 timeout 이 먼저 (timers 단계가 check 보다 앞) — 20/20", count(busy, "timeout") === N, count(busy, "timeout"));
    rec.check("I/O 콜백 안에서는 immediate 가 항상 먼저 (poll → check → 다음 바퀴 timers) — 60/60", [...cjs, ...esm, ...busy].every((r) => first(r.io) === "immediate"));
    const p = [...cjs, ...esm];
    rec.note(
      count(p, "immediate") > 0 && count(p, "timeout") > 0
        ? `바로 진입한 40번 중 timeout 먼저 ${count(p, "timeout")}번, immediate 먼저 ${count(p, "immediate")}번 — 같은 코드가 실행마다 다르게 돈다. 순서에 의존하는 코드는 버그다.`
        : `바로 진입한 40번은 모두 ${count(p, "timeout") ? "timeout" : "immediate"} 이 먼저였다. 프로세스 시작 비용 때문에 이 기계에서는 한쪽으로 치우치지만 보장된 순서가 아니다 — 2ms 지연을 넣은 행처럼 조건이 바뀌면 뒤집힌다.`,
    );
  },
};

// ---------------------------------------------------------------- 2. 스트림 백프레셔
const BP_SRC = `
import { Writable, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const mode = process.argv[2];
const CHUNK = 64 * 1024, COUNT = 512; // 32MB
let maxBuffered = 0, maxRss = 0;
const sampler = setInterval(() => { maxRss = Math.max(maxRss, process.memoryUsage().rss); }, 10);
const slow = new Writable({
  highWaterMark: CHUNK,
  write(chunk, _enc, cb) { setTimeout(cb, 1); },   // 느린 소비자: 청크마다 1ms
});
const t0 = performance.now();
const base = process.memoryUsage().rss;
if (mode === "ignore") {
  // write() 의 반환값(false = 버퍼가 찼다)을 무시하고 계속 밀어 넣는다
  for (let i = 0; i < COUNT; i++) { slow.write(Buffer.alloc(CHUNK, i & 255)); maxBuffered = Math.max(maxBuffered, slow.writableLength); }
  maxRss = Math.max(maxRss, process.memoryUsage().rss);
  await new Promise((r) => slow.end(r));
} else {
  let i = 0;
  const src = new Readable({ highWaterMark: CHUNK, read() { this.push(i < COUNT ? Buffer.alloc(CHUNK, i++ & 255) : null); } });
  const watch = setInterval(() => { maxBuffered = Math.max(maxBuffered, slow.writableLength); }, 1);
  await pipeline(src, slow);
  clearInterval(watch);
}
clearInterval(sampler);
console.log(JSON.stringify({ mode, ms: Math.round(performance.now() - t0), maxBuffered, rssGrowth: Math.max(0, maxRss - base) }));
`;

export const nodeStreamBackpressure: CodeExperiment = {
  id: "node-stream-backpressure",
  subject: "nodejs",
  title: "스트림 백프레셔: write() 의 false 를 무시하면 메모리가 생산량만큼 쌓인다",
  category: "스트림",
  summary: "빠른 생산자가 32MB(64KB × 512)를 청크마다 1ms 걸리는 느린 Writable 에 보낸다. write() 반환값을 무시하면 내부 버퍼가 32MB 까지 차고 RSS 가 그만큼 늘지만, pipeline 은 highWaterMark(64KB) 근처에서 생산자를 멈춰 메모리가 일정하다",
  notes: ["06-streams-backpressure", "05-buffers-encoding"],
  description: `
Writable.write() 는 **"더 넣어도 되는가"** 를 boolean 으로 돌려준다. false 는 내부 버퍼가 highWaterMark 를 넘었다는 뜻이고, 생산자는 'drain' 이벤트까지 멈춰야 한다.
이 약속을 지키는 것이 **백프레셔**다. pipeline()·pipe()·for await 는 이를 자동으로 지킨다. 손으로 write() 를 루프 돌리며 반환값을 무시하면, 소비자가 느린 만큼 데이터가 메모리에 쌓인다 — 업로드 프록시·로그 전송기에서 OOM 이 나는 전형적인 원인이다.
`,
  code: `// ❌ 반환값 무시
for (const chunk of chunks) slow.write(chunk);     // 버퍼가 32MB 까지 자람

// ✅ 백프레셔 존중
await pipeline(Readable.from(chunks), slow);       // highWaterMark 근처에서 생산자가 멈춤
// 손으로 쓴다면
if (!slow.write(chunk)) await once(slow, "drain");`,
  async run({ rec }) {
    const ignore = await rec.measure("write() 반환값 무시 (64KB × 512 = 32MB)", () => runNodeArgs(BP_SRC, "ignore"));
    const respect = await rec.measure("pipeline() 으로 백프레셔 존중", () => runNodeArgs(BP_SRC, "respect"));
    type R = { ms: number; maxBuffered: number; rssGrowth: number };
    const a = ignore as R, b = respect as R;
    rec.steps.push({
      cmd: "비교",
      result: [
        { 방식: "반환값 무시", "최대 내부 버퍼(MB)": mb(a.maxBuffered), "RSS 증가(MB)": mb(a.rssGrowth), "소요(ms)": a.ms },
        { 방식: "pipeline", "최대 내부 버퍼(MB)": mb(b.maxBuffered), "RSS 증가(MB)": mb(b.rssGrowth), "소요(ms)": b.ms },
      ],
      ms: 0,
    });
    rec.check("반환값을 무시하면 내부 버퍼가 거의 전체(≥ 24MB)까지 쌓인다", a.maxBuffered >= 24 * 1024 * 1024, mb(a.maxBuffered));
    rec.check("pipeline 은 버퍼를 highWaterMark 근처(≤ 256KB)로 유지한다", b.maxBuffered <= 256 * 1024, mb(b.maxBuffered));
    rec.check("무시한 쪽은 RSS 가 보낸 데이터만큼(≥ 28MB) 늘어난다 — 32MB 가 동시에 살아 있다", a.rssGrowth >= 28 * 1024 * 1024, mb(a.rssGrowth));
    rec.note(`pipeline 쪽 RSS 도 ${mb(b.rssGrowth)}MB 늘었는데, 이는 '동시에 살아 있는' 데이터가 아니라 다 쓴 Buffer 가 아직 GC 되지 않은 것이다(내부 버퍼 최대 ${mb(b.maxBuffered)}MB). 무시한 쪽은 버퍼가 실제로 참조 중이라 GC 해도 줄지 않는다 — 생산량이 수 GB 면 그대로 OOM.`);
    rec.note("총 소요 시간은 둘 다 소비자 속도(청크당 1ms)에 묶여 비슷하다. 백프레셔는 속도가 아니라 '메모리 상한' 을 지키는 장치다.");
  },
};

async function runNodeArgs(source: string, arg: string, flags: string[] = []): Promise<unknown> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "node-lab-"));
  const file = path.join(dir, "lab.mjs");
  await fs.writeFile(file, source);
  try {
    return await new Promise((resolve, reject) => {
      execFile(process.execPath, [...flags, file, arg], { cwd: dir, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: "" } }, (err, stdout, stderr) => {
        const last = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        try {
          resolve(JSON.parse(last));
        } catch {
          reject(new Error(`자식 프로세스 출력 파싱 실패: ${(err?.message ?? "") + stderr.slice(0, 300)}`));
        }
      });
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 3. GC 와 힙
const GC_SRC = `
import { PerformanceObserver, constants } from "node:perf_hooks";
import v8 from "node:v8";
const mode = process.argv[2];
const gcs = { minor: 0, major: 0, incremental: 0, minorMs: 0, majorMs: 0 };
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const k = e.detail?.kind;
    if (k === constants.NODE_PERFORMANCE_GC_MINOR) { gcs.minor++; gcs.minorMs += e.duration; }
    else if (k === constants.NODE_PERFORMANCE_GC_MAJOR) { gcs.major++; gcs.majorMs += e.duration; }
    else if (k === constants.NODE_PERFORMANCE_GC_INCREMENTAL) gcs.incremental++;
  }
});
obs.observe({ entryTypes: ["gc"] });
const before = v8.getHeapStatistics().used_heap_size;
const keep = [];
const t0 = performance.now();
for (let i = 0; i < 3_000_000; i++) {
  const o = { id: i, name: "user-" + i, tags: [i & 7, i & 15] };
  if (mode === "long" && i % 3 === 0) keep.push(o);   // 1/3 을 오래 붙잡는다 → Old 로 승격
}
const ms = Math.round(performance.now() - t0);
await new Promise((r) => setTimeout(r, 50));
const spaces = Object.fromEntries(v8.getHeapSpaceStatistics().map((s) => [s.space_name, Math.round(s.space_used_size / 1024 / 1024 * 10) / 10]));
console.log(JSON.stringify({ mode, ms, kept: keep.length, ...gcs, minorMs: Math.round(gcs.minorMs), majorMs: Math.round(gcs.majorMs), usedMB: Math.round((v8.getHeapStatistics().used_heap_size - before) / 1024 / 1024), newSpace: spaces.new_space, oldSpace: spaces.old_space }));
`;
const OOM_SRC = `
const keep = [];
for (;;) keep.push({ big: "x".repeat(1024) + keep.length });
`;

export const nodeGcHeap: CodeExperiment = {
  id: "node-gc-heap",
  subject: "nodejs",
  title: "GC 와 힙: 짧게 사는 객체는 Scavenge 로 싸게 치우고, 오래 사는 객체는 Old 공간과 Mark-Compact 를 부른다",
  category: "V8 · 메모리",
  summary: "같은 객체 300만 개를 만들되 바로 버리는 경우와 1/3 을 붙잡는 경우의 GC 종류별 횟수·시간과 Young/Old 사용량을 perf_hooks 의 gc 항목으로 비교하고, --max-old-space-size=32 에서 힙이 터지는(FATAL ERROR) 것을 재현",
  notes: ["10-gc-heap", "11-memory-leaks"],
  description: `
V8 의 힙은 세대로 나뉜다. 새 객체는 **Young(new space)** 에 생기고, 대부분 금방 죽는다는 세대 가설 덕에 **Scavenge**(살아남은 것만 복사)로 싸게 치운다. 두 번 살아남은 객체는 **Old 공간으로 승격**되고, Old 는 **Mark-Compact**(병행 마킹 + 압축)로 치운다 — 더 비싸다.
그래서 "객체를 많이 만든다" 보다 "**오래 붙잡는다**" 가 GC 비용을 키운다. 캐시·누수·큰 배열이 Old 를 채우면 major GC 가 늘고, --max-old-space-size 를 넘으면 프로세스가 죽는다.
`,
  code: `node --trace-gc app.js
# [..]  12 ms: Scavenge 4.1 (6.0) -> 3.2 (7.0) MB, 0.6 / 0.0 ms
# [..] 210 ms: Mark-Compact 48.3 (60.1) -> 40.2 (58.0) MB, 22.4 / 0.0 ms

// 코드에서
new PerformanceObserver((l) => l.getEntries().forEach((e) => console.log(e.detail.kind, e.duration))).observe({ entryTypes: ["gc"] });
v8.getHeapSpaceStatistics()   // new_space / old_space / code_space …
node --max-old-space-size=32 app.js   # Old 상한 32MB → 넘으면 FATAL ERROR: … JavaScript heap out of memory`,
  async run({ rec }) {
    type G = { ms: number; kept: number; minor: number; major: number; minorMs: number; majorMs: number; usedMB: number; newSpace: number; oldSpace: number };
    const short = (await rec.measure("객체 300만 개 — 만들고 바로 버림", () => runNodeArgs(GC_SRC, "short"))) as G;
    const long = (await rec.measure("객체 300만 개 — 1/3(100만 개)을 배열에 붙잡음", () => runNodeArgs(GC_SRC, "long"))) as G;
    rec.steps.push({
      cmd: "GC 비교 (perf_hooks gc 항목)",
      result: [
        { 패턴: "짧게 삶", "minor(Scavenge)": short.minor, "major(Mark-Compact)": short.major, "minor ms": short.minorMs, "major ms": short.majorMs, "Old 사용(MB)": short.oldSpace, "루프(ms)": short.ms },
        { 패턴: "오래 삶", "minor(Scavenge)": long.minor, "major(Mark-Compact)": long.major, "minor ms": long.minorMs, "major ms": long.majorMs, "Old 사용(MB)": long.oldSpace, "루프(ms)": long.ms },
      ],
      ms: 0,
    });
    rec.check("짧게 사는 객체는 Scavenge(minor)로 치워진다 — minor 가 수십 번 이상", short.minor >= 10, short.minor);
    rec.check("붙잡으면 Old 공간이 훨씬 커진다 (승격)", long.oldSpace > short.oldSpace * 3 && long.oldSpace > 20, { short: short.oldSpace, long: long.oldSpace });
    rec.check("붙잡은 쪽이 GC 에 쓴 시간이 더 길다", long.minorMs + long.majorMs > short.minorMs + short.majorMs, { short: short.minorMs + short.majorMs, long: long.minorMs + long.majorMs });
    const oom = await rec.measure("node --max-old-space-size=32 — 끝없이 붙잡기", () => runNode(OOM_SRC, ["--max-old-space-size=32"], 60_000));
    const fatal = /heap out of memory|Reached heap limit/i.test(oom.stderr);
    rec.steps.push({ cmd: "종료 코드·신호 · stderr 첫 줄", result: { code: oom.code, signal: oom.signal, stderr: oom.stderr.split("\n").find((l) => /FATAL|heap/i.test(l)) ?? oom.stderr.slice(0, 160) }, ms: oom.ms });
    rec.check("Old 상한을 넘으면 프로세스가 죽는다 (FATAL ERROR … JavaScript heap out of memory, SIGABRT = 셸에서 134)", fatal && oom.code !== 0);
    rec.note("컨테이너에서는 --max-old-space-size 를 컨테이너 메모리 한도보다 작게(보통 70~75%) 잡는다. 그렇지 않으면 V8 이 GC 를 미루다 cgroup OOM(exit 137)으로 먼저 죽는다 — 운영체제 내부 노트의 os-cgroup-limits 실험과 같은 현상.");
  },
};

// ---------------------------------------------------------------- 4. 메모리 누수 찾기
const LEAK_SRC = `
import v8 from "node:v8";
import fs from "node:fs";
import { EventEmitter } from "node:events";
const mode = process.argv[2];
const bus = new EventEmitter();
bus.setMaxListeners(0);
const cache = new Map();            // 요청별 결과를 '잠깐' 담는다던 캐시
class Session { constructor(id) { this.id = id; this.payload = Buffer.alloc(4096, id & 255); this.createdAt = Date.now(); } }
function handle(id) {
  const s = new Session(id);
  cache.set(id, s);
  const onConfig = () => s.id;     // 클로저가 s 를 붙잡는다
  bus.on("config", onConfig);
  if (mode === "fixed") { cache.delete(id); bus.off("config", onConfig); }
}
function summarize(file) {
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  const f = snap.snapshot.meta.node_fields, types = snap.snapshot.meta.node_types[0];
  const W = f.length, iType = f.indexOf("type"), iName = f.indexOf("name"), iSize = f.indexOf("self_size");
  const by = new Map(); let nodes = 0, bytes = 0;
  for (let i = 0; i < snap.nodes.length; i += W) {
    const t = types[snap.nodes[i + iType]]; const size = snap.nodes[i + iSize]; nodes++; bytes += size;
    if (t !== "object" && t !== "closure") continue;
    const name = t === "closure" ? "(closure) " + snap.strings[snap.nodes[i + iName]] : snap.strings[snap.nodes[i + iName]];
    const cur = by.get(name) ?? { count: 0, size: 0 }; cur.count++; cur.size += size; by.set(name, cur);
  }
  fs.rmSync(file);
  return { nodes, bytes, by };
}
for (let i = 0; i < 1000; i++) handle(i);
const s1 = summarize(v8.writeHeapSnapshot(\`\${process.cwd()}/a.heapsnapshot\`));
for (let i = 1000; i < 3000; i++) handle(i);
const s2 = summarize(v8.writeHeapSnapshot(\`\${process.cwd()}/b.heapsnapshot\`));
const growth = [...s2.by].map(([name, v]) => ({ name, count: v.count - (s1.by.get(name)?.count ?? 0), size: v.size - (s1.by.get(name)?.size ?? 0) }))
  .filter((x) => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
console.log(JSON.stringify({ mode, nodes1: s1.nodes, nodes2: s2.nodes, mb1: Math.round(s1.bytes / 1048576 * 10) / 10, mb2: Math.round(s2.bytes / 1048576 * 10) / 10, listeners: bus.listenerCount("config"), cacheSize: cache.size, growth }));
`;

export const nodeLeakDetect: CodeExperiment = {
  id: "node-leak-detect",
  subject: "nodejs",
  title: "메모리 누수 찾기: 힙 스냅샷 두 장을 비교하면 늘어나는 생성자가 범인을 가리킨다",
  category: "V8 · 메모리",
  summary: "요청마다 전역 Map 캐시에 넣고 이벤트 리스너(클로저)를 다는 코드를 1,000번 → 3,000번 처리하며 v8.writeHeapSnapshot 두 장을 찍어 생성자별 객체 수 증가를 집계한다. 누수 버전은 Session·클로저가 처리 수만큼 늘고, 정리하는 버전은 늘지 않는다",
  notes: ["11-memory-leaks", "10-gc-heap"],
  description: `
누수는 "GC 가 못 치우는 것" 이 아니라 **"아직 누군가 참조하고 있어서 치우면 안 되는 것"** 이다. GC 는 정확하다. 문제는 우리가 놓아주지 않은 참조다.
대표 경로는 넷이다: 지우지 않는 **전역 캐시(Map)**, 해제하지 않는 **이벤트 리스너**(클로저가 큰 객체를 붙잡음), 끄지 않은 **타이머**, 그리고 모듈 수준 배열.
찾는 법은 단순하다. **부하 전후로 힙 스냅샷을 두 장** 찍고 생성자별 개수를 비교한다. 처리량에 비례해 늘어나는 생성자가 범인이고, 그 객체의 retainer(누가 붙잡나)를 따라가면 원인 코드가 나온다. Chrome DevTools 의 Comparison 뷰가 하는 일을 이 실험은 스냅샷 JSON 을 직접 집계해 보여 준다.
`,
  code: `// 누수
const cache = new Map();
app.get("/x", (req) => { const s = new Session(req.id); cache.set(req.id, s); bus.on("config", () => s.id); });

// 찾기
v8.writeHeapSnapshot("a.heapsnapshot");   // 부하 전
// … 요청 2,000건 …
v8.writeHeapSnapshot("b.heapsnapshot");   // 부하 후 → DevTools Memory › Comparison 에서 # Delta 정렬

// 고치기: 크기·TTL 이 있는 캐시(LRU), 리스너는 off/once/AbortSignal, 필요하면 WeakMap·WeakRef`,
  async run({ rec }) {
    type L = { nodes1: number; nodes2: number; mb1: number; mb2: number; listeners: number; cacheSize: number; growth: { name: string; count: number; size: number }[] };
    const leak = (await rec.measure("누수 버전 — 1,000건 후 스냅샷 → 2,000건 더 → 스냅샷", () => runNodeArgs(LEAK_SRC, "leak"))) as L;
    const fixed = (await rec.measure("고친 버전 — 같은 부하, 캐시 delete·리스너 off", () => runNodeArgs(LEAK_SRC, "fixed"))) as L;
    rec.steps.push({ cmd: "누수 버전: 스냅샷 사이에 늘어난 생성자 상위", result: leak.growth.map((g) => ({ 생성자: g.name, "개수 증가": g.count, "얕은 크기 증가(KB)": Math.round(g.size / 1024) })), ms: 0 });
    rec.steps.push({
      cmd: "전체 비교",
      result: [
        { 버전: "누수", "힙(MB) 1→2": `${leak.mb1} → ${leak.mb2}`, "노드 수 1→2": `${leak.nodes1} → ${leak.nodes2}`, 리스너: leak.listeners, "캐시 크기": leak.cacheSize },
        { 버전: "고침", "힙(MB) 1→2": `${fixed.mb1} → ${fixed.mb2}`, "노드 수 1→2": `${fixed.nodes1} → ${fixed.nodes2}`, 리스너: fixed.listeners, "캐시 크기": fixed.cacheSize },
      ],
      ms: 0,
    });
    const sessionGrowth = leak.growth.find((g) => g.name === "Session")?.count ?? 0;
    rec.check("누수 버전에서 Session 이 처리한 요청 수(2,000)만큼 늘어난다", sessionGrowth >= 1900, sessionGrowth);
    rec.check("리스너도 요청 수만큼 쌓인다 (3,000개)", leak.listeners === 3000, leak.listeners);
    const fixedSession = fixed.growth.find((g) => g.name === "Session")?.count ?? 0;
    rec.check("고친 버전은 Session 이 늘지 않고(< 10) 리스너·캐시가 0 이다", fixedSession < 10 && fixed.listeners === 0 && fixed.cacheSize === 0, { session: fixedSession, listeners: fixed.listeners, cache: fixed.cacheSize });
    rec.note(`힙 노드 수 증가: 누수 ${leak.nodes2 - leak.nodes1} vs 고침 ${fixed.nodes2 - fixed.nodes1}. 고친 쪽의 증가분은 첫 스냅샷을 집계한 문자열·Map 같은 측정 자체의 잔여물이다 — 그래서 "총량" 보다 "처리량에 비례해 느는 생성자" 를 본다.`);
    rec.note("Session 하나는 얕은 크기가 수십 바이트지만 payload Buffer(4KB, 힙 밖 메모리)를 붙잡는다. 얕은 크기만 보면 작은 누수로 보여도 retained size 는 훨씬 크다 — DevTools 에서는 Retained Size 열을 같이 본다.");
  },
};
