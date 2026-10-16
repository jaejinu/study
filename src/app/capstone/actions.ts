"use server";

import { revalidatePath } from "next/cache";
import { savePostmortem, startCapstone, verifyCapstoneStep } from "@/lib/drills/capstone";
import { logger } from "@/lib/log";

export async function verifyStepAction(projectId: string, stepId: string) {
  const t0 = performance.now();
  const res = await verifyCapstoneStep(projectId, stepId);
  logger.info("capstone.verify", { project: projectId, step: stepId, ok: res.ok, ms: Math.round(performance.now() - t0) });
  revalidatePath(`/capstone/${projectId}`);
  revalidatePath("/capstone");
  return res;
}

export async function savePostmortemAction(projectId: string, text: string) {
  await savePostmortem(projectId, text);
  revalidatePath(`/capstone/${projectId}`);
  return { ok: true };
}

export async function restartCapstoneAction(projectId: string) {
  await startCapstone(projectId, true);
  revalidatePath(`/capstone/${projectId}`);
  revalidatePath("/capstone");
  return { ok: true };
}
