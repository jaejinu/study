"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "./ui";

export interface Card {
  note: string;
  noteTitle?: string;
  q: string;
  a: string;
}

export function Flashcards({ cards, subject }: { cards: Card[]; subject: string }) {
  const [order, setOrder] = useState(() => cards.map((_, i) => i));
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [score, setScore] = useState({ right: 0, wrong: 0 });
  const [done, setDone] = useState(false);
  const card = cards[order[idx]];

  const next = (right: boolean) => {
    setScore((s) => ({ right: s.right + (right ? 1 : 0), wrong: s.wrong + (right ? 0 : 1) }));
    if (idx + 1 >= order.length) setDone(true);
    else {
      setIdx(idx + 1);
      setFlipped(false);
    }
  };
  const restart = (shuffle: boolean) => {
    const o = cards.map((_, i) => i);
    if (shuffle) for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
    setOrder(o);
    setIdx(0);
    setFlipped(false);
    setScore({ right: 0, wrong: 0 });
    setDone(false);
  };

  if (cards.length === 0) return <p className="text-sm text-muted">아직 이 주제의 퀴즈가 없습니다.</p>;
  if (done)
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-center">
        <div className="text-2xl font-bold">
          {score.right} / {cards.length}
        </div>
        <p className="mt-1 text-sm text-muted">맞음 {score.right} · 다시 볼 것 {score.wrong}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={() => restart(false)}>처음부터</Button>
          <Button variant="ghost" onClick={() => restart(true)}>섞어서 다시</Button>
        </div>
      </div>
    );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span>
          {idx + 1} / {order.length}
        </span>
        <span>
          맞음 {score.right} · 틀림 {score.wrong}
        </span>
      </div>
      <button onClick={() => setFlipped((v) => !v)} className="block w-full rounded-xl border border-border bg-surface p-6 text-left transition-colors hover:border-muted">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted">{flipped ? "답" : "질문 (클릭해서 뒤집기)"}</div>
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
        <Button variant="ghost" className="ml-auto" onClick={() => restart(true)}>섞기</Button>
      </div>
    </div>
  );
}
