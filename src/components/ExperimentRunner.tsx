"use client";

import { useState, useTransition } from "react";
import { runExperimentAction } from "@/actions/experiments";
import type { ExperimentResult } from "@/experiments/types";
import { StepsTable } from "./StepsTable";
import { Badge, Button } from "./ui";

export function ExperimentRunner({ id }: { id: string }) {
  const [result, setResult] = useState<ExperimentResult | null>(null);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      setResult(await runExperimentAction(id));
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={pending}>
          {pending ? "실행 중…" : result ? "다시 실행 ▶" : "실험 실행 ▶"}
        </Button>
        {result && (
          <>
            <Badge tone={result.ok ? "ok" : "accent"}>{result.ok ? "성공" : "실패"}</Badge>
            <span className="text-xs text-muted">
              {result.steps.length}단계 · {result.durationMs}ms · {new Date(result.ranAt).toLocaleTimeString("ko-KR")}
            </span>
          </>
        )}
      </div>
      {result?.error && (
        <div className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-accent">{result.error}</div>
      )}
      {result && <StepsTable steps={result.steps} />}
      {!result && (
        <p className="text-sm text-muted">
          버튼을 누르면 서버가 실제 Redis 에 명령을 보내고, 실행된 명령과 응답을 순서대로 보여줍니다. 실험용 키는 끝나면 자동 삭제됩니다.
        </p>
      )}
    </div>
  );
}
