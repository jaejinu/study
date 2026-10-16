import { execFile } from "node:child_process";

export interface KubeStatus {
  installed: boolean;
  clientVersion?: string;
  context?: string;
  connected: boolean;
  serverVersion?: string;
  nodes?: { name: string; status: string; version: string; roles: string }[];
  pods?: { namespace: string; name: string; status: string; ready: string }[];
  error?: string;
  /** 부가 컴포넌트 상태 */
  addons?: { name: string; status: string; detail?: string }[];
}

function run(args: string[], timeout = 5000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("kubectl", args, { timeout, env: process.env }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (err ? stderr || err.message : stdout).trim() }),
    );
  });
}

interface NodeList {
  items: { metadata: { name: string; labels?: Record<string, string> }; status: { conditions: { type: string; status: string }[]; nodeInfo: { kubeletVersion: string } } }[];
}
interface PodList {
  items: { metadata: { name: string; namespace: string }; status: { phase: string; containerStatuses?: { ready: boolean }[] } }[];
}

/** kubectl / 현재 컨텍스트 / 노드·Pod 상태 (클러스터가 없어도 안내용 정보 반환) */
export async function getKubeStatus(): Promise<KubeStatus> {
  const client = await run(["version", "--client", "-o", "json"]);
  if (!client.ok) {
    const missing = /ENOENT|not found/i.test(client.out);
    return { installed: !missing, connected: false, error: missing ? "kubectl 이 설치되어 있지 않습니다" : client.out };
  }
  const clientVersion = (JSON.parse(client.out) as { clientVersion?: { gitVersion?: string } }).clientVersion?.gitVersion;
  const ctx = await run(["config", "current-context"]);
  if (!ctx.ok) return { installed: true, clientVersion, connected: false, error: "현재 컨텍스트가 없습니다 (클러스터 미생성)" };

  const nodesRes = await run(["get", "nodes", "-o", "json", "--request-timeout=4s"], 6000);
  if (!nodesRes.ok) {
    return { installed: true, clientVersion, context: ctx.out, connected: false, error: nodesRes.out.split("\n")[0] };
  }
  const nodes = (JSON.parse(nodesRes.out) as NodeList).items.map((n) => ({
    name: n.metadata.name,
    status: n.status.conditions.find((c) => c.type === "Ready")?.status === "True" ? "Ready" : "NotReady",
    version: n.status.nodeInfo.kubeletVersion,
    roles: Object.keys(n.metadata.labels ?? {})
      .filter((l) => l.startsWith("node-role.kubernetes.io/"))
      .map((l) => l.split("/")[1])
      .join(",") || "worker",
  }));
  const podsRes = await run(["get", "pods", "-A", "-o", "json", "--request-timeout=4s"], 6000);
  const pods = podsRes.ok
    ? (JSON.parse(podsRes.out) as PodList).items
        .filter((p) => !p.metadata.namespace.startsWith("kube-") && p.metadata.namespace !== "local-path-storage")
        .map((p) => ({
          namespace: p.metadata.namespace,
          name: p.metadata.name,
          status: p.status.phase,
          ready: `${(p.status.containerStatuses ?? []).filter((c) => c.ready).length}/${(p.status.containerStatuses ?? []).length}`,
        }))
    : [];
  const addons: { name: string; status: string; detail?: string }[] = [];
  const [ms, kps, argo, rollouts, app] = await Promise.all([
    run(["-n", "kube-system", "get", "deploy", "metrics-server", "-o", "jsonpath={.status.readyReplicas}", "--request-timeout=4s"], 6000),
    run(["-n", "monitoring", "get", "deploy", "-l", "app.kubernetes.io/name=grafana", "-o", "jsonpath={.items[0].status.readyReplicas}", "--request-timeout=4s"], 6000),
    run(["-n", "argocd", "get", "deploy", "argocd-server", "-o", "jsonpath={.status.readyReplicas}", "--request-timeout=4s"], 6000),
    run(["-n", "argo-rollouts", "get", "deploy", "argo-rollouts", "-o", "jsonpath={.status.readyReplicas}", "--request-timeout=4s"], 6000),
    run(["-n", "argocd", "get", "application", "study", "-o", "jsonpath={.status.sync.status} {.status.health.status}", "--request-timeout=4s"], 6000),
  ]);
  const up = (r: { ok: boolean; out: string }) => (r.ok && Number(r.out) > 0 ? "ready" : "없음");
  addons.push({ name: "metrics-server (HPA)", status: up(ms), detail: up(ms) === "없음" ? "pnpm k8s:metrics" : undefined });
  addons.push({ name: "kube-prometheus-stack", status: up(kps), detail: up(kps) === "없음" ? "pnpm k8s:monitoring" : "pnpm k8s:grafana:port → :13001" });
  addons.push({ name: "ArgoCD", status: up(argo), detail: up(argo) === "없음" ? "pnpm k8s:argocd" : app.ok && app.out.trim() ? `Application study: ${app.out}` : "Application 없음 (kubectl apply -f k8s/argocd/application.yaml)" });
  addons.push({ name: "Argo Rollouts", status: up(rollouts), detail: up(rollouts) === "없음" ? "pnpm k8s:rollouts" : "kubectl argo rollouts get rollout web-canary -n study" });
  return { installed: true, clientVersion, context: ctx.out, connected: true, serverVersion: nodes[0]?.version, nodes, pods, addons };
}
