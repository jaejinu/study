import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

/**
 * Nginx 실험 — 임시 설정 파일로 작은 nginx 컨테이너를 띄우고, 같은 요청을 설정만 바꿔 보내며 동작을 비교한다.
 * 컨테이너 이름은 lab-nginx-*, 포트는 127.0.0.1:1847x. cleanup 이 모두 지운다.
 */

const IMAGE = "nginx:1.27-alpine";

async function requiresDocker(): Promise<string | null> {
  const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 8000 });
  if (!d.ok) return "Docker 데몬이 필요합니다 (Docker Desktop 실행).";
  return null;
}

/** 설정 문자열을 임시 디렉터리에 쓰고 그 경로를 돌려준다 (Docker Desktop 은 /var/folders 를 공유한다) */
async function writeConf(name: string, conf: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const file = path.join(dir, "nginx.conf");
  await fs.writeFile(file, conf);
  return file;
}

async function rm(ctx: ShellCtx, names: string[]) {
  await ctx.sh("docker", ["rm", "-f", ...names], { allowFail: true, label: `docker rm -f ${names.join(" ")}   # 정리` });
}

/** 컨테이너의 nginx 가 응답할 때까지 */
async function waitHttp(ctx: ShellCtx, url: string, label: string) {
  await ctx.poll(label, async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return r.status > 0 ? true : undefined;
    } catch {
      return undefined;
    }
  }, { timeoutMs: 30_000, intervalMs: 300 });
}

type Shot = { status: number; ms: number; body: string; headers: Headers };

async function hit(url: string, timeoutMs = 10_000): Promise<Shot> {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    const body = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t0), body: body.trim(), headers: r.headers };
  } catch {
    return { status: 0, ms: Math.round(performance.now() - t0), body: "", headers: new Headers() };
  }
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// ---------------------------------------------------------------- 1. 레이트리밋 burst
const RL_NAME = "lab-nginx-rl";
const RL_PORT = 18471;

const RL_CONF = `events { worker_connections 1024; }
http {
  # 같은 속도(5r/s)·같은 버스트(10)를 세 가지 방식으로 — 존을 나눠 서로 간섭하지 않게
  limit_req_zone $binary_remote_addr zone=nob:1m rate=5r/s;
  limit_req_zone $binary_remote_addr zone=nodelay:1m rate=5r/s;
  limit_req_zone $binary_remote_addr zone=delay:1m rate=5r/s;
  limit_req_status 503;
  server {
    listen 80;
    location = /health { return 200 "ok\\n"; }
    # 주의: 'return 200' 은 rewrite 단계에서 끝나 limit_req(preaccess 단계)가 돌지 않는다 → 정적 파일로 응답
    location /nob/     { limit_req zone=nob;                     alias /usr/share/nginx/html/; }
    location /nodelay/ { limit_req zone=nodelay burst=10 nodelay; alias /usr/share/nginx/html/; }
    location /delay/   { limit_req zone=delay burst=10;          alias /usr/share/nginx/html/; }
  }
}
`;

