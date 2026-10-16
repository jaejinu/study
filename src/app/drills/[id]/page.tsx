import Link from "next/link";
import { notFound } from "next/navigation";
import { getDrill } from "@/lib/drills/catalog";
import { bestRun, getActive, getRuns } from "@/lib/drills/state";
import { toView } from "@/lib/drills/view";
import { DrillRunner } from "@/components/drills/DrillRunner";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  return { title: getDrill(id)?.title ?? "장애 훈련" };
}

export default async function DrillPage({ params }: Props) {
  const { id } = await params;
  const d = getDrill(id);
  if (!d) notFound();
  const [runs, active] = await Promise.all([getRuns(id), getActive(id)]);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 text-xs text-muted">
        <Link href="/drills" className="hover:text-foreground">
          장애 대응 훈련
        </Link>{" "}
        / {d.id}
      </div>
      <DrillRunner drill={toView(d)} initialActive={active} initialRuns={runs} best={bestRun(runs)?.ms ?? null} initialHints={active ? d.hints.slice(0, active.hints) : []} />
    </div>
  );
}
