"use server";

import { execLine, type ConsoleResult } from "@/lib/console";
import { logger } from "@/lib/log";

export async function execCommandAction(line: string): Promise<ConsoleResult> {
  if (typeof line !== "string" || line.length > 10_000) {
    return { ok: false, cmd: "", error: "잘못된 입력", ms: 0 };
  }
  const r = await execLine(line);
  logger[r.ok ? "info" : "warn"]("console.exec", { cmd: r.cmd.split(" ")[0]?.toUpperCase(), ok: r.ok, ms: r.ms, error: r.error });
  return r;
}