export const nginxRateLimitBurst: ShellExperiment = {
  id: "nginx-rate-limit-burst",
  subject: "nginx",
  title: "레이트리밋: 같은 5r/s 라도 burst·nodelay 에 따라 30개 동시 요청의 결과가 완전히 달라진다",
  category: "레이트리밋",
  summary: "limit_req rate=5r/s 를 burst 없음 / burst=10 nodelay / burst=10(지연) 세 location 에 걸고 동시 30요청을 보내 200·503 개수와 지연 분포를 비교한다. 리키 버킷이 '대기열(지연)' 과 '즉시 통과(nodelay)' 를 어떻게 가르는지 수치로 본다",
  notes: ["03-cache-tls-ratelimit", "04-internals-performance-openresty"],
  description: `
\`limit_req\` 는 **리키 버킷(leaky bucket)** 이다. rate=5r/s 면 200ms 마다 한 칸씩 물이 빠진다.
- **burst 없음**: 버킷 크기가 0 — 동시에 몰리면 첫 요청만 통과하고 나머지는 즉시 503.
- **burst=10 (기본, delay)**: 넘친 요청을 최대 10개까지 **줄 세워 200ms 간격으로 천천히** 통과시킨다. 성공 수는 늘지만 뒤쪽 요청은 최대 2초 기다린다.
- **burst=10 nodelay**: 10개까지는 **즉시** 통과시키고 버킷 칸만 차지한다. 사용자 체감 지연은 없지만, 버킷이 빌 때까지(2초) 다음 버스트는 거부된다.
API 게이트웨이의 "순간 버스트 허용" 과 같은 개념이다 ([API 설계 노트 06](/api-design/notes/06-gateway-auth-ratelimit)의 토큰 버킷). 이 프로젝트의 \`nginx/nginx.conf\` 는 \`rate=10r/s burst=20 nodelay\` 를 쓴다.
`,
  code: `limit_req_zone $binary_remote_addr zone=nodelay:1m rate=5r/s;
location /nob/     { limit_req zone=nob;                     alias /usr/share/nginx/html/; }
location /nodelay/ { limit_req zone=nodelay burst=10 nodelay; alias /usr/share/nginx/html/; }
location /delay/   { limit_req zone=delay burst=10;          alias /usr/share/nginx/html/; }
# 'return 200' 과 함께 쓰면 limit_req 가 무시된다 (return 은 rewrite 단계에서 끝남)
# 동시 30요청
seq 30 | xargs -P 30 -I{} curl -s -o /dev/null -w '%{http_code} %{time_total}\\n' localhost:18471/nodelay/index.html`,
  requires: requiresDocker,
  cleanup: (ctx) => rm(ctx, [RL_NAME]),
  async run(ctx) {
    await rm(ctx, [RL_NAME]);
    const conf = await writeConf(RL_NAME, RL_CONF);
    await ctx.sh("docker", ["run", "-d", "--name", RL_NAME, "-p", `127.0.0.1:${RL_PORT}:80`, "-v", `${conf}:/etc/nginx/nginx.conf:ro`, IMAGE], { label: `docker run -d --name ${RL_NAME} -p 127.0.0.1:${RL_PORT}:80 -v ./nginx.conf:/etc/nginx/nginx.conf:ro ${IMAGE}` });
    await waitHttp(ctx, `http://127.0.0.1:${RL_PORT}/health`, "nginx 가 뜰 때까지");

    const rows: string[][] = [];
    const results: Record<string, { ok: number; rej: number; p50: number; max: number; okMs: number[] }> = {};
    for (const loc of ["nob", "nodelay", "delay"]) {
      await ctx.sleep(2500); // 앞 시나리오의 버킷이 비도록
      const shots = await Promise.all(Array.from({ length: 30 }, () => hit(`http://127.0.0.1:${RL_PORT}/${loc}/index.html`)));
      const ok = shots.filter((s) => s.status === 200);
      const rej = shots.filter((s) => s.status === 503);
      const okMs = ok.map((s) => s.ms);
      results[loc] = { ok: ok.length, rej: rej.length, p50: pct(shots.map((s) => s.ms), 50), max: Math.max(...shots.map((s) => s.ms)), okMs };
      rows.push([`/${loc}`, String(ok.length), String(rej.length), `${pct(okMs, 50)}ms`, `${okMs.length ? Math.max(...okMs) : 0}ms`, `${Math.max(...rej.map((s) => s.ms), 0)}ms`]);
      ctx.note(`/${loc}: 200 ${ok.length}개 · 503 ${rej.length}개`);
    }
    ctx.table("동시 30요청 (rate=5r/s)", ["location", "200", "503", "200 의 p50", "200 의 최대", "503 의 최대"], rows);

    const nob = results.nob, nd = results.nodelay, dl = results.delay;
    ctx.check("burst 없음: 거의 첫 요청만 통과 (200 ≤ 2)", nob.ok <= 2 && nob.ok >= 1, `${nob.ok}`);
    ctx.check("burst=10 nodelay: 약 11개(1 + 버스트 10) 통과", nd.ok >= 10 && nd.ok <= 12, `${nd.ok}`);
    ctx.check("burst=10 지연: 통과 수는 nodelay 와 같다", Math.abs(dl.ok - nd.ok) <= 1, `${dl.ok} vs ${nd.ok}`);
    const ndMax = Math.max(...nd.okMs), dlMax = Math.max(...dl.okMs);
    ctx.check("nodelay 는 성공 요청도 즉시 (최대 < 300ms)", ndMax < 300, `${ndMax}ms`);
    ctx.check("delay 는 줄을 세워 200ms 간격으로 내보낸다 (가장 늦은 성공 ≥ 1.5초)", dlMax >= 1500, `${dlMax}ms`);
    ctx.note(`해석: 같은 '11개 통과' 라도 nodelay 는 사용자 지연 0, delay 는 마지막 요청이 ${dlMax}ms 기다렸다. API 는 보통 nodelay(빠른 거절)를, 업로드·크롤러 완충처럼 '늦어도 성공' 이 나은 곳은 delay 를 쓴다.`);

    await ctx.sleep(2500);
    const after = await Promise.all(Array.from({ length: 30 }, () => hit(`http://127.0.0.1:${RL_PORT}/nodelay/index.html`)));
    const ret = await Promise.all(Array.from({ length: 30 }, () => hit(`http://127.0.0.1:${RL_PORT}/health`)));
    ctx.note(`함정 확인: limit_req 를 'return 200' 과 같은 location 에 두면 무시된다 — 처음 이 실험을 그렇게 짰다가 30/30 이 통과했다. return 은 rewrite 단계, limit_req 는 그 뒤 preaccess 단계라서. (/health 30개 → 200 ${ret.filter((x) => x.status === 200).length}개)`);
    ctx.note(`2.5초 쉬고 다시 30개 → 200 ${after.filter((s) => s.status === 200).length}개 (버킷이 다시 비었다). 쉬지 않고 바로 보내면 버킷이 차 있어 1~2개만 통과한다.`);
    const logs = await ctx.sh("docker", ["logs", "--tail", "3", RL_NAME], { allowFail: true, label: "docker logs   # 거절은 error_log 에 'limiting requests, excess: …' 로 남는다" });
    ctx.note(/limiting requests/.test(logs.out + logs.err) ? "error_log 에 'limiting requests, excess: …by zone' 가 찍혔다 — Loki 에서 이 문자열로 레이트리밋 발동을 알림으로 걸 수 있다" : "error_log 경고는 limit_req_log_level 로 조절한다");
    await rm(ctx, [RL_NAME]);
  },
};

