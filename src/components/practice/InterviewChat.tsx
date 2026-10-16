"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui";

type Msg = { role: "user" | "assistant"; content: string };
const LEVELS = ["기초", "중급", "심화"] as const;
const MAX_TURNS = 5;

export function InterviewChat({ subject, subjectName, configured }: { subject: string; subjectName: string; configured: boolean }) {
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("중급");
  const [seed, setSeed] = useState(1);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [summary, setSummary] = useState("");
  const [notes, setNotes] = useState<{ title: string; href: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const answers = messages.filter((m) => m.role === "user").length;
  const started = messages.length > 0;

  const call = async (action: "start" | "answer" | "finish", history: Msg[], useSeed: number) => {
    setBusy(true);
    setErr("");
    const isFinish = action === "finish";
    if (!isFinish) setMessages([...history, { role: "assistant", content: "" }]);
    try {
      const res = await fetch("/api/practice/interview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, level, seed: useSeed, action, messages: history }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: res.statusText }));
        setErr(j.error ?? "요청 실패");
        if (!isFinish) setMessages(history);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          const ev = JSON.parse(p.slice(6)) as { type: string; text?: string; notes?: { title: string; href: string }[]; message?: string };
          if (ev.type === "meta" && ev.notes) setNotes(ev.notes);
          else if (ev.type === "text") {
            acc += ev.text ?? "";
            if (isFinish) setSummary(acc);
            else setMessages([...history, { role: "assistant", content: acc }]);
          } else if (ev.type === "error") setErr(ev.message ?? "오류");
        }
        bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    const s = Math.floor(Math.random() * 1_000_000) + 1;
    setSeed(s);
    setSummary("");
    void call("start", [], s);
  };
  const answer = () => {
    if (!input.trim()) return;
    const h: Msg[] = [...messages, { role: "user", content: input.trim() }];
    setInput("");
    void call("answer", h, seed);
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">난이도</span>
        {LEVELS.map((l) => (
          <button key={l} onClick={() => setLevel(l)} disabled={started && !summary} className={`rounded border px-2.5 py-1 ${level === l ? "border-accent bg-accent-soft text-foreground" : "border-border text-muted hover:text-foreground"} disabled:opacity-60`}>
            {l}
          </button>
        ))}
        <Button className="ml-auto" onClick={start} disabled={!configured || busy}>
          {started ? "새 면접 시작" : "면접 시작"}
        </Button>
      </div>
      {!configured && <p className="mb-3 text-sm text-warn">OPENAI_API_KEY 가 없어 면접 모드를 쓸 수 없습니다. 로컬 모델(Ollama)로도 됩니다.</p>}

      <div className="space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            {m.role === "user" ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent-soft px-3.5 py-2 text-[14px] leading-relaxed">{m.content}</div>
            ) : (
              <div className="rounded-2xl rounded-bl-sm border border-border bg-surface px-4 py-3">
                <div className="mb-1 text-[11px] text-muted">면접관 · {subjectName} · {level}</div>
                {m.content ? <Markdown content={m.content} small /> : <span className="text-[13px] text-muted">생각 중…</span>}
              </div>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {started && !summary && (
        <div className="mt-4">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) answer(); }} rows={4} disabled={busy} placeholder="답변을 입력… (⌘Enter 로 전송)" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px] outline-none focus:border-muted" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={answer} disabled={busy || !input.trim() || answers >= MAX_TURNS}>
              답변 보내기
            </Button>
            <Button variant="ghost" onClick={() => void call("finish", messages, seed)} disabled={busy || answers === 0}>
              면접 마치고 요약 받기
            </Button>
            <span className="text-[12px] text-muted">
              답변 {answers}/{MAX_TURNS}
              {answers >= MAX_TURNS ? " — 이제 요약을 받아 보세요" : ""}
            </span>
          </div>
        </div>
      )}
      {err && <p className="mt-2 text-[13px] text-accent">오류: {err}</p>}

      {summary && (
        <div className="mt-5 rounded-xl border border-ok/30 bg-surface p-5">
          <div className="mb-2 font-semibold">면접 요약</div>
          <Markdown content={summary} small />
          {notes.length > 0 && (
            <div className="mt-3 border-t border-border pt-3 text-[13px]">
              <div className="mb-1 text-muted">다시 볼 노트 (이번 면접의 근거)</div>
              <ul className="space-y-0.5">
                {notes.map((n) => (
                  <li key={n.href}>
                    <Link href={n.href} className="text-info hover:underline">
                      {n.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
