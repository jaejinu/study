"use client";

import { Fragment, useState, useTransition } from "react";
import { runBenchmarkAction } from "@/actions/monitor";
import type { BenchResult } from "@/lib/benchmark";
import { Badge, Button, Card } from "./ui";

// dataviz 검증 통과 팔레트 (dark surface #121821): 순차=blue, 파이프라인=amber
const SERIES_COLORS = ["#3b82f6", "#c0871c"];

function fmt(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(Math.round(n));
}

function GroupedBars({ result }: { result: BenchResult }) {
  const tests = result.series[0].rows.map((r) => r.test);
  const max = Math.max(1, ...result.series.flatMap((s) => s.rows.map((r) => r.rps)));
  const W = 760;
  const H = 300;
  const padL = 56;
  const padB = 36;
  const padT = 16;
  const groupW = (W - padL - 12) / tests.length;
  const barW = Math.min(28, (groupW - 12) / result.series.length);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="테스트별 초당 요청 수 (파이프라인 유무)">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {fmt(t)}
            </text>
          </g>
        ))}
        {tests.map((test, ti) => {
          const gx = padL + ti * groupW + (groupW - barW * result.series.length - 2 * (result.series.length - 1)) / 2;
          return (
            <g key={test}>
              {result.series.map((s, si) => {
                const row = s.rows.find((r) => r.test === test);
                const v = row?.rps ?? 0;
                const x = gx + si * (barW + 2);
                const top = y(v);
                return (
                  <g key={s.label}>
                    <rect
                      x={x}
                      y={top}
                      width={barW}
                      height={Math.max(0, H - padB - top)}
                      rx="4"
                      fill={SERIES_COLORS[si]}
                      onMouseEnter={() => setHover({ x: x + barW / 2, y: top, text: `${test} · ${s.label}: ${fmt(v)} req/s, avg ${row?.avgMs.toFixed(3)}ms, p99 ${row?.p99.toFixed(3)}ms` })}
                      onMouseLeave={() => setHover(null)}
                    />
                    <rect x={x} y={H - padB - 4} width={barW} height={4} fill={SERIES_COLORS[si]} />
                    <text x={x + barW / 2} y={top - 4} textAnchor="middle" fontSize="10" fill="var(--muted)">
                      {fmt(v)}
                    </text>
                  </g>
                );
              })}
              <text x={padL + ti * groupW + groupW / 2} y={H - padB + 16} textAnchor="middle" fontSize="11" fill="var(--foreground)">
                {test}
              </text>
            </g>
          );
        })}
        <line x1={padL} x2={W - 8} y1={H - padB} y2={H - padB} stroke="var(--muted)" strokeWidth="1" />
        <text x={padL} y={H - 4} fontSize="10" fill="var(--muted)">
          req/s (높을수록 좋음)
        </text>
      </svg>
      {hover && (
        <div className="pointer-events-none absolute rounded border border-border bg-surface-2 px-2 py-1 text-[11px]" style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%`, transform: "translate(-50%, -120%)" }}>
          {hover.text}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
        {result.series.map((s, i) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SERIES_COLORS[i] }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Benchmark() {
  const [result, setResult] = useState<BenchResult | null>(null);
  const [requests, setRequests] = useState(20000);
  const [clients, setClients] = useState(20);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted">
          요청 수 (-n)
          <input type="number" value={requests} min={1000} max={200000} step={1000} onChange={(e) => setRequests(Number(e.target.value))} className="ml-2 w-28 rounded border border-border bg-surface px-2 py-1 font-mono text-sm text-foreground" />
        </label>
        <label className="text-xs text-muted">
          동시 클라이언트 (-c)
          <input type="number" value={clients} min={1} max={100} onChange={(e) => setClients(Number(e.target.value))} className="ml-2 w-20 rounded border border-border bg-surface px-2 py-1 font-mono text-sm text-foreground" />
        </label>
        <Button onClick={() => start(async () => setResult(await runBenchmarkAction(requests, clients)))} disabled={pending}>
          {pending ? "redis-benchmark 실행 중…" : "벤치마크 실행 ▶"}
        </Button>
        {result?.ok && <Badge tone="ok">{new Date(result.ranAt).toLocaleTimeString("ko-KR")}</Badge>}
      </div>
      {result && !result.ok && <div className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-accent">{result.error}</div>}
      {result?.ok && (
        <>
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">명령별 처리량 — 파이프라인 유무 비교</div>
            <GroupedBars result={result} />
          </Card>
          <Card className="overflow-x-auto p-4">
            <div className="mb-2 text-sm font-semibold">표</div>
            <table className="w-full text-[13px]">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">명령</th>
                  {result.series.map((s) => (
                    <th key={s.label} className="py-1 text-right" colSpan={3}>
                      {s.label}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th />
                  {result.series.map((s) => (
                    <Fragment key={s.label}>
                      <th className="py-1 text-right">req/s</th>
                      <th className="py-1 text-right">avg ms</th>
                      <th className="py-1 text-right">p99 ms</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.series[0].rows.map((r0) => (
                  <tr key={r0.test} className="border-t border-border">
                    <td className="py-1 font-mono">{r0.test}</td>
                    {result.series.map((s) => {
                      const r = s.rows.find((x) => x.test === r0.test);
                      return (
                        <Fragment key={s.label}>
                          <td className="py-1 text-right font-mono">{r ? fmt(r.rps) : "-"}</td>
                          <td className="py-1 text-right font-mono text-muted">{r?.avgMs.toFixed(3)}</td>
                          <td className="py-1 text-right font-mono text-muted">{r?.p99.toFixed(3)}</td>
                        </Fragment>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">
              -n {result.requests} 요청, -c {result.clients} 클라이언트. 파이프라인은 RTT 를 줄여 처리량을 크게 올리지만 개별 명령의 지연은 늘어난다.
            </p>
          </Card>
        </>
      )}
      {!result && (
        <p className="text-sm text-muted">
          <code>redis-benchmark -q --csv -t set,get,incr,lpush,rpop,sadd,hset,zadd</code> 를 <code>-P 1</code> 과 <code>-P 16</code> 으로 두 번 실행해 비교합니다. 로컬에서 10초 안팎 걸립니다.
        </p>
      )}
    </div>
  );
}
