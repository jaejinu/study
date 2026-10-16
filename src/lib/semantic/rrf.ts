/**
 * Reciprocal Rank Fusion: 점수 척도가 다른 순위 목록(BM25 점수 vs 코사인 유사도)을 "순위" 만으로 합친다.
 *   score(d) = Σ_i  w_i / (k + rank_i(d))      (rank 는 1부터)
 * k=60 은 원 논문(Cormack et al. 2009)의 기본값 — 상위 몇 위의 차이를 완만하게 만들어 한쪽 목록의 1위가 독주하지 않게 한다.
 */
export interface Fused {
  id: string;
  score: number;
  /** 목록별 순위 (없으면 null) */
  ranks: (number | null)[];
}

export function rrfFuse(lists: string[][], k = 60, weights?: number[]): Fused[] {
  const acc = new Map<string, Fused>();
  lists.forEach((list, li) => {
    const w = weights?.[li] ?? 1;
    list.forEach((id, i) => {
      const f = acc.get(id) ?? { id, score: 0, ranks: lists.map(() => null) };
      if (f.ranks[li] !== null) return; // 같은 목록에 중복이 있으면 첫 순위만
      f.ranks[li] = i + 1;
      f.score += w / (k + i + 1);
      acc.set(id, f);
    });
  });
  return [...acc.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** "subject/slug#anchor~n" → "subject/slug" */
export function noteKeyOf(chunkId: string): string {
  const i = chunkId.indexOf("#");
  return i < 0 ? chunkId : chunkId.slice(0, i);
}

export interface NoteGroup<T> {
  noteKey: string;
  score: number;
  /** 가장 점수가 높은 섹션 */
  best: T;
  /** 이 노트에서 걸린 청크 수 */
  matched: number;
}

/**
 * 청크 순위를 노트 순위로 접는다: 노트 점수 = 가장 좋은 섹션 점수 (+ 두 번째 섹션의 bonus 배).
 * 같은 노트의 섹션이 결과를 도배하지 않게 하고, 링크는 가장 좋은 섹션 앵커로 건다.
 */
export function groupByNote<T extends { id: string; score: number }>(items: T[], limit: number, bonus = 0): NoteGroup<T>[] {
  const groups = new Map<string, { best: T; second: number; matched: number }>();
  for (const it of items) {
    const key = noteKeyOf(it.id);
    const g = groups.get(key);
    if (!g) groups.set(key, { best: it, second: 0, matched: 1 });
    else {
      g.matched++;
      if (it.score > g.best.score) {
        g.second = g.best.score;
        g.best = it;
      } else if (it.score > g.second) g.second = it.score;
    }
  }
  return [...groups.entries()]
    .map(([noteKey, g]) => ({ noteKey, score: g.best.score + bonus * g.second, best: g.best, matched: g.matched }))
    .sort((a, b) => b.score - a.score || a.noteKey.localeCompare(b.noteKey))
    .slice(0, limit);
}
