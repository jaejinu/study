import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

const NS = "study";
const K = (...args: string[]) => ["-n", NS, ...args];

async function requiresCluster(): Promise<string | null> {
  const ctx = await exec("kubectl", ["config", "current-context"], { timeout: 5000 });
  if (!ctx.ok) return "kubectl 컨텍스트가 없습니다. `pnpm k8s:cluster` 로 kind 클러스터를 만드세요.";
  const nodes = await exec("kubectl", ["get", "nodes", "--request-timeout=5s"], { timeout: 8000 });
  if (!nodes.ok) return `클러스터(${ctx.out})에 연결할 수 없습니다. Docker 와 kind 클러스터가 실행 중인지 확인하세요.`;
  return null;
}

async function ensureNamespace(ctx: ShellCtx) {
  const r = await ctx.sh("kubectl", ["get", "ns", NS], { allowFail: true });
  if (!r.ok) await ctx.sh("kubectl", ["create", "ns", NS]);
}

async function cleanupLab(ctx: ShellCtx) {
  await ctx.sh("kubectl", K("delete", "deploy,svc,cm,pod", "-l", "lab=true", "--ignore-not-found", "--wait=false"), { allowFail: true });
  await ctx.poll(
    "lab 리소스의 Pod 이 모두 사라질 때까지",
    async () => {
      const r = await exec("kubectl", K("get", "pods", "-l", "lab=true", "-o", "name"));
      return r.ok && r.out === "" ? true : undefined;
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
}

async function podNames(name: string): Promise<string[]> {
  const r = await exec("kubectl", K("get", "pods", "-l", `app=${name}`, "-o", "jsonpath={.items[*].metadata.name}"));
  return r.ok && r.out ? r.out.split(/\s+/) : [];
}

async function readyPods(name: string): Promise<number> {
  const r = await exec("kubectl", K("get", "pods", "-l", `app=${name}`, "-o", "jsonpath={range .items[*]}{.status.containerStatuses[0].ready}{\"\\n\"}{end}"));
  return r.ok ? r.out.split("\n").filter((l) => l.trim() === "true").length : 0;
}

async function createDeploy(ctx: ShellCtx, name: string, image: string, replicas: number) {
  await ctx.sh("kubectl", K("create", "deployment", name, `--image=${image}`, `--replicas=${replicas}`, "--port=80"));
  await ctx.sh("kubectl", K("label", "deploy", name, "lab=true"));
  await ctx.sh("kubectl", K("rollout", "status", `deploy/${name}`, "--timeout=120s"), { timeout: 130_000 });
}

export const k8sSelfHealing: ShellExperiment = {
  id: "k8s-self-healing",
  subject: "kubernetes",
  title: "자가 치유: Pod 을 지우면 다시 살아난다",
  category: "워크로드",
  summary: "Deployment 의 Pod 을 전부 삭제하고 ReplicaSet 이 새 Pod 을 만들어 복제본 수를 회복하는 과정을 관찰",
  notes: ["03-pod-deployment", "01-kubernetes-overview"],
  description: `
Deployment 는 "이 레이블의 Pod 이 N 개 있어야 한다" 는 **원하는 상태**를 저장한다. Pod 을 지우면 현재 상태(0개)와 원하는 상태(2개)가
달라지고, ReplicaSet 컨트롤러가 즉시 새 Pod 을 만든다. 새 Pod 은 **이름과 IP 가 다르다** — 그래서 Pod 을 직접 가리키면 안 되고 Service 를 쓴다.
`,
  code: `kubectl -n study create deployment lab-web --image=nginx:1.27-alpine --replicas=2
kubectl -n study rollout status deploy/lab-web
kubectl -n study get pods -l app=lab-web
kubectl -n study delete pods -l app=lab-web      # 전부 삭제
kubectl -n study get pods -l app=lab-web -w      # 새 이름으로 다시 2개`,
  requires: requiresCluster,
  cleanup: cleanupLab,
  async run(ctx) {
    await ensureNamespace(ctx);
    await createDeploy(ctx, "lab-web", "nginx:1.27-alpine", 2);
    const before = await podNames("lab-web");
    await ctx.sh("kubectl", K("get", "pods", "-l", "app=lab-web", "-o", "wide"));
    ctx.note(`현재 Pod: ${before.join(", ")}`);

    await ctx.sh("kubectl", K("delete", "pods", "-l", "app=lab-web", "--wait=false"));
    const after = await ctx.poll(
      "새 Pod 2개가 Ready 가 될 때까지",
      async () => {
        const names = await podNames("lab-web");
        const fresh = names.filter((n) => !before.includes(n));
        return fresh.length >= 2 && (await readyPods("lab-web")) >= 2 ? fresh : undefined;
      },
      { timeoutMs: 90_000 },
    );
    await ctx.sh("kubectl", K("get", "pods", "-l", "app=lab-web", "-o", "wide"));
    ctx.check("새 Pod 이름이 이전과 다르다", after.every((n) => !before.includes(n)), `이전: ${before.join(", ")}\n이후: ${after.join(", ")}`);
    await ctx.sh("kubectl", K("get", "deploy", "lab-web"));
    await ctx.sh("kubectl", K("get", "events", "--field-selector", "reason=SuccessfulCreate", "--sort-by=.lastTimestamp"), { allowFail: true });
  },
};

export const k8sScale: ShellExperiment = {
  id: "k8s-scale",
  subject: "kubernetes",
  title: "스케일 아웃/인: 복제본 수 바꾸기",
  category: "워크로드",
  summary: "replicas 를 1 → 4 → 1 로 바꾸며 Pod 이 생기고 사라지는 속도를 측정",
  notes: ["03-pod-deployment", "07-deploy-resources"],
  description: `
\`kubectl scale\` 은 Deployment 의 \`spec.replicas\` 만 바꾼다. 나머지는 컨트롤러가 알아서 한다.
늘릴 때는 스케줄링 + 이미지(캐시됨) + 컨테이너 시작 시간이 걸리고, 줄일 때는 SIGTERM 후 \`terminationGracePeriodSeconds\`(기본 30초) 안에 종료된다.
HPA 는 이 값을 메트릭에 따라 자동으로 조정한다.
`,
  code: `kubectl -n study create deployment lab-scale --image=nginx:1.27-alpine --replicas=1
kubectl -n study scale deploy/lab-scale --replicas=4
kubectl -n study get pods -l app=lab-scale -w
kubectl -n study scale deploy/lab-scale --replicas=1`,
  requires: requiresCluster,
  cleanup: cleanupLab,
  async run(ctx) {
    await ensureNamespace(ctx);
    await createDeploy(ctx, "lab-scale", "nginx:1.27-alpine", 1);
    await ctx.sh("kubectl", K("scale", "deploy/lab-scale", "--replicas=4"));
    const up = await ctx.measure("4개가 Ready 될 때까지", () =>
      ctx.poll("Ready 4/4", async () => ((await readyPods("lab-scale")) >= 4 ? true : undefined), { timeoutMs: 90_000, intervalMs: 500 }),
    );
    await ctx.sh("kubectl", K("get", "pods", "-l", "app=lab-scale"));
    ctx.check("Pod 4개", (await podNames("lab-scale")).length === 4);

    await ctx.sh("kubectl", K("scale", "deploy/lab-scale", "--replicas=1"));
    const down = await ctx.measure("1개만 남을 때까지", () =>
      ctx.poll("Pod 1개", async () => ((await podNames("lab-scale")).length === 1 ? true : undefined), { timeoutMs: 90_000, intervalMs: 500 }),
    );
    await ctx.sh("kubectl", K("get", "pods", "-l", "app=lab-scale"));
    ctx.note(`스케일 아웃 ${up.ms}ms, 스케일 인 ${down.ms}ms (nginx 는 SIGTERM 에 바로 종료되어 빠르다)`);
  },
};

export const k8sRollingUpdate: ShellExperiment = {
  id: "k8s-rolling-update",
  subject: "kubernetes",
  title: "롤링 업데이트와 롤백",
  category: "워크로드",
  summary: "이미지를 바꿔 무중단 교체를 관찰하고, rollout history 를 본 뒤 undo 로 되돌리기",
  notes: ["03-pod-deployment", "07-deploy-resources"],
  description: `
\`set image\` 로 Pod 템플릿이 바뀌면 Deployment 는 **새 ReplicaSet** 을 만들어 Pod 을 하나씩 늘리고 옛 ReplicaSet 을 줄인다.
옛 ReplicaSet 은 0개로 남아 있어서 \`rollout undo\` 가 순식간에 가능하다. \`--record\` 대신 \`kubernetes.io/change-cause\` annotation 으로 이력에 메모를 남긴다.
`,
  code: `kubectl -n study create deployment lab-roll --image=nginx:1.27-alpine --replicas=3
kubectl -n study set image deploy/lab-roll nginx=nginx:1.28-alpine
kubectl -n study rollout status deploy/lab-roll
kubectl -n study get rs -l app=lab-roll          # 새 RS 3개, 옛 RS 0개
kubectl -n study rollout history deploy/lab-roll
kubectl -n study rollout undo deploy/lab-roll
kubectl -n study get deploy lab-roll -o jsonpath='{.spec.template.spec.containers[0].image}'`,
  requires: requiresCluster,
  cleanup: cleanupLab,
  async run(ctx) {
    await ensureNamespace(ctx);
    await createDeploy(ctx, "lab-roll", "nginx:1.27-alpine", 3);
    await ctx.sh("kubectl", K("annotate", "deploy/lab-roll", "kubernetes.io/change-cause=initial nginx:1.27", "--overwrite"));
    await ctx.sh("kubectl", K("set", "image", "deploy/lab-roll", "nginx=nginx:1.28-alpine"));
    await ctx.sh("kubectl", K("annotate", "deploy/lab-roll", "kubernetes.io/change-cause=upgrade to nginx:1.28", "--overwrite"));
    await ctx.sh("kubectl", K("rollout", "status", "deploy/lab-roll", "--timeout=120s"), { timeout: 130_000 });
    await ctx.sh("kubectl", K("get", "rs", "-l", "app=lab-roll"));
    const img = await ctx.sh("kubectl", K("get", "deploy", "lab-roll", "-o", "jsonpath={.spec.template.spec.containers[0].image}"));
    ctx.check("이미지가 1.28 로 바뀜", img.out === "nginx:1.28-alpine", img.out);
    await ctx.sh("kubectl", K("rollout", "history", "deploy/lab-roll"));

    ctx.note("문제가 생겼다고 가정하고 되돌린다");
    await ctx.sh("kubectl", K("rollout", "undo", "deploy/lab-roll"));
    await ctx.sh("kubectl", K("rollout", "status", "deploy/lab-roll", "--timeout=120s"), { timeout: 130_000 });
    const back = await ctx.sh("kubectl", K("get", "deploy", "lab-roll", "-o", "jsonpath={.spec.template.spec.containers[0].image}"));
    ctx.check("롤백 후 1.27", back.out === "nginx:1.27-alpine", back.out);
    await ctx.sh("kubectl", K("get", "rs", "-l", "app=lab-roll"));
  },
};

export const k8sServiceEndpoints: ShellExperiment = {
  id: "k8s-service-endpoints",
  subject: "kubernetes",
  title: "Service: 바뀌는 Pod IP 를 고정 이름으로",
  category: "네트워킹",
  summary: "Service 의 endpoints 가 Pod 교체에 따라 갱신되는 것을 보고, 임시 Pod 에서 DNS 이름으로 접속",
  notes: ["04-service-ingress"],
  description: `
Service 는 selector 에 맞는 **Ready 상태** Pod 들의 IP 를 endpoints 로 유지한다. Pod 이 죽고 새로 생기면 endpoints 가 자동으로 바뀌지만
Service 의 ClusterIP 와 DNS 이름(\`lab-svc\`)은 그대로다. 클러스터 안의 다른 Pod 은 \`http://lab-svc\` 로 접속한다.
`,
  code: `kubectl -n study create deployment lab-svc --image=nginx:1.27-alpine --replicas=2
kubectl -n study expose deployment lab-svc --port=80
kubectl -n study get endpoints lab-svc
kubectl -n study delete pod -l app=lab-svc
kubectl -n study get endpoints lab-svc          # IP 가 바뀜
kubectl -n study run curl --rm -i --image=curlimages/curl -- curl -s http://lab-svc`,
  requires: requiresCluster,
  cleanup: cleanupLab,
  async run(ctx) {
    await ensureNamespace(ctx);
    await createDeploy(ctx, "lab-svc", "nginx:1.27-alpine", 2);
    await ctx.sh("kubectl", K("expose", "deployment", "lab-svc", "--port=80"));
    await ctx.sh("kubectl", K("label", "svc", "lab-svc", "lab=true"));
    await ctx.sh("kubectl", K("get", "svc", "lab-svc"));
    const ep1 = await ctx.sh("kubectl", K("get", "endpoints", "lab-svc", "-o", "jsonpath={.subsets[*].addresses[*].ip}"));
    ctx.note(`endpoints: ${ep1.out}`);

    await ctx.sh("kubectl", K("delete", "pods", "-l", "app=lab-svc", "--wait=false"));
    const ep2 = await ctx.poll(
      "endpoints 가 새 IP 2개로 바뀔 때까지",
      async () => {
        const r = await exec("kubectl", K("get", "endpoints", "lab-svc", "-o", "jsonpath={.subsets[*].addresses[*].ip}"));
        const ips = r.out.split(/\s+/).filter(Boolean);
        return ips.length === 2 && ips.every((ip) => !ep1.out.includes(ip)) ? ips : undefined;
      },
      { timeoutMs: 90_000 },
    );
    ctx.check("Pod IP 는 전부 바뀌었다", true, `이전: ${ep1.out}\n이후: ${ep2.join(" ")}`);
    const svc = await ctx.sh("kubectl", K("get", "svc", "lab-svc", "-o", "jsonpath={.spec.clusterIP}"));
    ctx.note(`Service ClusterIP 는 그대로: ${svc.out}`);

    ctx.note("클러스터 안에서 DNS 이름으로 접속");
    const curl = await ctx.sh(
      "kubectl",
      K("run", "lab-curl", "--rm", "-i", "--restart=Never", "--labels=lab=true", "--image=curlimages/curl:8.10.1", "--", "curl", "-s", "-m", "10", "http://lab-svc"),
      { timeout: 120_000 },
    );
    ctx.check("nginx 환영 페이지를 받았다", curl.out.includes("Welcome to nginx"));
  },
};

export const k8sBrokenImage: ShellExperiment = {
  id: "k8s-broken-image",
  subject: "kubernetes",
  title: "장애 진단: ImagePullBackOff 를 만들고 고치기",
  category: "운영",
  summary: "존재하지 않는 태그로 배포해 이벤트에서 원인을 읽고, set image 로 복구",
  notes: ["08-ops-debugging", "03-pod-deployment"],
  description: `
가장 흔한 배포 실패. Pod 은 \`ErrImagePull\` → \`ImagePullBackOff\` 상태로 남고, **\`kubectl describe pod\` 의 Events** 에 정확한 이유가 찍힌다.
Deployment 의 롤링 업데이트는 새 Pod 이 Ready 가 안 되면 멈추므로 기존 버전이 계속 서비스된다 (maxUnavailable 덕분).
`,
  code: `kubectl -n study create deployment lab-broken --image=nginx:does-not-exist
kubectl -n study get pods -l app=lab-broken          # ImagePullBackOff
kubectl -n study describe pod -l app=lab-broken | tail -n 8    # Events: Failed to pull image ... not found
kubectl -n study set image deploy/lab-broken nginx=nginx:1.27-alpine
kubectl -n study rollout status deploy/lab-broken`,
  requires: requiresCluster,
  cleanup: cleanupLab,
  async run(ctx) {
    await ensureNamespace(ctx);
    await ctx.sh("kubectl", K("create", "deployment", "lab-broken", "--image=nginx:does-not-exist"));
    await ctx.sh("kubectl", K("label", "deploy", "lab-broken", "lab=true"));
    const state = await ctx.poll(
      "Pod 이 ImagePullBackOff / ErrImagePull 이 될 때까지",
      async () => {
        const r = await exec("kubectl", K("get", "pods", "-l", "app=lab-broken", "-o", "jsonpath={.items[0].status.containerStatuses[0].state.waiting.reason}"));
        return r.out === "ImagePullBackOff" || r.out === "ErrImagePull" ? r.out : undefined;
      },
      { timeoutMs: 90_000 },
    );
    await ctx.sh("kubectl", K("get", "pods", "-l", "app=lab-broken"));
    const desc = await ctx.sh("kubectl", K("describe", "pod", "-l", "app=lab-broken"));
    const eventLines = desc.out.split("\n").filter((l) => /Failed|BackOff|Pulling/.test(l)).slice(-5).join("\n");
    ctx.check(`상태 ${state}, 이벤트에 원인이 있다`, /not found|manifest unknown|Failed to pull/i.test(desc.out), eventLines);

    ctx.note("올바른 이미지로 고친다");
    await ctx.sh("kubectl", K("set", "image", "deploy/lab-broken", "nginx=nginx:1.27-alpine"));
    await ctx.sh("kubectl", K("rollout", "status", "deploy/lab-broken", "--timeout=120s"), { timeout: 130_000 });
    await ctx.sh("kubectl", K("get", "pods", "-l", "app=lab-broken"));
    ctx.check("Ready 1/1", (await readyPods("lab-broken")) === 1);
  },
};

export const k8sConfigReload: ShellExperiment = {
  id: "k8s-configmap-env-vs-file",
  subject: "kubernetes",
  title: "ConfigMap 변경: 환경 변수는 안 바뀌고, 파일은 바뀐다",
  category: "설정",
  summary: "같은 ConfigMap 을 env 와 볼륨으로 각각 주입한 뒤 값을 바꿔 어느 쪽이 갱신되는지 확인",
  notes: ["05-configmap-secret"],
  description: `
환경 변수는 **컨테이너 시작 시점에 고정**된다. 볼륨으로 마운트한 파일은 kubelet 이 주기적으로(기본 최대 1분 + 캐시 TTL) 동기화한다.
그래서 설정 변경을 확실히 반영하려면 \`rollout restart\` 하거나, kustomize 의 configMapGenerator 처럼 이름에 해시를 붙여 Pod 템플릿 자체를 바꾼다.
이 실험은 파일 갱신을 기다리므로 1~2분 걸릴 수 있다.
`,
  code: `kubectl -n study create configmap lab-cfg --from-literal=GREETING=hello
# env 와 volume 둘 다로 주입하는 Pod 생성 (아래 매니페스트)
kubectl -n study exec lab-cfg-pod -- sh -c 'echo $GREETING; cat /cfg/GREETING'
kubectl -n study create configmap lab-cfg --from-literal=GREETING=bonjour --dry-run=client -o yaml | kubectl apply -f -
# 잠시 후
kubectl -n study exec lab-cfg-pod -- sh -c 'echo $GREETING; cat /cfg/GREETING'   # hello / bonjour`,
  requires: requiresCluster,
  cleanup: cleanupLab,
  async run(ctx) {
    await ensureNamespace(ctx);
    await ctx.sh("kubectl", K("create", "configmap", "lab-cfg", "--from-literal=GREETING=hello"));
    await ctx.sh("kubectl", K("label", "cm", "lab-cfg", "lab=true"));
    const pod = `apiVersion: v1
kind: Pod
metadata:
  name: lab-cfg-pod
  namespace: ${NS}
  labels: { lab: "true", app: lab-cfg }
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      env:
        - name: GREETING
          valueFrom: { configMapKeyRef: { name: lab-cfg, key: GREETING } }
      volumeMounts:
        - { name: cfg, mountPath: /cfg }
  volumes:
    - name: cfg
      configMap: { name: lab-cfg }
`;
    await ctx.sh("kubectl", ["apply", "-f", "-"], { input: pod, label: "kubectl apply -f - <<EOF (Pod: env + volume 마운트)" });
    await ctx.sh("kubectl", K("wait", "--for=condition=Ready", "pod/lab-cfg-pod", "--timeout=120s"), { timeout: 130_000 });
    const before = await ctx.sh("kubectl", K("exec", "lab-cfg-pod", "--", "sh", "-c", "echo env=$GREETING; echo file=$(cat /cfg/GREETING)"));
    ctx.check("처음엔 둘 다 hello", before.out.includes("env=hello") && before.out.includes("file=hello"), before.out);

    await ctx.sh("kubectl", K("create", "configmap", "lab-cfg", "--from-literal=GREETING=bonjour", "--dry-run=client", "-o", "yaml"), { label: "kubectl create cm lab-cfg --from-literal=GREETING=bonjour --dry-run=client -o yaml | kubectl apply -f -" }).then((r) =>
      ctx.sh("kubectl", ["apply", "-f", "-"], { input: r.out, label: "(apply)" }),
    );
    await ctx.sh("kubectl", K("label", "cm", "lab-cfg", "lab=true", "--overwrite"));
    const after = await ctx.poll(
      "마운트된 파일이 bonjour 로 갱신될 때까지 (최대 3분)",
      async () => {
        const r = await exec("kubectl", K("exec", "lab-cfg-pod", "--", "sh", "-c", "echo env=$GREETING; echo file=$(cat /cfg/GREETING)"));
        return r.out.includes("file=bonjour") ? r.out : undefined;
      },
      { timeoutMs: 180_000, intervalMs: 3000 },
    );
    ctx.check("환경 변수는 여전히 hello, 파일은 bonjour", after.includes("env=hello") && after.includes("file=bonjour"), after);
  },
};