// ---------------------------------------------------------------- 2. 프록시 캐시와 cache lock
const CACHE_NAME = "lab-nginx-cache";
const CACHE_PORT = 18473;
const ORIGIN_PORT = 18472;

const CACHE_CONF = `events { worker_connections 1024; }
http {
  proxy_cache_path /tmp/cache levels=1:2 keys_zone=c:5m max_size=50m inactive=10m;
  upstream origin { server host.docker.internal:${ORIGIN_PORT}; keepalive 8; }
  server {
    listen 80;
    location = /health { return 200 "ok\\n"; }
    location /unlocked/ {
      proxy_pass http://origin;
      proxy_http_version 1.1; proxy_set_header Connection "";
      proxy_cache c; proxy_cache_valid 200 1m;
      add_header X-Cache-Status $upstream_cache_status always;
    }
    location /locked/ {
      proxy_pass http://origin;
      proxy_http_version 1.1; proxy_set_header Connection "";
      proxy_cache c; proxy_cache_valid 200 1m;
      proxy_cache_lock on;            # 같은 키의 동시 미스는 하나만 원본으로
      proxy_cache_lock_timeout 5s;
      add_header X-Cache-Status $upstream_cache_status always;
    }
  }
}
`;

/** 실험 프로세스 안의 느린 원본 서버: 요청 수를 경로별로 센다 */
function startOrigin(delayMs: number): Promise<{ server: http.Server; hits: Map<string, number> }> {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0];
    hits.set(p, (hits.get(p) ?? 0) + 1);
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=60" });
      res.end(`// ${p} generated at ${Date.now()}\n`);
    }, delayMs);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(ORIGIN_PORT, "0.0.0.0", () => resolve({ server, hits }));
  });
}

