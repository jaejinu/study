"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { fmtMs, type ActiveDrill, type DrillRun, type DrillView } from "@/lib/drills/view";
import { RunBars } from "./RunBars";
import { useReadOnly } from "../ReadOnly";

type Phase = "idle" | "starting" | "running" | "checking" | "resetting" | "passed" | "gaveUp";

async function call(id: string, action: string) {
  const res = await fetch(`/api/drills/${id}/${action}`, { method: "POST" });
  return (await res.json()) as { ok: boolean; error?: string; passed?: boolean; detail?: string; ms?: number; hint?: string; active?: ActiveDrill };
}

export function DrillRunner({
  drill,
  initialActive,
  initialRuns,
  initialHints,
  best,
}: {
  drill: DrillView;
  initialActive: ActiveDrill | null;
  initialRuns: DrillRun[];
  initialHints: string[];
  best: number | null;
}) {
  const router = useRouter();
  const { readOnly } = useReadOnly();
  const [phase, setPhase] = useState<Phase>(initialActive ? "running" : "idle");
  const [active, setActive] = useState<ActiveDrill | null>(initialActive);
  const [hints, setHints] = useState<string[]>(initialHints);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger" | "muted"; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [result, setResult] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const left = active ? Math.max(0, active.expiresAt - now) : 0;
  const elapsed = active ? now - active.startedAt : 0;
  const expired = active !== null && left === 0;
  const busy = phase === "starting" || phase === "checking" || phase === "resetting";
  const finished = phase === "passed" || phase === "gaveUp";

  async function start() {
    setPhase("starting");
    setMsg({ tone: "muted", text: "전용 컨테이너에 고장을 만드는 중… (이미지 받기 포함 최대 1~2분)" });
    const r = await call(drill.id, "start");
    if (!r.ok || !r.active) {
      setPhase("idle");
      setMsg({ tone: "danger", text: r.error ?? "시작 실패" });
      return;
    }
    setActive(r.active);
    setHints([]);
    setResult(null);
    setNow(Date.now());
    setPhase("running");
    setMsg(null);
  }
  async function check() {
    setPhase("checking");
    const r = await call(drill.id, "check");
    if (!r.ok) {
      setPhase(r.error?.includes("진행 중") ? "idle" : "running");
      setMsg({ tone: "danger", text: r.error ?? "채점 실패" });
      if (r.error?.includes("진행 중")) setActive(null);
      return;
    }
    if (r.passed) {
      setPhase("passed");
      setActive(null);
      setResult(r.ms ?? null);
      setMsg({ tone: "ok", text: `복구 확인 — ${r.detail}` });
      router.refresh();
    } else {
      setPhase("running");
      setMsg({ tone: "danger", text: `아직 고장 상태 — ${r.detail}` });
    }
  }
  async function hint() {
    const r = await call(drill.id, "hint");
    if (r.ok && r.hint) setHints((h) => (h.includes(r.hint!) ? h : [...h, r.hint!]));
    else setMsg({ tone: "danger", text: r.error ?? "힌트 실패" });
  }
  async function giveUp() {
    setPhase("resetting");
    setMsg({ tone: "muted", text: "컨테이너를 지우고 원복하는 중…" });
    const r = await call(drill.id, "reset");
    setActive(null);
    setPhase("gaveUp");
    setMsg(r.ok ? { tone: "muted", text: "원복 완료 — 전용 리소스를 모두 지웠다. 아래 해설을 읽고 다시 도전해 보자." } : { tone: "danger", text: r.error ?? "원복 실패" });
    router.refresh();
  }

  const levelTone = drill.level === "쉬움" ? "ok" : drill.level === "보통" ? "info" : "danger";
  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={levelTone}>{drill.level}</Badge>
          <span className="text-xs text-muted">제한 {drill.timeLimitMin}분 · 힌트 {drill.hintCount}개</span>
          {best !== null && <span className="text-xs text-muted">· 최고 기록 {fmtMs(best)}</span>}
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">{drill.title}</h1>
        <p className="mt-1 text-sm text-muted">{drill.summary}</p>
      </div>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">증상</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {drill.symptoms.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <h3 className="mt-4 text-xs font-semibold text-muted">관찰을 시작할 만한 명령</h3>
        <pre className="mt-1 overflow-x-auto rounded bg-background p-3 text-[12.5px] leading-relaxed">{drill.starters.join("\n")}</pre>
      </Card>

      <Card className={`p-4 ${active ? "border-warn/50" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          {readOnly && (
            <p className="text-sm text-muted">
              🔒 읽기 전용 공개판에서는 고장을 주입하지 않습니다. 로컬에서 <code>pnpm dev</code> 로 띄운 뒤 <code>/drills/{drill.id}</code> 에서 훈련하세요. 위의 증상과 명령으로 어떤 장애인지 미리 볼 수 있습니다.
            </p>
          )}
          {!readOnly && !active && !busy && (
            <Button id="drill-start" onClick={start}>
              {finished ? "다시 도전" : "훈련 시작 (고장 주입)"}
            </Button>
          )}
          {(active || phase === "checking" || phase === "resetting") && (
            <>
              <Button id="drill-check" onClick={check} disabled={busy}>
                {phase === "checking" ? "채점 중…" : "채점"}
              </Button>
              <Button variant="ghost" onClick={hint} disabled={busy || hints.length >= drill.hintCount}>
                힌트 ({hints.length}/{drill.hintCount})
              </Button>
              <Button id="drill-giveup" variant="danger" onClick={giveUp} disabled={phase === "resetting"} className="ml-auto">
                {phase === "resetting" ? "원복 중…" : "포기하고 원복"}
              </Button>
            </>
          )}
          {phase === "starting" && <span className="text-sm text-muted">고장 주입 중…</span>}
        </div>
        {active && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <span>
              경과 <b className="tabular-nums">{fmtMs(elapsed)}</b>
            </span>
            <span className={left < 120_000 ? "text-danger" : "text-muted"}>
              데드맨 자동 원복까지 <b className="tabular-nums">{fmtMs(left)}</b>
            </span>
            {expired && <span className="text-danger">시간 초과 — 자동 원복됐을 수 있다. 포기하고 원복을 눌러 정리하자.</span>}
          </div>
        )}
        {active?.endpoint && <p className="mt-2 text-xs text-muted">대상: <code>{active.endpoint}</code></p>}
        {msg && (
          <p className={`mt-3 text-sm ${msg.tone === "ok" ? "text-ok" : msg.tone === "danger" ? "text-danger" : "text-muted"}`} role="status">
            {msg.text}
          </p>
        )}
        {result !== null && (
          <p className="mt-2 text-lg font-semibold text-ok">
            MTTR {fmtMs(result)} {best !== null && result <= best ? "· 최고 기록!" : ""}
          </p>
        )}
        {hints.length > 0 && (
          <ol className="mt-4 space-y-1.5 border-t border-border pt-3 text-sm">
            {hints.map((h, i) => (
              <li key={h}>
                <span className="mr-1 text-warn">힌트 {i + 1}.</span>
                {h}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {finished && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">해설</h2>
          <p className="mt-2 text-sm leading-relaxed">{drill.explanation.cause}</p>
          <h3 className="mt-4 text-xs font-semibold text-muted">고치는 법</h3>
          <p className="mt-1 text-sm leading-relaxed">{drill.explanation.fix}</p>
          <pre className="mt-2 overflow-x-auto rounded bg-background p-3 text-[12.5px] leading-relaxed">{drill.solution.join("\n")}</pre>
          <h3 className="mt-4 text-xs font-semibold text-muted">관련 노트</h3>
          <ul className="mt-1 space-y-0.5 text-sm">
            {drill.explanation.notes.map((n) => (
              <li key={n.href}>
                <Link className="text-info hover:underline" href={n.href}>
                  {n.title}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="text-sm font-semibold">최근 기록</h2>
        {initialRuns.length === 0 ? (
          <p className="mt-2 text-sm text-muted">아직 기록이 없다.</p>
        ) : (
          <>
            <div className="mt-3">
              <RunBars runs={initialRuns} limitMs={drill.timeLimitMin * 60_000} />
            </div>
            <p className="mt-2 text-xs text-muted">
              막대 높이 = 걸린 시간(제한 시간 대비) · 초록 = 통과 · 빨강 = 실패/포기. 통과 {initialRuns.filter((r) => r.ok).length} / 시도 {initialRuns.length}
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
