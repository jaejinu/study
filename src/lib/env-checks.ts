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

async function version(bin: string, args: string[] = ["--version"]): Promise<string | null> {
  const r = await run(bin, args);
  return r.ok ? r.out.split("\n")[0].trim() : null;
}

export async function checkSecurity(): Promise<EnvStatus> {
  const [trivy, openssl, docker, kubectl] = await Promise.all([version("trivy"), version("openssl", ["version"]), version("docker", ["--version"]), run("kubectl", ["auth", "whoami", "--request-timeout=4s"])]);
  return {
    ok: !!openssl && !!docker,
    title: trivy ? "보안 도구 준비됨 (trivy · openssl · docker)" : "trivy 가 없습니다 (이미지 스캔 실험에 필요)",
    lines: [`trivy: ${trivy ?? "없음"}`, `openssl: ${openssl ?? "없음"} · docker: ${docker ?? "없음"}`, `kubectl 인증: ${kubectl.ok ? "클러스터 연결됨 (RBAC 실험 가능)" : "클러스터 없음"}`],
    hint: trivy ? undefined : "brew install trivy",
    links: [{ label: "OWASP Top 10", href: "https://owasp.org/www-project-top-ten/" }, { label: "Trivy 문서", href: "https://trivy.dev" }],
  };
}

export async function checkIac(): Promise<EnvStatus> {
  const [tofu, tf, docker] = await Promise.all([version("tofu"), version("terraform"), version("docker", ["--version"])]);
  const bin = tofu ? "tofu" : tf ? "terraform" : null;
  return {
    ok: !!bin,
    title: bin ? `${bin} 준비됨` : "terraform/opentofu 가 없습니다",
    lines: [`opentofu: ${tofu ?? "없음"} · terraform: ${tf ?? "없음"}`, `docker: ${docker ?? "없음"} (Docker 프로바이더 실험 대상)`],
    hint: bin ? undefined : "brew install opentofu   # 또는 brew tap hashicorp/tap && brew install hashicorp/tap/terraform",
    links: [{ label: "OpenTofu 문서", href: "https://opentofu.org/docs/" }, { label: "Terraform 레지스트리", href: "https://registry.terraform.io" }],
  };
}

export async function checkDistributed(): Promise<EnvStatus> {
  return {
    ok: true,
    title: "이론 주제는 별도 환경이 필요 없습니다",
    lines: ["원리의 증거는 다른 주제 실험실에서:", "Redis Sentinel 페일오버·클러스터 슬롯, Kafka ISR·acks, PostgreSQL 격리 수준·분산 락, Kubernetes etcd/리더 선출"],
    links: [
      { label: "Redis 실험실", href: "/redis/lab" },
      { label: "Kafka 실험실", href: "/kafka/lab" },
      { label: "PostgreSQL 실험실", href: "/postgres/lab" },
    ],
  };
}

export async function checkPerformance(): Promise<EnvStatus> {
  const [k6, app, prom] = await Promise.all([version("k6", ["version"]), fetchText("http://127.0.0.1:3000/api/metrics"), fetchText("http://127.0.0.1:19090/-/ready")]);
  return {
    ok: !!k6 && app.ok,
    title: k6 ? (app.ok ? "k6 + 대상 앱 준비됨" : "k6 는 있지만 앱(3000)이 응답하지 않습니다") : "k6 가 없습니다",
    lines: [`k6: ${k6 ?? "없음"}`, `대상 앱 /api/metrics: ${app.ok ? "응답" : "없음"} · Prometheus: ${prom.ok ? "실행 중 (RED 패널로 부하 관찰 가능)" : "꺼짐"}`],
    hint: k6 ? undefined : "brew install k6",
    links: [{ label: "k6 문서", href: "https://grafana.com/docs/k6/latest/" }, { label: "Grafana RED 패널", href: "http://localhost:13000/d/study-redis" }],
  };
}