export const nginxProxyCache: ShellExperiment = {
  id: "nginx-proxy-cache",
  subject: "nginx",
  title: "프록시 캐시: MISS → HIT 로 원본 호출이 사라지고, proxy_cache_lock 이 동시 미스 20개를 원본 1번으로 합친다",
  category: "캐시",
  summary: "실험 프로세스 안에 300ms 걸리는 원본 서버를 띄우고 nginx 프록시 캐시를 앞에 둔다. 같은 URL 두 번(MISS→HIT), 새 URL 에 동시 20요청을 lock 없이/있게 보내 원본 호출 수와 지연을 비교한다 — 썬더링 허드를 프록시가 막는 방법",
  notes: ["03-cache-tls-ratelimit", "02-reverse-proxy-lb"],
  description: `
프록시 캐시는 **원본 앞에서 응답을 저장**해 같은 요청을 원본까지 보내지 않는다. \`X-Cache-Status\` 헤더(\`$upstream_cache_status\`)로 MISS·HIT·EXPIRED·STALE·UPDATING 을 확인할 수 있다.
문제는 **캐시가 비어 있는 순간**이다. 인기 URL 이 만료되거나 처음 요청될 때 동시에 들어온 요청이 전부 MISS 로 원본에 몰린다 — 썬더링 허드. \`proxy_cache_lock on\` 은 같은 키의 첫 요청만 원본에 보내고 나머지는 그 응답이 캐시에 들어올 때까지 기다리게 한다(요청 병합, request collapsing).
[아키텍처 노트 10](/architecture/notes/10-cache-layers-cdn) 의 CDN 요청 병합, Redis 의 캐시 스탬피드 방어와 같은 문제를 프록시 계층에서 푸는 것이다.
`,
  code: `proxy_cache_path /tmp/cache keys_zone=c:5m;
location /locked/ {
  proxy_pass http://origin;
  proxy_cache c; proxy_cache_valid 200 1m;
  proxy_cache_lock on;
  add_header X-Cache-Status $upstream_cache_status always;
}
curl -sI localhost:18473/locked/app.js | grep -i x-cache   # MISS → HIT
seq 20 | xargs -P 20 -I{} curl -s -o /dev/null localhost:18473/locked/new.js   # 원본 호출 1번`,
  requires: async () => {
    const d = await requiresDocker();
    if (d) return d;
    const busy = await exec("lsof", ["-nP", `-iTCP:${ORIGIN_PORT}`, "-sTCP:LISTEN"], { timeout: 4000 });
    if (busy.ok && busy.out.trim()) return `포트 ${ORIGIN_PORT} 를 다른 프로세스가 쓰고 있습니다 (실험의 원본 서버용).`;
    return null;
  },
  cleanup: (ctx) => rm(ctx, [CACHE_NAME]),
  async run(ctx) {
    await rm(ctx, [CACHE_NAME]);
    const { server, hits } = await startOrigin(300);
    ctx.note(`원본 서버: 이 실험 프로세스 안, 0.0.0.0:${ORIGIN_PORT}, 응답마다 300ms 지연, 경로별 호출 수를 센다`);
    try {
      const conf = await writeConf(CACHE_NAME, CACHE_CONF);
      await ctx.sh("docker", ["run", "-d", "--name", CACHE_NAME, "-p", `127.0.0.1:${CACHE_PORT}:80`, "--add-host", "host.docker.internal:host-gateway", "-v", `${conf}:/etc/nginx/nginx.conf:ro`, IMAGE], { label: `docker run -d --name ${CACHE_NAME} -p 127.0.0.1:${CACHE_PORT}:80 … ${IMAGE}` });
      await waitHttp(ctx, `http://127.0.0.1:${CACHE_PORT}/health`, "nginx 가 뜰 때까지");
      const base = `http://127.0.0.1:${CACHE_PORT}`;

      const a1 = await hit(`${base}/locked/app.js`);
      const a2 = await hit(`${base}/locked/app.js`);
      const a3 = await hit(`${base}/locked/app.js`);
      ctx.table("같은 URL 세 번", ["요청", "X-Cache-Status", "지연", "원본 누적 호출"], [
        ["1번째", a1.headers.get("x-cache-status") ?? "-", `${a1.ms}ms`, "1"],
        ["2번째", a2.headers.get("x-cache-status") ?? "-", `${a2.ms}ms`, String(hits.get("/locked/app.js") ?? 0)],
        ["3번째", a3.headers.get("x-cache-status") ?? "-", `${a3.ms}ms`, String(hits.get("/locked/app.js") ?? 0)],
      ]);
      ctx.check("첫 요청은 MISS(원본 300ms), 다음부터 HIT", a1.headers.get("x-cache-status") === "MISS" && a2.headers.get("x-cache-status") === "HIT" && a1.ms >= 280);
      ctx.check("HIT 는 원본을 부르지 않는다 (원본 호출 1회)", hits.get("/locked/app.js") === 1, String(hits.get("/locked/app.js")));
      ctx.check("HIT 는 MISS 보다 훨씬 빠르다", a2.ms < a1.ms / 3, `${a2.ms}ms vs ${a1.ms}ms`);

      const burst = async (p: string) => {
        const t0 = performance.now();
        const shots = await Promise.all(Array.from({ length: 20 }, () => hit(`${base}${p}`)));
        return { shots, total: Math.round(performance.now() - t0), origin: hits.get(p) ?? 0 };
      };
      const un = await burst("/unlocked/new.js");
      const lk = await burst("/locked/new.js");
      const statuses = (xs: Shot[]) => {
        const m = new Map<string, number>();
        for (const s of xs) m.set(s.headers.get("x-cache-status") ?? "-", (m.get(s.headers.get("x-cache-status") ?? "-") ?? 0) + 1);
        return [...m.entries()].map(([k, v]) => `${k}×${v}`).join(" ");
      };
      ctx.table("빈 캐시에 동시 20요청", ["설정", "원본 호출", "X-Cache-Status 분포", "전체 소요", "응답 200"], [
        ["proxy_cache_lock off", String(un.origin), statuses(un.shots), `${un.total}ms`, String(un.shots.filter((s) => s.status === 200).length)],
        ["proxy_cache_lock on", String(lk.origin), statuses(lk.shots), `${lk.total}ms`, String(lk.shots.filter((s) => s.status === 200).length)],
      ]);
      ctx.check("lock 없음: 동시 미스가 원본으로 쏟아진다 (원본 호출 ≥ 10)", un.origin >= 10, String(un.origin));
      ctx.check("lock 있음: 원본 호출 1번으로 합쳐진다", lk.origin === 1, String(lk.origin));
      ctx.check("lock 있음: 20개 모두 200", lk.shots.every((s) => s.status === 200));
      ctx.note("lock 으로 기다린 요청도 원본 응답 시간(≈300ms)만큼은 기다린다 — 지연을 없애려면 stale 응답을 먼저 주는 proxy_cache_use_stale updating + proxy_cache_background_update 를 함께 쓴다.");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(ctx, [CACHE_NAME]);
    }
  },
};

