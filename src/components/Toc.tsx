"use client";

import { useEffect, useState } from "react";

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
      let cur = els[0].id;
      for (const el of els) if (el.getBoundingClientRect().top <= 120) cur = el.id;
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
