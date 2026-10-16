"use client";

import { useEffect, useState } from "react";
import { useStored } from "./shell/useStored";

/** 우측 목차 패널: 제목을 눌러 접기/펴기 (기억) */
export function TocPanel({ headings }: { headings: Heading[] }) {
  const [v, set] = useStored("study:toc-collapsed", "0");
  const collapsed = v === "1";
  return (
    <div>
      <button onClick={() => set(collapsed ? "0" : "1")} aria-expanded={!collapsed} className="mb-2 flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-foreground">
        <span>이 노트의 목차 · {headings.filter((h) => h.depth === 2).length}</span>
        <span aria-hidden>{collapsed ? "펼치기 ▾" : "접기 ▴"}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[calc(100vh-10rem)] overflow-y-auto pr-1">
          <Toc headings={headings} />
        </div>
      )}
    </div>
  );
}

export interface Heading {
  id: string;
  text: string;
  depth: number;
}

/** 스크롤 위치에 따라 현재 섹션을 강조하는 목차 */
export function Toc({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState<string>(headings[0]?.id ?? "");
  useEffect(() => {
    const els = headings.map((h) => document.getElementById(h.id)).filter((e): e is HTMLElement => !!e);
    if (els.length === 0) return;
    const onScroll = () => {
      // offsetTop 은 가장 가까운 positioned 조상 기준이라 틀어진다 → 뷰포트 기준 좌표로 판정
      // 상단 바(44px) 아래 1/4 지점을 지난 마지막 제목이 현재 섹션
      const line = 44 + window.innerHeight * 0.25;
      let cur = els[0].id;
      for (const el of els) if (el.getBoundingClientRect().top <= line) cur = el.id;
      // 문서 끝에 닿으면 마지막 섹션
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = els[els.length - 1].id;
      setActive(cur);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [headings]);
  if (headings.length === 0) return null;
  return (
    <ul className="toc space-y-0.5 text-[13px]">
      {headings.map((h) => (
        <li key={h.id} className={h.depth === 3 ? "pl-4 text-[12px]" : ""}>
          <a href={`#${h.id}`} className={`block border-l-2 rounded-r-md py-2 pl-3 leading-snug transition-colors ${active === h.id ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:border-muted hover:text-foreground"}`}>
            {h.text}
          </a>
        </li>
      ))}
    </ul>
  );
}
