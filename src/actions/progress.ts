"use server";

import { revalidatePath } from "next/cache";
import { setCheck, setRead } from "@/lib/progress";
import { logger } from "@/lib/log";

const ID = /^[a-z0-9-]+$/;

export async function toggleReadAction(subject: string, slug: string, on: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!ID.test(subject) || !ID.test(slug)) return { ok: false, error: "잘못된 식별자" };
  try {
    await setRead(subject, slug, on);
    logger.info("progress.read", { subject, slug, on });
    revalidatePath(`/${subject}`);
    revalidatePath(`/${subject}/notes`);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function toggleCheckAction(subject: string, slug: string, line: number, on: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!ID.test(subject) || !ID.test(slug) || !Number.isInteger(line)) return { ok: false, error: "잘못된 식별자" };
  try {
    await setCheck(subject, slug, line, on);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
