"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { recordQuizAction } from "@/actions/study";
import type { QuizStat } from "@/lib/study-shared";
import { Button } from "./ui";

export interface Card {
  /** 서버에서 만든 카드 키 (간격 반복 기록용) */
  key?: string;
  note: string;
  noteTitle?: string;
  q: string;
  a: string;
}

type Mode = "review" | "order";

const BOX_LABEL = ["새로/틀림", "1일", "3일", "7일", "14일"];

function buildOrder(cards: Card[], stats: Record<string, QuizStat>, mode: Mode, now: number): number[] {
  const idx = cards.map((_, i) => i);
  if (mode === "order") return idx;
  // 복습 우선: 기한 지난 카드(상자 낮은 순, 틀린 횟수 많은 순) → 처음 보는 카드 → 아직 기한 안 된 카드(가까운 순)
  const rank = (i: number) => {
    const s = cards[i].key ? stats[cards[i].key!] : undefined;
    if (!s) return [1, 0, i];
    if (s.due <= now) return [0, s.box * 1000 - s.wrong, i];
    return [2, s.due, i];
  };
  return idx.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
}

export function Flashcards({ cards, subject, stats: initialStats = {}, defaultMode = "review" }: { cards: Card[]; subject: string; stats?: Record<string, QuizStat>; defaultMode?: Mode }) {
  const [stats, setStats] = useState(initialStats);
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [now] = useState(() => Date.now());
  const [order, setOrder] = useState(() => buildOrder(cards, initialStats, defaultMode, now));
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [score, setScore] = useState({ right: 0, wrong: 0 });
  const [missed, setMissed] = useState<number[]>([]);
  const [done, setDone] = useState(false);
  const [saveErr, setSaveErr] = useState(false);
  const card = cards[order[idx]];
  const stat = card?.key ? stats[card.key] : undefined;
  const dueCount = useMemo(() => cards.filter((c) => c.key && stats[c.key] && stats[c.key].due <= now).length, [cards, stats, now]);

  const next = (right: boolean) => {
    setScore((s) => ({ right: s.right + (right ? 1 : 0), wrong: s.wrong + (right ? 0 : 1) }));
    if (!right) setMissed((m) => [...m, order[idx]]);
    if (card.key) {
      const key = card.key;
      void recordQuizAction(subject, key, right).then((r) => {
        if (r.ok && r.stat) setStats((s) => ({ ...s, [key]: r.stat! }));
        else setSaveErr(true);
      });
    }
    if (idx + 1 >= order.length) setDone(true);
    else {
      setIdx(idx + 1);
      setFlipped(false);
    }
  };
  const restart = (o: number[]) => {
    setOrder(o);
    setIdx(0);
    setFlipped(false);
    setScore({ right: 0, wrong: 0 });
    setMissed([]);
    setDone(false);
  };
  const shuffled = () => {
    const o = cards.map((_, i) => i);
    for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
    return o;
  };
  const switchMode = (m: Mode) => {
    setMode(m);
    restart(buildOrder(cards, stats, m, Date.now()));
  };

  if (cards.length === 0)
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-8 text-center text-sm">
        <p className="font-medium">아직 이 주제의 퀴즈 카드가 없습니다</p>
        <p className="mt-1 text-muted">노트를 먼저 읽어 보세요. 카드는 노트와 함께 추가됩니다.</p>
        <Link href={`/${subject}/notes`} className="mt-4 inline-block rounded-md border border-border bg-surface px-3 py-1.5 hover:border-muted">
          학습 노트 목차 →
        </Link>
      </div>
    );
  if (done)
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-center">
        <div className="text-2xl font-bold">
          {score.right} / {order.length}
        </div>
        <p className="mt-1 text-sm text-muted">맞음 {score.right} · 다시 볼 것 {score.wrong}</p>
        {saveErr && <p className="mt-1 text-xs text-accent">기록 저장 실패 — Redis 가 켜져 있어야 복습 일정이 저장됩니다</p>}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {missed.length > 0 && <Button onClick={() => restart(missed)}>틀린 {missed.length}장만 다시</Button>}
          <Button variant={missed.length ? "ghost" : "primary"} onClick={() => restart(buildOrder(cards, stats, mode, Date.now()))}>처음부터</Button>
          <Button variant="ghost" onClick={() => restart(shuffled())}>섞어서 다시</Button>
        </div>
      </div>
    );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
        <span>
          {idx + 1} / {order.length}
          {mode === "review" && dueCount > 0 && <span className="ml-2 text-warn">복습 기한 지난 카드 {dueCount}장</span>}
        </span>
        <span className="flex items-center gap-2">
          <span>맞음 {score.right} · 틀림 {score.wrong}</span>
          <span className="inline-flex overflow-hidden rounded border border-border">
            <button onClick={() => switchMode("review")} className={`px-2 py-0.5 ${mode === "review" ? "bg-surface-2 text-foreground" : "hover:text-foreground"}`} title="기한 지난·틀린 카드부터">복습 우선</button>
            <button onClick={() => switchMode("order")} className={`px-2 py-0.5 ${mode === "order" ? "bg-surface-2 text-foreground" : "hover:text-foreground"}`} title="노트 순서대로">순서대로</button>
          </span>
        </span>
      </div>
      <button onClick={() => setFlipped((v) => !v)} className="block w-full rounded-xl border border-border bg-surface p-6 text-left transition-colors hover:border-muted">
        <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted">
          <span>{flipped ? "답" : "질문 (클릭해서 뒤집기)"}</span>
          {stat ? (
            <span className={`normal-case ${stat.due <= now ? "text-warn" : ""}`} title={`맞음 ${stat.right} · 틀림 ${stat.wrong} · 연속 ${stat.streak}`}>
              상자 {stat.box} · 간격 {BOX_LABEL[stat.box]}{stat.due <= now && stat.last > 0 ? " · 복습 기한" : ""}
            </span>
          ) : (
            <span className="normal-case">처음 보는 카드</span>
          )}
        </div>
        <div className={`text-lg leading-relaxed ${flipped ? "text-foreground" : "font-medium"}`}>{flipped ? card.a : card.q}</div>
        {flipped && card.noteTitle && (
          <div className="mt-3 text-xs text-muted">
            관련 노트:{" "}
            <Link href={`/${subject}/notes/${card.note}`} className="text-info hover:underline" onClick={(e) => e.stopPropagation()}>
              {card.noteTitle}
            </Link>
          </div>
        )}
      </button>
      <div className="mt-3 flex gap-2">
        {!flipped ? (
          <Button variant="ghost" onClick={() => setFlipped(true)}>답 보기</Button>
        ) : (
          <>
            <Button onClick={() => next(true)}>맞았다 ✓</Button>
            <Button variant="danger" onClick={() => next(false)}>틀렸다 ✗</Button>
          </>
        )}
        <Button variant="ghost" className="ml-auto" onClick={() => restart(shuffled())}>섞기</Button>
      </div>
    </div>
  );
}
