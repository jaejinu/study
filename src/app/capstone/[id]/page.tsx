import Link from "next/link";
import { notFound } from "next/navigation";
import { findExperiment } from "@/lab/registry";
import { getCapstone, getCapstoneState } from "@/lib/drills/capstone";
import { CapstoneSteps, type StepView } from "@/components/drills/CapstoneSteps";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  return { title: getCapstone(id)?.title.split(":")[0] ?? "종합 과제" };
}

export default async function CapstoneProjectPage({ params }: Props) {
  const { id } = await params;
  const p = getCapstone(id);
  if (!p) notFound();
  const s = await getCapstoneState(id);
  const steps: StepView[] = p.steps.map((st) => ({
    id: st.id,
    title: st.title,
    goal: st.goal,
    actions: st.actions,
    notes: st.notes,
    input: st.input,
    experiments: st.experiments.map((e) => findExperiment(e)).filter((e): e is NonNullable<typeof e> => !!e).map((e) => ({ href: e.href, title: e.title })),
    last: s.steps[st.id] ?? null,
  }));
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 text-xs text-muted">
        <Link href="/capstone" className="hover:text-foreground">
          종합 과제
        </Link>{" "}
        / {p.id}
      </div>
      <h1 className="text-2xl font-bold tracking-tight">{p.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">{p.summary}</p>
      <div className="mt-3 rounded-lg border border-border bg-surface px-4 py-3 text-[13px]">
        <div className="font-medium">필요한 환경</div>
        <ul className="mt-1 list-disc pl-5 text-muted">
          {p.requires.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
      <CapstoneSteps projectId={p.id} steps={steps} startedAt={s.startedAt} baseline={s.baseline} postmortem={s.postmortem} />
    </div>
  );
}
