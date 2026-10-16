import { TestRunner } from "@/components/TestRunner";
import { Badge, Card, PageHeader } from "@/components/ui";
import { readLastReport } from "@/lib/report";
import { isReadOnly } from "@/lib/read-only";

export const dynamic = "force-dynamic";
export const metadata = { title: "테스트" };

export default async function TestsPage() {
  const report = await readLastReport();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="테스트 리포트" subtitle="실험실의 모든 실험은 vitest 테스트이기도 합니다. 실험 안의 ✓ 검증이 하나라도 실패하면 테스트가 실패합니다." />
      {!isReadOnly() && <TestRunner />}
      <div className="mt-6">
        {!report ? (
          <Card className="p-4 text-sm text-muted">
            아직 리포트가 없습니다. 위 버튼을 누르거나 터미널에서 <code>pnpm test:report</code> 를 실행하세요.
          </Card>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
              <Badge tone={report.success ? "ok" : "accent"}>{report.success ? "모두 통과" : "실패 있음"}</Badge>
              <span className="font-mono text-xs text-muted">
                통과 {report.numPassedTests} · 실패 {report.numFailedTests} · 건너뜀 {report.numPendingTests} · 전체 {report.numTotalTests}
              </span>
              <span className="text-xs text-muted">{new Date(report.startTime).toLocaleString("ko-KR")}</span>
            </div>
            {report.files.map((f) => (
              <Card key={f.name} className="mb-4 overflow-hidden">
                <div className="flex items-center justify-between border-b border-border bg-surface-2 px-4 py-2 text-sm">
                  <code>{f.name}</code>
                  <Badge tone={f.status === "passed" ? "ok" : "accent"}>{f.status}</Badge>
                </div>
                <ul className="divide-y divide-border">
                  {f.tests.map((t) => (
                    <li key={t.fullName} className="px-4 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span className={t.status === "passed" ? "text-ok" : t.status === "failed" ? "text-accent" : "text-muted"}>
                          {t.status === "passed" ? "✓" : t.status === "failed" ? "✗" : "○"}
                        </span>
                        <span className="flex-1">{t.title}</span>
                        <span className="font-mono text-xs text-muted">{t.duration}ms</span>
                      </div>
                      {t.failureMessages.length > 0 && (
                        <pre className="mt-2 overflow-x-auto rounded bg-code p-3 text-xs text-accent">{t.failureMessages.join("\n")}</pre>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
