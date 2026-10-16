"use client";

import { useEffect, useSyncExternalStore } from "react";

/** 최근 방문한 노트·실험 (브라우저 localStorage). 서버의 progress:read 는 순서가 없는 Set 이라 '최근' 은 여기서 */
export interface RecentItem {
  kind: "note" | "lab";
  subject: string;
  href: string;
  title: string;
  at: number;
}

const KEY = "study:recent";
const EVT = "study:recent";
const MAX = 12;
const EMPTY: RecentItem[] = [];
let cache: { raw: string | null; items: RecentItem[] } = { raw: null, items: EMPTY };

function snapshot(): RecentItem[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return EMPTY;
  }
  if (raw === cache.raw) return cache.items;
  let items: RecentItem[] = EMPTY;
  try {
    items = raw ? (JSON.parse(raw) as RecentItem[]) : EMPTY;
  } catch {
    items = EMPTY;
  }
  cache = { raw, items };
  return items;
}

function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useRecent(): RecentItem[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

export function pushRecent(item: Omit<RecentItem, "at">) {
  const list = snapshot().filter((r) => r.href !== item.href);
  const next = [{ ...item, at: Date.now() }, ...list].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(EVT));
}

/** 노트·실험 페이지에 두면 방문을 기록한다 (렌더 출력 없음) */
export function RecentTracker(props: Omit<RecentItem, "at">) {
  const { kind, subject, href, title } = props;
  useEffect(() => {
    pushRecent({ kind, subject, href, title });
  }, [kind, subject, href, title]);
  return null;
}

export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}
