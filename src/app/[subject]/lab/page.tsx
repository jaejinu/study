import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, PageHeader } from "@/components/ui";
import { hasLab, labCategories, listLab } from "@/lab/registry";
import { getSubject } from "@/lib/subjects";
import { getProgress } from "@/lib/progress";
import { ProgressBar } from "@/components/ProgressBar";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ subject: string }> };

export async function generateMetadata({ params }: Props) {
  const { subject } = await params;
  return { title: `${getSubject(subject)?.name ?? ""} 실험실` };
}

export default async function ShellLabPage({ params }: Props) {
  const { subject: id } = await params;
  const subject = getSubject(id);
  if (!subject || !hasLab(id)) notFound();
  const list = listLab(id);
  const progress = await getProgress(id);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`${subject.name} 실험실`}
        subtitle="각 실험은 서버에서 실제 명령이나 클라이언트 라이브러리를 실행하고 단계별 결과·소요 시간을 그대로 보여줍니다. 기대값 검증(✓/✗)도 함께 실행됩니다."
      />
      <div className="mb-6">
        <ProgressBar done={list.filter((e) => progress.labDone.includes(e.id)).length} total={list.length} label="성공한 실험" />
      </div>
      {labCategories(id).map((c) => (
        <section key={c} className="mb-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{c}</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {list
              .filter((e) => e.category === c)
              .map((e) => (
                <li key={e.id}>
                  <Link href={`/${id}/lab/${e.id}`} className="block h-full rounded-lg border border-border bg-surface p-3 transition-colors hover:border-muted">
                    <div className="text-sm font-medium">
                      {progress.labDone.includes(e.id) && <span className="mr-1 text-ok">✓</span>}
                      {e.title}
                    </div>
                    <div className="mt-1 text-xs text-muted">{e.summary}</div>
                    <div className="mt-2">
                      <Badge>{e.id}</Badge>
                    </div>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
