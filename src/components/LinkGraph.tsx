"use client";

import { useMemo, useState } from "react";
import type { GraphEdge, GraphNode } from "@/lib/graph";

interface SubjectMeta {
  id: string;
  name: string;
  hex: string;
}

/** 주제별 클러스터를 큰 원 위에 배치하고, 각 클러스터 안에서 노트(안쪽 원)와 실험(바깥 원)을 둘러 놓는 결정적 레이아웃 */
export function LinkGraph({ nodes, edges, subjects }: { nodes: GraphNode[]; edges: GraphEdge[]; subjects: SubjectMeta[] }) {
  const W = 1100;
  const H = 820;
  const [hover, setHover] = useState<string | null>(null);
  const [onlySubject, setOnlySubject] = useState<string | null>(null);

  const pos = useMemo(() => {
    const p = new Map<string, { x: number; y: number }>();
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.36;
    subjects.forEach((s, si) => {
      const ang = (si / subjects.length) * Math.PI * 2 - Math.PI / 2;
      const scx = cx + R * Math.cos(ang);
      const scy = cy + R * Math.sin(ang);
      const notes = nodes.filter((n) => n.subject === s.id && n.kind === "note");
      const labs = nodes.filter((n) => n.subject === s.id && n.kind === "lab");
      notes.forEach((n, i) => {
        const a = (i / Math.max(1, notes.length)) * Math.PI * 2;
        p.set(n.id, { x: scx + 46 * Math.cos(a), y: scy + 46 * Math.sin(a) });
      });
      labs.forEach((n, i) => {
        const a = (i / Math.max(1, labs.length)) * Math.PI * 2 + 0.2;
        p.set(n.id, { x: scx + 92 * Math.cos(a), y: scy + 92 * Math.sin(a) });
      });
    });
    return p;
  }, [nodes, subjects]);

  const color = (subject: string) => subjects.find((s) => s.id === subject)?.hex ?? "#8b98a9";
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) {
      (m.get(e.from) ?? m.set(e.from, new Set()).get(e.from)!).add(e.to);
      (m.get(e.to) ?? m.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
    return m;
  }, [edges]);
  const visible = (n: GraphNode) => !onlySubject || n.subject === onlySubject || (hover !== null && neighbors.get(hover)?.has(n.id));
  const hoverNode = nodes.find((n) => n.id === hover);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <button onClick={() => setOnlySubject(null)} className={`rounded border px-2 py-1 ${onlySubject === null ? "border-muted text-foreground" : "border-border text-muted"}`}>
          전체
        </button>
        {subjects.map((s) => (
          <button key={s.id} onClick={() => setOnlySubject(s.id === onlySubject ? null : s.id)} className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 ${onlySubject === s.id ? "border-muted text-foreground" : "border-border text-muted"}`}>
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.hex }} />
            {s.name}
          </button>
        ))}
        <span className="self-center text-muted">● 노트 &nbsp; ◆ 실험 &nbsp; 노드 {nodes.length} · 링크 {edges.length}</span>
      </div>
      <div className="relative overflow-hidden rounded-lg border border-border bg-[#0d1117]">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
          {edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const active = hover === e.from || hover === e.to;
            const fromN = nodes.find((n) => n.id === e.from)!;
            const toN = nodes.find((n) => n.id === e.to)!;
            if (!visible(fromN) && !visible(toN)) return null;
            const cross = fromN.subject !== toN.subject;
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={active ? "#e6edf3" : cross ? "#58a6ff" : color(fromN.subject)} strokeOpacity={active ? 0.9 : hover ? 0.08 : cross ? 0.5 : 0.25} strokeWidth={active ? 1.8 : 1} />;
          })}
          {subjects.map((s, si) => {
            const ang = (si / subjects.length) * Math.PI * 2 - Math.PI / 2;
            const R = Math.min(W, H) * 0.36;
            const x = W / 2 + R * Math.cos(ang);
            const y = H / 2 + R * Math.sin(ang);
            return (
              <text key={s.id} x={x} y={y + 4} textAnchor="middle" fontSize="12" fontWeight="600" fill={s.hex} opacity={onlySubject && onlySubject !== s.id ? 0.3 : 0.9}>
                {s.name}
              </text>
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const dim = !visible(n) || (hover && hover !== n.id && !neighbors.get(hover)?.has(n.id));
            const r = n.kind === "note" ? 6 : 5;
            return (
              <a key={n.id} href={n.href} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                {n.kind === "note" ? (
                  <circle cx={p.x} cy={p.y} r={hover === n.id ? r + 2 : r} fill={color(n.subject)} opacity={dim ? 0.2 : 1} stroke="#0d1117" strokeWidth="1.5" />
                ) : (
                  <rect x={p.x - r} y={p.y - r} width={r * 2} height={r * 2} transform={`rotate(45 ${p.x} ${p.y})`} fill={color(n.subject)} opacity={dim ? 0.2 : 0.85} stroke="#0d1117" strokeWidth="1.5" />
                )}
              </a>
            );
          })}
        </svg>
        {hoverNode && (
          <div className="pointer-events-none absolute left-3 top-3 max-w-sm rounded border border-border bg-surface px-3 py-2 text-xs">
            <div className="font-medium">{hoverNode.kind === "note" ? "● " : "◆ "}{hoverNode.title}</div>
            <div className="mt-1 text-muted">연결 {neighbors.get(hoverNode.id)?.size ?? 0}개 · 클릭하면 이동</div>
          </div>
        )}
      </div>
    </div>
  );
}
