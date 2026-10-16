"use client";

import { useState, useTransition } from "react";
import { runTestsAction, type RunTestsResult } from "@/actions/tests";
import { Button } from "./ui";

export function TestRunner() {
  const [last, setLast] = useState<RunTestsResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button onClick={() => start(async () => setLast(await runTestsAction()))} disabled={pending}>
          {pending ? "vitest 실행 중… (수 초 소요)" : "지금 테스트 실행 ▶"}
        </Button>
        <span className="text-xs text-muted">
          터미널에서 <code>pnpm test:report</code> 를 실행해도 같은 리포트가 갱신됩니다.
        </span>
      </div>
      {last && (
        <details className="rounded-lg border border-border bg-surface" open={!last.ok}>
          <summary className="cursor-pointer px-4 py-2 text-sm">
            실행 출력 보기 {last.ok ? "(성공)" : "(실패 또는 오류)"}
          </summary>
          <pre className="max-h-[400px] overflow-auto border-t border-border p-4 text-xs leading-relaxed text-muted">{last.output || last.error}</pre>
        </details>
      )}
    </div>
  );
}
