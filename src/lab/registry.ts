import { experiments as redisExperiments } from "@/experiments";
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

const SHELL = new Set(["docker", "kubernetes", "linux-network", "observability", "security", "iac", "performance", "sre", "ebpf", "finops", "os-internals", "nginx", "github-actions"]);
const CODE = new Set(["kafka", "postgres", "ai-systems", "chaos", "observability", "opensearch", "db-internals", "api-design", "messaging", "mlops", "testing", "distributed-systems", "ai-agents", "clickhouse", "data-engineering"]);

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

/**
 * 실험 id 로 실험을 찾는다. 노트의 frontmatter experiments 는 다른 주제의 실험을 "증거" 로 참조할 수 있다
 * (예: 아키텍처 노트 → chaos·redis·postgres 실험). 우선 그 주제, 다음 Redis 실험, 마지막으로 모든 주제에서 찾는다.
 */
export function findExperiment(id: string, preferSubject?: string): { id: string; title: string; summary: string; subject: string; href: string } | undefined {
  if (preferSubject && preferSubject !== "redis") {
    const e = getLab(preferSubject, id);
    if (e) return { id: e.id, title: e.title, summary: e.summary, subject: preferSubject, href: `/${preferSubject}/lab/${e.id}` };
  }
  const r = redisExperiments.find((x) => x.id === id);
  if (r) return { id: r.id, title: r.title, summary: r.summary, subject: "redis", href: `/redis/lab/${r.id}` };
  for (const s of [...SHELL, ...CODE]) {
    const e = getLab(s, id);
    if (e) return { id: e.id, title: e.title, summary: e.summary, subject: s, href: `/${s}/lab/${e.id}` };
  }
  return undefined;
}
