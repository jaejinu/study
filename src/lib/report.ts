import fs from "node:fs/promises";
import path from "node:path";

export const REPORT_PATH = path.join(process.cwd(), "reports", "vitest.json");

export interface TestCase {
  fullName: string;
  title: string;
  status: "passed" | "failed" | "skipped" | "pending" | "todo";
  duration: number;
  failureMessages: string[];
}

export interface TestReport {
  success: boolean;
  startTime: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  files: { name: string; status: string; tests: TestCase[] }[];
}

interface RawReport {
  success: boolean;
  startTime: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: {
    name: string;
    status: string;
    assertionResults: { fullName: string; title: string; status: TestCase["status"]; duration?: number; failureMessages: string[] }[];
  }[];
}

export function parseReport(raw: string): TestReport {
  const r = JSON.parse(raw) as RawReport;
  return {
    success: r.success,
    startTime: r.startTime,
    numTotalTests: r.numTotalTests,
    numPassedTests: r.numPassedTests,
    numFailedTests: r.numFailedTests,
    numPendingTests: r.numPendingTests,
    files: r.testResults.map((f) => ({
      name: path.relative(process.cwd(), f.name),
      status: f.status,
      tests: f.assertionResults.map((a) => ({
        fullName: a.fullName,
        title: a.title,
        status: a.status,
        duration: Math.round(a.duration ?? 0),
        failureMessages: a.failureMessages ?? [],
      })),
    })),
  };
}

export async function readLastReport(): Promise<TestReport | null> {
  try {
    return parseReport(await fs.readFile(REPORT_PATH, "utf8"));
  } catch {
    return null;
  }
}
