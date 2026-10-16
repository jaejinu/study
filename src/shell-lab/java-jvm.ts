import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { armDeadman } from "@/lib/deadman";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

/**
 * Java 4~6부(JVM 내부·GC·컨테이너) 실험. 로컬에 JDK 가 없어도 되도록 Docker 의 eclipse-temurin:21-jdk 로
 * javac/java 를 돌린다. 소스는 os.tmpdir() 아래 임시 디렉터리에 쓰고 /w 로 마운트한다(끝나면 삭제).
 * CPU·메모리를 고정(--cpus, --memory)해 측정이 Docker Desktop 의 다른 컨테이너 영향을 덜 받게 한다.
 */

const JDK = "eclipse-temurin:21-jdk";

async function requiresJdk(): Promise<string | null> {
  const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 8000 });
  if (!d.ok) return "Docker 데몬이 필요합니다. 이 실험은 Docker 의 eclipse-temurin:21-jdk 로 javac/java 를 실행합니다.";
  return null;
}

async function ensureJdk(ctx: ShellCtx) {
  if ((await exec("docker", ["image", "inspect", JDK], { timeout: 10_000 })).ok) return;
  await ctx.sh("docker", ["pull", "-q", JDK], { timeout: 600_000, label: `docker pull ${JDK}   # 첫 실행만 (약 200MB)` });
}

async function workdir(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lab-java-"));
  for (const [name, src] of Object.entries(files)) await fs.writeFile(path.join(dir, name), src);
  return dir;
}

/** JDK 컨테이너에서 셸 명령 실행 (임시 디렉터리를 /w 로) */
function jdk(ctx: ShellCtx, dir: string, cmd: string, opts: { label: string; docker?: string[]; timeout?: number; allowFail?: boolean; name?: string }) {
  const args = ["run", "--rm", ...(opts.name ? ["--name", opts.name] : []), ...(opts.docker ?? []), "-v", `${dir}:/w`, "-w", "/w", JDK, "sh", "-c", cmd];
  return ctx.sh("docker", args, { label: opts.label, timeout: opts.timeout ?? 180_000, allowFail: opts.allowFail });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0;
};

// ---------------------------------------------------------------- 1. JIT 워밍업
const WARMUP = `public class Warmup {
    static int work(int x) {
        int h = x;
        for (int i = 0; i < 20; i++) { h = h * 31 + (h >>> 7) ^ i; }
        return h;
    }
    public static void main(String[] a) {
        int batches = Integer.parseInt(a[0]), per = Integer.parseInt(a[1]);
        long sink = 0;
        for (int b = 0; b < batches; b++) {
            long t0 = System.nanoTime();
            for (int i = 0; i < per; i++) sink += work(i + b);
            System.out.println("BATCH " + b + " " + (System.nanoTime() - t0) / per);
        }
        System.out.println("SINK " + sink);
    }
}
`;

