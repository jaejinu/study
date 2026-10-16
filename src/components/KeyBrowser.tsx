"use client";

import { useEffect, useState, useTransition } from "react";
import { deleteKeyAction, inspectKeyAction, scanKeysAction, type KeyInfo, type KeyValue } from "@/actions/keys";
import { Badge, Button } from "./ui";

const TYPE_TONE: Record<string, "ok" | "info" | "warn" | "accent" | "muted"> = {
  string: "ok",
  hash: "info",
  list: "warn",
  set: "accent",
  zset: "accent",
  stream: "info",
};

export function KeyBrowser() {
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [cursor, setCursor] = useState("0");
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<KeyValue | null>(null);
  const [pending, start] = useTransition();

  const scan = (reset = true) =>
    start(async () => {
      const r = await scanKeysAction(pattern, reset ? "0" : cursor, 100);
      setError(r.ok ? null : (r.error ?? "오류"));
      setKeys((prev) => (reset ? r.keys : [...prev, ...r.keys]));
      setCursor(r.cursor);
      setTotal(r.total);
    });

  useEffect(() => {
    scan(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inspect = (key: string) => start(async () => setSelected(await inspectKeyAction(key)));
  const remove = (key: string) =>
    start(async () => {
      await deleteKeyAction(key);
      setSelected(null);
      const r = await scanKeysAction(pattern, "0", 100);
      setKeys(r.keys);
      setCursor(r.cursor);
      setTotal(r.total);
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <div>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            scan(true);
          }}
        >
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-sm outline-none focus:border-muted"
            placeholder="패턴 (예: user:*, lab:*)"
            spellCheck={false}
          />
          <Button type="submit" variant="ghost" disabled={pending}>
            SCAN
          </Button>
        </form>
        {error && <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">{error}</div>}
        <div className="mb-2 text-xs text-muted">
          DB 전체 키 {total}개 · 표시 {keys.length}개 {cursor !== "0" && "· 더 있음"}
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2">키</th>
                <th className="px-3 py-2">타입</th>
                <th className="px-3 py-2">인코딩</th>
                <th className="px-3 py-2 text-right">TTL</th>
                <th className="px-3 py-2 text-right">바이트</th>
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted">
                    키가 없습니다. 콘솔이나 실험실에서 데이터를 만들어 보세요.
                  </td>
                </tr>
              )}
              {keys.map((k) => (
                <tr
                  key={k.key}
                  onClick={() => inspect(k.key)}
                  className={`cursor-pointer border-t border-border hover:bg-surface-2 ${selected?.key === k.key ? "bg-surface-2" : ""}`}
                >
                  <td className="max-w-[260px] truncate px-3 py-1.5 font-mono text-xs">{k.key}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={TYPE_TONE[k.type] ?? "muted"}>{k.type}</Badge>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-muted">{k.encoding ?? "-"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted">{k.ttl === -1 ? "∞" : k.ttl === -2 ? "-" : `${k.ttl}s`}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted">{k.memory ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {cursor !== "0" && (
          <Button variant="ghost" className="mt-3" onClick={() => scan(false)} disabled={pending}>
            더 불러오기
          </Button>
        )}
      </div>
      <div className="rounded-lg border border-border bg-surface p-4">
        {!selected ? (
          <p className="text-sm text-muted">왼쪽에서 키를 클릭하면 값이 여기에 표시됩니다.</p>
        ) : !selected.ok ? (
          <p className="text-sm text-accent">{selected.error}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all text-sm">{selected.key}</code>
              <Badge tone={TYPE_TONE[selected.type] ?? "muted"}>{selected.type}</Badge>
              <span className="text-xs text-muted">TTL {selected.ttl === -1 ? "없음" : selected.ttl === -2 ? "(키 없음)" : `${selected.ttl}s`}</span>
              <Button variant="danger" className="ml-auto px-2.5 py-1 text-xs" onClick={() => remove(selected.key)} disabled={pending}>
                DEL
              </Button>
            </div>
            <pre className="max-h-[480px] overflow-auto rounded-md code-surface p-3 text-xs">
              {typeof selected.value === "string" ? selected.value : JSON.stringify(selected.value, null, 2)}
            </pre>
            {selected.truncated && <p className="text-xs text-muted">일부만 표시됨 (최대 200개)</p>}
          </div>
        )}
      </div>
    </div>
  );
}
