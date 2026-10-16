import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "./runner";
import type { ShellExperiment } from "./types";

/**
 * 비용 실험들의 단가는 전부 "가정" 이다. 실제 청구서가 아니라 모델링 연습용이며, 실험 결과 표에 가정을 함께 적는다.
 * 대략 주요 클라우드의 범용 온디맨드 인스턴스를 vCPU·GiB 로 쪼갠 수준 (2026 년 공개가 기준 근사치).
 */
const PRICE = {
  vcpuHour: 0.0316, // USD / vCPU·시간
  gibHour: 0.0042, // USD / GiB·시간
  hoursPerMonth: 730,
};

const KCTX = ["--context", "kind-study"];

function cpuMilli(v: string | undefined): number {
  if (!v) return 0;
  if (v.endsWith("m")) return Number(v.slice(0, -1));
  if (v.endsWith("n")) return Number(v.slice(0, -1)) / 1e6;
  if (v.endsWith("u")) return Number(v.slice(0, -1)) / 1e3;
  return Number(v) * 1000;
}

function memMi(v: string | undefined): number {
  if (!v) return 0;
  const m = v.match(/^([\d.]+)([A-Za-z]*)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit: Record<string, number> = { "": 1 / 1048576, Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576, k: 1000 / 1048576 };
  return n * (unit[m[2]] ?? 1);
}

const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

// ---------------------------------------------------------------- 1. requests vs 실사용
type PodJson = {
  items: {
    metadata: { name: string; namespace: string };
    status: { phase?: string; qosClass?: string };
    spec: { containers: { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }[] };
  }[];
};

export const finopsK8sRequestsVsUsage: ShellExperiment = {
  id: "finops-k8s-requests-vs-usage",
  subject: "finops",
  title: "Kubernetes 비용의 정체: requests 는 예약이고 사용량은 따로다 — 네임스페이스별 과다 요청과 유휴 비용을 계산한다",
  category: "Kubernetes 비용",
  summary: "kind-study 의 Running Pod 전부에서 CPU·메모리 requests 를 합치고 metrics-server(kubectl top)의 실사용과 네임스페이스별로 나란히 놓는다. requests 가 아예 없는 BestEffort Pod 수, max(요청, 사용) 기준 배분 비용, 노드 용량 중 아무도 예약하지 않은 유휴 비용을 가정 단가로 월 환산한다 (OpenCost 의 배분 공식과 같은 사고방식)",
  notes: ["03-kubernetes-cost", "02-unit-economics", "01-cloud-cost-model"],
  description: `
클라우드에서 돈을 내는 단위는 **노드(VM)** 다. 그런데 Kubernetes 에서 노드를 몇 대 띄울지는 Pod 의 **requests(예약)** 가 정한다 — 스케줄러는 실사용이 아니라 requests 합으로 노드를 채운다.
그래서 비용 질문은 세 개로 쪼개진다.
1. **배분(allocation)**: 이 네임스페이스는 노드의 얼마를 차지했나? OpenCost 는 컨테이너마다 \`max(request, usage)\` 를 쓴다. 예약했으면 안 써도 남이 못 쓰니 내 비용이고, 예약보다 더 썼으면 그만큼도 내 비용이다.
2. **효율**: requests 중 실제로 쓴 비율. 10~30% 면 "돈을 내고 비워 둔" 자리가 70~90% 라는 뜻이다.
3. **유휴(idle)**: 노드 용량 중 아무에게도 배분되지 않은 부분. 노드를 줄이거나(빈 패킹) 요청을 맞추면 사라진다.
requests 가 없는 Pod(BestEffort)는 배분 계산에서 0 으로 보이고, 스케줄러가 과밀 배치하며, 메모리 압박 때 가장 먼저 쫓겨난다. 비용 가시성의 첫 단계는 "모든 Pod 에 requests" 다.
`,
  code: `kubectl get pods -A -o json | jq '…requests 합…'          # 예약
kubectl top pods -A --no-headers                           # 실사용 (metrics-server)
kubectl get nodes -o jsonpath='{.items[*].status.allocatable}'
# 네임스페이스 배분 = Σ 컨테이너 max(request, usage) × 단가
# 유휴 = 노드 용량 - Σ 배분`,
  requires: async () => {
    const r = await exec("kubectl", [...KCTX, "top", "pods", "-A", "--no-headers", "--request-timeout=8s"], { timeout: 15_000 });
    if (!r.ok) return "kind-study 클러스터와 metrics-server 가 필요합니다 (`pnpm k8s:cluster && pnpm k8s:metrics`). `kubectl --context kind-study top pods -A` 가 동작해야 합니다.";
    return null;
  },
  async run(ctx) {
    ctx.note(`가정 단가: vCPU·시간 $${PRICE.vcpuHour}, GiB·시간 $${PRICE.gibHour}, 월 ${PRICE.hoursPerMonth}시간 (범용 온디맨드 근사치. 실제 청구가 아니라 모델링용)`);
    const podsRaw = await ctx.sh("kubectl", [...KCTX, "get", "pods", "-A", "-o", "json"], { label: "kubectl get pods -A -o json   # requests 수집" });
    const pods = JSON.parse(podsRaw.out) as PodJson;
    const top = await ctx.sh("kubectl", [...KCTX, "top", "pods", "-A", "--no-headers"], { label: "kubectl top pods -A --no-headers   # 실사용 (metrics-server, 최근 수십 초 평균)" });
    const usage = new Map<string, { cpu: number; mem: number }>();
    for (const line of top.out.split("\n").filter(Boolean)) {
      const [ns, name, cpu, mem] = line.trim().split(/\s+/);
      usage.set(`${ns}/${name}`, { cpu: cpuMilli(cpu), mem: memMi(mem) });
    }
    const nodes = JSON.parse((await ctx.sh("kubectl", [...KCTX, "get", "nodes", "-o", "json"], { label: "kubectl get nodes -o json   # 노드 용량(allocatable)" })).out) as { items: { status: { allocatable: Record<string, string> } }[] };
    const capCpu = nodes.items.reduce((a, n) => a + cpuMilli(n.status.allocatable.cpu), 0);
    const capMem = nodes.items.reduce((a, n) => a + memMi(n.status.allocatable.memory), 0);

    type Row = { pods: number; bestEffort: number; reqCpu: number; useCpu: number; reqMem: number; useMem: number; allocCpu: number; allocMem: number };
    const byNs = new Map<string, Row>();
    for (const p of pods.items) {
      if (p.status.phase !== "Running") continue;
      const ns = p.metadata.namespace;
      const row = byNs.get(ns) ?? { pods: 0, bestEffort: 0, reqCpu: 0, useCpu: 0, reqMem: 0, useMem: 0, allocCpu: 0, allocMem: 0 };
      row.pods++;
      if (p.status.qosClass === "BestEffort") row.bestEffort++;
      const reqCpu = p.spec.containers.reduce((a, c) => a + cpuMilli(c.resources?.requests?.cpu), 0);
      const reqMem = p.spec.containers.reduce((a, c) => a + memMi(c.resources?.requests?.memory), 0);
      const u = usage.get(`${ns}/${p.metadata.name}`) ?? { cpu: 0, mem: 0 };
      row.reqCpu += reqCpu;
      row.reqMem += reqMem;
      row.useCpu += u.cpu;
      row.useMem += u.mem;
      // OpenCost 식 배분: Pod 단위 max(request, usage)
      row.allocCpu += Math.max(reqCpu, u.cpu);
      row.allocMem += Math.max(reqMem, u.mem);
      byNs.set(ns, row);
    }
    const monthly = (cpuM: number, memMiB: number) => ((cpuM / 1000) * PRICE.vcpuHour + (memMiB / 1024) * PRICE.gibHour) * PRICE.hoursPerMonth;
    const rows = [...byNs.entries()].sort((a, b) => monthly(b[1].allocCpu, b[1].allocMem) - monthly(a[1].allocCpu, a[1].allocMem));
    ctx.table(
      "네임스페이스별 예약 vs 실사용 (CPU 는 millicore, 메모리는 MiB)",
      ["네임스페이스", "Pod", "BestEffort", "CPU 요청", "CPU 사용", "CPU 효율", "Mem 요청", "Mem 사용", "배분 비용/월"],
      rows.map(([ns, r]) => [
        ns,
        String(r.pods),
        r.bestEffort ? `${r.bestEffort}` : "0",
        fmt(r.reqCpu),
        fmt(r.useCpu),
        r.reqCpu ? `${((r.useCpu / r.reqCpu) * 100).toFixed(0)}%` : "요청 없음",
        fmt(r.reqMem),
        fmt(r.useMem),
        usd(monthly(r.allocCpu, r.allocMem)),
      ]),
    );
    const tot = rows.reduce((a, [, r]) => ({ reqCpu: a.reqCpu + r.reqCpu, useCpu: a.useCpu + r.useCpu, reqMem: a.reqMem + r.reqMem, useMem: a.useMem + r.useMem, allocCpu: a.allocCpu + r.allocCpu, allocMem: a.allocMem + r.allocMem, pods: a.pods + r.pods, be: a.be + r.bestEffort }), { reqCpu: 0, useCpu: 0, reqMem: 0, useMem: 0, allocCpu: 0, allocMem: 0, pods: 0, be: 0 });
    const clusterCost = monthly(capCpu, capMem);
    const allocCost = monthly(tot.allocCpu, tot.allocMem);
    ctx.table("클러스터 전체", ["항목", "CPU (m)", "메모리 (MiB)", "월 비용(가정)"], [
      ["노드 용량 (allocatable)", fmt(capCpu), fmt(capMem), usd(clusterCost)],
      ["requests 합 (예약)", fmt(tot.reqCpu), fmt(tot.reqMem), usd(monthly(tot.reqCpu, tot.reqMem))],
      ["실사용 합", fmt(tot.useCpu), fmt(tot.useMem), usd(monthly(tot.useCpu, tot.useMem))],
      ["배분 합 Σmax(요청, 사용)", fmt(tot.allocCpu), fmt(tot.allocMem), usd(allocCost)],
      ["유휴 = 용량 - 배분", fmt(capCpu - tot.allocCpu), fmt(capMem - tot.allocMem), usd(clusterCost - allocCost)],
    ]);
    ctx.check("Running Pod 의 requests 와 실사용을 모두 수집했다", tot.pods > 0 && usage.size > 0, `Pod ${tot.pods}개, top ${usage.size}행`);
    ctx.check("배분은 언제나 예약과 실사용 중 큰 쪽 이상이다 (max 공식)", tot.allocCpu >= Math.max(tot.reqCpu, tot.useCpu) - 1);
    const idlePct = ((clusterCost - allocCost) / clusterCost) * 100;
    ctx.note(`이 클러스터는 노드 비용의 ${idlePct.toFixed(0)}% 가 유휴다. 로컬 kind 노드는 Mac 전체(CPU ${fmt(capCpu / 1000)}개)를 노드 용량으로 보고하니 유휴가 크게 나오는 게 정상 — 클라우드라면 이 숫자가 "노드를 줄여도 되는 양" 이다.`);
    ctx.note(`requests 가 없는 BestEffort Pod 가 ${tot.be}개다(전체 ${tot.pods}개). 이 Pod 들은 배분 표에서 실사용만큼만 보이고, 스케줄러는 0 으로 보고 과밀 배치한다. 비용 가시성과 안정성 둘 다를 위해 requests 를 넣는 것이 FinOps 의 첫 액션이다.`);
    const worst = rows.filter(([, r]) => r.reqCpu >= 100).map(([ns, r]) => ({ ns, eff: r.useCpu / r.reqCpu })).sort((a, b) => a.eff - b.eff)[0];
    if (worst) ctx.note(`CPU 효율이 가장 낮은 곳: ${worst.ns} (${(worst.eff * 100).toFixed(0)}%). 운영이라면 VPA 권고값이나 p95 사용량 × 1.2~1.5 로 requests 를 낮추는 후보다.`);
  },
};

// ---------------------------------------------------------------- 2. 관측 데이터 볼륨
type TsdbStatus = {
  data: {
    headStats: { numSeries: number; chunkCount: number; minTime: number; maxTime: number };
    seriesCountByMetricName: { name: string; value: number }[];
    labelValueCountByLabelName: { name: string; value: number }[];
  };
};

async function promQuery(base: string, q: string): Promise<number | null> {
  try {
    const r = await fetch(`${base}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { data?: { result?: { value: [number, string] }[] } };
    const v = j.data?.result?.[0]?.value?.[1];
    return v === undefined ? null : Number(v);
  } catch {
    return null;
  }
}

async function metricValue(url: string, name: string): Promise<number | null> {
  try {
    const t = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text();
    let sum = 0;
    let found = false;
    for (const line of t.split("\n")) {
      if (line.startsWith(name) && (line[name.length] === " " || line[name.length] === "{")) {
        sum += Number(line.trim().split(/\s+/).pop());
        found = true;
      }
    }
    return found ? sum : null;
  } catch {
    return null;
  }
}

export const finopsObservabilityVolume: ShellExperiment = {
  id: "finops-observability-volume",
  subject: "finops",
  title: "관측 비용은 볼륨 × 보존이다: 메트릭 시계열 수·카디널리티 주범, 로그 수집 바이트를 재고 월 비용을 모델링한다",
  category: "관측 비용",
  summary: "이 프로젝트의 Prometheus 에서 활성 시계열 수와 초당 샘플 수, 시계열을 가장 많이 만드는 메트릭(히스토그램 _bucket)과 값이 많은 레이블을 TSDB 상태 API 로 뽑고, Loki 수집 바이트·라인과 앱 로그 파일 크기를 더해 관리형 관측 서비스 단가(가정)로 월 비용을 환산한다. 보존 기간·버킷 수를 바꾸면 얼마나 줄어드는지도 계산한다",
  notes: ["04-data-observability-cost", "06-governance"],
  description: `
관리형 관측 서비스는 대체로 **메트릭은 활성 시계열 수**, **로그는 수집 GB 와 보존 GB-월**, **트레이스는 스팬 수(또는 GB)** 로 청구한다. 즉 비용 = 볼륨 × 단가 × 보존.
메트릭에서 볼륨을 키우는 범인은 거의 항상 **카디널리티**다. 시계열 수 = 메트릭 × 레이블 값 조합. 히스토그램 하나는 버킷 수(예: 15) × 레이블 조합만큼 시계열을 만들고, 사용자 ID·URL 원문 같은 레이블 하나가 수만 배를 만든다.
이 실험은 실제 Prometheus 의 \`/api/v1/status/tsdb\` 로 상위 메트릭·레이블을 뽑아 "어디를 줄이면 되는지" 를 숫자로 본다. 로그는 Loki 의 수집 카운터로 하루 볼륨을 추정한다.
`,
  code: `curl -s localhost:19090/api/v1/status/tsdb | jq '.data.headStats, .data.seriesCountByMetricName[:10]'
curl -s 'localhost:19090/api/v1/query?query=rate(prometheus_tsdb_head_samples_appended_total[5m])'
curl -s localhost:13100/metrics | grep -E 'loki_distributor_(bytes|lines)_received_total'
ls -la logs/app.jsonl`,
  requires: async () => {
    const ok = await fetch("http://127.0.0.1:19090/-/ready", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
    return ok ? null : "관측 스택이 필요합니다: `pnpm obs:up` (Prometheus 19090, Loki 13100).";
  },
  async run(ctx) {
    const PROM = "http://127.0.0.1:19090";
    const tsdb = (await (await fetch(`${PROM}/api/v1/status/tsdb`, { signal: AbortSignal.timeout(5000) })).json()) as TsdbStatus;
    ctx.note("curl localhost:19090/api/v1/status/tsdb   # 헤드 블록(최근 ~2시간)의 시계열·카디널리티 통계");
    const series = tsdb.data.headStats.numSeries;
    const top = tsdb.data.seriesCountByMetricName.slice(0, 10);
    const topSum = top.reduce((a, m) => a + m.value, 0);
    ctx.table(`시계열을 가장 많이 만드는 메트릭 상위 10 (전체 활성 시계열 ${fmt(series)}개)`, ["메트릭", "시계열", "비율"], top.map((m) => [m.name, fmt(m.value), `${((m.value / series) * 100).toFixed(1)}%`]));
    const buckets = top.filter((m) => m.name.endsWith("_bucket"));
    const bucketShare = buckets.reduce((a, m) => a + m.value, 0) / series;
    ctx.check("TSDB 상태 API 로 활성 시계열과 상위 메트릭을 얻었다", series > 0 && top.length > 0, `${series} 시계열`);
    ctx.note(`상위 10개가 전체의 ${((topSum / series) * 100).toFixed(0)}% 다. 그중 히스토그램 버킷(_bucket)이 ${buckets.length}개로 전체의 ${(bucketShare * 100).toFixed(0)}% — 버킷 수 × 레이블 조합이 곱해지기 때문이다.`);
    ctx.table("값이 가장 많은 레이블 (카디널리티 폭발의 용의자)", ["레이블", "고유 값 수"], tsdb.data.labelValueCountByLabelName.slice(0, 8).map((l) => [l.name, fmt(l.value)]));

    const samplesPerSec = (await promQuery(PROM, "sum(rate(prometheus_tsdb_head_samples_appended_total[5m]))")) ?? 0;
    const blocksBytes = (await promQuery(PROM, "sum(prometheus_tsdb_storage_blocks_bytes)")) ?? 0;
    const retention = (await promQuery(PROM, "max(prometheus_tsdb_retention_limit_seconds)")) ?? 0;
    const lokiBytes = await metricValue("http://127.0.0.1:13100/metrics", "loki_distributor_bytes_received_total");
    const lokiLines = await metricValue("http://127.0.0.1:13100/metrics", "loki_distributor_lines_received_total");
    // Loki 는 Prometheus 에 스크레이프되지 않으므로 자기 /metrics 의 시작 시각으로 가동 시간을 구한다
    const lokiStart = await metricValue("http://127.0.0.1:13100/metrics", "process_start_time_seconds");
    const lokiUptimeH = lokiStart ? (Date.now() / 1000 - lokiStart) / 3600 : null;
    let appLog = 0;
    let appLines = 0;
    try {
      const f = path.join(process.cwd(), "logs", "app.jsonl");
      appLog = (await fs.stat(f)).size;
      appLines = (await fs.readFile(f, "utf8")).split("\n").filter(Boolean).length;
    } catch {
      /* 없음 */
    }
    ctx.table("측정한 볼륨", ["항목", "값"], [
      ["활성 시계열 (head)", fmt(series)],
      ["수집 샘플/초", fmt(samplesPerSec, 1)],
      ["샘플/일 (추정)", fmt(samplesPerSec * 86400)],
      ["Prometheus 디스크 블록", `${(blocksBytes / 1048576).toFixed(1)} MiB`],
      ["Prometheus 보존 한도", retention ? `${(retention / 86400).toFixed(0)}일` : "기본(15일)"],
      ["Loki 누적 수집", lokiBytes !== null ? `${(lokiBytes / 1048576).toFixed(1)} MiB / ${fmt(lokiLines ?? 0)}줄` : "Loki 메트릭 없음"],
      ["Loki 가동 시간", lokiUptimeH ? `${lokiUptimeH.toFixed(1)}시간` : "?"],
      ["앱 로그 파일 logs/app.jsonl", `${(appLog / 1024).toFixed(0)} KiB / ${fmt(appLines)}줄 (평균 ${appLines ? (appLog / appLines).toFixed(0) : 0} B/줄)`],
    ]);

    // 관리형 서비스 단가 가정
    const P = { perKSeriesMonth: 8, logIngestGB: 0.5, logRetainGBMonth: 0.1 };
    const logGBPerDay = lokiBytes !== null && lokiUptimeH ? lokiBytes / 1e9 / (lokiUptimeH / 24) : 0;
    const metricCost = (series / 1000) * P.perKSeriesMonth;
    const logIngest = logGBPerDay * 30 * P.logIngestGB;
    const logRetain = (d: number) => logGBPerDay * d * P.logRetainGBMonth;
    ctx.table(`월 비용 모델 (가정: 시계열 1천 개당 $${P.perKSeriesMonth}/월, 로그 수집 $${P.logIngestGB}/GB, 보존 $${P.logRetainGBMonth}/GB-월)`, ["시나리오", "메트릭", "로그 수집", "로그 보존", "합계"], [
      ["지금 그대로 (로그 30일 보존)", usd(metricCost), usd(logIngest), usd(logRetain(30)), usd(metricCost + logIngest + logRetain(30))],
      ["히스토그램 버킷 절반으로", usd(metricCost * (1 - bucketShare / 2)), usd(logIngest), usd(logRetain(30)), usd(metricCost * (1 - bucketShare / 2) + logIngest + logRetain(30))],
      ["로그 보존 7일", usd(metricCost), usd(logIngest), usd(logRetain(7)), usd(metricCost + logIngest + logRetain(7))],
      ["트래픽 100배 (로그는 선형, 시계열은 거의 그대로)", usd(metricCost * 1.1), usd(logIngest * 100), usd(logRetain(30) * 100), usd(metricCost * 1.1 + logIngest * 100 + logRetain(30) * 100)],
    ]);
    ctx.check("메트릭·로그 볼륨으로 월 비용 시나리오를 계산했다", metricCost > 0);
    ctx.note("핵심 비대칭: 메트릭 비용은 트래픽이 아니라 카디널리티(레이블 조합)에 비례하고, 로그 비용은 트래픽에 비례한다. 그래서 대규모에선 '셀 수 있는 건 메트릭으로, 로그는 샘플링·레벨 필터' 가 정석이다.");
    ctx.note("레이블 하나를 지우면 얼마나 줄지 미리 보려면: count(count by (le, instance)(redis_commands_latencies_usec_bucket)) 처럼 남길 레이블만으로 다시 세어 본다.");
  },
};

// ---------------------------------------------------------------- 3. LLM 토큰 비용
const OLLAMA = "http://127.0.0.1:11434";
const MODEL = process.env.FINOPS_OLLAMA_MODEL ?? "qwen2.5:1.5b";

type OllamaChat = { prompt_eval_count?: number; eval_count?: number; prompt_eval_duration?: number; eval_duration?: number; total_duration?: number };

async function ollamaChat(system: string, user: string, maxTokens: number): Promise<OllamaChat & { wallMs: number }> {
  const t0 = performance.now();
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false, options: { num_predict: maxTokens, temperature: 0 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = (await r.json()) as OllamaChat;
  return { ...j, wallMs: Math.round(performance.now() - t0) };
}

/** 공개 단가 근사치 (USD / 1M 토큰). 캐시된 입력은 보통 기본 입력의 10% */
const LLM_PRICE: { model: string; input: number; cached: number; output: number }[] = [
  { model: "gpt-5", input: 1.25, cached: 0.125, output: 10 },
  { model: "gpt-5-mini", input: 0.25, cached: 0.025, output: 2 },
  { model: "gpt-5-nano", input: 0.05, cached: 0.005, output: 0.4 },
];

export const finopsLlmTokenCost: ShellExperiment = {
  id: "finops-llm-token-cost",
  subject: "finops",
  title: "LLM 비용은 토큰이다: 긴 시스템 프롬프트·출력 길이·프리픽스 캐시가 토큰과 지연, 월 비용을 어떻게 바꾸는지 로컬 모델로 잰다",
  category: "LLM 비용",
  summary: "로컬 Ollama(qwen2.5:1.5b)에 짧은 프롬프트와 노트 한 편 크기의 긴 시스템 프롬프트를 보내 입력·출력 토큰 수를 재고, 같은 프리픽스를 다시 보냈을 때 prefill 시간이 얼마나 줄어드는지(KV 캐시) 측정한다. 측정한 토큰으로 상용 모델 단가(가정)에서 요청당·월 비용을 계산하고, 캐시 할인·출력 제한·작은 모델 라우팅의 절감액을 비교한다. 앱의 study_llm_* 메트릭이 있으면 함께 보여 준다",
  notes: ["05-llm-token-cost", "02-unit-economics"],
  description: `
LLM API 는 **입력 토큰 + 출력 토큰** 으로 청구한다. 출력 토큰 단가는 입력의 4~8배다. 그리고 많은 제공자가 **같은 프리픽스(시스템 프롬프트·도구 정의·문서)를 반복해서 보내면 캐시된 입력으로 할인**한다(보통 90%).
이 사이트의 "AI 에게 묻기" 는 노트 본문(수천 토큰)을 시스템 프롬프트에 넣는다. 질문은 짧은데 입력이 길다 — 전형적인 "캐시가 돈을 아끼는" 형태다.
로컬 모델은 돈이 들지 않지만 **토큰 수와 시간은 진짜**다. Ollama 는 응답에 \`prompt_eval_count\`(입력 토큰), \`eval_count\`(출력 토큰), \`prompt_eval_duration\`(prefill 시간)을 준다. 같은 프리픽스를 다시 보내면 KV 캐시 덕에 prefill 이 거의 0 이 된다 — 상용 API 의 캐시 할인이 존재하는 이유가 바로 이 계산 절감이다.
`,
  code: `curl -s localhost:11434/api/chat -d '{"model":"qwen2.5:1.5b","stream":false,"options":{"num_predict":64},
  "messages":[{"role":"system","content":"<노트 본문>"},{"role":"user","content":"이중 쓰기 문제가 뭐야?"}]}' \\
  | jq '{prompt_eval_count, eval_count, prefill_ms: (.prompt_eval_duration/1e6)}'
curl -s localhost:3000/api/metrics | grep study_llm_   # 앱이 기록한 토큰·비용`,
  requires: async () => {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((x) => x.json() as Promise<{ models: { name: string }[] }>).catch(() => null);
    if (!r) return "Ollama 가 필요합니다: `brew install ollama && ollama serve`, 그리고 `ollama pull qwen2.5:1.5b`.";
    if (!r.models.some((m) => m.name === MODEL)) return `Ollama 에 ${MODEL} 모델이 없습니다: \`ollama pull ${MODEL}\``;
    return null;
  },
  async run(ctx) {
    // 노트 한 편 크기의 시스템 프롬프트 (실제 노트 본문 사용)
    let noteBody = "";
    try {
      noteBody = (await fs.readFile(path.join(process.cwd(), "content/kafka/notes/08-cdc-outbox-debezium.md"), "utf8")).slice(0, 14000);   // AskPanel 과 같은 상한
    } catch {
      noteBody = "Outbox 와 CDC 는 이중 쓰기 문제를 트랜잭션 하나로 줄인다. ".repeat(200);
    }
    const shortSys = "너는 학습 도우미다. 짧게 답한다.";
    // 맨 앞에 실행마다 다른 값을 넣어 이전 실행의 KV 캐시와 겹치지 않게 한다 (첫 호출을 확실히 콜드로)
    const longSys = `[세션 ${Date.now().toString(36)}] 너는 학습 도우미다. 아래 노트를 근거로 짧게 답한다.\n\n${noteBody}`;
    ctx.note(`모델 ${MODEL} (로컬, 무료). 긴 시스템 프롬프트 = kafka/08-cdc-outbox-debezium 노트 앞 ${noteBody.length.toLocaleString()}자 (AI 에게 묻기 패널이 노트 본문을 넣는 것과 같은 형태)`);

    const a = await ctx.measure("짧은 시스템 프롬프트 + 질문 (출력 64토큰 제한)", () => ollamaChat(shortSys, "이중 쓰기 문제가 뭐야?", 64));
    const b = await ctx.measure("긴 시스템 프롬프트 + 질문 — 첫 호출 (캐시 없음)", () => ollamaChat(longSys, "이중 쓰기 문제가 뭐야?", 64));
    const c = await ctx.measure("같은 긴 프리픽스 + 다른 질문 — 두 번째 호출 (KV 캐시 재사용)", () => ollamaChat(longSys, "복제 슬롯이 왜 위험해?", 64));
    const d = await ctx.measure("같은 프리픽스, 출력 제한 256토큰", () => ollamaChat(longSys, "Debezium 운영 함정을 자세히 설명해 줘", 256));
    const rows = [
      ["짧은 프롬프트", a.value],
      ["긴 프롬프트 (첫 호출)", b.value],
      ["긴 프롬프트 (캐시 적중)", c.value],
      ["긴 프롬프트, 출력 256", d.value],
    ] as const;
    ctx.table("토큰과 시간 (Ollama 응답 필드)", ["경우", "입력 토큰", "출력 토큰", "prefill(ms)", "생성(ms)", "전체(ms)"], rows.map(([k, r]) => [k, fmt(r.prompt_eval_count ?? 0), fmt(r.eval_count ?? 0), fmt((r.prompt_eval_duration ?? 0) / 1e6), fmt((r.eval_duration ?? 0) / 1e6), fmt(r.wallMs)]));
    const inLong = b.value.prompt_eval_count ?? 0;
    const inShort = a.value.prompt_eval_count ?? 0;
    const prefillCold = (b.value.prompt_eval_duration ?? 0) / 1e6;
    const prefillWarm = (c.value.prompt_eval_duration ?? 0) / 1e6;
    ctx.check("노트를 시스템 프롬프트에 넣으면 입력 토큰이 수십 배 늘어난다", inLong > inShort * 10, `${inShort} → ${inLong}`);
    ctx.check("같은 프리픽스를 다시 보내면 prefill 시간이 크게 줄어든다 (KV 캐시)", prefillWarm < prefillCold * 0.6, `${prefillCold.toFixed(0)}ms → ${prefillWarm.toFixed(0)}ms`);
    ctx.note(`Ollama 는 캐시된 프리픽스도 입력 토큰 수(${fmt(c.value.prompt_eval_count ?? 0)})로 보고하지만 실제 계산은 ${(100 - (prefillWarm / Math.max(prefillCold, 1)) * 100).toFixed(0)}% 줄었다. 상용 API 의 '캐시된 입력 90% 할인' 은 이 절감을 가격에 반영한 것이다.`);

    // 측정 토큰으로 월 비용 모델: 하루 2,000 질문, 질문당 입력 inLong, 출력 64
    const perDay = 2000;
    const outTok = 64;
    const cost = (p: (typeof LLM_PRICE)[number], inTok: number, cachedTok: number, out: number) => ((inTok - cachedTok) * p.input + cachedTok * p.cached + out * p.output) / 1e6;
    const prefixTok = inLong - (inShort - 10); // 노트 부분 ≈ 캐시 대상
    ctx.table(`월 비용 모델 (가정: 하루 ${perDay.toLocaleString()} 질문, 질문당 입력 ${fmt(inLong)} · 출력 ${outTok} 토큰, 30일)`, ["모델(가정 단가)", "캐시 없음", "프리픽스 캐시", "캐시 + 출력 32 제한", "요청당(캐시)"], LLM_PRICE.map((p) => [
      `${p.model} ($${p.input}/$${p.output} per 1M)`,
      usd(cost(p, inLong, 0, outTok) * perDay * 30),
      usd(cost(p, inLong, prefixTok, outTok) * perDay * 30),
      usd(cost(p, inLong, prefixTok, 32) * perDay * 30),
      `$${cost(p, inLong, prefixTok, outTok).toFixed(5)}`,
    ]));
    const big = LLM_PRICE[0];
    const small = LLM_PRICE[2];
    const routed = 0.8 * cost(small, inLong, prefixTok, outTok) + 0.2 * cost(big, inLong, prefixTok, outTok);
    ctx.note(`모델 라우팅: 쉬운 질문 80% 를 ${small.model}, 어려운 20% 만 ${big.model} 로 보내면 요청당 $${routed.toFixed(5)} — 전부 ${big.model} 일 때($${cost(big, inLong, prefixTok, outTok).toFixed(5)})의 ${((routed / cost(big, inLong, prefixTok, outTok)) * 100).toFixed(0)}%.`);

    // 앱이 기록한 메트릭
    for (const base of ["http://127.0.0.1:3310", "http://127.0.0.1:3000"]) {
      const tok = await metricValue(`${base}/api/metrics`, "study_llm_tokens_total");
      const usdTotal = await metricValue(`${base}/api/metrics`, "study_llm_cost_usd_total");
      if (tok !== null) {
        ctx.note(`앱(${base}) 메트릭: 누적 LLM 토큰 ${fmt(tok)}, 추정 비용 $${(usdTotal ?? 0).toFixed(4)} — Grafana 의 'LLM 토큰/분'·'LLM 비용' 패널이 이 값을 그린다.`);
        break;
      }
    }
  },
};
