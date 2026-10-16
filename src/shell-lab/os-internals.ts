import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

/**
 * 운영체제 내부 실험. macOS 에는 Linux 커널이 없으므로 Docker Desktop 의 Linux VM 안에서 돈다.
 * 특권 컨테이너는 그 VM 의 커널을 직접 만진다 — study-redis 는 멈추거나 재시작하지 않는다.
 */
const TOOLS = "study-os-tools:local";
const TOOLS_DOCKERFILE = `FROM alpine:3.20
RUN apk add --no-cache perf util-linux coreutils procps >/dev/null
`;

async function requiresDocker(): Promise<string | null> {
  const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 6000 });
  return d.ok ? null : "Docker 데몬이 필요합니다 (실험은 Docker Desktop 의 Linux VM 커널에서 돈다).";
}

async function ensureTools(ctx: ShellCtx) {
  if ((await exec("docker", ["image", "inspect", TOOLS], { timeout: 10_000 })).ok) {
    ctx.note(`도구 이미지 ${TOOLS} 재사용 (alpine + perf, util-linux, coreutils, procps)`);
    return;
  }
  await ctx.sh("docker", ["build", "-q", "-t", TOOLS, "-"], { input: TOOLS_DOCKERFILE, timeout: 600_000, label: `docker build -t ${TOOLS} -   # alpine + perf·taskset·coreutils dd (첫 실행만, 수십 초)` });
}

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

// ---------------------------------------------------------------- 1. 컨텍스트 스위치
function parsePerfPipe(out: string): number {
  const m = out.match(/([\d.]+)\s+usecs\/op/);
  return m ? Number(m[1]) : NaN;
}

async function redisSwitches(): Promise<{ voluntary: number; involuntary: number; threads: number }> {
  const pid = Number((await exec("docker", ["inspect", "-f", "{{.State.Pid}}", "study-redis"])).out);
  // 모든 스레드의 합 (Redis 는 메인 스레드 + bio/io 스레드)
  const r = await exec("docker", ["run", "--rm", "--pid=host", "--privileged", "alpine:3.20", "sh", "-c", `cat /proc/${pid}/task/*/status | grep ctxt_switches`], { timeout: 30_000 });
  let voluntary = 0;
  let involuntary = 0;
  let threads = 0;
  for (const l of r.out.split("\n")) {
    const m = l.match(/^(voluntary|nonvoluntary)_ctxt_switches:\s+(\d+)/);
    if (!m) continue;
    if (m[1] === "voluntary") {
      voluntary += Number(m[2]);
      threads++;
    } else involuntary += Number(m[2]);
  }
  return { voluntary, involuntary, threads };
}

