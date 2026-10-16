"use client";

import { useEffect, useState, useTransition } from "react";

/** 실험 결과의 공통 모양 (Redis·셸·코드 실험 결과에서 필요한 것만) */
export interface RunLike {
  ok: boolean;
  durationMs: number;
  ranAt: string;
  error?: string;
  steps: { cmd: string; note?: boolean; ok?: boolean; error?: boolean }[];
}

interface Saved {
  ok: boolean;
  durationMs: number;
  ranAt: string;
  pass: number;
  fail: number;
}

const key = (id: string) => `study:lab-last:${id}`;

function checksOf(r: RunLike) {
  // 검증 단계는 "✓ …" / "✗ …" 로 시작하는 기록 (Recorder.check / ctx.check)
  const checks = r.steps.filter((s) => s.cmd.startsWith("✓") || s.cmd.startsWith("✗"));
  const fail = checks.filter((s) => s.cmd.startsWith("✗") || s.ok === false || s.error).length;
  return { pass: checks.length - fail, fail, total: checks.length };
}

export function loadPrevious(id: string): Saved | null {
  try {
    const raw = localStorage.getItem(key(id));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

export function saveRun(id: string, r: RunLike) {
  const c = checksOf(r);
  try {
    localStorage.setItem(key(id), JSON.stringify({ ok: r.ok, durationMs: r.durationMs, ranAt: r.ranAt, pass: c.pass, fail: c.fail } satisfies Saved));
  } catch {
    /* ignore */
  }
}

/** 실행 상태 + 지난번 결과(브라우저 기록) 비교를 묶은 훅. storageId 는 "subject/id" */
export function useLabRun<T extends RunLike>(storageId: string, action: () => Promise<T>) {
  const [result, setResult] = useState<T | null>(null);
  const [previous, setPrevious] = useState<Saved | null>(null);
  const [pending, start] = useTransition();
  const run = () => {
    setPrevious(loadPrevious(storageId));
    start(async () => {
      const r = await action();
      setResult(r);
      saveRun(storageId, r);
    });
  };
  return { result, previous, pending, run };
}

function fmt(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 실행 중: 스피너 + 경과 시간 (+ 지난번 소요 시간이 있으면 예상 진행) */
export function RunningIndicator({ previousMs }: { previousMs?: number }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const elapsed = now - start;
  const pct = previousMs ? Math.min(95, (elapsed / previousMs) * 100) : undefined;
  return (
    <div className="rounded-lg border border-info/30 bg-info/5 px-4 py-3" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-sm">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-info/30 border-t-info" aria-hidden />
        <span className="font-medium">실행 중…</span>
        <span className="font-mono text-muted">{fmt(elapsed)}</span>
        {previousMs !== undefined && <span className="text-xs text-muted">지난번 {fmt(previousMs)} 걸림</span>}
      </div>
      {pct !== undefined && (
        <div className="mt-2 h-1 overflow-hidden rounded bg-surface-2">
          <div className="h-full rounded bg-info transition-[width] duration-200" style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="mt-2 text-xs text-muted">서버가 실제 명령을 실행하고 있습니다. 끝나면 단계별 결과가 한 번에 표시됩니다.</p>
    </div>
  );
}

/** 결과 요약 헤더: 성공/실패 · 검증 ✓/✗ 개수 · 소요 시간 · 지난번과 비교 */
export function RunSummary({ result, previous }: { result: RunLike; previous: Saved | null }) {
  const c = checksOf(result);
  const delta = previous ? result.durationMs - previous.durationMs : null;
  const pct = previous && previous.durationMs > 0 && delta !== null ? Math.round((delta / previous.durationMs) * 100) : null;
  return (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-3 ${result.ok ? "border-ok/40 bg-ok/5" : "border-danger/40 bg-danger/10"}`}>
      <span className={`text-base font-semibold ${result.ok ? "text-ok" : "text-danger"}`}>{result.ok ? "✓ 성공" : "✗ 실패"}</span>
      {c.total > 0 && (
        <span className="text-sm">
          검증 <span className="font-mono text-ok">{c.pass}</span>
          {c.fail > 0 && (
            <>
              {" "}
              / <span className="font-mono text-danger">✗ {c.fail}</span>
            </>
          )}{" "}
          <span className="text-muted">/ {c.total}</span>
        </span>
      )}
      <span className="text-sm text-muted">
        {result.steps.length}단계 · <span className="font-mono text-foreground">{fmt(result.durationMs)}</span>
      </span>
      {previous && (
        <span className="text-xs text-muted" title={`지난 실행: ${new Date(previous.ranAt).toLocaleString("ko-KR")}`}>
          지난번 {previous.ok ? "성공" : "실패"} · {fmt(previous.durationMs)}
          {pct !== null && Math.abs(pct) >= 5 && <span className={delta! < 0 ? "text-ok" : "text-warn"}> ({pct > 0 ? "+" : ""}{pct}%)</span>}
          {previous.ok !== result.ok && <span className={result.ok ? "text-ok" : "text-danger"}> · 결과가 바뀜</span>}
        </span>
      )}
      <span className="ml-auto text-xs text-muted">{new Date(result.ranAt).toLocaleTimeString("ko-KR")}</span>
    </div>
  );
}
