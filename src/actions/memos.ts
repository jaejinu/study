"use server";

import { revalidatePath } from "next/cache";
import { addMemo, deleteMemo, type Memo } from "@/lib/memos";

const ID = /^[a-z0-9-]+$/;

export async function addMemoAction(subject: string, slug: string, quote: string, text: string): Promise<{ ok: boolean; memo?: Memo; error?: string }> {
  if (!ID.test(subject) || !ID.test(slug)) return { ok: false, error: "잘못된 식별자" };
  if (!text.trim() && !quote.trim()) return { ok: false, error: "내용이 없습니다" };
  try {
    const memo = await addMemo(subject, slug, quote.trim(), text.trim());
    revalidatePath("/memos");
    return { ok: true, memo };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function deleteMemoAction(subject: string, slug: string, id: string): Promise<{ ok: boolean }> {
  if (!ID.test(subject) || !ID.test(slug) || !/^[a-z0-9-]+$/i.test(id)) return { ok: false };
  try {
    await deleteMemo(subject, slug, id);
    revalidatePath("/memos");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
