"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 코드 블록: 언어 라벨 + 복사 버튼 */
export function CodeBlock({ lang, children, ...rest }: { lang?: string; children: ReactNode } & React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = ref.current?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* 클립보드 권한 없음 */
    }
  };
  return (
    <div className="code-block group relative">
      <div className="code-toolbar">
        {lang && <span className="code-lang">{lang}</span>}
        <button type="button" onClick={copy} className="code-copy" aria-label="코드 복사">
          {copied ? "✓ 복사됨" : "복사"}
        </button>
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  );
}

/** 표: 넘치면 '옆으로 스크롤' 힌트와 오른쪽 그라데이션을 보여 준다 */
export function TableWrap({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ overflow: boolean; atEnd: boolean }>({ overflow: false, atEnd: true });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setState({ overflow: el.scrollWidth > el.clientWidth + 2, atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, []);
  return (
    <div className="table-outer">
      {state.overflow && <div className="table-hint">{state.atEnd ? "← 표 처음으로 스크롤" : "옆으로 스크롤해 더 보기 →"}</div>}
      <div className={`table-wrap ${state.overflow && !state.atEnd ? "is-clipped" : ""}`} ref={ref} tabIndex={state.overflow ? 0 : undefined} role={state.overflow ? "region" : undefined} aria-label={state.overflow ? "가로로 스크롤되는 표" : undefined}>
        <table>{children}</table>
      </div>
    </div>
  );
}

/** 이미지(다이어그램) 클릭 → 화면 가득 확대, Esc·바깥 클릭으로 닫기 */
export function ZoomImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!src) return null;
  return (
    <>
      <button type="button" className="zoom-trigger" onClick={() => setOpen(true)} aria-label={`${alt || "그림"} 크게 보기`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- 노트 본문 이미지(정적 SVG)는 원본 크기로 */}
        <img src={src} alt={alt ?? ""} loading="lazy" />
        <span className="zoom-hint" aria-hidden>
          ⤢ 크게 보기
        </span>
      </button>
      {alt && <span className="figure-caption">{alt}</span>}
      {open &&
        // 이미지는 마크다운의 <p> 안에 있으므로 오버레이는 body 로 포털 (p 안에 div 금지)
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={alt || "그림 확대"} onClick={() => setOpen(false)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 확대 보기 */}
            <img src={src} alt={alt ?? ""} className="max-h-[92vh] max-w-[96vw] rounded-lg border border-border bg-[#0d1117] object-contain" />
            <button type="button" className="absolute right-4 top-4 rounded-md bg-surface px-3 py-1.5 text-sm" onClick={() => setOpen(false)} autoFocus>
              닫기 (Esc)
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/** 상단 읽기 진행 막대: 상단 바의 #reading-progress-slot 에 포털로 그린다 (사이드바를 가로지르지 않게) */
export function ReadingProgress() {
  const [pct, setPct] = useState(0);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // 슬롯은 레이아웃(상단 바)에 있으므로 마운트 후 한 번 찾는다
    const t = requestAnimationFrame(() => setSlot(document.getElementById("reading-progress-slot")));
    return () => cancelAnimationFrame(t);
  }, []);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = document.documentElement;
        const max = h.scrollHeight - h.clientHeight;
        setPct(max > 0 ? Math.min(100, Math.max(0, (h.scrollTop / max) * 100)) : 0);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  if (!slot) return null;
  return createPortal(<div className="h-full bg-accent transition-[width] duration-75" style={{ width: `${pct}%` }} />, slot);
}
