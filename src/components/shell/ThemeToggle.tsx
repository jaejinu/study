"use client";

import { useEffect } from "react";
import { useStored } from "./useStored";

export type Theme = "dark" | "light" | "system";
export const THEME_KEY = "study:theme";

/** 첫 페인트 전에 실행되는 인라인 스크립트 (layout <head>). 기본은 다크 */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");document.documentElement.setAttribute("data-theme",t==="light"||t==="system"?t:"dark")}catch(e){document.documentElement.setAttribute("data-theme","dark")}`;

/** 다크(기본) → 라이트 → 시스템 순환. system 은 OS 의 prefers-color-scheme 를 따른다 */
export function ThemeToggle() {
  const [raw, setRaw] = useStored(THEME_KEY, "dark");
  const theme: Theme = raw === "light" || raw === "system" ? raw : "dark";
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const next = () => {
    const order: Theme[] = ["dark", "light", "system"];
    setRaw(order[(order.indexOf(theme) + 1) % order.length]);
  };
  const icon = theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐";
  const label = theme === "dark" ? "다크" : theme === "light" ? "라이트" : "시스템";
  return (
    <button onClick={next} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-2 hover:text-foreground" title={`테마: ${label} (클릭해서 변경)`} aria-label={`테마 변경, 현재 ${label}`}>
      <span aria-hidden>{icon}</span>
    </button>
  );
}
