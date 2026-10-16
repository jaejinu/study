/** 클라이언트에서도 쓰는 학습 기록 타입·유틸 (Redis/node 의존 없음) */
export interface QuizStat {
  right: number;
  wrong: number;
  /** 연속 정답 */
  streak: number;
  /** (구) 라이트너 상자 0~4 — FSRS 안정도로부터 계산해 호환용으로 유지 */
  box: number;
  /** 다음 복습 시각 (epoch ms) */
  due: number;
  last: number;
  /** FSRS: 기억 안정도(일) — 회상 확률이 90% 로 떨어지기까지의 기간 */
  stability?: number;
  /** FSRS: 난이도 1(쉬움) ~ 10(어려움) */
  difficulty?: number;
  reps?: number;
  lapses?: number;
}

/** 답 평가: 1 다시(기억 못 함) · 2 어려움 · 3 좋음 · 4 쉬움 */
export type Grade = 1 | 2 | 3 | 4;

/**
 * FSRS-4.5 (Free Spaced Repetition Scheduler) — 기본 가중치.
 * 회상 확률 R(t) = (1 + F·t/S)^D, 목표 회상률 90% 에서 다음 간격 = 안정도 S.
 * 성공하면 S 가 (난이도·현재 R·현재 S 에 따라) 커지고, 실패하면 작아진다.
 */
const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const DAY = 86_400_000;
const RELEARN_MS = 10 * 60_000;
const clampD = (d: number) => Math.min(10, Math.max(1, d));
const initS = (g: Grade) => W[g - 1];
const initD = (g: Grade) => clampD(W[4] - (g - 3) * W[5]);

/** 마지막 복습 이후 지금의 회상 확률 (0~1) */
export function retrievability(s: QuizStat | undefined, now = Date.now()): number {
  if (!s || !s.last) return 0;
  const S = s.stability ?? legacyStability(s);
  const t = Math.max(0, (now - s.last) / DAY);
  return Math.pow(1 + (FACTOR * t) / S, DECAY);
}

function legacyStability(s: QuizStat): number {
  return [0.4, 1, 3, 7, 14][Math.max(0, Math.min(4, s.box ?? 0))];
}

/** 평가 하나를 반영한 새 기록 */
export function schedule(prev: QuizStat | undefined, g: Grade, now = Date.now()): QuizStat {
  const base: QuizStat = prev ?? { right: 0, wrong: 0, streak: 0, box: 0, due: 0, last: 0, reps: 0, lapses: 0 };
  const first = !prev || !prev.last;
  let S: number;
  let D: number;
  if (first) {
    S = initS(g);
    D = initD(g);
  } else {
    const S0 = prev.stability ?? legacyStability(prev);
    const D0 = prev.difficulty ?? 5;
    const R = retrievability(prev, now);
    D = clampD(W[7] * initD(4) + (1 - W[7]) * (D0 - W[6] * (g - 3)));
    if (g === 1) S = W[11] * Math.pow(D0, -W[12]) * (Math.pow(S0 + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R));
    else S = S0 * (Math.exp(W[8]) * (11 - D0) * Math.pow(S0, -W[9]) * (Math.exp(W[10] * (1 - R)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1) + 1);
  }
  S = Math.max(0.1, Math.min(36500, S));
  const due = g === 1 ? now + RELEARN_MS : now + Math.max(1, Math.round(S)) * DAY;
  const right = g >= 2;
  return {
    right: base.right + (right ? 1 : 0),
    wrong: base.wrong + (right ? 0 : 1),
    streak: right ? base.streak + 1 : 0,
    box: S < 1 ? 0 : S < 3 ? 1 : S < 7 ? 2 : S < 14 ? 3 : 4,
    due,
    last: now,
    stability: Math.round(S * 100) / 100,
    difficulty: Math.round(D * 100) / 100,
    reps: (base.reps ?? 0) + 1,
    lapses: (base.lapses ?? 0) + (g === 1 && !first ? 1 : 0),
  };
}

/** 버튼마다 "이걸 고르면 다음 복습은 언제" 미리보기 */
export function previewIntervals(prev: QuizStat | undefined, now = Date.now()): Record<Grade, string> {
  const fmt = (ms: number) => (ms < DAY ? `${Math.round(ms / 60_000)}분` : ms < 30 * DAY ? `${Math.round(ms / DAY)}일` : ms < 365 * DAY ? `${Math.round(ms / (30 * DAY))}개월` : `${(ms / (365 * DAY)).toFixed(1)}년`);
  const out = {} as Record<Grade, string>;
  for (const g of [1, 2, 3, 4] as Grade[]) out[g] = fmt(schedule(prev, g, now).due - now);
  return out;
}

export const GRADE_LABEL: Record<Grade, string> = { 1: "다시", 2: "어려움", 3: "좋음", 4: "쉬움" };


export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
