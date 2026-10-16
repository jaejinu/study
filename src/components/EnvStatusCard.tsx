import { checkEnv } from "@/lib/env-checks";
import { Card } from "./ui";

export async function EnvStatusCard({ subject }: { subject: string }) {
  const st = await checkEnv(subject);
  return (
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
  );
}
