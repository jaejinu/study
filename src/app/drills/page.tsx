import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { drills } from "@/lib/drills/catalog";
import { bestRun, getActive, getRuns } from "@/lib/drills/state";
import { fmtMs } from "@/lib/drills/view";
import { RunBars } from "@/components/drills/RunBars";

export const dynamic = "force-dynamic";
export const metadata = { title: "장애 대응 훈련" };

const tone = { 쉬움: "ok", 보통: "info", 어려움: "danger" } as const;

export default async function DrillsPage() {
  const rows = await Promise.all(drills.map(async (d) => ({ d, runs: await getRuns(d.id), active: await getActive(d.id) })));
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="장애 대응 훈련"
        subtitle="진짜 고장을 전용 컨테이너(lab-drill-*)에 만들고, 증상만 보고 내 터미널에서 고친다. 채점 버튼이 실제 상태를 확인하고 복구 시간(MTTR)을 기록한다."
      >
        <Link href="/capstone" className="text-sm text-info hover:underline">
          종합 과제(캡스톤) →
        </Link>
      </PageHeader>
      <Card className="mb-6 px-4 py-3 text-[13px] leading-relaxed text-muted">
        시작하는 순간 <b className="text-foreground">데드맨 스위치</b>가 장전된다. 제한 시간이 지나면 브라우저를 닫았어도 고장 난 컨테이너가 자동으로 지워진다.
        언제든 <b className="text-foreground">포기하고 원복</b>을 누르면 즉시 정리되고 해설이 열린다. 필요한 것: Docker Desktop (k8s 훈련은 kind-study 클러스터).
        가이드: <Link className="text-info hover:underline" href="/chaos/notes/05-incident-drills">장애 훈련 노트</Link>
      </Card>
      <ul className="space-y-3">
        {rows.map(({ d, runs, active }) => {
          const best = bestRun(runs);
          const passed = runs.filter((r) => r.ok).length;
          return (
            <li key={d.id}>
              <Link href={`/drills/${d.id}`} className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:border-muted">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={tone[d.level]}>{d.level}</Badge>
                  <h2 className="font-semibold">{d.title}</h2>
                  {active && <Badge tone="warn">진행 중</Badge>}
                  <span className="ml-auto text-xs text-muted">제한 {d.timeLimitMin}분</span>
                </div>
                <p className="mt-1.5 text-sm text-muted">{d.summary}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
                  <span>
                    최고 기록 <b className="text-foreground">{best ? fmtMs(best.ms) : "—"}</b>
                  </span>
                  <span>
                    통과 {passed} / 시도 {runs.length}
                  </span>
                  {runs.length > 0 && <RunBars runs={runs} limitMs={d.timeLimitMin * 60_000} compact />}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
