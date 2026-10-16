"use server";

import { getCodeExperiment } from "@/code-lab";
import { runCodeExperiment } from "@/code-lab/runner";
import type { CodeResult } from "@/code-lab/types";
import { markLabDone } from "@/lib/progress";
import { logger } from "@/lib/log";
import { metrics, timed } from "@/lib/metrics";

export async function runCodeExperimentAction(subject: string, id: string): Promise<CodeResult> {
  const r = await timed("experiment.run", () => runCodeExperiment(getCodeExperiment(subject, id), id), (x) => x.ok);
  metrics.experimentRuns.inc({ subject, experiment: id, outcome: r.ok ? "ok" : "error" });
  metrics.experimentDuration.observe({ subject, experiment: id }, r.durationMs / 1000);
  if (r.ok) await markLabDone(subject, id);
  logger[r.ok ? "info" : "warn"]("experiment.run", { subject, experiment: id, ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, error: r.error });
  return r;
}
