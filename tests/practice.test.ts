import { describe, expect, it } from "vitest";
import { closestSentence, conceptMentioned, extractConcepts, groundFeedback, hasQuestion, keywordRecall, keywords, parseFeedback, sampleGolden, splitSections, visibleTurn, type Feedback } from "@/lib/practice/core";

const NOTE = `도입 문단

## 왜 파이프라인인가

**RTT** 가 병목이다. 명령을 묶으면 **왕복 시간** 을 줄인다.

\`\`\`bash
## 코드 안의 제목은 무시
redis-cli --pipe
\`\`\`

### 배치 크기

## 얼마나 묶을까?

**수천 개씩 묶는 것이 일반적이다.**

## 실습 체크리스트

- [ ] 해 보기
`;

describe("splitSections", () => {
  it("## 제목 단위로 나누고 코드 블록 안 # 와 체크리스트 섹션은 무시한다", () => {
    const s = splitSections(NOTE);
    expect(s.map((x) => x.title)).toEqual(["왜 파이프라인인가", "얼마나 묶을까?"]);
    expect(s[0].id).toBe("s1");
    expect(s[0].body).toContain("redis-cli --pipe");
  });
});

describe("extractConcepts", () => {
  it("태그 → 굵은 용어 → 짧은 소제목 순, 문장형 굵은 글씨와 의문형 제목은 뺀다", () => {
    const c = extractConcepts({ content: NOTE, tags: ["pipeline"] });
    expect(c[0]).toBe("pipeline");
    expect(c).toContain("RTT");
    expect(c).toContain("왕복 시간");
    expect(c).toContain("배치 크기");
    expect(c).not.toContain("얼마나 묶을까?");
    expect(c.some((x) => x.includes("일반적이다"))).toBe(false);
  });
  it("섹션을 고르면 그 섹션 본문에서만 뽑는다", () => {
    expect(extractConcepts({ content: NOTE, tags: ["pipeline"], section: "s1" })).toEqual(["RTT", "왕복 시간", "배치 크기"]);
  });
});

describe("parseFeedback", () => {
  it("코드 펜스·앞뒤 잡담을 허용한다", () => {
    const fb = parseFeedback('네, 평가입니다.\n```json\n{"score": 72, "covered": ["RTT"], "missing": [], "wrong": [{"claim":"a","evidence":"b"}], "followup": ["q1","q2","q3"]}\n```');
    expect(fb?.score).toBe(72);
    expect(fb?.wrong).toEqual([{ claim: "a", evidence: "b" }]);
    expect(fb?.followup).toHaveLength(2);
  });
  it("0~1 비율 점수는 100점 만점으로, 범위 밖은 자른다", () => {
    expect(parseFeedback('{"score": 0.65, "covered": [], "missing": [], "wrong": [], "followup": []}')?.score).toBe(65);
    expect(parseFeedback('{"score": 140, "covered": [], "missing": [], "wrong": [], "followup": []}')?.score).toBe(100);
  });
  it("깨진 JSON 이나 score 없는 응답은 null (라우트가 1회 재시도)", () => {
    expect(parseFeedback('{"score": 70, "covered": [')).toBeNull();
    expect(parseFeedback('{"covered": []}')).toBeNull();
    expect(parseFeedback("")).toBeNull();
  });
});

describe("groundFeedback", () => {
  const base: Feedback = { score: 80, covered: ["지어낸 개념"], missing: [], wrong: [], followup: [] };
  const concepts = ["RTT", "왕복 시간", "배치 크기", "MULTI"];
  const explanation = "파이프라인은 RTT 를 줄이려고 여러 명령을 한 번에 보내서 왕복 시간을 아낀다.";

  it("covered/missing 은 모델 말이 아니라 설명에 실제로 나온 개념으로 정한다", () => {
    const g = groundFeedback(base, concepts, explanation, NOTE);
    expect(g.covered).toEqual(["RTT", "왕복 시간"]);
    expect(g.missing).toEqual(["배치 크기", "MULTI"]);
    expect(g.coverage).toBe(0.5);
    expect(g.score).toBe(Math.round(0.5 * 60 + 80 * 0.4));
    expect(g.modelScore).toBe(80);
  });
  it("노트에 없는 근거를 단 '틀린 주장' 은 버리고, 있는 것만 감점한다", () => {
    const g = groundFeedback({ ...base, wrong: [{ claim: "x", evidence: "명령을 묶으면 왕복 시간 을 줄인다" }, { claim: "y", evidence: "노트에 전혀 없는 지어낸 문장입니다" }] }, concepts, explanation, NOTE);
    expect(g.wrong.map((w) => w.claim)).toEqual(["x"]);
    expect(g.droppedWrong).toBe(1);
    expect(g.score).toBe(Math.round(0.5 * 60 + 80 * 0.4 - 7));
  });
  it("스키마 문구를 베낀 꼬리 질문은 빠진 개념으로 만든 질문으로 바꾼다", () => {
    const g = groundFeedback({ ...base, followup: ["이해를 확인할 다음 질문 1~2개"], summary: "한 문장 총평" }, concepts, explanation, NOTE);
    expect(g.followup).toHaveLength(2);
    expect(g.followup[0]).toContain("배치 크기");
    expect(g.summary).toBeUndefined();
  });
  it("conceptMentioned 는 조사를 떼고 핵심 단어 과반이면 다룬 것으로 본다", () => {
    expect(conceptMentioned("클러스터에서의 파이프라인", "파이프라인은 RTT 를 줄인다")).toBe(false);
    expect(conceptMentioned("클러스터에서의 파이프라인", "클러스터에서는 파이프라인을 슬롯별로 나눈다")).toBe(true);
    expect(conceptMentioned("Lua 스크립트", "파이프라인만 썼다")).toBe(false);
  });
});

