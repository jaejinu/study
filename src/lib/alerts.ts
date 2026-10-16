import { ensureConnected, getRedis } from "./redis";

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

/** 받은 알림을 Redis List 에 쌓는다 (최근 200개) — 관측성 대시보드의 "최근 알림" */
export async function storeAlerts(alerts: ReceivedAlert[]): Promise<void> {
  const r = getRedis();
  await ensureConnected(r);
  const p = r.pipeline();
  for (const a of alerts) p.lpush(KEY, JSON.stringify(a));
  p.ltrim(KEY, 0, MAX - 1);
  await p.exec();
}

export async function recentAlerts(limit = 50): Promise<ReceivedAlert[]> {
  try {
    const r = getRedis();
    await ensureConnected(r);
    return (await r.lrange(KEY, 0, limit - 1)).map((s) => JSON.parse(s) as ReceivedAlert);
  } catch {
    return [];
  }
}
