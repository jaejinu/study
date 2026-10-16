"use client";

import Link from "next/link";
import { useState } from "react";
import { subjects } from "@/lib/subjects";
import { timeAgo, useRecent } from "../shell/recent";

export interface NextUp {
  subject: string;
  slug: string;
  title: string;
  level: string;
  read: number;
  total: number;
}

function Mark({ id }: { id: string }) {
  const s = subjects.find((x) => x.id === id);
  return <span className={`grid h-6 w-6 shrink-0 place-items-center rounded text-[10px] font-bold text-white ${s?.color ?? "bg-surface-2"}`}>{s?.mark ?? "·"}</span>;
}

/**
 * 첫 화면 '이어서 학습'.
 * - 최근 본 노트·실험: 브라우저 기록(localStorage)
 * - 다음 노트: 서버가 계산한 '읽기 시작한 주제의 첫 안 읽은 노트'
 * - 아무 기록도 없으면 추천 시작점
 */
export function ContinueLearning({ nextUp, starters }: { nextUp: NextUp[]; starters: NextUp[] }) {
  const recent = useRecent();
  const [now] = useState(() => Date.now());
  const recentShown = recent.slice(0, 4);
  const hasHistory = recentShown.length > 0 || nextUp.length > 0;
  const suggestions = nextUp.length > 0 ? nextUp : starters;

  return (
    <section className="mb-10 rounded-xl border border-border bg-surface p-5" aria-labelledby="continue-title">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="continue-title" className="text-lg font-semibold">
          {hasHistory ? "이어서 학습" : "어디서 시작할까요?"}
        </h2>
        <span className="text-xs text-muted">{hasHistory ? "최근 본 것과 다음에 읽을 노트" : "처음이라면 아래 셋 중 하나로 시작해 보세요"}</span>
      </div>
      <div className={`grid gap-5 ${recentShown.length > 0 ? "md:grid-cols-2" : ""}`}>
        {recentShown.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted">최근 본 것</div>
            <ul className="space-y-1">
              {recentShown.map((r) => (
                <li key={r.href}>
                  <Link href={r.href} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2">
                    <Mark id={r.subject} />
                    <span className="min-w-0 flex-1 truncate">
                      {r.kind === "lab" && <span className="mr-1 text-muted">⚗</span>}
                      {r.title}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">{timeAgo(r.at, now)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted">{nextUp.length > 0 ? "다음에 읽을 노트" : "추천 시작점"}</div>
          <ul className="space-y-1">
            {suggestions.map((n) => {
              const pct = n.total ? Math.round((n.read / n.total) * 100) : 0;
              return (
                <li key={`${n.subject}/${n.slug}`}>
                  <Link href={`/${n.subject}/notes/${n.slug}`} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2">
                    <Mark id={n.subject} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{n.title}</span>
                      {n.read > 0 && (
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                          <span className="h-1 w-16 overflow-hidden rounded bg-surface-2">
                            <span className="block h-full rounded bg-ok" style={{ width: `${pct}%` }} />
                          </span>
                          {n.read}/{n.total} 읽음
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] text-info">읽기 →</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
