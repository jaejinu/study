"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { restartCapstoneAction, savePostmortemAction, verifyStepAction } from "@/app/capstone/actions";
import { Button } from "@/components/ui";
import { ReadOnlyHint, useReadOnly } from "../ReadOnly";

export interface StepView {
  id: string;
  title: string;
  goal: string;
  actions: string[];
  notes: { href: string; title: string }[];
  experiments: { href: string; title: string }[];
  input?: "postmortem";
  last: { ok: boolean; at: number; detail: string } | null;
}

const TEMPLATE = `## 영향
- 

## 타임라인 (KST)
- 00:00 장애 시작 (무엇이)
- 00:00 알림 수신 (어떤 알림)
- 00:00 원인 파악
- 00:00 복구

## 원인
- 

## 조치 (재발 방지)
- 
`;

function Step({ projectId, step, postmortem }: { projectId: string; step: StepView; postmortem: string }) {
  const { readOnly } = useReadOnly();
  const [last, setLast] = useState(step.last);
  const [pending, start] = useTransition();
  const [text, setText] = useState(postmortem || TEMPLATE);
  const [saved, setSaved] = useState(false);
  const verify = () =>
    start(async () => {
      if (step.input === "postmortem") await savePostmortemAction(projectId, text);
      const r = await verifyStepAction(projectId, step.id);
      setLast({ ...r, at: Date.now() });
    });
  return (
    <li className={`rounded-lg border bg-surface p-4 ${last?.ok ? "border-ok/50" : "border-border"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <span className={`mt-0.5 ${last?.ok ? "text-ok" : last ? "text-danger" : "text-muted"}`} aria-hidden>
          {last?.ok ? "✓" : last ? "✗" : "○"}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{step.title}</h2>
          <p className="mt-0.5 text-sm text-muted">{step.goal}</p>
        </div>
        {!readOnly && (
          <Button onClick={verify} disabled={pending} variant={last?.ok ? "ghost" : "primary"} data-step={step.id}>
            {pending ? "검증 중…" : "검증"}
          </Button>
        )}
      </div>
      <pre className="mt-3 overflow-x-auto rounded bg-background p-3 text-[12.5px] leading-relaxed">{step.actions.join("\n")}</pre>
      {step.input === "postmortem" && !readOnly && (
        <div className="mt-3">
          <textarea
            aria-label="포스트모템 본문"
            className="h-64 w-full rounded border border-border bg-background p-3 font-mono text-[12.5px]"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
          />
          <div className="mt-1 flex items-center gap-2 text-xs text-muted">
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await savePostmortemAction(projectId, text);
                  setSaved(true);
                })
              }
            >
              저장
            </Button>
            <span>{text.length}자 {saved && "· 저장됨"}</span>
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {step.notes.map((n) => (
          <Link key={n.href} href={n.href} className="text-info hover:underline">
            📖 {n.title}
          </Link>
        ))}
        {step.experiments.map((e) => (
          <Link key={e.href} href={e.href} className="text-accent hover:underline">
            ⚗ {e.title.length > 40 ? `${e.title.slice(0, 40)}…` : e.title}
          </Link>
        ))}
      </div>
      {last && (
        <p className={`mt-3 text-sm ${last.ok ? "text-ok" : "text-danger"}`} role="status">
          {last.ok ? "통과" : "미통과"} — {last.detail} <span className="text-xs text-muted">({new Date(last.at).toLocaleTimeString("ko-KR")})</span>
        </p>
      )}
    </li>
  );
}

export function CapstoneSteps({ projectId, steps, startedAt, baseline, postmortem }: { projectId: string; steps: StepView[]; startedAt: number | null; baseline: Record<string, string>; postmortem: string }) {
  const [pending, start] = useTransition();
  const { readOnly } = useReadOnly();
  const done = steps.filter((s) => s.last?.ok).length;
  return (
    <div className="mt-5">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <span>
          진행 <b>{done}</b> / {steps.length}
        </span>
        <span className="text-xs text-muted">
          {startedAt ? `시작 ${new Date(startedAt).toLocaleString("ko-KR")}` : "아직 시작 전 — 첫 검증 때 시작 시각과 기준 스냅샷을 잡는다"}
          {Object.keys(baseline).length > 0 && ` · 기준 ${Object.entries(baseline).map(([k, v]) => `${k}=${v}`).join(" ")}`}
        </span>
        {!readOnly && (
          <Button variant="ghost" className="ml-auto" disabled={pending} onClick={() => start(async () => void (await restartCapstoneAction(projectId), location.reload()))}>
            처음부터 다시
          </Button>
        )}
      </div>
      <ReadOnlyHint className="mb-3">읽기 전용 공개판에서는 단계 검증(클러스터·Prometheus 조회)을 실행하지 않습니다. 각 단계의 조치와 연결된 노트·실험을 읽고, 검증은 로컬에서 하세요.</ReadOnlyHint>
      <ol className="space-y-3">
        {steps.map((s) => (
          <Step key={s.id} projectId={projectId} step={s} postmortem={postmortem} />
        ))}
      </ol>
    </div>
  );
}
