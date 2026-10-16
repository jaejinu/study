"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paletteSearchAction, type PaletteHit } from "@/actions/search";
import { subjects } from "@/lib/subjects";

type Item = { kind: "page" | "subject" | PaletteHit["kind"]; title: string; href: string; hint?: string; subject?: string };

const PAGES: Item[] = [
  { kind: "page", title: "주제 선택 (홈)", href: "/", hint: "모든 트랙과 주제" },
  { kind: "page", title: "오늘의 복습", href: "/review", hint: "모든 주제의 기한 카드 + 새 카드 (FSRS)" },
  { kind: "page", title: "AI 학습 모드", href: "/practice", hint: "설명해 보기 · 면접 연습 · 모델 비교" },
  { kind: "page", title: "장애 대응 훈련", href: "/drills", hint: "진짜 고장을 고치고 MTTR 기록 · 종합 과제(/capstone)" },
  { kind: "page", title: "학습 경로", href: "/path", hint: "트랙별 추천 순서·선수 주제" },
  { kind: "page", title: "약점 지도", href: "/mastery", hint: "주제·레벨별 숙련도와 다음에 공부할 것" },
  { kind: "page", title: "내 메모", href: "/memos", hint: "노트에 남긴 메모·하이라이트" },
  { kind: "page", title: "학습 기록·백업", href: "/records", hint: "내보내기·가져오기" },
  { kind: "page", title: "AI 도우미", href: "/assistant", hint: "노트 검색·실험 제안" },
  { kind: "page", title: "용어집", href: "/glossary" },
  { kind: "page", title: "링크 그래프", href: "/graph" },
  { kind: "page", title: "전체 검색", href: "/search" },
];

/** 스니펫의 마크다운 기호(** ` # | > [](...))를 걷어내 한 줄 요약으로 */
function plain(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`#>|_]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function openPalette() {
  window.dispatchEvent(new Event("study:palette"));
}

const KIND_LABEL: Record<Item["kind"], string> = { page: "이동", subject: "주제", note: "노트", lab: "실험", term: "용어" };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // 결과는 어떤 질의에 대한 것인지와 함께 보관 → 입력이 바뀌면 이전 결과는 자동으로 무시된다
  const [result, setResult] = useState<{ q: string; hits: PaletteHit[] } | null>(null);
  const [cursor, setCursor] = useState(0);
  const router = useRouter();
  const seq = useRef(0);

  const show = useCallback(() => {
    setQ("");
    setResult(null);
    setCursor(0);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) setOpen(false);
        else show();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("study:palette", show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("study:palette", show);
    };
  }, [open, show]);

  const query = q.trim();
  useEffect(() => {
    if (!open || query.length < 2) return;
    const my = ++seq.current;
    const t = setTimeout(async () => {
      const r = await paletteSearchAction(query).catch(() => []);
      if (my === seq.current) setResult({ q: query, hits: r });
    }, 180);
    return () => clearTimeout(t);
  }, [query, open]);
  const hits = useMemo(() => (query.length >= 2 && result?.q === query ? result.hits : []), [query, result]);
  const loading = query.length >= 2 && result?.q !== query;

  const items = useMemo<Item[]>(() => {
    const lower = q.trim().toLowerCase();
    const subj = subjects
      .filter((s) => !lower || s.name.toLowerCase().includes(lower) || s.id.includes(lower) || s.tagline.toLowerCase().includes(lower))
      .slice(0, lower ? 4 : 8)
      .map<Item>((s) => ({ kind: "subject", title: s.name, href: `/${s.id}`, hint: s.tagline, subject: s.id }));
    const pages = PAGES.filter((p) => !lower || p.title.toLowerCase().includes(lower));
    const remote = hits.map<Item>((h) => ({ kind: h.kind, title: h.title, href: h.href, hint: h.snippet, subject: h.subject }));
    return [...remote, ...subj, ...pages];
  }, [q, hits]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-[2px]" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="빠른 이동">
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/50" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <span className="text-muted">⌕</span>
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(items.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const it = items[cursor];
                if (it) go(it.href);
                else if (q.trim()) go(`/search?q=${encodeURIComponent(q.trim())}`);
              }
            }}
            placeholder="노트 · 실험 · 용어 · 주제 검색…  (↑↓ 이동, Enter 열기, Esc 닫기)"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
            aria-label="검색어"
          />
          {loading && <span className="text-xs text-muted">검색 중…</span>}
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] text-muted sm:inline">Esc</kbd>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto py-1" role="listbox">
          {items.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted">{q.trim().length < 2 ? "두 글자 이상 입력하면 노트·실험·용어를 찾습니다." : loading ? "찾는 중…" : "결과가 없습니다. Enter 로 전체 검색을 열 수 있습니다."}</li>
          )}
          {items.map((it, i) => {
            const s = it.subject ? subjects.find((x) => x.id === it.subject) : undefined;
            return (
              <li key={`${it.kind}-${it.href}-${i}`} role="option" aria-selected={i === cursor}>
                <Link
                  href={it.href}
                  onClick={(e) => {
                    e.preventDefault();
                    go(it.href);
                  }}
                  onMouseEnter={() => setCursor(i)}
                  className={`flex items-start gap-3 px-4 py-2 text-sm ${i === cursor ? "bg-accent-soft" : ""}`}
                >
                  <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-[10px] font-bold text-white ${s?.color ?? "bg-surface-2"}`}>{s?.mark ?? "·"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{it.title}</span>
                    {it.hint && <span className="clamp-1 text-xs text-muted">{plain(it.hint)}</span>}
                  </span>
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">{KIND_LABEL[it.kind]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-between border-t border-border px-4 py-1.5 text-[11px] text-muted">
          <span>⌘K / Ctrl+K 로 어디서나 열기</span>
          <span>{items.length > 0 && `${cursor + 1} / ${items.length}`}</span>
        </div>
      </div>
    </div>
  );
}
