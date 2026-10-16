"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { getSubject, subjects } from "@/lib/subjects";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const subject = getSubject(pathname.split("/")[1] ?? "");
  const isActive = (href: string) => (href === `/${subject?.id}` ? pathname === href : pathname.startsWith(href));

  return (
    <>
      <button
        className="fixed left-3 top-3 z-30 rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm md:hidden"
        onClick={() => setOpen((v) => !v)}
        aria-label="메뉴"
      >
        ☰
      </button>
      <aside
        className={`fixed inset-y-0 left-0 z-20 w-64 shrink-0 border-r border-border bg-surface transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">
          <Link href="/" className="flex items-center gap-2.5 border-b border-border px-5 py-5" onClick={() => setOpen(false)}>
            <span className={`grid h-8 w-8 place-items-center rounded-md text-sm font-bold text-white ${subject?.color ?? "bg-surface-2"}`}>
              {subject?.mark ?? "S"}
            </span>
            <div>
              <div className="text-sm font-semibold leading-tight">{subject ? `${subject.name} Study` : "Study"}</div>
              <div className="text-[11px] text-muted">{subject ? "공부 · 정리 · 실험" : "주제를 선택하세요"}</div>
            </div>
          </Link>

          <form
            className="px-3 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) {
                router.push(`/search?q=${encodeURIComponent(q.trim())}`);
                setOpen(false);
              }
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색…  (노트·실험)" className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-muted" />
          </form>
          <nav className="flex-1 space-y-0.5 px-3 py-3">
            {subject ? (
              <>
                {subject.nav.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    onClick={() => setOpen(false)}
                    className={`flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                      isActive(n.href) ? "bg-accent-soft text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground"
                    }`}
                  >
                    <span className={`mt-0.5 w-5 text-center font-mono text-xs ${isActive(n.href) ? "text-accent" : ""}`}>{n.icon}</span>
                    <span>
                      <span className="block font-medium">{n.label}</span>
                      <span className="block text-[11px] text-muted">{n.desc}</span>
                    </span>
                  </Link>
                ))}
                <div className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">다른 주제</div>
                {subjects
                  .filter((s) => s.id !== subject.id)
                  .map((s) => (
                    <Link
                      key={s.id}
                      href={`/${s.id}`}
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-3 rounded-md px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-foreground"
                    >
                      <span className={`grid h-5 w-5 place-items-center rounded text-[10px] font-bold text-white ${s.color}`}>{s.mark}</span>
                      {s.name}
                    </Link>
                  ))}
                <Link href="/" onClick={() => setOpen(false)} className="block rounded-md px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-foreground">
                  ← 주제 선택으로
                </Link>
              </>
            ) : (
              subjects.map((s) => (
                <Link
                  key={s.id}
                  href={`/${s.id}`}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground"
                >
                  <span className={`grid h-6 w-6 place-items-center rounded text-xs font-bold text-white ${s.color}`}>{s.mark}</span>
                  <span>
                    <span className="block font-medium text-foreground">{s.name}</span>
                    <span className="block text-[11px]">{s.tagline}</span>
                  </span>
                </Link>
              ))
            )}
          </nav>

          <div className="flex gap-1 border-t border-border px-3 py-2 text-[11px]">
            {[
              { href: "/assistant", label: "AI 도우미" },
              { href: "/glossary", label: "용어집" },
              { href: "/graph", label: "링크 그래프" },
              { href: "/search", label: "검색" },
            ].map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className={`rounded px-2 py-1 ${pathname.startsWith(l.href) ? "bg-accent-soft text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground"}`}>
                {l.label}
              </Link>
            ))}
          </div>
          {subject && (
            <div className="border-t border-border px-5 py-3 text-[11px] leading-relaxed text-muted">
              {subject.setup.map((s) => (
                <div key={s.cmd}>
                  {s.label}: <code className="text-foreground">{s.cmd}</code>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-10 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}
    </>
  );
}
