"use server";

import { execLine, type ConsoleResult } from "@/lib/console";

export async function execCommandAction(line: string): Promise<ConsoleResult> {
  if (typeof line !== "string" || line.length > 10_000) {
    return { ok: false, cmd: "", error: "잘못된 입력", ms: 0 };
  }
  return execLine(line);
}
