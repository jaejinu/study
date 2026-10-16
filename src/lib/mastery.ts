import { findExperiment } from "@/lab/registry";
import { listNotes } from "./notes";
import { getLabDoneKeys, getReadKeys } from "./progress";
import { loadQuiz } from "./quiz";
import { cardKey, getQuizStatsMany } from "./study";
import { retrievability } from "./study-shared";
import { getSubject, subjects, type SubjectId } from "./subjects";

export const LEVELS = ["기초", "중급", "심화"] as const;
export type Level = (typeof LEVELS)[number];

export interface Cell {
  subject: SubjectId;
  level: Level;
  notes: number;
  read: number;
  cards: number;
  seen: number;
  /** 본 카드의 평균 회상 확률 (0~1) */
  retention: number;
  labs: number;
  labsDone: number;
  /** 0~100. 읽기 40% · 퀴즈 기억(본 비율 × 회상 확률) 40% · 실험 20% (실험이 없으면 읽기·퀴즈를 50:50) */
  score: number;
  nextNote?: { slug: string; title: string };
}

/**
 * 주제 × 레벨 숙련도. 읽었는지만으로는 '안다' 를 알 수 없어서 퀴즈 기억 확률(FSRS)과 실험 통과를 함께 본다.
 */
export async function computeMastery(now = Date.now()): Promise<Cell[]> {
  const [read, labDone, allStats] = await Promise.all([getReadKeys(), getLabDoneKeys(), getQuizStatsMany(subjects.map((s) => s.id))]);
  const cells: Cell[] = [];
  for (const s of subjects) {
    const [notes, quiz] = await Promise.all([listNotes(s.id), loadQuiz(s.id)]);
    for (const level of LEVELS) {
      const ns = notes.filter((n) => n.level === level);
      if (ns.length === 0) continue;
      const slugs = new Set(ns.map((n) => n.slug));
      const readN = ns.filter((n) => read.has(`${s.id}/${n.slug}`)).length;
      const cards = quiz.filter((c) => slugs.has(c.note));
      const seenStats = cards.map((c) => allStats[s.id]?.[cardKey(c.note, c.q)]).filter((x) => x && x.last);
      const retention = seenStats.length ? seenStats.reduce((a, st) => a + retrievability(st, now), 0) / seenStats.length : 0;
      const labIds = [...new Set(ns.flatMap((n) => n.experiments))].map((id) => findExperiment(id, s.id)).filter((e): e is NonNullable<typeof e> => !!e);
      const labsDoneN = labIds.filter((e) => labDone.has(`${e.subject}/${e.id}`)).length;
      const readR = readN / ns.length;
      const quizR = cards.length ? (seenStats.length / cards.length) * retention : readR;
      const labR = labIds.length ? labsDoneN / labIds.length : null;
      const score = Math.round(100 * (labR === null ? 0.5 * readR + 0.5 * quizR : 0.4 * readR + 0.4 * quizR + 0.2 * labR));
      const next = ns.find((n) => !read.has(`${s.id}/${n.slug}`));
      cells.push({ subject: s.id, level, notes: ns.length, read: readN, cards: cards.length, seen: seenStats.length, retention, labs: labIds.length, labsDone: labsDoneN, score, nextNote: next ? { slug: next.slug, title: next.title } : undefined });
    }
  }
  return cells;
}

/**
 * 다음에 공부할 것: 시작한 주제(읽은 노트나 본 카드가 있는)에서 가장 약한 칸,
 * 그다음 선수 주제를 절반 이상 끝낸 주제의 기초. 같은 주제는 한 번만.
 */
export function recommend(cells: Cell[], limit = 5): { cell: Cell; reason: string }[] {
  const bySubject = new Map<string, Cell[]>();
  for (const c of cells) bySubject.set(c.subject, [...(bySubject.get(c.subject) ?? []), c]);
  const subjectScore = (id: string) => {
    const cs = bySubject.get(id) ?? [];
    const n = cs.reduce((a, c) => a + c.notes, 0);
    return n ? cs.reduce((a, c) => a + c.score * c.notes, 0) / n : 0;
  };
  const started = (id: string) => (bySubject.get(id) ?? []).some((c) => c.read > 0 || c.seen > 0);
  const out: { cell: Cell; reason: string }[] = [];
  const used = new Set<string>();
  const inProgress = cells
    .filter((c) => started(c.subject) && c.score < 80)
    .sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.score - b.score);
  for (const c of inProgress) {
    if (used.has(c.subject)) continue;
    used.add(c.subject);
    const why = c.seen > 0 && c.retention < 0.8 ? `퀴즈 기억 확률 ${Math.round(c.retention * 100)}% — 복습이 필요합니다` : c.read < c.notes ? `${c.level} 노트 ${c.notes - c.read}편이 남았습니다` : c.labs > c.labsDone ? `연결된 실험 ${c.labs - c.labsDone}개를 아직 돌리지 않았습니다` : "퀴즈를 풀어 기억을 확인해 보세요";
    out.push({ cell: c, reason: why });
    if (out.length >= limit) return out;
  }
  const fresh = cells
    .filter((c) => c.level === "기초" && !started(c.subject) && (getSubject(c.subject)?.prereq ?? []).every((p) => subjectScore(p) >= 50))
    .sort((a, b) => (getSubject(a.subject)?.prereq?.length ?? 0) - (getSubject(b.subject)?.prereq?.length ?? 0));
  for (const c of fresh) {
    if (used.has(c.subject)) continue;
    used.add(c.subject);
    out.push({ cell: c, reason: (getSubject(c.subject)?.prereq ?? []).length ? "선수 주제를 충분히 익혔습니다 — 시작해 보세요" : "선수 지식 없이 시작할 수 있는 주제입니다" });
    if (out.length >= limit) break;
  }
  return out;
}
