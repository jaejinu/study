import Link from "next/link";
import { experiments } from "@/experiments";
import { listNotes } from "@/lib/notes";
import { shellExperiments } from "@/shell-lab";
import { subjects } from "@/lib/subjects";

export const dynamic = "force-dynamic";

export default async function Home() {
  const counts = await Promise.all(
    subjects.map(async (s) => ({
      id: s.id,
      notes: (await listNotes(s.id)).length,
      experiments: s.id === "redis" ? experiments.length : shellExperiments.filter((e) => e.subject === s.id).length,
    })),
  );
  return (
    <div className="mx-auto max-w-5xl pt-10 md:pt-16">
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">무엇을 공부할까요?</h1>
        <p className="mt-3 text-muted">주제를 고르면 목차 순서의 학습 노트와 실습 환경이 열립니다.</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {subjects.map((s) => {
          const c = counts.find((x) => x.id === s.id)!;
          return (
            <Link
              key={s.id}
              href={`/${s.id}`}
              className="group flex flex-col rounded-xl border border-border bg-surface p-6 transition-all hover:-translate-y-0.5 hover:border-muted hover:shadow-lg hover:shadow-black/30"
            >
              <div className="flex items-center gap-3">
                <span className={`grid h-12 w-12 place-items-center rounded-lg text-xl font-bold text-white ${s.color}`}>{s.mark}</span>
                <div>
                  <div className="text-xl font-semibold">{s.name}</div>
                  <div className="text-sm text-muted">{s.tagline}</div>
                </div>
              </div>
              <p className="mt-4 flex-1 text-sm leading-relaxed text-muted">{s.description}</p>
              <div className="mt-5 flex gap-4 border-t border-border pt-4 text-xs text-muted">
                <span>
                  노트 <span className="font-mono text-foreground">{c.notes}</span>편
                </span>
                {c.experiments > 0 && (
                  <span>
                    실험 <span className="font-mono text-foreground">{c.experiments}</span>개
                  </span>
                )}
                <span className="ml-auto text-info group-hover:underline">시작하기 →</span>
              </div>
            </Link>
          );
        })}
      </div>
      <p className="mt-10 text-center text-xs text-muted">
        주제를 추가하려면 <code>src/lib/subjects.ts</code> 에 항목을 넣고 <code>content/&lt;id&gt;/notes</code> 에 노트를 작성하세요.
      </p>
    </div>
  );
}
