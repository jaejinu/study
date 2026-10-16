import type Redis from "ioredis";
import { createRedis, ensureConnected, getRedis } from "@/lib/redis";
import { createRecorder } from "@/lib/trace";
import { getExperiment } from "./index";
import type { ExperimentResult } from "./types";

export const LAB_PREFIX = "lab:";

export async function deleteByPattern(client: Redis, pattern: string): Promise<number> {
  let cursor = "0";
  let deleted = 0;
  do {
    const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (keys.length) deleted += await client.del(...keys);
  } while (cursor !== "0");
  return deleted;
}

export async function runExperiment(id: string): Promise<ExperimentResult> {
  const exp = getExperiment(id);
  const ranAt = new Date().toISOString();
  if (!exp) return { id, ok: false, steps: [], durationMs: 0, error: `실험을 찾을 수 없음: ${id}`, ranAt };

  const rec = createRecorder();
  const base = getRedis();
  const extra: Redis[] = [];
  const prefix = `${LAB_PREFIX}${id}:`;
  const t0 = performance.now();

  try {
    if (exp.requires) {
      const problem = await exp.requires();
      if (problem) return { id, ok: false, steps: [], durationMs: 0, error: problem, ranAt };
    }
    await ensureConnected(base);
    await deleteByPattern(base, `${prefix}*`);
    await exp.run({
      redis: rec.wrap(base),
      raw: base,
      rec,
      k: (name) => `${prefix}${name}`,
      newClient: async (alias, options) => {
        const c = createRedis(options);
        await ensureConnected(c);
        extra.push(c);
        return rec.wrap(c, alias);
      },
    });
    return { id, ok: true, steps: rec.steps, durationMs: Math.round(performance.now() - t0), ranAt };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { id, ok: false, steps: rec.steps, durationMs: Math.round(performance.now() - t0), error: message, ranAt };
  } finally {
    await Promise.allSettled(extra.map((c) => c.quit().catch(() => c.disconnect())));
    try {
      if (base.status === "ready") await deleteByPattern(base, `${prefix}*`);
    } catch {
      /* 정리 실패는 무시 */
    }
  }
}
