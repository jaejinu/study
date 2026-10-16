"use server";

import { getShellExperiment } from "@/shell-lab";
import { runShellExperiment } from "@/shell-lab/runner";
import type { ShellResult } from "@/shell-lab/types";

export async function runShellExperimentAction(subject: string, id: string): Promise<ShellResult> {
  return runShellExperiment(getShellExperiment(subject, id), id);
}
