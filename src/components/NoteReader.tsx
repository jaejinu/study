"use client";
import { useEffect, useState, type ReactNode } from "react";
import { readPreference, savePreference } from "@/lib/browser-preferences";
import type { ReadingLocation } from "./ContinueLearning";
export function NoteReader({
  children,
  location,
}: {
  children: ReactNode;
  location: Omit<ReadingLocation, "progress">;
}) {
  const [focus, setFocus] = useState(false),
    [progress, setProgress] = useState(0);
  const { href, title, subject, chapter } = location;
  useEffect(() => {
    document.documentElement.dataset.focus = String(focus);
    return () => {
      delete document.documentElement.dataset.focus;
    };
  }, [focus]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const article = document.querySelector(".reader-layout article");
        const end = article
          ? article.getBoundingClientRect().bottom +
            window.scrollY -
            window.innerHeight
          : document.documentElement.scrollHeight - window.innerHeight;
        const progress = Math.min(
          100,
          Math.max(0, (window.scrollY / Math.max(1, end)) * 100),
        );
        setProgress(progress);
        savePreference(
          "study:last-note",
          JSON.stringify({ href, title, subject, chapter, progress }),
        );
      });
    };
    if (new URLSearchParams(window.location.search).has("resume")) {
      try {
        const saved = JSON.parse(readPreference("study:last-note"));
        if (saved.href === href && Number.isFinite(saved.progress)) {
          const article = document.querySelector(".reader-layout article");
          const end = article
            ? article.getBoundingClientRect().bottom +
              window.scrollY -
              window.innerHeight
            : 0;
          window.scrollTo(
            0,
            (Math.max(0, end) * Math.min(100, Math.max(0, saved.progress))) /
              100,
          );
        }
      } catch {}
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [href, title, subject, chapter]);
  return (
    <>
      <div className="reading-track" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="reader-toolbar">
        <span>
          {subject} · 읽은 위치 {Math.round(progress)}%
        </span>
        <button onClick={() => setFocus(!focus)} aria-pressed={focus}>
          {focus ? "집중 모드 끝내기 · Esc" : "집중 모드 ↗"}
        </button>
      </div>
      {children}
    </>
  );
}
