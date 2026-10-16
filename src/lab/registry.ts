import { listCodeExperiments, getCodeExperiment } from "@/code-lab";
import { listShellExperiments, getShellExperiment } from "@/shell-lab";

export interface LabItem {
  kind: "shell" | "code";
  id: string;
  title: string;
  category: string;
  summary: string;
  description: string;
  code: string;
  notes: string[];
}

const SHELL = new Set(["docker", "kubernetes", "linux-network", "observability", "security", "iac", "performance"]);
const CODE = new Set(["kafka", "postgres", "ai-systems", "chaos", "observability"]);

export function hasLab(subject: string): boolean {
  return SHELL.has(subject) || CODE.has(subject);
}

/** 한 주제에 셸 실험과 코드 실험이 함께 있을 수 있다 (예: 관측성) */
export function listLab(subject: string): LabItem[] {
  const shell = SHELL.has(subject) ? listShellExperiments(subject as "docker").map((e) => ({ kind: "shell" as const, ...e })) : [];
  const code = CODE.has(subject) ? listCodeExperiments(subject).map((e) => ({ kind: "code" as const, ...e })) : [];
  return [...shell, ...code];
}

export function getLab(subject: string, id: string): LabItem | undefined {
  if (SHELL.has(subject)) {
    const e = getShellExperiment(subject, id);
    if (e) return { kind: "shell", ...e };
  }
  if (CODE.has(subject)) {
    const e = getCodeExperiment(subject, id);
    if (e) return { kind: "code", ...e };
  }
  return undefined;
}

export function labCategories(subject: string): string[] {
  return [...new Set(listLab(subject).map((e) => e.category))];
}
