"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getSubject, subjectsByTrack } from "@/lib/subjects";
import { openPalette } from "./shell/CommandPalette";
import { useStored } from "./shell/useStored";

const COLLAPSE_KEY = "study:sidebar-collapsed";

/**
 * 좌측 사이드바. 데스크톱에서는 접기(아이콘만)/펴기를 지원하고 상태를 localStorage 에 기억한다.
 * 모바일에서는 상단 바의 ☰ 버튼(study:sidebar 이벤트)으로 열리는 서랍.
 */
export function Sidebar() {
  const pathname = usePathname();
  // 모바일 서랍: 연 페이지 경로를 기억해 두면 이동하는 순간 자동으로 닫힌다 (effect 불필요)
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (v: boolean) => setOpenOn(v ? pathname : null);
  const [stored, setStored] = useStored(COLLAPSE_KEY, "0");
  const collapsed = stored === "1";
  const subject = getSubject(pathname.split("/")[1] ?? "");
  const isActive = (href: string) => (href === `/${subject?.id}` ? pathname === href : pathname.startsWith(href));
  const toggleCollapsed = useCallback(() => setStored(collapsed ? "0" : "1"), [collapsed, setStored]);

  useEffect(() => {
    const onToggle = () => setOpenOn((cur) => (cur === window.location.pathname ? null : window.location.pathname));
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("study:sidebar", onToggle);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("study:sidebar", onToggle);
      window.removeEventListener("keydown", onKey);
    };
  }, [toggleCollapsed]);
  // 모바일 서랍은 항상 펼친 상태로
  const mini = collapsed && !open;

  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-40 shrink-0 border-r border-border bg-surface transition-[transform,width] duration-200 md:sticky md:top-0 md:z-20 md:h-screen md:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"} ${mini ? "w-64 md:w-[60px]" : "w-64"}`}
        aria-label="사이드바"
      >
        <div className="flex h-full flex-col">
          <div className={`flex items-center border-b border-border ${mini ? "md:flex-col md:gap-2 md:px-2 md:py-3" : ""} gap-2.5 px-4 py-4`}>
            <Link href="/" className="flex min-w-0 flex-1 items-center gap-2.5" title="주제 선택으로">
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md text-sm font-bold text-white ${subject?.color ?? "bg-surface-2"}`}>{subject?.mark ?? "S"}</span>
              <span className={`min-w-0 ${mini ? "md:hidden" : ""}`}>
                <span className="block truncate text-sm font-semibold leading-tight">{subject ? subject.name : "Study"}</span>
                <span className="block truncate text-[11px] text-muted">{subject ? subject.tagline : "주제를 선택하세요"}</span>
              </span>
            </Link>
            <button onClick={toggleCollapsed} className="hidden rounded-md px-1.5 py-1 text-muted hover:bg-surface-2 hover:text-foreground md:block" aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"} title={`${collapsed ? "펼치기" : "접기"} (⌘\\)`}>
              {collapsed ? "»" : "«"}
            </button>
          </div>

          <div className={`px-3 pt-3 ${mini ? "md:px-2" : ""}`}>
            <button onClick={openPalette} className={`flex w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-muted hover:border-muted hover:text-foreground ${mini ? "md:justify-center md:px-0" : ""}`} title="빠른 검색 (⌘K)">
              <span aria-hidden>⌕</span>
              <span className={mini ? "md:hidden" : ""}>노트·실험·용어 검색</span>
              <kbd className={`ml-auto rounded border border-border px-1 text-[10px] ${mini ? "md:hidden" : ""}`}>⌘K</kbd>
            </button>
          </div>

          <nav className={`min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-3 ${mini ? "md:px-2" : ""}`}>
            {subject &&
              subject.nav.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  title={mini ? n.label : undefined}
                  className={`flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors ${mini ? "md:justify-center md:px-0" : ""} ${isActive(n.href) ? "bg-accent-soft text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground"}`}
                  aria-current={isActive(n.href) ? "page" : undefined}
                >
                  <span className={`mt-0.5 w-5 text-center font-mono text-xs ${isActive(n.href) ? "text-accent" : ""}`}>{n.icon}</span>
                  <span className={mini ? "md:hidden" : ""}>
                    <span className="block font-medium">{n.label}</span>
                    <span className="block text-[11px] text-muted">{n.desc}</span>
                  </span>
                </Link>
              ))}
            {subjectsByTrack().map(({ track, subjects: list }) => (
              <div key={track.id}>
                <div className={`px-3 pb-0.5 pt-4 text-[11px] font-semibold tracking-wide text-muted ${mini ? "md:hidden" : ""}`}>{track.name}</div>
                {mini && <div className="hidden border-t border-border/60 pt-2 md:mx-2 md:mt-2 md:block" />}
                {list.map((s) => (
                  <Link
                    key={s.id}
                    href={`/${s.id}`}
                    title={mini ? s.name : undefined}
                    className={`flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] ${mini ? "md:justify-center md:px-0" : ""} ${s.id === subject?.id ? "bg-surface-2 text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground"}`}
                  >
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded text-[9px] font-bold text-white ${s.color}`}>{s.mark}</span>
                    <span className={`truncate ${mini ? "md:hidden" : ""}`}>{s.name}</span>
                  </Link>
                ))}
              </div>
            ))}
          </nav>

          <div className={`flex flex-wrap gap-1 border-t border-border px-3 py-2 text-[11px] ${mini ? "md:hidden" : ""}`}>
            {[
              { href: "/assistant", label: "AI 도우미" },
              { href: "/glossary", label: "용어집" },
              { href: "/graph", label: "링크 그래프" },
              { href: "/search", label: "전체 검색" },
            ].map((l) => (
              <Link key={l.href} href={l.href} className={`rounded px-2 py-1 ${pathname.startsWith(l.href) ? "bg-accent-soft text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground"}`}>
                {l.label}
              </Link>
            ))}
          </div>
          {subject && (
            <details className={`border-t border-border px-5 py-2.5 text-[11px] leading-relaxed text-muted ${mini ? "md:hidden" : ""}`}>
              <summary className="cursor-pointer select-none py-0.5 hover:text-foreground">환경 준비 명령</summary>
              <div className="mt-1 space-y-0.5">
                {subject.setup.map((s) => (
                  <div key={s.cmd}>
                    {s.label}: <code className="text-foreground">{s.cmd}</code>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)} aria-hidden />}
    </>
  );
}
