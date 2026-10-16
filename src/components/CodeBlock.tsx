"use client";
import { useRef, useState, type ReactNode } from "react";
export function CodeBlock({ children, lang }: { children: ReactNode; lang?: string }) {
  const ref = useRef<HTMLPreElement>(null),
    [status, setStatus] = useState("복사");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.textContent ?? "");
      setStatus("복사됨");
    } catch {
      setStatus("복사 실패");
    }
  };
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{lang ?? "CODE"}</span>
        <button type="button" onClick={copy} aria-live="polite">
          {status}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}