export const javaJitWarmup: ShellExperiment = {
  id: "java-jit-warmup",
  subject: "java",
  title: "JIT 워밍업: 같은 메서드가 인터프리터 → C1 → C2 로 옮겨 가며 몇 배 빨라지는가",
  category: "JVM 내부",
  summary: "작은 계산 메서드를 2,000회씩 묶음으로 반복 호출하며 묶음마다 호출당 ns 를 잰다. 기본(계층 컴파일), C1 만(-XX:TieredStopAtLevel=1), 인터프리터만(-Xint) 세 모드를 비교하고, -XX:+PrintCompilation 로 work() 가 언제 몇 단계로 컴파일되는지(3 → 4, made not entrant) 본다",
  notes: ["15-jit-compilation", "14-classloading-bytecode"],
  description: `
JVM 은 바이트코드를 처음엔 **인터프리터**로 실행하고, 자주 불리는 메서드를 **C1**(빠른 컴파일·프로파일 수집, 단계 3) → **C2**(공격적 최적화, 단계 4) 순으로 기계어로 바꾼다(계층 컴파일).
그래서 자바 서비스는 시작 직후 느리고 수 초~수 분 뒤에 빨라진다(**워밍업**). 벤치마크에서 첫 측정을 버리는 이유, 배포 직후 p99 가 튀는 이유, 짧게 사는 서버리스·CLI 에서 GraalVM 네이티브·CDS·CRaC 를 찾는 이유가 모두 여기 있다.
이 실험은 같은 메서드의 호출당 시간을 묶음별로 찍어 그 곡선을 직접 본다.
`,
  code: `javac Warmup.java
java -XX:+PrintCompilation Warmup 40 2000 | grep -E "BATCH|Warmup::work"   # 계층 컴파일 로그 + 묶음별 ns/호출
java -XX:TieredStopAtLevel=1 Warmup 40 2000                                # C1 만
java -Xint Warmup 15 2000                                                  # 인터프리터만
javap -c Warmup                                                            # work() 의 바이트코드`,
  requires: requiresJdk,
  async run(ctx) {
    await ensureJdk(ctx);
    const dir = await workdir({ "Warmup.java": WARMUP });
    const guard = armDeadman(`rm -rf '${dir}'`, 900);
    try {
      await jdk(ctx, dir, "javac Warmup.java", { label: "javac Warmup.java" });
      const D = ["--cpus=2", "--memory=512m"];
      const parse = (out: string) => out.split("\n").filter((l) => l.startsWith("BATCH ")).map((l) => Number(l.split(" ")[2]));
      const tiered = await jdk(ctx, dir, "java -XX:+PrintCompilation Warmup 40 2000", { label: "java -XX:+PrintCompilation Warmup 40 2000   # 기본: 계층 컴파일", docker: D });
      const compileLines = tiered.out.split("\n").filter((l) => l.includes("Warmup::work"));
      const tieredNs = parse(tiered.out);
      const c1 = parse((await jdk(ctx, dir, "java -XX:TieredStopAtLevel=1 Warmup 40 2000", { label: "java -XX:TieredStopAtLevel=1 Warmup 40 2000   # C1 만", docker: D })).out);
      const xint = parse((await jdk(ctx, dir, "java -Xint Warmup 15 2000", { label: "java -Xint Warmup 15 2000   # 인터프리터만", docker: D })).out);
      ctx.table(
        "work() 컴파일 기록 (-XX:+PrintCompilation: 시각ms · 컴파일ID · 단계 · 메서드)",
        ["시각(ms)", "ID", "단계", "비고"],
        compileLines.slice(0, 8).map((l) => {
          const p = l.trim().split(/\s+/);
          return [p[0], p[1], p.find((x) => /^[0-4]$/.test(x)) ?? "?", l.includes("made not entrant") ? "made not entrant (상위 단계로 교체)" : l.includes("%") ? "OSR (루프 도중 교체)" : ""];
        }),
      );
      const steady = (xs: number[]) => median(xs.slice(-10));
      ctx.table("호출당 시간 (ns) — 첫 묶음 · 다섯째 묶음 · 마지막 10묶음 중앙값", ["모드", "첫 묶음", "다섯째", "안정 상태", "인터프리터 대비"], [
        ["-Xint (인터프리터만)", String(xint[0]), String(xint[4] ?? "-"), String(steady(xint)), "1.0×"],
        ["C1 만 (TieredStopAtLevel=1)", String(c1[0]), String(c1[4]), String(steady(c1)), `${(steady(xint) / Math.max(1, steady(c1))).toFixed(1)}×`],
        ["기본 (계층: 인터프리터→C1→C2)", String(tieredNs[0]), String(tieredNs[4]), String(steady(tieredNs)), `${(steady(xint) / Math.max(1, steady(tieredNs))).toFixed(1)}×`],
      ]);
      ctx.table("기본 모드의 묶음별 곡선 (앞 12묶음)", ["묶음", ...tieredNs.slice(0, 12).map((_, i) => String(i))], [["ns/호출", ...tieredNs.slice(0, 12).map(String)]]);
      ctx.check("work() 가 C1(단계 1~3) 과 C2(단계 4) 로 모두 컴파일됐다", compileLines.some((l) => /\s4\s+Warmup::work/.test(l)) && compileLines.some((l) => /\s[1-3]\s+Warmup::work/.test(l)), compileLines.slice(0, 4).join("\n"));
      ctx.check("JIT 안정 상태가 인터프리터보다 5배 이상 빠르다", steady(xint) >= 5 * Math.max(1, steady(tieredNs)), `xint ${steady(xint)}ns vs tiered ${steady(tieredNs)}ns`);
      ctx.check("기본 모드는 첫 묶음이 안정 상태보다 느리다 (워밍업 곡선)", tieredNs[0] > steady(tieredNs), `${tieredNs[0]} → ${steady(tieredNs)}`);
      await jdk(ctx, dir, "javap -c Warmup | sed -n '/static int work/,/ireturn/p'", { label: "javap -c Warmup   # work() 바이트코드 — 인터프리터가 한 줄씩 실행하는 것" });
      ctx.note("C1 만으로도 인터프리터보다 크게 빠르지만, C2 는 프로파일(실제로 받은 타입·분기 빈도)을 근거로 인라이닝·루프 최적화를 더 한다. 'made not entrant' 는 낮은 단계 코드를 버리고 새 코드로 갈아탄다는 뜻 — 가정이 깨지면 같은 표시로 탈최적화(deopt)도 일어난다.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      guard.disarm();
    }
  },
};

// ---------------------------------------------------------------- 2. GC 비교
const ALLOC = `public class Alloc {
    public static void main(String[] a) {
        int iters = Integer.parseInt(a[0]);
        Object[] keep = new Object[200_000];          // 장수 객체 링 버퍼 (최대 약 100MB 유지)
        long t0 = System.nanoTime(), sink = 0;
        for (int i = 0; i < iters; i++) {
            byte[] tmp = new byte[256];               // 짧게 사는 객체 — 대부분 Young 에서 죽는다
            tmp[i & 255] = (byte) i; sink += tmp[(i * 7) & 255];
            if ((i & 31) == 0) keep[(i >>> 5) % keep.length] = new long[64];   // 32개 중 1개는 오래 산다
        }
        System.out.println("MS " + (System.nanoTime() - t0) / 1_000_000 + " SINK " + sink);
    }
}
`;

export const javaGcCompare: ShellExperiment = {
  id: "java-gc-compare",
  subject: "java",
  title: "GC 비교: 같은 할당 부하를 Serial·G1·ZGC 로 돌려 멈춤 횟수·최대·p99·총 시간을 잰다",
  category: "GC",
  summary: "256MB 힙에서 짧게 사는 byte[256] 2천만 개와 오래 사는 long[64] 일부(최대 약 100MB 유지)를 할당하는 같은 프로그램을 SerialGC·G1·세대형 ZGC 로 실행한다. -Xlog:safepoint 로 GC 가 애플리케이션을 멈춘 시간을 같은 기준으로 모아 횟수·최대·p99·합계와 전체 실행 시간을 비교한다",
  notes: ["17-gc-basics-g1", "18-zgc-shenandoah-tuning", "19-diagnostic-tools"],
  description: `
GC 를 고르는 일은 **최대 멈춤(지연)** 과 **처리량(총 시간·CPU)** 사이의 선택이다.
Serial 은 한 스레드로 세상을 멈추고 치운다(단순·작은 힙에 효율적). G1 은 리전 단위로 나눠 목표 멈춤 시간(기본 200ms)에 맞춰 일부만 치운다(서버 기본값). ZGC 는 표시·이동까지 앱과 **동시에** 해 멈춤을 1ms 근처로 묶는 대신 CPU 와 메모리를 더 쓴다.
GC 로그 형식은 수집기마다 다르므로, 모두에 공통인 **세이프포인트 로그**(-Xlog:safepoint)의 Total(멈춤 도달 + 멈춤 동안) 으로 비교한다.
`,
  code: `javac Alloc.java
for gc in -XX:+UseSerialGC -XX:+UseG1GC "-XX:+UseZGC -XX:+ZGenerational"; do
  java $gc -Xms256m -Xmx256m -Xlog:safepoint:file=sp.log -Xlog:gc:file=gc.log Alloc 20000000
  grep -o 'Total: [0-9]* ns' sp.log | sort -t' ' -k2 -n | tail -1      # 최대 멈춤
done`,
  requires: requiresJdk,
  async run(ctx) {
    await ensureJdk(ctx);
    const dir = await workdir({ "Alloc.java": ALLOC });
    const guard = armDeadman(`rm -rf '${dir}'`, 900);
    try {
      await jdk(ctx, dir, "javac Alloc.java", { label: "javac Alloc.java" });
      const gcs: [string, string][] = [
        ["Serial", "-XX:+UseSerialGC"],
        ["G1", "-XX:+UseG1GC"],
        ["ZGC (세대형)", "-XX:+UseZGC -XX:+ZGenerational"],
      ];
      const rows: string[][] = [];
      const res: Record<string, { n: number; max: number; p99: number; sum: number; wall: number; log: string }> = {};
      for (const [name, flag] of gcs) {
        const tag = name.split(" ")[0].toLowerCase();
        const r = await jdk(ctx, dir, `java ${flag} -Xms256m -Xmx256m -Xlog:safepoint=info:file=/w/sp-${tag}.log -Xlog:gc:file=/w/gc-${tag}.log Alloc 20000000`, { label: `java ${flag} -Xms256m -Xmx256m -Xlog:safepoint -Xlog:gc Alloc 20000000`, docker: ["--cpus=2", "--memory=768m"], timeout: 300_000 });
        const wall = Number(r.out.match(/MS (\d+)/)?.[1] ?? 0);
        const sp = await fs.readFile(path.join(dir, `sp-${tag}.log`), "utf8").catch(() => "");
        const lines = sp.split("\n").filter((l) => /Safepoint "/.test(l));
        const gcLines = lines.filter((l) => /Safepoint "(GenCollect|G1|Z|Collect|Serial|Shenandoah)/.test(l));
        const ms = gcLines.map((l) => Number(l.match(/Total: (\d+) ns/)?.[1] ?? 0) / 1e6);
        const gcLog = await fs.readFile(path.join(dir, `gc-${tag}.log`), "utf8").catch(() => "");
        res[name] = { n: ms.length, max: Math.max(0, ...ms), p99: pct(ms, 0.99), sum: ms.reduce((a, b) => a + b, 0), wall, log: gcLog.split("\n").slice(1, 4).join("\n") };
        rows.push([name, String(ms.length), res[name].max.toFixed(2), res[name].p99.toFixed(2), res[name].sum.toFixed(1), String(wall)]);
        ctx.note(`${name} gc 로그 앞부분:\n${res[name].log}`);
      }
      ctx.table("GC 세이프포인트(애플리케이션 멈춤) — 같은 프로그램·같은 256MB 힙·CPU 2개", ["수집기", "멈춤 횟수", "최대(ms)", "p99(ms)", "합계(ms)", "전체 실행(ms)"], rows);
      const z = res["ZGC (세대형)"], s = res.Serial, g = res.G1;
      ctx.check("세 수집기 모두 GC 세이프포인트가 기록됐다", s.n > 0 && g.n > 0 && z.n > 0, `${s.n}/${g.n}/${z.n}`);
      ctx.check("ZGC 의 최대 멈춤이 Serial 의 최대 멈춤보다 짧다 (동시 수집)", z.max < s.max, `ZGC ${z.max.toFixed(2)}ms vs Serial ${s.max.toFixed(2)}ms`);
      ctx.note(`해석: 멈춤 횟수는 ZGC 가 가장 많을 수 있다(사이클마다 짧은 세이프포인트 3~4개). 중요한 것은 각각이 얼마나 짧은가와, 그 대가로 전체 실행 시간·CPU 가 얼마나 느는가다(ZGC ${z.wall}ms vs G1 ${g.wall}ms vs Serial ${s.wall}ms). 작은 힙·배치 작업은 Serial·Parallel 이, 대화형 서비스는 G1, 수십 GB 힙의 지연 민감 서비스는 ZGC 가 맞는 경우가 많다.`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      guard.disarm();
    }
  },
};

// ---------------------------------------------------------------- 3. 컨테이너 메모리
const HOG = `import java.util.*;
public class Hog {
    public static void main(String[] a) {
        int mb = Integer.parseInt(a[0]);
        List<byte[]> keep = new ArrayList<>();
        Runtime rt = Runtime.getRuntime();
        System.out.println("MAXHEAP_MB " + rt.maxMemory() / 1048576 + " CPUS " + rt.availableProcessors());
        for (int i = 0; i < mb; i++) { byte[] b = new byte[1 << 20]; Arrays.fill(b, (byte) 1); keep.add(b); if (i % 32 == 0) System.out.println("ALLOC_MB " + i); }
        System.out.println("DONE " + keep.size());
    }
}
`;

const OOM_NAMES = ["lab-java-oome", "lab-java-oomkill"];

export const javaContainerMemory: ShellExperiment = {
  id: "java-container-memory",
  subject: "java",
  title: "컨테이너 속 JVM: 256MB 컨테이너에서 힙은 얼마로 잡히고, 넘치면 OutOfMemoryError 인가 OOMKilled(137) 인가",
  category: "컨테이너",
  summary: "--memory 256m·1g 컨테이너에서 JVM 이 고르는 MaxHeapSize·GC·CPU 수를 -XX:+PrintFlagsFinal 로 읽고, MaxRAMPercentage=75 로 바꿔 본다. 그다음 힙 상한이 컨테이너보다 작을 때(자바 OutOfMemoryError, 종료 코드 1)와 -Xmx1g 로 컨테이너보다 크게 잡았을 때(커널 OOM 킬러, 137·OOMKilled=true)를 나란히 재현한다",
  notes: ["20-jvm-in-containers", "16-memory-layout"],
  description: `
JDK 10+ 의 JVM 은 cgroup 을 읽어 **컨테이너 메모리 한도**를 자기 '물리 메모리' 로 본다. 기본 힙 상한은 그 25%(작은 메모리에선 다른 규칙)라, 1GB 컨테이너에서 힙은 256MB 뿐이다 — 메모리를 넉넉히 줬는데 OOM 이 나는 흔한 이유.
반대로 -Xmx 를 컨테이너보다 크게 잡으면 힙이 다 차기도 전에 **커널이 프로세스를 죽인다**(OOMKilled, 137). 자바 스택 트레이스도, 힙 덤프도 남지 않는다.
또 하나의 함정: JVM 은 CPU 2개 이상 + 메모리 1792MB 이상일 때만 '서버급' 으로 보고 G1 을 고른다. 작은 컨테이너는 **SerialGC** 가 기본이 된다.
`,
  code: `docker run --rm --memory=256m --cpus=2 eclipse-temurin:21-jdk java -XX:+PrintFlagsFinal -version | grep -E ' MaxHeapSize | UseSerialGC | UseG1GC '
docker run --rm --memory=256m eclipse-temurin:21-jdk java -XX:MaxRAMPercentage=75 -XX:+PrintFlagsFinal -version | grep ' MaxHeapSize '
docker run --name a --memory=256m --memory-swap=256m … java Hog 400        # 힙(약 126MB)을 넘김 → java.lang.OutOfMemoryError, exit 1
docker run --name b --memory=256m --memory-swap=256m … java -Xmx1g Hog 400 # 컨테이너를 넘김 → exit 137, OOMKilled=true
docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' a b`,
  requires: requiresJdk,
  cleanup: async (ctx) => {
    await ctx.sh("docker", ["rm", "-f", ...OOM_NAMES], { allowFail: true, label: `docker rm -f ${OOM_NAMES.join(" ")}   # 정리` });
  },
  async run(ctx) {
    await ensureJdk(ctx);
    const dir = await workdir({ "Hog.java": HOG });
    await exec("docker", ["rm", "-f", ...OOM_NAMES]);
    const guard = armDeadman(`docker rm -f ${OOM_NAMES.join(" ")}; rm -rf '${dir}'`, 900);
    try {
      await jdk(ctx, dir, "javac Hog.java", { label: "javac Hog.java" });
      const flag = (out: string, name: string) => out.match(new RegExp(`\\s${name}\\s+=\\s+(\\S+)`))?.[1] ?? "?";
      const rows: string[][] = [];
      const ergo: Record<string, { heapMb: number; gc: string }> = {};
      for (const [mem, extra, label] of [["256m", "", "256MB 컨테이너 (기본)"], ["1g", "", "1GB 컨테이너 (기본)"], ["256m", "-XX:MaxRAMPercentage=75", "256MB + MaxRAMPercentage=75"], ["2g", "", "2GB 컨테이너 (기본)"]] as const) {
        const r = await ctx.sh("docker", ["run", "--rm", `--memory=${mem}`, "--cpus=2", JDK, "sh", "-c", `java ${extra} -XX:+PrintFlagsFinal -version 2>/dev/null | grep -E ' MaxHeapSize | MaxRAMPercentage | UseSerialGC | UseG1GC '`], { label: `docker run --memory=${mem} --cpus=2 … java ${extra} -XX:+PrintFlagsFinal -version`, timeout: 120_000 });
        const heapMb = Math.round(Number(flag(r.out, "MaxHeapSize")) / 1048576);
        const gc = flag(r.out, "UseG1GC") === "true" ? "G1" : flag(r.out, "UseSerialGC") === "true" ? "Serial" : "?";
        ergo[label] = { heapMb, gc };
        rows.push([label, `${heapMb} MB`, flag(r.out, "MaxRAMPercentage"), gc]);
      }
      ctx.table("JVM 인체공학(ergonomics) — 컨테이너 한도에 따라 자동으로 고른 값", ["조건", "MaxHeapSize", "MaxRAMPercentage", "선택된 GC"], rows);
      ctx.check("1GB 컨테이너의 기본 힙은 한도의 25%(256MB) 근처다", Math.abs(ergo["1GB 컨테이너 (기본)"].heapMb - 256) <= 8, `${ergo["1GB 컨테이너 (기본)"].heapMb} MB`);
      ctx.check("MaxRAMPercentage=75 로 256MB 컨테이너의 힙이 기본보다 커졌다", ergo["256MB + MaxRAMPercentage=75"].heapMb > ergo["256MB 컨테이너 (기본)"].heapMb, `${ergo["256MB 컨테이너 (기본)"].heapMb} → ${ergo["256MB + MaxRAMPercentage=75"].heapMb} MB`);
      ctx.check("2GB 미만 컨테이너는 SerialGC, 2GB(서버급)는 G1 이 기본이다", ergo["1GB 컨테이너 (기본)"].gc === "Serial" && ergo["2GB 컨테이너 (기본)"].gc === "G1", `${ergo["1GB 컨테이너 (기본)"].gc} / ${ergo["2GB 컨테이너 (기본)"].gc}`);

      ctx.note("이제 같은 256MB 컨테이너(스왑 끔: --memory-swap=256m)에서 1MB 배열을 400개 쌓아 본다");
      const a = await ctx.sh("docker", ["run", "--name", OOM_NAMES[0], "--memory=256m", "--memory-swap=256m", "--cpus=2", "-v", `${dir}:/w`, "-w", "/w", JDK, "java", "Hog", "400"], { allowFail: true, timeout: 120_000, label: `docker run --name ${OOM_NAMES[0]} --memory=256m --memory-swap=256m … java Hog 400   # 힙 상한(기본) < 컨테이너` });
      const b = await ctx.sh("docker", ["run", "--name", OOM_NAMES[1], "--memory=256m", "--memory-swap=256m", "--cpus=2", "-v", `${dir}:/w`, "-w", "/w", JDK, "java", "-Xmx1g", "Hog", "400"], { allowFail: true, timeout: 120_000, label: `docker run --name ${OOM_NAMES[1]} --memory=256m --memory-swap=256m … java -Xmx1g Hog 400   # 힙 상한 > 컨테이너` });
      const st = async (n: string) => (await exec("docker", ["inspect", "-f", "{{.State.ExitCode}} {{.State.OOMKilled}}", n])).out.split(" ");
      const [ea, oa] = await st(OOM_NAMES[0]);
      const [eb, ob] = await st(OOM_NAMES[1]);
      const lastAlloc = (out: string) => (out.match(/ALLOC_MB (\d+)/g) ?? []).pop()?.split(" ")[1] ?? "0";
      ctx.table("넘쳤을 때 무슨 일이 일어나는가", ["경우", "힙 상한", "마지막으로 쌓은 MB", "종료 코드", "OOMKilled", "남는 흔적"], [
        ["힙 상한 < 컨테이너", `${(a.out + a.err).match(/MAXHEAP_MB (\d+)/)?.[1] ?? "?"} MB`, lastAlloc(a.out), ea, oa, /OutOfMemoryError/.test(a.out + a.err) ? "java.lang.OutOfMemoryError 스택 트레이스" : "?"],
        ["-Xmx1g > 컨테이너 256MB", `${(b.out + b.err).match(/MAXHEAP_MB (\d+)/)?.[1] ?? "?"} MB`, lastAlloc(b.out), eb, ob, "없음 (커널이 SIGKILL)"],
      ]);
      ctx.check("힙이 먼저 차면 자바가 OutOfMemoryError 를 던지고 컨테이너는 OOMKilled 가 아니다", /OutOfMemoryError/.test(a.out + a.err) && oa === "false", `exit ${ea} oom ${oa}`);
      ctx.check("컨테이너가 먼저 차면 커널 OOM 킬러가 죽인다 (137, OOMKilled=true)", eb === "137" && ob === "true", `exit ${eb} oom ${ob}`);
      ctx.note("교훈: -Xmx(또는 MaxRAMPercentage)는 컨테이너 한도보다 작게, 그리고 힙 밖 메모리(메타스페이스·스레드 스택·코드 캐시·다이렉트 버퍼·GC 자료구조)를 위해 25% 이상 남긴다. OOMKilled 는 힙 덤프를 남기지 않으므로 -XX:+HeapDumpOnOutOfMemoryError 로는 잡히지 않는다 — 컨테이너 메트릭(container_memory_working_set_bytes)과 NMT 로 본다.");
    } finally {
      await exec("docker", ["rm", "-f", ...OOM_NAMES]);
      await fs.rm(dir, { recursive: true, force: true });
      guard.disarm();
    }
  },
};
