"use server";

import { getCodeExperiment } from "@/code-lab";
import { runCodeExperiment } from "@/code-lab/runner";
import type { CodeResult } from "@/code-lab/types";
import { markLabDone } from "@/lib/progress";
import { countChecks, recordLabRun } from "@/lib/lab-history";
import { logger } from "@/lib/log";
import { metrics, timed } from "@/lib/metrics";
import { isReadOnly, READ_ONLY_MESSAGE } from "@/lib/read-only";

export async function runCodeExperimentAction(subject: string, id: string): Promise<CodeResult> {
  if (isReadOnly()) return { id, ok: false, steps: [], durationMs: 0, error: READ_ONLY_MESSAGE, ranAt: new Date().toISOString() };
  const r = await timed("experiment.run", () => runCodeExperiment(getCodeExperiment(subject, id), id), (x) => x.ok);
  metrics.experimentRuns.inc({ subject, experiment: id, outcome: r.ok ? "ok" : "error" });
  metrics.experimentDuration.observe({ subject, experiment: id }, r.durationMs / 1000);
  if (r.ok) await markLabDone(subject, id);
  const c = countChecks(r.steps);
  await recordLabRun(subject, id, { ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, checks: c.checks, failedChecks: c.failed, error: r.error });
  logger[r.ok ? "info" : "warn"]("experiment.run", { subject, experiment: id, ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, error: r.error });
  return r;
}