async function checkSimple(title: string, probes: { label: string; ok: boolean; detail?: string }[], hint?: string, links?: { label: string; href: string }[]): Promise<EnvStatus> {
  return { ok: probes.every((p) => p.ok), title, lines: probes.map((p) => `${p.label}: ${p.ok ? "준비됨" : "없음"}${p.detail ? ` (${p.detail})` : ""}`), hint, links };
}

export async function checkSre(): Promise<EnvStatus> {
  const [prom, am, app] = await Promise.all([fetchText("http://127.0.0.1:19090/-/ready"), fetchText("http://127.0.0.1:19093/-/ready"), fetchText("http://127.0.0.1:3000/api/metrics")]);
  return checkSimple(prom.ok && am.ok ? "SLO 실험 준비됨 (Prometheus · Alertmanager · 앱 메트릭)" : "관측 스택이 필요합니다", [{ label: "Prometheus(19090)", ok: prom.ok }, { label: "Alertmanager(19093)", ok: am.ok }, { label: "앱 /api/metrics", ok: app.ok }], prom.ok ? undefined : "pnpm obs:up", [{ label: "Grafana", href: "http://localhost:13000" }, { label: "관측성 대시보드", href: "/observability" }]);
}
export async function checkEbpf(): Promise<EnvStatus> {
  const [docker, kernel, falco] = await Promise.all([version("docker", ["--version"]), run("docker", ["info", "--format", "{{.KernelVersion}}"]), run("kubectl", ["--context", "kind-study", "-n", "falco", "get", "ds", "falco", "-o", "jsonpath={.status.numberReady}", "--request-timeout=4s"])]);
  return checkSimple(docker ? `eBPF 실험 준비됨 (Docker VM 커널 ${kernel.out || "?"})` : "Docker 가 필요합니다", [{ label: "docker", ok: !!docker, detail: docker ?? undefined }, { label: "Linux 커널 (BTF 필요, 5.8+)", ok: kernel.ok, detail: kernel.out }, { label: "Falco (kind-study)", ok: falco.ok && Number(falco.out) > 0 }], docker ? undefined : "Docker Desktop 실행", [{ label: "bpftrace 문서", href: "https://github.com/bpftrace/bpftrace" }, { label: "보안 Falco 실험", href: "/security/lab" }]);
}
export async function checkSearch(): Promise<EnvStatus> {
  const os = await fetchText("http://127.0.0.1:19200/");
  const ver = os.ok ? (os.text.match(/"number"\s*:\s*"([^"]+)"/)?.[1] ?? "") : "";
  return checkSimple(os.ok ? `OpenSearch ${ver} 연결됨 (19200)` : "OpenSearch 가 꺼져 있습니다", [{ label: "OpenSearch(19200)", ok: os.ok, detail: ver || undefined }], os.ok ? undefined : "pnpm search:up", [{ label: "OpenSearch 문서", href: "https://docs.opensearch.org" }]);
}
export async function checkDbInternals(): Promise<EnvStatus> {
  const [pg, redis] = await Promise.all([run("docker", ["inspect", "-f", "{{.State.Status}}", "study-postgres"]), run("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"])]);
  return checkSimple("스토리지 엔진 실험 대상", [{ label: "PostgreSQL(study-postgres, pageinspect)", ok: pg.ok && pg.out === "running" }, { label: "Redis(study-redis)", ok: redis.ok && redis.out === "running" }, { label: "node:sqlite (Node 22 내장)", ok: Number(process.versions.node.split(".")[0]) >= 22 }], pg.ok ? undefined : "pnpm pg:up && pnpm redis:docker");
}
export async function checkApiDesign(): Promise<EnvStatus> {
  const nginx = await fetchText("http://127.0.0.1:18080/health");
  return checkSimple("gRPC 실험은 Node 만으로 동작합니다", [{ label: "@grpc/grpc-js", ok: true }, { label: "Nginx 프록시(18080)", ok: nginx.ok }], nginx.ok ? undefined : "pnpm nginx:up   # 프록시 실험용 (선택)", [{ label: "gRPC 문서", href: "https://grpc.io/docs/" }]);
}
export async function checkMessaging(): Promise<EnvStatus> {
  const [rmq, nats, kafka] = await Promise.all([fetchText("http://127.0.0.1:15674/"), fetchText("http://127.0.0.1:18222/varz"), run("docker", ["inspect", "-f", "{{.State.Status}}", "study-kafka"])]);
  return checkSimple(rmq.ok && nats.ok ? "RabbitMQ · NATS 연결됨" : "브로커가 꺼져 있습니다", [{ label: "RabbitMQ(5673, 관리 15674)", ok: rmq.ok }, { label: "NATS JetStream(14222, 모니터 18222)", ok: nats.ok }, { label: "Kafka(19092, 비교용)", ok: kafka.ok && kafka.out === "running" }], rmq.ok && nats.ok ? undefined : "pnpm mq:up", [{ label: "RabbitMQ 관리 UI", href: "http://localhost:15674" }, { label: "NATS 모니터", href: "http://localhost:18222" }]);
}
export async function checkMlops(): Promise<EnvStatus> {
  const [ollama, mlflow] = await Promise.all([fetchText("http://127.0.0.1:11434/api/tags"), fetchText("http://127.0.0.1:15000/health")]);
  const models = ollama.ok ? (ollama.text.match(/"name"\s*:\s*"([^"]+)"/g) ?? []).map((m) => m.replace(/.*"([^"]+)"$/, "$1")).join(", ") : "";
  return checkSimple("로컬 모델 서빙 · 실험 추적", [{ label: "Ollama(11434)", ok: ollama.ok, detail: models || undefined }, { label: "MLflow(15000)", ok: mlflow.ok }, { label: "ANTHROPIC_API_KEY", ok: !!process.env.ANTHROPIC_API_KEY, detail: "LLM-judge 실험 (없으면 로컬 모델로)" }], ollama.ok ? undefined : "brew install ollama && ollama serve && ollama pull qwen2.5:0.5b", [{ label: "Ollama", href: "https://ollama.com" }, { label: "MLflow UI", href: "http://localhost:15000" }]);
}
export async function checkTesting(): Promise<EnvStatus> {
  const [redis, docker] = await Promise.all([run("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"]), version("docker", ["--version"])]);
  return checkSimple("테스트 실험 준비", [{ label: "vitest · fast-check", ok: true }, { label: "Docker (컨테이너 격리 테스트)", ok: !!docker }, { label: "Redis(study-redis)", ok: redis.ok && redis.out === "running" }], redis.ok ? undefined : "pnpm redis:docker");
}
export async function checkFinops(): Promise<EnvStatus> {
  const [oc, prom, kps] = await Promise.all([run("kubectl", ["--context", "kind-study", "-n", "opencost", "get", "deploy", "opencost", "-o", "jsonpath={.status.readyReplicas}", "--request-timeout=4s"]), fetchText("http://127.0.0.1:19090/-/ready"), run("kubectl", ["--context", "kind-study", "-n", "monitoring", "get", "svc", "kps-kube-prometheus-stack-prometheus", "--request-timeout=4s"])]);
  return checkSimple("비용 모델링 대상", [{ label: "OpenCost (kind-study)", ok: oc.ok && Number(oc.out) > 0 }, { label: "kube-prometheus-stack", ok: kps.ok }, { label: "Prometheus(19090, 보존 비용 측정)", ok: prom.ok }], oc.ok && Number(oc.out) > 0 ? undefined : "helm install opencost (실험 설명 참고)", [{ label: "OpenCost", href: "https://www.opencost.io" }]);
}
export async function checkOsInternals(): Promise<EnvStatus> {
  const [docker, kernel, redis] = await Promise.all([version("docker", ["--version"]), run("docker", ["info", "--format", "{{.KernelVersion}} / {{.NCPU}} CPU / {{.MemTotal}} B"]), run("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"])]);
  return checkSimple(docker ? `Linux VM 준비됨 (${kernel.out})` : "Docker 가 필요합니다", [{ label: "docker (특권 컨테이너로 perf·bpftrace)", ok: !!docker }, { label: "Redis(study-redis, 관측 대상)", ok: redis.ok && redis.out === "running" }], docker ? undefined : "Docker Desktop 실행");
}

