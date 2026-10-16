import { exportBackup, importBackup, type Backup } from "@/lib/backup";
import { logger } from "@/lib/log";
import { readOnlyResponse } from "@/lib/read-only";

export const dynamic = "force-dynamic";

/** GET: 학습 기록 JSON 다운로드 */
export async function GET() {
  // 공개판: 서버에 개인 기록이 없고, 내부 데이터 덤프 경로를 열어 두지 않는다
  const blocked = readOnlyResponse("백업 내보내기");
  if (blocked) return blocked;
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
  const blocked = readOnlyResponse("백업 가져오기");
  if (blocked) return blocked;
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