// ---------------------------------------------------------------- 3. 업스트림 장애 전환
const NET = "lab-nginx-net";
const UP_A = "lab-nginx-up-a";
const UP_B = "lab-nginx-up-b";
const LB_NAME = "lab-nginx-lb";
const LB_PORT = 18474;

const upConf = (name: string) => `events {}
http { server { listen 80; location / { return 200 "${name}\\n"; } } }
`;

const LB_CONF = `events { worker_connections 1024; }
http {
  upstream app {
    server ${UP_A}:80 max_fails=1 fail_timeout=5s;
    server ${UP_B}:80 max_fails=1 fail_timeout=5s;
  }
  # max_fails=0: 실패해도 절대 빼지 않는다 — 재시도까지 끄면 죽은 서버 몫은 그대로 실패
  upstream app_nofail {
    server ${UP_A}:80 max_fails=0;
    server ${UP_B}:80 max_fails=0;
  }
  server {
    listen 80;
    proxy_connect_timeout 1s;
    proxy_read_timeout 2s;
    location = /health { return 200 "ok\\n"; }
    # 실패하면 다음 업스트림으로 (기본: error timeout)
    location / {
      proxy_pass http://app;
      proxy_next_upstream error timeout http_502 http_503;
      proxy_next_upstream_tries 2;
      add_header X-Upstream $upstream_addr always;
    }
    # 재시도 끔 — 죽은 서버로 간 요청은 그대로 실패
    location /noretry/ {
      proxy_pass http://app_nofail/;
      proxy_next_upstream off;
      add_header X-Upstream $upstream_addr always;
    }
  }
}
`;

