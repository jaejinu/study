import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-surface ${className}`}>{children}</div>;
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ok" | "warn" | "accent" | "info" }) {
  const map = {
    muted: "bg-surface-2 text-muted border-border",
    ok: "bg-ok/15 text-ok border-ok/30",
    warn: "bg-warn/15 text-warn border-warn/30",
    accent: "bg-accent-soft text-accent border-accent/30",
    info: "bg-info/15 text-info border-info/30",
  };
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium ${map[tone]}`}>{children}</span>;
}

export function LevelBadge({ level }: { level: string }) {
  const tone = level === "기초" ? "ok" : level === "중급" ? "info" : "accent";
  return <Badge tone={tone}>{level}</Badge>;
}

export function Button({
  children,
  className = "",
  variant = "primary",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const v = {
    primary: "bg-accent text-white hover:bg-accent/90 disabled:bg-accent/40",
    ghost: "border border-border bg-surface-2 text-foreground hover:border-muted disabled:opacity-50",
    danger: "border border-accent/40 text-accent hover:bg-accent-soft disabled:opacity-50",
  };
  return (
    <button className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${v[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function RedisDown({ error, url }: { error?: string; url: string }) {
  return (
    <Card className="border-warn/40 p-4">
      <div className="font-semibold text-warn">Redis 에 연결할 수 없습니다</div>
      <p className="mt-1 text-sm text-muted">
        <code>{url}</code> 에 서버가 없는 것 같습니다. 프로젝트 루트에서 아래 명령으로 서버를 띄우세요.
      </p>
      <pre className="mt-2 rounded bg-background p-3 text-sm">pnpm redis</pre>
      {error && <p className="mt-2 text-xs text-muted">{error}</p>}
    </Card>
  );
}

export function NoteLink({ slug, title }: { slug: string; title: string }) {
  return (
    <Link href={`/redis/notes/${slug}`} className="text-sm text-info underline-offset-2 hover:underline">
      {title}
    </Link>
  );
}
