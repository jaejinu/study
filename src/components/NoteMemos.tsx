"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { addMemoAction, deleteMemoAction } from "@/actions/memos";
import type { Memo } from "@/lib/memos";

/** 본문 텍스트 노드에서 quote 의 첫 출현을 <mark> 로 감싼다 (여러 노드에 걸치면 첫 노드 안의 앞부분만) */
function highlight(root: HTMLElement, memo: Memo) {
  const q = memo.quote.trim();
  if (!q || root.querySelector(`mark[data-memo="${memo.id}"]`)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const probe = q.slice(0, 60);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent ?? "";
    const i = t.indexOf(probe);
    if (i < 0 || (n.parentElement && n.parentElement.closest("pre, mark"))) continue;
    const range = document.createRange();
    range.setStart(n, i);
    range.setEnd(n, Math.min(t.length, i + q.length));
    const mark = document.createElement("mark");
    mark.dataset.memo = memo.id;
    mark.className = "memo-mark";
    mark.title = memo.text || "하이라이트";
    try {
      range.surroundContents(mark);
    } catch {
      /* 요소 경계를 가로지르면 건너뛴다 */
    }
    return;
  }
}

export function NoteMemos({ subject, slug, initial }: { subject: string; slug: string; initial: Memo[] }) {
  const [memos, setMemos] = useState<Memo[]>(initial);
  const [sel, setSel] = useState<{ quote: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ quote: string } | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const root = () => document.querySelector<HTMLElement>("article .note");

  useEffect(() => {
    const r = root();
    if (r) memos.forEach((m) => highlight(r, m));
  }, [memos]);

  useEffect(() => {
    const onUp = () => {
      const s = window.getSelection();
      const r = root();
      if (!s || s.isCollapsed || !r || !s.anchorNode || !r.contains(s.anchorNode)) return setSel(null);
      const quote = s.toString().trim();
      if (quote.length < 4) return setSel(null);
      const rect = s.getRangeAt(0).getBoundingClientRect();
      setSel({ quote: quote.slice(0, 500), x: rect.left + rect.width / 2, y: rect.top + window.scrollY - 40 });
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
    };
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    const r = await addMemoAction(subject, slug, draft.quote, text);
    if (r.ok && r.memo) {
      setMemos((ms) => [...ms, r.memo!]);
      setDraft(null);
      setText("");
      setErr("");
    } else setErr(r.error ?? "저장 실패 (Redis 가 켜져 있어야 합니다)");
  }, [draft, subject, slug, text]);

  const remove = async (m: Memo) => {
    if ((await deleteMemoAction(subject, slug, m.id)).ok) {
      document.querySelectorAll(`mark[data-memo="${m.id}"]`).forEach((el) => el.replaceWith(...Array.from(el.childNodes)));
      setMemos((ms) => ms.filter((x) => x.id !== m.id));
    }
  };

  return (
    <>
      {sel && !draft && (
        <button
          style={{ position: "absolute", left: sel.x, top: sel.y, transform: "translateX(-50%)" }}
          className="z-30 rounded-md border border-border bg-surface px-2.5 py-1 text-[12.5px] shadow-lg hover:border-muted"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setDraft({ quote: sel.quote });
            setSel(null);
            setTimeout(() => box.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
          }}
        >
          ✎ 메모·하이라이트
        </button>
      )}
      <section ref={box} className="mt-10">
        <h2 className="mb-2 text-sm font-semibold">
          내 메모 <span className="text-muted">({memos.length})</span>
        </h2>
        {draft && (
          <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 p-3">
            <blockquote className="mb-2 border-l-2 border-warn pl-2 text-[13px] text-muted">“{draft.quote}”</blockquote>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="내 말로 정리하거나 질문을 적어 두세요 (비워 두면 하이라이트만)" className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13.5px] outline-none focus:border-muted" autoFocus />
            <div className="mt-2 flex items-center gap-2">
              <button onClick={save} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-contrast hover:bg-accent/90">저장</button>
              <button onClick={() => setDraft(null)} className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-muted">취소</button>
              {err && <span className="text-[12px] text-accent">{err}</span>}
            </div>
          </div>
        )}
        {memos.length === 0 && !draft ? (
          <p className="text-[13px] text-muted">본문에서 문장을 드래그하면 메모와 하이라이트를 남길 수 있습니다. 모든 메모는 <Link href="/memos" className="text-info hover:underline">내 메모 모아 보기</Link>에서 볼 수 있습니다.</p>
        ) : (
          <ul className="space-y-2">
            {memos.map((m) => (
              <li key={m.id} className="rounded-lg border border-border bg-surface px-3 py-2 text-[13.5px]">
                {m.quote && <div className="mb-1 border-l-2 border-warn pl-2 text-[12.5px] text-muted">“{m.quote.length > 160 ? `${m.quote.slice(0, 160)}…` : m.quote}”</div>}
                {m.text && <div className="whitespace-pre-wrap">{m.text}</div>}
                <div className="mt-1 flex text-[11px] text-muted">
                  {new Date(m.at).toLocaleString("ko-KR")}
                  <button onClick={() => remove(m)} className="ml-auto hover:text-accent">삭제</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
