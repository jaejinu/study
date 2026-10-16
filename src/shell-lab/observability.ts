import { armUnpause } from "@/lib/deadman";
import { exec } from "./runner";
import type { ShellExperiment } from "./types";

const APP = "http://127.0.0.1:3000";
const PROM = "http://127.0.0.1:19090";
const AM = "http://127.0.0.1:19093";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000), cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

async function requiresObs(): Promise<string | null> {
  const [prom, am, app] = await Promise.all([getJson<unknown>(`${PROM}/api/v1/status/buildinfo`), getJson<unknown>(`${AM}/api/v2/status`), getJson<unknown>(`${APP}/api/alerts`)]);
  if (!prom || !am) return "Prometheus/Alertmanager 가 꺼져 있습니다. `pnpm obs:up` 을 실행하세요.";
  if (!app) return "앱의 /api/alerts 에 접근할 수 없습니다. `pnpm dev` 가 3000 에서 실행 중이어야 합니다.";
  const docker = await exec("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"], { timeout: 5000 });
  if (!docker.ok || docker.out !== "running") return "Docker 의 study-redis 컨테이너가 실행 중이어야 합니다 (`pnpm redis:docker`). 이 실험은 그 컨테이너를 잠시 멈춥니다.";
  return null;
}

type PromAlerts = { data: { alerts: { labels: Record<string, string>; state: string }[] } };
type AppAlert = { alertname: string; status: string; receivedAt: string; severity: string };

