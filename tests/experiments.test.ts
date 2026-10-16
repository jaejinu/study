import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experiments } from "@/experiments";
import { runExperiment } from "@/experiments/runner";
import { ensureConnected, getRedis } from "@/lib/redis";

/**
 * 모든 실험을 실제 Redis 에 대해 실행한다.
 * 각 실험은 내부에서 rec.check() 로 기대값을 검증하며, 실패 시 예외를 던진다.
 *   pnpm redis   (별도 터미널)
 *   pnpm test
 */
beforeAll(async () => {
  try {
    await ensureConnected(getRedis());
  } catch (e) {
    throw new Error(`Redis 에 연결할 수 없습니다. 먼저 \`pnpm redis\` 로 서버를 띄우세요. (${(e as Error).message})`);
  }
});

afterAll(async () => {
  await getRedis().quit();
});

describe("Redis 실험", () => {
  for (const exp of experiments) {
    it(`[${exp.category}] ${exp.title} (${exp.id})`, async () => {
      const result = await runExperiment(exp.id);
      const failed = result.steps.filter((s) => s.error);
      expect(result.error, failed.map((s) => `${s.cmd} → ${JSON.stringify(s.result)}`).join("\n")).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.steps.length).toBeGreaterThan(0);
    });
  }
});
