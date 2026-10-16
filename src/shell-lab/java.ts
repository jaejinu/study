import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

/**
 * Java 1~3부 실험 — 로컬에 JDK 가 없어도 Docker 의 eclipse-temurin:21-jdk 로 단일 파일 실행(`java X.java`)한다.
 * 임시 디렉터리에 소스를 쓰고 /w 로 마운트해 실행, 출력의 RESULT 줄을 파싱해 표로 만든다.
 * 컨테이너는 --rm 이고 이름(lab-java-*)을 붙여, 중단돼도 cleanup 이 지울 수 있게 한다.
 */

const IMAGE = "eclipse-temurin:21-jdk";

async function requiresJdk(): Promise<string | null> {
  const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 8000 });
  if (!d.ok) return "Docker 데몬이 필요합니다 (Docker Desktop 실행). 자바 실험은 eclipse-temurin:21-jdk 컨테이너에서 돕니다.";
  return null;
}

async function ensureImage(ctx: ShellCtx) {
  const has = await exec("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"], { timeout: 10_000 });
  if (!has.ok) await ctx.sh("docker", ["pull", IMAGE], { timeout: 900_000, label: `docker pull ${IMAGE}   # 첫 실행만 (약 750MB)` });
}

async function withSources<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lab-java-"));
  try {
    for (const [name, src] of Object.entries(files)) await fs.writeFile(path.join(dir, name), src);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 컨테이너 안에서 `java [opts] File.java args` 를 실행. timeout 으로 무한 루프를 막는다 */
async function runJava(ctx: ShellCtx, dir: string, name: string, file: string, javaArgs: string[], progArgs: string[], label: string, timeoutSec = 120) {
  return ctx.sh("docker", ["run", "--rm", "--name", name, "-v", `${dir}:/w`, "-w", "/w", IMAGE, "timeout", String(timeoutSec), "java", ...javaArgs, file, ...progArgs], { timeout: (timeoutSec + 60) * 1000, label });
}

async function rmContainers(ctx: ShellCtx, names: string[]) {
  await ctx.sh("docker", ["rm", "-f", ...names], { allowFail: true, label: `docker rm -f ${names.join(" ")}   # 정리` });
}

const lines = (out: string, tag: string) => out.split("\n").filter((l) => l.startsWith(tag + " ")).map((l) => l.slice(tag.length + 1).trim().split(/\s+/));

// ------------------------------------------------------------------------------------------------
const HASHMAP_SRC = `import java.util.*;

public class HashMapLab {
    // 같은 해시를 내는 나쁜 키 — Comparable 이 아니다
    static final class BadKey {
        final int id;
        BadKey(int id) { this.id = id; }
        @Override public int hashCode() { return 42; }
        @Override public boolean equals(Object o) { return o instanceof BadKey b && b.id == id; }
    }
    // 같은 해시지만 Comparable — 트리화된 버킷에서 compareTo 로 길을 찾는다
    static final class BadComparableKey implements Comparable<BadComparableKey> {
        final int id;
        BadComparableKey(int id) { this.id = id; }
        @Override public int hashCode() { return 42; }
        @Override public boolean equals(Object o) { return o instanceof BadComparableKey b && b.id == id; }
        @Override public int compareTo(BadComparableKey o) { return Integer.compare(id, o.id); }
    }

    static long sink;

    /** n 개를 넣고 모두 한 번씩 조회하는 데 걸린 시간(ns) — 조회만 잰다 */
    static <K> long lookupNanos(List<K> keys) {
        Map<K, Integer> m = new HashMap<>();
        for (int i = 0; i < keys.size(); i++) m.put(keys.get(i), i);
        long t0 = System.nanoTime();
        for (K k : keys) sink += m.get(k);
        return System.nanoTime() - t0;
    }

    public static void main(String[] args) {
        // 1) 리사이즈 시점: 기본 용량 16, 적재율 0.75 → 12, 24, 48 ... 번째 put 이 테이블을 두 배로 늘리며 전체를 재배치
        int reps = 3000;
        int[] thresholds = {12, 24, 48, 96, 192, 384, 768, 1536, 3072, 6144};
        int max = 6200;
        long[] at = new long[max + 1];
        for (int r = 0; r < reps + 500; r++) {
            HashMap<Integer, Integer> m = new HashMap<>();
            for (int i = 1; i <= max; i++) {
                long t0 = System.nanoTime();
                m.put(i, i);
                long dt = System.nanoTime() - t0;
                if (r >= 500) at[i] += dt; // 앞 500 회는 JIT 워밍업
            }
        }
        for (int th : thresholds) {
            double resize = at[th + 1] / (double) reps;          // threshold+1 번째 put 이 리사이즈를 일으킨다
            double normal = (at[th - 1] + at[th - 2] + at[th + 3]) / 3.0 / reps;
            System.out.printf("RESIZE %d %.0f %.0f%n", th + 1, resize, normal);
        }
        // 2) 나쁜 hashCode: 모든 키가 한 버킷 → 8개 넘으면(TREEIFY_THRESHOLD, 테이블 64 이상) 트리화
        for (int warm = 0; warm < 3; warm++) {
            List<BadKey> a = new ArrayList<>(); for (int i = 0; i < 2000; i++) a.add(new BadKey(i)); lookupNanos(a);
            List<BadComparableKey> b = new ArrayList<>(); for (int i = 0; i < 2000; i++) b.add(new BadComparableKey(i)); lookupNanos(b);
            List<Integer> c = new ArrayList<>(); for (int i = 0; i < 2000; i++) c.add(i); lookupNanos(c);
        }
        for (int n : new int[] {1000, 2000, 4000, 8000}) {
            List<Integer> good = new ArrayList<>(); List<BadKey> bad = new ArrayList<>(); List<BadComparableKey> badC = new ArrayList<>();
            for (int i = 0; i < n; i++) { good.add(i); bad.add(new BadKey(i)); badC.add(new BadComparableKey(i)); }
            long g = lookupNanos(good), b = lookupNanos(bad), bc = lookupNanos(badC);
            System.out.printf("COLLIDE %d %.1f %.1f %.1f%n", n, g / (double) n, b / (double) n, bc / (double) n);
        }
        System.out.println("SINK " + (sink % 7));
    }
}
`;

export const javaHashmapInternals: ShellExperiment = {
  id: "java-hashmap-internals",
  subject: "java",
  title: "HashMap 내부: 리사이즈가 일어나는 put, 같은 해시만 내는 키, 그리고 트리화가 구해 주는 것",
  category: "컬렉션",
  summary: "put 하나하나의 시간을 3천 번 평균 내 '용량×0.75 를 넘는 순간' 의 put 만 수십~수백 배 느린 것(전체 재배치)을 리플렉션 없이 보고, hashCode 가 상수인 키 n 개의 조회 비용을 Comparable 이 아닐 때(버킷 안 O(n))와 Comparable 일 때(트리화 버킷 O(log n))로 비교한다",
  notes: ["08-hashmap-internals", "02-types-objects-immutability"],
  description: `
HashMap 은 **배열(버킷 테이블) + 체인** 이다. 원소 수가 \`용량 × 0.75\` 를 넘는 순간의 put 은 테이블을 두 배로 늘리고 **모든 원소를 다시 배치**한다 — 평소 수십 ns 인 put 이 그 한 번만 수 μs 가 된다.
\`hashCode\` 가 나쁘면 모든 키가 한 버킷에 몰린다. 버킷의 원소가 8개를 넘고 테이블이 64 이상이면 연결 리스트를 **레드-블랙 트리** 로 바꾸는데(트리화), 키가 \`Comparable\` 이어야 트리 안에서 길을 찾을 수 있다. Comparable 이 아니면 트리여도 양쪽을 다 뒤져 사실상 O(n) 이다.
`,
  code: `docker run --rm -v "$PWD":/w -w /w eclipse-temurin:21-jdk java HashMapLab.java
# RESIZE <리사이즈를 일으킨 put 번호> <그 put 평균 ns> <주변 put 평균 ns>
# COLLIDE <n> <좋은 키 ns/조회> <상수 hashCode ns/조회> <상수 hashCode + Comparable ns/조회>`,
  requires: requiresJdk,
  cleanup: (ctx) => rmContainers(ctx, ["lab-java-hashmap"]),
  async run(ctx) {
    await ensureImage(ctx);
    const r = await withSources({ "HashMapLab.java": HASHMAP_SRC }, (dir) => runJava(ctx, dir, "lab-java-hashmap", "HashMapLab.java", [], [], "docker run eclipse-temurin:21-jdk java HashMapLab.java   # 소스는 실험 설명의 code 참고", 180));
    const resize = lines(r.out, "RESIZE").map(([n, rs, nm]) => ({ n: Number(n), resize: Number(rs), normal: Number(nm) }));
    ctx.table("리사이즈를 일으키는 put (용량 16 → 32 → … , 적재율 0.75)", ["put 번호", "그때 테이블", "그 put 평균", "주변 put 평균", "배수"], resize.map((x) => [String(x.n), `${(x.n - 1) / 0.75} → ${((x.n - 1) / 0.75) * 2}`, `${x.resize} ns`, `${x.normal} ns`, `${(x.resize / x.normal).toFixed(0)}×`]));
    const big = resize.filter((x) => x.n > 700);
    ctx.check("큰 테이블일수록 리사이즈 put 이 주변 put 보다 훨씬 느리다 (전체 재배치)", big.length > 0 && big.every((x) => x.resize > x.normal * 10));
    ctx.check("리사이즈 비용이 테이블 크기에 비례해 커진다", resize[resize.length - 1].resize > resize[0].resize * 10);

    const col = lines(r.out, "COLLIDE").map(([n, g, b, bc]) => ({ n: Number(n), good: Number(g), bad: Number(b), badC: Number(bc) }));
    ctx.table("조회 1회당 평균 시간 (모든 키의 hashCode 가 42)", ["n", "좋은 키(Integer)", "상수 hashCode", "상수 hashCode + Comparable"], col.map((x) => [String(x.n), `${x.good} ns`, `${x.bad} ns`, `${x.badC} ns`]));
    const first = col[0], last = col[col.length - 1];
    ctx.check("Comparable 이 아닌 충돌 키는 n 이 8배일 때 조회 비용도 몇 배로 늘어난다 (버킷 안 선형 탐색)", last.bad > first.bad * 3);
    ctx.check("Comparable 이면 트리화된 버킷에서 compareTo 로 찾아 조회 비용이 거의 늘지 않는다", last.badC < last.bad / 20);
    ctx.note("교훈: hashCode 는 분포가 좋아야 하고, 키로 쓸 클래스는 equals·hashCode 를 함께 정의한다. 트리화는 '나쁜 해시에 대한 보험' 이지 해법이 아니다 — 보험도 키가 Comparable 일 때만 제대로 듣는다.");
  },
};

// ------------------------------------------------------------------------------------------------
const VISIBILITY_SRC = `public class Visibility {
    static boolean plain;            // volatile 아님
    static volatile boolean flagged; // volatile

    public static void main(String[] args) throws Exception {
        String mode = args[0];
        Thread t = new Thread(() -> {
            long i = 0;
            if (mode.equals("volatile")) { while (!flagged) i++; }
            else { while (!plain) i++; }
            System.out.println("LOOP_ENDED " + i);
        });
        t.setDaemon(true); // 끝나지 않아도 JVM 이 종료되게
        t.start();
        Thread.sleep(1000);              // 그동안 루프가 JIT 컴파일된다
        long t0 = System.nanoTime();
        if (mode.equals("volatile")) flagged = true; else plain = true;
        t.join(2000);
        System.out.printf("RESULT %s alive=%s waitedMs=%d%n", mode, t.isAlive(), (System.nanoTime() - t0) / 1_000_000);
    }
}
`;

export const javaJmmVisibility: ShellExperiment = {
  id: "java-jmm-visibility",
  subject: "java",
  title: "자바 메모리 모델: volatile 없는 플래그를 영원히 못 보는 스레드",
  category: "동시성",
  summary: "while(!stop) 루프를 도는 스레드에게 1초 뒤 stop=true 를 알린다. 평범한 boolean 이면 JIT 가 읽기를 루프 밖으로 끌어내 스레드가 끝나지 않고(2초 기다려도 살아 있음), volatile 이면 즉시 끝나며, -Xint(JIT 끔)에서는 평범한 필드로도 끝나는 것을 비교한다",
  notes: ["10-threads-jmm", "11-locks-juc"],
  description: `
자바 메모리 모델(JMM)은 "한 스레드의 쓰기가 다른 스레드에 **언제** 보이는가" 를 **happens-before** 관계로만 보장한다. 동기화 없는 평범한 필드 쓰기는 다른 스레드가 영원히 못 볼 수도 있다.
실제로 그렇게 되는 이유는 하드웨어 캐시보다 **컴파일러 최적화** 가 크다: JIT(C2)는 루프 안에서 바뀌지 않는 것처럼 보이는 필드 읽기를 루프 밖으로 끌어낸다(호이스팅). \`volatile\` 은 그 최적화를 금지하고 쓰기→읽기 사이에 happens-before 를 만든다.
`,
  code: `docker run --rm -v "$PWD":/w -w /w eclipse-temurin:21-jdk java Visibility.java plain      # 끝나지 않음
docker run --rm -v "$PWD":/w -w /w eclipse-temurin:21-jdk java Visibility.java volatile   # 즉시 끝남
docker run --rm -v "$PWD":/w -w /w eclipse-temurin:21-jdk java -Xint Visibility.java plain   # JIT 없으면 끝남`,
  requires: requiresJdk,
  cleanup: (ctx) => rmContainers(ctx, ["lab-java-vis-plain", "lab-java-vis-volatile", "lab-java-vis-xint"]),
  async run(ctx) {
    await ensureImage(ctx);
    const rows: string[][] = [];
    const res: Record<string, { alive: boolean; waited: number }> = {};
    await withSources({ "Visibility.java": VISIBILITY_SRC }, async (dir) => {
      for (const [key, jvm, mode, label] of [
        ["plain", [], "plain", "평범한 boolean (JIT)"],
        ["plain-2", [], "plain", "평범한 boolean (JIT, 두 번째 시도)"],
        ["volatile", [], "volatile", "volatile boolean"],
        ["xint", ["-Xint"], "plain", "평범한 boolean, -Xint (인터프리터만)"],
      ] as [string, string[], string, string][]) {
        const r = await runJava(ctx, dir, `lab-java-vis-${key.replace("-2", "")}`, "Visibility.java", jvm, [mode], `docker run ... java ${jvm.join(" ")} Visibility.java ${mode}   # ${label}`, 30);
        const m = /RESULT \S+ alive=(true|false) waitedMs=(\d+)/.exec(r.out);
        const alive = m?.[1] === "true";
        res[key] = { alive, waited: Number(m?.[2] ?? -1) };
        rows.push([label, alive ? "끝나지 않음 (2초 후에도 살아 있음)" : "끝남", `${m?.[2] ?? "?"} ms`]);
      }
    });
    ctx.table("stop 을 true 로 바꾼 뒤 루프 스레드가 끝나는가", ["필드", "결과", "join 대기"], rows);
    ctx.check("volatile 이면 즉시 끝난다 (happens-before)", !res.volatile.alive && res.volatile.waited < 500);
    ctx.check("JIT 를 끄면(-Xint) 평범한 필드도 결국 보인다 — 원인은 JIT 의 최적화", !res.xint.alive);
    ctx.check("평범한 boolean 은 JIT 컴파일 후 끝나지 않는다 (두 시도 중 한 번 이상)", res.plain.alive || res["plain-2"].alive);
    ctx.note("'내 PC 에서는 됐다' 는 동시성 버그의 증거가 아니다. 이 실험의 평범한 필드 버전이 -Xint 에선 끝나듯, 실행 환경·JIT 단계에 따라 결과가 달라진다. 공유 변수는 volatile·락·Atomic* 중 하나로 반드시 happens-before 를 만든다.");
  },
};

// ------------------------------------------------------------------------------------------------
const VTHREADS_SRC = `import java.lang.management.ManagementFactory;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

public class VThreads {
    static int peakPlatformThreads(Runnable work) throws Exception {
        var mx = ManagementFactory.getThreadMXBean();
        var peak = new AtomicInteger(mx.getThreadCount());
        var sampler = Executors.newSingleThreadScheduledExecutor();
        sampler.scheduleAtFixedRate(() -> peak.accumulateAndGet(mx.getThreadCount(), Math::max), 0, 20, TimeUnit.MILLISECONDS);
        work.run();
        sampler.shutdownNow();
        return peak.get();
    }

    static long run(ExecutorService ex, int tasks, Runnable body) throws Exception {
        long t0 = System.nanoTime();
        try (ex) {
            for (int i = 0; i < tasks; i++) ex.submit(body);
        } // close() 는 모든 작업이 끝날 때까지 기다린다
        return (System.nanoTime() - t0) / 1_000_000;
    }

    public static void main(String[] args) throws Exception {
        int n = 10_000;
        Runnable sleep100 = () -> { try { Thread.sleep(100); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } };
        System.out.println("CPUS " + Runtime.getRuntime().availableProcessors());
        // 워밍업
        run(Executors.newVirtualThreadPerTaskExecutor(), 1000, sleep100);

        long[] ms = new long[1];
        int pPeak = peakPlatformThreads(() -> { try { ms[0] = run(Executors.newFixedThreadPool(200), n, sleep100); } catch (Exception e) { throw new RuntimeException(e); } });
        System.out.printf("RUN platform-200 %d %d %d%n", n, ms[0], pPeak);
        int vPeak = peakPlatformThreads(() -> { try { ms[0] = run(Executors.newVirtualThreadPerTaskExecutor(), n, sleep100); } catch (Exception e) { throw new RuntimeException(e); } });
        System.out.printf("RUN virtual %d %d %d%n", n, ms[0], vPeak);

        // 피닝: synchronized 안에서 블로킹하면 가상 스레드가 캐리어(플랫폼 스레드)를 놓지 못한다 (JDK 21)
        int m = 400;
        Runnable pinned = () -> { Object lock = new Object(); synchronized (lock) { try { Thread.sleep(100); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } } };
        Runnable unpinned = () -> { ReentrantLock lock = new ReentrantLock(); lock.lock(); try { Thread.sleep(100); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } finally { lock.unlock(); } };
        long pin = run(Executors.newVirtualThreadPerTaskExecutor(), m, pinned);
        System.out.printf("RUN virtual-synchronized %d %d 0%n", m, pin);
        long unpin = run(Executors.newVirtualThreadPerTaskExecutor(), m, unpinned);
        System.out.printf("RUN virtual-reentrantlock %d %d 0%n", m, unpin);
    }
}
`;

export const javaVirtualThreads: ShellExperiment = {
  id: "java-virtual-threads",
  subject: "java",
  title: "가상 스레드: 1만 개의 블로킹 작업, 그리고 synchronized 피닝",
  category: "동시성",
  summary: "100ms 씩 블로킹하는 작업 1만 개를 플랫폼 스레드 풀(200)과 가상 스레드로 각각 실행해 총 시간과 OS 스레드 수를 비교하고, 가상 스레드 안에서 synchronized 블록 안에 블로킹하면 캐리어를 놓지 못해(피닝) ReentrantLock 버전보다 수십 배 느려지는 것을 본다",
  notes: ["13-virtual-threads-structured", "12-executors-completablefuture"],
  description: `
가상 스레드는 JVM 이 관리하는 가벼운 스레드다. 블로킹 호출(sleep·소켓 읽기)을 만나면 **캐리어(플랫폼 스레드)에서 내려가고** 캐리어는 다른 가상 스레드를 실행한다. 그래서 동시에 수만 개가 "블로킹" 해도 OS 스레드는 CPU 코어 수만큼만 쓴다.
JDK 21 에서는 \`synchronized\` 블록 안에서 블로킹하면 가상 스레드가 캐리어에 **고정(피닝)** 된다. 그러면 동시에 진행할 수 있는 수가 캐리어 수(=코어 수)로 떨어진다.
`,
  code: `docker run --rm -v "$PWD":/w -w /w eclipse-temurin:21-jdk java VThreads.java
# RUN <방식> <작업 수> <총 ms> <최대 플랫폼 스레드 수>
# 피닝 위치를 보려면: java -Djdk.tracePinnedThreads=short VThreads.java`,
  requires: requiresJdk,
  cleanup: (ctx) => rmContainers(ctx, ["lab-java-vthreads"]),
  async run(ctx) {
    await ensureImage(ctx);
    const r = await withSources({ "VThreads.java": VTHREADS_SRC }, (dir) => runJava(ctx, dir, "lab-java-vthreads", "VThreads.java", [], [], "docker run eclipse-temurin:21-jdk java VThreads.java", 120));
    const cpus = Number(/CPUS (\d+)/.exec(r.out)?.[1] ?? 0);
    const runs = Object.fromEntries(lines(r.out, "RUN").map(([k, n, ms, th]) => [k, { n: Number(n), ms: Number(ms), threads: Number(th) }]));
    const p = runs["platform-200"], v = runs["virtual"], pin = runs["virtual-synchronized"], unpin = runs["virtual-reentrantlock"];
    ctx.table(`100ms 블로킹 작업 (컨테이너가 보는 CPU ${cpus}개)`, ["방식", "작업 수", "총 시간", "최대 플랫폼 스레드"], [
      ["고정 스레드 풀 200", String(p.n), `${p.ms} ms`, String(p.threads)],
      ["가상 스레드", String(v.n), `${v.ms} ms`, String(v.threads)],
      ["가상 스레드 + synchronized 안에서 sleep (피닝)", String(pin.n), `${pin.ms} ms`, "-"],
      ["가상 스레드 + ReentrantLock 안에서 sleep", String(unpin.n), `${unpin.ms} ms`, "-"],
    ]);
    ctx.check("스레드 풀 200 은 1만 작업을 50번에 나눠 처리해 약 5초 (n/200 × 100ms)", p.ms > 4000);
    ctx.check("가상 스레드는 1만 작업을 거의 한 번에 처리한다 (1초 미만)", v.ms < 1000);
    ctx.check("가상 스레드는 OS 스레드를 적게 쓴다 (풀 200 보다 적은 최대 플랫폼 스레드)", v.threads < p.threads);
    ctx.check("synchronized 안의 블로킹은 캐리어를 붙잡아(피닝) ReentrantLock 버전보다 훨씬 느리다", pin.ms > unpin.ms * 5);
    ctx.note(`피닝 시간 ≈ 작업 수 / 캐리어 수(=CPU ${cpus}) × 100ms = ${Math.round((pin.n / Math.max(cpus, 1)) * 100)}ms 예상. JDK 24(JEP 491)부터는 synchronized 피닝이 대부분 사라지지만, 21 LTS 에서는 블로킹 구간의 락을 ReentrantLock 으로 바꾸는 것이 정석이다.`);
  },
};
