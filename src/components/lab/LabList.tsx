"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export interface LabCard {
  id: string;
  title: string;
  summary: string;
  category: string;
  href: string;
  done: boolean;
}

type Status = "all" | "todo" | "done";

/** 실험 목록: 카테고리 칩 + 완료 여부 필터. 전체일 땐 카테고리별로 묶어서 보여 준다 */
export function LabList({ items, categories }: { items: LabCard[]; categories: string[] }) {
  const [cat, setCat] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("all");
  const filtered = useMemo(() => items.filter((e) => (!cat || e.category === cat) && (status === "all" || (status === "done" ? e.done : !e.done))), [items, cat, status]);
  const groups = cat ? [cat] : categories;
  const doneCount = items.filter((e) => e.done).length;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2" role="toolbar" aria-label="실험 필터">
        <Chip active={!cat} onClick={() => setCat(null)}>
          전체 <span className="opacity-60">{items.length}</span>
        </Chip>
        {categories.map((c) => (
          <Chip key={c} active={cat === c} onClick={() => setCat(cat === c ? null : c)}>
            {c} <span className="opacity-60">{items.filter((e) => e.category === c).length}</span>
          </Chip>
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <div className="inline-flex overflow-hidden rounded-md border border-border text-[12px]" role="group" aria-label="완료 여부">
          {(
            [
              ["all", "모두"],
              ["todo", `안 한 것 ${items.length - doneCount}`],
              ["done", `성공 ${doneCount}`],
            ] as const
          ).map(([v, label]) => (
            <button key={v} onClick={() => setStatus(v)} aria-pressed={status === v} className={`px-2.5 py-1 ${status === v ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          {status === "done" ? "아직 성공한 실험이 없습니다. '안 한 것' 에서 하나 골라 실행해 보세요." : status === "todo" ? "이 조건의 실험은 모두 성공했습니다 ✓" : "조건에 맞는 실험이 없습니다."}
        </div>
      )}

      {groups.map((g) => {
        const list = filtered.filter((e) => e.category === g);
        if (!list.length) return null;
        return (
          <section key={g} className="mb-8">
            {!cat && <h2 className="mb-2 text-sm font-semibold tracking-wide text-muted">{g}</h2>}
            <ul className="grid gap-2 sm:grid-cols-2">
              {list.map((e) => (
                <li key={e.id}>
                  <Link href={e.href} className={`flex h-full flex-col rounded-lg border bg-surface p-3.5 transition-colors hover:border-muted ${e.done ? "border-ok/30" : "border-border"}`}>
                    <div className="flex items-start gap-2 text-sm font-medium">
                      <span className={`mt-px shrink-0 ${e.done ? "text-ok" : "text-muted"}`} aria-label={e.done ? "성공" : "아직 안 함"}>
                        {e.done ? "✓" : "⚗"}
                      </span>
                      <span>{e.title}</span>
                    </div>
                    <div className="clamp-3 mt-1.5 flex-1 text-[13px] leading-relaxed text-foreground/75">{e.summary}</div>
                    <div className="mt-2 font-mono text-[11px] text-muted/80">{e.id}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={active} className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${active ? "border-accent/50 bg-accent-soft text-foreground" : "border-border text-muted hover:border-muted hover:text-foreground"}`}>
      {children}
    </button>
  );
}
