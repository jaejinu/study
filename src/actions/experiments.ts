"use server";

import { runExperiment } from "@/experiments/runner";
import type { ExperimentResult } from "@/experiments/types";
import { logger } from "@/lib/log";

export async function runExperimentAction(id: string): Promise<ExperimentResult> {
  const r = await runExperiment(id);
  logger[r.ok ? "info" : "warn"]("experiment.run", { subject: "redis", experiment: id, ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, error: r.error });
  return r;
}
