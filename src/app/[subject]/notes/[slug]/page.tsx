import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { LevelBadge } from "@/components/ui";
import { experiments } from "@/experiments";
import { getNote, listNotes } from "@/lib/notes";
import { getSubject } from "@/lib/subjects";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ subject: string; slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { subject, slug } = await params;
  const note = await getNote(subject, slug);
  return { title: note?.title ?? "노트" };
}

export default async function NotePage({ params }: Props) {
  const { subject: id, slug } = await params;
  const subject = getSubject(id);
  if (!subject) notFound();
  const [note, all] = await Promise.all([getNote(subject.id, slug), listNotes(subject.id)]);
  if (!note) notFound();
  const idx = all.findIndex((n) => n.slug === slug);
  const prev = all[idx - 1];
  const next = all[idx + 1];
  const related = subject.id === "redis" ? note.experiments.map((eid) => experiments.find((e) => e.id === eid)).filter((e) => e !== undefined) : [];
  const base = `/${subject.id}/notes`;

  return (
    <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[minmax(0,1fr)_220px]">
      <article>
        <div className="mb-4 flex items-center gap-2 pt-8 text-xs text-muted md:pt-0">
          <Link href={base} className="hover:text-foreground">
            {subject.name} 학습 노트
          </Link>
          <span>/</span>
          <span>{String(idx + 1).padStart(2, "0")}</span>
          <LevelBadge level={note.level} />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{note.title}</h1>
        <p className="mt-2 text-muted">{note.summary}</p>
        <div className="mt-6">
          <Markdown content={note.content} />
        </div>

        {related.length > 0 && (
          <section className="mt-10 rounded-lg border border-accent/30 bg-accent-soft/40 p-4">
            <h2 className="mb-2 text-sm font-semibold text-accent">⚗ 이 노트와 관련된 실험</h2>
            <ul className="space-y-1.5">
              {related.map((e) => (
                <li key={e.id}>
                  <Link href={`/redis/lab/${e.id}`} className="text-sm hover:underline">
                    {e.title}
                  </Link>
                  <span className="ml-2 text-xs text-muted">{e.summary}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <nav className="mt-10 flex justify-between border-t border-border pt-4 text-sm">
          {prev ? (
            <Link href={`${base}/${prev.slug}`} className="text-info hover:underline">
              ← {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`${base}/${next.slug}`} className="text-right text-info hover:underline">
              {next.title} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>

      <aside className="hidden lg:block">
        <div className="sticky top-8">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">이 노트의 목차</div>
          <ul className="space-y-1 border-l border-border text-[13px]">
            {note.headings.map((h) => (
              <li key={h.id} className={h.depth === 3 ? "pl-6" : "pl-3"}>
                <a href={`#${h.id}`} className="block py-0.5 text-muted hover:text-foreground">
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
          {note.tags.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-1.5">
              {note.tags.map((t) => (
                <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