export const osContextSwitch: ShellExperiment = {
  id: "os-context-switch",
  subject: "os-internals",
  title: "컨텍스트 스위치의 값: 파이프 핑퐁으로 한 번의 비용을 재고, Redis 가 요청 하나에 몇 번 잠드는지 센다",
  category: "프로세스·스케줄링",
  summary: "perf bench sched pipe 로 두 프로세스가 파이프로 메시지를 주고받을 때 왕복 1회 비용을 잰다(CPU 를 넘나들 때 / 한 CPU 에 고정했을 때 / 스레드끼리). 이어서 study-redis 의 모든 스레드의 voluntary·nonvoluntary 컨텍스트 스위치를 /proc 에서 읽고 redis-benchmark 전후 차이로 '요청당 스위치 수' 를 구한다. 파이프라이닝(-P 16)이 스위치를 얼마나 줄이는지도",
  notes: ["01-processes-threads-context-switch", "05-syscalls-interrupts"],
  description: `
컨텍스트 스위치는 CPU 가 실행하던 태스크의 레지스터·스택 포인터·주소 공간을 저장하고 다른 태스크로 바꾸는 일이다. 직접 비용은 1~수 µs 지만, 진짜 비용은 **캐시·TLB 가 식는 것**과 **깨어나 다시 스케줄될 때까지의 대기**다.
\`perf bench sched pipe\` 는 두 태스크가 파이프로 1바이트를 주고받게 해 "쓰기 → 상대 깨우기 → 내가 잠들기" 를 반복한다. 왕복 하나에 스위치가 두 번 들어 있다.
- 두 태스크가 **다른 CPU** 에 있으면 깨우기에 CPU 간 인터럽트(IPI)와 유휴 CPU 깨움이 섞인다.
- **한 CPU 에 고정**(taskset)하면 순수 스위치 비용에 가깝다.
- **스레드**(-T)끼리는 주소 공간이 같아 TLB 를 비울 필요가 없다.
그리고 서버 쪽: Redis 는 요청이 없으면 \`epoll_wait\` 로 잠든다(voluntary 스위치). 요청이 오면 깨어나 처리한다. 클라이언트가 한 번에 하나씩 보내면 요청마다 잠들고 깨고, 파이프라인으로 묶어 보내면 한 번 깨서 여러 개를 처리한다.
`,
  code: `docker run --rm --privileged study-os-tools:local perf bench sched pipe -l 100000            # CPU 를 넘나드는 왕복
docker run --rm --privileged study-os-tools:local taskset -c 0 perf bench sched pipe -l 100000  # 한 CPU 고정
docker run --rm --privileged study-os-tools:local perf bench sched pipe -T -l 100000         # 스레드끼리
PID=$(docker inspect -f '{{.State.Pid}}' study-redis)
docker run --rm --pid=host alpine cat /proc/$PID/task/*/status | grep ctxt_switches
docker exec study-redis redis-benchmark -q -n 50000 -c 50 -t get        # 그리고 다시 /proc 확인`,
  requires: async () => {
    const d = await requiresDocker();
    if (d) return d;
    const r = await exec("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"], { timeout: 6000 });
    return r.ok && r.out === "running" ? null : "관측 대상 study-redis 가 실행 중이어야 합니다 (`pnpm redis:docker`).";
  },
  async run(ctx) {
    await ensureTools(ctx);
    const loops = "100000";
    const cross = await ctx.sh("docker", ["run", "--rm", "--privileged", "--name", "lab-os-perf", TOOLS, "perf", "bench", "sched", "pipe", "-l", loops], { timeout: 120_000, label: `perf bench sched pipe -l ${loops}   # 두 프로세스, 스케줄러가 CPU 를 고름` });
    const pinned = await ctx.sh("docker", ["run", "--rm", "--privileged", "--name", "lab-os-perf", TOOLS, "taskset", "-c", "0", "perf", "bench", "sched", "pipe", "-l", loops], { timeout: 120_000, label: `taskset -c 0 perf bench sched pipe -l ${loops}   # 둘 다 CPU 0 에 고정` });
    const threads = await ctx.sh("docker", ["run", "--rm", "--privileged", "--name", "lab-os-perf", TOOLS, "taskset", "-c", "0", "perf", "bench", "sched", "pipe", "-T", "-l", loops], { timeout: 120_000, label: `taskset -c 0 perf bench sched pipe -T -l ${loops}   # 스레드 둘 (주소 공간 공유)` });
    const rows: [string, number][] = [
      ["프로세스 ↔ 프로세스, CPU 자유", parsePerfPipe(cross.out)],
      ["프로세스 ↔ 프로세스, CPU 0 고정", parsePerfPipe(pinned.out)],
      ["스레드 ↔ 스레드, CPU 0 고정", parsePerfPipe(threads.out)],
    ];
    ctx.table("파이프 왕복 1회 비용 (왕복 = 쓰기·깨우기·잠들기 ×2, 스위치 2번)", ["경우", "µs/왕복", "스위치 1번 ≈ µs", "초당 왕복"], rows.map(([k, us]) => [k, fmt(us, 2), fmt(us / 2, 2), fmt(1e6 / us)]));
    ctx.check("perf bench 로 세 경우 모두 측정했다", rows.every(([, v]) => Number.isFinite(v) && v > 0));
    const [, crossUs] = rows[0];
    const [, pinUs] = rows[1];
    ctx.note(pinUs < crossUs ? `한 CPU 에 고정하면 ${fmt(crossUs / pinUs, 1)}배 빠르다. CPU 를 넘나드는 깨우기는 IPI·유휴 CPU 깨움·캐시 이동 비용이 더해진다 — 스레드 수를 코어보다 많이 늘릴 때의 숨은 비용.` : `이 VM 에선 CPU 고정 효과가 작다(${fmt(crossUs, 1)} vs ${fmt(pinUs, 1)} µs). 가상 CPU 스케줄링(하이퍼바이저)이 사이에 끼어 있기 때문일 수 있다.`);

    const before = await redisSwitches();
    ctx.note(`study-redis 스레드 ${before.threads}개의 누적 스위치: voluntary ${fmt(before.voluntary)}, nonvoluntary ${fmt(before.involuntary)}`);
    const N = 50000;
    await ctx.sh("docker", ["exec", "study-redis", "redis-benchmark", "-q", "-n", String(N), "-c", "50", "-t", "get"], { timeout: 120_000, label: `redis-benchmark -n ${N} -c 50 -t get   # 요청 하나씩 (파이프라인 없음)` });
    const mid = await redisSwitches();
    await ctx.sh("docker", ["exec", "study-redis", "redis-benchmark", "-q", "-n", String(N), "-c", "50", "-P", "16", "-t", "get"], { timeout: 120_000, label: `redis-benchmark -n ${N} -c 50 -P 16 -t get   # 16개씩 파이프라인` });
    const after = await redisSwitches();
    const d1 = { v: mid.voluntary - before.voluntary, i: mid.involuntary - before.involuntary };
    const d2 = { v: after.voluntary - mid.voluntary, i: after.involuntary - mid.involuntary };
    ctx.table(`Redis 의 컨텍스트 스위치 (GET ${fmt(N)}개 처리하는 동안 증가분, 전 스레드 합)`, ["클라이언트", "voluntary (스스로 잠듦)", "nonvoluntary (선점당함)", "요청 1,000개당 voluntary"], [
      ["파이프라인 없음 (-P 1)", fmt(d1.v), fmt(d1.i), fmt((d1.v / N) * 1000, 1)],
      ["파이프라인 16 (-P 16)", fmt(d2.v), fmt(d2.i), fmt((d2.v / N) * 1000, 1)],
    ]);
    ctx.check("부하 중 Redis 의 voluntary 스위치가 증가했다 (epoll_wait 로 잠들고 깨기)", d1.v > 0);
    ctx.check("파이프라인을 쓰면 같은 요청 수에 스위치가 줄어든다 (한 번 깨서 여러 개 처리)", d2.v < d1.v, `${fmt(d1.v)} → ${fmt(d2.v)}`);
    ctx.note("voluntary 가 대부분이고 nonvoluntary(선점)가 적다면 CPU 경쟁이 아니라 I/O 대기로 잠드는 것 — 이벤트 루프 서버의 정상 패턴이다. nonvoluntary 가 늘면 CPU 가 모자라 스케줄러가 빼앗는 중이다(컨테이너 CPU 제한이나 이웃 프로세스).");
  },
};

