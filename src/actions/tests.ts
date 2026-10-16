"use server";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { REPORT_PATH, readLastReport, type TestReport } from "@/lib/report";

export interface RunTestsResult {
  ok: boolean;
  report: TestReport | null;
  output: string;
  error?: string;
}

/** 브라우저에서 vitest 를 실행하고 JSON 리포트를 갱신한다 */
export async function runTestsAction(): Promise<RunTestsResult> {
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const cwd = process.cwd();
  const output = await new Promise<string>((resolve) => {
    execFile(
      "pnpm",
      ["exec", "vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${REPORT_PATH}`],
      { cwd, timeout: 120_000, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolve(`${stdout}\n${stderr}${err && !stdout ? `\n${err.message}` : ""}`.trim()),
    );
  });
  const report = await readLastReport();
  revalidatePath("/redis/tests");
  revalidatePath("/redis");
  return { ok: report?.success ?? false, report, output, error: report ? undefined : "리포트를 생성하지 못했습니다" };
}
