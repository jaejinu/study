import Link from "next/link";
import { notFound } from "next/navigation";
import { LevelBadge, PageHeader } from "@/components/ui";
import { findExperiment } from "@/lab/registry";
import { listNotes } from "@/lib/notes";
import { getSubject, subjects } from "@/lib/subjects";
import { getProgress } from "@/lib/progress";
import { ProgressBar } from "@/components/ProgressBar";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ subject: string }> };

export async function generateMetadata({ params }: Props) {
  const { subject } = await params;
  return { title: `${getSubject(subject)?.name ?? ""} 학습 노트` };
}

export default async function NotesPage({ params }: Props) {
  const { subject: id } = await params;
  const subject = getSubject(id);
  if (!subject) notFound();
  const [notes, progress] = await Promise.all([listNotes(subject.id), getProgress(subject.id)]);
  const groups = [
    { level: "기초", desc: "개념과 기본 사용법" },
    { level: "중급", desc: "실전에서 자주 쓰는 패턴" },
    { level: "심화", desc: "운영·최적화·내부 동작" },
  ] as const;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={`${subject.name} 학습 노트 목차`} subtitle="위에서 아래로 순서대로 읽도록 구성했습니다. 각 노트에는 목차와 실습·실험 링크가 있습니다." />
      <div className="mb-6">
        <ProgressBar done={notes.filter((n) => progress.read.includes(n.slug)).length} total={notes.length} />
      </div>
      {notes.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <div className="text-3xl" aria-hidden>
            ✎
          </div>
          <p className="mt-3 font-medium">{subject.name} 노트를 준비하고 있습니다</p>
          <p className="mt-1 text-sm text-muted">그동안 같은 트랙의 다른 주제를 읽거나, ⌘K 로 관련 내용을 찾아보세요.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2 text-sm">
            {subjects
              .filter((s) => s.track === subject.track && s.id !== subject.id)
              .slice(0, 4)
              .map((s) => (
                <Link key={s.id} href={`/${s.id}/notes`} className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 hover:border-muted">
                  <span className={`grid h-5 w-5 place-items-center rounded text-[9px] font-bold text-white ${s.color}`}>{s.mark}</span>
                  {s.name}
                </Link>
              ))}
          </div>
        </div>
      )}
      {groups.map((g) => {
        const list = notes.filter((n) => n.level === g.level);
        if (list.length === 0) return null;
        return (
          <section key={g.level} className="mb-8">
            <div className="mb-2 flex items-center gap-2">
              <LevelBadge level={g.level} />
              <span className="text-sm text-muted">{g.desc}</span>
            </div>
            <ol className="divide-y divide-border rounded-lg border border-border bg-surface">
              {list.map((n) => {
                const globalIdx = notes.findIndex((x) => x.slug === n.slug) + 1;
                return (
                  <li key={n.slug}>
                    <Link href={`/${subject.id}/notes/${n.slug}`} className="flex gap-4 px-4 py-3 hover:bg-surface-2">
                      <span className={`w-7 shrink-0 font-mono text-sm ${progress.read.includes(n.slug) ? "text-ok" : "text-muted"}`}>
                        {progress.read.includes(n.slug) ? "✓" : String(globalIdx).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{n.title}</span>
                        <span className="mt-0.5 block text-sm text-muted">{n.summary}</span>
                        <span className="mt-1.5 flex flex-wrap gap-1.5">
                          {n.tags.map((t) => (
                            <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                              #{t}
                            </span>
                          ))}
                          {n.experiments.map((eid) => {
                            const e = findExperiment(eid, subject.id);
                            return e ? (
                              <span key={eid} className="rounded border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
                                ⚗ {e.title.split(":")[0]}
                              </span>
                            ) : null;
                          })}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
