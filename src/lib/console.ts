import type Redis from "ioredis";
import { createRedis, ensureConnected } from "./redis";
import { isReadOnly, READ_ONLY_MESSAGE } from "./read-only";

declare global {
  var __redisConsole: Redis | undefined;
}

/** 콘솔 전용 커넥션: 블로킹 명령이 전체 앱을 멈추지 않도록 분리하고 타임아웃을 둔다 */
export function getConsoleRedis(): Redis {
  if (!globalThis.__redisConsole) {
    globalThis.__redisConsole = createRedis({ commandTimeout: 5000 });
  }
  return globalThis.__redisConsole;
}

/** 학습 환경을 망가뜨리거나 커넥션을 점유하는 명령은 막는다 */
const BLOCKED = new Set([
  "FLUSHALL", "FLUSHDB", "SHUTDOWN", "DEBUG", "MONITOR", "SYNC", "PSYNC",
  "REPLICAOF", "SLAVEOF", "CLUSTER", "ACL", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE",
  "MIGRATE", "FAILOVER", "MODULE", "SCRIPT", "FUNCTION", "RESET", "QUIT",
]);
const BLOCKED_SUB: Record<string, Set<string>> = {
  CONFIG: new Set(["SET", "REWRITE", "RESETSTAT"]),
  CLIENT: new Set(["KILL", "PAUSE", "UNPAUSE"]),
};

/** redis-cli 와 비슷하게 따옴표를 존중해 토큰화한다 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < line.length) {
        const n = line[++i];
        cur += n === "n" ? "\n" : n === "t" ? "\t" : n;
      } else if (c === quote) {
        quote = null;
      } else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

export interface ConsoleResult {
  ok: boolean;
  cmd: string;
  result?: unknown;
  error?: string;
  ms: number;
}

export async function execLine(line: string): Promise<ConsoleResult> {
  if (isReadOnly()) return { ok: false, cmd: "", error: READ_ONLY_MESSAGE, ms: 0 };
  const t0 = performance.now();
  const tokens = tokenize(line.trim());
  const cmd = tokens.join(" ");
  if (tokens.length === 0) return { ok: false, cmd, error: "명령을 입력하세요", ms: 0 };
  const name = tokens[0].toUpperCase();
  const sub = tokens[1]?.toUpperCase();
  if (BLOCKED.has(name) || BLOCKED_SUB[name]?.has(sub)) {
    return { ok: false, cmd, error: `${name}${sub && BLOCKED_SUB[name] ? " " + sub : ""} 는 이 콘솔에서 막혀 있습니다 (학습 환경 보호)`, ms: 0 };
  }
  try {
    const client = getConsoleRedis();
    await ensureConnected(client);
    const result = await client.call(name, ...tokens.slice(1));
    return { ok: true, cmd, result: normalize(result), ms: Math.round((performance.now() - t0) * 100) / 100 };
  } catch (e) {
    return { ok: false, cmd, error: e instanceof Error ? e.message : String(e), ms: Math.round((performance.now() - t0) * 100) / 100 };
  }
}

function normalize(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "bigint") return v.toString();
  return v;
}
