import Link from "next/link";
import { Badge, PageHeader } from "@/components/ui";
import { categories, experiments } from "@/experiments";

export const metadata = { title: "실험실" };

export default function LabPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="실험실" subtitle="각 실험은 실제 Redis 에 명령을 보내고, 실행된 명령·응답·소요 시간을 그대로 보여줍니다. 기대값 검증(✓/✗)도 함께 실행됩니다." />
      {categories.map((c) => {
        const list = experiments.filter((e) => e.category === c);
        if (!list.length) return null;
        return (
          <section key={c} className="mb-8">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{c}</h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {list.map((e) => (
                <li key={e.id}>
                  <Link href={`/redis/lab/${e.id}`} className="block h-full rounded-lg border border-border bg-surface p-3 transition-colors hover:border-muted">
                    <div className="text-sm font-medium">{e.title}</div>
                    <div className="mt-1 text-xs text-muted">{e.summary}</div>
                    <div className="mt-2">
                      <Badge>{e.id}</Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
