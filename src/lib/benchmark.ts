import { execFile } from "node:child_process";
import { REDIS_URL } from "./redis";

export interface BenchRow {
  test: string;
  rps: number;
  avgMs: number;
  p50: number;
  p99: number;
}
export interface BenchResult {
  ok: boolean;
  error?: string;
  requests: number;
  clients: number;
  series: { label: string; pipeline: number; rows: BenchRow[] }[];
  ranAt: string;
}

const TESTS = "set,get,incr,lpush,rpop,sadd,hset,zadd";

function hostPort(): [string, string] {
  try {
    const u = new URL(REDIS_URL);
    return [u.hostname || "127.0.0.1", u.port || "6379"];
  } catch {
    return ["127.0.0.1", "6379"];
  }
}

function parseCsv(out: string): BenchRow[] {
  // "test","rps","avg_latency_ms","min_latency_ms","p50_latency_ms","p95_latency_ms","p99_latency_ms","max_latency_ms"
  return out
    .split("\n")
    .filter((l) => l.startsWith('"') && !l.startsWith('"test"'))
    .map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "")))
    .map((c) => ({ test: c[0], rps: Number(c[1]), avgMs: Number(c[2]), p50: Number(c[4] ?? 0), p99: Number(c[6] ?? 0) }));
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("redis-benchmark", args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(/ENOENT/.test(err.message) ? "redis-benchmark 가 없습니다 (brew install redis 에 포함)" : stderr || err.message));
      else resolve(stdout);
    });
  });
}

export async function runBenchmark(requests = 20_000, clients = 20): Promise<BenchResult> {
  const [host, port] = hostPort();
  const ranAt = new Date().toISOString();
  try {
    const series = [];
    for (const pipeline of [1, 16]) {
      const out = await run(["-h", host, "-p", port, "-q", "--csv", "-n", String(requests), "-c", String(clients), "-P", String(pipeline), "-t", TESTS]);
      series.push({ label: pipeline === 1 ? "파이프라인 없음 (-P 1)" : "파이프라인 16 (-P 16)", pipeline, rows: parseCsv(out) });
    }
    return { ok: true, requests, clients, series, ranAt };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), requests, clients, series: [], ranAt };
  }
}
