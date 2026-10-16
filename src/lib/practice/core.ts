/**
 * AI 학습 모드의 순수 함수들 (서버·클라이언트·테스트에서 공용, I/O 없음).
 *  - 설명해 보기: 노트에서 핵심 개념 체크리스트를 뽑고, 모델의 JSON 피드백을 검증한다
 *  - 모델 비교: 퀴즈 골든셋 표본 추출(시드 고정), 정답 키워드 재현율
 */

export interface Section {
  id: string;
  title: string;
  body: string;
}

/** 노트 본문을 `## ` 제목 단위로 나눈다 (코드 블록 안의 # 는 무시) */
export function splitSections(content: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  let inCode = false;
  const intro: string[] = [];
  for (const line of content.split("\n")) {
    if (/^```/.test(line.trim())) inCode = !inCode;
    const m = !inCode && /^##\s+(.+?)\s*$/.exec(line);
    if (m && !line.startsWith("###")) {
      if (cur) out.push(cur);
      const title = m[1].replace(/[`*]/g, "").trim();
      cur = { id: `s${out.length + 1}`, title, body: "" };
      continue;
    }
    if (cur) cur.body += `${line}\n`;
    else intro.push(line);
  }
  if (cur) out.push(cur);
  return out.filter((s) => !/실습 체크리스트|함께 읽기|이어서 읽기/.test(s.title));
}

const STOP_TITLES = /^(예시로 보기|실습 체크리스트|정리|요약|들어가며|참고|함께 읽기|이어서 읽기)/;

/**
 * 핵심 개념 체크리스트: `##`/`###` 제목, **굵은 글씨**, tags 에서 짧은 명사구를 뽑는다.
 * 작은 모델은 "무엇이 빠졌나" 를 스스로 찾기 어렵기 때문에 체크리스트를 주면 판정이 안정적이다.
 */
export function extractConcepts(input: { content: string; tags?: string[]; section?: string }, max = 12): string[] {
  const text = input.section ? (splitSections(input.content).find((s) => s.id === input.section || s.title === input.section)?.body ?? input.content) : input.content;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const t = raw
      .replace(/[`*_]/g, "")
      .replace(/\s*[—–:]\s.*$/, "")
      .replace(/\(.*?\)/g, "")
      .trim();
    if (t.length < 2 || t.length > 30 || STOP_TITLES.test(t) || /^\d+[.)]?$/.test(t)) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  // 우선순위: 태그 → 굵은 글씨(용어) → 짧은 소제목. 소제목은 "얼마나 묶을까" 같은 문장형이 많아 마지막에, 짧고 의문형이 아닌 것만
  if (!input.section) for (const t of input.tags ?? []) add(t);
  // 굵은 글씨는 '용어' 만: 16자 이하, 문장 끝(다·요·음·함)이 아니고, 글자(한글·영문)가 들어 있는 것
  for (const m of text.matchAll(/\*\*([^*\n]{2,40})\*\*/g)) {
    const t = m[1].trim();
    if (t.length <= 16 && !/(다|요|음|함|임|니다)[.!]?$/.test(t) && /[A-Za-z가-힣]/.test(t) && !/^[~\d\s.,%-]+/.test(t)) add(t);
  }
  let inCode = false;
  for (const line of text.split("\n")) {
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const h = /^(#{2,3})\s+(.+)$/.exec(line);
    if (!h || (input.section && h[1] === "##")) continue;
    const t = h[2].replace(/[`*_]/g, "").replace(/\s*[—–:]\s.*$/, "").trim();
    if (t.length <= 16 && !/[?？까요]$/.test(t)) add(t);
  }
  return out.slice(0, max);
}

export interface Feedback {
  score: number;
  covered: string[];
  missing: string[];
  wrong: { claim: string; evidence: string }[];
  followup: string[];
  summary?: string;
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? Object.values(x).join(" — ") : String(x))).map((s) => s.trim()).filter(Boolean) : []);

