import Link from "next/link";
import { notFound } from "next/navigation";
import { ExperimentRunner } from "@/components/ExperimentRunner";
import { LabHistory } from "@/components/LabHistory";
import { CodeBlock } from "@/components/CodeBlock";
import { Markdown } from "@/components/Markdown";
import { Badge, Card } from "@/components/ui";
import { experiments, getExperiment } from "@/experiments";
import { listNotes } from "@/lib/notes";
import { isReadOnly } from "@/lib/read-only";
import { LocalRunGuide } from "@/components/ReadOnlyNotice";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  return { title: getExperiment(id)?.title ?? "실험" };
}

export default async function ExperimentPage({ params }: Props) {
  const { id } = await params;
  const exp = getExperiment(id);
  if (!exp) notFound();
  const notes = await listNotes("redis");
  const related = exp.notes.map((s) => notes.find((n) => n.slug === s)).filter((n) => n !== undefined);
  const idx = experiments.findIndex((e) => e.id === id);
  const prev = experiments[idx - 1];
  const next = experiments[idx + 1];

  return (
    <div className="lab-page mx-auto max-w-5xl">
      <div className="mb-3 flex items-center gap-2 pt-8 text-xs text-muted md:pt-0">
        <Link href="/redis/lab" className="hover:text-foreground">
          실험실
        </Link>
        <span>/</span>
        <Badge>{exp.category}</Badge>
      </div>
      <h1 className="text-2xl font-bold tracking-tight">{exp.title}</h1>
      <p className="mt-1 text-muted">{exp.summary}</p>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="min-w-0 p-6">
          <h2 className="mb-1 text-sm font-semibold">무엇을 배우나</h2>
          <Markdown content={exp.description.trim()} small />
          {related.length > 0 && (
            <div className="mt-3 border-t border-border pt-3 text-sm">
              <span className="text-muted">관련 노트: </span>
              {related.map((n, i) => (
                <span key={n.slug}>
                  {i > 0 && ", "}
                  <Link href={`/redis/notes/${n.slug}`} className="text-info hover:underline">
                    {n.title}
                  </Link>
                </span>
              ))}
            </div>
          )}
        </Card>
        <Card className="min-w-0 p-6">
          <h2 className="mb-2 text-sm font-semibold">redis-cli 로 보면</h2>
          <CodeBlock><code>{exp.code}</code></CodeBlock>
        </Card>
      </div>

      <section className="mt-6 rounded-xl border border-border bg-surface p-6">
        <h2 className="mb-3 text-lg font-semibold">실행 결과</h2>
        {isReadOnly() ? <LocalRunGuide kind="redis" subject="redis" id={exp.id} /> : <ExperimentRunner id={exp.id} />}
      </section>

      <section className="mt-6 rounded-xl border border-border bg-surface p-6">
        <h2 className="mb-3 text-lg font-semibold">실행 이력</h2>
        {isReadOnly() ? <p className="text-[13px] text-muted">공개판에는 실행 이력이 없습니다. 로컬에서 실행하면 결과가 Redis Stream 에 쌓여 추이로 보입니다.</p> : <LabHistory subject="redis" id={exp.id} />}
      </section>

      <nav className="mt-10 flex justify-between border-t border-border pt-4 text-sm">
        {prev ? (
          <Link href={`/redis/lab/${prev.id}`} className="text-info hover:underline">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/redis/lab/${next.id}`} className="text-right text-info hover:underline">
            {next.title} →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
}
