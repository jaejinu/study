import { exportBackup, importBackup, type Backup } from "@/lib/backup";
import { logger } from "@/lib/log";

export const dynamic = "force-dynamic";

/** GET: 학습 기록 JSON 다운로드 */
export async function GET() {
  try {
    const b = await exportBackup();
    const name = `study-backup-${b.exportedAt.slice(0, 10)}.json`;
    return new Response(JSON.stringify(b, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });
  } catch (e) {
    return Response.json({ error: `Redis 에 연결할 수 없습니다: ${(e as Error).message}` }, { status: 503 });
  }
}

/** POST ?mode=merge|replace : 백업 JSON 가져오기 */
export async function POST(req: Request) {
  const mode = new URL(req.url).searchParams.get("mode") === "replace" ? "replace" : "merge";
  try {
    const body = (await req.json()) as Backup;
    const r = await importBackup(body, mode);
    logger.info("backup.import", { mode, keys: r.keys });
    return Response.json({ ok: true, mode, keys: r.keys });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
