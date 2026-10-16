import { describe, expect, it } from "vitest";
import { previewIntervals, retrievability, schedule, type QuizStat } from "@/lib/study-shared";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

describe("FSRS 스케줄링", () => {
  it("첫 평가: 다시는 10분 뒤, 좋음은 약 4일 뒤, 쉬움이 가장 길다", () => {
    const again = schedule(undefined, 1, T0);
    const good = schedule(undefined, 3, T0);
    const easy = schedule(undefined, 4, T0);
    expect(again.due - T0).toBe(10 * 60_000);
    expect(Math.round((good.due - T0) / DAY)).toBe(4);
    expect(easy.due).toBeGreaterThan(good.due);
    expect(good.difficulty).toBeLessThan(again.difficulty!);
  });
  it("기한에 맞춰 성공하면 안정도가 커지고, 실패하면 줄며 lapses 가 는다", () => {
    const s1 = schedule(undefined, 3, T0);
    const s2 = schedule(s1, 3, s1.due);
    expect(s2.stability!).toBeGreaterThan(s1.stability!);
    const lapse = schedule(s2, 1, s2.due);
    expect(lapse.stability!).toBeLessThan(s2.stability!);
    expect(lapse.lapses).toBe(1);
  });
  it("간격이 지날수록 회상 확률이 떨어지고, 안정도만큼 지나면 약 90%", () => {
    const s = schedule(undefined, 3, T0);
    const atDue = retrievability(s, T0 + s.stability! * DAY);
    expect(atDue).toBeGreaterThan(0.89);
    expect(atDue).toBeLessThan(0.91);
    expect(retrievability(s, T0 + 30 * DAY)).toBeLessThan(atDue);
  });
  it("예전 라이트너 상자 기록도 이어서 스케줄된다", () => {
    const legacy: QuizStat = { right: 3, wrong: 0, streak: 3, box: 3, due: T0, last: T0 - 7 * DAY };
    const next = schedule(legacy, 3, T0);
    expect(next.stability!).toBeGreaterThan(7);
    expect(Object.keys(previewIntervals(legacy, T0))).toEqual(["1", "2", "3", "4"]);
  });
});
