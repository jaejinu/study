"use server";

import { execLine, type ConsoleResult } from "@/lib/console";
import { logger } from "@/lib/log";
import { metrics, timed } from "@/lib/metrics";

export async function execCommandAction(line: string): Promise<ConsoleResult> {
  if (typeof line !== "string" || line.length > 10_000) {
    return { ok: false, cmd: "", error: "잘못된 입력", ms: 0 };
  }
  const r = await timed("console.exec", () => execLine(line), (x) => x.ok);
  metrics.consoleCommands.inc({ command: r.cmd.split(" ")[0]?.toUpperCase() || "?", outcome: r.ok ? "ok" : "error" });
  logger[r.ok ? "info" : "warn"]("console.exec", { cmd: r.cmd.split(" ")[0]?.toUpperCase(), ok: r.ok, ms: r.ms, error: r.error });
  return r;
}
