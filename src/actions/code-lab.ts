"use server";

import { getCodeExperiment } from "@/code-lab";
import { runCodeExperiment } from "@/code-lab/runner";
import type { CodeResult } from "@/code-lab/types";
import { markLabDone } from "@/lib/progress";

export async function runCodeExperimentAction(subject: string, id: string): Promise<CodeResult> {
  const r = await runCodeExperiment(getCodeExperiment(subject, id), id);
  if (r.ok) await markLabDone(subject, id);
  return r;
}
