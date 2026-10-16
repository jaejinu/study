"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getSubject } from "@/lib/subjects";
import { navState } from "@/lib/read-only";
import type { NavigationNotes } from "./AppShell";
import { useReadOnly } from "./ReadOnly";
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
  const flags = useReadOnly();
  // 읽기 전용 공개판: 실행형 메뉴(콘솔·키 브라우저·모니터·벤치마크·메모·백업, AI 꺼짐이면 AI)는 숨기고 훈련은 '로컬 전용' 표시
  const visible = (href: string) => navState(href, flags) !== "hidden";
  const nav = (href: string, label: string) => {
    const state = navState(href, flags);
    if (state === "hidden") return null;
    return (
      <Link
        key={href}
        href={href}
        onClick={onNavigate}
        aria-current={pathname === href ? "page" : undefined}
        className={`nav-item ${pathname === href ? "active" : ""} ${state === "local" ? "opacity-60" : ""}`}
        title={state === "local" ? "읽기 전용 공개판에서는 설명만 볼 수 있습니다 (실행은 로컬에서)" : undefined}
      >
        {label}
        {state === "local" && " · 로컬 전용"}
      </Link>
    );
  };
  const subjectNav = subject ? subject.nav.filter((n) => visible(n.href)) : [];
  return (
    <aside className="study-sidebar">
      <nav aria-label="학습 탐색">
        <p className="nav-label">
          {subject ? `${subject.name} / 학습 공간` : "내 학습 공간"}
        </p>
        <div className="nav-group">
          {nav("/", subject ? "← 학습 홈" : "오늘의 학습")}
          {subject ? (
            subjectNav.slice(0, 4).map((n) => nav(n.href, n.label))
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
        {subject && subjectNav.length > 4 && (
          <details className="nav-group">
            <summary className="nav-label cursor-pointer">실습 도구</summary>
            {subjectNav.slice(4).map((n) => nav(n.href, n.label))}
          </details>
        )}
        <div className="nav-group nav-secondary">
          {subject && nav("/subjects", "다른 주제 보기 ↗")}
          {nav("/review", "오늘의 복습")}
          {nav("/practice", "AI 학습 모드")}
          {nav("/drills", "장애 훈련")}
          {nav("/path", "학습 경로")}
          {nav("/mastery", "약점 지도")}
          {nav("/memos", "내 메모")}
          {nav("/records", "학습 기록·백업")}
          {nav("/assistant", "AI 도우미")}
          {nav("/glossary", "용어집")}
          {nav("/graph", "노트 연결 지도")}
        </div>
      </nav>
    </aside>
  );
}
