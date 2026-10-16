import { ensureConnected, getRedis } from "@/lib/redis";
import { listNotes } from "@/lib/notes";
import { subjects } from "@/lib/subjects";

export const dynamic = "force-dynamic";

/**
 * Prometheus 텍스트 포맷으로 이 앱의 메트릭을 노출한다 (관측성 노트 03).
 * observability/prometheus.yml 의 study-app job 이 5초마다 긁어 간다.
 */
export async function GET() {
  const lines: string[] = [];
  const metric = (name: string, help: string, type: string, rows: { labels?: Record<string, string>; value: number }[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const r of rows) {
      const l = r.labels ? `{${Object.entries(r.labels).map(([k, v]) => `${k}="${v}"`).join(",")}}` : "";
      lines.push(`${name}${l} ${r.value}`);
    }
  };
  metric("process_uptime_seconds", "Node 프로세스 가동 시간", "gauge", [{ value: Math.round(process.uptime()) }]);
  metric("process_resident_memory_bytes", "RSS", "gauge", [{ value: process.memoryUsage().rss }]);

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

  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" } });
}
