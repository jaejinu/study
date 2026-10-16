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
