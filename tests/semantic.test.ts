import { describe, expect, it } from "vitest";
import { chunkNote, cleanMarkdown, type NoteInput } from "@/lib/semantic/chunk";
import { groupByNote, noteKeyOf, rrfFuse } from "@/lib/semantic/rrf";
import { getNote, listNotes } from "@/lib/notes";
import { subjects } from "@/lib/subjects";

const base: Omit<NoteInput, "content" | "headings"> = { subject: "redis", slug: "99-test", title: "테스트 노트", summary: "요약 문장", level: "기초", tags: ["캐시"] };

describe("cleanMarkdown", () => {
  it("코드 블록은 앞 몇 줄만 남기고 mermaid 는 버린다", () => {
    const md = ["본문", "```js", ...Array.from({ length: 10 }, (_, i) => `line${i}`), "```", "```mermaid", "graph LR; A-->B", "```", "끝 [링크](http://x) **굵게**"].join("\n");
    const out = cleanMarkdown(md, 3);
    expect(out).toContain("line0");
    expect(out).toContain("line2");
    expect(out).not.toContain("line3");
    expect(out).toContain("…");
    expect(out).not.toContain("graph LR");
    expect(out).toContain("끝 링크 굵게");
  });
});

describe("chunkNote", () => {
  it("## 섹션마다 청크를 만들고 도입부엔 요약·태그를 붙이며, 앵커는 headings 의 id 를 쓴다", () => {
    const content = ["도입 문단", "", "## 첫 섹션", "첫 내용", "", "```bash", "# 코드 안의 제목은 무시", "```", "", "## 둘째 섹션", "둘째 내용"].join("\n");
    const headings = [
      { depth: 2, text: "첫 섹션", id: "첫-섹션" },
      { depth: 2, text: "둘째 섹션", id: "둘째-섹션" },
    ];
    const cs = chunkNote({ ...base, content, headings });
    expect(cs.map((c) => c.id)).toEqual(["redis/99-test#_intro", "redis/99-test#첫-섹션", "redis/99-test#둘째-섹션"]);
    expect(cs[0].body).toContain("요약 문장");
    expect(cs[0].body).toContain("태그: 캐시");
    expect(cs[0].href).toBe("/redis/notes/99-test");
    expect(cs[1].href).toBe("/redis/notes/99-test#첫-섹션");
    expect(cs[1].body).toContain("# 코드 안의 제목은 무시");
    expect(cs[1].text.startsWith("테스트 노트 — 첫 섹션\n")).toBe(true);
    expect(new Set(cs.map((c) => c.hash)).size).toBe(3);
  });

  it("긴 섹션은 ### 경계로 나누고 묶음의 첫 ### 앵커로 이동한다", () => {
    const para = (w: string) => `${w} `.repeat(120).trim();
    const content = ["## 큰 섹션", para("가"), "", "### 하위 A", para("나"), "", "### 하위 B", para("다")].join("\n");
    const headings = [
      { depth: 2, text: "큰 섹션", id: "큰-섹션" },
      { depth: 3, text: "하위 A", id: "하위-a" },
      { depth: 3, text: "하위 B", id: "하위-b" },
    ];
    const cs = chunkNote({ ...base, summary: "", tags: [], content, headings }, { maxChars: 400 });
    expect(cs.map((c) => c.anchor)).toEqual(["큰-섹션", "하위-a", "하위-b"]);
    expect(cs[2].heading).toBe("큰 섹션 > 하위 B");
    expect(cs.every((c) => c.body.length <= 400)).toBe(true);
    expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
  });

  it("실제 노트 전체: 청크 id 가 유일하고 모든 앵커가 노트 목차 id 중 하나다", async () => {
    let total = 0;
    for (const s of subjects) {
      for (const m of await listNotes(s.id)) {
        const n = (await getNote(s.id, m.slug))!;
        const cs = chunkNote({ subject: s.id, slug: m.slug, title: n.title, summary: n.summary, level: n.level, tags: n.tags, content: n.content, headings: n.headings });
        const ids = new Set(n.headings.map((h) => h.id));
        for (const c of cs) expect(c.anchor === "" || ids.has(c.anchor), `${c.id}`).toBe(true);
        expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
        expect(cs.length).toBeGreaterThan(0);
        total += cs.length;
      }
    }
    expect(total).toBeGreaterThan(1000);
  });
});

describe("RRF", () => {
  it("순위의 역수 합으로 합치고, 두 목록에 모두 있는 문서가 위로 온다", () => {
    const f = rrfFuse([["a", "b", "c"], ["c", "a", "d"]], 60);
    expect(f[0].id).toBe("a"); // 1/61 + 1/62
    expect(f[1].id).toBe("c"); // 1/63 + 1/61
    expect(f[0].score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(f.find((x) => x.id === "d")!.ranks).toEqual([null, 3]);
    expect(f.find((x) => x.id === "b")!.ranks).toEqual([2, null]);
  });

  it("가중치와 k 가 반영되고, 한 목록 안의 중복은 첫 순위만 센다", () => {
    const f = rrfFuse([["a", "a"], ["b"]], 10, [1, 2]);
    expect(f[0].id).toBe("b");
    expect(f[0].score).toBeCloseTo(2 / 11, 10);
    expect(f[1].score).toBeCloseTo(1 / 11, 10);
  });
});

describe("groupByNote", () => {
  it("노트별 최고 섹션만 남기고 매치 수를 센다", () => {
    const items = [
      { id: "redis/01#a", score: 0.5 },
      { id: "kafka/02#x", score: 0.4 },
      { id: "redis/01#b", score: 0.3 },
      { id: "redis/03#_intro~1", score: 0.2 },
    ];
    const g = groupByNote(items, 10);
    expect(g.map((x) => x.noteKey)).toEqual(["redis/01", "kafka/02", "redis/03"]);
    expect(g[0].best.id).toBe("redis/01#a");
    expect(g[0].matched).toBe(2);
    expect(noteKeyOf("redis/03#_intro~1")).toBe("redis/03");
  });

  it("bonus 를 주면 여러 섹션이 맞는 노트가 앞선다", () => {
    const items = [
      { id: "a/1#x", score: 0.5 },
      { id: "b/2#x", score: 0.45 },
      { id: "b/2#y", score: 0.4 },
    ];
    expect(groupByNote(items, 10, 0)[0].noteKey).toBe("a/1");
    expect(groupByNote(items, 10, 0.3)[0].noteKey).toBe("b/2");
    expect(groupByNote(items, 1, 0.3)).toHaveLength(1);
  });
});
