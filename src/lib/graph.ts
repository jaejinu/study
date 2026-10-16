import { getNote, listNotes } from "./notes";
import { subjects } from "./subjects";
import { experiments } from "@/experiments";
import { listLab } from "@/lab/registry";

export interface GraphNode {
  id: string;
  kind: "note" | "lab";
  subject: string;
  title: string;
  href: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  kind: "note-note" | "note-lab";
}

/** 노트 본문의 내부 링크와 frontmatter 의 실험 참조로 그래프를 만든다 */
export async function buildGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const add = (n: GraphNode) => {
    if (!nodeIds.has(n.id)) {
      nodeIds.add(n.id);
      nodes.push(n);
    }
  };
  for (const s of subjects) {
    for (const m of await listNotes(s.id)) add({ id: `note:${s.id}/${m.slug}`, kind: "note", subject: s.id, title: m.title, href: `/${s.id}/notes/${m.slug}` });
    const labs = s.id === "redis" ? experiments.map((e) => ({ id: e.id, title: e.title })) : listLab(s.id);
    for (const e of labs) add({ id: `lab:${s.id}/${e.id}`, kind: "lab", subject: s.id, title: e.title, href: `/${s.id}/lab/${e.id}` });
  }
  const seen = new Set<string>();
  for (const s of subjects) {
    for (const m of await listNotes(s.id)) {
      const from = `note:${s.id}/${m.slug}`;
      const note = await getNote(s.id, m.slug);
      if (!note) continue;
      for (const eid of m.experiments) {
        const to = `lab:${s.id}/${eid}`;
        if (nodeIds.has(to) && !seen.has(from + to)) {
          seen.add(from + to);
          edges.push({ from, to, kind: "note-lab" });
        }
      }
      for (const match of note.content.matchAll(/\]\(\/([a-z0-9-]+)\/notes\/([a-z0-9-]+)\)/g)) {
        const to = `note:${match[1]}/${match[2]}`;
        if (nodeIds.has(to) && to !== from && !seen.has(from + to)) {
          seen.add(from + to);
          edges.push({ from, to, kind: "note-note" });
        }
      }
      for (const match of note.content.matchAll(/\]\(\/([a-z0-9-]+)\/lab\/([a-z0-9-]+)\)/g)) {
        const to = `lab:${match[1]}/${match[2]}`;
        if (nodeIds.has(to) && !seen.has(from + to)) {
          seen.add(from + to);
          edges.push({ from, to, kind: "note-lab" });
        }
      }
    }
  }
  return { nodes, edges };
}
