import Link from "next/link";
import { LevelBadge, PageHeader } from "@/components/ui";
import { listNotes } from "@/lib/notes";
import { experiments } from "@/experiments";

export const dynamic = "force-dynamic";
export const metadata = { title: "학습 노트" };

export default async function NotesPage() {
  const notes = await listNotes();
  const groups = [
    { level: "기초", desc: "Redis 가 무엇이고 어떻게 데이터를 다루는지" },
    { level: "중급", desc: "원자성, 메시징, 캐싱 같은 실전 패턴" },
    { level: "심화", desc: "운영·고가용성·메모리 최적화" },
  ] as const;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="학습 노트 목차" subtitle="위에서 아래로 순서대로 읽도록 구성했습니다. 각 노트 끝에는 관련 실험이 연결되어 있습니다." />
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
                    <Link href={`/notes/${n.slug}`} className="flex gap-4 px-4 py-3 hover:bg-surface-2">
                      <span className="w-7 shrink-0 font-mono text-sm text-muted">{String(globalIdx).padStart(2, "0")}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{n.title}</span>
                        <span className="mt-0.5 block text-sm text-muted">{n.summary}</span>
                        <span className="mt-1.5 flex flex-wrap gap-1.5">
                          {n.tags.map((t) => (
                            <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                              #{t}
                            </span>
                          ))}
                          {n.experiments.map((id) => {
                            const e = experiments.find((x) => x.id === id);
                            return e ? (
                              <span key={id} className="rounded border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
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
