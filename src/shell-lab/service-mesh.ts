import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { armDeadman, type Deadman } from "@/lib/deadman";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

/**
 * 서비스 메시 실험 — kind-study 클러스터의 Linkerd 위에서 mTLS·인가·재시도·타임아웃·장애 축적·트래픽 분할을 직접 측정한다.
 *
 * - 각 실험은 자기 네임스페이스(mesh-lab-*)를 만들고 끝나면 지운다. Linkerd 컨트롤 플레인은 그대로 둔다.
 * - 이미지: traefik/whoami(요청 정보·?wait= 지연), hashicorp/http-echo(고정 응답·상태 코드), curlimages/curl(클라이언트)
 * - 데드맨 스위치: 실험이 중간에 끊겨도 15분 뒤 실험 네임스페이스가 지워진다
 */

const CTX = "kind-study";
const K = (...args: string[]) => ["--context", CTX, ...args];

/** 공식 edge CLI(~/.linkerd2/bin)를 우선 쓴다 — brew 의 linkerd 는 존재하지 않는 이미지 태그를 렌더링할 수 있다 */
function linkerdBin(): string {
  const p = path.join(os.homedir(), ".linkerd2", "bin", "linkerd");
  return existsSync(p) ? p : "linkerd";
}

async function requiresMesh(): Promise<string | null> {
  const ns = await exec("kubectl", K("get", "ns", "study", "--request-timeout=5s"), { timeout: 8000 });
  if (!ns.ok) return "kind-study 클러스터가 필요합니다 (`pnpm k8s:cluster`).";
  const cp = await exec("kubectl", K("-n", "linkerd", "get", "deploy", "linkerd-destination", "-o", "jsonpath={.status.readyReplicas}", "--request-timeout=5s"), { timeout: 8000 });
  if (!cp.ok || Number(cp.out) < 1)
    return [
      "Linkerd 컨트롤 플레인이 kind-study 에 필요합니다:",
      "kubectl --context kind-study apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml",
      "linkerd --context kind-study install --crds | kubectl --context kind-study apply --server-side -f -",
      "linkerd --context kind-study install | kubectl --context kind-study apply -f - && linkerd --context kind-study check",
      "(brew 의 linkerd 가 version-2.20 같은 존재하지 않는 태그를 렌더링하면 GitHub 릴리스의 edge CLI 를 ~/.linkerd2/bin 에 받아 쓴다)",
    ].join("\n");
  const cli = await exec(linkerdBin(), ["version", "--client", "--short"], { timeout: 8000 });
  if (!cli.ok) return "linkerd CLI 가 필요합니다 (프록시 메트릭 조회용): brew install linkerd 또는 GitHub 릴리스의 edge CLI.";
  return null;
}

async function apply(ctx: ShellCtx, ns: string, yaml: string, label: string) {
  await ctx.sh("kubectl", K("-n", ns, "apply", "-f", "-"), { input: yaml, label });
}

async function rollout(ctx: ShellCtx, ns: string, deploys: string[]) {
  for (const d of deploys) await ctx.sh("kubectl", K("-n", ns, "rollout", "status", `deploy/${d}`, "--timeout=180s"), { timeout: 200_000 });
}

async function freshNamespace(ctx: ShellCtx, ns: string): Promise<Deadman> {
  await exec("kubectl", K("delete", "ns", ns, "--wait=true", "--timeout=120s"), { timeout: 130_000 });
  const guard = armDeadman(`kubectl --context ${CTX} delete ns ${ns} --wait=false`, 900);
  ctx.note(`데드맨 스위치 장전 (pid ${guard.pid}): 실험이 중단돼도 15분 뒤 네임스페이스 ${ns} 를 지운다`);
  await ctx.sh("kubectl", K("create", "ns", ns));
  return guard;
}

async function dropNamespace(ctx: ShellCtx, ns: string) {
  await ctx.sh("kubectl", K("delete", "ns", ns, "--wait=false"), { allowFail: true, label: `kubectl delete ns ${ns}   # 정리 (Linkerd 컨트롤 플레인은 남긴다)` });
}

