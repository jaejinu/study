import { ensureConnected, getRedis } from "@/lib/redis";
import { listNotes } from "@/lib/notes";
import { subjects } from "@/lib/subjects";
import { metrics } from "@/lib/metrics";
import { hiddenInReadOnly } from "@/lib/read-only";

export const dynamic = "force-dynamic";

/**
 * Prometheus 텍스트 포맷 (관측성 노트 03).
 *  - prom-client 레지스트리: 프로세스 기본 메트릭 + 실험·노트·콘솔·액션·LLM·알림 카운터/히스토그램
 *  - 아래 게이지: Redis 에 저장된 학습 진행률을 매 스크레이프마다 읽어 노출
 */
export async function GET() {
  // 공개판: 내부 메트릭(프로세스·요청·LLM 비용 등)은 노출하지 않는다
  const hidden = hiddenInReadOnly();
  if (hidden) return hidden;
  const lines: string[] = [];
  const metric = (name: string, help: string, type: string, rows: { labels?: Record<string, string>; value: number }[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const r of rows) {
      const l = r.labels ? `{${Object.entries(r.labels).map(([k, v]) => `${k}="${v}"`).join(",")}}` : "";
      lines.push(`${name}${l} ${r.value}`);
    }
  };
  const notes = await Promise.all(subjects.map(async (s) => ({ subject: s.id, n: (await listNotes(s.id)).length })));
  metric("study_notes_total", "주제별 노트 수", "gauge", notes.map((x) => ({ labels: { subject: x.subject }, value: x.n })));

  let redisUp = 0;
  const read: Record<string, number> = {};
  const lab: Record<string, number> = {};
  try {
    const r = getRedis();
    await ensureConnected(r);
    redisUp = 1;
    for (const k of await r.smembers("progress:read")) read[k.split("/")[0]] = (read[k.split("/")[0]] ?? 0) + 1;
    for (const k of await r.smembers("progress:lab")) lab[k.split("/")[0]] = (lab[k.split("/")[0]] ?? 0) + 1;
  } catch {
    /* redis down */
  }
  metric("study_redis_up", "앱에서 Redis 연결 가능 여부", "gauge", [{ value: redisUp }]);
  metric("study_progress_read_total", "읽은 노트 수", "gauge", subjects.map((s) => ({ labels: { subject: s.id }, value: read[s.id] ?? 0 })));
  metric("study_progress_lab_total", "성공한 실험 수", "gauge", subjects.map((s) => ({ labels: { subject: s.id }, value: lab[s.id] ?? 0 })));

  const body = (await metrics.registry.metrics()) + "\n" + lines.join("\n") + "\n";
  return new Response(body, { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" } });
}
