"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

interface Entry {
  term: string;
  subject: string;
  def: string;
  link?: string;
}
interface SubjectMeta {
  id: string;
  name: string;
  mark: string;
  color: string;
}

export function GlossaryList({ entries, subjects }: { entries: Entry[]; subjects: SubjectMeta[] }) {
  const [q, setQ] = useState("");
  const [subject, setSubject] = useState<string>("all");
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return entries.filter((e) => (subject === "all" || e.subject === subject) && (!t || e.term.toLowerCase().includes(t) || e.def.toLowerCase().includes(t)));
  }, [entries, q, subject]);
  const groups = subjects.filter((s) => filtered.some((e) => e.subject === s.id));
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="용어나 설명으로 필터" className="min-w-[220px] flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-muted" />
        <select value={subject} onChange={(e) => setSubject(e.target.value)} className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm">
          <option value="all">모든 주제</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="self-center text-xs text-muted">{filtered.length}개</span>
      </div>
      {groups.map((s) => (
        <section key={s.id} className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <span className={`grid h-5 w-5 place-items-center rounded text-[10px] font-bold text-white ${s.color}`}>{s.mark}</span>
            {s.name}
          </h2>
          <dl className="divide-y divide-border rounded-lg border border-border bg-surface">
            {filtered
              .filter((e) => e.subject === s.id)
              .map((e) => (
                <div key={e.term} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[220px_1fr]">
                  <dt className="font-medium">{e.link ? <Link href={e.link} className="hover:underline">{e.term}</Link> : e.term}</dt>
                  <dd className="text-sm text-muted">{e.def}</dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
      {filtered.length === 0 && <p className="text-sm text-muted">일치하는 용어가 없습니다.</p>}
    </div>
  );
}
