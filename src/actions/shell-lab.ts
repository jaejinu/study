"use server";

import { getShellExperiment } from "@/shell-lab";
import { runShellExperiment } from "@/shell-lab/runner";
import type { ShellResult } from "@/shell-lab/types";
import { markLabDone } from "@/lib/progress";
import { logger } from "@/lib/log";
import { metrics, timed } from "@/lib/metrics";

export async function runShellExperimentAction(subject: string, id: string): Promise<ShellResult> {
  const r = await timed("experiment.run", () => runShellExperiment(getShellExperiment(subject, id), id), (x) => x.ok);
  metrics.experimentRuns.inc({ subject, experiment: id, outcome: r.ok ? "ok" : "error" });
  metrics.experimentDuration.observe({ subject, experiment: id }, r.durationMs / 1000);
  if (r.ok) await markLabDone(subject, id);
  logger[r.ok ? "info" : "warn"]("experiment.run", { subject, experiment: id, ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, error: r.error });
  return r;
}
