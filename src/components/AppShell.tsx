"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getSubject } from "@/lib/subjects";
import { Sidebar } from "./Sidebar";
import { openPalette } from "./shell/CommandPalette";
import { ThemeControl } from "./ThemeControl";
export type NavigationNotes = Record<
  string,
  { slug: string; title: string; order: number }[]
>;
export function AppShell({
  children,
  notes,
}: {
  children: ReactNode;
  notes: NavigationNotes;
}) {
  const pathname = usePathname();
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const menuOpen = menuPath === pathname;
  const menuButton = useRef<HTMLButtonElement>(null),
    navRef = useRef<HTMLDivElement>(null);
  const subject = getSubject(pathname.split("/")[1]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menuOpen) {
        setMenuPath(null);
        menuButton.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    navRef.current?.querySelector<HTMLElement>("button, a")?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(
        navRef.current?.querySelectorAll<HTMLElement>("a, button, summary") ??
          [],
      ).filter((n) => n.getClientRects().length);
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", trap);
    };
  }, [menuOpen]);
  return (
    <>
      <a className="skip-link" href="#main-content">
        본문으로 바로가기
      </a>
      <header className="app-header">
        <div className="header-identity">
          <button
            ref={menuButton}
            className="menu-toggle"
            aria-label="메뉴 열기"
            aria-expanded={menuOpen}
            aria-controls="study-navigation"
            onClick={() => setMenuPath(menuOpen ? null : pathname)}
          >
            ☰
          </button>
          <Link className="wordmark" href="/">
            study.
          </Link>
          <span className="header-context">
            {subject
              ? `${subject.name} / ${pathname.includes("/notes") ? "학습 노트" : pathname.includes("/lab") ? "실험실" : "학습 공간"}`
              : pathname === "/subjects"
                ? "전체 주제"
                : "내 학습 공간"}
          </span>
        </div>
        <div className="header-actions">
          <button type="button" onClick={openPalette} className="header-search">
            검색 <kbd>⌘ K</kbd>
          </button>
          <ThemeControl />
        </div>
      </header>
      <div className="app-body">
        {menuOpen && (
          <button
            className="nav-scrim"
            tabIndex={-1}
            aria-label="메뉴 닫기"
            onClick={() => setMenuPath(null)}
          />
        )}
        <div
          ref={navRef}
          id="study-navigation"
          className={`sidebar-slot ${menuOpen ? "is-open" : ""}`}
        >
          <button
            className="menu-close"
            onClick={() => {
              setMenuPath(null);
              menuButton.current?.focus();
            }}
          >
            메뉴 닫기 ×
          </button>
          <Sidebar notes={notes} onNavigate={() => setMenuPath(null)} />
        </div>
        <main id="main-content" tabIndex={-1} className="app-main">
          {children}
        </main>
      </div>
    </>
  );
}
