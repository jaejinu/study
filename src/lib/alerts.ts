import { createRedis, ensureConnected } from "./redis";

/** Alertmanager 웹훅 페이로드 (v4) 의 알림 하나 */
export interface ReceivedAlert {
  id: string;
  status: "firing" | "resolved";
  alertname: string;
  severity: string;
  summary: string;
  description: string;
  labels: Record<string, string>;
  startsAt: string;
  endsAt: string;
  receivedAt: string;
  receiver: string;
}

const KEY = "alerts:recent";
const MAX = 200;

/**
 * 알림 저장소는 "장애 중인 의존성" 에 기대면 안 된다 (Redis 가 죽어서 온 RedisDown 알림을 Redis 에 저장하려다 멈추면 안 됨).
 * 그래서 1) 항상 프로세스 메모리 링 버퍼에 먼저 넣고, 2) Redis 에는 1초 타임아웃으로 best-effort 저장한다.
 */
declare global {
  var __studyAlertBuffer: ReceivedAlert[] | undefined;
}
const memory: ReceivedAlert[] = globalThis.__studyAlertBuffer ?? (globalThis.__studyAlertBuffer = []);

let store: ReturnType<typeof createRedis> | null = null;
function storeClient() {
  if (!store) store = createRedis({ commandTimeout: 1000, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
  return store;
}

export async function storeAlerts(alerts: ReceivedAlert[]): Promise<{ redis: boolean }> {
  memory.unshift(...alerts);
  memory.splice(MAX);
  try {
    const r = storeClient();
    await Promise.race([ensureConnected(r), new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout")), 1000))]);
    const p = r.pipeline();
    for (const a of alerts) p.lpush(KEY, JSON.stringify(a));
    p.ltrim(KEY, 0, MAX - 1);
    await p.exec();
    return { redis: true };
  } catch {
    return { redis: false };
  }
}

export async function recentAlerts(limit = 50): Promise<ReceivedAlert[]> {
  let fromRedis: ReceivedAlert[] = [];
  try {
    const r = storeClient();
    await Promise.race([ensureConnected(r), new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout")), 1000))]);
    fromRedis = (await r.lrange(KEY, 0, limit - 1)).map((s) => JSON.parse(s) as ReceivedAlert);
  } catch {
    /* Redis 없으면 메모리만 */
  }
  const seen = new Set<string>();
  const merged: ReceivedAlert[] = [];
  for (const a of [...memory, ...fromRedis]) {
    const key = `${a.id}:${a.status}:${a.receivedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(a);
  }
  return merged.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
}