/** 모델 응답에서 피드백 JSON 을 꺼내 검증한다. 코드 펜스·앞뒤 잡담을 허용, 형식이 안 맞으면 null */
export function parseFeedback(text: string): Feedback | null {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidates = [fenced, text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter((c): c is string => !!c && c.includes("{"));
  for (const c of candidates) {
    try {
      const j = JSON.parse(c.trim()) as Record<string, unknown>;
      const scoreRaw = typeof j.score === "string" ? parseFloat(j.score) : j.score;
      if (typeof scoreRaw !== "number" || Number.isNaN(scoreRaw)) continue;
      const score = Math.round(Math.min(100, Math.max(0, scoreRaw <= 1 && scoreRaw > 0 && !Number.isInteger(scoreRaw) ? scoreRaw * 100 : scoreRaw)));
      const wrong = Array.isArray(j.wrong)
        ? j.wrong
            .map((w) => (typeof w === "string" ? { claim: w, evidence: "" } : typeof w === "object" && w ? { claim: String((w as Record<string, unknown>).claim ?? (w as Record<string, unknown>).주장 ?? ""), evidence: String((w as Record<string, unknown>).evidence ?? (w as Record<string, unknown>).근거 ?? "") } : null))
            .filter((w): w is { claim: string; evidence: string } => !!w && !!w.claim.trim())
        : [];
      return { score, covered: asStrings(j.covered), missing: asStrings(j.missing), wrong, followup: asStrings(j.followup).slice(0, 2), summary: typeof j.summary === "string" ? j.summary : undefined };
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

/** 개념이 설명에 나왔는지: 개념의 핵심 단어(2자 이상, 조사 제거) 중 과반이 설명에 있으면 (두 단어 개념은 둘 다) 다룬 것으로 본다 */
export function conceptMentioned(concept: string, explanation: string): boolean {
  const ks = keywords(concept);
  if (ks.length === 0) return false;
  const lower = explanation.toLowerCase();
  const hit = ks.filter((k) => lower.includes(k)).length;
  return hit > ks.length / 2;
}

/** 노트에서 주장과 핵심 단어가 가장 많이 겹치는 문장 (코드 블록·표 구분선 제외, 드문 단어에 가중). 겹침이 없으면 null */
export function closestSentence(claim: string, note: string): string | null {
  const ks = keywords(claim);
  if (ks.length === 0) return null;
  const sentences = note
    .replace(/```[\s\S]*?```/g, "\n")
    .split(/\n|(?<=[.!?。])\s+/)
    .map((x) => x.replace(/^[\s>*#|-]+/, "").replace(/[`*_]/g, "").trim())
    .filter((x) => x.length >= 8 && !/^[-|:\s]+$/.test(x));
  // 드문 단어일수록 무게를 크게 (노트 전체에 흔한 "파이프라인" 보다 "원자성" 이 겹치는 문장이 근거에 가깝다)
  const lowers = sentences.map((x) => x.toLowerCase());
  const weight = new Map(ks.map((k) => [k, 1 / Math.max(1, lowers.filter((l) => l.includes(k)).length)]));
  let best: { s: string; score: number } | null = null;
  for (const [i, sen] of sentences.entries()) {
    const score = ks.reduce((a, k) => a + (lowers[i].includes(k) ? weight.get(k)! : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { s: sen, score };
  }
  return best ? best.s.slice(0, 200) : null;
}

/** 한국어 응답에 한자가 섞이는 작은 모델의 언어 이탈 */
const HAN = /\p{Script=Han}/u;

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[`*_"'“”‘’]/g, "").trim().toLowerCase();

/**
 * 모델 피드백을 근거로 묶는다 (작은 모델은 체크리스트와 무관한 covered, 노트에 없는 '근거' 를 지어내기 쉽다).
 *  - covered/missing: 체크리스트 항목이 설명에 실제로 나왔는지 서버가 직접 판정 (모델 판단과 무관하게 재현 가능)
 *  - wrong: evidence 가 노트 본문에 실제로 있는 문장(8자 이상 일치)일 때만 남긴다
 *  - score: 직접 판정한 개념 포함률 60% + 모델 점수 40%
 */
export function groundFeedback(fb: Feedback, concepts: string[], explanation: string, noteContent: string): Feedback & { modelScore: number; coverage: number; droppedWrong: number; unverified: { claim: string; evidence: string }[] } {
  const explained = explanation.toLowerCase();
  const covered = concepts.filter((c) => conceptMentioned(c, explanation));
  const missing = concepts.filter((c) => !covered.includes(c));
  const note = norm(noteContent);
  const wrong = fb.wrong.filter((w) => {
    const ev = norm(w.evidence);
    if (ev.length < 8) return false;
    // 근거의 앞부분 20자(또는 전체)가 노트에 그대로 있어야 인정
    return note.includes(ev.slice(0, Math.min(20, ev.length)));
  });
  const coverage = concepts.length ? covered.length / concepts.length : fb.score / 100;
  // 모델이 스키마 설명 문구를 그대로 베낀 꼬리 질문은 버리고, 빠진 개념으로 질문을 만든다
  const templ = /(1~2개|다음 질문|이해를 확인할|체크리스트 중)/;
  let followup = fb.followup.filter((q) => q.length >= 6 && !templ.test(q) && !HAN.test(q));
  if (followup.length === 0) followup = missing.slice(0, 2).map((c) => `'${c}' 는 무엇이고, 이 노트의 주제에서 왜 중요한가요?`);
  const score = Math.round(coverage * 60 + fb.score * 0.4 - Math.min(20, wrong.length * 7));
  return { ...fb, covered, missing, wrong, followup, summary: fb.summary && !/한 문장 총평/.test(fb.summary) && !HAN.test(fb.summary) ? fb.summary : undefined, score: Math.max(0, Math.min(100, score)), modelScore: fb.score, coverage: Math.round(coverage * 100) / 100, droppedWrong: fb.wrong.length - wrong.length, unverified: fb.wrong
      .filter((w) => !wrong.includes(w))
      // 학습자가 실제로 한 말에 대한 지적만, 노트의 가장 가까운 문장을 서버가 찾아 붙인다 (감점 없음 — 학습자가 직접 비교)
      .filter((w) => keywords(w.claim).some((k) => explained.includes(k)))
      .map((w) => ({ claim: w.claim, evidence: closestSentence(w.claim, noteContent) ?? "" }))
      .filter((w) => w.evidence)
      .slice(0, 3) };
}

/** 결정적 PRNG (mulberry32) — 평가 표본을 실행마다 같게 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 주제별 카드 목록에서 n 장을 주제를 고르게 돌아가며(라운드 로빈) 시드 고정으로 뽑는다 */
export function sampleGolden<T>(bySubject: Record<string, T[]>, n: number, seed = 42): (T & { subject: string })[] {
  const rnd = mulberry32(seed);
  const pools = Object.keys(bySubject)
    .sort()
    .map((s) => ({ s, cards: [...bySubject[s]].map((c) => ({ c, r: rnd() })).sort((a, b) => a.r - b.r).map((x) => x.c) }))
    .filter((p) => p.cards.length > 0)
    .map((p) => ({ ...p, order: rnd() }))
    .sort((a, b) => a.order - b.order);
  const out: (T & { subject: string })[] = [];
  for (let i = 0; out.length < n && pools.some((p) => p.cards.length > i); i++) {
    for (const p of pools) {
      if (out.length >= n) break;
      if (p.cards[i]) out.push({ ...p.cards[i], subject: p.s });
    }
  }
  return out;
}

/** 한국어·영문 정답에서 의미 있는 단어(2자 이상, 조사·불용어 제외) */
export function keywords(answer: string): string[] {
  const stop = new Set(["그리고", "하지만", "때문", "경우", "것이", "있다", "없다", "한다", "된다", "이다", "수", "등", "및", "the", "and", "for", "with", "that", "this"]);
  const josa = /(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|이다|한다|된다|하고|하는|해서|하면)$/;
  const words = answer
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w.replace(josa, "") : w))
    .filter((w) => w.length >= 2 && !stop.has(w));
  return [...new Set(words)];
}

/** 정답 키워드 중 모델 답에 나온 비율 (0~1) */
export function keywordRecall(modelAnswer: string, golden: string): number {
  const ks = keywords(golden);
  if (ks.length === 0) return 0;
  const lower = modelAnswer.toLowerCase();
  return ks.filter((k) => lower.includes(k)).length / ks.length;
}

/** 면접관 응답에 실제 질문이 있는지 (물음표, 또는 "~나요/까/세요" 로 끝나는 문장) */
export function hasQuestion(text: string): boolean {
  return /[?？]/.test(text) || /(나요|까요|습니까|인가요|세요)\s*[.!]?\s*$/m.test(text.trim());
}

/**
 * 면접 답변 턴에서 사용자에게 보여 줄 부분 (작은 모델은 입력을 되풀이하고, 모범 답을 흘리고, 질문 뒤에 장황하게 이어 쓴다).
 *  - "평가:" 부터 시작 (앞의 되풀이 제거, 끝까지 없으면 전체)
 *  - "모범 답"/"지원자 답변" 이 나오면 거기서 자름 (면접관만 보는 정보)
 *  - "꼬리 질문" 다음 첫 물음표에서 끝 (물음표가 없으면 꼬리 질문 부분을 버림)
 * 스트리밍 중(done=false)에는 앞부분이 바뀌지 않도록(prefix-stable) 끝의 몇 글자를 보류한다.
 */
export function visibleTurn(acc: string, done: boolean): string {
  let start = acc.search(/\**평가\**\s*[:：]/);
  if (start < 0) {
    if (!done) return "";
    start = 0;
  }
  let body = acc.slice(start);
  let cut = false;
  const leak = body.search(/\**\(?\s*(면접관만 보는 )?모범 답|\**지원자 답변/);
  if (leak >= 0) {
    body = body.slice(0, leak);
    cut = true;
  }
  const fq = body.search(/\**꼬리 질문/);
  if (fq >= 0) {
    const q = body.slice(fq).search(/[?？]/);
    // 물음표가 나올 때까지 꼬리 질문은 보류, 끝내 질문이 아니면 버린다 (라우트가 질문 은행의 다음 질문으로 대신)
    body = q >= 0 ? body.slice(0, fq + q + 1) : body.slice(0, fq);
    cut = true;
  }
  if (done) return body.trim();
  return cut ? body : body.slice(0, Math.max(0, body.length - 10));
}

export const LEVELS = ["기초", "중급", "심화"] as const;
export type Level = (typeof LEVELS)[number];
