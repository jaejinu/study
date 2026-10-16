import { getShellExperiment } from "@/shell-lab";
import { exec, runShellExperiment } from "@/shell-lab/runner";
import { countChecks, getLabRuns, recordLabRun } from "@/lib/lab-history";
import { recentAlerts } from "@/lib/alerts";
import { ensureConnected, getRedis } from "@/lib/redis";

/**
 * 종합 과제(캡스톤) — 여러 주제를 하나의 운영 시나리오로 엮는다.
 * 상태: Redis Hash `capstone:<id>`
 *   startedAt   프로젝트 시작 시각(ms) — "그 뒤에 일어난 일" 만 인정하기 위한 기준
 *   baseline    시작 시점 스냅샷(JSON, 예: 카나리 Rollout 의 이미지·리비전)
 *   step:<sid>  {ok, at, detail} 마지막 검증 결과(JSON)
 *   postmortem  사용자가 쓴 포스트모템 본문
 */
export const PROM = "http://localhost:19090";
const KCTX = ["--context", "kind-study"];

export interface StepCtx {
  startedAt: number;
  baseline: Record<string, string>;
  fields: Record<string, string>;
}
export interface StepResult {
  ok: boolean;
  detail: string;
}
export interface CapstoneStep {
  id: string;
  title: string;
  goal: string;
  actions: string[];
  notes: { href: string; title: string }[];
  experiments: string[];
  /** 포스트모템처럼 사용자가 페이지에서 직접 글을 써야 하는 단계 */
  input?: "postmortem";
  verify: (c: StepCtx) => Promise<StepResult>;
}
export interface CapstoneProject {
  id: string;
  title: string;
  summary: string;
  requires: string[];
  steps: CapstoneStep[];
  snapshot?: () => Promise<Record<string, string>>;
}

async function prom(query: string): Promise<{ metric: Record<string, string>; value: number }[] | null> {
  try {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { status: string; data: { result: { metric: Record<string, string>; value: [number, string] }[] } };
    if (j.status !== "success") return null;
    return j.data.result.map((x) => ({ metric: x.metric, value: Number(x.value[1]) }));
  } catch {
    return null;
  }
}
const kubectl = (args: string[], timeout = 20_000) => exec("kubectl", [...KCTX, ...args], { timeout });
async function kjson<T>(args: string[]): Promise<T | null> {
  const r = await kubectl([...args, "-o", "json"]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out) as T;
  } catch {
    return null;
  }
}
const ago = (ms: number) => `${Math.max(0, Math.round((Date.now() - ms) / 60_000))}분 전`;

