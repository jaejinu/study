import type { ShellExperiment } from "./types";

const REDIS_PORT = (() => {
  try {
    return new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379").port || "6379";
  } catch {
    return "6379";
  }
})();

export const netPortsSockets: ShellExperiment = {
  id: "net-ports-sockets",
  subject: "linux-network",
  title: "포트와 소켓: 누가 어느 포트를 듣고 있나",
  category: "소켓",
  summary: "lsof/netstat 로 LISTEN 소켓과 ESTABLISHED 연결을 보고, nc 로 포트 열림을 확인하고, 닫힌 포트와 비교",
  notes: ["02-ip-ports-sockets", "05-tools"],
  description: `
소켓은 \`(프로토콜, 로컬 IP:포트, 원격 IP:포트)\` 로 식별되는 통신 끝점이다. 서버 프로세스는 포트를 **LISTEN** 하고, 연결이 오면
새 소켓(ESTABLISHED)이 생긴다. \`lsof -i\`(macOS/Linux) 또는 \`ss -tlnp\`(Linux) 로 어떤 프로세스가 어떤 포트를 쓰는지 본다.
\`nc -z\` 는 TCP 핸드셰이크만 해 보고 끊는다 — 포트 스캐너의 원리다.
`,
  code: `lsof -nP -iTCP -sTCP:LISTEN          # 듣고 있는 포트와 프로세스 (Linux: ss -tlnp)
lsof -nP -i :6379                     # 특정 포트
nc -zv 127.0.0.1 6379                 # 열림: succeeded
nc -zv -w 1 127.0.0.1 1               # 닫힘: refused
netstat -an | grep ESTABLISHED | head  # 맺어진 연결 (Linux: ss -tnp)`,
  async run(ctx) {
    const listen = await ctx.sh("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { allowFail: true });
    const lines = listen.out.split("\n").slice(1);
    ctx.check(`LISTEN 소켓 ${lines.length}개`, lines.length > 0);
    const byProc = new Map<string, number>();
    for (const l of lines) byProc.set(l.split(/\s+/)[0], (byProc.get(l.split(/\s+/)[0]) ?? 0) + 1);
    ctx.table("프로세스별 LISTEN 수", ["프로세스", "소켓 수"], [...byProc].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p, n]) => [p, String(n)]));

    await ctx.sh("lsof", ["-nP", "-i", `:${REDIS_PORT}`], { allowFail: true });
    const open = await ctx.sh("nc", ["-zv", "-w", "2", "127.0.0.1", REDIS_PORT], { allowFail: true });
    ctx.check(`127.0.0.1:${REDIS_PORT} 열림 (succeeded)`, /succeeded|open/i.test(open.out + open.err), (open.out + open.err).trim());
    const closed = await ctx.sh("nc", ["-zv", "-w", "1", "127.0.0.1", "1"], { allowFail: true });
    ctx.check("127.0.0.1:1 닫힘 (refused)", !closed.ok || /refused|failed/i.test(closed.out + closed.err), (closed.out + closed.err).trim());
    const est = await ctx.sh("sh", ["-c", "netstat -an | grep -c ESTABLISHED"], { allowFail: true });
    ctx.note(`ESTABLISHED 연결 ${est.out.trim()}개`);
    await ctx.sh("sh", ["-c", `lsof -nP -iTCP:${REDIS_PORT} -sTCP:ESTABLISHED | head -n 6`], { allowFail: true });
  },
};

export const netDnsHttp: ShellExperiment = {
  id: "net-dns-http",
  subject: "linux-network",
  title: "DNS 해석과 HTTP 요청의 전 과정",
  category: "프로토콜",
  summary: "dig 로 A/CNAME 레코드와 TTL 을 보고, curl -v 로 TCP 연결 → 요청 → 응답 헤더의 흐름과 각 단계 시간을 측정",
  notes: ["03-dns", "04-http-tls"],
  description: `
브라우저가 주소를 치면: **DNS 해석**(이름 → IP) → **TCP 3-way 핸드셰이크** → (TLS 핸드셰이크) → **HTTP 요청/응답**.
\`dig\` 는 리졸버에 직접 질의해 레코드와 TTL(캐시 가능 시간)을 보여주고, \`curl -w\` 는 단계별 시간을 출력한다.
로컬 앱(localhost:3000)과 외부 사이트를 비교하면 RTT 의 영향이 보인다.
`,
  code: `dig +short example.com A
dig example.com +noall +answer          # TTL 포함
dig @1.1.1.1 example.com                # 특정 리졸버에 질의
scutil --dns | head -n 20               # macOS 리졸버 설정 (Linux: cat /etc/resolv.conf)
curl -sv http://localhost:3000/api/metrics -o /dev/null 2>&1 | head -n 20
curl -s -o /dev/null -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\\n' https://example.com`,
  async run(ctx) {
    const a = await ctx.sh("dig", ["+short", "example.com", "A"], { allowFail: true, timeout: 10_000 });
    ctx.check("example.com 의 A 레코드 (IPv4)", /^\d+\.\d+\.\d+\.\d+/m.test(a.out), a.out || a.err);
    await ctx.sh("dig", ["example.com", "+noall", "+answer"], { allowFail: true, timeout: 10_000 });
    await ctx.sh("dig", ["+short", "www.github.com"], { allowFail: true, timeout: 10_000 });
    const resolv = await ctx.sh("sh", ["-c", "scutil --dns 2>/dev/null | grep -m 3 nameserver || cat /etc/resolv.conf"], { allowFail: true });
    ctx.note(`시스템 리졸버: ${resolv.out.trim().split("\n").join(" / ")}`);

    const local = await ctx.sh("curl", ["-s", "-o", "/dev/null", "-w", "dns=%{time_namelookup}s connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s http=%{http_code}", "http://localhost:3000/api/metrics"], { allowFail: true, timeout: 15_000 });
    const remote = await ctx.sh("curl", ["-s", "-o", "/dev/null", "-w", "dns=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s total=%{time_total}s http=%{http_code}", "https://example.com"], { allowFail: true, timeout: 20_000 });
    const lc = Number(/connect=([\d.]+)/.exec(local.out)?.[1] ?? 0);
    const rc = Number(/connect=([\d.]+)/.exec(remote.out)?.[1] ?? 0);
    ctx.check(`TCP 연결: 로컬 ${(lc * 1000).toFixed(1)}ms vs 외부 ${(rc * 1000).toFixed(1)}ms`, lc < rc || rc === 0, `${local.out}\n${remote.out}`);
    const verbose = await ctx.sh("sh", ["-c", "curl -sv http://localhost:3000/api/metrics -o /dev/null 2>&1 | grep -E '^(\\*|>|<)' | head -n 16"], { allowFail: true, timeout: 15_000 });
    ctx.check("요청(>)과 응답(<) 헤더가 보인다", /^> GET/m.test(verbose.out) && /^< HTTP/m.test(verbose.out), undefined);
  },
};
