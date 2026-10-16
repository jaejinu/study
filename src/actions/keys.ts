"use server";

import { ensureConnected, getRedis } from "@/lib/redis";

export interface KeyInfo {
  key: string;
  type: string;
  ttl: number;
  encoding: string | null;
  memory: number | null;
}

export interface ScanResult {
  ok: boolean;
  error?: string;
  cursor: string;
  keys: KeyInfo[];
  total: number;
}

export async function scanKeysAction(pattern: string, cursor = "0", count = 50): Promise<ScanResult> {
  const client = getRedis();
  try {
    await ensureConnected(client);
    const safePattern = pattern.trim() || "*";
    const [next, keys] = await client.scan(cursor, "MATCH", safePattern, "COUNT", Math.min(Math.max(count, 10), 500));
    const total = await client.dbsize();
    if (keys.length === 0) return { ok: true, cursor: next, keys: [], total };
    const p = client.pipeline();
    for (const k of keys) {
      p.type(k);
      p.ttl(k);
      p.object("ENCODING", k);
      p.memory("USAGE", k);
    }
    const res = (await p.exec()) ?? [];
    const infos: KeyInfo[] = keys.map((key, i) => ({
      key,
      type: String(res[i * 4][1] ?? "?"),
      ttl: Number(res[i * 4 + 1][1] ?? -1),
      encoding: res[i * 4 + 2][0] ? null : String(res[i * 4 + 2][1]),
      memory: res[i * 4 + 3][0] ? null : Number(res[i * 4 + 3][1]),
    }));
    return { ok: true, cursor: next, keys: infos.sort((a, b) => a.key.localeCompare(b.key)), total };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), cursor: "0", keys: [], total: 0 };
  }
}

export interface KeyValue {
  ok: boolean;
  error?: string;
  key: string;
  type: string;
  ttl: number;
  value: unknown;
  truncated: boolean;
}

const LIMIT = 200;

export async function inspectKeyAction(key: string): Promise<KeyValue> {
  const client = getRedis();
  const base = { key, type: "none", ttl: -2, value: null, truncated: false };
  try {
    await ensureConnected(client);
    const type = await client.type(key);
    const ttl = await client.ttl(key);
    let value: unknown = null;
    let truncated = false;
    switch (type) {
      case "string":
        value = await client.get(key);
        break;
      case "list": {
        const len = await client.llen(key);
        value = await client.lrange(key, 0, LIMIT - 1);
        truncated = len > LIMIT;
        break;
      }
      case "hash": {
        const [, fields] = await client.hscan(key, "0", "COUNT", LIMIT);
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        value = obj;
        truncated = (await client.hlen(key)) > LIMIT;
        break;
      }
      case "set": {
        const [, members] = await client.sscan(key, "0", "COUNT", LIMIT);
        value = members;
        truncated = (await client.scard(key)) > LIMIT;
        break;
      }
      case "zset": {
        const raw = await client.zrange(key, "0", String(LIMIT - 1), "WITHSCORES");
        const arr: { member: string; score: number }[] = [];
        for (let i = 0; i < raw.length; i += 2) arr.push({ member: raw[i], score: Number(raw[i + 1]) });
        value = arr;
        truncated = (await client.zcard(key)) > LIMIT;
        break;
      }
      case "stream": {
        value = await client.xrevrange(key, "+", "-", "COUNT", 50);
        truncated = (await client.xlen(key)) > 50;
        break;
      }
      default:
        value = type === "none" ? null : `(${type} 타입은 미리보기 미지원)`;
    }
    return { ok: true, key, type, ttl, value, truncated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ...base };
  }
}

export async function deleteKeyAction(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = getRedis();
    await ensureConnected(client);
    await client.del(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