describe("sampleGolden / keywordRecall", () => {
  const by = { a: Array.from({ length: 20 }, (_, i) => ({ q: `a${i}` })), b: Array.from({ length: 3 }, (_, i) => ({ q: `b${i}` })), c: [] as { q: string }[] };
  it("시드가 같으면 같은 표본, 주제를 고르게 돌아가며 뽑는다", () => {
    const s1 = sampleGolden(by, 8, 42);
    expect(sampleGolden(by, 8, 42)).toEqual(s1);
    expect(sampleGolden(by, 8, 7)).not.toEqual(s1);
    expect(s1).toHaveLength(8);
    expect(s1.filter((x) => x.subject === "b")).toHaveLength(3);
    expect(s1.slice(0, 2).map((x) => x.subject).sort()).toEqual(["a", "b"]);
  });
  it("정답 키워드(조사 제거) 중 답에 나온 비율", () => {
    expect(keywords("파이프라인은 왕복 시간을 줄인다")).toEqual(["파이프라인", "왕복", "시간을", "줄인다"].map((w) => w.replace(/을$/, "")));
    expect(keywordRecall("파이프라인으로 왕복을 줄임", "파이프라인은 왕복 시간을 줄인다")).toBeCloseTo(2 / 4);
    expect(keywordRecall("아무 말", "")).toBe(0);
  });
});

describe("hasQuestion", () => {
  it("물음표나 의문형 어미가 있어야 질문으로 본다", () => {
    expect(hasQuestion("안녕하세요, 시니어 기술 면접관입니다. 먼저 인사를 드리겠습니다.")).toBe(false);
    expect(hasQuestion("파이프라인이 왜 빠른가요?")).toBe(true);
    expect(hasQuestion("평가: 좋습니다.\n꼬리 질문: 배치 크기는 어떻게 정하나요")).toBe(true);
  });
});

describe("closestSentence / 확인 필요 지적", () => {
  const note = "## 원자성\n\n- 원자성은 **없다**. 중간에 다른 클라이언트 명령이 끼어들 수 있다.\n\n```\n원자성 코드\n```\n\n파이프라인은 RTT 를 줄인다. 파이프라인은 배치로 묶는다.";
  it("주장과 핵심 단어가 가장 많이 겹치는 노트 문장을 찾는다", () => {
    expect(closestSentence("파이프라인은 원자성을 보장한다", note)).toBe("원자성은 없다.");
    expect(closestSentence("Lua 스크립트 캐시", note)).toBeNull();
  });
  it("근거 없는 지적은 감점하지 않고, 학습자가 한 말에 대한 것만 가까운 노트 문장과 함께 돌려준다", () => {
    const fb: Feedback = { score: 80, covered: [], missing: [], wrong: [{ claim: "원자성을 보장한다", evidence: "노트의 내용과 일치하지 않음" }, { claim: "클러스터 슬롯 이야기", evidence: "없음" }], followup: ["파이프라인을 更深入了解하기"], summary: "좋다" };
    const g = groundFeedback(fb, ["RTT"], "파이프라인은 RTT 를 줄이고 원자성을 보장한다", note);
    expect(g.wrong).toEqual([]);
    expect(g.unverified).toEqual([{ claim: "원자성을 보장한다", evidence: "원자성은 없다." }]);
    expect(g.followup.some((q) => /更/.test(q))).toBe(false);
  });
});

describe("visibleTurn", () => {
  const raw = '**첫 질문:** X?\n\n**지원자 답변:**\n답\n\n**평가:**\n- 맞은 점: 좋다\n\n**꼬리 질문:** 배치 크기는 어떻게 정하나요? 그리고 더 쓰기\n\n**모범 답:** 비밀';
  it("되풀이를 건너뛰고 평가부터 꼬리 질문의 물음표까지만, 모범 답은 노출하지 않는다", () => {
    const v = visibleTurn(raw, true);
    expect(v.startsWith("**평가:**")).toBe(true);
    expect(v.endsWith("정하나요?")).toBe(true);
    expect(v).not.toContain("비밀");
    expect(v).not.toContain("지원자 답변");
  });
  it("스트리밍 중 결과는 항상 최종 결과의 접두사다", () => {
    let prev = "";
    for (let i = 1; i <= raw.length; i++) {
      const v = visibleTurn(raw.slice(0, i), false);
      expect(v.startsWith(prev) || v.length < prev.length).toBe(true);
      if (v.length >= prev.length) prev = v;
    }
    expect(visibleTurn(raw, true).startsWith(prev)).toBe(true);
  });
  it("평가 표시가 없으면 끝나고 나서 전체를 보여 준다 (모범 답은 잘라냄)", () => {
    expect(visibleTurn("좋은 답입니다. 다음은?", false)).toBe("");
    expect(visibleTurn("좋은 답입니다. (모범 답: 비밀)", true)).toBe("좋은 답입니다.");
  });
});

describe("visibleTurn — 질문이 아닌 꼬리 질문", () => {
  it("물음표 없는 꼬리 질문은 버린다 (라우트가 은행 질문으로 대신)", () => {
    const raw = "**평가:** 좋다.\n\n**꼬리 질문:** EXEC 결과는 에러만 돌아옵니다.";
    expect(visibleTurn(raw, true)).toBe("**평가:** 좋다.");
    expect(hasQuestion(visibleTurn(raw, true))).toBe(false);
  });
});
