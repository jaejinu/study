import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/CodeBlock";
import { Markdown } from "@/components/Markdown";
import { ShellLabRunner } from "@/components/ShellLabRunner";
import { CodeLabRunner } from "@/components/CodeLabRunner";
import { Badge, Card } from "@/components/ui";
import { getLab, listLab } from "@/lab/registry";
import { listNotes } from "@/lib/notes";
import { getSubject } from "@/lib/subjects";
import { RecentTracker } from "@/components/shell/recent";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ subject: string; id: string }> };

export async function generateMetadata({ params }: Props) {
  const { subject, id } = await params;
  return { title: getLab(subject, id)?.title ?? "실험" };
}

export default async function ShellExperimentPage({ params }: Props) {
  const { subject: sid, id } = await params;
  const subject = getSubject(sid);
  const exp = getLab(sid, id);
  if (!subject || !exp) notFound();
  const notes = await listNotes(sid);
  const related = exp.notes.map((s) => notes.find((n) => n.slug === s)).filter((n) => n !== undefined);
  const all = listLab(sid);
  const idx = all.findIndex((e) => e.id === id);
  const prev = all[idx - 1];
  const next = all[idx + 1];

  return (
    <div className="lab-page mx-auto max-w-5xl">
      <RecentTracker kind="lab" subject={sid} href={`/${sid}/lab/${exp.id}`} title={exp.title} />
      <div className="mb-3 flex items-center gap-2 pt-8 text-xs text-muted md:pt-0">
        <Link href={`/${sid}/lab`} className="hover:text-foreground">
          {subject.name} 실험실
        </Link>
        <span>/</span>
        <Badge>{exp.category}</Badge>
      </div>
      <h1 className="text-2xl font-bold tracking-tight">{exp.title}</h1>
      <p className="mt-1 text-muted">{exp.summary}</p>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="min-w-0 p-6">
          <h2 className="mb-1 text-sm font-semibold">무엇을 배우나</h2>
          <Markdown content={exp.description.trim()} small />
          {related.length > 0 && (
            <div className="mt-3 border-t border-border pt-3 text-sm">
              <span className="text-muted">관련 노트: </span>
              {related.map((n, i) => (
                <span key={n.slug}>
                  {i > 0 && ", "}
                  <Link href={`/${sid}/notes/${n.slug}`} className="text-info hover:underline">
                    {n.title}
                  </Link>
                </span>
              ))}
            </div>
          )}
        </Card>
        <Card className="min-w-0 p-6">
          <h2 className="mb-2 text-sm font-semibold">{exp.kind === "shell" ? "터미널에서 하면" : "CLI / SQL 로 보면"}</h2>
          <CodeBlock><code>{exp.code}</code></CodeBlock>
        </Card>
      </div>

      <section className="mt-6 rounded-xl border border-border bg-surface p-6">
        <h2 className="mb-3 text-lg font-semibold">실행 결과</h2>
        {exp.kind === "shell" ? <ShellLabRunner subject={sid} id={exp.id} /> : <CodeLabRunner subject={sid} id={exp.id} />}
      </section>

      <nav className="mt-10 flex justify-between border-t border-border pt-4 text-sm">
        {prev ? (
          <Link href={`/${sid}/lab/${prev.id}`} className="text-info hover:underline">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/${sid}/lab/${next.id}`} className="text-right text-info hover:underline">
            {next.title} →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
}
