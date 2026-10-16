import { exec } from "@/shell-lab/runner";
import type { Drill } from "./types";

const NET = "lab-drill-net";
const sh = (bin: string, args: string[], timeout = 120_000) => exec(bin, args, { timeout });
const dockerUp = async () => ((await sh("docker", ["version", "--format", "{{.Server.Version}}"], 8000)).ok ? null : "Docker 데몬이 필요합니다 (Docker Desktop 실행).");
const rm = async (...names: string[]) => {
  await sh("docker", ["rm", "-f", ...names], 60_000);
};
const ensureNet = async () => {
  await sh("docker", ["network", "create", NET], 20_000); // 이미 있으면 실패해도 무시
};
const must = async (bin: string, args: string[], label: string, timeout = 180_000) => {
  const r = await sh(bin, args, timeout);
  if (!r.ok) throw new Error(`${label} 실패: ${(r.err || r.out).slice(0, 300)}`);
  return r.out;
};
async function waitFor(fn: () => Promise<boolean>, ms = 60_000, every = 500): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}

// ---------------------------------------------------------------- 1. Nginx 502
const NGINX_PORT = 18491;
const nginxConf = (port: number) => `server {
  listen 80;
  location / {
    proxy_pass http://lab-drill-web:${port};
    proxy_connect_timeout 2s;
  }
}
`;
const nginx502: Drill = {
  id: "nginx-502",
  title: "갑자기 502 Bad Gateway",
  level: "쉬움",
  summary: "배포 직후 프록시 뒤 서비스가 502 를 돌려준다. 백엔드 컨테이너는 살아 있다고 한다.",
  symptoms: [
    `http://localhost:${NGINX_PORT}/ 이 502 Bad Gateway 를 돌려준다`,
    "백엔드 담당자: \"lab-drill-web 컨테이너는 Running 이고 우리 쪽 로그엔 요청이 하나도 안 왔어요\"",
    "알림: Nginx 5xx 비율 100% (5분)",
  ],
  starters: [`curl -i localhost:${NGINX_PORT}/`, "docker logs --tail 20 lab-drill-nginx", "docker ps --filter name=lab-drill"],
  timeLimitMin: 15,
  requires: dockerUp,
  async setup() {
    await rm("lab-drill-nginx", "lab-drill-web");
    await ensureNet();
    await must("docker", ["run", "-d", "--name", "lab-drill-web", "--network", NET, "busybox:1.36", "sh", "-c", "mkdir -p /www && echo drill-ok > /www/index.html && httpd -f -p 80 -h /www"], "백엔드 시작");
    await must("docker", ["run", "-d", "--name", "lab-drill-nginx", "--network", NET, "-p", `127.0.0.1:${NGINX_PORT}:80`, "nginx:1.27-alpine"], "Nginx 시작");
    const w = await exec("docker", ["exec", "-i", "lab-drill-nginx", "sh", "-c", "cat > /etc/nginx/conf.d/default.conf && nginx -s reload"], { input: nginxConf(8081), timeout: 20_000 });
    if (!w.ok) throw new Error(`설정 쓰기 실패: ${w.err}`);
    await waitFor(async () => (await sh("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${NGINX_PORT}/`], 5000)).out === "502", 20_000);
    return `http://localhost:${NGINX_PORT}/ (컨테이너 lab-drill-nginx, lab-drill-web)`;
  },
  async check() {
    const r = await sh("curl", ["-s", "-m", "3", "-w", "\n%{http_code}", `http://127.0.0.1:${NGINX_PORT}/`], 6000);
    const [body, code] = [r.out.split("\n").slice(0, -1).join("\n").trim(), r.out.split("\n").pop()];
    return { ok: code === "200" && body === "drill-ok", detail: `HTTP ${code ?? "?"} · 응답 ${JSON.stringify(body.slice(0, 40))}` };
  },
  async reset() {
    await rm("lab-drill-nginx", "lab-drill-web");
    await sh("docker", ["network", "rm", NET], 20_000);
  },
  deadmanCommand: `docker rm -f lab-drill-nginx lab-drill-web; docker network rm ${NET}`,
  hints: [
    "502 는 Nginx 가 업스트림에 연결하지 못했거나 이상한 응답을 받았다는 뜻이다. Nginx 의 error 로그에 업스트림 주소가 찍힌다.",
    "docker logs lab-drill-nginx 의 'connect() failed (111: Connection refused) while connecting to upstream' 줄에서 업스트림 주소·포트를 보자. 백엔드가 실제로 듣는 포트와 비교한다.",
    "docker exec lab-drill-nginx cat /etc/nginx/conf.d/default.conf 로 proxy_pass 의 포트를 확인하고, 고친 뒤 nginx -t && nginx -s reload.",
  ],
  explanation: {
    cause: "proxy_pass 가 업스트림의 8081 포트를 가리키는데 백엔드(busybox httpd)는 80 에서 듣는다. 연결 거부(ECONNREFUSED) → Nginx 가 502 를 돌려준다. 백엔드 로그가 비어 있는 것은 요청이 그쪽에 도달하지 못했기 때문이다.",
    fix: "docker exec lab-drill-nginx sed -i 's/:8081/:80/' /etc/nginx/conf.d/default.conf\ndocker exec lab-drill-nginx nginx -t\ndocker exec lab-drill-nginx nginx -s reload",
    notes: [
      { href: "/nginx/notes/02-reverse-proxy-lb", title: "Nginx 리버스 프록시·로드밸런싱" },
      { href: "/linux-network/notes/02-ip-ports-sockets", title: "IP·포트·소켓" },
    ],
  },
  solution: [
    { bin: "docker", args: ["exec", "lab-drill-nginx", "sed", "-i", "s/:8081/:80/", "/etc/nginx/conf.d/default.conf"] },
    { bin: "docker", args: ["exec", "lab-drill-nginx", "nginx", "-s", "reload"] },
  ],
};

// ---------------------------------------------------------------- 2. Redis OOM
const REDIS_PORT = 16399;
const redisOom: Drill = {
  id: "redis-oom",
  title: "캐시 쓰기가 전부 실패한다",
  level: "쉬움",
  summary: "읽기는 되는데 SET 이 에러를 낸다. 세션이 저장되지 않아 사용자가 계속 로그아웃된다.",
  symptoms: [
    "앱 로그: ReplyError: OOM command not allowed when used memory > 'maxmemory'.",
    `Redis 주소: 127.0.0.1:${REDIS_PORT} (컨테이너 lab-drill-redis)`,
    "알림: RedisRejectedWrites — 쓰기 거부 증가",
  ],
  starters: [`docker exec lab-drill-redis redis-cli set probe 1`, "docker exec lab-drill-redis redis-cli info memory | head -20", "docker exec lab-drill-redis redis-cli config get 'maxmemory*'"],
  timeLimitMin: 15,
  requires: dockerUp,
  async setup() {
    await rm("lab-drill-redis");
    await must("docker", ["run", "-d", "--name", "lab-drill-redis", "-p", `127.0.0.1:${REDIS_PORT}:6379`, "redis:8-alpine", "redis-server", "--maxmemory-policy", "noeviction", "--save", "", "--appendonly", "no"], "Redis 시작");
    await waitFor(async () => (await sh("docker", ["exec", "lab-drill-redis", "redis-cli", "ping"], 5000)).out === "PONG", 30_000);
    // 세션처럼 보이는 키 300개(약 4MB)를 넣은 뒤, maxmemory 를 사용량보다 낮게 → 확실히 OOM
    await sh("docker", ["exec", "lab-drill-redis", "sh", "-c", "for i in $(seq 1 300); do redis-cli set session:$i $(head -c 12000 /dev/zero | tr '\\0' x) >/dev/null 2>&1; done; redis-cli config set maxmemory 3mb >/dev/null"], 120_000);
    const probe = await sh("docker", ["exec", "lab-drill-redis", "redis-cli", "set", "probe", "1"], 5000);
    if (!/OOM/.test(probe.out + probe.err)) throw new Error(`OOM 상태를 만들지 못함: ${probe.out}`);
    return `redis-cli -p ${REDIS_PORT} (또는 docker exec lab-drill-redis redis-cli)`;
  },
  async check() {
    const r = await sh("docker", ["exec", "lab-drill-redis", "redis-cli", "set", "drill:check", String(Date.now())], 5000);
    const ok = r.out.trim() === "OK";
    const pol = (await sh("docker", ["exec", "lab-drill-redis", "redis-cli", "config", "get", "maxmemory-policy"], 5000)).out.split("\n")[1] ?? "?";
    const mm = (await sh("docker", ["exec", "lab-drill-redis", "redis-cli", "config", "get", "maxmemory"], 5000)).out.split("\n")[1] ?? "?";
    return { ok, detail: `SET → ${r.out.trim() || r.err.trim()} · maxmemory=${mm} · policy=${pol}` };
  },
  async reset() {
    await rm("lab-drill-redis");
  },
  deadmanCommand: "docker rm -f lab-drill-redis",
  hints: [
    "에러 문구에 원인이 그대로 있다. 이 Redis 는 메모리가 얼마까지 허용되고, 넘치면 무엇을 하도록 설정돼 있을까?",
    "info memory 의 used_memory 와 maxmemory, 그리고 maxmemory-policy 를 보자. noeviction 이면 꽉 찼을 때 쓰기를 거부한다.",
    "캐시라면 CONFIG SET maxmemory-policy allkeys-lru (오래 안 쓴 키 축출), 용량이 문제라면 CONFIG SET maxmemory 64mb. 운영에선 둘 다 설정 파일에도 반영한다.",
  ],
  explanation: {
    cause: "maxmemory 가 3MB 로 작고 정책이 noeviction 이라, 메모리가 차자 Redis 가 모든 쓰기를 OOM 에러로 거부한다. 캐시 용도라면 축출 정책이 필요하고, 세션처럼 잃으면 안 되는 데이터라면 용량을 늘리고 축출 대상과 분리해야 한다.",
    fix: "docker exec lab-drill-redis redis-cli config set maxmemory-policy allkeys-lru\n# 또는 용량 증설\ndocker exec lab-drill-redis redis-cli config set maxmemory 64mb",
    notes: [
      { href: "/redis/notes/03-keys-expiration", title: "키 만료와 메모리 축출" },
      { href: "/redis/notes/12-memory-performance", title: "메모리와 성능 진단" },
    ],
  },
  solution: [{ bin: "docker", args: ["exec", "lab-drill-redis", "redis-cli", "config", "set", "maxmemory-policy", "allkeys-lru"] }],
};

// ---------------------------------------------------------------- 3. PostgreSQL 연결 고갈
const PG_PORT = 15499;
const pgConnections: Drill = {
  id: "pg-connections",
  title: "DB 에 새 연결이 안 된다",
  level: "보통",
  summary: "앱이 DB 에 새로 연결하지 못해 요청이 실패한다. DB 서버는 살아 있고 CPU 도 한가하다.",
  symptoms: [
    "앱 로그: FATAL: remaining connection slots are reserved for roles with the SUPERUSER attribute",
    `DB 주소: 127.0.0.1:${PG_PORT} (컨테이너 lab-drill-pg, 앱 사용자 app, 관리자 postgres, 비밀번호 없음)`,
    "대시보드: DB CPU 2%, 활성 연결 수가 한계에 붙어 있음",
  ],
  starters: ["docker exec lab-drill-pg psql -U app -d postgres -c 'select 1'", "docker exec lab-drill-pg psql -U postgres -c 'show max_connections'"],
  timeLimitMin: 15,
  requires: dockerUp,
  async setup() {
    await rm("lab-drill-pg");
    await must("docker", ["run", "-d", "--name", "lab-drill-pg", "-p", `127.0.0.1:${PG_PORT}:5432`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16-alpine", "-c", "max_connections=10", "-c", "superuser_reserved_connections=3"], "PostgreSQL 시작");
    const up = await waitFor(async () => (await sh("docker", ["exec", "lab-drill-pg", "pg_isready", "-U", "postgres"], 5000)).ok, 60_000, 1000);
    if (!up) throw new Error("PostgreSQL 이 준비되지 않음");
    await waitFor(async () => (await sh("docker", ["exec", "lab-drill-pg", "psql", "-U", "postgres", "-c", "select 1"], 5000)).ok, 30_000, 1000);
    await must("docker", ["exec", "lab-drill-pg", "psql", "-U", "postgres", "-c", "create role app login"], "앱 사용자 생성");
    // 앱 사용자 슬롯(10-3=7)을 오래 붙잡는 세션으로 채운다 — 컨테이너 안 백그라운드 프로세스
    await sh("docker", ["exec", "-d", "lab-drill-pg", "sh", "-c", "for i in 1 2 3 4 5 6 7; do psql -U app -d postgres -c 'select pg_sleep(3600)' >/dev/null 2>&1 & sleep 0.2; done; wait"], 10_000);
    const full = await waitFor(async () => !(await sh("docker", ["exec", "lab-drill-pg", "psql", "-U", "app", "-d", "postgres", "-c", "select 1"], 5000)).ok, 30_000, 1000);
    if (!full) throw new Error("연결 고갈 상태를 만들지 못함");
    return `psql -h 127.0.0.1 -p ${PG_PORT} -U postgres (또는 docker exec -it lab-drill-pg psql -U postgres)`;
  },
  async check() {
    const r = await sh("docker", ["exec", "lab-drill-pg", "psql", "-U", "app", "-d", "postgres", "-tAc", "select 1"], 8000);
    const n = (await sh("docker", ["exec", "lab-drill-pg", "psql", "-U", "postgres", "-tAc", "select count(*) from pg_stat_activity where usename = 'app'"], 8000)).out.trim();
    return { ok: r.ok && r.out.trim() === "1", detail: r.ok ? `app 사용자 연결 성공 · 현재 app 세션 ${n}개` : `app 사용자 연결 실패: ${(r.err || r.out).slice(0, 120)}` };
  },
  async reset() {
    await rm("lab-drill-pg");
  },
  deadmanCommand: "docker rm -f lab-drill-pg",
  hints: [
    "연결 수 한도에 걸렸다. 관리자(postgres)는 예약 슬롯으로 아직 들어갈 수 있다 — 누가 슬롯을 차지하고 있는지 보자.",
    "select pid, usename, state, now() - query_start as age, query from pg_stat_activity order by age desc; — 같은 쿼리로 오래 붙잡힌 세션이 보인다.",
    "급한 불: select pg_terminate_backend(pid) from pg_stat_activity where usename = 'app' and query like '%pg_sleep%'; 재발 방지: 커넥션 풀 크기 제한, statement_timeout, idle_in_transaction_session_timeout.",
  ],
  explanation: {
    cause: "max_connections=10 중 3개는 superuser 예약이라 앱 사용자는 7개까지만 쓸 수 있는데, 오래 걸리는 세션 7개가 전부 붙잡고 있다. DB 는 한가하지만 연결 슬롯이 없어 새 연결을 거부한다 — 연결 수는 CPU 처럼 보이지 않는 자원이다.",
    fix: "docker exec lab-drill-pg psql -U postgres -c \"select pg_terminate_backend(pid) from pg_stat_activity where usename = 'app' and pid <> pg_backend_pid()\"\n# 재발 방지\nalter role app set statement_timeout = '30s';\nalter system set idle_in_transaction_session_timeout = '60s'; select pg_reload_conf();",
    notes: [
      { href: "/postgres/notes/05-operations", title: "PostgreSQL 운영" },
      { href: "/chaos/notes/03-resilience-patterns-verified", title: "복원력 패턴 실측(벌크헤드)" },
    ],
  },
  solution: [{ bin: "docker", args: ["exec", "lab-drill-pg", "psql", "-U", "postgres", "-c", "select pg_terminate_backend(pid) from pg_stat_activity where usename = 'app' and pid <> pg_backend_pid()"] }],
};

// ---------------------------------------------------------------- 4. Kubernetes 롤아웃 멈춤
const KCTX = ["--context", "kind-study"];
const k8sRollout: Drill = {
  id: "k8s-rollout-stuck",
  title: "배포가 끝나지 않는다",
  level: "보통",
  summary: "새 버전 배포가 10분째 진행 중이다. 서비스는 아직 옛 버전으로 응답하고 있다.",
  symptoms: [
    "CI: kubectl rollout status deploy/web -n drill — 'Waiting for deployment \"web\" rollout to finish: 1 out of 2 new replicas have been updated...' 에서 멈춤",
    "알림: KubeDeploymentRolloutStuck (drill/web)",
    "클러스터 컨텍스트 kind-study, 네임스페이스 drill",
  ],
  starters: ["kubectl --context kind-study -n drill get deploy,rs,pods", "kubectl --context kind-study -n drill rollout status deploy/web --timeout=5s"],
  timeLimitMin: 20,
  requires: async () => ((await sh("kubectl", [...KCTX, "get", "nodes", "--request-timeout=5s"], 10_000)).ok ? null : "kind-study 클러스터가 필요합니다 (pnpm k8s:cluster)."),
  async setup() {
    await sh("kubectl", [...KCTX, "delete", "ns", "drill", "--ignore-not-found", "--wait=true", "--timeout=60s"], 90_000);
    await must("kubectl", [...KCTX, "create", "ns", "drill"], "네임스페이스");
    const manifest = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: drill }
spec:
  replicas: 2
  strategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
  progressDeadlineSeconds: 60
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
          ports: [{ containerPort: 80 }]
          readinessProbe: { httpGet: { path: /, port: 80 }, periodSeconds: 2 }
`;
    await sh("docker", ["pull", "-q", "nginx:1.27-alpine"], 180_000);
    await sh("kind", ["load", "docker-image", "nginx:1.27-alpine", "--name", "study"], 180_000);
    const ap = await exec("kubectl", [...KCTX, "apply", "-f", "-"], { input: manifest, timeout: 60_000 });
    if (!ap.ok) throw new Error(`배포 실패: ${ap.err}`);
    await must("kubectl", [...KCTX, "-n", "drill", "rollout", "status", "deploy/web", "--timeout=120s"], "첫 배포", 130_000);
    // 오타 난 이미지로 새 버전 배포 → ImagePullBackOff, maxUnavailable 0 이라 옛 Pod 가 계속 서비스
    await must("kubectl", [...KCTX, "-n", "drill", "set", "image", "deploy/web", "web=nginx:1.27-alpne"], "새 버전 배포");
    return "kubectl --context kind-study -n drill …";
  },
  async check() {
    const img = (await sh("kubectl", [...KCTX, "-n", "drill", "get", "deploy", "web", "-o", "jsonpath={.spec.template.spec.containers[0].image}"], 10_000)).out;
    const st = await sh("kubectl", [...KCTX, "-n", "drill", "rollout", "status", "deploy/web", "--timeout=5s"], 15_000);
    const ready = (await sh("kubectl", [...KCTX, "-n", "drill", "get", "deploy", "web", "-o", "jsonpath={.status.readyReplicas}/{.spec.replicas}/{.status.updatedReplicas}"], 10_000)).out;
    const [r, want, upd] = ready.split("/").map(Number);
    const ok = st.ok && r === want && upd === want && !/alpne/.test(img);
    return { ok, detail: `이미지 ${img} · Ready ${r || 0}/${want || "?"} · 갱신 ${upd || 0} · rollout ${st.ok ? "완료" : "진행 중"}` };
  },
  async reset() {
    await sh("kubectl", [...KCTX, "delete", "ns", "drill", "--ignore-not-found", "--wait=false"], 30_000);
  },
  deadmanCommand: "kubectl --context kind-study delete ns drill --ignore-not-found --wait=false",
  hints: [
    "rollout 은 새 ReplicaSet 의 Pod 가 Ready 가 될 때까지 기다린다. 새 Pod 의 상태(STATUS)를 보자.",
    "kubectl describe pod 의 Events 에 이미지 관련 실패가 있다. 이미지 이름을 한 글자씩 읽어 보자.",
    "kubectl rollout undo deploy/web (직전 버전으로) 또는 kubectl set image deploy/web web=nginx:1.27-alpine. 그다음 rollout status 로 완료 확인.",
  ],
  explanation: {
    cause: "새 버전의 이미지 태그 오타(nginx:1.27-alpne)로 새 Pod 가 ImagePullBackOff 에 빠졌다. maxUnavailable 0 이라 옛 Pod 가 계속 트래픽을 받아 사용자 영향은 없지만, 배포는 progressDeadlineSeconds 를 넘겨 멈춘다. 롤링 업데이트 설정이 장애를 '배포 지연' 으로 줄여 준 사례다.",
    fix: "kubectl --context kind-study -n drill rollout undo deploy/web\nkubectl --context kind-study -n drill rollout status deploy/web",
    notes: [
      { href: "/kubernetes/notes/07-deploy-resources", title: "배포 전략과 리소스" },
      { href: "/kubernetes/notes/08-ops-debugging", title: "운영과 디버깅" },
    ],
  },
  solution: [
    { bin: "kubectl", args: [...KCTX, "-n", "drill", "rollout", "undo", "deploy/web"] },
    { bin: "kubectl", args: [...KCTX, "-n", "drill", "rollout", "status", "deploy/web", "--timeout=120s"] },
  ],
};

// ---------------------------------------------------------------- 5. 디스크 꽉 참
const diskFull: Drill = {
  id: "disk-full",
  title: "로그가 더 이상 안 쌓인다",
  level: "쉬움",
  summary: "서비스가 '쓰기 실패' 를 내며 요청 일부를 버린다. 메모리·CPU 는 정상이다.",
  symptoms: [
    "앱 로그: write error: No space left on device",
    "컨테이너 lab-drill-disk 의 데이터 디렉터리는 /data",
    "알림: NodeFilesystemAlmostOutOfSpace — 사용률 99%",
  ],
  starters: ["docker exec lab-drill-disk df -h /data", "docker logs --tail 5 lab-drill-disk"],
  timeLimitMin: 10,
  requires: dockerUp,
  async setup() {
    await rm("lab-drill-disk");
    await must("docker", ["run", "-d", "--name", "lab-drill-disk", "--tmpfs", "/data:size=8m", "busybox:1.36", "sh", "-c", "while true; do date >> /data/app.log 2>&1 || echo 'write error: No space left on device' >&2; sleep 1; done"], "컨테이너 시작");
    await sh("docker", ["exec", "lab-drill-disk", "sh", "-c", "mkdir -p /data/backup && dd if=/dev/zero of=/data/backup/db-dump-old.bin bs=1k count=16384 2>/dev/null; true"], 30_000);
    const full = await sh("docker", ["exec", "lab-drill-disk", "sh", "-c", "echo probe > /data/.drill-probe"], 5000);
    if (full.ok) throw new Error("디스크를 채우지 못함");
    return "docker exec -it lab-drill-disk sh";
  },
  async check() {
    const w = await sh("docker", ["exec", "lab-drill-disk", "sh", "-c", "echo drill-check > /data/.drill-check && rm -f /data/.drill-check"], 5000);
    const use = (await sh("docker", ["exec", "lab-drill-disk", "sh", "-c", "df /data | tail -1 | awk '{print $5}'"], 5000)).out.trim();
    const pct = Number(use.replace("%", ""));
    return { ok: w.ok && pct < 90, detail: `쓰기 ${w.ok ? "성공" : "실패"} · /data 사용률 ${use || "?"}` };
  },
  async reset() {
    await rm("lab-drill-disk");
  },
  deadmanCommand: "docker rm -f lab-drill-disk",
  hints: [
    "df 로 어느 파일시스템이 찼는지 보자. 그다음은 '무엇이' 차지하는지.",
    "du -sh /data/* 또는 du -a /data | sort -n | tail — 앱 로그 말고 큰 파일이 있다.",
    "오래된 덤프 파일을 지우자(rm /data/backup/db-dump-old.bin). 재발 방지: 백업은 앱 데이터 볼륨 밖으로, 로그는 로테이션, 사용률 80% 알림.",
  ],
  explanation: {
    cause: "8MB 볼륨을 오래된 백업 덤프(8MB)가 다 차지해 앱 로그 쓰기가 ENOSPC 로 실패한다. CPU·메모리 지표만 보면 정상이라 놓치기 쉽다 — 디스크는 USE 방법론의 '포화' 를 별도로 봐야 하는 자원이다.",
    fix: "docker exec lab-drill-disk du -a /data | sort -n | tail -5\ndocker exec lab-drill-disk rm /data/backup/db-dump-old.bin\ndocker exec lab-drill-disk df -h /data",
    notes: [
      { href: "/os-internals/notes/04-filesystem-io", title: "파일시스템과 I/O" },
      { href: "/sre/notes/04-oncall-runbooks", title: "온콜과 런북" },
    ],
  },
  solution: [{ bin: "docker", args: ["exec", "lab-drill-disk", "rm", "-f", "/data/backup/db-dump-old.bin"] }],
};

export const drills: Drill[] = [nginx502, redisOom, diskFull, pgConnections, k8sRollout];

export function getDrill(id: string): Drill | undefined {
  return drills.find((d) => d.id === id);
}
