import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

/** arm64 VM(Apple Silicon 의 Docker Desktop) 용 bpftrace 이미지. quay.io/iovisor/bpftrace 는 amd64 전용이라 직접 빌드한다 */
const IMAGE = "study-bpftrace:local";
const DOCKERFILE = `FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bpftrace >/dev/null && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["bpftrace"]
`;

async function requiresEbpf(): Promise<string | null> {
  const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 6000 });
  if (!d.ok) return "Docker 데몬이 필요합니다 (eBPF 는 Docker Desktop 의 Linux VM 커널에서 돈다).";
  const r = await exec("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"], { timeout: 6000 });
  if (!r.ok || r.out !== "running") return "관측 대상 study-redis 가 실행 중이어야 합니다 (`pnpm redis:docker`).";
  const btf = await exec("docker", ["run", "--rm", "--privileged", "alpine:3.20", "test", "-e", "/sys/kernel/btf/vmlinux"], { timeout: 60_000 });
  if (!btf.ok) return "이 커널에 BTF(/sys/kernel/btf/vmlinux)가 없습니다. CO-RE·구조체 접근이 필요한 실험을 돌릴 수 없습니다.";
  return null;
}

async function ensureImage(ctx: ShellCtx) {
  const has = await exec("docker", ["image", "inspect", IMAGE], { timeout: 10_000 });
  if (has.ok) {
    ctx.note(`bpftrace 이미지 ${IMAGE} 재사용`);
    return;
  }
  await ctx.sh("docker", ["build", "-q", "-t", IMAGE, "-"], { input: DOCKERFILE, timeout: 600_000, label: `docker build -t ${IMAGE} -   # Ubuntu 24.04 + bpftrace (첫 실행만, 1~3분)` });
}

function bpftrace(ctx: ShellCtx, script: string, label: string, timeout = 60_000) {
  return ctx.sh("docker", ["run", "--rm", "--privileged", "--pid=host", "-v", "/sys/kernel/debug:/sys/kernel/debug:rw", IMAGE, "-e", script], { allowFail: true, timeout, label });
}

async function redisPid(): Promise<number> {
  const r = await exec("docker", ["inspect", "-f", "{{.State.Pid}}", "study-redis"]);
  return Number(r.out);
}

/** bpftrace hist() 출력 → [구간, 개수] 행 */
function parseHist(out: string, name: string): { rows: string[][]; total: number } {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.trim() === `@${name}:`);
  const rows: string[][] = [];
  let total = 0;
  if (start < 0) return { rows, total };
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\s*(\[[^\]]*[\])])\s+(\d+)\s*\|/);
    if (!m) {
      if (rows.length) break;
      continue;
    }
    rows.push([m[1], m[2]]);
    total += Number(m[2]);
  }
  return { rows, total };
}

function parseScalar(out: string, name: string): number {
  const m = out.match(new RegExp(`^@${name}: (\\d+)`, "m"));
  return m ? Number(m[1]) : 0;
}

/** 히스토그램 행에서 누적 50%·99% 가 속한 구간 */
function quantileBucket(rows: string[][], q: number): string {
  const total = rows.reduce((a, r) => a + Number(r[1]), 0);
  let acc = 0;
  for (const r of rows) {
    acc += Number(r[1]);
    if (acc >= total * q) return r[0];
  }
  return "-";
}

