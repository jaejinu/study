import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DockerStatusCard } from "@/components/DockerStatusCard";
import { RedisStatusCard } from "@/components/RedisStatusCard";
import { Badge, Card, LevelBadge, PageHeader } from "@/components/ui";
import { categories, experiments } from "@/experiments";
import { listNotes } from "@/lib/notes";
import { readLastReport } from "@/lib/report";
import { getSubject } from "@/lib/subjects";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ subject: string }> };

export async function generateMetadata({ params }: Props) {
  const { subject } = await params;
  return { title: getSubject(subject)?.name ?? "Study" };
}

export default async function SubjectHome({ params }: Props) {
  const { subject: id } = await params;
  const subject = getSubject(id);
  if (!subject) notFound();
  const [notes, report] = await Promise.all([listNotes(subject.id), subject.id === "redis" ? readLastReport() : null]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`${subject.name} Study`}
        subtitle={subject.id === "redis" ? "노트로 개념을 익히고 → 실험실에서 실제 동작을 확인하고 → 콘솔로 직접 만져 본다." : "노트로 개념을 익히고 → 터미널에서 직접 실습한다. 각 노트 끝의 실습 블록을 따라 해 보자."}
      />

      <Suspense fallback={<Card className="p-4 text-sm text-muted">환경 확인 중…</Card>}>
        {subject.id === "redis" ? <RedisStatusCard /> : <DockerStatusCard />}
      </Suspense>

      <section className="mt-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">학습 로드맵</h2>
          <Link href={`/${subject.id}/notes`} className="text-sm text-info hover:underline">
            전체 목차 →
          </Link>
        </div>
        <ol className="grid gap-2 sm:grid-cols-2">
          {notes.map((n, idx) => (
            <li key={n.slug}>
              <Link href={`/${subject.id}/notes/${n.slug}`} className="flex h-full gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-muted">
                <span className="w-6 shrink-0 font-mono text-sm text-muted">{String(idx + 1).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{n.title}</span>
                    <LevelBadge level={n.level} />
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{n.summary}</span>
                  {n.experiments.length > 0 && <span className="mt-1 block text-[11px] text-muted">⚗ 실험 {n.experiments.length}개</span>}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {subject.id === "redis" && (
        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <Card className="p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-semibold">실험실</h2>
              <Link href="/redis/lab" className="text-sm text-info hover:underline">
                모두 보기 →
              </Link>
            </div>
            <ul className="space-y-1 text-sm">
              {categories.map((c) => (
                <li key={c} className="flex justify-between">
                  <span className="text-muted">{c}</span>
                  <span className="font-mono">{experiments.filter((e) => e.category === c).length}개</span>
                </li>
              ))}
              <li className="flex justify-between border-t border-border pt-1 font-medium">
                <span>합계</span>
                <span className="font-mono">{experiments.length}개</span>
              </li>
            </ul>
          </Card>
          <Card className="p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-semibold">최근 테스트</h2>
              <Link href="/redis/tests" className="text-sm text-info hover:underline">
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
      )}

      {subject.id === "docker" && (
        <section className="mt-8">
          <Card className="p-4">
            <h2 className="mb-2 font-semibold">이 프로젝트의 Redis 를 Docker 로 띄우기</h2>
            <p className="text-sm text-muted">
              루트의 <code>docker-compose.yml</code> 은 <code>redis/redis.conf</code> 를 그대로 마운트합니다. Redis 노트의 실험도 그대로 동작합니다.
            </p>
            <pre className="mt-2 rounded bg-[#0d1117] p-3 text-xs leading-relaxed">{`pnpm redis:docker          # docker compose up -d redis
docker compose logs -f redis
docker compose exec redis redis-cli ping
pnpm redis:docker:down     # 정지 (데이터는 볼륨에 보존)`}</pre>
          </Card>
        </section>
      )}
    </div>
  );
}
