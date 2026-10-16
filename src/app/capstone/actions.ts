"use server";

import { revalidatePath } from "next/cache";
import { savePostmortem, startCapstone, verifyCapstoneStep, type StepResult } from "@/lib/drills/capstone";
import { logger } from "@/lib/log";
import { isReadOnly, READ_ONLY_MESSAGE } from "@/lib/read-only";

export async function verifyStepAction(projectId: string, stepId: string): Promise<StepResult> {
  if (isReadOnly()) return { ok: false, detail: READ_ONLY_MESSAGE };
  const t0 = performance.now();
  const res = await verifyCapstoneStep(projectId, stepId);
  logger.info("capstone.verify", { project: projectId, step: stepId, ok: res.ok, ms: Math.round(performance.now() - t0) });
  revalidatePath(`/capstone/${projectId}`);
  revalidatePath("/capstone");
  return res;
}

export async function savePostmortemAction(projectId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (isReadOnly()) return { ok: false, error: READ_ONLY_MESSAGE };
  await savePostmortem(projectId, text);
  revalidatePath(`/capstone/${projectId}`);
  return { ok: true };
}

export async function restartCapstoneAction(projectId: string): Promise<{ ok: boolean; error?: string }> {
  if (isReadOnly()) return { ok: false, error: READ_ONLY_MESSAGE };
  await startCapstone(projectId, true);
  revalidatePath(`/capstone/${projectId}`);
  revalidatePath("/capstone");
  return { ok: true };
}
