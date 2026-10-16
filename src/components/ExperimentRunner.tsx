"use client";

import { runExperimentAction } from "@/actions/experiments";
import { RunningIndicator, RunSummary, useLabRun } from "./lab/RunStatus";
import { StepsTable } from "./StepsTable";
import { Button } from "./ui";

export function ExperimentRunner({ id }: { id: string }) {
  const { result, previous, pending, run } = useLabRun(`redis/${id}`, () => runExperimentAction(id));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={pending}>
          {pending ? "실행 중…" : result ? "다시 실행 ▶" : "실험 실행 ▶"}
        </Button>
        {!result && !pending && <span className="text-sm text-muted">실제 Redis 에 명령을 보내고 명령·응답을 순서대로 보여 줍니다. 실험용 키는 끝나면 삭제됩니다.</span>}
      </div>
      {pending && <RunningIndicator previousMs={previous?.durationMs} />}
      {result && !pending && <RunSummary result={result} previous={previous} />}
      {result?.error && <div className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-accent">{result.error}</div>}
      {result && <StepsTable steps={result.steps} />}
    </div>
  );
}
