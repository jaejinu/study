import { logger } from "@/lib/log";
import type { CodeExperiment } from "./types";

const LOKI = "http://127.0.0.1:13100";

async function lokiQuery<T>(path: string, params: Record<string, string>): Promise<T | null> {
  try {
    const u = new URL(`${LOKI}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await fetch(u, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

type RangeResult = { data: { resultType: string; result: { stream?: Record<string, string>; metric?: Record<string, string>; values: [string, string][] }[] } };

export const lokiLogPipeline: CodeExperiment = {
  id: "loki-log-pipeline",
  subject: "observability",
  title: "로그 파이프라인: 구조화 로그가 Loki 에 도착해 LogQL 로 검색·집계되기까지",
  category: "로그",
  summary: "앱 로거로 고유 마커가 든 info/warn/error 로그를 남기고, Alloy → Loki 수집 지연을 재고, 라벨·JSON 파서·필터·메트릭 질의(rate, quantile_over_time)를 Loki API 로 실행해 결과를 확인. trace_id 가 붙는지도",
  notes: ["05-logging-loki", "06-tracing-otel"],
  description: `
로그 한 줄의 여정: \`logger.info()\` → \`logs/app.jsonl\` (+ stdout) → Alloy 가 tail → JSON 파싱으로 level 라벨·trace_id 메타데이터 → Loki 저장 → LogQL.
이 실험은 실제로 로그를 쓰고 Loki 에서 되찾아 **수집 지연**을 재며, LogQL 의 네 가지(선택자, 파이프라인 필터, JSON 필드 조건, 메트릭 질의)를 실행한다.
사전 준비: \`pnpm obs:up\` (Loki·Alloy).
`,
  code: `# 앱: logger.warn("log.lab", { marker: "<id>", durationMs: 123, ... })
# LogQL
{service="study-app"} |= "<marker>"                                   # 문자열 필터
{service="study-app", level="warn"} | json | marker = "<id>"          # 라벨 + JSON 필드
sum by (level) (count_over_time({service="study-app"} |= "<marker>" [5m]))        # 레벨별 개수
quantile_over_time(0.95, {service="study-app"} | json | marker="<id>" | unwrap durationMs [5m])   # 로그로 p95
curl -G localhost:13100/loki/api/v1/query_range --data-urlencode 'query=…'`,
  requires: async () => {
    const ready = await fetch(`${LOKI}/ready`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
    return ready ? null : "Loki(13100) 가 준비되지 않았습니다. `pnpm obs:up` 후 잠시 기다리세요.";
  },
  async run({ rec }) {
    const marker = `lab-${Date.now().toString(36)}`;
    const t0 = Date.now();
    const durations = [12, 48, 95, 330, 410, 880, 1500, 33, 70, 2600];
    durations.forEach((d, i) => {
      const level = d > 1000 ? "error" : d > 300 ? "warn" : "info";
      logger[level]("log.lab", { marker, seq: i, durationMs: d, route: i % 2 ? "/api/x" : "/api/y" });
    });
    rec.steps.push({ cmd: `logger.* × ${durations.length} (marker=${marker}, info 5 / warn 3 / error 2, durationMs 다양)`, result: "written to stdout + logs/app.jsonl", ms: 0 });

    const start = `${(t0 - 60_000) * 1_000_000}`;
    const end = () => `${(Date.now() + 5_000) * 1_000_000}`;
    const first = await rec.measure("Loki 에 도착할 때까지 (Alloy tail → push)", async () => {
      for (let i = 0; i < 60; i++) {
        const r = await lokiQuery<RangeResult>("/loki/api/v1/query_range", { query: `{service="study-app"} |= "${marker}"`, start, end: end(), limit: "100" });
        const n = r?.data.result.reduce((a, s) => a + s.values.length, 0) ?? 0;
        if (n >= durations.length) return `${n}줄, ${Date.now() - t0}ms 후`;
        await new Promise((res) => setTimeout(res, 1000));
      }
      throw new Error("Loki 에 로그가 도착하지 않음 (Alloy 가 logs/app.jsonl 을 읽는지 확인)");
    });
    void first;
    const byLevel = await lokiQuery<RangeResult>("/loki/api/v1/query_range", { query: `{service="study-app"} |= "${marker}"`, start, end: end(), limit: "100" });
    const labels = byLevel?.data.result.map((s) => `${JSON.stringify(s.stream)} ×${s.values.length}`) ?? [];
    rec.steps.push({ cmd: `{service="study-app"} |= "${marker}"  → 스트림(라벨 집합)별`, result: labels, ms: 0 });
    rec.check("level 이 라벨로 승격되어 info/warn/error 스트림이 나뉜다", (byLevel?.data.result.length ?? 0) >= 3);
    const sample = byLevel?.data.result[0]?.values[0]?.[1] ?? "";
    rec.note(/"trace_id":"[0-9a-f]{32}"/.test(sample) ? "로그 줄에 trace_id 가 있다 → Grafana 에서 로그↔트레이스 점프 가능" : "헤드리스 실행이라 활성 span 이 없어 trace_id 가 비어 있다. 웹 실험실에서 실행하면 요청 span 의 trace_id 가 붙는다.");
    rec.steps.push({ cmd: "샘플 로그 줄", result: sample.slice(0, 200), ms: 0 });

    const warnOnly = await lokiQuery<RangeResult>("/loki/api/v1/query_range", { query: `{service="study-app", level="warn"} | json | marker = "${marker}"`, start, end: end(), limit: "100" });
    const warnN = warnOnly?.data.result.reduce((a, s) => a + s.values.length, 0) ?? 0;
    rec.steps.push({ cmd: `{service="study-app", level="warn"} | json | marker = "${marker}"`, result: `${warnN}줄`, ms: 0 });
    rec.check("라벨 필터 + JSON 필드 조건 → warn 3줄", warnN === 3, warnN);

    const counts = await lokiQuery<RangeResult>("/loki/api/v1/query_range", { query: `sum by (level) (count_over_time({service="study-app"} |= "${marker}" [5m]))`, start: `${(Date.now() - 1000) * 1_000_000}`, end: end(), step: "60" });
    const perLevel = Object.fromEntries((counts?.data.result ?? []).map((s) => [s.metric?.level, Number(s.values.at(-1)?.[1] ?? 0)]));
    rec.steps.push({ cmd: `sum by (level) (count_over_time(… [5m]))  (메트릭 질의)`, result: perLevel, ms: 0 });
    rec.check("info 5 / warn 3 / error 2", perLevel.info === 5 && perLevel.warn === 3 && perLevel.error === 2, perLevel);

    const p95 = await lokiQuery<RangeResult>("/loki/api/v1/query_range", { query: `quantile_over_time(0.95, {service="study-app"} | json | marker = "${marker}" | unwrap durationMs [5m])`, start: `${(Date.now() - 1000) * 1_000_000}`, end: end(), step: "60" });
    const p95v = Number(p95?.data.result[0]?.values.at(-1)?.[1] ?? 0);
    rec.steps.push({ cmd: `quantile_over_time(0.95, … | unwrap durationMs [5m])`, result: `${p95v.toFixed(0)}ms`, ms: 0 });
    rec.check("로그의 숫자 필드로 p95 를 계산할 수 있다 (≈ 1500~2600)", p95v >= 1000, p95v);
    const byRoute = await lokiQuery<RangeResult>("/loki/api/v1/query_range", { query: `sum by (route) (count_over_time({service="study-app"} | json | marker = "${marker}" [5m]))`, start: `${(Date.now() - 1000) * 1_000_000}`, end: end(), step: "60" });
    rec.steps.push({ cmd: `sum by (route) (…)  — 라벨이 아닌 JSON 필드로도 집계 가능 (질의 시 파싱, 라벨 폭발 없음)`, result: Object.fromEntries((byRoute?.data.result ?? []).map((s) => [s.metric?.route, Number(s.values.at(-1)?.[1] ?? 0)])), ms: 0 });
    rec.note(`Grafana Explore → Loki 에서 같은 질의를 실행해 보자: {service="study-app"} | json | marker = "${marker}"`);
  },
};

// ---------------------------------------------------------------- CPU 프로파일 (inspector)
import { Session } from "node:inspector/promises";
import fs from "node:fs/promises";
import path from "node:path";

type CpuProfile = { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] }[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };

export const obsCpuProfile: CodeExperiment = {
  id: "obs-cpu-profile",
  subject: "observability",
  title: "CPU 프로파일: inspector 로 이 프로세스를 2초 샘플링해 어느 함수가 CPU 를 먹는지 본다",
  category: "프로파일링",
  summary: "node:inspector 세션으로 Profiler.start → 의도적으로 무거운 동기 작업(JSON 직렬화·정렬·해시)을 섞어 돌린 뒤 → Profiler.stop. 샘플 수·간격, self time 상위 함수 표, 프로파일을 logs/cpu-profile-*.cpuprofile 로 저장(Chrome DevTools · speedscope 로 열기)",
  notes: ["10-continuous-profiling", "06-tracing-otel"],
  description: `
메트릭은 "CPU 가 80%" 라고 알려 주고 트레이스는 "이 요청이 느리다" 를 알려 준다. **어느 코드 줄이** CPU 를 쓰는지는 **프로파일**만 안다.
Node 는 V8 샘플링 프로파일러를 \`node:inspector\` 로 노출한다: 일정 간격(기본 1ms 안팎)으로 스택을 찍고, 같은 스택을 합쳐 트리로 만든다. **self time** 이 큰 함수가 최적화 대상이다(flame graph 의 넓고 평평한 꼭대기).
이 실험은 실행 중인 프로세스 안에서 프로파일러를 켰다 끄고(운영에서 연속 프로파일링이 하는 일과 같다) 상위 함수를 표로 보여 준다. 저장된 \`.cpuprofile\` 은 Chrome DevTools(Performance → Load) 나 speedscope.app 에 끌어다 놓으면 flame graph 가 된다.
`,
  code: `import { Session } from "node:inspector/promises";
const s = new Session(); s.connect();
await s.post("Profiler.enable"); await s.post("Profiler.setSamplingInterval", { interval: 500 }); await s.post("Profiler.start");
// … 워크로드 …
const { profile } = await s.post("Profiler.stop");   // nodes[].callFrame, hitCount, samples[], timeDeltas[]
fs.writeFile("logs/cpu-profile.cpuprofile", JSON.stringify(profile));
# CLI 대안: node --cpu-prof app.js  → *.cpuprofile  /  연속 프로파일링: Pyroscope · Parca`,
  async run({ rec }) {
    const session = new Session();
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 500 });
    await session.post("Profiler.start");
    rec.note("프로파일러 시작 (샘플 간격 500µs). 2초 동안 세 종류의 동기 작업을 섞어 돌린다");

    function heavyJsonRoundtrip(n: number) {
      let bytes = 0;
      for (let i = 0; i < n; i++) {
        const o = { id: i, tags: ["a", "b", "c"], nested: { x: i * 2, s: "x".repeat(50) } };
        bytes += JSON.stringify(JSON.parse(JSON.stringify(o))).length;
      }
      return bytes;
    }
    function heavySort(n: number) {
      const arr = Array.from({ length: n }, (_, i) => (i * 7919) % 10007);
      arr.sort((a, b) => a - b);
      return arr[0];
    }
    function heavyHash(n: number) {
      let h = 2166136261;
      for (let i = 0; i < n; i++) h = Math.imul(h ^ (i & 255), 16777619) >>> 0;
      return h;
    }
    const t0 = performance.now();
    let rounds = 0;
    while (performance.now() - t0 < 2000) {
      heavyJsonRoundtrip(2000);
      heavySort(50_000);
      heavyHash(2_000_000);
      rounds++;
      await new Promise((r) => setImmediate(r)); // 이벤트 루프에 숨 쉴 틈
    }
    const { profile } = (await session.post("Profiler.stop")) as { profile: CpuProfile };
    session.disconnect();
    const durationMs = Math.round((profile.endTime - profile.startTime) / 1000);
    rec.steps.push({ cmd: "워크로드", result: `${rounds} 라운드 (JSON 왕복 2000건 + 정렬 5만 + 해시 200만) in ${Math.round(performance.now() - t0)}ms`, ms: 0 });
    rec.steps.push({ cmd: "프로파일 요약", result: { durationMs, samples: profile.samples.length, nodes: profile.nodes.length, avgIntervalUs: Math.round(profile.timeDeltas.reduce((a, b) => a + b, 0) / Math.max(1, profile.timeDeltas.length)) }, ms: 0 });
    rec.check("샘플이 수백 개 이상 모였다", profile.samples.length > 300, profile.samples.length);

    // self time: samples[] 의 각 노드 id 가 몇 번 찍혔나 × 간격
    const selfCount = new Map<number, number>();
    for (const id of profile.samples) selfCount.set(id, (selfCount.get(id) ?? 0) + 1);
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    // total time: 자신 + 자손 샘플
    const totalCount = new Map<number, number>();
    for (const [id, c] of selfCount) { let cur: number | undefined = id; while (cur !== undefined) { totalCount.set(cur, (totalCount.get(cur) ?? 0) + c); cur = parent.get(cur); } }
    const total = profile.samples.length;
    const name = (id: number) => { const n = byId.get(id)!; const fn = n.callFrame.functionName || "(anonymous)"; const file = n.callFrame.url ? path.basename(n.callFrame.url) + ":" + (n.callFrame.lineNumber + 1) : ""; return `${fn}${file ? ` ${file}` : ""}`; };
    const top = [...selfCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, c]) => ({ fn: name(id), self: `${((c / total) * 100).toFixed(1)}%`, total: `${(((totalCount.get(id) ?? 0) / total) * 100).toFixed(1)}%` }));
    rec.steps.push({ cmd: "self time 상위 10 함수 (자기 자신이 CPU 를 쓴 비율 / 자손 포함)", result: top, ms: 0 });
    const ours = top.filter((t) => /heavy(JsonRoundtrip|Sort|Hash)|JSON|sort|parse|stringify/.test(t.fn));
    rec.check("의도한 무거운 함수(JSON/정렬/해시)가 상위에 보인다", ours.length >= 2, top.slice(0, 5).map((t) => t.fn));
    const idle = top.find((t) => /\(idle\)|\(program\)|\(garbage collector\)/.test(t.fn));
    rec.note(idle ? `특수 노드 ${idle.fn} ${idle.self}: (idle)=이벤트 루프 대기, (program)=네이티브/V8 내부, (garbage collector)=GC. GC 비율이 높으면 할당을 줄이는 것이 최적화` : "(idle)/(garbage collector) 비율도 함께 보자 — GC 가 높으면 할당 패턴이 문제");
    const file = path.join(process.cwd(), "logs", `cpu-profile-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(profile));
    rec.steps.push({ cmd: "저장", result: `${file} — Chrome DevTools Performance 탭 'Load profile' 또는 https://www.speedscope.app 에 드롭하면 flame graph`, ms: 0 });
    rec.note("운영에선 이걸 Pyroscope/Parca 에이전트가 10초마다 자동으로 하고(연속 프로파일링), 트레이스의 span 과 프로파일을 trace_id 로 잇는다 (노트 10).");
  },
};
