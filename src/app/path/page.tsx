import Link from "next/link";
import { listNotes } from "@/lib/notes";
import { getReadKeys } from "@/lib/progress";
import { getSubject, learningPaths, tracks } from "@/lib/subjects";

export const dynamic = "force-dynamic";
export const metadata = { title: "학습 경로" };

/** 트랙별 추천 순서 — 각 주제의 진행률, 다음에 읽을 노트, 선수 주제 충족 여부 */
export default async function PathPage() {
  const read = await getReadKeys();
  const data = await Promise.all(
    learningPaths.map(async (p) => ({
      track: tracks.find((t) => t.id === p.track)!,
      steps: await Promise.all(
        p.steps.map(async (id) => {
          const s = getSubject(id)!;
          const notes = await listNotes(id);
          const done = notes.filter((n) => read.has(`${id}/${n.slug}`)).length;
          const next = notes.find((n) => !read.has(`${id}/${n.slug}`));
          return { s, notes: notes.length, done, next };
        }),
      ),
    })),
  );
  const pct = (d: number, n: number) => (n ? Math.round((d / n) * 100) : 0);
  const progressOf = new Map(data.flatMap((t) => t.steps.map((x) => [x.s.id, pct(x.done, x.notes)] as const)));
  const total = data.reduce((a, t) => a + t.steps.reduce((b, x) => b + x.notes, 0), 0);
  const doneAll = data.reduce((a, t) => a + t.steps.reduce((b, x) => b + x.done, 0), 0);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold tracking-tight">학습 경로</h1>
      <p className="mt-1 text-sm text-muted">
        트랙마다 위에서 아래로 진행하는 추천 순서입니다. 선수 주제를 절반 이상 읽었으면 초록으로 표시됩니다. 전체 진행 {doneAll}/{total}편 ({pct(doneAll, total)}%).
      </p>
      <div className="mt-6 space-y-8">
        {data.map(({ track, steps }) => (
          <section key={track.id}>
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-lg font-semibold">{track.name}</h2>
              <span className="text-sm text-muted">{track.desc}</span>
            </div>
            <ol className="space-y-2">
              {steps.map(({ s, notes, done, next }, i) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3">
                  <span className="w-6 font-mono text-sm text-muted">{String(i + 1).padStart(2, "0")}</span>
                  <Link href={`/${s.id}`} className="min-w-[10rem] flex-1 font-medium hover:underline">
                    {s.name}
                    <span className="ml-2 text-[12px] font-normal text-muted">{s.tagline}</span>
                  </Link>
                  {(s.prereq ?? []).length > 0 && (
                    <span className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
                      선수
                      {(s.prereq ?? []).map((p) => (
                        <Link key={p} href={`/${p}`} className={`rounded border px-1.5 py-0.5 ${(progressOf.get(p) ?? 0) >= 50 ? "border-ok/40 text-ok" : "border-border hover:text-foreground"}`}>
                          {getSubject(p)?.name}
                        </Link>
                      ))}
                    </span>
                  )}
                  <span className="flex w-40 items-center gap-2 text-[12px] text-muted">
                    <span className="h-1.5 flex-1 overflow-hidden rounded bg-surface-2">
                      <span className="block h-full rounded bg-ok" style={{ width: `${pct(done, notes)}%` }} />
                    </span>
                    {done}/{notes}
                  </span>
                  {next ? (
                    <Link href={`/${s.id}/notes/${next.slug}`} className="text-[12.5px] text-info hover:underline">
                      다음: {next.title.length > 28 ? `${next.title.slice(0, 28)}…` : next.title} →
                    </Link>
                  ) : notes > 0 ? (
                    <span className="text-[12.5px] text-ok">완료 ✓</span>
                  ) : (
                    <span className="text-[12.5px] text-muted">준비 중</span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