export const alertPipeline: ShellExperiment = {
  id: "alert-pipeline-redis-down",
  subject: "observability",
  title: "알림 파이프라인: Redis 를 멈추면 알림이 도착하고, 살리면 해제된다",
  category: "알림",
  summary: "study-redis 컨테이너를 docker pause 로 멈춰 redis_up=0 → Prometheus 규칙(for 30s) → Alertmanager 라우팅(critical, group_wait 0) → 앱 웹훅 수신까지의 시간을 측정하고, unpause 후 resolved 알림까지 확인 (2~3분)",
  notes: ["09-alerting-pipeline", "02-prometheus-promql"],
  description: `
알림은 네 단계를 거친다: **수집**(exporter 가 redis_up=0 노출) → **평가**(Prometheus 가 5초마다 규칙 평가, \`for: 30s\` 동안 pending) → **라우팅**(Alertmanager 가 severity 로 수신자 선택, 그룹화·억제) → **전달**(웹훅 → 이 앱의 /api/alerts).
각 단계의 지연이 더해져 "장애 발생 → 사람이 아는 시각" 이 된다. 이 실험은 그 시간을 실제로 잰다.
\`docker pause\` 는 프로세스를 SIGSTOP 으로 얼려 연결은 살아 있지만 응답이 없는, 가장 까다로운 장애(hang)를 흉내 낸다.
`,
  code: `docker pause study-redis                      # Redis 가 멈춤 (연결은 살아 있음)
curl -s localhost:19090/api/v1/alerts | jq '.data.alerts[] | {alertname: .labels.alertname, state}'   # pending → firing
curl -s localhost:19093/api/v2/alerts | jq '.[].labels.alertname'                                      # Alertmanager 도착
curl -s localhost:3000/api/alerts | jq '.[0]'                                                         # 앱 웹훅 수신
docker unpause study-redis
# 잠시 후 status=resolved 알림이 같은 경로로 온다`,
  requires: requiresObs,
  cleanup: async (ctx) => {
    await ctx.sh("docker", ["unpause", "study-redis"], { allowFail: true });
  },
  async run(ctx) {
    const before = (await getJson<AppAlert[]>(`${APP}/api/alerts`)) ?? [];
    const baseline = before.filter((a) => a.alertname === "RedisDown").length;
    ctx.note(`시작 전 앱이 받은 RedisDown 알림: ${baseline}건`);
    const guard = armUnpause("study-redis", 240);
    ctx.note(`데드맨 스위치 장전 (pid ${guard.pid}): 실험이 중단돼도 240초 뒤 docker unpause`);
    await ctx.sh("docker", ["pause", "study-redis"]);
    const t0 = performance.now();

    const pending = await ctx.poll("Prometheus 에서 RedisDown 이 pending/firing 이 될 때까지", async () => {
      const j = await getJson<PromAlerts>(`${PROM}/api/v1/alerts`);
      const a = j?.data.alerts.find((x) => x.labels.alertname === "RedisDown");
      return a ? a.state : undefined;
    }, { timeoutMs: 60_000, intervalMs: 3000 });
    ctx.note(`${Math.round((performance.now() - t0) / 1000)}s: RedisDown ${pending} (redis_up=0 가 수집됨)`);

    await ctx.poll("firing 으로 전환 (for: 30s 경과)", async () => {
      const j = await getJson<PromAlerts>(`${PROM}/api/v1/alerts`);
      return j?.data.alerts.find((x) => x.labels.alertname === "RedisDown")?.state === "firing" ? true : undefined;
    }, { timeoutMs: 90_000, intervalMs: 3000 });
    const tFiring = Math.round((performance.now() - t0) / 1000);
    ctx.note(`${tFiring}s: firing → Alertmanager 로 전송`);

    await ctx.poll("Alertmanager 에 RedisDown 도착", async () => {
      const j = await getJson<{ labels: Record<string, string> }[]>(`${AM}/api/v2/alerts?active=true`);
      return j?.some((x) => x.labels.alertname === "RedisDown") ? true : undefined;
    }, { timeoutMs: 60_000, intervalMs: 2000 });

    const received = await ctx.poll("앱 /api/alerts 에 firing 웹훅 수신 (critical 라우트: group_wait 0s)", async () => {
      const j = (await getJson<AppAlert[]>(`${APP}/api/alerts`)) ?? [];
      const hit = j.find((a) => a.alertname === "RedisDown" && a.status === "firing" && new Date(a.receivedAt).getTime() > Date.now() - 5 * 60_000);
      return hit ?? undefined;
    }, { timeoutMs: 90_000, intervalMs: 2000 });
    const tReceived = Math.round((performance.now() - t0) / 1000);
    ctx.check(`장애 → 알림 수신 ${tReceived}s (severity=${received.severity})`, received.severity === "critical", JSON.stringify(received).slice(0, 200));
    ctx.table("단계별 소요", ["단계", "누적 초"], [["pause 직후", "0"], ["Prometheus firing (for 30s 포함)", String(tFiring)], ["앱 웹훅 수신", String(tReceived)]]);

    ctx.note("복구: unpause 후 resolved 알림을 기다린다 (resolve_timeout·그룹 간격 영향)");
    await ctx.sh("docker", ["unpause", "study-redis"]);
    guard.disarm();
    const t1 = performance.now();
    await ctx.poll("Prometheus 에서 RedisDown 사라짐", async () => {
      const j = await getJson<PromAlerts>(`${PROM}/api/v1/alerts`);
      return j && !j.data.alerts.some((x) => x.labels.alertname === "RedisDown") ? true : undefined;
    }, { timeoutMs: 90_000, intervalMs: 3000 });
    const resolved = await ctx.poll("앱에 resolved 웹훅 수신", async () => {
      const j = (await getJson<AppAlert[]>(`${APP}/api/alerts`)) ?? [];
      return j.find((a) => a.alertname === "RedisDown" && a.status === "resolved" && new Date(a.receivedAt).getTime() > Date.now() - 5 * 60_000) ?? undefined;
    }, { timeoutMs: 180_000, intervalMs: 3000 });
    ctx.check(`복구 → resolved 수신 ${Math.round((performance.now() - t1) / 1000)}s`, resolved.status === "resolved");
    ctx.note("관측성 대시보드의 '최근 알림' 과 Grafana 의 '받은 알림' 패널, Loki 의 alert.received 로그에서 같은 사건을 볼 수 있다");
  },
};