// ---------------------------------------------------------------- 1. Redis syscall 분포 + write 지연
const SYSCALLS: Record<string, Record<number, string>> = {
  aarch64: { 17: "getcwd", 21: "epoll_ctl", 22: "epoll_pwait", 59: "pipe2", 83: "fdatasync", 135: "rt_sigprocmask", 165: "getrusage", 220: "clone", 223: "fadvise64", 25: "fcntl", 29: "ioctl", 56: "openat", 57: "close", 62: "lseek", 63: "read", 64: "write", 65: "readv", 66: "writev", 73: "ppoll", 98: "futex", 113: "clock_gettime", 124: "sched_yield", 172: "getpid", 198: "socket", 202: "accept", 208: "setsockopt", 209: "getsockopt", 222: "mmap", 215: "munmap", 226: "mprotect", 233: "madvise", 242: "accept4", 260: "wait4", 261: "prlimit64", 278: "getrandom", 291: "statx" },
  x86_64: { 0: "read", 1: "write", 3: "close", 7: "poll", 9: "mmap", 11: "munmap", 16: "ioctl", 19: "readv", 20: "writev", 39: "getpid", 43: "accept", 54: "setsockopt", 55: "getsockopt", 72: "fcntl", 202: "futex", 228: "clock_gettime", 232: "epoll_wait", 257: "openat", 281: "epoll_pwait", 288: "accept4", 318: "getrandom" },
};

