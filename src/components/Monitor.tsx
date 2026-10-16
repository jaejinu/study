"use client";

import { useEffect, useRef, useState } from "react";
import { getSnapshotAction } from "@/actions/monitor";
import type { Snapshot } from "@/lib/monitor";
import { Badge, Card } from "./ui";

const LINE = "#3b82f6";

function Sparkline({ values, label, unit }: { values: number[]; label: string; unit: string }) {
  const W = 360;
  const H = 80;
  const max = Math.max(1, ...values);
  const min = 0;
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const pts = values.map((v, i) => [i * step, H - 8 - ((v - min) / (max - min)) * (H - 16)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [hover, setHover] = useState<number | null>(null);
  const last = values[values.length - 1] ?? 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="font-mono text-foreground">
          {hover !== null ? values[hover] : last} {unit}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        onMouseMove={(e) => {
          const rect = (e.target as SVGElement).closest("svg")!.getBoundingClientRect();
          const i = Math.round(((e.clientX - rect.left) / rect.width) * (values.length - 1));
          setHover(Math.max(0, Math.min(values.length - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={0} x2={W} y1={H - 8} y2={H - 8} stroke="var(--border)" />
        {values.length > 1 && <path d={d} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" />}
        {hover !== null && pts[hover] && (
          <>
            <line x1={pts[hover][0]} x2={pts[hover][0]} y1={0} y2={H - 8} stroke="var(--muted)" strokeDasharray="2 2" />
            <circle cx={pts[hover][0]} cy={pts[hover][1]} r="4" fill={LINE} stroke="var(--surface)" strokeWidth="2" />
          </>
        )}
      </svg>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="font-mono text-lg">{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function Monitor() {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [running, setRunning] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await getSnapshotAction();
      if (alive) setSnaps((prev) => [...prev, s].slice(-60));
    };
    tick();
    if (running) timer.current = setInterval(tick, 2000);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, [running]);

  const last = snaps[snaps.length - 1];
  if (!last) return <p className="text-sm text-muted">수집 중…</p>;
  if (!last.ok) return <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">Redis 에 연결할 수 없습니다: {last.error}</div>;

  // ops/sec 는 INFO 의 순간값, 누적 명령 수 차이로도 계산해 둔다
  const ops = snaps.map((s) => s.opsPerSec);
  const mem = snaps.map((s) => Math.round(s.usedMemory / 1024));
  const clients = snaps.map((s) => s.clients);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-xs text-muted">
        <Badge tone={running ? "ok" : "muted"}>{running ? "2초마다 갱신" : "일시정지"}</Badge>
        <button className="underline" onClick={() => setRunning((v) => !v)}>
          {running ? "일시정지" : "재개"}
        </button>
        <span>{new Date(last.at).toLocaleTimeString("ko-KR")}</span>
        <span>샘플 {snaps.length}/60</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="ops/sec" value={String(last.opsPerSec)} sub={`누적 ${last.totalCommands.toLocaleString()}`} />
        <Tile label="메모리" value={last.usedMemoryHuman} sub={`단편화 ${last.fragmentation.toFixed(2)}${last.maxmemory ? ` · 한도 ${Math.round(last.maxmemory / 1024 / 1024)}MB` : ""}`} />
        <Tile label="클라이언트" value={String(last.clients)} sub={`블로킹 ${last.blocked}`} />
        <Tile label="키" value={last.keys.toLocaleString()} sub={`TTL 있음 ${last.expires}`} />
        <Tile label="히트율" value={last.hitRate === null ? "-" : `${(last.hitRate * 100).toFixed(1)}%`} sub="keyspace hits/(hits+misses)" />
        <Tile label="만료/축출" value={`${last.expired} / ${last.evicted}`} sub="expired_keys / evicted_keys" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-3">
          <Sparkline values={ops} label="ops/sec" unit="ops" />
        </Card>
        <Card className="p-3">
          <Sparkline values={mem} label="used_memory" unit="KB" />
        </Card>
        <Card className="p-3">
          <Sparkline values={clients} label="connected_clients" unit="" />
        </Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold">SLOWLOG (최근 10, 임계값 10ms)</div>
          {last.slowlog.length === 0 ? (
            <p className="text-sm text-muted">느린 명령이 없습니다. 콘솔에서 <code>DEBUG SLEEP 0.02</code> 는 막혀 있으니, 큰 키에 <code>KEYS *</code> 같은 명령으로 만들어 볼 수 있습니다.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">시각</th>
                  <th className="py-1 text-right">µs</th>
                  <th className="py-1">명령</th>
                </tr>
              </thead>
              <tbody>
                {last.slowlog.map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="py-1 text-xs text-muted">{new Date(s.at).toLocaleTimeString("ko-KR")}</td>
                    <td className="py-1 text-right font-mono text-xs">{s.durationUs.toLocaleString()}</td>
                    <td className="py-1 font-mono text-xs">{s.cmd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold">명령 통계 (호출 수 상위 10)</div>
          <table className="w-full text-[13px]">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1">명령</th>
                <th className="py-1 text-right">호출</th>
                <th className="py-1 text-right">µs/호출</th>
              </tr>
            </thead>
            <tbody>
              {last.commandStats.map((c) => (
                <tr key={c.cmd} className="border-t border-border">
                  <td className="py-1 font-mono text-xs">{c.cmd}</td>
                  <td className="py-1 text-right font-mono text-xs">{c.calls.toLocaleString()}</td>
                  <td className="py-1 text-right font-mono text-xs text-muted">{c.usecPerCall.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <p className="text-xs text-muted">
        INFO 와 SLOWLOG GET 을 2초마다 읽습니다. 다른 탭에서 벤치마크나 실험을 돌리면 ops/sec 와 메모리가 움직이는 것을 볼 수 있습니다.
      </p>
    </div>
  );
}
