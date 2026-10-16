/** 클라이언트에서도 쓰는 학습 기록 타입·유틸 (Redis/node 의존 없음) */
export interface QuizStat {
  right: number;
  wrong: number;
  /** 연속 정답 */
  streak: number;
  /** 라이트너 상자 0(새로/틀림) ~ 4(안정) */
  box: number;
  /** 다음 복습 시각 (epoch ms) */
  due: number;
  last: number;
}

/** 상자별 복습 간격 (ms): 즉시 · 1일 · 3일 · 7일 · 14일 */
export const BOX_INTERVALS = [0, 1, 3, 7, 14].map((d) => d * 86_400_000);

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
