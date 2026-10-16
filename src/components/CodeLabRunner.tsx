"use client";

import { runCodeExperimentAction } from "@/actions/code-lab";
import { RunningIndicator, RunSummary, useLabRun } from "./lab/RunStatus";
import { StepsTable } from "./StepsTable";
import { Button } from "./ui";

export function CodeLabRunner({ subject, id }: { subject: string; id: string }) {
  const { result, previous, pending, run } = useLabRun(`${subject}/${id}`, () => runCodeExperimentAction(subject, id));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={pending}>
          {pending ? "실행 중…" : result ? "다시 실행 ▶" : "실험 실행 ▶"}
        </Button>
        {!result && !pending && <span className="text-sm text-muted">서버가 클라이언트 라이브러리로 실제 서비스에 접속해 단계별 결과를 보여 줍니다. 만든 토픽·테이블(lab_*)은 끝나면 정리됩니다.</span>}
      </div>
      {pending && <RunningIndicator previousMs={previous?.durationMs} />}
      {result && !pending && <RunSummary result={result} previous={previous} />}
      {result?.error && <pre className="whitespace-pre-wrap rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-xs text-accent">{result.error}</pre>}
      {result && result.steps.length > 0 && <StepsTable steps={result.steps} />}
    </div>
  );
}
