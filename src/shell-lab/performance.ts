import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

const APP = "http://127.0.0.1:3000";
const REDIS = ["-h", "127.0.0.1", "-p", "6379"];

async function requiresK6(): Promise<string | null> {
  const k6 = await exec("k6", ["version"], { timeout: 5000 });
  if (!k6.ok) return "k6 가 없습니다. `brew install k6` 로 설치하세요.";
  try {
    const r = await fetch(`${APP}/api/metrics`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return `대상 앱(${APP})이 ${r.status} 를 반환합니다.`;
  } catch {
    return `대상 앱(${APP})에 연결할 수 없습니다. \`pnpm dev\` 가 3000 에서 실행 중이어야 합니다.`;
  }
  return null;
}

type Summary = { metrics: Record<string, Record<string, number> & { values?: Record<string, number>; thresholds?: Record<string, { ok: boolean }> }> };

/** --summary-export 의 레거시 형식과 새 형식(values 안에) 둘 다 읽는다 */
function metric(s: Summary, name: string): Record<string, number> {
  const m = s.metrics[name];
  if (!m) return {};
  return (m.values ?? m) as Record<string, number>;
}

const fmt = (n: number | undefined, d = 1) => (n === undefined || Number.isNaN(n) ? "-" : n.toFixed(d));

async function runK6(ctx: ShellCtx, script: string, label: string, extra: string[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "k6-lab-"));
  const file = path.join(dir, "script.js");
  const out = path.join(dir, "summary.json");
  await fs.writeFile(file, script);
  const r = await ctx.sh("k6", ["run", "--quiet", "--no-color", "--summary-trend-stats", "avg,min,med,max,p(90),p(95),p(99)", "--summary-export", out, ...extra, file], { allowFail: true, timeout: 120_000, label });
  let summary: Summary | null = null;
  try {
    summary = JSON.parse(await fs.readFile(out, "utf8")) as Summary;
  } catch {
    /* 요약 없음 */
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { r, summary };
}

function durationRow(name: string, s: Summary): string[] {
  const d = metric(s, "http_req_duration");
  const reqs = metric(s, "http_reqs");
  const failed = metric(s, "http_req_failed");
  return [name, fmt(reqs.count, 0), fmt(reqs.rate), fmt(d.med ?? d["p(50)"]), fmt(d["p(95)"]), fmt(d["p(99)"]), fmt(d.max), `${fmt((failed.value ?? 0) * 100, 2)}%`];
}

const DUR_COLS = ["시나리오", "요청 수", "req/s", "p50 ms", "p95 ms", "p99 ms", "max ms", "실패율"];

export const k6Smoke: ShellExperiment = {
  id: "perf-k6-smoke",
  subject: "performance",
  title: "k6 스모크 테스트 — 임계값(SLO)을 걸고 통과/실패를 판정한다",
  category: "부하 테스트",
  summary: "VU 5 로 15초간 /api/metrics 와 노트 페이지를 치며 p95 < 500ms, 실패율 < 1% 임계값을 검사. 요약 JSON 을 파싱해 백분위수 표로 보여 주고, 임계값 실패 시 k6 가 종료 코드 99 를 내는 것을 확인",
  notes: ["03-k6-load-testing", "01-language-of-performance"],
  description: `
스모크 테스트는 "부하를 걸기 전에 스크립트와 시스템이 정상인지" 확인하는 가장 작은 테스트다. 핵심은 **임계값(thresholds)** — SLO 를 코드로 적어 두면 k6 가 자동으로 합격/불합격을 판정하고 CI 에서 배포를 막을 수 있다.
결과 표의 **p50 과 p95, p99 의 간격**을 보자. 평균은 꼬리를 숨긴다.
`,
  code: `cat > smoke.js <<'JS'
import http from "k6/http";
import { check, sleep } from "k6";
export const options = {
  vus: 5, duration: "15s",
  thresholds: { http_req_duration: ["p(95)<500"], http_req_failed: ["rate<0.01"] },   // SLO
};
export default function () {
  const r = http.get("http://127.0.0.1:3000/api/metrics");
  check(r, { "200": (res) => res.status === 200 });
  http.get("http://127.0.0.1:3000/redis/notes");
  sleep(0.2);
}
JS
k6 run --summary-export summary.json smoke.js ; echo "exit=$?"   # 임계값 실패면 99`,
  requires: requiresK6,
  async run(ctx) {
    const script = `
import http from "k6/http";
import { check, sleep } from "k6";
export const options = {
  vus: 5, duration: "15s",
  thresholds: { http_req_duration: ["p(95)<500"], http_req_failed: ["rate<0.01"] },
};
export default function () {
  const r = http.get("${APP}/api/metrics");
  check(r, { "metrics 200": (res) => res.status === 200 });
  const n = http.get("${APP}/redis/notes");
  check(n, { "notes 200": (res) => res.status === 200 });
  sleep(0.2);
}`;
    ctx.note("VU 5 × 15초, 요청마다 /api/metrics + /redis/notes, 0.2초 think time");
    const { r, summary } = await runK6(ctx, script, "k6 run smoke (15s)");
    if (!summary) throw new Error("k6 요약을 읽지 못했습니다: " + r.err.slice(0, 300));
    ctx.table("요청 지연 분포", DUR_COLS, [durationRow("smoke", summary)]);
    const d = metric(summary, "http_req_duration");
    const failed = metric(summary, "http_req_failed");
    const checks = metric(summary, "checks");
    ctx.table("임계값", ["임계값", "측정값", "결과"], [
      ["http_req_duration p(95) < 500ms", `${fmt(d["p(95)"])} ms`, (d["p(95)"] ?? 1e9) < 500 ? "PASS" : "FAIL"],
      ["http_req_failed rate < 1%", `${fmt((failed.value ?? 0) * 100, 2)}%`, (failed.value ?? 1) < 0.01 ? "PASS" : "FAIL"],
    ]);
    ctx.check("k6 가 임계값 통과로 종료(코드 0; 임계값 실패면 99)", r.code === 0, `exit=${r.code}`);
    ctx.check("모든 check 가 통과 (200 응답)", (checks.fails ?? 0) === 0, `passes=${checks.passes} fails=${checks.fails}`);
    const ratio = (d["p(99)"] ?? 0) / Math.max(d.med ?? d["p(50)"] ?? 1, 0.01);
    ctx.note(`p99 / p50 = ${ratio.toFixed(1)}배 — 꼬리가 중앙값의 몇 배인지가 "평균이 숨기는 것" 의 크기다. 2~3배는 보통, 10배 이상이면 GC·락·캐시 미스 같은 간헐 지연을 의심한다.`);
  },
};

export const k6Ramp: ShellExperiment = {
  id: "perf-k6-arrival-rate",
  subject: "performance",
  title: "도착률 10 → 25 → 50 req/s — 포화점(knee)을 지나면 지연이 폭발한다",
  category: "부하 테스트",
  summary: "constant-arrival-rate 실행기로 /api/metrics 를 10·25·50 req/s 로 각 8초 쏴서 p50/p95/p99 와 dropped_iterations 가 어떻게 변하는지 비교. 큐잉 이론의 포화 곡선, 열린 모델 vs 닫힌 모델, 조정 누락(coordinated omission)을 실물로",
  notes: ["01-language-of-performance", "03-k6-load-testing", "08-tail-latency-at-scale"],
  description: `
VU 가 "응답을 받은 뒤 다음 요청" 을 보내는 **닫힌 모델**에서는 서버가 느려지면 요청률이 저절로 줄어 지연이 과소평가된다(**조정 누락**). 실제 사용자는 서버가 느리다고 덜 오지 않는다.
\`constant-arrival-rate\` 는 **열린 모델**: 정해진 속도로 요청을 발생시키고 부족하면 VU 를 더 할당한다. 그래서 과부하가 지연에 그대로 드러난다.
두 속도에서 **p50 은 비슷한데 p95/p99 가 먼저 벌어지는** 현상을 보자 — 큐잉 이론의 "사용률이 오르면 대기 시간이 비선형으로 는다" 의 실물이다.
`,
  code: `export const options = {
  scenarios: {
    low:  { executor: "constant-arrival-rate", rate: 10, timeUnit: "1s", duration: "8s", preAllocatedVUs: 5,  maxVUs: 50 },
    mid:  { executor: "constant-arrival-rate", rate: 25, timeUnit: "1s", duration: "8s", preAllocatedVUs: 10, maxVUs: 100, startTime: "10s" },
    high: { executor: "constant-arrival-rate", rate: 50, timeUnit: "1s", duration: "8s", preAllocatedVUs: 20, maxVUs: 200, startTime: "20s" },
  },
};
export default function () { http.get("http://127.0.0.1:3000/api/metrics"); }
# dropped_iterations 가 있으면 maxVUs 가 모자라 목표 속도를 못 낸 것 = 서버가 그 속도를 못 받는다`,
  requires: requiresK6,
  async run(ctx) {
    const mk = (rate: number, pre: number, max: number) => `
import http from "k6/http";
export const options = {
  scenarios: { s: { executor: "constant-arrival-rate", rate: ${rate}, timeUnit: "1s", duration: "8s", preAllocatedVUs: ${pre}, maxVUs: ${max}, gracefulStop: "3s" } },
  thresholds: { http_req_failed: ["rate<0.05"] },
};
export default function () { http.get("${APP}/api/metrics"); }`;
    const rows: string[][] = [];
    const results: { rate: number; s: Summary; dropped: number }[] = [];
    for (const [rate, pre, max] of [[10, 5, 50], [25, 10, 100], [50, 20, 200]] as const) {
      const { summary } = await runK6(ctx, mk(rate, pre, max), `k6 constant-arrival-rate ${rate} req/s × 8s`);
      if (!summary) throw new Error("k6 요약을 읽지 못했습니다");
      const dropped = metric(summary, "dropped_iterations").count ?? 0;
      results.push({ rate, s: summary, dropped });
      rows.push(durationRow(`${rate} req/s 목표`, summary).concat([String(dropped)]));
    }
    ctx.table("도착률별 지연 분포 (목표 req/s vs 실제 req/s 를 비교)", [...DUR_COLS, "drop"], rows);
    const d = results.map((x) => metric(x.s, "http_req_duration"));
    const achieved = results.map((x) => metric(x.s, "http_reqs").rate ?? 0);
    const knee = results.findIndex((x, i) => achieved[i] < x.rate * 0.8);
    ctx.note(knee === -1 ? "세 단계 모두 목표 속도를 달성 — 포화점이 50 req/s 보다 높다. 운영 빌드라면 더 올려 보자." : `${results[knee].rate} req/s 에서 실제 ${achieved[knee].toFixed(1)} req/s 만 달성 — 여기가 포화점(knee). 그 아래(${knee > 0 ? results[knee - 1].rate : "-"} req/s)까지는 p50 이 거의 그대로였다가, 넘는 순간 요청이 큐에 쌓여 p50 까지 수십 배로 뛴다. 개발 서버(Turbopack, 단일 프로세스)의 한계이며 운영 빌드는 훨씬 높다.`);
    ctx.note(`p50: ${d.map((x) => fmt(x.med)).join(" → ")} ms · p99: ${d.map((x) => fmt(x["p(99)"])).join(" → ")} ms — 꼬리(p99)가 중앙값보다 먼저 움직인다.`);
    ctx.check("10 req/s 는 목표 달성, 드롭 없음 (기준선)", achieved[0] >= 8 && results[0].dropped === 0, `${achieved[0].toFixed(1)} req/s, drop=${results[0].dropped}`);
    ctx.check("부하가 오를수록 p95 가 단조 증가", (d[0]["p(95)"] ?? 0) <= (d[1]["p(95)"] ?? 0) && (d[1]["p(95)"] ?? 0) <= (d[2]["p(95)"] ?? 0), d.map((x) => fmt(x["p(95)"])).join(" ≤ "));
    ctx.check("50 req/s 에서 실패(5xx)는 0 — 느려질 뿐 틀리지 않는다", (metric(results[2].s, "http_req_failed").value ?? 1) < 0.05, `${fmt((metric(results[2].s, "http_req_failed").value ?? 0) * 100, 2)}%`);
    ctx.note("dropped_iterations 는 'VU 를 다 써서 예정된 요청을 시작조차 못 함' — 열린 모델이 과부하를 숨기지 않고 드러내는 방식이다. 같은 부하를 VU 고정(닫힌 모델)으로 돌리면 느린 응답을 기다리느라 요청률이 저절로 줄어 p99 가 낮게 '보인다'(조정 누락). 사용자 수가 고정된 내부 도구가 아니면 도착률 실행기를 쓰자.");
  },
};

export const k6RedisPath: ShellExperiment = {
  id: "perf-k6-redis-path",
  subject: "performance",
  title: "부하 중 다운스트림 관찰 — 첫 화면 부하가 Redis ops/s 로 번역된다",
  category: "병목 분석",
  summary: "Redis 를 읽는 첫 화면(/)을 20 req/s 로 10초 치면서 redis-cli INFO 로 처리 명령 수와 instantaneous_ops_per_sec 를 샘플링. '요청 1개 = Redis 명령 N개' 의 증폭 계수를 계산하고, 어디가 병목인지 추론하는 법",
  notes: ["05-data-access-bottlenecks", "02-measurement-methodology"],
  description: `
부하 테스트는 응답 시간만 보면 반쪽이다. **다운스트림**(DB, 캐시)에 무엇이 일어나는지 같이 봐야 병목을 찾는다.
이 앱의 첫 화면은 주제마다 진행률을 Redis 에서 읽는다(SMEMBERS ×2 + SCAN …). 요청 1개가 Redis 명령 몇 개가 되는지(**증폭 계수**)를 재면 "요청 1000 req/s 면 Redis 는 N×1000 ops/s" 로 용량을 계산할 수 있다.
`,
  code: `redis-cli INFO stats | grep total_commands_processed      # 전
k6 run load.js &                                            # / 를 20 req/s × 10s
redis-cli INFO stats | grep instantaneous_ops_per_sec       # 중간에 샘플
redis-cli INFO stats | grep total_commands_processed      # 후
# 증폭 계수 = (후 - 전) / 요청 수
redis-cli --latency -i 1                                    # 부하 중 Redis 자체 RTT`,
  requires: async () => {
    const k = await requiresK6();
    if (k) return k;
    const r = await exec("redis-cli", [...REDIS, "PING"], { timeout: 3000 });
    return r.ok && r.out === "PONG" ? null : "Redis(6379) 에 연결할 수 없습니다 (`pnpm redis` 또는 `pnpm redis:docker`).";
  },
  async run(ctx) {
    const stat = async (name: string) => {
      const r = await exec("redis-cli", [...REDIS, "INFO", "stats"], { timeout: 3000 });
      const m = r.out.match(new RegExp(`${name}:(\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    const before = await stat("total_commands_processed");
    ctx.note(`시작 전 total_commands_processed = ${before}`);
    const script = `
import http from "k6/http";
export const options = { scenarios: { s: { executor: "constant-arrival-rate", rate: 20, timeUnit: "1s", duration: "10s", preAllocatedVUs: 10, maxVUs: 60, gracefulStop: "3s" } } };
export default function () { http.get("${APP}/"); }`;
    const samples: number[] = [];
    const sampler = (async () => {
      for (let i = 0; i < 8; i++) {
        await ctx.sleep(1200);
        samples.push(await stat("instantaneous_ops_per_sec"));
      }
    })();
    const { summary } = await runK6(ctx, script, "k6 GET / 20 req/s × 10s (동시에 Redis 샘플링)");
    await sampler;
    if (!summary) throw new Error("k6 요약을 읽지 못했습니다");
    const after = await stat("total_commands_processed");
    const reqs = metric(summary, "http_reqs").count ?? 0;
    const cmds = after - before;
    const amp = reqs > 0 ? cmds / reqs : 0;
    ctx.table("HTTP 지연", DUR_COLS, [durationRow("GET / @20rps", summary)]);
    ctx.table("Redis 쪽 관찰", ["항목", "값"], [
      ["HTTP 요청 수", String(reqs)],
      ["Redis 명령 수 (후 - 전)", String(cmds)],
      ["증폭 계수 (명령/요청)", amp.toFixed(1)],
      ["instantaneous_ops_per_sec 샘플", samples.join(", ")],
      ["샘플 최대", String(Math.max(0, ...samples))],
    ]);
    ctx.check("부하 중 Redis 명령이 처리됨 (증폭 계수 > 1)", amp > 1, `amp=${amp.toFixed(1)}`);
    ctx.check("요청이 처리됨 (≥ 100)", reqs >= 100, String(reqs));
    const lat = await ctx.sh("redis-cli", [...REDIS, "--latency", "-i", "1", "--raw"], { allowFail: true, timeout: 2500, label: "redis-cli --latency (2초 샘플)" });
    void lat;
    ctx.note(`용량 계산: 첫 화면 1000 req/s 면 Redis 는 약 ${(amp * 1000).toFixed(0)} ops/s — 단일 Redis 의 10만+ ops/s 에 비하면 여유. 병목은 Redis 가 아니라 앱의 SSR(렌더링·직렬 await)일 가능성이 크다 → 트레이스로 span 별 시간을 보자 (/observability).`);
    ctx.note("개선 후보: 주제별 Promise.all 병렬화는 이미 있음. 다음은 progress:* 를 한 번의 SMEMBERS 로 읽고 메모리에서 나누기(증폭 계수 ↓), 또는 짧은 TTL 캐시.");
  },
};

export const nodeEventLoop: ShellExperiment = {
  id: "perf-node-eventloop",
  subject: "performance",
  title: "이벤트 루프 막힘 — 동기 300ms 루프 vs setImmediate 로 쪼갠 루프의 지연 분포",
  category: "프로파일링",
  summary: "Node 의 monitorEventLoopDelay 로 이벤트 루프 지연 히스토그램을 재면서 (a) 300ms 동기 계산, (b) 같은 계산을 5ms 단위로 쪼개 setImmediate 로 양보할 때 p50/p99/max 를 비교. 왜 CPU 작업이 모든 요청의 꼬리 지연이 되는지",
  notes: ["04-node-web-server-performance", "08-tail-latency-at-scale"],
  description: `
Node 는 단일 스레드 이벤트 루프라서 **한 요청의 동기 계산이 다른 모든 요청을 멈춘다**. 타이머·I/O 콜백이 밀리는 시간이 곧 이벤트 루프 지연이고, \`perf_hooks.monitorEventLoopDelay\` 가 그것을 히스토그램으로 준다.
같은 양의 계산도 **쪼개서 양보**하면(setImmediate, 워커 스레드, 또는 큐로 분리) 최대 지연이 작업 단위 크기로 줄어든다. 처리량은 거의 같다 — 지연 분포만 달라진다.
`,
  code: `node -e '
const { monitorEventLoopDelay } = require("node:perf_hooks");
const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
function burn(ms){ const t=Date.now(); while(Date.now()-t<ms){} }
// (a) 300ms 한 번에
burn(300);
setTimeout(()=>{ console.log("blocking: p50", h.percentile(50)/1e6, "p99", h.percentile(99)/1e6, "max", h.max/1e6); h.reset();
  // (b) 5ms 씩 60번, 사이에 setImmediate 로 양보
  let n=0; (function step(){ burn(5); if(++n<60) setImmediate(step); else setTimeout(()=>console.log("chunked: p50", h.percentile(50)/1e6, "p99", h.percentile(99)/1e6, "max", h.max/1e6),50); })();
},50);'`,
  async run(ctx) {
    const js = `
const { monitorEventLoopDelay } = require("node:perf_hooks");
function burn(ms){ const t=Date.now(); while(Date.now()-t<ms){} }
function run(label, fn, done){ const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
  const tick = setInterval(()=>{}, 1);   // 타이머가 밀리는 것을 측정하도록 주기 작업
  const t0 = performance.now();
  fn(()=>{ setTimeout(()=>{ clearInterval(tick); h.disable();
    done({ label, ms: Math.round(performance.now()-t0), p50: h.percentile(50)/1e6, p99: h.percentile(99)/1e6, max: h.max/1e6 }); }, 30); });
}
const out = [];
run("blocking 300ms x1", (cb)=>{ setTimeout(()=>{ burn(300); cb(); }, 20); }, (r)=>{ out.push(r);
  run("chunked 5ms x60 (setImmediate)", (cb)=>{ let n=0; setTimeout(function step(){ burn(5); if(++n<60) setImmediate(step); else cb(); }, 20); }, (r2)=>{ out.push(r2);
    run("chunked 1ms x300", (cb)=>{ let n=0; setTimeout(function step(){ burn(1); if(++n<300) setImmediate(step); else cb(); }, 20); }, (r3)=>{ out.push(r3); console.log(JSON.stringify(out)); });
  });
});`;
    const r = await ctx.sh("node", ["-e", js], { timeout: 30_000, label: "node -e (이벤트 루프 지연 히스토그램 3회)" });
    const rows = JSON.parse(r.out.trim().split("\n").pop() ?? "[]") as { label: string; ms: number; p50: number; p99: number; max: number }[];
    ctx.table("이벤트 루프 지연 (같은 총 계산량 ≈ 300ms)", ["방식", "총 소요 ms", "루프 지연 p50 ms", "p99 ms", "max ms"], rows.map((x) => [x.label, String(x.ms), fmt(x.p50), fmt(x.p99), fmt(x.max)]));
    const [a, b, c] = rows;
    ctx.check("동기 300ms 는 루프 최대 지연 ≥ 250ms", a?.max >= 250, `max=${fmt(a?.max)}`);
    ctx.check("5ms 로 쪼개면 최대 지연이 1/10 이하로", b?.max <= a?.max / 10, `${fmt(b?.max)} vs ${fmt(a?.max)}`);
    ctx.check("1ms 로 쪼개면 더 작아짐", c?.max <= b?.max + 1, `${fmt(c?.max)} vs ${fmt(b?.max)}`);
    ctx.note("총 소요는 거의 같다. 바뀐 것은 '그 동안 다른 요청이 얼마나 기다리나' — 처리량이 아니라 꼬리 지연 문제다. 운영에서는 CPU 작업을 worker_threads 또는 별도 큐(워커 프로세스)로 빼는 것이 정석이고, 이벤트 루프 지연 p99 를 메트릭으로 내보내 알림을 건다(prom-client 의 nodejs_eventloop_lag_seconds).");
  },
};
