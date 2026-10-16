import { createHash } from "node:crypto";
import { storeAlerts, type ReceivedAlert } from "@/lib/alerts";
import { logger } from "@/lib/log";
import { metrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";

interface AmPayload {
  receiver?: string;
  status?: string;
  alerts?: { status: "firing" | "resolved"; labels: Record<string, string>; annotations?: Record<string, string>; startsAt: string; endsAt: string; fingerprint?: string }[];
}

/**
 * Alertmanager webhook receiver. observability/alertmanager.yml 이 이 주소로 보낸다.
 * 알림을 Redis 에 저장하고, 로그·메트릭으로도 남긴다 (관측성 노트 09).
 */
export async function POST(req: Request) {
  let payload: AmPayload;
  try {
    payload = (await req.json()) as AmPayload;
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const alerts: ReceivedAlert[] = (payload.alerts ?? []).map((a) => ({
    id: a.fingerprint ?? createHash("md5").update(JSON.stringify(a.labels) + a.startsAt).digest("hex"),
    status: a.status,
    alertname: a.labels.alertname ?? "unknown",
    severity: a.labels.severity ?? "none",
    summary: a.annotations?.summary ?? "",
    description: a.annotations?.description ?? "",
    labels: a.labels,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    receivedAt: now,
    receiver: payload.receiver ?? "",
  }));
  for (const a of alerts) {
    metrics.alertsReceived.inc({ alertname: a.alertname, severity: a.severity, status: a.status });
    logger[a.status === "firing" && (a.severity === "critical" || a.severity === "warning") ? "warn" : "info"]("alert.received", {
      alertname: a.alertname, severity: a.severity, status: a.status, summary: a.summary, receiver: a.receiver,
    });
  }
  try {
    await storeAlerts(alerts);
  } catch (e) {
    logger.error("alert.store.failed", { error: String(e) });
  }
  return Response.json({ ok: true, received: alerts.length });
}

export async function GET() {
  const { recentAlerts } = await import("@/lib/alerts");
  return Response.json(await recentAlerts(50));
}
