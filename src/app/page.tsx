import Link from "next/link";
import { Suspense } from "react";
import { RedisStatusCard } from "@/components/RedisStatusCard";
import { Badge, Card, LevelBadge, PageHeader } from "@/components/ui";
import { categories, experiments } from "@/experiments";
import { listNotes } from "@/lib/notes";
import { readLastReport } from "@/lib/report";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [notes, report] = await Promise.all([listNotes(), readLastReport()]);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Redis Study" subtitle="노트로 개념을 익히고 → 실험실에서 실제 동작을 확인하고 → 콘솔로 직접 만져 본다." />

      <Suspense fallback={<Card className="p-4 text-sm text-muted">Redis 상태 확인 중…</Card>}>
        <RedisStatusCard />
      </Suspense>

      <section className="mt-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">학습 로드맵</h2>
          <Link href="/notes" className="text-sm text-info hover:underline">
            전체 목차 →
          </Link>
        </div>
        <ol className="grid gap-2 sm:grid-cols-2">
          {notes.map((n, idx) => (
            <li key={n.slug}>
              <Link href={`/notes/${n.slug}`} className="flex h-full gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-muted">
                <span className="w-6 shrink-0 font-mono text-sm text-muted">{String(idx + 1).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{n.title}</span>
                    <LevelBadge level={n.level} />
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{n.summary}</span>
                  {n.experiments.length > 0 && (
                    <span className="mt-1 block text-[11px] text-muted">⚗ 실험 {n.experiments.length}개</span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-8 grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-semibold">실험실</h2>
            <Link href="/lab" className="text-sm text-info hover:underline">
              모두 보기 →
            </Link>
          </div>
          <ul className="space-y-1 text-sm">
            {categories.map((c) => {
              const n = experiments.filter((e) => e.category === c).length;
              return (
                <li key={c} className="flex justify-between">
                  <span className="text-muted">{c}</span>
                  <span className="font-mono">{n}개</span>
                </li>
              );
            })}
            <li className="flex justify-between border-t border-border pt-1 font-medium">
              <span>합계</span>
              <span className="font-mono">{experiments.length}개</span>
            </li>
          </ul>
        </Card>
        <Card className="p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-semibold">최근 테스트</h2>
            <Link href="/tests" className="text-sm text-info hover:underline">
              리포트 →
            </Link>
          </div>
          {report ? (
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={report.success ? "ok" : "accent"}>{report.success ? "모두 통과" : "실패 있음"}</Badge>
                <span className="text-xs text-muted">{new Date(report.startTime).toLocaleString("ko-KR")}</span>
              </div>
              <div className="font-mono text-xs text-muted">
                통과 {report.numPassedTests} / 실패 {report.numFailedTests} / 전체 {report.numTotalTests}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">
              아직 리포트가 없습니다. <code>pnpm test:report</code> 를 실행하거나 테스트 페이지에서 실행하세요.
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
