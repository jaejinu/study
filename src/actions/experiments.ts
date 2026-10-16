"use server";

import { runExperiment } from "@/experiments/runner";
import type { ExperimentResult } from "@/experiments/types";

export async function runExperimentAction(id: string): Promise<ExperimentResult> {
  return runExperiment(id);
}
