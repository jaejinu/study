"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getSubject } from "@/lib/subjects";

/** 모바일 하단 탭바: 현재 주제의 주요 섹션 (대시보드·노트·퀴즈·실험실) */
export function MobileTabs() {
  const pathname = usePathname();
  const subject = getSubject(pathname.split("/")[1] ?? "");
  if (!subject) return null;
  const tabs = subject.nav.slice(0, 4);
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 grid border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }} aria-label="주제 섹션">
      {tabs.map((n) => {
        const active = n.href === `/${subject.id}` ? pathname === n.href : pathname.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${active ? "text-foreground" : "text-muted"}`} aria-current={active ? "page" : undefined}>
            <span className={`font-mono text-base ${active ? "text-accent" : ""}`}>{n.icon}</span>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
