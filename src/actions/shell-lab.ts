"use server";

import { getShellExperiment } from "@/shell-lab";
import { runShellExperiment } from "@/shell-lab/runner";
import type { ShellResult } from "@/shell-lab/types";
import { markLabDone } from "@/lib/progress";

export async function runShellExperimentAction(subject: string, id: string): Promise<ShellResult> {
  const r = await runShellExperiment(getShellExperiment(subject, id), id);
  if (r.ok) await markLabDone(subject, id);
  return r;
}
