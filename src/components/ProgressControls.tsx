"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toggleCheckAction, toggleReadAction } from "@/actions/progress";
import { Button } from "./ui";

export function ReadToggle({ subject, slug, initial }: { subject: string; slug: string; initial: boolean }) {
  const [read, setRead] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant={read ? "ghost" : "primary"}
        className="px-3 py-1 text-xs"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await toggleReadAction(subject, slug, !read);
            if (r.ok) {
              setRead(!read);
              setErr(null);
              router.refresh();
            } else setErr(r.error ?? "실패");
          })
        }
      >
        {read ? "✓ 읽음 (취소)" : "읽음으로 표시"}
      </Button>
      {err && <span className="text-xs text-accent">{err} (Redis 가 켜져 있어야 저장됩니다)</span>}
    </span>
  );
}

export function TaskCheckbox({ subject, slug, line, initial, label }: { subject: string; slug: string; line: number; initial: boolean; label?: string }) {
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();
  return (
    <input
      type="checkbox"
      aria-label={label ? `체크리스트: ${label}` : "체크리스트 항목"}
      checked={on}
      disabled={pending}
      onChange={() =>
        start(async () => {
          const r = await toggleCheckAction(subject, slug, line, !on);
          if (r.ok) setOn(!on);
        })
      }
      className="mr-1.5 h-4 w-4 cursor-pointer accent-[var(--ok)] align-middle"
    />
  );
}
