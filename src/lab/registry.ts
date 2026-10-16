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

const SHELL = new Set(["docker", "kubernetes", "linux-network", "observability"]);
const CODE = new Set(["kafka", "postgres", "ai-systems"]);

export function hasLab(subject: string): boolean {
  return SHELL.has(subject) || CODE.has(subject);
}

export function listLab(subject: string): LabItem[] {
  if (SHELL.has(subject)) return listShellExperiments(subject as "docker").map((e) => ({ kind: "shell", ...e }));
  if (CODE.has(subject)) return listCodeExperiments(subject).map((e) => ({ kind: "code", ...e }));
  return [];
}

export function getLab(subject: string, id: string): LabItem | undefined {
  if (SHELL.has(subject)) {
    const e = getShellExperiment(subject, id);
    return e && { kind: "shell", ...e };
  }
  if (CODE.has(subject)) {
    const e = getCodeExperiment(subject, id);
    return e && { kind: "code", ...e };
  }
  return undefined;
}

export function labCategories(subject: string): string[] {
  return [...new Set(listLab(subject).map((e) => e.category))];
}
