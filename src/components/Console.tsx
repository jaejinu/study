"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { execCommandAction } from "@/actions/console";
import type { ConsoleResult } from "@/lib/console";
import { Button } from "./ui";

const EXAMPLES = [
  "SET hello world",
  "GET hello",
  "INCR counter",
  "HSET user:1 name alice age 30",
  "HGETALL user:1",
  "ZADD rank 10 a 20 b 30 c",
  "ZREVRANGE rank 0 -1 WITHSCORES",
  "SET temp 1 EX 30",
  "TTL temp",
  "SCAN 0 MATCH * COUNT 20",
  "OBJECT ENCODING counter",
  "INFO memory",
  "DBSIZE",
];

function render(v: unknown, depth = 0): React.ReactNode {
  const pad = "  ".repeat(depth);
  if (v === null || v === undefined) return <span className="text-muted">{pad}(nil)</span>;
  if (typeof v === "number") return <span className="text-warn">{pad}(integer) {v}</span>;
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="text-muted">{pad}(empty array)</span>;
    return (
      <div>
        {v.map((x, i) => (
          <div key={i}>
            {pad}
            {i + 1}) {Array.isArray(x) ? <div className="pl-4">{render(x, 0)}</div> : render(x, 0)}
          </div>
        ))}
      </div>
    );
  }
  const s = String(v);
  if (s.includes("\n")) return <pre className="whitespace-pre-wrap">{pad}{s}</pre>;
  return <span>{pad}&quot;{s}&quot;</span>;
}

export function Console() {
  const [history, setHistory] = useState<ConsoleResult[]>([]);
  const [input, setInput] = useState("");
  const [cmdHist, setCmdHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [pending, start] = useTransition();
  const bottom = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  const submit = (line: string) => {
    const l = line.trim();
    if (!l) return;
    setCmdHist((h) => [l, ...h].slice(0, 100));
    setHistIdx(-1);
    setInput("");
    if (l.toUpperCase() === "CLEAR") {
      setHistory([]);
      return;
    }
    start(async () => {
      const r = await execCommandAction(l);
      setHistory((h) => [...h, r]);
    });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
      <div className="flex min-h-[520px] flex-col rounded-lg border border-border bg-[#0d1117]">
        <div className="flex-1 overflow-y-auto p-4 font-mono text-[13px] leading-relaxed">
          {history.length === 0 && (
            <div className="text-muted">
              redis-cli 처럼 명령을 입력하세요. 위/아래 화살표로 이전 명령을 불러오고, <span className="text-foreground">CLEAR</span> 로 화면을 비웁니다.
              <br />
              FLUSHALL, CONFIG SET, SUBSCRIBE 처럼 환경을 망가뜨리거나 커넥션을 점유하는 명령은 막혀 있습니다.
            </div>
          )}
          {history.map((h, i) => (
            <div key={i} className="mb-3">
              <div className="text-info">
                <span className="text-muted">127.0.0.1:6379&gt; </span>
                {h.cmd}
              </div>
              <div className={`pl-2 ${h.ok ? "text-foreground" : "text-accent"}`}>
                {h.ok ? render(h.result) : `(error) ${h.error}`}
              </div>
              {h.ms > 0 && <div className="pl-2 text-[11px] text-muted">{h.ms}ms</div>}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form
          className="flex items-center gap-2 border-t border-border px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <span className="font-mono text-xs text-muted">127.0.0.1:6379&gt;</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                const n = Math.min(histIdx + 1, cmdHist.length - 1);
                setHistIdx(n);
                setInput(cmdHist[n] ?? "");
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const n = Math.max(histIdx - 1, -1);
                setHistIdx(n);
                setInput(n === -1 ? "" : cmdHist[n]);
              }
            }}
            className="flex-1 bg-transparent font-mono text-sm outline-none"
            placeholder="SET key value"
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
          <Button type="submit" variant="ghost" disabled={pending} className="px-3 py-1 text-xs">
            {pending ? "…" : "실행"}
          </Button>
        </form>
      </div>
      <aside className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">예제 명령</div>
        <div className="flex flex-col gap-1">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setInput(ex);
                inputRef.current?.focus();
              }}
              className="rounded border border-border bg-surface px-2.5 py-1.5 text-left font-mono text-xs text-muted hover:border-muted hover:text-foreground"
            >
              {ex}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
