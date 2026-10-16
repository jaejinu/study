"use server";

import { runExperiment } from "@/experiments/runner";
import type { ExperimentResult } from "@/experiments/types";
import { logger } from "@/lib/log";
import { metrics, timed } from "@/lib/metrics";
import { countChecks, recordLabRun } from "@/lib/lab-history";
import { isReadOnly, READ_ONLY_MESSAGE } from "@/lib/read-only";

export async function runExperimentAction(id: string): Promise<ExperimentResult> {
  if (isReadOnly()) return { id, ok: false, steps: [], durationMs: 0, error: READ_ONLY_MESSAGE, ranAt: new Date().toISOString() };
  const r = await timed("experiment.run", () => runExperiment(id), (x) => x.ok);
  metrics.experimentRuns.inc({ subject: "redis", experiment: id, outcome: r.ok ? "ok" : "error" });
  metrics.experimentDuration.observe({ subject: "redis", experiment: id }, r.durationMs / 1000);
  const c = countChecks(r.steps as { cmd: string; ok?: boolean; error?: boolean }[]);
  await recordLabRun("redis", id, { ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, checks: c.checks, failedChecks: c.failed, error: r.error });
  logger[r.ok ? "info" : "warn"]("experiment.run", { subject: "redis", experiment: id, ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, error: r.error });
  return r;
}
