"use server";

import { getShellExperiment } from "@/shell-lab";
import { runShellExperiment } from "@/shell-lab/runner";
import type { ShellResult } from "@/shell-lab/types";
import { markLabDone } from "@/lib/progress";
import { logger } from "@/lib/log";

export async function runShellExperimentAction(subject: string, id: string): Promise<ShellResult> {
  const r = await runShellExperiment(getShellExperiment(subject, id), id);
  if (r.ok) await markLabDone(subject, id);
  logger[r.ok ? "info" : "warn"]("experiment.run", { subject, experiment: id, ok: r.ok, durationMs: r.durationMs, steps: r.steps.length, error: r.error });
  return r;
}
