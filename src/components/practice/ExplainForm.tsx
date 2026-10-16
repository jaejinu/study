"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui";
import type { Feedback } from "@/lib/practice/core";

type Grounded = Feedback & { modelScore?: number; coverage?: number; droppedWrong?: number; unverified?: { claim: string; evidence: string }[] };
type History = { at: number; score: number; section?: string }[];
type Result = { feedback: Grounded | null; raw?: string; concepts: string[]; attempts: number; ms: number; model: string; history: History };

function ScoreBars({ history }: { history: History }) {
  if (history.length === 0) return null;
  const rows = [...history].reverse();
  return (
    <div className="mt-4">
      <div className="mb-1 text-[12px] text-muted">이 노트의 설명 점수 추이 (최근 {rows.length}회)</div>
      <div className="flex h-16 items-end gap-1" role="img" aria-label="설명 점수 추이">
        {rows.map((h) => (
          <div key={h.at} title={`${new Date(h.at).toLocaleString("ko-KR")} · ${h.score}점${h.section ? ` · ${h.section}` : ""}`} className={`flex flex-1 items-start justify-center rounded-t text-[10px] text-white ${h.score >= 70 ? "bg-ok/70" : h.score >= 40 ? "bg-warn/70" : "bg-accent/70"}`} style={{ height: `${Math.max(14, h.score)}%` }}>
            {h.score}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExplainForm({ subject, slug, noteTitle, sections, initialHistory, configured }: { subject: string; slug: string; noteTitle: string; sections: { id: string; title: string }[]; initialHistory: History; configured: boolean }) {
  const [section, setSection] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const history = res?.history ?? initialHistory;
  const target = section ? sections.find((s) => s.id === section)?.title : noteTitle;

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/practice/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, slug, section: section || undefined, explanation: text }) });
      const j = await r.json();
      if (!r.ok) setErr(j.error ?? "요청 실패");
      else setRes(j as Result);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fb = res?.feedback;
  return (
    <div>
      <label className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">설명할 범위</span>
        <select value={section} onChange={(e) => setSection(e.target.value)} className="max-w-full rounded border border-border bg-background px-2 py-1">
          <option value="">노트 전체 — {noteTitle}</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              섹션 · {s.title}
            </option>
          ))}
        </select>
      </label>
      <p className="mb-2 text-[13.5px] text-muted">
        <b className="text-foreground">{target}</b> 을(를) 이 주제를 처음 듣는 동료에게 설명한다고 생각하고, 노트를 보지 말고 내 말로 써 보세요. 예시와 &ldquo;왜 그런지&rdquo; 가 들어가면 좋습니다.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} disabled={!configured || busy} placeholder={configured ? "예: 파이프라인은 … 왜냐하면 … 예를 들어 …" : "OPENAI_API_KEY 설정 후 사용할 수 있습니다"} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px] leading-relaxed outline-none focus:border-muted" />
      <div className="mt-2 flex items-center gap-3">
        <Button onClick={submit} disabled={!configured || busy || text.trim().length < 20}>
          {busy ? "채점 중…" : "피드백 받기"}
        </Button>
        <span className="text-[12px] text-muted">{text.trim().length}자 · 20자 이상</span>
        {err && <span className="text-[13px] text-accent">{err}</span>}
      </div>

      {res && !fb && (
        <div className="mt-5 rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm">
          <div className="mb-1 font-medium text-warn">모델이 형식에 맞는 피드백을 주지 못했습니다 (재시도 {res.attempts - 1}회). 원문을 그대로 보여 드립니다.</div>
          <pre className="whitespace-pre-wrap text-[13px]">{res.raw}</pre>
        </div>
      )}

      {fb && (
        <div className="mt-5 space-y-3 rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className={`text-3xl font-bold ${fb.score >= 70 ? "text-ok" : fb.score >= 40 ? "text-warn" : "text-accent"}`}>{fb.score}점</span>
            <span className="text-[12.5px] text-muted">
              핵심 개념 포함 {Math.round((fb.coverage ?? 0) * 100)}% · 모델 점수 {fb.modelScore ?? "-"} · {res.model} · {(res.ms / 1000).toFixed(1)}초
            </span>
          </div>
          {fb.summary && <p className="text-[14px]">{fb.summary}</p>}
          <div>
            <div className="mb-1 text-[12px] text-muted">다룬 개념</div>
            <div className="flex flex-wrap gap-1.5">
              {fb.covered.length ? fb.covered.map((c) => <span key={c} className="rounded border border-ok/40 bg-ok/10 px-2 py-0.5 text-[12.5px] text-ok">✓ {c}</span>) : <span className="text-[13px] text-muted">없음</span>}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[12px] text-muted">빠진 개념 — 노트에서 다시 보세요</div>
            <div className="flex flex-wrap gap-1.5">
              {fb.missing.length ? fb.missing.map((c) => <span key={c} className="rounded border border-warn/40 bg-warn/10 px-2 py-0.5 text-[12.5px] text-warn">{c}</span>) : <span className="text-[13px] text-ok">모두 다뤘습니다</span>}
            </div>
          </div>
          {fb.wrong.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] text-muted">노트와 다른 주장</div>
              <ul className="space-y-2">
                {fb.wrong.map((w, i) => (
                  <li key={i} className="rounded border border-accent/30 bg-accent-soft/40 p-2.5 text-[13px]">
                    <div>✗ {w.claim}</div>
                    <div className="mt-1 text-muted">노트: &ldquo;{w.evidence}&rdquo;</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(fb.unverified?.length ?? 0) > 0 && (
            <div>
              <div className="mb-1 text-[12px] text-muted">확인 필요 — 모델이 지적했지만 근거를 대지 못한 주장 (감점 없음). 노트의 가장 가까운 문장과 직접 비교해 보세요</div>
              <ul className="space-y-2">
                {fb.unverified!.map((w, i) => (
                  <li key={i} className="rounded border border-border bg-background p-2.5 text-[13px]">
                    <div>? {w.claim}</div>
                    <div className="mt-1 text-muted">노트: &ldquo;{w.evidence}&rdquo;</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(fb.droppedWrong ?? 0) > 0 && <p className="text-[11.5px] text-muted">노트 인용으로 근거가 확인되지 않은 지적 {fb.droppedWrong}건은 점수에 반영하지 않았습니다.</p>}
          {fb.followup.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] text-muted">다음에 스스로 답해 볼 질문</div>
              <ul className="list-disc pl-5 text-[13.5px]">
                {fb.followup.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex gap-3 pt-1 text-[13px]">
            <Link href={`/${subject}/notes/${slug}`} className="text-info hover:underline">
              노트 다시 보기 →
            </Link>
            <Link href={`/practice/interview?subject=${subject}`} className="text-info hover:underline">
              이 주제로 면접 연습 →
            </Link>
          </div>
        </div>
      )}
      <ScoreBars history={history} />
    </div>
  );
}
