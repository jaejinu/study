"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { progressSummaryAction, type ProgressSummary } from "@/actions/summary";
import { getSubject } from "@/lib/subjects";
import { openPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";

const SECTION: Record<string, string> = { notes: "학습 노트", quiz: "퀴즈", lab: "실험실", console: "콘솔", keys: "키 브라우저", monitor: "모니터", benchmark: "벤치마크", tests: "테스트" };
const TOP: Record<string, string> = { path: "학습 경로", assistant: "AI 도우미", glossary: "용어집", graph: "링크 그래프", search: "검색" };

export function openAsk() {
  window.dispatchEvent(new CustomEvent("ask:open"));
}

/** 얇은 글로벌 바: 브레드크럼 · ⌘K · AI 에게 묻기 · 테마 · 진행률 요약 */
export function TopBar() {
  const pathname = usePathname();
  const [, first, second] = pathname.split("/");
  const subject = getSubject(first ?? "");
  const [sum, setSum] = useState<ProgressSummary | null>(null);

  useEffect(() => {
    let alive = true;
    progressSummaryAction(subject?.id ?? null)
      .then((s) => alive && setSum(s))
      .catch(() => alive && setSum(null));
    return () => {
      alive = false;
    };
  }, [subject?.id, pathname]);

  const pct = sum && sum.total ? Math.round((sum.read / sum.total) * 100) : 0;
  return (
    <header className="sticky top-0 z-30 flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 text-sm backdrop-blur md:px-6">
      <button className="rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-foreground md:hidden" onClick={() => window.dispatchEvent(new Event("study:sidebar"))} aria-label="메뉴 열기">
        ☰
      </button>
      <nav className="flex min-w-0 items-center gap-1.5 text-[13px]" aria-label="현재 위치">
        <Link href="/" className="shrink-0 font-semibold text-muted hover:text-foreground">
          Study
        </Link>
        {subject && (
          <>
            <span className="text-muted/60">/</span>
            <Link href={`/${subject.id}`} className="flex min-w-0 items-center gap-1.5 hover:underline">
              <span className={`grid h-4 w-4 shrink-0 place-items-center rounded text-[9px] font-bold text-white ${subject.color}`}>{subject.mark}</span>
              <span className="truncate">{subject.name}</span>
            </Link>
          </>
        )}
        {subject && second && SECTION[second] && (
          <>
            <span className="hidden text-muted/60 sm:inline">/</span>
            <Link href={`/${subject.id}/${second}`} className="hidden truncate text-muted hover:text-foreground sm:inline">
              {SECTION[second]}
            </Link>
          </>
        )}
        {!subject && first && (
          <>
            <span className="text-muted/60">/</span>
            <span className="truncate text-muted">{TOP[first] ?? first}</span>
          </>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <button onClick={openPalette} className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1 text-[12.5px] text-muted hover:border-muted hover:text-foreground" aria-label="빠른 검색 열기 (⌘K)">
          <span aria-hidden>⌕</span>
          <span className="hidden sm:inline">검색</span>
          <kbd className="hidden rounded border border-border bg-background px-1 text-[10px] sm:inline">⌘K</kbd>
        </button>
        <button onClick={openAsk} className="rounded-md px-2.5 py-1 text-[12.5px] text-muted hover:bg-surface-2 hover:text-foreground" aria-label="AI 에게 묻기 (⌘/)" title="AI 에게 묻기 (⌘/)">
          <span aria-hidden>✦</span> <span className="hidden lg:inline">AI 에게 묻기</span>
        </button>
        <ThemeToggle />
        {sum && sum.total > 0 && (
          <Link
            href={sum.due > 0 && subject ? `/${subject.id}/quiz` : subject ? `/${subject.id}/notes` : "/"}
            className="hidden items-center gap-2 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-surface-2 hover:text-foreground md:flex"
            title={`${sum.scope === "subject" ? "이 주제" : "전체"} 읽은 노트 ${sum.read}/${sum.total}${sum.due ? ` · 복습 기한 지난 카드 ${sum.due}장` : ""}`}
          >
            <span className="h-1.5 w-16 overflow-hidden rounded bg-surface-2">
              <span className="block h-full rounded bg-ok" style={{ width: `${pct}%` }} />
            </span>
            <span className="font-mono">
              {sum.read}/{sum.total}
            </span>
            {sum.due > 0 && <span className="rounded bg-warn/15 px-1.5 text-warn">복습 {sum.due}</span>}
          </Link>
        )}
      </div>
      {/* 노트 페이지의 읽기 진행 막대가 포털로 들어오는 자리 (상단 바 아래 경계선) */}
      <div id="reading-progress-slot" className="pointer-events-none absolute inset-x-0 -bottom-px h-[3px]" aria-hidden />
    </header>
  );
}
