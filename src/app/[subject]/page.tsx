import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DockerStatusCard } from "@/components/DockerStatusCard";
import { KubeStatusCard } from "@/components/KubeStatusCard";
import { RedisStatusCard } from "@/components/RedisStatusCard";
import { Badge, Card, LevelBadge, PageHeader } from "@/components/ui";
import { categories, experiments } from "@/experiments";
import { listNotes } from "@/lib/notes";
import { readLastReport } from "@/lib/report";
import { getSubject } from "@/lib/subjects";
import { hasLab, listLab } from "@/lab/registry";
import { EnvStatusCard } from "@/components/EnvStatusCard";
import { getProgress, getReadKeys } from "@/lib/progress";
import { ProgressBar } from "@/components/ProgressBar";
import { loadQuiz } from "@/lib/quiz";
import { cardKey, fmtDuration, getQuizStats, getSubjectStudySeconds, summarizeReview } from "@/lib/study";

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
  const [notes, report, progress, quiz, stats, studySeconds] = await Promise.all([listNotes(subject.id), subject.id === "redis" ? readLastReport() : null, getProgress(subject.id), loadQuiz(subject.id), getQuizStats(subject.id), getSubjectStudySeconds(subject.id)]);
  const readCount = notes.filter((n) => progress.read.includes(n.slug)).length;
  const review = summarizeReview(quiz.map((c) => cardKey(c.note, c.q)), stats);
  const prereqIds = subject.prereq ?? [];
  const [readKeys, prereqNotes] = await Promise.all([prereqIds.length ? getReadKeys() : Promise.resolve(new Set<string>()), Promise.all(prereqIds.map((p) => listNotes(p)))]);
  const prereqs = prereqIds.map((p, i) => ({ id: p, name: getSubject(p)?.name ?? p, total: prereqNotes[i].length, done: prereqNotes[i].filter((n) => readKeys.has(`${p}/${n.slug}`)).length }));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`${subject.name} Study`}
        subtitle={
          subject.id === "redis"
            ? "노트로 개념을 익히고 → 실험실에서 실제 동작을 확인하고 → 콘솔로 직접 만져 본다."
            : subject.id === "docker"
              ? "노트로 개념을 익히고 → 터미널에서 직접 실습한다. 각 노트 끝의 실습 블록을 따라 해 보자."
              : subject.id === "kubernetes"
                ? "노트로 개념을 익히고 → 로컬 클러스터(kind)에 직접 배포해 본다. kubectl 로 오브젝트를 만지며 익히자."
                : "노트로 개념을 익히고 → 로컬 환경에서 직접 실습한다. 각 노트 끝의 체크리스트를 따라 해 보자."
        }
      />

      {prereqs.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-[13px]">
          <span className="text-muted">먼저 보면 좋은 주제</span>
          {prereqs.map((p) => (
            <Link key={p.id} href={`/${p.id}`} className={`rounded border px-2 py-0.5 ${p.total && p.done / p.total >= 0.5 ? "border-ok/40 text-ok" : "border-border hover:border-muted"}`}>
              {p.name} <span className="text-muted">{p.done}/{p.total}</span>
            </Link>
          ))}
          <Link href="/path" className="ml-auto text-info hover:underline">학습 경로 →</Link>
        </div>
      )}

      <Suspense fallback={<Card className="p-4 text-sm text-muted">환경 확인 중…</Card>}>
        {subject.id === "redis" ? <RedisStatusCard /> : subject.id === "docker" ? <DockerStatusCard /> : subject.id === "kubernetes" ? <KubeStatusCard /> : <EnvStatusCard subject={subject.id} />}
      </Suspense>

      <section className="mt-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">학습 로드맵</h2>
          <Link href={`/${subject.id}/notes`} className="text-sm text-info hover:underline">
            전체 목차 →
          </Link>
        </div>
        <div className="mb-3">
          <ProgressBar done={readCount} total={notes.length} />
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
            {studySeconds > 0 && <span>⏱ 학습 시간 {fmtDuration(studySeconds)}</span>}
            {review.total > 0 && (
              <Link href={`/${subject.id}/quiz`} className={review.due > 0 ? "text-warn hover:underline" : "hover:underline"}>
                ? 퀴즈 {review.total}장 · 복습 기한 지남 {review.due} · 안정 {review.stable}
              </Link>
            )}
          </div>
        </div>
        <ol className="grid gap-2 sm:grid-cols-2">
          {notes.map((n, idx) => (
            <li key={n.slug}>
              <Link href={`/${subject.id}/notes/${n.slug}`} className="flex h-full gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-muted">
                <span className={`w-6 shrink-0 font-mono text-sm ${progress.read.includes(n.slug) ? "text-ok" : "text-muted"}`}>
                  {progress.read.includes(n.slug) ? "✓" : String(idx + 1).padStart(2, "0")}
                </span>
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

      {hasLab(subject.id) && (
        <section className="mt-8">
          <Card className="p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-semibold">실험실</h2>
              <Link href={`/${subject.id}/lab`} className="text-sm text-info hover:underline">
                모두 보기 →
              </Link>
            </div>
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {listLab(subject.id).map((e) => (
                <li key={e.id}>
                  <Link href={`/${subject.id}/lab/${e.id}`} className="text-muted hover:text-foreground">
                    ⚗ {e.title}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {subject.id === "kubernetes" && (
        <section className="mt-8">
          <Card className="p-4">
            <h2 className="mb-2 font-semibold">이 프로젝트의 Redis 를 Kubernetes 에 배포하기</h2>
            <p className="text-sm text-muted">
              <code>k8s/</code> 의 매니페스트(Namespace, ConfigMap, StatefulSet, Service)를 kustomize 로 적용합니다. 포트 포워딩하면 Redis 대시보드와 실험이 그대로 붙습니다.
            </p>
            <pre className="mt-2 rounded bg-code p-3 text-xs leading-relaxed">{`pnpm k8s:cluster     # kind 로 로컬 클러스터 생성 (최초 1회)
pnpm k8s:up          # kustomize 빌드 → kubectl apply + 롤아웃 대기
kubectl -n study get all,pvc,cm
pnpm k8s:port        # svc/redis → localhost:6379 (다른 Redis 는 꺼 두기)
pnpm k8s:down        # 리소스 삭제
pnpm k8s:cluster:down`}</pre>
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
            <pre className="mt-2 rounded bg-code p-3 text-xs leading-relaxed">{`pnpm redis:docker          # docker compose up -d redis
docker compose logs -f redis
docker compose exec redis redis-cli ping
pnpm redis:docker:down     # 정지 (데이터는 볼륨에 보존)`}</pre>
          </Card>
        </section>
      )}
    </div>
  );
}
