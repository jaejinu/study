import { getDrill } from "@/lib/drills/catalog";
import { checkDrill, getActive, giveUp, startDrill, takeHint } from "@/lib/drills/state";
import { logger } from "@/lib/log";
import { readOnlyResponse } from "@/lib/read-only";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; action: string }> };

/** POST /api/drills/<id>/start|check|hint|reset */
export async function POST(_req: Request, { params }: Ctx) {
  const blocked = readOnlyResponse("장애 훈련");
  if (blocked) return blocked;
  const { id, action } = await params;
  if (!getDrill(id)) return Response.json({ ok: false, error: "없는 훈련" }, { status: 404 });
  const t0 = performance.now();
  let res: Record<string, unknown>;
  if (action === "start") res = await startDrill(id);
  else if (action === "check") res = await checkDrill(id);
  else if (action === "hint") res = await takeHint(id);
  else if (action === "reset") res = await giveUp(id);
  else return Response.json({ ok: false, error: "없는 동작" }, { status: 400 });
  logger.info("drill.action", { drill: id, action, ok: res.ok, passed: res.passed, ms: Math.round(performance.now() - t0) });
  return Response.json(res, { status: res.ok ? 200 : 400 });
}

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return Response.json({ active: await getActive(id) });
}
