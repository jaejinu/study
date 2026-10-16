import { armDeadman } from "@/lib/deadman";
import { ensureConnected, getRedis } from "@/lib/redis";
import { getDrill } from "./catalog";
import type { Drill } from "./types";

/**
 * 훈련 진행 상태 — Redis
 *   drills:active:<id>  Hash  startedAt, hints, deadmanPid, endpoint   (TTL = 제한 시간 + 여유)
 *   drills:runs:<id>    Stream  ok, ms, hints, gaveUp                  (최근 20회)
 * 데드맨 스위치: 시작 직전에 장전해 제한 시간이 지나면 전용 컨테이너를 지운다(서버가 죽어도). 통과·포기하면 해제.
 */
const activeKey = (id: string) => `drills:active:${id}`;
const runsKey = (id: string) => `drills:runs:${id}`;

export interface ActiveDrill {
  startedAt: number;
  hints: number;
  endpoint: string;
  deadmanPid: number;
  expiresAt: number;
}

export interface DrillRun {
  at: number;
  ok: boolean;
  ms: number;
  hints: number;
  gaveUp: boolean;
}

function disarm(pid: number) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM"); // sh + sleep 프로세스 그룹
  } catch {
    /* 이미 끝남 */
  }
}

export async function getActive(id: string): Promise<ActiveDrill | null> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    const h = await r.hgetall(activeKey(id));
    if (!h.startedAt) return null;
    return { startedAt: Number(h.startedAt), hints: Number(h.hints ?? 0), endpoint: h.endpoint ?? "", deadmanPid: Number(h.deadmanPid ?? 0), expiresAt: Number(h.expiresAt ?? 0) };
  } catch {
    return null;
  }
}

export async function startDrill(id: string): Promise<{ ok: boolean; error?: string; active?: ActiveDrill }> {
  const d = getDrill(id);
  if (!d) return { ok: false, error: "없는 훈련" };
  const why = await d.requires();
  if (why) return { ok: false, error: why };
  const r = getRedis();
  await ensureConnected(r);
  const prev = await getActive(id);
  if (prev) {
    disarm(prev.deadmanPid);
    await d.reset();
  }
  const seconds = d.timeLimitMin * 60;
  const guard = armDeadman(d.deadmanCommand, seconds); // 주입 직전 장전
  try {
    const endpoint = await d.setup();
    const now = Date.now();
    const active: ActiveDrill = { startedAt: now, hints: 0, endpoint, deadmanPid: guard.pid ?? 0, expiresAt: now + seconds * 1000 };
    await r.hset(activeKey(id), { startedAt: active.startedAt, hints: 0, endpoint, deadmanPid: active.deadmanPid, expiresAt: active.expiresAt });
    await r.expire(activeKey(id), seconds + 120);
    return { ok: true, active };
  } catch (e) {
    guard.disarm();
    await d.reset();
    return { ok: false, error: (e as Error).message };
  }
}

export async function takeHint(id: string): Promise<{ ok: boolean; hint?: string; index?: number; error?: string }> {
  const d = getDrill(id);
  const a = await getActive(id);
  if (!d || !a) return { ok: false, error: "진행 중인 훈련이 아닙니다" };
  const idx = Math.min(a.hints, d.hints.length - 1);
  const r = getRedis();
  await r.hset(activeKey(id), "hints", Math.min(a.hints + 1, d.hints.length));
  return { ok: true, hint: d.hints[idx], index: idx + 1 };
}

async function finish(d: Drill, a: ActiveDrill, ok: boolean, gaveUp: boolean) {
  const r = getRedis();
  const ms = Date.now() - a.startedAt;
  await r.xadd(runsKey(d.id), "MAXLEN", "~", "20", "*", "ok", ok ? "1" : "0", "ms", String(ms), "hints", String(a.hints), "gaveUp", gaveUp ? "1" : "0");
  await r.del(activeKey(d.id));
  disarm(a.deadmanPid);
  await d.reset();
  return ms;
}

export async function checkDrill(id: string): Promise<{ ok: boolean; passed?: boolean; detail?: string; ms?: number; error?: string }> {
  const d = getDrill(id);
  const a = await getActive(id);
  if (!d || !a) return { ok: false, error: "진행 중인 훈련이 아닙니다" };
  const c = await d.check();
  if (!c.ok) return { ok: true, passed: false, detail: c.detail };
  const ms = await finish(d, a, true, false);
  return { ok: true, passed: true, detail: c.detail, ms };
}

export async function giveUp(id: string): Promise<{ ok: boolean; error?: string }> {
  const d = getDrill(id);
  if (!d) return { ok: false, error: "없는 훈련" };
  const a = await getActive(id);
  if (a) await finish(d, a, false, true);
  else await d.reset();
  return { ok: true };
}

export async function getRuns(id: string, count = 20): Promise<DrillRun[]> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    const rows = await r.xrevrange(runsKey(id), "+", "-", "COUNT", count);
    return rows
      .map(([sid, f]) => {
        const m: Record<string, string> = {};
        for (let i = 0; i < f.length; i += 2) m[f[i]] = f[i + 1];
        return { at: Number(sid.split("-")[0]), ok: m.ok === "1", ms: Number(m.ms), hints: Number(m.hints), gaveUp: m.gaveUp === "1" };
      })
      .reverse();
  } catch {
    return [];
  }
}

export function bestRun(runs: DrillRun[]): DrillRun | undefined {
  return runs.filter((r) => r.ok).sort((a, b) => a.ms - b.ms)[0];
}
