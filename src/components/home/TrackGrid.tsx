"use client";

import Link from "next/link";
import { useStored } from "../shell/useStored";

export interface CardData {
  id: string;
  name: string;
  tagline: string;
  description: string;
  mark: string;
  color: string;
  notes: number;
  read: number;
  experiments: number;
  due: number;
}

export interface TrackData {
  id: string;
  name: string;
  desc: string;
  cards: CardData[];
}

const DENSITY_KEY = "study:home-density";

/** 카드 밀도 토글 (상세 ↔ 컴팩트). 첫 화면 오른쪽 위에 둔다 */
export function DensityToggle() {
  const [density, setDensity] = useStored(DENSITY_KEY, "detail");
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border text-[12px]" role="group" aria-label="카드 밀도">
      {[
        { v: "detail", label: "상세" },
        { v: "compact", label: "컴팩트" },
      ].map((o) => (
        <button key={o.v} onClick={() => setDensity(o.v)} aria-pressed={density === o.v} className={`px-2.5 py-1 ${density === o.v ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Progress({ read, notes }: { read: number; notes: number }) {
  const pct = notes ? Math.round((read / notes) * 100) : 0;
  return (
    <div className="h-1 overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="읽은 노트 비율">
      <div className="h-full rounded bg-ok" style={{ width: `${pct}%` }} />
    </div>
  );
}

function DetailCard({ c }: { c: CardData }) {
  return (
    <Link href={`/${c.id}`} className={`group flex flex-col rounded-xl border border-border bg-surface p-5 transition-all hover:-translate-y-0.5 hover:border-muted hover:shadow-lg hover:shadow-black/20 ${c.notes === 0 ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-base font-bold text-white ${c.color}`}>{c.mark}</span>
        <div className="min-w-0">
          <div className="truncate text-[17px] font-semibold leading-tight">{c.name}</div>
          <div className="truncate text-[12.5px] text-muted">{c.tagline}</div>
        </div>
      </div>
      <p className="clamp-3 mt-3 flex-1 text-[13.5px] leading-relaxed text-muted">{c.description}</p>
      <div className="mt-4">
        <Progress read={c.read} notes={c.notes} />
        <div className="mt-2 flex items-center gap-3 text-[12px] text-muted">
          {c.notes === 0 ? (
            <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px]">준비 중</span>
          ) : (
            <span>
              노트 <span className="font-mono text-foreground">{c.notes}</span>
              {c.read > 0 && <span className="text-ok"> · {c.read} 읽음</span>}
            </span>
          )}
          {c.experiments > 0 && (
            <span>
              실험 <span className="font-mono text-foreground">{c.experiments}</span>
            </span>
          )}
          {c.due > 0 && <span className="text-warn">복습 {c.due}</span>}
          <span className="ml-auto text-info opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">시작 →</span>
        </div>
      </div>
    </Link>
  );
}

function CompactCard({ c }: { c: CardData }) {
  return (
    <Link href={`/${c.id}`} className={`flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 transition-colors hover:border-muted ${c.notes === 0 ? "opacity-60" : ""}`} title={c.description}>
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md text-xs font-bold text-white ${c.color}`}>{c.mark}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{c.name}</span>
        <span className="mt-1 block">
          <Progress read={c.read} notes={c.notes} />
        </span>
      </span>
      <span className="shrink-0 text-right font-mono text-[11px] text-muted">
        {c.notes === 0 ? "준비 중" : `${c.read}/${c.notes}`}
        {c.due > 0 && <span className="block text-warn">복습 {c.due}</span>}
      </span>
    </Link>
  );
}

/** 트랙 하나: 제목 클릭으로 접기/펴기(기억), 밀도에 따라 카드 모양이 바뀐다 */
export function TrackSection({ track }: { track: TrackData }) {
  const [density] = useStored(DENSITY_KEY, "detail");
  const [folded, setFolded] = useStored(`study:track:${track.id}`, "0");
  const isFolded = folded === "1";
  const read = track.cards.reduce((a, c) => a + c.read, 0);
  const total = track.cards.reduce((a, c) => a + c.notes, 0);
  const compact = density === "compact";
  return (
    <section className="mb-8">
      <h2 className="mb-3">
        <button onClick={() => setFolded(isFolded ? "0" : "1")} aria-expanded={!isFolded} className="group flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left">
          <span className={`inline-block w-3 text-xs text-muted transition-transform ${isFolded ? "" : "rotate-90"}`} aria-hidden>
            ▸
          </span>
          <span className="text-lg font-semibold group-hover:underline">{track.name}</span>
          <span className="text-sm text-muted">{track.desc}</span>
          <span className="ml-auto font-mono text-[12px] text-muted">
            {track.cards.length}개 주제 · {read}/{total} 읽음
          </span>
        </button>
      </h2>
      {!isFolded && (
        <div className={compact ? "grid gap-2 sm:grid-cols-2 lg:grid-cols-4" : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"}>
          {track.cards.map((c) => (compact ? <CompactCard key={c.id} c={c} /> : <DetailCard key={c.id} c={c} />))}
        </div>
      )}
    </section>
  );
}