const meshed = { "linkerd.io/inject": "enabled" };

function deploy(name: string, labels: Record<string, string>, container: string, opts: { replicas?: number; inject?: boolean; sa?: string } = {}): string {
  const lab = JSON.stringify(labels);
  const ann = opts.inject === false ? "{}" : JSON.stringify(meshed);
  return `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${name} }
spec:
  replicas: ${opts.replicas ?? 1}
  selector: { matchLabels: ${lab} }
  template:
    metadata: { labels: ${lab}, annotations: ${ann} }
    spec:
      ${opts.sa ? `serviceAccountName: ${opts.sa}` : ""}
      terminationGracePeriodSeconds: 2
      containers: [${container}]
---
`;
}

function service(name: string, selector: Record<string, string>, targetPort: number): string {
  return `apiVersion: v1
kind: Service
metadata: { name: ${name} }
spec: { selector: ${JSON.stringify(selector)}, ports: [{ name: http, port: 80, targetPort: ${targetPort} }] }
---
`;
}

const CURL = `{ name: curl, image: "curlimages/curl:8.11.1", command: ["sleep", "3600"] }`;
const WHOAMI = `{ name: whoami, image: "traefik/whoami:v1.10.3", ports: [{ containerPort: 80 }] }`;
const echo = (text: string, status = 200) => `{ name: echo, image: "hashicorp/http-echo:1.0", args: ["-text=${text}", "-listen=:5678"${status !== 200 ? `, "-status-code=${status}"` : ""}], ports: [{ containerPort: 5678 }] }`;

/** 클라이언트 Pod 안에서 n 번 요청하고 "상태코드 시간" 줄을 돌려받는다 */
async function burst(ns: string, client: string, url: string, n: number, extra = ""): Promise<{ code: string; s: number; body: string }[]> {
  const script = `for i in $(seq 1 ${n}); do curl -s --max-time 6 ${extra} -o /tmp/b -w "%{http_code} %{time_total} " "${url}"; head -c 40 /tmp/b 2>/dev/null | tr -d '\\n'; echo; done`;
  const r = await exec("kubectl", K("-n", ns, "exec", `deploy/${client}`, "-c", "curl", "--", "sh", "-c", script), { timeout: 300_000 });
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [code, t, ...rest] = l.split(" ");
      return { code, s: Number(t), body: rest.join(" ").trim() };
    });
}

