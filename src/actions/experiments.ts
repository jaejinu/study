"use server";

import { runExperiment } from "@/experiments/runner";
import type { ExperimentResult } from "@/experiments/types";
import { logger } from "@/lib/log";
import { metrics, timed } from "@/lib/metrics";

export async function runExperimentAction(id: string): Promise<ExperimentResult> {
  const r = await timed("experiment.run", () => runExperiment(id), (x) => x.ok);
  metrics.experimentRuns.inc({ subject: "redis", experiment: id, outcome: r.ok ? "ok" : "error" });
  metrics.experimentDuration.observe({ subject: "redis", experiment: id }, r.durationMs / 1000);
  logger[r.ok ? "info" : "warn"]("experiment.run", { subject: "redis", experiment: id, ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, error: r.error });
  return r;
}
