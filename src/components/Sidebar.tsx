"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const NAV = [
  { href: "/", label: "대시보드", icon: "◉", desc: "서버 상태 · 학습 현황" },
  { href: "/notes", label: "학습 노트", icon: "✎", desc: "목차대로 읽는 정리 노트" },
  { href: "/lab", label: "실험실", icon: "⚗", desc: "실제 Redis 로 동작 확인" },
  { href: "/console", label: "콘솔", icon: "›_", desc: "redis-cli 처럼 명령 실행" },
  { href: "/keys", label: "키 브라우저", icon: "⌘", desc: "저장된 키와 값 살펴보기" },
  { href: "/tests", label: "테스트", icon: "✓", desc: "vitest 결과 리포트" },
];

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

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
            <span className="grid h-8 w-8 place-items-center rounded-md bg-accent text-sm font-bold text-white">R</span>
            <div>
              <div className="text-sm font-semibold leading-tight">Redis Study</div>
              <div className="text-[11px] text-muted">공부 · 정리 · 실험</div>
            </div>
          </Link>
          <nav className="flex-1 space-y-0.5 px-3 py-3">
            {NAV.map((n) => (
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
          </nav>
          <div className="border-t border-border px-5 py-3 text-[11px] leading-relaxed text-muted">
            <div>
              서버: <code className="text-foreground">pnpm redis</code>
            </div>
            <div>
              테스트: <code className="text-foreground">pnpm test</code>
            </div>
          </div>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-10 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}
    </>
  );
}