function count(xs: { code: string }[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of xs) m[x.code] = (m[x.code] ?? 0) + 1;
  return m;
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const ms = (s: number) => `${Math.round(s * 1000)}`;

// ------------------------------------------------------------------------------------------ 1. mTLS 와 신원 기반 인가
export const meshMtls: ShellExperiment = {
  id: "mesh-mtls",
  subject: "service-mesh",
  title: "mTLS 와 서비스 신원: 주입된 Pod 끼리는 자동으로 암호화·인증되고, 신원으로 접근을 막을 수 있다",
  category: "보안",
  summary: "whoami 서버(메시)에 메시 클라이언트와 일반 클라이언트가 요청한 뒤 서버 프록시 메트릭에서 tls·client_id 를 확인하고, 프록시 인증서 만료까지 남은 시간을 읽는다. 이어 Server·MeshTLSAuthentication·AuthorizationPolicy 로 '이 ServiceAccount 신원만 허용' 을 걸어 일반 클라이언트가 403 을 받는 것을 본다",
  notes: ["03-mtls-identity", "01-what-mesh-solves"],
  description: `
Linkerd 는 Pod 에 프록시(사이드카)를 주입하고, 프록시끼리 **자동으로 mTLS** 를 맺는다. 앱 코드도, 인증서 발급·회전도 손댈 필요가 없다.
신원은 IP 가 아니라 **ServiceAccount** 다: \`client-meshed.mesh-lab-mtls.serviceaccount.identity.linkerd.cluster.local\`. 그래서 Pod 가 재시작해 IP 가 바뀌어도 정책이 그대로 맞는다.
이 실험은 메시 클라이언트와 메시 밖 클라이언트가 같은 서버를 부를 때 서버 프록시가 둘을 어떻게 구분하는지 메트릭으로 확인하고, 신원 기반 인가 정책으로 메시 밖 요청을 거절한다.
`,
  code: `kubectl -n mesh-lab-mtls annotate … linkerd.io/inject=enabled            # Pod 템플릿에 주입
kubectl -n mesh-lab-mtls exec deploy/client-meshed -c curl -- curl -s http://whoami/
linkerd diagnostics proxy-metrics -n mesh-lab-mtls deploy/whoami | grep 'request_total{direction="inbound"'
#   tls="true", client_id="client-meshed.mesh-lab-mtls.serviceaccount.identity.linkerd.cluster.local"
#   tls="no_identity", no_tls_reason="no_tls_from_remote"      ← 메시 밖 클라이언트
# 신원 기반 인가 (policy.linkerd.io)
Server(podSelector app=whoami, port 80) + MeshTLSAuthentication(identities: [client-meshed…]) + AuthorizationPolicy(targetRef Server)`,
  requires: requiresMesh,
  cleanup: async (ctx) => dropNamespace(ctx, "mesh-lab-mtls"),
  async run(ctx) {
    const ns = "mesh-lab-mtls";
    const guard = await freshNamespace(ctx, ns);
    try {
      await apply(
        ctx,
        ns,
        `apiVersion: v1
kind: ServiceAccount
metadata: { name: client-meshed }
---
${deploy("whoami", { app: "whoami" }, WHOAMI)}${service("whoami", { app: "whoami" }, 80)}${deploy("client-meshed", { app: "client-meshed" }, CURL, { sa: "client-meshed" })}${deploy("client-plain", { app: "client-plain" }, CURL, { inject: false })}`,
        "kubectl apply: whoami(메시) · client-meshed(메시, SA client-meshed) · client-plain(메시 밖)",
      );
      await rollout(ctx, ns, ["whoami", "client-meshed", "client-plain"]);
      const pods = await ctx.sh("kubectl", K("-n", ns, "get", "pods", "-o", 'jsonpath={range .items[*]}{.metadata.labels.app}{"\\tinit="}{.spec.initContainers[*].name}{"\\tcontainers="}{.spec.containers[*].name}{"\\n"}{end}'), { label: "kubectl get pods -o jsonpath='{… initContainers[*].name … containers[*].name}'   # 주입 결과" });
      const line = (app: string) => pods.out.split("\n").find((l) => l.startsWith(`${app}\t`)) ?? "";
      ctx.check("주입된 Pod 에 linkerd-proxy 가 붙었다 — 네이티브 사이드카(restartPolicy: Always 인 initContainer)로", /init=.*linkerd-proxy/.test(line("whoami")) && /init=.*linkerd-proxy/.test(line("client-meshed")), pods.out);
      ctx.check("메시 밖 클라이언트에는 프록시가 없다", !/linkerd-proxy/.test(line("client-plain")), line("client-plain"));
      ctx.note("이 Linkerd 는 proxy.nativeSidecar=true 다. 프록시가 일반 컨테이너가 아니라 initContainer(restartPolicy: Always)로 들어가므로, 앱 컨테이너보다 먼저 떠 있고 앱이 끝난 뒤에 종료된다 — Job 이 끝나지 않던 사이드카 고질병이 사라진다(노트 02).");

      const url = `http://whoami.${ns}.svc.cluster.local/`;
      const a = await burst(ns, "client-meshed", url, 10);
      const b = await burst(ns, "client-plain", url, 10);
      ctx.table("정책 없음 — 두 클라이언트 모두 통과", ["클라이언트", "응답"], [
        ["client-meshed (메시)", JSON.stringify(count(a))],
        ["client-plain (메시 밖)", JSON.stringify(count(b))],
      ]);

      const met = await ctx.sh(linkerdBin(), ["--context", CTX, "diagnostics", "proxy-metrics", "-n", ns, "deploy/whoami"], { timeout: 60_000, label: `linkerd diagnostics proxy-metrics -n ${ns} deploy/whoami   # 서버 쪽 프록시 메트릭 (출력 일부만 해석)` });
      const inbound = met.out.split("\n").filter((l) => l.startsWith('request_total{direction="inbound"') && l.includes('target_port="80"'));
      const rows = inbound.map((l) => {
        const tls = l.match(/tls="([^"]+)"/)?.[1] ?? "?";
        const cid = l.match(/client_id="([^"]+)"/)?.[1] ?? l.match(/no_tls_reason="([^"]+)"/)?.[1] ?? "";
        return [tls, cid, l.trim().split(" ").pop() ?? ""];
      });
      ctx.table("서버 프록시가 본 인바운드 요청 (request_total)", ["tls", "client_id / 이유", "요청 수"], rows);
      ctx.check("메시 클라이언트의 요청은 tls=true 이고 ServiceAccount 신원이 붙어 있다", rows.some((r) => r[0] === "true" && r[1].startsWith(`client-meshed.${ns}.serviceaccount.identity.linkerd.cluster.local`)), JSON.stringify(rows));
      ctx.check("메시 밖 클라이언트의 요청은 평문으로 기록된다 (no_tls_from_remote)", rows.some((r) => r[0] === "no_identity" && r[1] === "no_tls_from_remote"));
      const cfg = await exec("kubectl", K("-n", "linkerd", "get", "cm", "linkerd-config", "-o", "jsonpath={.data.values}"), { timeout: 15_000 });
      const life = cfg.out.match(/issuanceLifetime:\s*(\S+)/)?.[1];
      const domain = cfg.out.match(/identityTrustDomain:\s*(\S+)/)?.[1];
      if (life) ctx.note(`워크로드 인증서 발급 수명 issuanceLifetime=${life}, 신뢰 도메인 ${domain ?? "?"} (linkerd-config). 프록시는 이 짧은 인증서를 만료 전에 identity 컨트롤러에서 스스로 다시 받는다 — 회전이 사람의 일이 아니다. 사람이 관리할 것은 1년짜리 트러스트 앵커·발급자 인증서다(노트 03).`);

      ctx.note("신원 기반 인가: whoami 의 80 포트를 Server 로 정의하고, client-meshed 신원만 허용하는 AuthorizationPolicy 를 건다");
      await apply(
        ctx,
        ns,
        `apiVersion: policy.linkerd.io/v1beta3
kind: Server
metadata: { name: whoami-http }
spec: { podSelector: { matchLabels: { app: whoami } }, port: 80, proxyProtocol: HTTP/1 }
---
apiVersion: policy.linkerd.io/v1alpha1
kind: MeshTLSAuthentication
metadata: { name: only-client-meshed }
spec: { identities: ["client-meshed.${ns}.serviceaccount.identity.linkerd.cluster.local"] }
---
apiVersion: policy.linkerd.io/v1alpha1
kind: AuthorizationPolicy
metadata: { name: whoami-allow-client-meshed }
spec:
  targetRef: { group: policy.linkerd.io, kind: Server, name: whoami-http }
  requiredAuthenticationRefs: [{ group: policy.linkerd.io, kind: MeshTLSAuthentication, name: only-client-meshed }]
`,
        "kubectl apply: Server(whoami:80) + MeshTLSAuthentication(client-meshed) + AuthorizationPolicy",
      );
      await ctx.poll("정책이 서버 프록시에 반영될 때까지 (메시 밖 요청이 403)", async () => ((await burst(ns, "client-plain", url, 1))[0]?.code === "403" ? true : undefined), { timeoutMs: 60_000, intervalMs: 1500 });
      const a2 = await burst(ns, "client-meshed", url, 10);
      const b2 = await burst(ns, "client-plain", url, 10);
      ctx.table("정책 적용 후", ["클라이언트", "응답"], [
        ["client-meshed (허용된 신원)", JSON.stringify(count(a2))],
        ["client-plain (신원 없음)", JSON.stringify(count(b2))],
      ]);
      ctx.check("허용된 신원은 계속 200", (count(a2)["200"] ?? 0) === 10, JSON.stringify(count(a2)));
      ctx.check("신원이 없는 메시 밖 클라이언트는 403", (count(b2)["403"] ?? 0) === 10, JSON.stringify(count(b2)));
      ctx.note("NetworkPolicy(L3/L4, IP·포트)와 달리 이 정책은 '누구냐(ServiceAccount)' 로 결정한다. 둘은 겹쳐 쓰는 층이다 — 보안 노트 06 참고.");
    } finally {
      await dropNamespace(ctx, ns);
      guard.disarm();
    }
  },
};

