"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getSubject } from "@/lib/subjects";
import type { NavigationNotes } from "./AppShell";
export function Sidebar({
  notes,
  onNavigate,
}: {
  notes: NavigationNotes;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const subject = getSubject(pathname.split("/")[1]);
  const currentNotes = subject ? (notes[subject.id] ?? []) : [];
  const nav = (href: string, label: string) => (
    <Link
      key={href}
      href={href}
      onClick={onNavigate}
      aria-current={pathname === href ? "page" : undefined}
      className={`nav-item ${pathname === href ? "active" : ""}`}
    >
      {label}
    </Link>
  );
  return (
    <aside className="study-sidebar">
      <nav aria-label="학습 탐색">
        <p className="nav-label">
          {subject ? `${subject.name} / 학습 공간` : "내 학습 공간"}
        </p>
        <div className="nav-group">
          {nav("/", subject ? "← 학습 홈" : "오늘의 학습")}
          {subject ? (
            subject.nav.slice(0, 4).map((n) => nav(n.href, n.label))
          ) : (
            <>
              {nav("/subjects", "전체 주제")}
              {nav("/#review", "복습")}
              {nav("/#activity", "학습 기록")}
            </>
          )}
        </div>
        {subject && pathname.includes("/notes") && currentNotes.length > 0 ? (
          <div className="nav-group note-navigation">
            <p className="nav-label">학습 노트 · {currentNotes.length}편</p>
            {currentNotes.map((n, i) =>
              nav(
                `/${subject.id}/notes/${n.slug}`,
                `${String(i + 1).padStart(2, "0")}  ${n.title}`,
              ),
            )}
          </div>
        ) : !subject ? (
          <div className="nav-group">
            <p className="nav-label">학습 바로가기</p>
            {["redis", "postgres", "kubernetes"].map((id) =>
              nav(`/${id}`, getSubject(id)?.name ?? id),
            )}
          </div>
        ) : null}
        {subject && subject.nav.length > 4 && (
          <details className="nav-group">
            <summary className="nav-label cursor-pointer">실습 도구</summary>
            {subject.nav.slice(4).map((n) => nav(n.href, n.label))}
          </details>
        )}
        <div className="nav-group nav-secondary">
          {subject && nav("/subjects", "다른 주제 보기 ↗")}
          {nav("/path", "학습 경로")}
          {nav("/assistant", "AI 도우미")}
          {nav("/glossary", "용어집")}
          {nav("/graph", "노트 연결 지도")}
        </div>
      </nav>
    </aside>
  );
}
