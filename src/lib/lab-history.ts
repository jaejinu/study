import { ensureConnected, getRedis } from "./redis";
import { isReadOnly } from "./read-only";

/**
 * 실험 실행 이력 — Redis Stream `lab:runs:<subject>/<id>` (최근 50회).
 * 브라우저 저장소의 '지난 실행 비교' 와 달리 서버에 남아 기기·브라우저가 바뀌어도 추이를 본다.
 * Stream 을 고른 이유: 시간순 append·자동 ID(밀리초 시각)·MAXLEN 으로 크기 제한·XREVRANGE 로 최근 N개 (Redis 노트 07).
 */
export interface LabRun {
  at: number;
  ok: boolean;
  durationMs: number;
  steps: number;
  checks: number;
  failedChecks: number;
  error?: string;
}

const key = (subject: string, id: string) => `lab:runs:${subject}/${id}`;

export async function recordLabRun(subject: string, id: string, run: Omit<LabRun, "at">): Promise<void> {
  if (isReadOnly()) return;
  const r = getRedis();
  try {
    await ensureConnected(r);
    await r.xadd(key(subject, id), "MAXLEN", "~", "50", "*", "ok", run.ok ? "1" : "0", "ms", String(run.durationMs), "steps", String(run.steps), "checks", String(run.checks), "failed", String(run.failedChecks), "error", (run.error ?? "").slice(0, 200));
  } catch {
    /* 이력 저장 실패는 실험 결과에 영향을 주지 않는다 */
  }
}

export async function getLabRuns(subject: string, id: string, count = 20): Promise<LabRun[]> {
  const r = getRedis();
  try {
    await ensureConnected(r);
    const rows = await r.xrevrange(key(subject, id), "+", "-", "COUNT", count);
    return rows
      .map(([sid, fields]) => {
        const f: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
        return { at: Number(sid.split("-")[0]), ok: f.ok === "1", durationMs: Number(f.ms), steps: Number(f.steps), checks: Number(f.checks), failedChecks: Number(f.failed), error: f.error || undefined };
      })
      .reverse();
  } catch {
    return [];
  }
}

/** 실험 결과의 steps 에서 검증(✓/✗) 개수를 센다 — 세 실험 프레임워크의 step 모양이 달라 cmd 접두어로 판정 */
export function countChecks(steps: { cmd: string; ok?: boolean; error?: boolean }[]): { checks: number; failed: number } {
  let checks = 0;
  let failed = 0;
  for (const s of steps) {
    if (/^[✓✗]/.test(s.cmd)) {
      checks++;
      if (s.cmd.startsWith("✗") || s.error || s.ok === false) failed++;
    }
  }
  return { checks, failed };
}
