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
      const y = window.scrollY + 120;
      let cur = els[0].id;
      for (const el of els) if (el.offsetTop <= y) cur = el.id;
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
        <li key={h.id} className={h.depth === 3 ? "pl-5" : ""}>
          <a href={`#${h.id}`} className={`block border-l-2 py-1 pl-3 leading-snug transition-colors ${active === h.id ? "border-accent text-foreground" : "border-border text-muted hover:border-muted hover:text-foreground"}`}>
            {h.text}
          </a>
        </li>
      ))}
    </ul>
  );
}
