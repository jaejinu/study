import Link from "next/link";
import { computeMastery, LEVELS, recommend, type Cell } from "@/lib/mastery";
import { getSubject, learningPaths, tracks } from "@/lib/subjects";

export const dynamic = "force-dynamic";
export const metadata = { title: "약점 지도" };

function tone(score: number): string {
  if (score >= 80) return "bg-ok/60 text-foreground";
  if (score >= 60) return "bg-ok/40";
  if (score >= 40) return "bg-ok/25";
  if (score >= 20) return "bg-warn/25";
  if (score > 0) return "bg-warn/15";
  return "bg-surface-2 text-muted";
}

function CellView({ c }: { c?: Cell }) {
  if (!c) return <td className="px-1 py-1"><div className="h-9 rounded bg-background/40" /></td>;
  const href = c.nextNote ? `/${c.subject}/notes/${c.nextNote.slug}` : `/${c.subject}/quiz`;
  const title = `${c.level} · 점수 ${c.score}\n노트 ${c.read}/${c.notes} 읽음\n퀴즈 ${c.seen}/${c.cards} 봄${c.seen ? ` · 기억 확률 ${Math.round(c.retention * 100)}%` : ""}\n실험 ${c.labsDone}/${c.labs} 통과`;
  return (
    <td className="px-1 py-1">
      <Link href={href} title={title} className={`flex h-9 items-center justify-center rounded font-mono text-[12px] transition-opacity hover:opacity-80 ${tone(c.score)}`}>
        {c.score}
      </Link>
    </td>
  );
}

export default async function MasteryPage() {
  const cells = await computeMastery();
  const recs = recommend(cells);
  const get = (s: string, l: string) => cells.find((c) => c.subject === s && c.level === l);
  const total = cells.reduce((a, c) => a + c.notes, 0);
  const overall = total ? Math.round(cells.reduce((a, c) => a + c.score * c.notes, 0) / total) : 0;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold tracking-tight">약점 지도</h1>
      <p className="mt-1 text-sm text-muted">
        주제·레벨마다 <b className="text-foreground">읽은 노트</b>(40%), <b className="text-foreground">퀴즈 기억 확률</b>(FSRS, 40%), <b className="text-foreground">통과한 실험</b>(20%)을 합친 숙련도입니다. 칸을 누르면 다음에 읽을 노트로 갑니다. 전체 {overall}점.
      </p>

      <section className="mt-6 rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-3 font-semibold">다음에 공부할 것</h2>
        {recs.length === 0 ? (
          <p className="text-sm text-muted">아직 시작한 주제가 없습니다. <Link href="/path" className="text-info hover:underline">학습 경로</Link>에서 첫 노트를 골라 보세요.</p>
        ) : (
          <ol className="space-y-2">
            {recs.map(({ cell, reason }, i) => (
              <li key={cell.subject} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="font-mono text-muted">{i + 1}</span>
                <Link href={`/${cell.subject}`} className="font-medium hover:underline">
                  {getSubject(cell.subject)?.name} · {cell.level}
                </Link>
                <span className="text-muted">{reason}</span>
                {cell.nextNote && (
                  <Link href={`/${cell.subject}/notes/${cell.nextNote.slug}`} className="ml-auto text-info hover:underline">
                    {cell.nextNote.title.length > 30 ? `${cell.nextNote.title.slice(0, 30)}…` : cell.nextNote.title} →
                  </Link>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="mt-6 space-y-6">
        {learningPaths.map((p) => {
          const track = tracks.find((t) => t.id === p.track)!;
          return (
            <section key={p.track}>
              <h2 className="mb-2 text-base font-semibold">{track.name}</h2>
              <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                <table className="w-full min-w-[480px] text-sm">
                  <thead>
                    <tr className="text-[12px] text-muted">
                      <th className="px-3 py-2 text-left font-normal">주제</th>
                      {LEVELS.map((l) => (
                        <th key={l} className="w-24 px-1 py-2 font-normal">{l}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {p.steps.map((id) => (
                      <tr key={id} className="border-t border-border">
                        <td className="px-3 py-1">
                          <Link href={`/${id}`} className="hover:underline">{getSubject(id)?.name}</Link>
                        </td>
                        {LEVELS.map((l) => (
                          <CellView key={l} c={get(id, l)} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>
      <p className="mt-4 text-[12px] text-muted">빈 칸은 그 레벨의 노트가 없다는 뜻입니다. 퀴즈를 하나도 안 본 칸은 퀴즈 점수를 읽기 비율로 대신합니다.</p>
    </div>
  );
}