// ------------------------------------------------------------------------------------------ 2. 재시도·장애 축적·타임아웃
export const meshRetryBudget: ShellExperiment = {
  id: "mesh-retry-budget",
  subject: "service-mesh",
  title: "트래픽 정책: 503 을 내는 Pod 하나를 재시도·장애 축적(서킷 브레이커)·타임아웃으로 다스린다",
  category: "복원력",
  summary: "정상 Pod 2개와 항상 503 을 내는 Pod 1개가 같은 Service 뒤에 있다. 메시 클라이언트로 60번씩 부르며 정책 없음 → 재시도(5xx, 최대 2회) → 장애 축적(연속 3번 실패하면 엔드포인트 격리)의 성공률과 지연을 비교하고, 2초 걸리는 요청에 500ms 타임아웃을 걸어 504 로 빨리 끊기는 것을 본다",
  notes: ["04-traffic-policy", "05-observability"],
  description: `
메시는 재시도·타임아웃·서킷 브레이커를 **앱 코드가 아니라 클라이언트 쪽 프록시**에서 수행한다. Linkerd 에서는 Service(또는 HTTPRoute)에 어노테이션 몇 줄이면 된다.
- \`retry.linkerd.io/http: 5xx\` + \`retry.linkerd.io/limit: "2"\` — 5xx 를 받으면 다른 엔드포인트로 최대 2번 더 보낸다
- \`balancer.linkerd.io/failure-accrual: consecutive\` — 연속 N 번 실패한 엔드포인트를 잠시 부하 분산에서 뺀다(서킷 브레이커)
- \`timeout.linkerd.io/request: 500ms\` — 그 시간 안에 응답이 없으면 프록시가 504 로 끊는다
재시도는 공짜가 아니다. 장애가 넓게 퍼지면 재시도가 부하를 몇 배로 키운다 — 그래서 횟수 상한과 **재시도 예산**(전체 요청 대비 비율)이 필요하다(장애 실험실 노트 03).
`,
  code: `kubectl -n mesh-lab-retry annotate svc web retry.linkerd.io/http=5xx retry.linkerd.io/limit=2
kubectl -n mesh-lab-retry annotate svc web balancer.linkerd.io/failure-accrual=consecutive \\
        balancer.linkerd.io/failure-accrual-consecutive-max-failures=3
kubectl -n mesh-lab-retry annotate svc whoami timeout.linkerd.io/request=500ms
kubectl -n mesh-lab-retry exec deploy/client-meshed -c curl -- curl -s -w '%{http_code} %{time_total}' http://whoami/?wait=2s`,
  requires: requiresMesh,
  cleanup: async (ctx) => dropNamespace(ctx, "mesh-lab-retry"),
  async run(ctx) {
    const ns = "mesh-lab-retry";
    const guard = await freshNamespace(ctx, ns);
    try {
      await apply(
        ctx,
        ns,
        `${deploy("web-good", { app: "web", v: "good" }, echo("ok"), { replicas: 2 })}${deploy("web-bad", { app: "web", v: "bad" }, echo("boom", 503))}${service("web", { app: "web" }, 5678)}${deploy("whoami", { app: "whoami" }, WHOAMI)}${service("whoami", { app: "whoami" }, 80)}${deploy("client-meshed", { app: "client-meshed" }, CURL)}`,
        "kubectl apply: web-good ×2 (200) · web-bad ×1 (항상 503) → Service web, whoami(지연용), client-meshed",
      );
      await rollout(ctx, ns, ["web-good", "web-bad", "whoami", "client-meshed"]);
      const url = `http://web.${ns}.svc.cluster.local/`;
      const phases: { label: string; set?: string[]; unset?: string[] }[] = [
        { label: "정책 없음" },
        { label: "재시도 5xx · 최대 2회", set: ["retry.linkerd.io/http=5xx", "retry.linkerd.io/limit=2"] },
        { label: "장애 축적 (연속 3회 실패 → 격리), 재시도 없음", unset: ["retry.linkerd.io/http-", "retry.linkerd.io/limit-"], set: ["balancer.linkerd.io/failure-accrual=consecutive", "balancer.linkerd.io/failure-accrual-consecutive-max-failures=3"] },
      ];
      const rows: string[][] = [];
      const ok: number[] = [];
      for (const ph of phases) {
        if (ph.unset) await ctx.sh("kubectl", K("-n", ns, "annotate", "svc", "web", ...ph.unset), { allowFail: true });
        if (ph.set) await ctx.sh("kubectl", K("-n", ns, "annotate", "svc", "web", ...ph.set, "--overwrite"));
        if (ph.set || ph.unset) await ctx.sleep(6000); // 목적지 컨트롤러 → 클라이언트 프록시로 정책 전파
        const r = await burst(ns, "client-meshed", url, 60);
        const c = count(r);
        const succ = (c["200"] ?? 0) / Math.max(1, r.length);
        ok.push(succ);
        const lat = r.map((x) => x.s);
        rows.push([ph.label, String(c["200"] ?? 0), String(r.length - (c["200"] ?? 0)), `${(succ * 100).toFixed(0)}%`, ms(pct(lat, 50)), ms(pct(lat, 99))]);
      }
      ctx.table("Service web (정상 2 · 503 1) 에 60번씩", ["정책", "200", "실패", "성공률", "p50 ms", "p99 ms"], rows);
      ctx.check("정책 없음: 503 Pod 로 간 요청이 그대로 실패한다 (5% 이상)", ok[0] < 0.95, `${(ok[0] * 100).toFixed(0)}%`);
      ctx.check("재시도를 켜면 성공률이 98% 이상 — 실패한 요청을 프록시가 다른 Pod 로 다시 보낸다", ok[1] >= 0.98, `${(ok[1] * 100).toFixed(0)}%`);
      ctx.check("장애 축적만으로도 정책 없음보다 성공률이 높다 — 나쁜 Pod 가 부하 분산에서 잠시 빠진다", ok[2] > ok[0], `${(ok[2] * 100).toFixed(0)}% > ${(ok[0] * 100).toFixed(0)}%`);
      ctx.note("재시도 행의 p99 가 늘었다면 그것이 재시도의 비용이다: 실패를 지연으로 바꾼다. 장애 축적은 실패를 처음부터 피하므로 지연이 늘지 않지만, 격리 직전 몇 번은 실패를 그대로 돌려준다 — 둘을 함께 쓰는 이유다.");

      ctx.note("타임아웃 — whoami 의 ?wait=2s 로 2초 걸리는 요청을 만든다");
      const slowUrl = `http://whoami.${ns}.svc.cluster.local/?wait=2s`;
      const before = (await burst(ns, "client-meshed", slowUrl, 3))[1];
      await ctx.sh("kubectl", K("-n", ns, "annotate", "svc", "whoami", "timeout.linkerd.io/request=500ms", "--overwrite"));
      await ctx.sleep(6000);
      const after = (await burst(ns, "client-meshed", slowUrl, 3))[1];
      ctx.table("2초 걸리는 요청", ["설정", "응답", "걸린 시간 ms"], [
        ["타임아웃 없음", before?.code ?? "?", ms(before?.s ?? 0)],
        ["timeout.linkerd.io/request=500ms", after?.code ?? "?", ms(after?.s ?? 0)],
      ]);
      ctx.check("타임아웃 없음: 2초 기다려 200", before?.code === "200" && (before?.s ?? 0) >= 1.9, `${before?.code} ${before?.s}s`);
      ctx.check("500ms 타임아웃: 프록시가 504 로 빨리 끊는다", after?.code === "504" && (after?.s ?? 9) < 1.2, `${after?.code} ${after?.s}s`);
      ctx.note("타임아웃은 호출자의 자원(스레드·커넥션·사용자 대기)을 지킨다. 하지만 서버는 그 요청을 계속 처리하고 있을 수 있다 — 끝까지 취소를 전파하려면 데드라인 전파가 필요하다(API 설계 노트 04).");
    } finally {
      await dropNamespace(ctx, ns);
      guard.disarm();
    }
  },
};

