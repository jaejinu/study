"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export function RecordsActions() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [msg, setMsg] = useState("");
  const upload = async (file: File) => {
    setMsg("가져오는 중…");
    try {
      const res = await fetch(`/api/backup?mode=${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      const j = (await res.json()) as { ok: boolean; keys?: number; error?: string };
      setMsg(j.ok ? `가져오기 완료: 키 ${j.keys}개 (${mode === "merge" ? "합치기" : "덮어쓰기"})` : `실패: ${j.error}`);
      router.refresh();
    } catch (e) {
      setMsg(`실패: ${(e as Error).message}`);
    }
  };
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-sm">
      <button onClick={() => (window.location.href = "/api/backup")} className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-contrast hover:bg-accent/90">
        JSON 으로 내보내기
      </button>
      <label className="flex items-center gap-1.5 text-muted">
        <select value={mode} onChange={(e) => setMode(e.target.value as "merge" | "replace")} className="rounded border border-border bg-background px-2 py-1">
          <option value="merge">합치기 (기존 기록 유지)</option>
          <option value="replace">덮어쓰기 (백업으로 교체)</option>
        </select>
      </label>
      <button onClick={() => input.current?.click()} className="rounded-md border border-border px-3 py-1.5 hover:border-muted">
        백업 파일 가져오기
      </button>
      <input ref={input} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      {msg && <span className="text-muted">{msg}</span>}
    </div>
  );
}
