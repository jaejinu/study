import { createHash } from "node:crypto";

/**
 * 노트를 "## 섹션" 단위 청크로 자른다 (의미 검색의 색인 단위).
 *
 * 왜 섹션인가: 노트 한 편(수천 자)을 벡터 하나로 만들면 여러 주제가 평균돼 흐려지고,
 * 문단 단위는 너무 잘게 쪼개 맥락("무엇에 대한 문단인지")을 잃는다. 노트 작성 규칙상 ## 하나가
 * 한 개념이므로 그대로 청크 경계로 쓰고, 검색 결과는 그 섹션 앵커(#id)로 바로 데려간다.
 *
 * 앵커는 getNote().headings(= rehype-slug 와 같은 규칙)를 문서 순서대로 짝지어 쓴다 — 직접 slug 를 다시
 * 계산하지 않으므로 화면의 목차 링크와 어긋나지 않는다.
 */

export interface NoteInput {
  subject: string;
  slug: string;
  title: string;
  summary: string;
  level: string;
  tags: string[];
  content: string;
  /** getNote().headings — depth 2·3 만, 문서 순서 */
  headings: { depth: number; text: string; id: string }[];
}

export interface Chunk {
  /** "subject/slug#anchor" (+ "~n" : 긴 섹션을 나눈 조각) */
  id: string;
  subject: string;
  slug: string;
  title: string;
  level: string;
  /** "섹션 > 하위 섹션" (도입부는 "개요") */
  heading: string;
  /** 섹션 앵커. 도입부는 "" */
  anchor: string;
  /** /subject/notes/slug#anchor */
  href: string;
  /** 정리된 본문 (코드 블록은 앞부분만) */
  body: string;
  /** 임베딩에 넣는 텍스트: 노트 제목·섹션 경로·본문 */
  text: string;
  /** text 의 sha1 — 바뀐 청크만 다시 임베딩한다 */
  hash: string;
}

export interface ChunkOptions {
  /** 이보다 긴 섹션은 ### 경계(없으면 문단)로 나눈다 */
  maxChars?: number;
  /** 코드 블록에서 남길 줄 수 */
  codeLines?: number;
}

const FENCE = /^\s*```/;

/** 코드 블록은 앞 몇 줄만, mermaid 는 통째로 버리고, 링크·HTML·강조 표시를 걷어낸다 */
export function cleanMarkdown(md: string, codeLines = 6): string {
  const out: string[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim().toLowerCase();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      if (lang === "mermaid") continue;
      const kept = code.filter((l) => l.trim()).slice(0, codeLines);
      out.push(kept.join("\n") + (code.filter((l) => l.trim()).length > codeLines ? "\n…" : ""));
      continue;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "") // 표 구분선
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sha1(s: string) {
  return createHash("sha1").update(s).digest("hex");
}

type Part = { h3: { text: string; id: string } | null; lines: string[] };
type Section = { h2: { text: string; id: string } | null; parts: Part[] };

/** 문단(빈 줄) 경계로 maxChars 이하 덩어리로 묶는다. 한 문단이 maxChars 보다 길면 그대로 자른다 */
function splitParagraphs(text: string, maxChars: number): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) {
      out.push(cur);
      cur = "";
    }
    if (p.length > maxChars) {
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
      continue;
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkNote(note: NoteInput, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 1800;
  const codeLines = opts.codeLines ?? 6;
  const queue = note.headings.filter((h) => h.depth === 2 || h.depth === 3);
  let qi = 0;

  // 1) 줄을 훑어 ## / ### 로 섹션·파트를 나눈다 (코드 블록 안의 # 는 제목이 아님 — notes.ts 와 같은 판정)
  const sections: Section[] = [{ h2: null, parts: [{ h3: null, lines: [] }] }];
  let inFence = false;
  for (const line of note.content.split("\n")) {
    if (line.trim().startsWith("```")) inFence = !inFence;
    const m = !inFence ? /^(#{2,3})\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (m) {
      const h = queue[qi];
      const depth = m[1].length;
      if (h && h.depth === depth) {
        qi++;
        if (depth === 2) sections.push({ h2: { text: h.text, id: h.id }, parts: [{ h3: null, lines: [] }] });
        else sections[sections.length - 1].parts.push({ h3: { text: h.text, id: h.id }, lines: [] });
        continue;
      }
    }
    const sec = sections[sections.length - 1];
    sec.parts[sec.parts.length - 1].lines.push(line);
  }

  const base = `/${note.subject}/notes/${note.slug}`;
  const chunks: Chunk[] = [];
  const push = (anchor: string, heading: string, body: string, n?: number) => {
    const text = `${note.title} — ${heading}\n${body}`;
    chunks.push({
      id: `${note.subject}/${note.slug}#${anchor || "_intro"}${n ? `~${n}` : ""}`,
      subject: note.subject,
      slug: note.slug,
      title: note.title,
      level: note.level,
      heading,
      anchor,
      href: anchor ? `${base}#${anchor}` : base,
      body,
      text,
      hash: sha1(text),
    });
  };

  for (const sec of sections) {
    const h2Text = sec.h2?.text ?? "개요";
    const h2Id = sec.h2?.id ?? "";
    const partTexts = sec.parts.map((p) => ({ p, body: cleanMarkdown(p.lines.join("\n"), codeLines) }));
    // 도입부: 요약·태그를 앞에 붙여 "이 노트가 무엇에 대한 것인지" 를 담는다
    if (!sec.h2) {
      const intro = [note.summary, note.tags.length ? `태그: ${note.tags.join(", ")}` : "", partTexts[0].body].filter(Boolean).join("\n\n");
      if (intro.trim()) splitParagraphs(intro, maxChars).forEach((b, i) => push("", h2Text, b, i || undefined));
      continue;
    }
    const whole = partTexts
      .map(({ p, body }) => (p.h3 ? `${p.h3.text}\n${body}` : body))
      .filter((s) => s.trim())
      .join("\n\n");
    if (whole.length <= maxChars) {
      push(h2Id, h2Text, whole || h2Text);
      continue;
    }
    // 2) 긴 섹션: ### 파트를 maxChars 까지 묶고, 묶음의 첫 ### 앵커로 데려간다
    let groupAnchor = h2Id;
    let groupHeading = h2Text;
    let buf = "";
    let n = 0;
    const flush = () => {
      if (!buf.trim()) return;
      const pieces = splitParagraphs(buf, maxChars);
      pieces.forEach((b) => push(groupAnchor, groupHeading, b, n++ || undefined));
      buf = "";
    };
    for (const { p, body } of partTexts) {
      const t = p.h3 ? `${p.h3.text}\n${body}` : body;
      if (!t.trim()) continue;
      if (buf && buf.length + t.length + 2 > maxChars) {
        flush();
        if (p.h3) {
          groupAnchor = p.h3.id;
          groupHeading = `${h2Text} > ${p.h3.text}`;
          n = 0;
        }
      } else if (!buf && p.h3) {
        groupAnchor = p.h3.id;
        groupHeading = `${h2Text} > ${p.h3.text}`;
        n = 0;
      }
      buf = buf ? `${buf}\n\n${t}` : t;
    }
    flush();
  }
  // 같은 id 가 생기지 않도록 (같은 앵커로 여러 묶음이 이어진 경우) 뒤에 번호를 더 붙인다
  const seen = new Map<string, number>();
  for (const c of chunks) {
    const k = seen.get(c.id) ?? 0;
    seen.set(c.id, k + 1);
    if (k) c.id = `${c.id}~${k}`;
  }
  return chunks;
}
