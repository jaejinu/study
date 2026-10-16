import type { Step } from "@/lib/trace";

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "(nil)";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 1).replace(/\n\s*/g, " ");
}

export function StepsTable({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return <p className="text-sm text-muted">기록된 단계가 없습니다.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-[13px]">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th className="w-10 px-3 py-2">#</th>
            <th className="px-3 py-2">명령 / 설명</th>
            <th className="px-3 py-2">결과</th>
            <th className="w-20 px-3 py-2 text-right">ms</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => {
            if (s.note) {
              const isCheck = s.cmd.startsWith("✓") || s.cmd.startsWith("✗");
              return (
                <tr key={i} className={`border-t border-border ${s.error ? "bg-danger/10" : isCheck ? "bg-ok/5" : "bg-surface-2/60"}`}>
                  <td className="px-3 py-1.5 text-muted">{i + 1}</td>
                  <td colSpan={s.result == null ? 3 : 1} className={`px-3 py-1.5 ${isCheck ? (s.error ? "text-danger" : "text-ok") : "italic text-muted"}`}>
                    {s.cmd}
                  </td>
                  {s.result != null && (
                    <td colSpan={2} className="px-3 py-1.5 font-mono text-xs text-muted">
                      {fmt(s.result)}
                    </td>
                  )}
                </tr>
              );
            }
            return (
              <tr key={i} className={`border-t border-border ${s.error ? "bg-danger/10" : ""}`}>
                <td className="px-3 py-1.5 text-muted">{i + 1}</td>
                <td className="px-3 py-1.5 font-mono text-xs">
                  <span className="text-info">{s.cmd}</span>
                </td>
                <td className={`max-w-[480px] break-all px-3 py-1.5 font-mono text-xs ${s.error ? "text-danger" : ""}`}>{fmt(s.result)}</td>
                <td className="px-3 py-1.5 text-right font-mono text-xs text-muted">{s.ms ? s.ms.toFixed(2) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
