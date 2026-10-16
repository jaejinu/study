import { checkEnv } from "@/lib/env-checks";
import { recentAlerts } from "@/lib/alerts";
import { Card } from "./ui";

export async function EnvStatusCard({ subject }: { subject: string }) {
  const st = await checkEnv(subject);
  const alerts = subject === "observability" ? await recentAlerts(8) : [];
  return (
    <>
    {subject === "observability" && (
      <Card className="mb-4 p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">최근 알림 (Alertmanager → /api/alerts)</span>
          <a href="http://localhost:19093" target="_blank" rel="noreferrer" className="text-xs text-info hover:underline">Alertmanager ↗</a>
        </div>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted">아직 받은 알림이 없습니다. 스택이 켜져 있으면 Watchdog(info) 가 곧 도착합니다. 실험실의 알림 파이프라인 실험으로 critical 알림을 만들어 보세요.</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {alerts.map((a) => (
              <li key={a.id + a.receivedAt} className="flex flex-wrap items-center gap-2">
                <span className={`rounded border px-1.5 py-0.5 text-[11px] ${a.status === "resolved" ? "border-ok/30 bg-ok/15 text-ok" : a.severity === "critical" ? "border-accent/30 bg-accent-soft text-accent" : a.severity === "warning" ? "border-warn/30 bg-warn/15 text-warn" : "border-border bg-surface-2 text-muted"}`}>{a.status === "resolved" ? "resolved" : a.severity}</span>
                <span className="font-mono text-xs">{a.alertname}</span>
                <span className="text-muted">{a.summary}</span>
                <span className="ml-auto text-[11px] text-muted">{new Date(a.receivedAt).toLocaleTimeString("ko-KR")}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    )}
    <Card className={`p-4 ${st.ok ? "" : "border-warn/40"}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${st.ok ? "bg-ok" : "bg-warn"}`} />
        <span className={`text-sm font-semibold ${st.ok ? "" : "text-warn"}`}>{st.title}</span>
      </div>
      {st.lines.length > 0 && (
        <ul className="space-y-0.5 font-mono text-[13px] text-foreground/90">
          {st.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {st.hint && <pre className="mt-2 rounded bg-background p-3 text-sm">{st.hint}</pre>}
      {st.links && (
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          {st.links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="text-info hover:underline">
              {l.label} ↗
            </a>
          ))}
        </div>
      )}
    </Card>
    </>
  );
}
