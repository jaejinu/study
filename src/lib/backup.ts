import fs from "node:fs/promises";
import path from "node:path";
import { ensureConnected, getRedis } from "./redis";
import { assertWritable, isReadOnly } from "./read-only";

/**
 * 학습 기록 백업·복원. 진행률·퀴즈 기록·학습 시간·실험 이력은 이 앱의 Redis 에만 있으므로
 * JSON 으로 내보내고 가져온다. 자료구조(Set·Hash·String·Stream)와 TTL 을 그대로 보존한다.
 */
export const BACKUP_PATTERNS = ["progress:*", "quiz:stats:*", "study:*", "lab:runs:*", "memo:*"] as const;
export const BACKUP_DIR = path.join(process.cwd(), "backups");

type Entry =
  | { key: string; type: "set"; ttl: number; value: string[] }
  | { key: string; type: "hash"; ttl: number; value: Record<string, string> }
  | { key: string; type: "string"; ttl: number; value: string }
  | { key: string; type: "stream"; ttl: number; value: [string, string[]][] };

export interface Backup {
  app: "study";
  version: 1;
  exportedAt: string;
  keys: Entry[];
}

export async function exportBackup(): Promise<Backup> {
  const r = getRedis();
  await ensureConnected(r);
  const keys = new Set<string>();
  for (const pattern of BACKUP_PATTERNS) {
    let cursor = "0";
    do {
      const [next, batch] = await r.scan(cursor, "MATCH", pattern, "COUNT", 500);
      cursor = next;
      batch.forEach((k) => keys.add(k));
    } while (cursor !== "0");
  }
  const out: Entry[] = [];
  for (const key of [...keys].sort()) {
    const [type, ttl] = await Promise.all([r.type(key), r.ttl(key)]);
    const t = ttl > 0 ? ttl : -1;
    if (type === "set") out.push({ key, type, ttl: t, value: (await r.smembers(key)).sort() });
    else if (type === "hash") out.push({ key, type, ttl: t, value: await r.hgetall(key) });
    else if (type === "string") out.push({ key, type, ttl: t, value: (await r.get(key)) ?? "" });
    else if (type === "stream") out.push({ key, type, ttl: t, value: (await r.xrange(key, "-", "+")) as [string, string[]][] });
  }
  return { app: "study", version: 1, exportedAt: new Date().toISOString(), keys: out };
}

export function summarize(b: Backup): Record<string, number> {
  const s: Record<string, number> = {};
  for (const e of b.keys) {
    const family = e.key.split(":").slice(0, 2).join(":").replace(/:[^:]*\/.*/, "");
    s[family] = (s[family] ?? 0) + 1;
  }
  return s;
}

/** mode=merge: 기존 기록과 합친다(Set 합집합, Hash·String 은 백업 값 우선, Stream 은 없는 ID 만 추가). replace: 백업 대상 키를 지우고 백업으로 덮는다 */
export async function importBackup(b: Backup, mode: "merge" | "replace" = "merge"): Promise<{ keys: number }> {
  assertWritable("백업 가져오기");
  if (b?.app !== "study" || b.version !== 1 || !Array.isArray(b.keys)) throw new Error("study 백업 파일이 아닙니다");
  const r = getRedis();
  await ensureConnected(r);
  if (mode === "replace") {
    const current = await exportBackup();
    if (current.keys.length) await r.del(...current.keys.map((e) => e.key));
  }
  for (const e of b.keys) {
    if (!BACKUP_PATTERNS.some((p) => e.key.startsWith(p.replace("*", "")))) continue; // 범위 밖 키는 무시
    const p = r.multi();
    if (e.type === "set" && e.value.length) p.sadd(e.key, ...e.value);
    else if (e.type === "hash" && Object.keys(e.value).length) p.hset(e.key, e.value);
    else if (e.type === "string") p.set(e.key, e.value);
    else if (e.type === "stream") {
      const last = mode === "merge" ? ((await r.xrevrange(e.key, "+", "-", "COUNT", 1))[0]?.[0] ?? "0-0") : "0-0";
      const cmp = (a: string, b2: string) => {
        const [am, as] = a.split("-").map(Number);
        const [bm, bs] = b2.split("-").map(Number);
        return am - bm || as - bs;
      };
      for (const [id, fields] of e.value) if (cmp(id, last) > 0) p.xadd(e.key, id, ...fields);
    }
    if (e.ttl > 0) p.expire(e.key, e.ttl);
    await p.exec();
  }
  return { keys: b.keys.length };
}

/** backups/study-YYYYMMDD-HHMM.json 으로 저장하고 오래된 것은 keep 개만 남긴다 */
export async function writeBackupFile(keep = 14): Promise<{ file: string; keys: number }> {
  assertWritable("백업 파일 쓰기");
  const b = await exportBackup();
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const d = new Date(b.exportedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; // 로컬 시각
  const file = path.join(BACKUP_DIR, `study-${stamp}.json`);
  await fs.writeFile(file, JSON.stringify(b, null, 2));
  const files = (await fs.readdir(BACKUP_DIR)).filter((f) => /^study-\d{8}-\d{4}\.json$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) await fs.rm(path.join(BACKUP_DIR, old));
  return { file, keys: b.keys.length };
}

export async function listBackupFiles(): Promise<{ name: string; size: number; mtime: number }[]> {
  try {
    const files = (await fs.readdir(BACKUP_DIR)).filter((f) => f.endsWith(".json")).sort().reverse();
    return Promise.all(files.map(async (name) => {
      const st = await fs.stat(path.join(BACKUP_DIR, name));
      return { name, size: st.size, mtime: st.mtimeMs };
    }));
  } catch {
    return [];
  }
}

/** 서버가 켜져 있는 동안 하루 한 번 자동 백업 (instrumentation 에서 시작) */
export function startAutoBackup(intervalMs = 6 * 3600_000) {
  if (isReadOnly()) return; // 공개판: Redis 도 없고 디스크에 쓰지도 않는다
  const tick = async () => {
    try {
      const latest = (await listBackupFiles())[0];
      if (latest && Date.now() - latest.mtime < 24 * 3600_000) return;
      await writeBackupFile();
    } catch {
      /* Redis 가 꺼져 있으면 다음 기회에 */
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, intervalMs).unref();
}