// ---------------------------------------------------------------- 2. 페이지 캐시
const PC_VOLUME = "lab-os-pagecache";

function ddSeconds(out: string): { secs: number; rate: string } {
  // coreutils dd: "268435456 bytes (268 MB, 256 MiB) copied, 0.123 s, 2.2 GB/s"
  const m = out.match(/copied,\s+([\d.]+)\s*s,\s+([\d.]+\s*\S+)/);
  return m ? { secs: Number(m[1]), rate: m[2] } : { secs: NaN, rate: "?" };
}

function meminfo(out: string, key: string): number {
  const m = out.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
  return m ? Number(m[1]) / 1024 : NaN; // MiB
}

export const osPageCache: ShellExperiment = {
  id: "os-page-cache",
  subject: "os-internals",
  title: "페이지 캐시: 같은 파일을 두 번 읽으면 왜 수십 배 빠른가 — 쓰기는 Dirty 로 쌓였다가 내려가고, drop_caches 후엔 다시 디스크다",
  category: "메모리·I/O",
  summary: "Docker VM 안 볼륨(ext4)에 256MiB 파일을 쓰며 /proc/meminfo 의 Dirty·Cached 변화를 보고, sync 로 내려간 뒤 drop_caches 로 캐시를 비운 상태의 첫 읽기(디스크) vs 두 번째 읽기(메모리) 처리량을 dd 로 잰다. O_DIRECT 로 캐시를 우회한 읽기도 비교한다",
  notes: ["02-virtual-memory-page-cache", "04-filesystem-io"],
  description: `
리눅스는 남는 메모리를 **페이지 캐시**로 쓴다. 파일을 읽으면 그 페이지가 메모리에 남고, 다음 읽기는 디스크에 가지 않는다. 그래서 \`free\` 의 "used" 가 커 보여도 대부분은 언제든 비울 수 있는 캐시다(available 을 보라).
쓰기도 캐시를 거친다. \`write()\` 는 페이지 캐시에 쓰고 **Dirty** 로 표시한 뒤 바로 반환하고, 커널 플러셔가 나중에(dirty_expire, dirty_ratio) 디스크로 내린다. \`fsync\`/\`sync\` 는 그걸 기다리게 하는 호출이다 — DB 커밋이 비싼 이유([DB 내부 노트](/db-internals/notes/04-wal-checkpoint-recovery)).
\`echo 3 > /proc/sys/vm/drop_caches\` 는 깨끗한 캐시를 버린다(특권 필요, **VM 전체**에 영향 — 다른 컨테이너의 파일 캐시도 잠깐 식는다. Redis 데이터는 프로세스 메모리라 영향 없음). O_DIRECT 는 캐시를 아예 거치지 않는 읽기로, 자체 버퍼 풀을 가진 DB 가 이중 캐싱을 피하려 쓴다.
`,
  code: `docker volume create lab-os-pagecache
docker run --rm --privileged -v lab-os-pagecache:/data study-os-tools:local sh -c '
  dd if=/dev/urandom of=/data/f bs=1M count=256; grep -E "^(Dirty|Cached)" /proc/meminfo
  sync; echo 3 > /proc/sys/vm/drop_caches
  dd if=/data/f of=/dev/null bs=1M               # 첫 읽기: 디스크
  dd if=/data/f of=/dev/null bs=1M               # 두 번째: 페이지 캐시
  dd if=/data/f of=/dev/null bs=1M iflag=direct  # O_DIRECT: 캐시 우회'`,
  requires: requiresDocker,
  cleanup: async (ctx) => {
    await ctx.sh("docker", ["rm", "-f", "lab-os-pc"], { allowFail: true, label: "docker rm -f lab-os-pc" });
    await ctx.sh("docker", ["volume", "rm", "-f", PC_VOLUME], { allowFail: true, label: `docker volume rm ${PC_VOLUME}` });
  },
  async run(ctx) {
    await ensureTools(ctx);
    await ctx.sh("docker", ["volume", "create", PC_VOLUME], { label: `docker volume create ${PC_VOLUME}   # VM 의 ext4 위 (overlayfs 는 O_DIRECT 미지원)` });
    const S = "@@";
    const script = [
      `M() { echo "${S}$1"; grep -E '^(MemFree|Cached|Dirty|Writeback):' /proc/meminfo; }`,
      "M start",
      "dd if=/dev/urandom of=/data/f bs=1M count=256 2>/dev/null",
      "M after_write",
      "sync",
      "M after_sync",
      "echo 3 > /proc/sys/vm/drop_caches",
      "M after_drop",
      `echo "${S}cold"; dd if=/data/f of=/dev/null bs=1M 2>&1 | tail -1`,
      "M after_cold",
      `echo "${S}warm"; dd if=/data/f of=/dev/null bs=1M 2>&1 | tail -1`,
      `echo "${S}direct"; dd if=/data/f of=/dev/null bs=1M iflag=direct 2>&1 | tail -1`,
      // 4KiB 단위: 요청당 비용이 드러난다 (앞 64MiB 만)
      "echo 3 > /proc/sys/vm/drop_caches",
      `echo "${S}cold4k"; dd if=/data/f of=/dev/null bs=4k count=16384 2>&1 | tail -1`,
      `echo "${S}warm4k"; dd if=/data/f of=/dev/null bs=4k count=16384 2>&1 | tail -1`,
      `echo "${S}direct4k"; dd if=/data/f of=/dev/null bs=4k count=16384 iflag=direct 2>&1 | tail -1`,
      `echo "${S}ra"; blockdev --getra "$(df /data | tail -1 | cut -d' ' -f1)" 2>/dev/null || echo "?"`,
      "rm -f /data/f",
    ].join("\n");
    const r = await ctx.sh("docker", ["run", "--rm", "--privileged", "--name", "lab-os-pc", "-v", `${PC_VOLUME}:/data`, TOOLS, "sh", "-c", script], { timeout: 180_000, label: "쓰기 → sync → drop_caches → 첫 읽기 → 두 번째 읽기 → O_DIRECT (256 MiB, 특권 컨테이너)" });
    const sec = (name: string) => r.out.split(`${S}${name}\n`)[1]?.split(S)[0] ?? "";
    const phases = ["start", "after_write", "after_sync", "after_drop", "after_cold"];
    ctx.table("/proc/meminfo (MiB, VM 전체)", ["시점", "Cached", "Dirty", "Writeback", "MemFree"], phases.map((p) => {
      const t = sec(p);
      return [p.replace("after_", "").replace("start", "시작").replace("write", "256MiB 쓴 직후").replace("sync", "sync 후").replace("drop", "drop_caches 후").replace("cold", "첫 읽기 후"), fmt(meminfo(t, "Cached")), fmt(meminfo(t, "Dirty")), fmt(meminfo(t, "Writeback")), fmt(meminfo(t, "MemFree"))];
    }));
    const dirtyAfterWrite = meminfo(sec("after_write"), "Dirty");
    const dirtyAfterSync = meminfo(sec("after_sync"), "Dirty");
    const cachedDrop = meminfo(sec("after_drop"), "Cached");
    const cachedCold = meminfo(sec("after_cold"), "Cached");
    const label: Record<string, string> = { cold: "1MiB 블록, 첫 읽기 (drop_caches 직후)", warm: "1MiB 블록, 두 번째 (페이지 캐시)", direct: "1MiB 블록, O_DIRECT (캐시 우회)", cold4k: "4KiB 블록, 첫 읽기 (drop_caches 직후)", warm4k: "4KiB 블록, 두 번째 (페이지 캐시)", direct4k: "4KiB 블록, O_DIRECT (캐시 우회)" };
    const reads = (["cold", "warm", "direct", "cold4k", "warm4k", "direct4k"] as const).map((k) => ({ k, ...ddSeconds(sec(k)) }));
    const bytes = (k: string) => (k.endsWith("4k") ? 64 : 256) * 1048576;
    const reqs = (k: string) => (k.endsWith("4k") ? 16384 : 256);
    ctx.table("순차 읽기 (dd). 블록이 작을수록 요청 하나의 고정 비용이 드러난다", ["읽기", "크기", "시간(s)", "처리량", "요청당 µs"], reads.map((x) => [label[x.k], `${bytes(x.k) / 1048576} MiB`, fmt(x.secs, 3), x.rate, fmt((x.secs * 1e6) / reqs(x.k), 1)]));
    const r4 = Object.fromEntries(reads.map((x) => [x.k, x.secs]));
    ctx.check("쓰기 직후 Dirty 가 크게 늘고 sync 후 줄어든다 (write 는 캐시에 쓰고 바로 반환)", dirtyAfterWrite > dirtyAfterSync + 50, `${fmt(dirtyAfterWrite)} → ${fmt(dirtyAfterSync)} MiB`);
    ctx.check("첫 읽기 후 Cached 가 파일 크기만큼 늘었다", cachedCold - cachedDrop > 200, `+${fmt(cachedCold - cachedDrop)} MiB`);
    ctx.check("4KiB 읽기: 페이지 캐시가 첫 읽기보다 빠르다", r4.warm4k < r4.cold4k, `${fmt(r4.cold4k, 3)}s → ${fmt(r4.warm4k, 3)}s (${fmt(r4.cold4k / r4.warm4k, 1)}배)`);
    ctx.check("4KiB O_DIRECT 는 캐시보다 몇 배 느리다 (요청마다 장치까지 왕복)", r4.direct4k > r4.warm4k * 3, `${fmt(r4.direct4k / r4.warm4k, 0)}배`);
    ctx.note(`첫 4KiB 읽기가 생각보다 빠른 이유는 readahead(${sec("ra").trim() || "?"} 섹터 = ${Number(sec("ra").trim()) ? Number(sec("ra").trim()) / 2 : "?"} KiB)다. 커널이 순차 접근을 감지하고 미리 큰 덩어리로 읽어 둔다. O_DIRECT 는 readahead 도 캐시도 없으니 4KiB 마다 가상 디스크까지 왕복 — 요청당 ${fmt((r4.direct4k * 1e6) / 16384, 0)} µs.`);
    ctx.note("1MiB 블록에선 O_DIRECT 가 캐시보다 빠르게 나오기도 한다: 큰 요청 하나의 고정 비용이 작아지고, 버퍼 읽기는 페이지 캐시 → 유저 버퍼 복사(memcpy)를 한 번 더 하기 때문이다. 자체 버퍼 풀을 가진 DB(InnoDB)가 O_DIRECT 를 쓰는 이유, PostgreSQL 이 shared_buffers 를 메모리의 25% 정도로 두고 나머지를 OS 캐시에 맡기는 이유가 이 트레이드오프다.");
    ctx.note("Docker Desktop 의 '디스크' 는 macOS 파일 위의 가상 디스크라, 첫 읽기도 호스트 페이지 캐시 덕에 꽤 빠를 수 있다. 실제 서버의 NVMe/EBS 에선 차이가 더 크다.");
  },
};

