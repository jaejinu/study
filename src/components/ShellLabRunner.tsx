"use client";

import { useState, useTransition } from "react";
import { runShellExperimentAction } from "@/actions/shell-lab";
import type { ShellResult, ShellStep } from "@/shell-lab/types";
import { Badge, Button } from "./ui";

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function Layers({ rows }: { rows: { size: number; createdBy: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.size));
  return (
    <div className="space-y-1">
      {[...rows].reverse().map((r, i) => (
        <div key={i} className="grid grid-cols-[90px_1fr] items-center gap-2 text-xs">
          <span className="text-right font-mono text-muted">{human(r.size)}</span>
          <div className="relative h-5 overflow-hidden rounded bg-surface-2">
            <div className="absolute inset-y-0 left-0 bg-info/40" style={{ width: `${Math.max(1, (r.size / max) * 100)}%` }} />
            <span className="absolute inset-y-0 left-2 flex items-center truncate font-mono text-[11px]">{r.createdBy || "(base)"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function StepRow({ s, i }: { s: ShellStep; i: number }) {
  const [open, setOpen] = useState(false);
  const long = s.output.split("\n").length > 12 || s.output.length > 800;
  const isCheck = s.cmd.startsWith("✓") || s.cmd.startsWith("✗");
  return (
    <div className={`border-t border-border ${!s.ok ? "bg-accent-soft" : isCheck ? "bg-ok/5" : s.note ? "bg-surface-2/60" : ""}`}>
      <div className="flex items-start gap-3 px-3 py-1.5">
        <span className="w-6 shrink-0 text-right text-xs text-muted">{i + 1}</span>
        <div className="min-w-0 flex-1">
          <div className={`font-mono text-xs ${isCheck ? (s.ok ? "text-ok" : "text-accent") : s.note ? "italic text-muted" : "text-info"}`}>
            {!s.note && <span className="text-muted">$ </span>}
            {s.cmd}
          </div>
          {s.data?.type === "layers" && (
            <div className="mt-2">
              <Layers rows={s.data.rows} />
            </div>
          )}
          {s.data?.type === "table" && (
            <table className="mt-2 text-xs">
              <thead>
                <tr>
                  {s.data.columns.map((c) => (
                    <th key={c} className="pr-4 text-left text-muted">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.data.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, ci) => (
                      <td key={ci} className="pr-4 font-mono">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {s.output && (
            <pre className={`mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed ${s.ok ? "text-foreground/80" : "text-accent"} ${long && !open ? "max-h-40 overflow-hidden" : ""}`}>
              {s.output}
            </pre>
          )}
          {long && (
            <button className="mt-1 text-[11px] text-muted hover:text-foreground" onClick={() => setOpen((v) => !v)}>
              {open ? "접기 ▲" : "전체 보기 ▼"}
            </button>
          )}
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted">{s.ms ? `${s.ms}ms` : ""}</span>
      </div>
    </div>
  );
}

export function ShellLabRunner({ subject, id }: { subject: string; id: string }) {
  const [result, setResult] = useState<ShellResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => start(async () => setResult(await runShellExperimentAction(subject, id)))} disabled={pending}>
          {pending ? "실행 중… (수십 초 걸릴 수 있음)" : result ? "다시 실행 ▶" : "실험 실행 ▶"}
        </Button>
        {result && (
          <>
            <Badge tone={result.ok ? "ok" : "danger"}>{result.ok ? "성공" : "실패"}</Badge>
            <span className="text-xs text-muted">
              {result.steps.length}단계 · {(result.durationMs / 1000).toFixed(1)}s · {new Date(result.ranAt).toLocaleTimeString("ko-KR")}
            </span>
          </>
        )}
      </div>
      {result?.error && <pre className="whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{result.error}</pre>}
      {result && result.steps.length > 0 && (
        <div className="rounded-lg border border-border">
          {result.steps.map((s, i) => (
            <StepRow key={i} s={s} i={i} />
          ))}
        </div>
      )}
      {!result && <p className="text-sm text-muted">버튼을 누르면 서버가 실제 명령을 실행하고 명령·출력·소요 시간을 순서대로 보여줍니다. 실험이 만든 리소스(lab-*)는 끝나면 정리됩니다.</p>}
    </div>
  );
}
