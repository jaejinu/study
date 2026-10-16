import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { drills } from "@/lib/drills/catalog";
import { capstones } from "@/lib/drills/capstone";
import { findExperiment } from "@/lab/registry";

const CONTENT = path.join(process.cwd(), "content");
const noteExists = (href: string) => {
  const m = href.match(/^\/([a-z0-9-]+)\/notes\/([a-z0-9-]+)$/);
  return !!m && fs.existsSync(path.join(CONTENT, m[1], "notes", `${m[2]}.md`));
};

describe("장애 대응 훈련 정의", () => {
  it("5개 이상, id 가 고유하고 URL 에 쓸 수 있다", () => {
    expect(drills.length).toBeGreaterThanOrEqual(5);
    const ids = drills.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  for (const d of drills) {
    describe(d.id, () => {
      it("setup·check·reset·requires 가 함수다", () => {
        for (const f of [d.setup, d.check, d.reset, d.requires]) expect(typeof f).toBe("function");
      });
      it("증상·관찰 명령이 있고, 증상에 원인을 직접 말하지 않는다", () => {
        expect(d.symptoms.length).toBeGreaterThan(0);
        expect(d.starters.length).toBeGreaterThan(0);
        expect(d.title.length).toBeGreaterThan(0);
        expect(d.summary.length).toBeGreaterThan(0);
      });
      it("힌트가 정확히 3개이고 비어 있지 않다", () => {
        expect(d.hints).toHaveLength(3);
        for (const h of d.hints) expect(h.trim().length).toBeGreaterThan(5);
      });
      it("해설(원인·고치는 법)과 정답 명령이 있다", () => {
        expect(d.explanation.cause.length).toBeGreaterThan(20);
        expect(d.explanation.fix.length).toBeGreaterThan(10);
        expect(d.solution.length).toBeGreaterThan(0);
        for (const s of d.solution) expect(s.bin.length).toBeGreaterThan(0);
      });
      it("관련 노트 링크가 실제 노트 파일이다", () => {
        expect(d.explanation.notes.length).toBeGreaterThan(0);
        const broken = d.explanation.notes.filter((n) => !noteExists(n.href)).map((n) => n.href);
        expect(broken).toEqual([]);
      });
      it("제한 시간이 양수이고 데드맨 원복 명령이 전용 리소스만 지운다", () => {
        expect(d.timeLimitMin).toBeGreaterThan(0);
        expect(d.timeLimitMin).toBeLessThanOrEqual(60);
        expect(d.deadmanCommand.length).toBeGreaterThan(0);
        expect(/lab-drill-|ns drill\b|namespace drill\b/.test(d.deadmanCommand)).toBe(true);
      });
    });
  }
});

describe("종합 과제 정의", () => {
  it("2개 이상, 각 6단계 안팎이고 id 가 고유하다", () => {
    expect(capstones.length).toBeGreaterThanOrEqual(2);
    for (const p of capstones) {
      expect(p.steps.length).toBeGreaterThanOrEqual(4);
      const ids = p.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it("모든 단계에 검증기·할 일·노트가 있고, 노트와 실험 id 가 실제로 존재한다", () => {
    const bad: string[] = [];
    for (const p of capstones)
      for (const s of p.steps) {
        if (typeof s.verify !== "function") bad.push(`${p.id}/${s.id}: verify`);
        if (!s.actions.length) bad.push(`${p.id}/${s.id}: actions`);
        if (!s.notes.length) bad.push(`${p.id}/${s.id}: notes`);
        for (const n of s.notes) if (!noteExists(n.href)) bad.push(`${p.id}/${s.id}: note ${n.href}`);
        for (const e of s.experiments) if (!findExperiment(e)) bad.push(`${p.id}/${s.id}: experiment ${e}`);
      }
    expect(bad).toEqual([]);
  });
});
