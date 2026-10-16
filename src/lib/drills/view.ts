import type { Drill } from "./types";
import type { ActiveDrill, DrillRun } from "./state";

/** 클라이언트에 넘길 수 있는(함수 없는) 훈련 정보 — 해설·정답은 끝난 뒤에만 보여 준다 */
export interface DrillView {
  id: string;
  title: string;
  level: Drill["level"];
  summary: string;
  symptoms: string[];
  starters: string[];
  timeLimitMin: number;
  hintCount: number;
  explanation: Drill["explanation"];
  solution: string[];
}

const quote = (a: string) => (/^[\w./:=@,+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

export function toView(d: Drill): DrillView {
  return {
    id: d.id,
    title: d.title,
    level: d.level,
    summary: d.summary,
    symptoms: d.symptoms,
    starters: d.starters,
    timeLimitMin: d.timeLimitMin,
    hintCount: d.hints.length,
    explanation: d.explanation,
    solution: d.solution.map((s) => [s.bin, ...s.args].map(quote).join(" ")),
  };
}

export const fmtMs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, "0")}초`;
};

export type { ActiveDrill, DrillRun };
