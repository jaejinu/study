"use server";

import { getCodeExperiment } from "@/code-lab";
import { runCodeExperiment } from "@/code-lab/runner";
import type { CodeResult } from "@/code-lab/types";
import { markLabDone } from "@/lib/progress";
import { logger } from "@/lib/log";

export async function runCodeExperimentAction(subject: string, id: string): Promise<CodeResult> {
  const r = await runCodeExperiment(getCodeExperiment(subject, id), id);
  if (r.ok) await markLabDone(subject, id);
  logger[r.ok ? "info" : "warn"]("experiment.run", { subject, experiment: id, ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, error: r.error });
  return r;
}
