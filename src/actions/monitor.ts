"use server";

import { runBenchmark, type BenchResult } from "@/lib/benchmark";
import { getSnapshot, type Snapshot } from "@/lib/monitor";
import { isReadOnly, READ_ONLY_MESSAGE } from "@/lib/read-only";

export async function getSnapshotAction(): Promise<Snapshot> {
  // 공개판: getRedis() 가 연결하지 않는 클라이언트라 getSnapshot 은 즉시 ok:false 를 돌려준다 (INFO·SLOWLOG 비노출)
  return getSnapshot();
}

export async function runBenchmarkAction(requests: number, clients: number): Promise<BenchResult> {
  if (isReadOnly()) return { ok: false, error: READ_ONLY_MESSAGE, requests: 0, clients: 0, series: [], ranAt: new Date().toISOString() };
  const n = Math.min(Math.max(Math.round(requests), 1000), 200_000);
  const c = Math.min(Math.max(Math.round(clients), 1), 100);
  return runBenchmark(n, c);
}
