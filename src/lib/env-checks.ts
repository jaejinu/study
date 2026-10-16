import { execFile } from "node:child_process";
import { kafkaClient, KAFKA_BROKERS } from "@/code-lab/kafka";
import { PG_URL, pgClient } from "@/code-lab/postgres";

export interface EnvStatus {
  ok: boolean;
  title: string;
  lines: string[];
  hint?: string;
  /** 추가 링크 */
  links?: { label: string; href: string }[];
}

async function fetchText(url: string, timeout = 2500): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: "no-store" });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch {
    return { ok: false, status: 0, text: "" };
  }
}

function run(bin: string, args: string[], timeout = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env: process.env }, (err, stdout, stderr) => resolve({ ok: !err, out: (err ? stderr || err.message : stdout).trim() }));
  });
}

export async function checkKafka(): Promise<EnvStatus> {
  const admin = kafkaClient("study-env").admin();
  try {
    await admin.connect();
    const [topics, cluster, groups] = await Promise.all([admin.listTopics(), admin.describeCluster(), admin.listGroups()]);
    return {
      ok: true,
      title: `Kafka 브로커 연결됨 (${KAFKA_BROKERS.join(",")})`,
      lines: [`브로커 ${cluster.brokers.length}개 · 컨트롤러 ${cluster.controller ?? "?"}`, `토픽 ${topics.filter((t) => !t.startsWith("__")).length}개: ${topics.filter((t) => !t.startsWith("__")).slice(0, 8).join(", ") || "(없음)"}`, `컨슈머 그룹 ${groups.groups.length}개`],
    };
  } catch {
    return { ok: false, title: "Kafka 브로커에 연결할 수 없습니다", lines: [`${KAFKA_BROKERS.join(",")}`], hint: "pnpm kafka:up   # 처음엔 30초쯤 걸립니다" };
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

export async function checkPostgres(): Promise<EnvStatus> {
  const c = pgClient();
  try {
    await c.connect();
    const v = (await c.query("select version() v, current_database() db, (select count(*) from pg_stat_activity) conns, pg_size_pretty(pg_database_size(current_database())) size")).rows[0];
    const tables = (await c.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n;
    return { ok: true, title: `PostgreSQL 연결됨 (${PG_URL.replace(/:[^:@]+@/, ":***@")})`, lines: [String(v.v).split(",")[0], `DB ${v.db} · 크기 ${v.size} · 커넥션 ${v.conns} · public 테이블 ${tables}개`] };
  } catch {
    return { ok: false, title: "PostgreSQL 에 연결할 수 없습니다", lines: [PG_URL.replace(/:[^:@]+@/, ":***@")], hint: "pnpm pg:up" };
  } finally {
    await c.end().catch(() => {});
  }
}

export async function checkObservability(): Promise<EnvStatus> {
  const [prom, graf, targets, metrics, loki, tempo, alloy] = await Promise.all([
    fetchText("http://127.0.0.1:19090/-/ready"),
    fetchText("http://127.0.0.1:13000/api/health"),
    fetchText("http://127.0.0.1:19090/api/v1/targets"),
    fetchText("http://127.0.0.1:3000/api/metrics"),
    fetchText("http://127.0.0.1:13100/ready"),
    fetchText("http://127.0.0.1:13200/ready"),
    fetchText("http://127.0.0.1:12346/-/ready"),
  ]);
  const lines: string[] = [];
  let up = 0;
  let total = 0;
  try {
    const t = JSON.parse(targets.text) as { data: { activeTargets: { labels: { job: string }; health: string }[] } };
    for (const a of t.data.activeTargets) {
      total++;
      if (a.health === "up") up++;
      lines.push(`${a.labels.job}: ${a.health}`);
    }
  } catch {
    /* prometheus down */
  }
  const ok = prom.ok && graf.ok;
  return {
    ok,
    title: ok ? "Prometheus · Grafana 실행 중" : "관측성 스택이 꺼져 있습니다",
    lines: ok
      ? [`스크레이프 타깃 ${up}/${total} up`, ...lines, `이 앱의 /api/metrics: ${metrics.ok ? "응답 OK" : "dev 서버 없음"}`, `로그: Loki ${loki.ok ? "ready" : "없음"} · Alloy ${alloy.ok ? "ready" : "없음"}`, `트레이스: Tempo ${tempo.ok ? "ready" : "없음"} · 앱 내보내기 ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? "ON (" + process.env.OTEL_EXPORTER_OTLP_ENDPOINT + ")" : "OFF — OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm dev"}`]
      : [`Prometheus ${prom.ok ? "OK" : "없음"} · Grafana ${graf.ok ? "OK" : "없음"} · Loki ${loki.ok ? "OK" : "없음"} · Tempo ${tempo.ok ? "OK" : "없음"}`],
    hint: ok ? undefined : "pnpm obs:up",
    links: ok
      ? [
          { label: "Prometheus", href: "http://localhost:19090/targets" },
          { label: "Grafana 대시보드", href: "http://localhost:13000/d/study-redis" },
          { label: "Grafana Explore (로그)", href: "http://localhost:13000/explore?schemaVersion=1&panes=%7B%22a%22:%7B%22datasource%22:%22loki%22,%22queries%22:%5B%7B%22expr%22:%22%7Bservice%3D%5C%22study-app%5C%22%7D%22%7D%5D%7D%7D" },
          { label: "Grafana Explore (트레이스)", href: "http://localhost:13000/explore?schemaVersion=1&panes=%7B%22a%22:%7B%22datasource%22:%22tempo%22,%22queries%22:%5B%7B%22queryType%22:%22traceqlSearch%22%7D%5D%7D%7D" },
          { label: "/api/metrics", href: "http://localhost:3000/api/metrics" },
        ]
      : undefined,
  };
}

export async function checkGithubActions(): Promise<EnvStatus> {
  const gh = await run("gh", ["run", "list", "--limit", "5", "--json", "status,conclusion,name,displayTitle,createdAt,url"]);
  if (!gh.ok) {
    return { ok: false, title: "gh CLI 로 워크플로 실행을 읽을 수 없습니다", lines: [gh.out.split("\n")[0]], hint: "brew install gh && gh auth login   (저장소에 원격이 있어야 합니다)", links: [{ label: "이 저장소의 Actions", href: "https://github.com/jaejinu/study/actions" }] };
  }
  try {
    const runs = JSON.parse(gh.out) as { status: string; conclusion: string; name: string; displayTitle: string; createdAt: string; url: string }[];
    return {
      ok: true,
      title: "최근 워크플로 실행 (gh run list)",
      lines: runs.map((r) => `${r.conclusion === "success" ? "✓" : r.status === "in_progress" ? "⏳" : "✗"} ${r.name} · ${r.displayTitle.slice(0, 48)} · ${new Date(r.createdAt).toLocaleString("ko-KR")}`),
      links: [{ label: "Actions 페이지", href: "https://github.com/jaejinu/study/actions" }, ...(runs[0] ? [{ label: "최근 실행", href: runs[0].url }] : [])],
    };
  } catch {
    return { ok: false, title: "gh 출력을 해석할 수 없습니다", lines: [gh.out.slice(0, 200)] };
  }
}

export async function checkNginx(): Promise<EnvStatus> {
  const [health, home, status] = await Promise.all([fetchText("http://127.0.0.1:18080/health"), fetchText("http://127.0.0.1:18080/"), fetchText("http://127.0.0.1:18080/nginx_status")]);
  if (!health.ok) return { ok: false, title: "Nginx 프록시가 꺼져 있습니다", lines: ["http://localhost:18080"], hint: "pnpm nginx:up   (pnpm dev 가 3000 에서 실행 중이어야 업스트림이 됩니다)" };
  const active = /Active connections: (\d+)/.exec(status.text)?.[1];
  return {
    ok: true,
    title: "Nginx 프록시 실행 중 (localhost:18080 → host:3000)",
    lines: [`/health: ${health.text.trim()}`, `/ 프록시 응답: HTTP ${home.status} ${home.ok ? "(앱 정상)" : "(업스트림 없음 — pnpm dev 실행 필요)"}`, active ? `stub_status active connections: ${active}` : "stub_status 접근 불가"],
    links: [{ label: "프록시로 사이트 열기", href: "http://localhost:18080" }, { label: "/nginx_status", href: "http://localhost:18080/nginx_status" }],
  };
}

export async function checkLinuxNetwork(): Promise<EnvStatus> {
  const [uname, ip, listen, dns] = await Promise.all([
    run("uname", ["-sr"]),
    run("sh", ["-c", "ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'"]),
    run("sh", ["-c", "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | tail -n +2 | wc -l | tr -d ' '"]),
    run("sh", ["-c", "scutil --dns 2>/dev/null | grep -m1 nameserver | awk '{print $3}' || grep -m1 nameserver /etc/resolv.conf | awk '{print $2}'"]),
  ]);
  return {
    ok: true,
    title: `이 머신: ${uname.out}`,
    lines: [`기본 인터페이스 IP: ${ip.out || "?"}`, `LISTEN 중인 TCP 소켓: ${listen.out}개`, `DNS 리졸버: ${dns.out || "?"}`],
    hint: "실험실에서 소켓·DNS·HTTP 를 직접 관찰해 보세요.",
  };
}

export async function checkAiSystems(): Promise<EnvStatus> {
  const { ensureConnected, getRedis } = await import("./redis");
  let search = false;
  let json = false;
  let redisOk = false;
  try {
    const r = getRedis();
    await ensureConnected(r);
    redisOk = true;
    const list = (await r.call("MODULE", "LIST")) as unknown[][];
    const names = list.map((m) => String(m[1]).toLowerCase());
    search = names.includes("search");
    json = names.includes("rejson");
  } catch {
    /* redis down */
  }
  const key = !!process.env.ANTHROPIC_API_KEY;
  return {
    ok: redisOk && search,
    title: redisOk && search ? "벡터 검색 준비됨 (Redis 8 Search 모듈)" : redisOk ? "Redis 는 있지만 Search 모듈이 없습니다" : "Redis 에 연결할 수 없습니다",
    lines: [
      `Redis: ${redisOk ? "연결됨" : "없음"} · Search(벡터) 모듈: ${search ? "있음" : "없음"} · JSON 모듈: ${json ? "있음" : "없음"}`,
      `ANTHROPIC_API_KEY: ${key ? "설정됨 (실제 LLM 호출 가능)" : "없음 — 실험은 결정적 가짜 임베딩/응답으로 동작합니다"}`,
    ],
    hint: redisOk && search ? undefined : "pnpm redis:docker   # brew 빌드에는 모듈이 없으니 Docker 의 redis:8 을 쓴다",
    links: [{ label: "Claude API 문서", href: "https://docs.anthropic.com" }, { label: "Redis 벡터 검색 문서", href: "https://redis.io/docs/latest/develop/interact/search-and-query/query/vector-search/" }],
  };
}

export async function checkArchitecture(): Promise<EnvStatus> {
  return {
    ok: true,
    title: "아키텍처 주제는 별도 환경이 필요 없습니다",
    lines: ["패턴의 증거는 다른 주제의 실험실에서 직접 돌려 봅니다:", "Redis(락·레이트리밋·스탬피드·Sentinel), Kafka(파티션·재처리), PostgreSQL(격리·잠금·SKIP LOCKED), Kubernetes(자가치유·롤링·HPA)"],
    links: [
      { label: "Redis 실험실", href: "/redis/lab" },
      { label: "Kafka 실험실", href: "/kafka/lab" },
      { label: "PostgreSQL 실험실", href: "/postgres/lab" },
    ],
  };
}

export async function checkChaos(): Promise<EnvStatus> {
  const [redis, kafka, pg, k8s, obs] = await Promise.all([
    run("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"]),
    run("docker", ["inspect", "-f", "{{.State.Status}}", "study-kafka"]),
    run("docker", ["inspect", "-f", "{{.State.Status}}", "study-postgres"]),
    run("kubectl", ["-n", "study", "get", "deploy", "web", "-o", "jsonpath={.status.readyReplicas}", "--request-timeout=4s"]),
    fetchText("http://127.0.0.1:19093/-/ready"),
  ]);
  const st = (r: { ok: boolean; out: string }) => (r.ok && r.out === "running" ? "running" : "없음");
  const lines = [
    `Redis(study-redis): ${st(redis)} · Kafka(study-kafka): ${st(kafka)} · PostgreSQL(study-postgres): ${st(pg)}`,
    `Kubernetes web Ready 복제본: ${k8s.ok ? k8s.out || 0 : "클러스터 없음"} (Pod kill 실험은 2 이상 필요)`,
    `Alertmanager: ${obs.ok ? "실행 중 — 장애가 알림으로 보임" : "꺼짐 — pnpm obs:up 이면 알림·로그로 장애를 확인할 수 있음"}`,
  ];
  const ok = st(redis) === "running";
  return { ok, title: ok ? "장애 주입 대상 준비됨" : "장애 주입 대상이 없습니다", lines, hint: ok ? undefined : "pnpm redis:docker   # 최소 Redis 는 Docker 로", links: [{ label: "관측성 대시보드 (최근 알림)", href: "/observability" }, { label: "Grafana", href: "http://localhost:13000/d/study-redis" }] };
}

export async function checkEnv(subject: string): Promise<EnvStatus> {
  switch (subject) {
    case "chaos":
      return checkChaos();
    case "ai-systems":
      return checkAiSystems();
    case "architecture":
      return checkArchitecture();
    case "kafka":
      return checkKafka();
    case "postgres":
      return checkPostgres();
    case "observability":
      return checkObservability();
    case "github-actions":
      return checkGithubActions();
    case "nginx":
      return checkNginx();
    case "linux-network":
      return checkLinuxNetwork();
    default:
      return { ok: true, title: subject, lines: [] };
  }
}
