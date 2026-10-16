import { describe, expect, it } from "vitest";
import { recommend, type Cell } from "@/lib/mastery";

const cell = (p: Partial<Cell>): Cell => ({ subject: "redis", level: "기초", notes: 4, read: 0, cards: 10, seen: 0, retention: 0, labs: 0, labsDone: 0, score: 0, ...p });

describe("약점 지도 추천", () => {
  it("시작한 주제의 낮은 칸을 먼저, 기억 확률이 낮으면 복습을 권한다", () => {
    const recs = recommend([cell({ subject: "redis", read: 4, seen: 8, retention: 0.5, score: 55 }), cell({ subject: "docker", level: "중급", read: 1, score: 30 })]);
    expect(recs[0].cell.subject).toBe("redis");
    expect(recs[0].reason).toMatch(/기억 확률 50%/);
    expect(recs.map((r) => r.cell.subject)).toContain("docker");
  });
  it("아무것도 시작하지 않았으면 선수 지식이 없는 기초 주제를 권한다", () => {
    const recs = recommend([cell({ subject: "redis" }), cell({ subject: "kubernetes" })]);
    expect(recs.map((r) => r.cell.subject)).toEqual(["redis"]);
  });
});
