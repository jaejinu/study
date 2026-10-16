"use server";

import { getShellExperiment } from "@/shell-lab";
import { runShellExperiment } from "@/shell-lab/runner";
import type { ShellResult } from "@/shell-lab/types";
import { markLabDone } from "@/lib/progress";
import { countChecks, recordLabRun } from "@/lib/lab-history";
import { logger } from "@/lib/log";
import { metrics, timed } from "@/lib/metrics";
import { isReadOnly, READ_ONLY_MESSAGE } from "@/lib/read-only";

export async function runShellExperimentAction(subject: string, id: string): Promise<ShellResult> {
  if (isReadOnly()) return { id, ok: false, steps: [], durationMs: 0, error: READ_ONLY_MESSAGE, ranAt: new Date().toISOString() };
  const r = await timed("experiment.run", () => runShellExperiment(getShellExperiment(subject, id), id), (x) => x.ok);
  metrics.experimentRuns.inc({ subject, experiment: id, outcome: r.ok ? "ok" : "error" });
  metrics.experimentDuration.observe({ subject, experiment: id }, r.durationMs / 1000);
  if (r.ok) await markLabDone(subject, id);
  const c = countChecks(r.steps);
  await recordLabRun(subject, id, { ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, checks: c.checks, failedChecks: c.failed, error: r.error });
  logger[r.ok ? "info" : "warn"]("experiment.run", { subject, experiment: id, ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, error: r.error });
  return r;
}