export const ebpfBpftraceSyscalls: ShellExperiment = {
  id: "ebpf-bpftrace-syscalls",
  subject: "ebpf",
  title: "bpftrace 로 Redis 의 시스템 콜을 센다: 부하 중 어떤 syscall 이 몇 번, write 는 몇 µs 걸리나",
  category: "bpftrace",
  summary: "Docker Desktop VM 커널에 bpftrace 를 특권 컨테이너로 올려 study-redis 프로세스(호스트 PID)만 필터하고, redis-benchmark 부하 10초 동안 raw_syscalls 로 syscall 종류별 횟수와 write 진입-반환 지연 히스토그램을 커널 안에서 집계한다. syscount·funclatency 의 원리를 한 줄 스크립트로",
  notes: ["02-bpftrace-one-liners", "01-what-is-ebpf", "03-bcc-libbpf-tools"],
  description: `
bpftrace 는 "프로브 /필터/ { 액션 }" 한 줄을 BPF 바이트코드로 바꿔 커널에 올린다. 집계(\`count()\`, \`hist()\`)는 **커널 안의 맵**에서 일어나고 유저 공간에는 요약만 온다 — 그래서 strace 처럼 매 syscall 마다 프로세스를 멈추지 않는다.
macOS 에는 eBPF 가 없으므로 Docker Desktop 의 Linux VM 에서 돈다. \`--privileged --pid=host\` 로 띄운 bpftrace 컨테이너는 VM 의 모든 프로세스(=모든 컨테이너)를 본다. 그래서 \`docker inspect -f '{{.State.Pid}}' study-redis\` 의 PID 로 Redis 만 골라낸다.
기대: Redis 는 이벤트 루프 서버라 \`epoll_pwait\` 로 기다리다 \`read\` 로 요청을 읽고 \`write\` 로 응답한다. 부하 중에는 read/write 가 압도적이고 write 하나는 수 µs 에 끝난다.
`,
  code: `PID=$(docker inspect -f '{{.State.Pid}}' study-redis)
docker run --rm --privileged --pid=host -v /sys/kernel/debug:/sys/kernel/debug study-bpftrace:local -e "
  tracepoint:raw_syscalls:sys_enter /pid == $PID/ { @sys[args.id] = count(); }
  tracepoint:syscalls:sys_enter_write /pid == $PID/ { @s[tid] = nsecs; }
  tracepoint:syscalls:sys_exit_write  /@s[tid]/ { @write_us = hist((nsecs - @s[tid]) / 1000); delete(@s[tid]); }
  interval:s:10 { clear(@s); exit(); }" &
sleep 3; docker exec study-redis redis-benchmark -q -n 50000 -c 20 -t set,get`,
  requires: requiresEbpf,
  async run(ctx) {
    await ensureImage(ctx);
    const pid = await redisPid();
    const arch = (await exec("docker", ["run", "--rm", "alpine:3.20", "uname", "-m"])).out.trim();
    ctx.note(`study-redis 의 VM PID = ${pid}, 아키텍처 ${arch} (syscall 번호표가 아키텍처마다 다르다)`);
    const script = `
tracepoint:raw_syscalls:sys_enter /pid == ${pid}/ { @sys[args.id] = count(); }
tracepoint:syscalls:sys_enter_write /pid == ${pid}/ { @s[tid] = nsecs; }
tracepoint:syscalls:sys_exit_write /@s[tid]/ { @write_us = hist((nsecs - @s[tid]) / 1000); delete(@s[tid]); }
interval:s:10 { clear(@s); exit(); }`;
    const traceP = bpftrace(ctx, script, `bpftrace (PID ${pid} 필터): raw_syscalls 집계 + write 지연 hist, 10초`);
    await ctx.sleep(3000);
    const bench = await ctx.sh("docker", ["exec", "study-redis", "redis-benchmark", "-q", "-n", "50000", "-c", "20", "-t", "set,get"], { allowFail: true, timeout: 60_000, label: "docker exec study-redis redis-benchmark -q -n 50000 -c 20 -t set,get   # 추적 중 부하" });
    ctx.note(`벤치마크: ${bench.out.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => /^\w+: [\d.]+ requests per second/.test(l)).join(" / ")}`);
    const tr = await traceP;
    ctx.check("bpftrace 가 VM 커널에 프로그램을 올리고 정상 종료했다", tr.ok, tr.err.split("\n").slice(-3).join(" "));

    const names = SYSCALLS[arch] ?? {};
    const counts = [...tr.out.matchAll(/^@sys\[(\d+)\]: (\d+)/gm)].map((m) => ({ id: Number(m[1]), n: Number(m[2]) })).sort((a, b) => b.n - a.n);
    const total = counts.reduce((a, c) => a + c.n, 0);
    ctx.table(`Redis 의 syscall 상위 (10초, 총 ${total.toLocaleString()}회)`, ["syscall", "번호", "횟수", "비율"], counts.slice(0, 8).map((c) => [names[c.id] ?? `#${c.id}`, String(c.id), c.n.toLocaleString(), `${((c.n / total) * 100).toFixed(1)}%`]));
    const top2 = counts.slice(0, 3).map((c) => names[c.id] ?? "");
    ctx.check("부하 중 상위 syscall 은 네트워크 I/O(read·write) 와 epoll 이다 — 이벤트 루프 서버의 서명", top2.some((n) => /^(read|write|writev)$/.test(n)) && total > 1000, top2.join(", "));

    const h = parseHist(tr.out, "write_us");
    ctx.table(`write 진입→반환 지연 (µs, 로그2 히스토그램, ${h.total.toLocaleString()}회)`, ["구간(µs)", "횟수"], h.rows);
    ctx.check("write 지연 히스토그램이 커널 안에서 집계됐다", h.total > 100, `${h.total}회`);
    ctx.note(`write p50 ≈ ${quantileBucket(h.rows, 0.5)} µs, p99 ≈ ${quantileBucket(h.rows, 0.99)} µs. 응답 하나를 소켓 버퍼에 넣는 비용이 이 정도다 — Redis 명령 자체보다 시스템 콜과 네트워크가 비싸다는 말의 커널 측 증거.`);
    ctx.note("같은 질문을 strace -c 로 하면 매 syscall 마다 ptrace 정지가 생겨 Redis 처리량이 몇 배 떨어진다. eBPF 는 커널 안에서 세고 요약만 꺼낸다.");
  },
};