export const nginxUpstreamFailover: ShellExperiment = {
  id: "nginx-upstream-failover",
  subject: "nginx",
  title: "업스트림 장애 전환: 백엔드 하나를 죽이면 proxy_next_upstream 이 실패를 숨기고, max_fails·fail_timeout 이 죽은 서버를 잠시 빼 준다",
  category: "로드밸런싱",
  summary: "업스트림 A·B 두 컨테이너 앞에 nginx 로드밸런서를 두고, B 를 docker stop 했을 때 재시도 켠 경로와 끈 경로의 실패율·지연을 비교한다. 첫 요청만 connect timeout(1s)을 맞고 이후 fail_timeout 동안 B 를 건너뛰는 것, B 를 살리면 다시 분산되는 것까지",
  notes: ["02-reverse-proxy-lb", "04-internals-performance-openresty"],
  description: `
nginx 의 오픈소스 판에는 **능동 헬스 체크가 없다**. 대신 실제 요청의 실패로 판단하는 **수동 헬스 체크**를 한다:
- \`max_fails=1 fail_timeout=5s\`: 5초 안에 1번 실패하면 그 서버를 5초 동안 후보에서 뺀다.
- \`proxy_next_upstream error timeout http_502\`: 연결 실패·타임아웃·502 면 **같은 요청을 다음 서버로 재시도**한다. 사용자는 실패를 보지 못하고 지연만 겪는다.
- \`proxy_connect_timeout 1s\`: 죽은 서버를 알아차리는 데 걸리는 시간의 상한. 기본 60s 면 첫 요청이 1분 매달린다.
재시도는 **멱등 요청**에만 안전하다. 기본값으로 POST 는 이미 보낸 뒤면 재시도하지 않는다(\`non_idempotent\` 를 켜야 함). [분산 시스템 노트 06](/distributed-systems/notes/06-transactions-coordination) 의 멱등성, [장애 실험실 노트 03](/chaos/notes/03-resilience-patterns-verified) 의 재시도·서킷 브레이커와 같은 원리다.
`,
  code: `upstream app {
  server lab-nginx-up-a:80 max_fails=1 fail_timeout=5s;
  server lab-nginx-up-b:80 max_fails=1 fail_timeout=5s;
}
proxy_connect_timeout 1s;
location /         { proxy_pass http://app; proxy_next_upstream error timeout http_502; }
location /noretry/ { proxy_pass http://app/; proxy_next_upstream off; }
docker stop lab-nginx-up-b          # B 장애
for i in $(seq 20); do curl -s -w ' %{http_code} %{time_total}\\n' localhost:18474/; done`,
  requires: requiresDocker,
  cleanup: async (ctx) => {
    await rm(ctx, [LB_NAME, UP_A, UP_B]);
    await ctx.sh("docker", ["network", "rm", NET], { allowFail: true, label: `docker network rm ${NET}` });
  },
  async run(ctx) {
    await rm(ctx, [LB_NAME, UP_A, UP_B]);
    await ctx.sh("docker", ["network", "rm", NET], { allowFail: true, label: "이전 네트워크 정리" });
    await ctx.sh("docker", ["network", "create", NET]);
    for (const [name, label] of [[UP_A, "A"], [UP_B, "B"]] as const) {
      const conf = await writeConf(name, upConf(label));
      await ctx.sh("docker", ["run", "-d", "--name", name, "--network", NET, "-v", `${conf}:/etc/nginx/nginx.conf:ro`, IMAGE], { label: `docker run -d --name ${name} --network ${NET} ${IMAGE}   # 업스트림 ${label}` });
    }
    const lbConf = await writeConf(LB_NAME, LB_CONF);
    await ctx.sh("docker", ["run", "-d", "--name", LB_NAME, "--network", NET, "-p", `127.0.0.1:${LB_PORT}:80`, "-v", `${lbConf}:/etc/nginx/nginx.conf:ro`, IMAGE], { label: `docker run -d --name ${LB_NAME} -p 127.0.0.1:${LB_PORT}:80 ${IMAGE}   # 로드밸런서` });
    await waitHttp(ctx, `http://127.0.0.1:${LB_PORT}/health`, "로드밸런서가 뜰 때까지");
    const base = `http://127.0.0.1:${LB_PORT}`;

    const series = async (p: string, n: number) => {
      const out: Shot[] = [];
      for (let i = 0; i < n; i++) out.push(await hit(`${base}${p}`, 8000));
      return out;
    };
    const summarize = (label: string, xs: Shot[]): string[] => {
      const ok = xs.filter((s) => s.status === 200);
      const a = ok.filter((s) => s.body === "A").length, b = ok.filter((s) => s.body === "B").length;
      const slow = xs.filter((s) => s.ms >= 800).length;
      return [label, `${ok.length}/${xs.length}`, `A ${a} · B ${b}`, String(xs.filter((s) => s.status >= 500 || s.status === 0).length), `${pct(xs.map((s) => s.ms), 50)}ms`, `${Math.max(...xs.map((s) => s.ms))}ms`, String(slow)];
    };
    const rows: string[][] = [];

    const healthy = await series("/", 10);
    rows.push(summarize("① 둘 다 정상", healthy));
    const hA = healthy.filter((s) => s.body === "A").length, hB = healthy.filter((s) => s.body === "B").length;
    ctx.check("정상일 때 라운드 로빈으로 A·B 에 고르게 분산", hA >= 3 && hB >= 3, `A ${hA} · B ${hB}`);

    await ctx.sh("docker", ["stop", "-t", "1", UP_B], { label: `docker stop ${UP_B}   # 장애 주입` });
    const retry = await series("/", 10);
    rows.push(summarize("② B 정지 · 재시도 켬 · max_fails=1", retry));
    ctx.check("재시도 켬: 사용자는 실패를 보지 않는다 (10/10 성공, 전부 A)", retry.every((s) => s.status === 200 && s.body === "A"));
    const slowRetry = retry.filter((s) => s.ms >= 800).length;
    ctx.check("죽은 B 를 처음 만난 요청만 느리다 (connect timeout), 이후 fail_timeout 동안 B 를 건너뛴다", slowRetry >= 1 && slowRetry <= 3, `느린 요청 ${slowRetry}개`);

    const noretry = await series("/noretry/", 10);
    rows.push(summarize("③ B 정지 · 재시도 끔 · max_fails=0", noretry));
    const failNo = noretry.filter((s) => s.status !== 200).length;
    ctx.check("재시도 끔 + 빼지 않음: 라운드 로빈으로 B 에 간 몫(약 절반)이 그대로 실패하고, 실패마다 connect timeout 1초", failNo >= 3 && failNo <= 7, `실패 ${failNo}개`);

    await ctx.sh("docker", ["start", UP_B], { label: `docker start ${UP_B}   # 복구` });
    await ctx.sleep(6000); // fail_timeout 경과
    const back = await series("/", 10);
    rows.push(summarize("④ B 복구 후", back));
    const bA = back.filter((s) => s.body === "A").length, bB = back.filter((s) => s.body === "B").length;
    ctx.check("B 가 살아나면 fail_timeout 뒤 다시 분산된다", bB >= 2 && bA >= 2, `A ${bA} · B ${bB}`);

    ctx.table("시나리오별 10요청 (순차)", ["상황", "성공", "응답한 서버", "5xx/실패", "p50", "최대", "800ms 이상"], rows);
    ctx.note("교훈: 재시도는 실패를 '지연' 으로 바꾼다. connect timeout 을 짧게(1s), 재시도 횟수를 제한(proxy_next_upstream_tries)하지 않으면 장애 시 모든 요청이 timeout × 서버 수만큼 매달린다. 능동 헬스 체크가 필요하면 Kubernetes readinessProbe 나 nginx Plus·Envoy·HAProxy 를 쓴다.");
    await rm(ctx, [LB_NAME, UP_A, UP_B]);
    await ctx.sh("docker", ["network", "rm", NET], { allowFail: true, label: `docker network rm ${NET}` });
  },
};
