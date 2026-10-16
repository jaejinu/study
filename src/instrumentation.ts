// Next.js 가 서버 시작 시 한 번 호출한다. OpenTelemetry 로 트레이스를 Tempo 에 보낸다 (관측성 노트 06).
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm dev
// 환경 변수가 없으면 계측은 켜지되 어디에도 내보내지 않는다.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerOTel, OTLPHttpJsonTraceExporter } = await import("@vercel/otel");
  const { IORedisInstrumentation } = await import("@opentelemetry/instrumentation-ioredis");
  const { PgInstrumentation } = await import("@opentelemetry/instrumentation-pg");
  const { RequestMetricsProcessor } = await import("@/lib/request-metrics");
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  registerOTel({
    // "auto" = 기본 내보내기 프로세서, 그리고 요청 RED 메트릭(사이트 SLO 의 SLI) 기록기
    spanProcessors: ["auto", new RequestMetricsProcessor()],
    serviceName: process.env.OTEL_SERVICE_NAME ?? "study-app",
    traceExporter: endpoint ? new OTLPHttpJsonTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }) : undefined,
    instrumentations: [new IORedisInstrumentation(), new PgInstrumentation()],
  });
  // 학습 기록 자동 백업 (하루 한 번, backups/ 에 최근 14개)
  const { startAutoBackup } = await import("@/lib/backup");
  startAutoBackup();
}
