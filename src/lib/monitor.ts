import { ensureConnected, getRedis } from "./redis";

export interface Snapshot {
  ok: boolean;
  error?: string;
  at: number;
  opsPerSec: number;
  totalCommands: number;
  usedMemory: number;
  usedMemoryHuman: string;
  maxmemory: number;
  fragmentation: number;
  clients: number;
  blocked: number;
  keys: number;
  expires: number;
  hitRate: number | null;
  evicted: number;
  expired: number;
  uptime: number;
  slowlog: { id: number; at: number; durationUs: number; cmd: string }[];
  commandStats: { cmd: string; calls: number; usecPerCall: number }[];
}

function parse(raw: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const l of raw.split("\n")) {
    const i = l.indexOf(":");
    if (i > 0 && !l.startsWith("#")) o[l.slice(0, i)] = l.slice(i + 1).trim();
  }
  return o;
}

export async function getSnapshot(): Promise<Snapshot> {
  const r = getRedis();
  const at = Date.now();
  try {
    await ensureConnected(r);
    const [infoRaw, slowRaw] = await Promise.all([r.info(), r.slowlog("GET", 10)]);
    const i = parse(infoRaw);
    const hits = Number(i.keyspace_hits ?? 0);
    const misses = Number(i.keyspace_misses ?? 0);
    const db0 = /keys=(\d+),expires=(\d+)/.exec(i.db0 ?? "");
    const commandStats = Object.entries(i)
      .filter(([k]) => k.startsWith("cmdstat_"))
      .map(([k, v]) => {
        const m = /calls=(\d+),usec=(\d+),usec_per_call=([\d.]+)/.exec(v);
        return { cmd: k.slice(8), calls: Number(m?.[1] ?? 0), usecPerCall: Number(m?.[3] ?? 0) };
      })
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10);
    const slowlog = (slowRaw as unknown as [number, number, number, string[]][]).map(([id, ts, us, args]) => ({
      id,
      at: ts * 1000,
      durationUs: us,
      cmd: args.slice(0, 6).join(" ") + (args.length > 6 ? " …" : ""),
    }));
    return {
      ok: true,
      at,
      opsPerSec: Number(i.instantaneous_ops_per_sec ?? 0),
      totalCommands: Number(i.total_commands_processed ?? 0),
      usedMemory: Number(i.used_memory ?? 0),
      usedMemoryHuman: i.used_memory_human ?? "?",
      maxmemory: Number(i.maxmemory ?? 0),
      fragmentation: Number(i.mem_fragmentation_ratio ?? 0),
      clients: Number(i.connected_clients ?? 0),
      blocked: Number(i.blocked_clients ?? 0),
      keys: Number(db0?.[1] ?? 0),
      expires: Number(db0?.[2] ?? 0),
      hitRate: hits + misses ? hits / (hits + misses) : null,
      evicted: Number(i.evicted_keys ?? 0),
      expired: Number(i.expired_keys ?? 0),
      uptime: Number(i.uptime_in_seconds ?? 0),
      slowlog,
      commandStats,
    };
  } catch (e) {
    return {
      ok: false, error: e instanceof Error ? e.message : String(e), at, opsPerSec: 0, totalCommands: 0, usedMemory: 0, usedMemoryHuman: "?", maxmemory: 0,
      fragmentation: 0, clients: 0, blocked: 0, keys: 0, expires: 0, hitRate: null, evicted: 0, expired: 0, uptime: 0, slowlog: [], commandStats: [],
    };
  }
}
