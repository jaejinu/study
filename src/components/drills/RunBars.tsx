import type { DrillRun } from "@/lib/drills/state";
import { fmtMs } from "@/lib/drills/view";

/** 최근 시도 막대 — 높이 = 걸린 시간(제한 시간 대비), 색 = 통과/실패 */
export function RunBars({ runs, limitMs, compact = false }: { runs: DrillRun[]; limitMs: number; compact?: boolean }) {
  const h = compact ? 18 : 56;
  return (
    <span className="inline-flex items-end gap-[3px]" style={{ height: h }} aria-label={`최근 ${runs.length}회 기록`}>
      {runs.map((r) => {
        const ratio = Math.max(0.08, Math.min(1, r.ms / limitMs));
        const label = `${new Date(r.at).toLocaleString("ko-KR")} · ${r.ok ? "통과" : r.gaveUp ? "포기" : "실패"} · ${fmtMs(r.ms)} · 힌트 ${r.hints}`;
        return (
          <span
            key={r.at}
            title={label}
            className={`block w-[7px] rounded-sm ${r.ok ? "bg-ok" : "bg-danger/60"}`}
            style={{ height: Math.round(h * ratio) }}
          />
        );
      })}
    </span>
  );
}
