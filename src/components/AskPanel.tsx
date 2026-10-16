"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";

type Proposal = { subject: string; id: string; title: string; reason: string; href: string };
type ToolEvent = { name: string; ms?: number; isError?: boolean; proposal?: Proposal };
type Usage = { model: string; input: number; output: number; cached: number; costUsd: number; ttftMs: number | null; totalMs: number; toolCalls: number };
type Source = { title: string; href: string; subject: string; kind: "current" | "related" };
type Msg = { role: "user" | "assistant"; content: string; tools?: ToolEvent[]; usage?: Usage; error?: string; sources?: Source[] };
type Config = { configured: boolean; model: string; models: string[]; baseUrl: string | null };

const QUICK = ["이 노트를 3줄로 요약해 줘", "지금 이 부분을 예시로 다시 설명해 줘", "이 내용과 관련해 직접 돌려 볼 실험은?", "면접 질문 3개 내 줘"];

/** 화면 오른쪽 "AI 에게 묻기" 패널 — 현재 페이지(노트 본문·선택 텍스트)를 컨텍스트로 OpenAI 에 묻는다 */
export function AskPanel() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState("");
  const [useSelection, setUseSelection] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/ask").then((r) => r.json()).then(setCfg).catch(() => setCfg({ configured: false, model: "", models: [], baseUrl: null }));
  }, []);
  // 페이지가 바뀌면 대화를 페이지 단위로 보관/복원 (sessionStorage)
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(`ask:${pathname}`);
      setMessages(saved ? (JSON.parse(saved) as Msg[]) : []);
    } catch {
      setMessages([]);
    }
  }, [pathname]);
  useEffect(() => {
    try {
      if (messages.length) sessionStorage.setItem(`ask:${pathname}`, JSON.stringify(messages.slice(-30)));
    } catch {
      /* ignore */
    }
  }, [messages, pathname]);
  useEffect(() => {
    const onSel = () => {
      const s = window.getSelection()?.toString() ?? "";
      if (s.trim().length > 8) setSelection(s.trim().slice(0, 2000));
    };
    document.addEventListener("selectionchange", onSel);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    // 상단 바 등 다른 곳에서 패널 열기: window.dispatchEvent(new CustomEvent("ask:open"))
    const onOpen = () => setOpen(true);
    window.addEventListener("ask:open", onOpen);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("ask:open", onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return;
      const next: Msg[] = [...messages, { role: "user", content: text.trim() }];
      setMessages([...next, { role: "assistant", content: "", tools: [] }]);
      setInput("");
      setBusy(true);
      abort.current = new AbortController();
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next.map((m) => ({ role: m.role, content: m.content })), context: { pathname, selection: useSelection ? selection : "" } }),
          signal: abort.current.signal,
        });
        if (!res.ok || !res.body) {
          const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
          setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? { ...m, error: err.error ?? "요청 실패" } : m)));
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const patch = (fn: (m: Msg) => Msg) => setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const p of parts) {
            if (!p.startsWith("data: ")) continue;
            const ev = JSON.parse(p.slice(6)) as Record<string, unknown>;
            if (ev.type === "text") patch((m) => ({ ...m, content: m.content + String(ev.text) }));
            else if (ev.type === "tool_start") patch((m) => ({ ...m, tools: [...(m.tools ?? []), { name: String(ev.name) }] }));
            else if (ev.type === "tool_result") patch((m) => ({ ...m, tools: (m.tools ?? []).map((t, i, arr) => (i === arr.length - 1 ? { ...t, ms: Number(ev.ms), isError: !!ev.isError, proposal: ev.proposal as Proposal | undefined } : t)) }));
            else if (ev.type === "usage") patch((m) => ({ ...m, usage: ev as unknown as Usage }));
            else if (ev.type === "sources") patch((m) => ({ ...m, sources: ev.items as Source[] }));
            else if (ev.type === "error") patch((m) => ({ ...m, error: String(ev.message) }));
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? { ...m, error: (e as Error).message } : m)));
      } finally {
        setBusy(false);
      }
    },
    [busy, messages, pathname, selection, useSelection],
  );

  const isNote = /^\/[a-z0-9-]+\/notes\/[a-z0-9-]+/.test(pathname);
  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="AI 에게 묻기 (⌘/)"
          className="ask-launcher fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-accent/40 bg-accent px-4 py-2.5 text-sm font-medium text-accent-contrast shadow-lg shadow-black/40 transition-all hover:bg-accent/90"
        >
          <span>✦</span>
          <span className="hidden sm:inline">AI 에게 묻기</span>
          <kbd className="hidden rounded bg-white/20 px-1 text-[10px] sm:inline">⌘/</kbd>
        </button>
      )}
      {open && (
        <aside className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[420px] flex-col border-l border-border bg-surface shadow-2xl shadow-black/50" role="dialog" aria-label="AI 에게 묻기">
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <span className="text-accent">✦</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">AI 에게 묻기</div>
              <div className="truncate text-[11px] text-muted">{isNote ? "이 노트 본문을 읽고 답합니다" : "이 사이트의 노트·실험을 근거로 답합니다"}{cfg?.model ? ` · ${cfg.model}` : ""}</div>
            </div>
            {messages.length > 0 && (
              <button onClick={() => setMessages([])} className="text-[11px] text-muted hover:text-foreground">
                지우기
              </button>
            )}
            <button onClick={() => setOpen(false)} className="rounded px-1.5 text-muted hover:text-foreground" aria-label="닫기">
              ✕
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {cfg && !cfg.configured && (
              <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-[13px] leading-relaxed">
                <div className="font-semibold text-warn">OPENAI_API_KEY 가 없습니다</div>
                <p className="mt-1 text-muted">개발 서버를 키와 함께 실행하세요. OpenAI 호환 로컬 모델(Ollama)도 됩니다.</p>
                <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-[11px]">{`OPENAI_API_KEY=sk-... pnpm dev
# 또는 Ollama
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen2.5:0.5b pnpm dev`}</pre>
              </div>
            )}
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-[13px] text-muted">{isNote ? "읽다가 막히는 부분을 바로 물어보세요. 본문을 드래그하면 그 부분을 컨텍스트로 넣습니다." : "무엇이든 물어보세요. 노트를 검색해 근거와 함께 답합니다."}</p>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK.map((q) => (
                    <button key={q} onClick={() => send(q)} disabled={busy || !cfg?.configured} className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[12px] text-muted hover:border-muted hover:text-foreground disabled:opacity-50">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`mb-3 ${m.role === "user" ? "flex justify-end" : ""}`}>
                {m.role === "user" ? (
                  <div className="max-w-[90%] rounded-2xl rounded-br-sm bg-accent-soft px-3.5 py-2 text-[13.5px] leading-relaxed">{m.content}</div>
                ) : (
                  <div className="rounded-2xl rounded-bl-sm border border-border bg-background px-3.5 py-2.5">
                    {m.tools && m.tools.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap gap-1 text-[11px] text-muted">
                        {m.tools.map((t, j) => (
                          <span key={j} className={`rounded border px-1.5 py-0.5 ${t.isError ? "border-accent/40 text-accent" : "border-border"}`}>
                            {t.name}
                            {t.ms !== undefined ? ` ${t.ms}ms` : " …"}
                          </span>
                        ))}
                      </div>
                    )}
                    {m.content ? <Markdown content={m.content} small /> : !m.error ? <span className="text-[13px] text-muted">생각 중…</span> : null}
                    {m.tools?.filter((t) => t.proposal).map((t, j) => (
                      <div key={j} className="mt-2 rounded-lg border border-accent/30 bg-accent-soft/40 p-2.5 text-[12.5px]">
                        <div className="font-medium text-accent">⚗ 실험 제안: {t.proposal!.title}</div>
                        <div className="mt-0.5 text-muted">{t.proposal!.reason}</div>
                        <Link href={t.proposal!.href} className="mt-1.5 inline-block rounded bg-accent px-2 py-1 text-[12px] text-accent-contrast hover:bg-accent/90">
                          실험실에서 열기 →
                        </Link>
                      </div>
                    ))}
                    {m.error && <div className="mt-1 text-[12px] text-accent">오류: {m.error}</div>}
                    {(m.sources?.length || /사이트 밖 내용/.test(m.content)) && m.content ? (
                      <div className="mt-2 border-t border-border pt-2">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                          <span>근거로 쓴 노트</span>
                          {/사이트 밖 내용/.test(m.content) && <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-warn">사이트 밖 내용 포함</span>}
                        </div>
                        <ul className="space-y-0.5">
                          {(m.sources ?? []).map((src) => (
                            <li key={src.href} className="truncate text-[12px]">
                              <Link href={src.href} className="text-info hover:underline">
                                {src.kind === "current" ? "📖 " : ""}
                                {src.title}
                              </Link>
                              <span className="ml-1 text-muted">· {src.subject}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {m.usage && (
                      <div className="mt-1.5 text-[10.5px] text-muted">
                        {m.usage.input + m.usage.output} 토큰 · ${m.usage.costUsd.toFixed(4)} · {m.usage.totalMs}ms{m.usage.toolCalls ? ` · 툴 ${m.usage.toolCalls}회` : ""}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={bottom} />
          </div>

          <form
            className="border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            {selection && (
              <label className="mb-2 flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-[11.5px] text-muted">
                <input type="checkbox" checked={useSelection} onChange={(e) => setUseSelection(e.target.checked)} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  선택한 텍스트를 함께 보냄: <span className="line-clamp-2 text-foreground/80">“{selection}”</span>
                </span>
                <button type="button" onClick={() => setSelection("")} className="hover:text-foreground">✕</button>
              </label>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={2}
                placeholder={cfg?.configured ? "질문을 입력… (Enter 전송, Shift+Enter 줄바꿈)" : "OPENAI_API_KEY 설정 후 사용할 수 있습니다"}
                disabled={!cfg?.configured}
                className="min-h-[44px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-[13.5px] outline-none focus:border-muted disabled:opacity-60"
              />
              {busy ? (
                <button type="button" onClick={() => abort.current?.abort()} className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-foreground">
                  중단
                </button>
              ) : (
                <button type="submit" disabled={!input.trim() || !cfg?.configured} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-contrast hover:bg-accent/90 disabled:opacity-50">
                  보내기
                </button>
              )}
            </div>
          </form>
        </aside>
      )}
    </>
  );
}