export async function checkAiAgents(): Promise<EnvStatus> {
  const [ollama, tempo] = await Promise.all([fetchText("http://127.0.0.1:11434/api/tags"), fetchText("http://127.0.0.1:13200/ready")]);
  const models = ollama.ok ? (ollama.text.match(/"name"\s*:\s*"([^"]+)"/g) ?? []).map((m) => m.replace(/.*"([^"]+)"$/, "$1")).join(", ") : "";
  return checkSimple(ollama.ok ? "에이전트 실험 준비됨 (로컬 모델)" : "Ollama 가 꺼져 있습니다", [{ label: "Ollama(11434)", ok: ollama.ok, detail: models || undefined }, { label: "Tempo(13200, 트레이스)", ok: tempo.ok }, { label: "OPENAI_API_KEY", ok: !!process.env.OPENAI_API_KEY, detail: "없으면 Ollama 사용" }], ollama.ok ? undefined : "ollama serve && ollama pull qwen2.5:1.5b", [{ label: "MCP 문서", href: "https://modelcontextprotocol.io" }]);
}
export async function checkClickhouse(): Promise<EnvStatus> {
  const ch = await fetchText("http://127.0.0.1:18123/?query=SELECT%20version()");
  return checkSimple(ch.ok ? `ClickHouse ${ch.text.trim()} 연결됨 (18123)` : "ClickHouse 가 꺼져 있습니다", [{ label: "ClickHouse HTTP(18123)", ok: ch.ok }], ch.ok ? undefined : "pnpm clickhouse:up", [{ label: "ClickHouse 문서", href: "https://clickhouse.com/docs" }]);
}
export async function checkDataEngineering(): Promise<EnvStatus> {
  const [s3, kafka, connect] = await Promise.all([run("docker", ["inspect", "-f", "{{.State.Status}}", "study-s3"]), run("docker", ["inspect", "-f", "{{.State.Status}}", "study-kafka"]), fetchText("http://127.0.0.1:18083/connectors")]);
  const s3ok = s3.ok && s3.out === "running";
  return checkSimple("데이터 파이프라인 구성 요소", [{ label: "DuckDB (내장)", ok: true }, { label: "S3 호환 저장소 versitygw (19100, 선택 — CDC 실험은 자체 컨테이너를 띄움)", ok: s3ok }, { label: "Kafka(19092)", ok: kafka.ok && kafka.out === "running" }, { label: "Kafka Connect/Debezium(18083)", ok: connect.ok }], connect.ok ? undefined : "pnpm cdc:up   # CDC → 레이크 실험용 (S3 저장소는 pnpm lake:up)", [{ label: "DuckDB 문서", href: "https://duckdb.org/docs" }]);
}

