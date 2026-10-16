import { getLabRuns } from "@/lib/lab-history";

/** 최근 실행 이력 막대: 높이 = 소요 시간, 색 = 성공/실패. 서버 컴포넌트 */
export async function LabHistory({ subject, id }: { subject: string; id: string }) {
  const runs = await getLabRuns(subject, id, 20);
  if (runs.length === 0) return <p className="text-[13px] text-muted">아직 기록된 실행이 없습니다. 실행하면 결과가 Redis Stream 에 쌓여 여기 추이로 보입니다.</p>;
  const max = Math.max(...runs.map((r) => r.durationMs), 1);
  const ok = runs.filter((r) => r.ok).length;
  const sorted = runs.map((r) => r.durationMs).sort((a, b) => a - b);
  const p50 = sorted[Math.floor((sorted.length - 1) / 2)];
  const last = runs[runs.length - 1];
  const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <span>
          최근 {runs.length}회 · 성공 <span className="text-foreground">{ok}</span> / 실패 <span className={runs.length - ok ? "text-accent" : "text-foreground"}>{runs.length - ok}</span>
        </span>
        <span>
          중앙값 <span className="font-mono text-foreground">{fmt(p50)}</span>
        </span>
        <span>
          마지막 <span className="font-mono text-foreground">{fmt(last.durationMs)}</span> ({new Date(last.at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })})
        </span>
      </div>
      <div className="flex h-16 items-end gap-1" role="img" aria-label={`최근 ${runs.length}회 실행 소요 시간 막대`}>
        {runs.map((r) => (
          <div
            key={r.at}
            title={`${new Date(r.at).toLocaleString("ko-KR")} · ${r.ok ? "성공" : "실패"} · ${fmt(r.durationMs)} · 검증 ${r.checks - r.failedChecks}/${r.checks}${r.error ? ` · ${r.error}` : ""}`}
            className={`min-w-[6px] flex-1 rounded-t ${r.ok ? "bg-ok/70" : "bg-accent/80"}`}
            style={{ height: `${Math.max(6, (r.durationMs / max) * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