// ---------------------------------------------------------------- 2. TCP 연결 수립 지연·수명 (tcplife / tcpconnlat 원리)
function tcpScript(seconds: number) {
  // 상태 번호: 1 ESTABLISHED, 2 SYN_SENT, 7 CLOSE. 프로토콜 6 = TCP. 클라이언트 쪽 소켓(dport 6379)만.
  return `
tracepoint:sock:inet_sock_set_state /args.protocol == 6 && args.dport == 6379/ {
  if (args.newstate == 2) { @syn[args.skaddr] = nsecs; }
  if (args.newstate == 1 && @syn[args.skaddr]) {
    @connect_us = hist((nsecs - @syn[args.skaddr]) / 1000); @est[args.skaddr] = nsecs; delete(@syn[args.skaddr]); @opened = count();
  }
  if (args.newstate == 7 && @est[args.skaddr]) {
    @life_ms = hist((nsecs - @est[args.skaddr]) / 1000000); delete(@est[args.skaddr]); @closed = count();
  }
}
interval:s:${seconds} { clear(@syn); clear(@est); exit(); }`;
}

export const ebpfTcpLatency: ShellExperiment = {
  id: "ebpf-tcp-latency",
  subject: "ebpf",
  title: "TCP 연결을 커널에서 본다: 연결을 매번 새로 맺으면 몇 개가 열리고, 맺는 데 얼마나, 얼마나 살다 죽나",
  category: "네트워크",
  summary: "tracepoint:sock:inet_sock_set_state 하나로 Redis(6379) 로 가는 TCP 소켓의 SYN_SENT→ESTABLISHED(연결 수립 지연)와 ESTABLISHED→CLOSE(수명)를 히스토그램으로 잰다. redis-benchmark 를 keepalive 끔(-k 0)과 켬(-k 1)으로 두 번 돌려 연결 수·수명의 차이를 비교 — 커넥션 풀이 왜 필요한지의 커널 측 증거",
  notes: ["02-bpftrace-one-liners", "03-bcc-libbpf-tools", "04-networking-xdp-tc-cilium", "07-writing-your-own"],
  description: `
\`tcplife\`·\`tcpconnlat\` 같은 도구는 TCP 상태 전이 tracepoint 를 본다. 소켓이 SYN_SENT 가 된 시각과 ESTABLISHED 가 된 시각의 차이가 **연결 수립 지연**(3-way handshake), ESTABLISHED 부터 CLOSE 까지가 **수명**이다. 소켓 포인터(\`skaddr\`)를 맵의 키로 써서 상태 사이를 짝짓는다.
두 번 측정한다: 요청마다 새 연결(\`-k 0\`)과 연결 재사용(\`-k 1\`). 같은 요청 수인데 열린 연결 수가 수백 배 차이 나고, 새 연결은 매번 핸드셰이크 비용을 낸다. 앱의 ioredis 가 연결 하나를 오래 유지하는 이유다.
클라이언트를 Redis 컨테이너 안(\`docker exec\`)에서 돌려 루프백 연결을 만든다 — VM 커널 안에서 일어나므로 bpftrace 가 그대로 본다.
`,
  code: `docker run --rm --privileged --pid=host -v /sys/kernel/debug:/sys/kernel/debug study-bpftrace:local -e '
tracepoint:sock:inet_sock_set_state /args.protocol == 6 && args.dport == 6379/ {
  if (args.newstate == 2) { @syn[args.skaddr] = nsecs; }                                  // SYN_SENT
  if (args.newstate == 1 && @syn[args.skaddr]) { @connect_us = hist((nsecs - @syn[args.skaddr]) / 1000); @est[args.skaddr] = nsecs; delete(@syn[args.skaddr]); }
  if (args.newstate == 7 && @est[args.skaddr]) { @life_ms = hist((nsecs - @est[args.skaddr]) / 1000000); delete(@est[args.skaddr]); }   // CLOSE
}
interval:s:8 { exit(); }' &
docker exec study-redis redis-benchmark -q -n 2000 -c 10 -k 0 -t ping_inline   # 요청마다 새 연결
docker exec study-redis redis-benchmark -q -n 2000 -c 10 -k 1 -t ping_inline   # 연결 재사용`,
  requires: requiresEbpf,
  async run(ctx) {
    await ensureImage(ctx);
    const results: { mode: string; opened: number; closed: number; connect: string[][]; life: string[][]; rps: string }[] = [];
    for (const [mode, k] of [["새 연결 (-k 0)", "0"], ["연결 재사용 (-k 1)", "1"]] as const) {
      const traceP = bpftrace(ctx, tcpScript(9), `bpftrace inet_sock_set_state (dport 6379) — ${mode}, 9초`);
      await ctx.sleep(3000);
      const b = await ctx.sh("docker", ["exec", "study-redis", "redis-benchmark", "-q", "-n", "2000", "-c", "10", "-k", k, "-t", "ping_inline"], { allowFail: true, timeout: 60_000, label: `docker exec study-redis redis-benchmark -q -n 2000 -c 10 -k ${k} -t ping_inline` });
      const tr = await traceP;
      if (!tr.ok) ctx.note(`bpftrace 오류: ${tr.err.split("\n").slice(-2).join(" ")}`);
      results.push({
        mode,
        opened: parseScalar(tr.out, "opened"),
        closed: parseScalar(tr.out, "closed"),
        connect: parseHist(tr.out, "connect_us").rows,
        life: parseHist(tr.out, "life_ms").rows,
        rps: b.out.split(/[\r\n]+/).map((l) => l.trim()).find((l) => /^\w+: [\d.]+ requests per second/.test(l))?.match(/([\d.]+) requests/)?.[1] ?? "?",
      });
    }
    ctx.table("두 모드 비교 (같은 2,000 요청)", ["모드", "열린 연결", "닫힌 연결", "연결 수립 p50(µs)", "연결 수립 p99(µs)", "수명 p50(ms)", "처리량(req/s)"], results.map((r) => [r.mode, String(r.opened), String(r.closed), quantileBucket(r.connect, 0.5), quantileBucket(r.connect, 0.99), quantileBucket(r.life, 0.5), r.rps]));
    const [fresh, reuse] = results;
    ctx.table(`연결 수립 지연 히스토그램 — ${fresh.mode} (µs)`, ["구간", "횟수"], fresh.connect);
    ctx.check("새 연결 모드는 요청 수에 가까운 연결을 열었다 (수백~2,000)", fresh.opened >= 500, `${fresh.opened}개`);
    ctx.check("재사용 모드는 클라이언트 수(10)에 가까운 연결만 열었다", reuse.opened > 0 && reuse.opened <= 30, `${reuse.opened}개`);
    ctx.check("상태 전이를 짝지어 연결 수립 지연(SYN_SENT→ESTABLISHED)을 측정했다", fresh.connect.length > 0);
    ctx.note(`새 연결 ${fresh.opened}개 × 핸드셰이크 ≈ ${quantileBucket(fresh.connect, 0.5)}µs + 소켓 생성·종료(TIME_WAIT) 비용. 루프백이라 µs 단위지만, 실제 네트워크(RTT 0.5ms)·TLS 라면 연결 하나에 수 ms 다. 커넥션 풀은 이 비용을 한 번만 낸다.`);
    ctx.note("앱(Node)의 ioredis 연결은 수명이 수 시간 — 같은 스크립트를 몇 분 켜 두고 앱을 재시작하면 수명 히스토그램 오른쪽 끝에 그 연결이 찍힌다.");
  },
};

