"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { runExperimentAction } from "@/actions/experiments";
import { runShellExperimentAction } from "@/actions/shell-lab";
import { runCodeExperimentAction } from "@/actions/code-lab";
import { Badge, Button, Card } from "./ui";

type ToolEvent = { name: string; input: Record<string, unknown>; ms?: number; isError?: boolean; preview?: string; proposal?: Proposal };
type Proposal = { subject: string; id: string; title: string; reason: string; href: string; status?: "pending" | "running" | "done" | "declined" };
type Usage = { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; ttftMs: number | null; totalMs: number; toolCalls: number };
type Msg = { role: "user" | "assistant"; content: string; tools?: ToolEvent[]; usage?: Usage; error?: string };

const SHELL = new Set(["docker", "kubernetes", "linux-network", "observability"]);

function summarizeResult(r: { ok: boolean; error?: string; durationMs: number; steps: { cmd: string; result?: unknown; output?: string; ok?: boolean; error?: boolean; note?: boolean }[] }): string {
  const lines = r.steps.slice(0, 40).map((s) => {
    const res = "result" in s ? JSON.stringify(s.result)?.slice(0, 160) : (s.output ?? "").slice(0, 160);
    return `- ${s.cmd.slice(0, 120)}${res ? ` → ${res}` : ""}`;
  });
  return `[실험 결과] ${r.ok ? "성공" : "실패"} (${r.durationMs}ms, ${r.steps.length}단계)${r.error ? `\n오류: ${r.error}` : ""}\n${lines.join("\n")}${r.steps.length > 40 ? "\n… (이하 생략)" : ""}`;
}

