import { PageHeader } from "@/components/ui";
import { LabList } from "@/components/lab/LabList";
import { categories, experiments } from "@/experiments";
import { getProgress } from "@/lib/progress";
import { ProgressBar } from "@/components/ProgressBar";

export const metadata = { title: "실험실" };

export const dynamic = "force-dynamic";

export default async function LabPage() {
  const progress = await getProgress("redis");
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="실험실" subtitle="각 실험은 실제 Redis 에 명령을 보내고, 실행된 명령·응답·소요 시간을 그대로 보여줍니다. 기대값 검증(✓/✗)도 함께 실행됩니다." />
      <div className="mb-6">
        <ProgressBar done={experiments.filter((e) => progress.labDone.includes(e.id)).length} total={experiments.length} label="성공한 실험" />
      </div>
      <LabList
        categories={categories.filter((c) => experiments.some((e) => e.category === c))}
        items={experiments.map((e) => ({ id: e.id, title: e.title, summary: e.summary, category: e.category, href: `/redis/lab/${e.id}`, done: progress.labDone.includes(e.id) }))}
      />
    </div>
  );
}