export async function checkServiceMesh(): Promise<EnvStatus> {
  const [cli, cp, kind] = await Promise.all([version(process.env.HOME ? `${process.env.HOME}/.linkerd2/bin/linkerd` : "linkerd", ["version", "--client", "--short"]).then((v) => v ?? version("linkerd", ["version", "--client", "--short"])), run("kubectl", ["--context", "kind-study", "-n", "linkerd", "get", "deploy", "linkerd-destination", "-o", "jsonpath={.status.readyReplicas}", "--request-timeout=4s"]), run("kubectl", ["--context", "kind-study", "get", "ns", "study", "--request-timeout=4s"])]);
  return checkSimple(cp.ok && Number(cp.out) > 0 ? "Linkerd 컨트롤 플레인 실행 중 (kind-study)" : "Linkerd 가 아직 없습니다", [{ label: "linkerd CLI (공식 edge 빌드 ~/.linkerd2/bin 우선 — brew 판은 이미지 태그 문제)", ok: !!cli, detail: cli ?? undefined }, { label: "Linkerd 컨트롤 플레인", ok: cp.ok && Number(cp.out) > 0 }, { label: "kind-study · study 네임스페이스", ok: kind.ok }], cli ? undefined : "curl -sL https://run.linkerd.io/install-edge | sh && ~/.linkerd2/bin/linkerd check --pre", [{ label: "Linkerd 문서", href: "https://linkerd.io/2/overview/" }]);
}
export async function checkEventSourcing(): Promise<EnvStatus> {
  const [pg, kafka] = await Promise.all([run("docker", ["inspect", "-f", "{{.State.Status}}", "study-postgres"]), run("docker", ["inspect", "-f", "{{.State.Status}}", "study-kafka"])]);
  return checkSimple("이벤트 스토어 실험 대상", [{ label: "PostgreSQL(15432, 이벤트 스토어)", ok: pg.ok && pg.out === "running" }, { label: "Kafka(19092, 발행 — 선택)", ok: kafka.ok && kafka.out === "running" }], pg.ok && pg.out === "running" ? undefined : "pnpm pg:up");
}
export async function checkNetworkProtocols(): Promise<EnvStatus> {
  const [docker, curl] = await Promise.all([version("docker", ["--version"]), run("curl", ["--version"])]);
  const http3 = /HTTP3/.test(curl.out);
  return checkSimple("손실·지연 주입 실험 준비", [{ label: "docker (tc netem 은 컨테이너 안에서 NET_ADMIN 으로)", ok: !!docker }, { label: "호스트 curl HTTP/3", ok: http3, detail: http3 ? undefined : "없으면 컨테이너 curl 을 사용" }], docker ? undefined : "Docker Desktop 실행");
}
export async function checkSystemDesign(): Promise<EnvStatus> {
  const [redis, pg, kafka, k6] = await Promise.all([run("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"]), run("docker", ["inspect", "-f", "{{.State.Status}}", "study-postgres"]), run("docker", ["inspect", "-f", "{{.State.Status}}", "study-kafka"]), version("k6", ["version"])]);
  const up = (r: { ok: boolean; out: string }) => r.ok && r.out === "running";
  return checkSimple("사례 검증 구성 요소", [{ label: "Redis", ok: up(redis) }, { label: "PostgreSQL", ok: up(pg) }, { label: "Kafka", ok: up(kafka) }, { label: "k6", ok: !!k6 }], up(redis) ? undefined : "pnpm redis:docker && pnpm pg:up && pnpm kafka:up");
}
export async function checkPlatformEngineering(): Promise<EnvStatus> {
  const gh = await run("gh", ["auth", "status"]);
  return checkSimple("DORA 계산 데이터", [{ label: "gh CLI 인증 (이 저장소의 커밋·CI 기록)", ok: gh.ok }], gh.ok ? undefined : "gh auth login", [{ label: "DORA", href: "https://dora.dev" }, { label: "Backstage", href: "https://backstage.io" }]);
}

export async function checkEnv(subject: string): Promise<EnvStatus> {
  switch (subject) {
    case "service-mesh": return checkServiceMesh();
    case "event-sourcing": return checkEventSourcing();
    case "network-protocols": return checkNetworkProtocols();
    case "system-design": return checkSystemDesign();
    case "platform-engineering": return checkPlatformEngineering();
    case "ai-agents": return checkAiAgents();
    case "clickhouse": return checkClickhouse();
    case "data-engineering": return checkDataEngineering();
    case "sre": return checkSre();
    case "ebpf": return checkEbpf();
    case "opensearch": return checkSearch();
    case "db-internals": return checkDbInternals();
    case "api-design": return checkApiDesign();
    case "messaging": return checkMessaging();
    case "mlops": return checkMlops();
    case "testing": return checkTesting();
    case "finops": return checkFinops();
    case "os-internals": return checkOsInternals();
    case "security":
      return checkSecurity();
    case "iac":
      return checkIac();
    case "distributed-systems":
      return checkDistributed();
    case "performance":
      return checkPerformance();
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