// ------------------------------------------------------------------------------------------ 3. 트래픽 분할 (Gateway API HTTPRoute)
export const meshTrafficSplit: ShellExperiment = {
  id: "mesh-traffic-split",
  subject: "service-mesh",
  title: "트래픽 분할: HTTPRoute 가중치 90/10 → 50/50 → 0/100 을 바꾸면 메시 클라이언트의 실제 응답 비율이 따라 움직인다",
  category: "배포",
  summary: "echo-v1·echo-v2 와 부모 Service echo 를 두고 Gateway API HTTPRoute 의 backendRefs 가중치를 세 번 바꾸며 메시 클라이언트로 200번씩 불러 실제 비율을 잰다. 같은 Service 를 메시 밖 클라이언트가 부르면 분할이 적용되지 않는다는 것도 확인한다 — 분할은 클라이언트 쪽 프록시가 한다",
  notes: ["06-canary-traffic-split", "02-sidecar-ambient"],
  description: `
카나리 배포의 핵심은 "새 버전에 트래픽의 일부만" 보내는 것이다. 복제본 수로 비율을 맞추는 방식(Argo Rollouts 의 기본, 쿠버네티스 노트 13)은 거칠다 — 복제본 4개면 25% 단위밖에 안 된다.
메시는 **요청 단위로** 비율을 정한다. Linkerd 는 Gateway API 의 \`HTTPRoute\` 를 Service 에 붙여(\`parentRefs: kind Service\`) backendRefs 가중치대로 나눈다.
이 분할은 **호출하는 쪽 프록시**에서 일어난다. 그래서 메시 밖 클라이언트는 원래 Service 의 셀렉터대로만 간다.
`,
  code: `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: echo-split }
spec:
  parentRefs: [{ group: core, kind: Service, name: echo, port: 80 }]
  rules:
    - backendRefs:
        - { name: echo-v1, port: 80, weight: 90 }
        - { name: echo-v2, port: 80, weight: 10 }
kubectl patch httproute echo-split --type=json -p '[{"op":"replace","path":"/spec/rules/0/backendRefs/0/weight","value":50}, …]'`,
  requires: async () => {
    const r = await requiresMesh();
    if (r) return r;
    const crd = await exec("kubectl", K("get", "crd", "httproutes.gateway.networking.k8s.io"), { timeout: 8000 });
    return crd.ok ? null : "Gateway API CRD(HTTPRoute)가 필요합니다: kubectl --context kind-study apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml";
  },
  cleanup: async (ctx) => dropNamespace(ctx, "mesh-lab-split"),
  async run(ctx) {
    const ns = "mesh-lab-split";
    const guard = await freshNamespace(ctx, ns);
    try {
      await apply(
        ctx,
        ns,
        `${deploy("echo-v1", { app: "echo", ver: "v1" }, echo("v1"))}${deploy("echo-v2", { app: "echo", ver: "v2" }, echo("v2"))}${service("echo", { app: "echo", ver: "v1" }, 5678)}${service("echo-v1", { app: "echo", ver: "v1" }, 5678)}${service("echo-v2", { app: "echo", ver: "v2" }, 5678)}${deploy("client-meshed", { app: "client-meshed" }, CURL)}${deploy("client-plain", { app: "client-plain" }, CURL, { inject: false })}`,
        "kubectl apply: echo-v1 · echo-v2 · Service echo(셀렉터는 v1) · echo-v1 · echo-v2 · client-meshed · client-plain",
      );
      await rollout(ctx, ns, ["echo-v1", "echo-v2", "client-meshed", "client-plain"]);
      const route = (w1: number, w2: number) => `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: echo-split }
spec:
  parentRefs: [{ group: core, kind: Service, name: echo, port: 80 }]
  rules:
    - backendRefs:
        - { name: echo-v1, port: 80, weight: ${w1} }
        - { name: echo-v2, port: 80, weight: ${w2} }
`;
      const url = `http://echo.${ns}.svc.cluster.local/`;
      const rows: string[][] = [];
      const share: Record<string, number> = {};
      for (const [w1, w2, n] of [[90, 10, 200], [50, 50, 200], [0, 100, 100]] as const) {
        await apply(ctx, ns, route(w1, w2), `kubectl apply HTTPRoute echo-split   # 가중치 v1 ${w1} / v2 ${w2}`);
        await ctx.sleep(5000);
        const r = await burst(ns, "client-meshed", url, n);
        const v2 = r.filter((x) => x.body.startsWith("v2")).length;
        share[`${w1}/${w2}`] = v2 / Math.max(1, r.length);
        rows.push([`${w1} / ${w2}`, String(r.length - v2), String(v2), `${((v2 / Math.max(1, r.length)) * 100).toFixed(1)}%`]);
      }
      const st = await ctx.sh("kubectl", K("-n", ns, "get", "httproute", "echo-split", "-o", "jsonpath={range .status.parents[*]}{.controllerName}: {range .conditions[*]}{.type}={.status} {end}{end}"), { label: "kubectl get httproute echo-split -o jsonpath='{.status.parents…}'   # Linkerd 가 경로를 받아들였는지" });
      ctx.table("메시 클라이언트가 받은 응답", ["가중치 v1 / v2", "v1", "v2", "v2 비율"], rows);
      ctx.check("HTTPRoute 가 Linkerd 에 Accepted", /Accepted=True/.test(st.out), st.out);
      ctx.check("90/10 → v2 비율 3~20%", share["90/10"] >= 0.03 && share["90/10"] <= 0.2, `${(share["90/10"] * 100).toFixed(1)}%`);
      ctx.check("50/50 → v2 비율 35~65%", share["50/50"] >= 0.35 && share["50/50"] <= 0.65, `${(share["50/50"] * 100).toFixed(1)}%`);
      ctx.check("0/100 → 전부 v2", share["0/100"] === 1, `${(share["0/100"] * 100).toFixed(1)}%`);
      const plain = await burst(ns, "client-plain", url, 40);
      const plainV2 = plain.filter((x) => x.body.startsWith("v2")).length;
      ctx.table("같은 시점(가중치 0/100)에 메시 밖 클라이언트", ["클라이언트", "v1", "v2"], [["client-plain", String(plain.length - plainV2), String(plainV2)]]);
      ctx.check("메시 밖 클라이언트는 분할이 적용되지 않고 Service 셀렉터(v1)로만 간다 — 분할은 호출 쪽 프록시의 일", plainV2 === 0 && plain.length > 0, `v2 ${plainV2}/${plain.length}`);
      ctx.note("Argo Rollouts 는 trafficRouting.plugins 로 이 HTTPRoute 의 가중치를 단계별로 바꾸며 분석(AnalysisTemplate)을 돌린다 — 쿠버네티스 노트 13 의 복제본 비율 카나리를 요청 비율 카나리로 바꾸는 방법이다(노트 06).");
    } finally {
      await dropNamespace(ctx, ns);
      guard.disarm();
    }
  },
};
