"use client";
import { useEffect } from "react";
import { readPreference, savePreference, usePreference } from "@/lib/browser-preferences";
export function ThemeControl() {
  const stored = usePreference("study:theme", "dark");
  const theme = ["light", "dark", "system"].includes(stored) ? stored : "dark";
  useEffect(() => {
    const sync = () => {
      const value = readPreference("study:theme", "dark");
      document.documentElement.dataset.theme = ["light", "dark", "system"].includes(value) ? value : "dark";
    };
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return (
    <label className="theme-control">
      <span className="sr-only">화면 테마</span>
      <select
        aria-label="화면 테마"
        value={theme}
        onChange={(e) => {
          document.documentElement.dataset.theme = e.target.value;
          savePreference("study:theme", e.target.value);
        }}
      >
        <option value="dark">다크 모드</option>
        <option value="light">라이트 모드</option>
        <option value="system">시스템 설정</option>
      </select>
    </label>
  );
}