export function Assistant({ configured, model: defaultModel, models }: { configured: boolean; model: string; models: string[] }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(defaultModel);
  const [busy, setBusy] = useState(false);
  const [totalCost, setTotalCost] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: text.trim() }];
    setMessages([...next, { role: "assistant", content: "", tools: [] }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: next.map((m) => ({ role: m.role, content: m.content })) }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: res.statusText }));
        setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? { ...m, error: j.error } : m)));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          const ev = JSON.parse(p.slice(6));
          setMessages((ms) => {
            const last = { ...ms[ms.length - 1] };
            if (ev.type === "text") last.content += ev.text;
            else if (ev.type === "tool_start") last.tools = [...(last.tools ?? []), { name: ev.name, input: ev.input }];
            else if (ev.type === "tool_result") {
              const tools = [...(last.tools ?? [])];
              const idx = tools.map((t) => t.name).lastIndexOf(ev.name);
              if (idx >= 0) tools[idx] = { ...tools[idx], ms: ev.ms, isError: ev.isError, preview: ev.preview, proposal: ev.proposal ? { ...ev.proposal, status: "pending" } : undefined };
              last.tools = tools;
            } else if (ev.type === "usage") {
              last.usage = ev;
              setTotalCost((c) => c + ev.costUsd);
            } else if (ev.type === "error") last.error = ev.message;
            return [...ms.slice(0, -1), last];
          });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const runProposal = async (mi: number, ti: number, p: Proposal) => {
    setMessages((ms) => ms.map((m, i) => (i !== mi ? m : { ...m, tools: m.tools?.map((t, j) => (j === ti && t.proposal ? { ...t, proposal: { ...t.proposal, status: "running" } } : t)) })));
    const r = p.subject === "redis" ? await runExperimentAction(p.id) : SHELL.has(p.subject) ? await runShellExperimentAction(p.subject, p.id) : await runCodeExperimentAction(p.subject, p.id);
    setMessages((ms) => ms.map((m, i) => (i !== mi ? m : { ...m, tools: m.tools?.map((t, j) => (j === ti && t.proposal ? { ...t, proposal: { ...t.proposal, status: "done" } } : t)) })));
    await send(`${summarizeResult(r as Parameters<typeof summarizeResult>[0])}\n\n이 결과를 해석해 줘.`);
  };

  if (!configured)
    return (
      <Card className="border-warn/40 p-5">
        <div className="font-semibold text-warn">ANTHROPIC_API_KEY 가 설정되어 있지 않습니다</div>
        <p className="mt-2 text-sm text-muted">도우미는 Claude API 를 호출합니다. 키를 환경 변수로 주고 dev 서버를 다시 띄우세요. 키는 서버에만 있고 브라우저로 가지 않습니다.</p>
        <pre className="mt-3 rounded bg-background p-3 text-sm">{`ANTHROPIC_API_KEY=sk-ant-... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm dev
# 모델 바꾸기: ASSISTANT_MODEL=claude-haiku-5-5`}</pre>
        <p className="mt-3 text-sm text-muted">
          키 없이도 구조는 읽을 수 있습니다: <code>src/lib/assistant/tools.ts</code>(툴 정의·실행), <code>src/app/api/assistant/route.ts</code>(스트리밍·툴 루프·관측). 설계는{" "}
          <Link href="/ai-systems/notes/01-llm-app-architecture" className="text-info hover:underline">AI 시스템 설계 노트</Link> 참고.
        </p>
      </Card>
    );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
      <div className="flex min-h-[560px] flex-col rounded-lg border border-border bg-surface">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="text-sm text-muted">
              <p>노트를 근거로 답하고, 도움이 될 실험을 제안합니다. 실험은 승인 버튼을 눌러야 실행됩니다.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {["Redis 파이프라인이 왜 빠른지 설명하고 확인할 실험을 제안해줘", "Kafka 에서 같은 주문의 이벤트 순서를 보장하려면?", "PostgreSQL 데드락은 어떻게 감지되고 예방하나?", "내가 Redis 에서 아직 안 읽은 노트는?"].map((q) => (
                  <button key={q} onClick={() => send(q)} className="rounded border border-border bg-surface-2 px-2.5 py-1.5 text-left text-xs hover:border-muted">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, mi) => (
            <div key={mi} className={m.role === "user" ? "ml-auto max-w-[85%] rounded-lg bg-accent-soft px-3 py-2 text-sm" : "max-w-[95%]"}>
              {m.role === "assistant" && m.tools && m.tools.length > 0 && (
                <div className="mb-2 space-y-1">
                  {m.tools.map((t, ti) => (
                    <div key={ti} className="rounded border border-border bg-surface-2 px-2 py-1 text-[11px]">
                      <span className="font-mono text-info">⚙ {t.name}</span>
                      <span className="ml-1 text-muted">{JSON.stringify(t.input).slice(0, 120)}</span>
                      {t.ms !== undefined && <span className={`ml-2 ${t.isError ? "text-accent" : "text-muted"}`}>{t.ms}ms{t.isError ? " · 오류" : ""}</span>}
                      {t.proposal && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded border border-accent/30 bg-background px-2 py-1.5 text-xs">
                          <span>⚗ <Link href={t.proposal.href} className="font-medium hover:underline">{t.proposal.title}</Link></span>
                          <span className="text-muted">— {t.proposal.reason}</span>
                          {t.proposal.status === "pending" && (
                            <>
                              <Button className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => runProposal(mi, ti, t.proposal!)}>승인하고 실행 ▶</Button>
                              <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => setMessages((ms) => ms.map((x, i) => (i !== mi ? x : { ...x, tools: x.tools?.map((y, j) => (j === ti && y.proposal ? { ...y, proposal: { ...y.proposal, status: "declined" } } : y)) })))}>건너뛰기</Button>
                            </>
                          )}
                          {t.proposal.status === "running" && <Badge tone="info">실행 중…</Badge>}
                          {t.proposal.status === "done" && <Badge tone="ok">실행됨 → 결과 전달</Badge>}
                          {t.proposal.status === "declined" && <Badge>건너뜀</Badge>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className={`whitespace-pre-wrap text-sm leading-relaxed ${m.role === "assistant" ? "" : ""}`}>{m.content || (m.role === "assistant" && busy && mi === messages.length - 1 ? <span className="text-muted">생각 중…</span> : null)}</div>
              {m.error && <div className="mt-1 text-xs text-accent">오류: {m.error}</div>}
              {m.usage && (
                <div className="mt-1 text-[11px] text-muted">
                  {m.usage.model} · 입력 {m.usage.input} (캐시 읽기 {m.usage.cacheRead}) · 출력 {m.usage.output} · 툴 {m.usage.toolCalls}회 · TTFT {m.usage.ttftMs ?? "-"}ms · 총 {m.usage.totalMs}ms · ≈${m.usage.costUsd.toFixed(4)}
                </div>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form className="flex gap-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="질문을 입력하세요" disabled={busy} className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-muted" />
          <Button type="submit" disabled={busy || !input.trim()}>{busy ? "…" : "보내기"}</Button>
        </form>
      </div>
      <aside className="space-y-3 text-sm">
        <Card className="p-3">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">모델</div>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-sm">
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <div className="mt-2 text-[11px] text-muted">라우팅 아이디어: 짧은 질문은 haiku, 긴 비교·설계는 sonnet/opus</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">이 세션 추정 비용</div>
          <div className="font-mono text-lg">${totalCost.toFixed(4)}</div>
          <div className="text-[11px] text-muted">시스템 프롬프트·툴 정의는 프롬프트 캐시 대상 (cache_read 가 늘면 적중)</div>
        </Card>
        <Card className="p-3 text-[12px] text-muted">
          <div className="mb-1 font-semibold text-foreground">어떻게 동작하나</div>
          <ol className="list-decimal space-y-1 pl-4">
            <li>search_notes 로 근거 검색 (전문 검색)</li>
            <li>필요하면 get_note 로 본문</li>
            <li>답 + 출처 링크</li>
            <li>propose_experiment → 당신이 승인 → 실행 → 결과를 다시 모델에게</li>
          </ol>
          <div className="mt-2">관측: <Link href="/observability" className="text-info hover:underline">토큰·비용·TTFT 메트릭</Link>, Tempo 의 assistant.chat 트레이스</div>
        </Card>
      </aside>
    </div>
  );
}
