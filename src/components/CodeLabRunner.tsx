"use client";

import { useState, useTransition } from "react";
import { runCodeExperimentAction } from "@/actions/code-lab";
import type { CodeResult } from "@/code-lab/types";
import { StepsTable } from "./StepsTable";
import { Badge, Button } from "./ui";

export function CodeLabRunner({ subject, id }: { subject: string; id: string }) {
  const [result, setResult] = useState<CodeResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => start(async () => setResult(await runCodeExperimentAction(subject, id)))} disabled={pending}>
          {pending ? "실행 중…" : result ? "다시 실행 ▶" : "실험 실행 ▶"}
        </Button>
        {result && (
          <>
            <Badge tone={result.ok ? "ok" : "accent"}>{result.ok ? "성공" : "실패"}</Badge>
            <span className="text-xs text-muted">
              {result.steps.length}단계 · {(result.durationMs / 1000).toFixed(1)}s · {new Date(result.ranAt).toLocaleTimeString("ko-KR")}
            </span>
          </>
        )}
      </div>
      {result?.error && <pre className="whitespace-pre-wrap rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-xs text-accent">{result.error}</pre>}
      {result && result.steps.length > 0 && <StepsTable steps={result.steps} />}
      {!result && <p className="text-sm text-muted">버튼을 누르면 서버가 클라이언트 라이브러리로 실제 서비스에 접속해 단계별 결과를 보여줍니다. 실험이 만든 토픽/테이블(lab_*)은 끝나면 정리됩니다.</p>}
    </div>
  );
}