// ---------------------------------------------------------------- 3. cgroup 제한
async function cat(container: string, file: string): Promise<string> {
  return (await exec("docker", ["exec", container, "cat", `/sys/fs/cgroup/${file}`], { timeout: 10_000 })).out;
}

function kv(text: string): Record<string, number> {
  const o: Record<string, number> = {};
  for (const l of text.split("\n")) {
    const [k, v] = l.trim().split(/\s+/);
    if (k && v !== undefined) o[k] = Number(v);
  }
  return o;
}

export const osCgroupLimits: ShellExperiment = {
  id: "os-cgroup-limits",
  subject: "os-internals",
  title: "cgroup 제한이 하는 일: --cpus=0.5 는 100ms 마다 50ms 만 주고 나머지는 멈춘다, --memory=64m 을 넘으면 커널이 죽인다",
  category: "cgroup",
  summary: "CPU 를 계속 쓰는 컨테이너를 --cpus=0.5 로 띄워 cgroup v2 의 cpu.max(50000 100000)와 cpu.stat 의 nr_throttled·throttled_usec 증가를 5초간 관찰하고, --memory=64m 컨테이너 안에서 200MiB 를 잡는 프로세스가 OOM 킬러에 exit 137 로 죽는 것과 memory.events 의 oom_kill 증가를 확인한다. 제한이 없는 study-redis 의 cgroup 값도 비교한다",
  notes: ["03-scheduler-cgroups", "02-virtual-memory-page-cache"],
  description: `
컨테이너의 CPU·메모리 제한은 커널의 **cgroup v2** 다. Docker·Kubernetes 는 숫자를 cgroup 파일에 써 줄 뿐이다.
- **CPU**: \`--cpus=0.5\` 는 \`cpu.max = 50000 100000\` — 100ms 주기(period)마다 50ms 쿼터. 쿼터를 다 쓰면 그 주기가 끝날 때까지 **스로틀(정지)** 된다. 평균 사용률이 낮아도 순간 버스트가 쿼터를 넘으면 지연이 튀는 이유([성능 06](/performance/notes/06-system-level)). Kubernetes 의 CPU limits 가 정확히 이것이다.
- **메모리**: \`--memory=64m\` 은 \`memory.max = 67108864\`. 넘으면 먼저 페이지 캐시를 회수하고, 그래도 모자라면 cgroup 안의 프로세스 하나를 **OOM 킬러**가 SIGKILL 한다(exit 137). Kubernetes 의 OOMKilled 가 이것이다.
\`memory.events\` 와 \`cpu.stat\` 은 이 일이 몇 번 일어났는지 세는 계기판이다 — cAdvisor/kubelet 이 \`container_cpu_cfs_throttled_periods_total\` 같은 메트릭으로 내보낸다.
`,
  code: `docker run -d --name lab-os-cpu --cpus=0.5 alpine sh -c 'while :; do :; done'
docker exec lab-os-cpu cat /sys/fs/cgroup/cpu.max      # 50000 100000
docker exec lab-os-cpu cat /sys/fs/cgroup/cpu.stat     # nr_periods, nr_throttled, throttled_usec
docker run -d --name lab-os-mem --memory=64m --memory-swap=64m alpine sleep 300
docker exec lab-os-mem sh -c 'head -c 200m /dev/zero | tail'   # exit 137
docker exec lab-os-mem cat /sys/fs/cgroup/memory.events         # oom_kill 1`,
  requires: requiresDocker,
  cleanup: async (ctx) => {
    await ctx.sh("docker", ["rm", "-f", "lab-os-cpu", "lab-os-mem"], { allowFail: true, label: "docker rm -f lab-os-cpu lab-os-mem" });
  },
  async run(ctx) {
    await ctx.sh("docker", ["rm", "-f", "lab-os-cpu", "lab-os-mem"], { allowFail: true, label: "이전 실행 정리" });
    // CPU
    await ctx.sh("docker", ["run", "-d", "--name", "lab-os-cpu", "--cpus=0.5", "alpine:3.20", "sh", "-c", "while :; do :; done"], { label: "docker run -d --name lab-os-cpu --cpus=0.5 alpine sh -c 'while :; do :; done'   # CPU 를 100% 쓰려는 프로세스" });
    await ctx.sleep(1000);
    const cpuMax = (await cat("lab-os-cpu", "cpu.max")).trim();
    const s1 = kv(await cat("lab-os-cpu", "cpu.stat"));
    const t0 = performance.now();
    await ctx.sleep(5000);
    const s2 = kv(await cat("lab-os-cpu", "cpu.stat"));
    const wallUs = (performance.now() - t0) * 1000;
    const periods = s2.nr_periods - s1.nr_periods;
    const throttled = s2.nr_throttled - s1.nr_throttled;
    const usage = s2.usage_usec - s1.usage_usec;
    const thrUs = s2.throttled_usec - s1.throttled_usec;
    ctx.table(`lab-os-cpu (--cpus=0.5) 의 5초간 cpu.stat 증가분, cpu.max = "${cpuMax}"`, ["항목", "값", "해석"], [
      ["nr_periods", fmt(periods), "100ms 주기 수 (5초 ≈ 50)"],
      ["nr_throttled", fmt(throttled), "쿼터를 다 써서 멈춘 주기 수"],
      ["스로틀 비율", `${fmt((throttled / Math.max(periods, 1)) * 100)}%`, "거의 모든 주기에서 멈춘다"],
      ["usage_usec", `${fmt(usage / 1000)} ms`, `벽시계 ${fmt(wallUs / 1000)} ms 중 실제 CPU 사용 → ${fmt((usage / wallUs) * 100)}%`],
      ["throttled_usec", `${fmt(thrUs / 1000)} ms`, "멈춰서 기다린 시간"],
    ]);
    ctx.check("cpu.max 가 50000 100000 (100ms 마다 50ms)", cpuMax === "50000 100000", cpuMax);
    ctx.check("무한 루프는 거의 모든 주기에서 스로틀된다", periods > 20 && throttled / periods > 0.8, `${throttled}/${periods}`);
    ctx.check("실제 CPU 사용률이 50% 근처로 묶인다", usage / wallUs > 0.4 && usage / wallUs < 0.6, `${fmt((usage / wallUs) * 100)}%`);
    await ctx.sh("docker", ["rm", "-f", "lab-os-cpu"], { allowFail: true, label: "docker rm -f lab-os-cpu" });

    // 메모리
    await ctx.sh("docker", ["run", "-d", "--name", "lab-os-mem", "--memory=64m", "--memory-swap=64m", "alpine:3.20", "sleep", "300"], { label: "docker run -d --name lab-os-mem --memory=64m --memory-swap=64m alpine sleep 300" });
    await ctx.sleep(500);
    const memMax = (await cat("lab-os-mem", "memory.max")).trim();
    const ev1 = kv(await cat("lab-os-mem", "memory.events"));
    const hog = await ctx.sh("docker", ["exec", "lab-os-mem", "sh", "-c", "head -c 200m /dev/zero | tail"], { allowFail: true, timeout: 60_000, label: "docker exec lab-os-mem sh -c 'head -c 200m /dev/zero | tail'   # tail 이 줄바꿈 없는 200MiB 를 메모리에 쌓는다" });
    const ev2 = kv(await cat("lab-os-mem", "memory.events"));
    const peak = (await cat("lab-os-mem", "memory.peak")).trim();
    const alive = (await exec("docker", ["inspect", "-f", "{{.State.Status}} oomkilled={{.State.OOMKilled}}", "lab-os-mem"])).out;
    ctx.table(`lab-os-mem (--memory=64m), memory.max = ${memMax}`, ["항목", "값"], [
      ["메모리 먹는 프로세스의 종료 코드", `${hog.code} ${hog.code === 137 ? "(128 + 9 = SIGKILL)" : ""}`],
      ["memory.events oom (한도 도달)", `${ev1.oom ?? 0} → ${ev2.oom ?? 0}`],
      ["memory.events oom_kill (킬러가 죽인 수)", `${ev1.oom_kill ?? 0} → ${ev2.oom_kill ?? 0}`],
      ["memory.events max (한도에 부딪친 횟수)", `${ev1.max ?? 0} → ${ev2.max ?? 0}`],
      ["memory.peak", `${fmt(Number(peak) / 1048576, 1)} MiB`],
      ["컨테이너 상태", alive],
    ]);
    ctx.check("memory.max 가 64MiB(67108864)", memMax === "67108864", memMax);
    ctx.check("한도를 넘긴 프로세스가 SIGKILL 로 죽었다 (exit 137)", hog.code === 137, `exit=${hog.code}`);
    ctx.check("memory.events 의 oom_kill 이 증가했다", (ev2.oom_kill ?? 0) > (ev1.oom_kill ?? 0));
    ctx.note("컨테이너의 PID 1(sleep)은 살아 있다 — OOM 킬러는 cgroup 안에서 가장 '나쁜'(메모리를 많이 쓰는) 프로세스 하나를 고른다. Kubernetes 에서 메인 프로세스가 죽으면 OOMKilled 로 재시작된다.");

    // 제한 없는 study-redis
    const redisRunning = (await exec("docker", ["inspect", "-f", "{{.State.Status}}", "study-redis"])).out === "running";
    if (redisRunning) {
      const rCpu = (await cat("study-redis", "cpu.max")).trim();
      const rMem = (await cat("study-redis", "memory.max")).trim();
      const rCur = Number((await cat("study-redis", "memory.current")).trim());
      ctx.table("비교: 제한 없이 띄운 study-redis 의 cgroup", ["파일", "값"], [
        ["cpu.max", rCpu],
        ["memory.max", rMem],
        ["memory.current", `${fmt(rCur / 1048576, 1)} MiB (프로세스 메모리 + 이 cgroup 이 만든 페이지 캐시)`],
      ]);
      ctx.note(`"max" 는 무제한이다. 제한이 없으면 Redis 가 VM 메모리를 다 쓸 때까지 아무도 막지 않는다 — 운영에서는 Redis 의 maxmemory 와 컨테이너 memory 한도를 함께(한도의 70~80% 를 maxmemory) 둔다.`);
    }
    await ctx.sh("docker", ["rm", "-f", "lab-os-mem"], { allowFail: true, label: "docker rm -f lab-os-mem" });
  },
};