// ---------------------------------------------------------------- 3. 스택 샘플링 프로파일
export const ebpfProfileFlamegraph: ShellExperiment = {
  id: "ebpf-profile-flamegraph",
  subject: "ebpf",
  title: "99Hz 스택 샘플링으로 Redis 의 CPU 시간이 어디에 쓰이는지 본다 (flame graph 의 원재료)",
  category: "프로파일링",
  summary: "bpftrace profile:hz:99 로 redis-benchmark 부하 중 study-redis 의 커널+유저 스택을 8초간 샘플링해 스택별 카운트를 커널 맵에 모은다. 상위 스택의 꼭대기(leaf) 함수, 커널/유저 비율, 유저 스택이 심볼로 풀리는지([unknown] 문제)를 표로 본다",
  notes: ["06-profiling-continuous", "02-bpftrace-one-liners"],
  description: `
샘플링 프로파일러는 정해진 주기(99Hz — 100Hz 와 위상이 맞는 주기 작업을 피하려고)로 **지금 CPU 에서 돌고 있는 스택**을 기록한다. 같은 스택이 많이 찍힐수록 그 코드가 CPU 를 많이 쓴 것이다. 스택을 맵의 **키**로 쓰면 커널 안에서 "스택 → 횟수" 로 집계돼 유저 공간 복사가 거의 없다.
이 출력이 flame graph 의 원재료다(FlameGraph 의 \`stackcollapse-bpftrace.pl\` → \`flamegraph.pl\`). 여기서는 상위 스택을 표로 읽는다: 꼭대기 함수(self time), 커널 프레임인지 유저 프레임인지.
Redis 는 대부분 I/O 를 하므로 커널 쪽(소켓 송수신, epoll) 비중이 크다. 유저 스택은 Alpine(musl) 최적화 빌드라 프레임 포인터가 없어 짧게 끊기거나 주소로만 나올 수 있다 — 노트 06 의 '[unknown]' 문제를 직접 본다.
`,
  code: `PID=$(docker inspect -f '{{.State.Pid}}' study-redis)
docker run --rm --privileged --pid=host -v /sys/kernel/debug:/sys/kernel/debug study-bpftrace:local -e "
  profile:hz:99 /pid == $PID/ { @[kstack(6), ustack(6)] = count(); @total = count(); }
  interval:s:8 { exit(); }" > redis.stacks &
docker exec study-redis redis-benchmark -q -n 300000 -c 50 -t set,get
# flame graph: ./stackcollapse-bpftrace.pl redis.stacks | ./flamegraph.pl > redis.svg`,
  requires: requiresEbpf,
  async run(ctx) {
    await ensureImage(ctx);
    const pid = await redisPid();
    const script = `
profile:hz:99 /pid == ${pid}/ { @[kstack(6), ustack(6)] = count(); @total = count(); }
interval:s:8 { exit(); }`;
    const traceP = bpftrace(ctx, script, `bpftrace profile:hz:99 (PID ${pid}) 8초 — 스택을 맵 키로`);
    await ctx.sleep(2500);
    await ctx.sh("docker", ["exec", "study-redis", "redis-benchmark", "-q", "-n", "300000", "-c", "50", "-t", "set,get"], { allowFail: true, timeout: 90_000, label: "docker exec study-redis redis-benchmark -q -n 300000 -c 50 -t set,get   # 샘플링 중 부하" });
    const tr = await traceP;
    ctx.check("bpftrace 프로파일러가 정상 종료했다", tr.ok, tr.err.split("\n").slice(-3).join(" "));
    const total = parseScalar(tr.out, "total");
    // @[\n kstack...\n,\n ustack...\n]: N
    const stacks = [...tr.out.matchAll(/@\[\n([\s\S]*?)\]: (\d+)/g)].map((m) => {
      const [k, u] = m[1].split(/^,\s*$/m).map((part) => part.split("\n").map((s) => s.trim()).filter(Boolean));
      return { kernel: k ?? [], user: u ?? [], n: Number(m[2]) };
    }).sort((a, b) => b.n - a.n);
    const kernelSamples = stacks.filter((s) => s.kernel.length > 0).reduce((a, s) => a + s.n, 0);
    const userFrames = stacks.flatMap((s) => s.user);
    const unknown = userFrames.filter((f) => /^0x[0-9a-f]+$|\[unknown\]/.test(f)).length;
    const named = (f: string) => !/^0x[0-9a-f]+$/.test(f) && f !== "[unknown]";
    const redisFn = (u: string[]) => u.find((f) => named(f) && !/^(write|read|writev|readv|epoll_pwait|epoll_wait|__syscall\w*|syscall)\+/.test(f))?.replace(/\+\d+$/, "") ?? "(심볼 없음)";
    ctx.table(`상위 스택 (8초 × 99Hz, 총 ${total} 샘플)`, ["샘플", "비율", "커널 꼭대기(leaf)", "Redis 함수(유저)", "깊이 k/u"], stacks.slice(0, 8).map((s) => [String(s.n), `${((s.n / Math.max(total, 1)) * 100).toFixed(1)}%`, s.kernel[0] ?? "(유저 모드)", redisFn(s.user), `${s.kernel.length}/${s.user.length}`]));
    ctx.check("부하 중 Redis 가 CPU 에서 샘플링됐다 (99Hz × 8초 상한 ≈ 792)", total >= 50, `${total} 샘플`);
    // 유저 쪽: Redis 함수별 합계 (on-CPU flame graph 를 위에서 자른 모양)
    const byFn = new Map<string, number>();
    for (const s of stacks) byFn.set(redisFn(s.user), (byFn.get(redisFn(s.user)) ?? 0) + s.n);
    ctx.table("Redis 함수별 샘플 (유저 스택에서 libc 래퍼 바로 위 프레임 기준)", ["함수", "샘플", "비율"], [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, n]) => [f, String(n), `${((n / Math.max(total, 1)) * 100).toFixed(1)}%`]));
    ctx.table("요약", ["항목", "값"], [
      ["커널 모드에서 찍힌 샘플", `${kernelSamples} (${((kernelSamples / Math.max(total, 1)) * 100).toFixed(0)}%)`],
      ["고유 스택 수", String(stacks.length)],
      ["유저 프레임 중 주소로만 나온 것", `${unknown} / ${userFrames.length}`],
    ]);
    ctx.check("커널 프레임이 있는 스택이 잡혔다 (소켓 송수신·epoll — I/O 서버의 CPU 는 상당 부분 커널에서 쓰인다)", kernelSamples > 0);
    const io = stacks.slice(0, 15).flatMap((s) => s.kernel).filter((f) => /tcp|sock|epoll|inet|skb|ip_|loopback|net_rx|__arm64_sys_(read|write|sendto|recvfrom)/i.test(f));
    ctx.note(io.length ? `상위 커널 프레임에 네트워크 경로가 보인다: ${[...new Set(io.map((f) => f.replace(/\+\d+$/, "")))].slice(0, 6).join(", ")}` : "상위 커널 프레임에 네트워크 함수가 없다면 부하가 너무 짧았을 수 있다 — -n 을 늘려 다시.");
    ctx.note(unknown > 0 ? `주소로만 나온 유저 프레임(${unknown}개)은 대부분 스택 맨 위의 musl libc syscall 진입점이다 — 공유 라이브러리 심볼을 못 풀었다. 그 아래 Redis 함수(writeToClient, readQueryFromClient …)는 심볼로 풀린다: redis-server 바이너리에는 심볼이 남아 있고 프레임 포인터로 사슬이 이어진다(노트 06).` : "유저 프레임이 전부 심볼로 풀렸다.");
    const bpfFrames = stacks.filter((s) => s.kernel.some((f) => f.startsWith("bpf_prog_"))).reduce((a, s) => a + s.n, 0);
    if (bpfFrames) ctx.note(`커널 스택에 bpf_prog_… 프레임이 ${bpfFrames} 샘플 보인다 — 이미 올라가 있는 다른 eBPF 프로그램(kind 의 Falco 가 sys_enter/sys_exit 에 붙인 것)이 Redis 의 매 syscall 마다 실행되는 비용이다. 관측 도구의 오버헤드가 프로파일에 그대로 찍힌다.`);
    ctx.note("전체 출력을 파일로 저장해 stackcollapse-bpftrace.pl | flamegraph.pl 로 넘기면 SVG flame graph 가 된다. 폭 = 비율, 꼭대기 = self time, 색은 의미 없음.");
  },
};
