"use client";
import Link from "next/link";
import { usePreference } from "@/lib/browser-preferences";
export type ReadingLocation = {
  href: string;
  title: string;
  subject: string;
  chapter: number;
  progress: number;
};
export function ContinueLearning({ first }: { first: ReadingLocation }) {
  const stored = usePreference("study:last-note");
  let note = first,
    resumed = false;
  try {
    const saved = JSON.parse(stored);
    if (
      typeof saved.href === "string" &&
      /^\/[a-z0-9-]+\/notes\/[a-z0-9-]+$/.test(saved.href) &&
      typeof saved.title === "string" &&
      typeof saved.subject === "string" &&
      Number.isFinite(saved.chapter) &&
      Number.isFinite(saved.progress)
    ) {
      note = saved;
      resumed = true;
    }
  } catch {}
  return (
    <section className="continue-card">
      <div>
        <p className="eyebrow">
          {resumed ? "CONTINUE LEARNING" : "START LEARNING"}
        </p>
        <h2>{note.title}</h2>
        <p className="home-intro">
          {note.subject} ·{" "}
          {resumed
            ? "지난번 읽던 지점에서 차분히 이어가세요."
            : "첫 노트부터 차근차근 시작해 보세요."}
        </p>
        <Link
          className="primary-link"
          href={note.href + (resumed ? "?resume=1" : "")}
        >
          {resumed ? "이어서 학습하기" : "학습 시작하기"}
          <span>→</span>
        </Link>
      </div>
      <div className="chapter-mark">
        <span>CHAPTER</span>
        <strong>{String(note.chapter).padStart(2, "0")}</strong>
        <span>
          {resumed
            ? `읽은 위치 ${Math.round(Math.min(100, Math.max(0, note.progress)))}%`
            : "하나의 개념부터"}
        </span>
      </div>
    </section>
  );
}