// ------------------------------------------------------------------ A. 관측 가능한 서비스
const observable: CapstoneProject = {
  id: "observable-service",
  title: "관측 가능한 서비스: 메트릭 → SLO → 번레이트 알림 → 장애 → 포스트모템",
  summary: "이 학습 앱 자체를 운영 대상으로 삼아, 메트릭을 노출·수집하고, SLO 를 코드로 검증해 Prometheus 에 적용한 뒤, 실제로 장애를 일으켜 알림이 웹훅으로 들어오는지 확인하고 포스트모템까지 쓴다.",
  requires: ["pnpm obs:up (Prometheus 19090 · Alertmanager 19093)", "Docker Desktop", "이 앱이 3000 포트에서 실행 중 (Prometheus 스크레이프 대상)"],
  steps: [
    {
      id: "metrics",
      title: "① 앱이 메트릭을 노출한다",
      goal: "/api/metrics 가 Prometheus 텍스트 형식으로 study_* 지표를 내보낸다.",
      actions: ["curl -s localhost:3000/api/metrics | grep -E '^study_' | head", "노트를 몇 개 열어 study_note_views_total 이 늘어나는지 본다"],
      notes: [
        { href: "/observability/notes/03-instrumentation-exporters", title: "계측과 익스포터" },
        { href: "/observability/notes/02-prometheus-promql", title: "Prometheus 와 PromQL" },
      ],
      experiments: ["obs-cpu-profile"],
      async verify() {
        const ports = [...new Set([process.env.PORT, "3000", "3310"].filter(Boolean))];
        for (const p of ports) {
          try {
            const r = await fetch(`http://127.0.0.1:${p}/api/metrics`, { signal: AbortSignal.timeout(5000) });
            const t = await r.text();
            const names = new Set(t.split("\n").filter((l) => l.startsWith("study_")).map((l) => l.split(/[{ ]/)[0]));
            if (r.ok && names.size > 0) return { ok: true, detail: `:${p}/api/metrics → study_* 지표 ${names.size}종 (예: ${[...names].slice(0, 3).join(", ")})` };
          } catch {
            /* 다음 포트 */
          }
        }
        return { ok: false, detail: `${ports.join("·")} 포트의 /api/metrics 에서 study_* 지표를 찾지 못함` };
      },
    },
    {
      id: "scrape",
      title: "② Prometheus 가 앱을 스크레이프한다",
      goal: "up{job=\"study-app\"} == 1 이고, 앱 지표가 Prometheus 에 시계열로 쌓인다.",
      actions: ["pnpm obs:up", "open http://localhost:19090/targets  # study-app 이 UP 인지", "curl -s 'localhost:19090/api/v1/query?query=up{job=\"study-app\"}'"],
      notes: [
        { href: "/observability/notes/02-prometheus-promql", title: "Prometheus 와 PromQL" },
        { href: "/observability/notes/09-alerting-pipeline", title: "알림 파이프라인" },
      ],
      experiments: ["alert-pipeline-redis-down"],
      async verify() {
        const up = await prom('up{job="study-app"}');
        if (up === null) return { ok: false, detail: "Prometheus(19090) 에 질의할 수 없음 — pnpm obs:up" };
        if (!up.length) return { ok: false, detail: "study-app 스크레이프 대상이 없음 (prometheus.yml 확인)" };
        if (up[0].value !== 1) return { ok: false, detail: `up{job="study-app"} = ${up[0].value} — 앱이 3000 포트에서 떠 있는지 확인` };
        const n = await prom('count({job="study-app", __name__=~"study_.+"})');
        const series = n?.[0]?.value ?? 0;
        return series > 0 ? { ok: true, detail: `up = 1 · study_* 시계열 ${series}개 수집 중` } : { ok: false, detail: "up=1 이지만 study_* 시계열이 없음" };
      },
    },
    {
      id: "slo-rules",
      title: "③ SLO 를 코드로 정의하고 테스트한다",
      goal: "레코딩 룰과 멀티윈도우 번레이트 알림을 promtool check/test rules 로 검증한다 (실험을 성공시키면 통과).",
      actions: ["실험 'SLO 를 코드로' 를 실행한다 (아래 링크) — 검증 버튼은 최근 24시간 안에 성공 기록이 없으면 직접 실행한다", "결과 표에서 번레이트·버짓 잔여를 읽고, 왜 요청 기반 SLI 가 비어 있을 수 있는지 설명해 본다"],
      notes: [
        { href: "/sre/notes/02-sli-slo-error-budget", title: "SLI·SLO·에러 버짓" },
        { href: "/sre/notes/03-burn-rate-alerting", title: "번레이트 알림" },
      ],
      experiments: ["sre-slo-recording-rules"],
      async verify() {
        const id = "sre-slo-recording-rules";
        const recent = (await getLabRuns("sre", id, 10)).filter((r) => r.ok && r.failedChecks === 0 && Date.now() - r.at < 86_400_000);
        if (recent.length) {
          const last = recent[recent.length - 1];
          return { ok: true, detail: `실험 성공 기록 있음 (${ago(last.at)}, 검증 ${last.checks}개 모두 통과)` };
        }
        const res = await runShellExperiment(getShellExperiment("sre", id), id);
        const { checks, failed } = countChecks(res.steps);
        await recordLabRun("sre", id, { ok: res.ok && failed === 0, durationMs: res.durationMs, steps: res.steps.length, checks, failedChecks: failed, error: res.error });
        if (!res.ok) return { ok: false, detail: `실험 실패: ${res.error ?? "알 수 없음"}` };
        return failed === 0 ? { ok: true, detail: `지금 실행 — 검증 ${checks}개 통과 (${(res.durationMs / 1000).toFixed(1)}s)` } : { ok: false, detail: `검증 ${failed}/${checks}개 실패` };
      },
    },
    {
      id: "burn-rate-loaded",
      title: "④ 번레이트 알림을 실제 Prometheus 에 적용한다",
      goal: "slo:* 레코딩 룰과 *BurnRate* 알림 규칙이 실행 중인 Prometheus 에 로드돼 있다.",
      actions: [
        "실험 ③ 이 출력한 slo.rules.yml 의 groups 를 observability/alert-rules.yml 끝에 붙인다",
        "docker run --rm -v $PWD/observability:/w --entrypoint promtool prom/prometheus check rules /w/alert-rules.yml",
        "docker compose -p study restart prometheus   # 또는 curl -X POST localhost:19090/-/reload (lifecycle 활성 시)",
        "open http://localhost:19090/rules",
      ],
      notes: [
        { href: "/sre/notes/03-burn-rate-alerting", title: "번레이트 알림" },
        { href: "/observability/notes/11-slo-dashboard-burn-rate", title: "SLO 대시보드와 번레이트" },
      ],
      experiments: ["sre-slo-recording-rules"],
      async verify() {
        try {
          const r = await fetch(`${PROM}/api/v1/rules`, { signal: AbortSignal.timeout(5000) });
          const j = (await r.json()) as { data: { groups: { name: string; rules: { name: string; type: string }[] }[] } };
          const rules = j.data.groups.flatMap((g) => g.rules);
          const rec = rules.filter((x) => x.type === "recording" && x.name.startsWith("slo:"));
          const alerts = rules.filter((x) => x.type === "alerting" && /burnrate/i.test(x.name));
          if (rec.length && alerts.length) return { ok: true, detail: `레코딩 ${rec.length}개 (${rec[0].name} …) · 번레이트 알림 ${alerts.map((a) => a.name).join(", ")}` };
          return { ok: false, detail: `로드된 규칙 ${rules.length}개 중 slo:* 레코딩 ${rec.length}개 · *BurnRate* 알림 ${alerts.length}개 — 둘 다 있어야 한다` };
        } catch {
          return { ok: false, detail: "Prometheus(19090) /api/v1/rules 질의 실패" };
        }
      },
    },
    {
      id: "incident-alert",
      title: "⑤ 장애를 주입하고 알림을 받는다",
      goal: "프로젝트 시작 이후 RedisDown 또는 *BurnRate* 알림이 Alertmanager → 앱 웹훅(/api/alerts)으로 실제로 들어왔다.",
      actions: [
        "실험 '장애 중 번레이트' 실행 (study-redis 를 45초 pause, 데드맨이 자동 unpause) — 또는 장애 훈련 'Redis OOM' 과 별개로",
        "open http://localhost:19093  # Alertmanager 에서 firing 확인",
        "curl -s localhost:3000/api/alerts | head -c 400   # 앱이 받은 알림",
      ],
      notes: [
        { href: "/observability/notes/09-alerting-pipeline", title: "알림 파이프라인" },
        { href: "/sre/notes/04-oncall-runbooks", title: "온콜과 런북" },
      ],
      experiments: ["sre-burn-rate-under-chaos", "alert-pipeline-redis-down", "chaos-redis-hang"],
      async verify(c) {
        const all = await recentAlerts(200);
        const hit = all.filter((a) => /RedisDown|BurnRate/i.test(a.alertname) && Date.parse(a.receivedAt) >= c.startedAt);
        if (!hit.length) return { ok: false, detail: `프로젝트 시작(${ago(c.startedAt)}) 이후 받은 RedisDown/BurnRate 알림 없음 (전체 최근 알림 ${all.length}건)` };
        const firing = hit.find((a) => a.status === "firing") ?? hit[0];
        const resolved = hit.some((a) => a.status === "resolved" && a.alertname === firing.alertname);
        return { ok: true, detail: `${firing.alertname} 수신 (${firing.receivedAt.slice(11, 19)} UTC)${resolved ? " · resolved 도 수신" : ""} · 수신기 ${firing.receiver}` };
      },
    },
    {
      id: "postmortem",
      title: "⑥ 포스트모템을 쓴다",
      goal: "영향·타임라인·원인·조치(재발 방지) 네 부분을 갖춘 비난 없는 포스트모템을 200자 이상 쓴다.",
      actions: ["실험 '포스트모템 타임라인' 으로 TTD·TTR 이 계산된 시간표를 뽑는다", "아래 입력란에 ## 영향 / ## 타임라인 / ## 원인 / ## 조치 를 채우고 저장한 뒤 검증"],
      notes: [
        { href: "/sre/notes/05-incident-postmortem", title: "사고 대응과 포스트모템" },
        { href: "/chaos/notes/05-incident-drills", title: "장애 대응 훈련" },
      ],
      experiments: ["sre-postmortem-timeline"],
      input: "postmortem",
      async verify(c) {
        const text = c.fields.postmortem ?? "";
        const parts = ["영향", "타임라인", "원인", "조치"].filter((k) => text.includes(k));
        const missing = ["영향", "타임라인", "원인", "조치"].filter((k) => !text.includes(k));
        if (text.length < 200) return { ok: false, detail: `본문 ${text.length}자 — 200자 이상 필요` };
        if (missing.length) return { ok: false, detail: `빠진 부분: ${missing.join(", ")}` };
        const times = (text.match(/\b\d{1,2}:\d{2}/g) ?? []).length;
        return times >= 2 ? { ok: true, detail: `${text.length}자 · ${parts.length}개 부분 · 타임라인 시각 ${times}개` } : { ok: false, detail: "타임라인에 시각(HH:MM)이 2개 이상 있어야 한다" };
      },
    },
  ],
};

// ------------------------------------------------------------------ B. 카나리 배포
interface RolloutJson {
  metadata: { annotations?: Record<string, string> };
  spec: { template: { spec: { containers: { image: string }[] } } };
  status?: { phase?: string; stableRS?: string; currentPodHash?: string; abort?: boolean; message?: string };
}
interface ListJson<T> {
  items: T[];
}
interface AnalysisRunJson {
  metadata: { name: string; creationTimestamp: string };
  status?: { phase?: string };
}
const rollout = () => kjson<RolloutJson>(["-n", "study", "get", "rollout", "web-canary"]);
const rolloutInfo = (r: RolloutJson) => ({
  image: r.spec.template.spec.containers[0]?.image ?? "",
  revision: r.metadata.annotations?.["rollout.argoproj.io/revision"] ?? "0",
  phase: r.status?.phase ?? "?",
  stableRS: r.status?.stableRS ?? "",
  current: r.status?.currentPodHash ?? "",
});
async function runsSince(t: number) {
  const l = await kjson<ListJson<AnalysisRunJson>>(["-n", "study", "get", "analysisruns"]);
  return (l?.items ?? []).filter((x) => Date.parse(x.metadata.creationTimestamp) >= t - 5000);
}

const canary: CapstoneProject = {
  id: "canary-release",
  title: "카나리 배포: 분석으로 자동 판정하고, 승격하고, 되돌린다",
  summary: "kind-study 클러스터에서 Argo Rollouts 로 새 버전을 25%→50%→100% 단계로 내보내며, Prometheus 질의 기반 AnalysisTemplate 이 각 단계의 건강을 자동 판정하게 한다. 마지막에 되돌리기까지 해 본다.",
  requires: ["kind-study 클러스터 (pnpm k8s:up)", "Argo Rollouts (pnpm k8s:rollouts)", "kubectl argo rollouts 플러그인 (brew install argoproj/tap/kubectl-argo-rollouts)", "이미지 study:dev · study:dev2 (kind load)"],
  snapshot: async (): Promise<Record<string, string>> => {
    const r = await rollout();
    if (!r) return {};
    const i = rolloutInfo(r);
    return { image: i.image, revision: i.revision, stableRS: i.stableRS };
  },
  steps: [
    {
      id: "cluster",
      title: "① 클러스터에 서비스를 배포한다",
      goal: "kind-study 의 study 네임스페이스에 web 이 Ready 다.",
      actions: ["pnpm k8s:up", "kubectl --context kind-study -n study get deploy,rollout,svc", "kubectl --context kind-study -n study rollout status deploy/web"],
      notes: [
        { href: "/kubernetes/notes/03-pod-deployment", title: "Pod 와 Deployment" },
        { href: "/kubernetes/notes/07-deploy-resources", title: "배포 전략과 리소스" },
      ],
      experiments: ["k8s-rolling-update", "k8s-self-healing"],
      async verify() {
        const d = await kjson<{ spec: { replicas: number }; status: { readyReplicas?: number } }>(["-n", "study", "get", "deploy", "web"]);
        const r = await rollout();
        if (!d && !r) return { ok: false, detail: "kind-study 의 study/web 을 찾지 못함 (클러스터가 떠 있는지 확인)" };
        const parts: string[] = [];
        if (d) parts.push(`deploy/web Ready ${d.status.readyReplicas ?? 0}/${d.spec.replicas}`);
        if (r) parts.push(`rollout/web-canary ${rolloutInfo(r).phase}`);
        const ok = (d !== null && (d.status.readyReplicas ?? 0) >= 1) || (r !== null && rolloutInfo(r).phase === "Healthy");
        return { ok, detail: parts.join(" · ") };
      },
    },
    {
      id: "rollouts",
      title: "② 점진 배포 컨트롤러를 설치한다",
      goal: "argo-rollouts 컨트롤러가 Available 이고, web-canary Rollout 이 Healthy 다.",
      actions: ["pnpm k8s:rollouts", "kubectl argo rollouts get rollout web-canary -n study"],
      notes: [{ href: "/kubernetes/notes/13-gitops-progressive-delivery", title: "GitOps 와 점진 배포" }, { href: "/kubernetes/notes/11-operators-crds", title: "오퍼레이터와 CRD" }],
      experiments: ["mesh-traffic-split"],
      async verify() {
        const c = await kjson<{ status: { availableReplicas?: number } }>(["-n", "argo-rollouts", "get", "deploy", "argo-rollouts"]);
        if (!c) return { ok: false, detail: "argo-rollouts 컨트롤러 없음 — pnpm k8s:rollouts" };
        const r = await rollout();
        if (!r) return { ok: false, detail: "컨트롤러는 있으나 Rollout web-canary 가 없음" };
        const i = rolloutInfo(r);
        return { ok: (c.status.availableReplicas ?? 0) >= 1 && i.phase === "Healthy", detail: `컨트롤러 Available ${c.status.availableReplicas ?? 0} · web-canary ${i.phase} · 이미지 ${i.image} · 리비전 ${i.revision}` };
      },
    },
    {
      id: "analysis-template",
      title: "③ 자동 판정 기준(AnalysisTemplate)을 이해한다",
      goal: "app-health 템플릿이 있고, 그 Prometheus 질의가 지금 성공 조건(≥1)을 만족한다.",
      actions: ["kubectl --context kind-study -n study get analysistemplate app-health -o yaml", "템플릿의 query 를 클러스터 Prometheus 에서 직접 실행해 본다 (Grafana Explore 또는 port-forward)"],
      notes: [{ href: "/kubernetes/notes/13-gitops-progressive-delivery", title: "GitOps 와 점진 배포" }, { href: "/sre/notes/06-capacity-release-change", title: "용량·릴리스·변경 관리" }],
      experiments: ["mesh-traffic-split"],
      async verify() {
        const t = await kjson<{ spec: { metrics: { name: string; successCondition?: string; provider?: { prometheus?: { query?: string } } }[] } }>(["-n", "study", "get", "analysistemplate", "app-health"]);
        if (!t) return { ok: false, detail: "AnalysisTemplate app-health 없음 — kubectl apply -f k8s/rollouts/web-rollout.yaml" };
        const ms = t.spec.metrics.map((m) => `${m.name}: ${m.provider?.prometheus?.query ?? "?"} (${m.successCondition ?? "-"})`);
        return { ok: ms.length > 0, detail: `지표 ${ms.length}개 — ${ms.join(" · ")}` };
      },
    },
    {
      id: "canary-start",
      title: "④ 새 버전으로 카나리를 시작한다",
      goal: "프로젝트 시작 시점과 다른 이미지로 Rollout 이 갱신됐다 (25% 단계에서 멈춰 있어도 통과).",
      actions: [
        "kubectl argo rollouts get rollout web-canary -n study   # 지금 이미지 확인",
        "kubectl argo rollouts set image web-canary web=study:dev -n study --context kind-study   # 지금이 study:dev 면 study:dev2 로",
        "kubectl argo rollouts get rollout web-canary -n study --watch",
      ],
      notes: [{ href: "/kubernetes/notes/13-gitops-progressive-delivery", title: "GitOps 와 점진 배포" }, { href: "/service-mesh/notes/06-canary-traffic-split", title: "카나리와 트래픽 분할" }],
      experiments: ["mesh-traffic-split"],
      async verify(c) {
        const r = await rollout();
        if (!r) return { ok: false, detail: "Rollout web-canary 없음" };
        const i = rolloutInfo(r);
        const base = c.baseline;
        if (!base.image) return { ok: false, detail: "시작 시점 스냅샷이 없음 — '처음부터 다시' 로 프로젝트를 새로 시작" };
        const changed = Number(i.revision) > Number(base.revision ?? 0) && i.image !== base.image;
        return { ok: changed, detail: `시작 시 ${base.image} (rev ${base.revision}) → 지금 ${i.image} (rev ${i.revision}) · ${i.phase}` };
      },
    },
    {
      id: "promote",
      title: "⑤ 분석 통과 → 100% 승격",
      goal: "시작 이후 생성된 AnalysisRun 이 Successful 이고, Rollout 이 새 이미지로 Healthy 다.",
      actions: ["kubectl --context kind-study -n study get analysisrun -w", "60초 pause 가 길면: kubectl argo rollouts promote web-canary -n study --context kind-study"],
      notes: [{ href: "/kubernetes/notes/13-gitops-progressive-delivery", title: "GitOps 와 점진 배포" }, { href: "/sre/notes/07-slo-driven-automation", title: "SLO 기반 자동화" }],
      experiments: ["mesh-traffic-split"],
      async verify(c) {
        const r = await rollout();
        if (!r) return { ok: false, detail: "Rollout web-canary 없음" };
        const i = rolloutInfo(r);
        const runs = await runsSince(c.startedAt);
        const good = runs.filter((x) => x.status?.phase === "Successful");
        const promoted = i.phase === "Healthy" && i.image !== c.baseline.image;
        const detail = `시작 이후 AnalysisRun ${runs.length}개 (성공 ${good.length}) · ${i.phase} · ${i.image}`;
        return { ok: good.length > 0 && promoted, detail };
      },
    },
    {
      id: "rollback",
      title: "⑥ 원래 버전으로 되돌린다",
      goal: "승격 뒤 undo 로 시작 시점의 이미지로 돌아와 Healthy 다 (리비전이 2 이상 증가).",
      actions: ["kubectl argo rollouts undo web-canary -n study --context kind-study", "kubectl argo rollouts promote web-canary -n study --context kind-study --full   # 단계 건너뛰기(되돌리기는 빨리)"],
      notes: [{ href: "/kubernetes/notes/08-ops-debugging", title: "운영과 디버깅" }, { href: "/sre/notes/06-capacity-release-change", title: "용량·릴리스·변경 관리" }],
      experiments: ["k8s-rolling-update"],
      async verify(c) {
        const r = await rollout();
        if (!r) return { ok: false, detail: "Rollout web-canary 없음" };
        const i = rolloutInfo(r);
        const promoted = c.fields["step:promote"] ? (JSON.parse(c.fields["step:promote"]) as { ok: boolean }).ok : false;
        const back = i.image === c.baseline.image && i.phase === "Healthy" && Number(i.revision) >= Number(c.baseline.revision ?? 0) + 2;
        return { ok: promoted && back, detail: `${promoted ? "⑤ 통과함" : "⑤ 를 먼저 통과해야 함"} · 지금 ${i.image} rev ${i.revision} ${i.phase} (시작 ${c.baseline.image} rev ${c.baseline.revision})` };
      },
    },
  ],
};

export const capstones: CapstoneProject[] = [observable, canary];
export const getCapstone = (id: string) => capstones.find((p) => p.id === id);

// ------------------------------------------------------------------ 상태
const key = (id: string) => `capstone:${id}`;

export interface CapstoneState {
  startedAt: number | null;
  baseline: Record<string, string>;
  steps: Record<string, { ok: boolean; at: number; detail: string }>;
  postmortem: string;
}

export async function getCapstoneState(id: string): Promise<CapstoneState> {
  const empty: CapstoneState = { startedAt: null, baseline: {}, steps: {}, postmortem: "" };
  try {
    const r = getRedis();
    await ensureConnected(r);
    const h = await r.hgetall(key(id));
    const steps: CapstoneState["steps"] = {};
    for (const [k, v] of Object.entries(h)) if (k.startsWith("step:")) steps[k.slice(5)] = JSON.parse(v);
    return { startedAt: h.startedAt ? Number(h.startedAt) : null, baseline: h.baseline ? JSON.parse(h.baseline) : {}, steps, postmortem: h.postmortem ?? "" };
  } catch {
    return empty;
  }
}

export async function startCapstone(id: string, force = false): Promise<void> {
  const p = getCapstone(id);
  if (!p) return;
  const r = getRedis();
  await ensureConnected(r);
  if (force) await r.del(key(id));
  if (await r.hexists(key(id), "startedAt")) return;
  const baseline = p.snapshot ? await p.snapshot() : {};
  await r.hset(key(id), { startedAt: Date.now(), baseline: JSON.stringify(baseline) });
}

export async function verifyCapstoneStep(id: string, stepId: string): Promise<StepResult> {
  const p = getCapstone(id);
  const step = p?.steps.find((s) => s.id === stepId);
  if (!p || !step) return { ok: false, detail: "없는 단계" };
  await startCapstone(id);
  const r = getRedis();
  const fields = await r.hgetall(key(id));
  let res: StepResult;
  try {
    res = await step.verify({ startedAt: Number(fields.startedAt), baseline: fields.baseline ? JSON.parse(fields.baseline) : {}, fields });
  } catch (e) {
    res = { ok: false, detail: `검증 중 오류: ${(e as Error).message}` };
  }
  await r.hset(key(id), `step:${stepId}`, JSON.stringify({ ...res, at: Date.now() }));
  return res;
}

export async function savePostmortem(id: string, text: string): Promise<void> {
  if (!getCapstone(id)) return;
  await startCapstone(id);
  await getRedis().hset(key(id), "postmortem", text.slice(0, 20_000));
}
