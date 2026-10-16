"use server";

import { runBenchmark, type BenchResult } from "@/lib/benchmark";
import { getSnapshot, type Snapshot } from "@/lib/monitor";

export async function getSnapshotAction(): Promise<Snapshot> {
  return getSnapshot();
}

export async function runBenchmarkAction(requests: number, clients: number): Promise<BenchResult> {
  const n = Math.min(Math.max(Math.round(requests), 1000), 200_000);
  const c = Math.min(Math.max(Math.round(clients), 1), 100);
  return runBenchmark(n, c);
}
