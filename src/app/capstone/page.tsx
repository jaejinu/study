import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { capstones, getCapstoneState } from "@/lib/drills/capstone";

export const dynamic = "force-dynamic";
export const metadata = { title: "종합 과제" };

export default async function CapstonePage() {
  const rows = await Promise.all(capstones.map(async (p) => ({ p, s: await getCapstoneState(p.id) })));
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="종합 과제 (캡스톤)" subtitle="여러 주제를 하나의 운영 시나리오로 엮는다. 각 단계는 실제 시스템 상태를 확인하는 자동 검증기가 있다.">
        <Link href="/drills" className="text-sm text-info hover:underline">
          ← 장애 대응 훈련
        </Link>
      </PageHeader>
      <ul className="space-y-4">
        {rows.map(({ p, s }) => {
          const done = p.steps.filter((st) => s.steps[st.id]?.ok).length;
          return (
            <li key={p.id}>
              <Link href={`/capstone/${p.id}`} className="block rounded-lg border border-border bg-surface p-5 transition-colors hover:border-muted">
                <h2 className="font-semibold">{p.title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{p.summary}</p>
                <div className="mt-3 flex items-center gap-3 text-xs text-muted">
                  <span className="flex gap-1" aria-label={`${done}/${p.steps.length} 단계 통과`}>
                    {p.steps.map((st) => (
                      <span key={st.id} className={`block h-2 w-6 rounded-sm ${s.steps[st.id]?.ok ? "bg-ok" : s.steps[st.id] ? "bg-danger/50" : "bg-surface-2"}`} title={st.title} />
                    ))}
                  </span>
                  <span>
                    {done} / {p.steps.length} 단계
                  </span>
                  {s.startedAt && <span>· 시작 {new Date(s.startedAt).toLocaleDateString("ko-KR")}</span>}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      <Card className="mt-6 px-4 py-3 text-[13px] leading-relaxed text-muted">
        진행 상태는 Redis Hash <code>capstone:&lt;id&gt;</code> 에 남는다. &quot;처음부터 다시&quot; 를 누르면 시작 시각과 기준 스냅샷을 새로 잡는다 — 알림·분석 실행은 시작 이후 것만 인정한다.
      </Card>
    </div>
  );
}
