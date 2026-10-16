// Next.js 가 서버 시작 시 한 번 호출한다. OpenTelemetry 로 트레이스를 Tempo 에 보낸다 (관측성 노트 06).
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318 pnpm dev
// 환경 변수가 없으면 계측은 켜지되 어디에도 내보내지 않는다.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerOTel, OTLPHttpJsonTraceExporter } = await import("@vercel/otel");
  const { IORedisInstrumentation } = await import("@opentelemetry/instrumentation-ioredis");
  const { PgInstrumentation } = await import("@opentelemetry/instrumentation-pg");
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "study-app",
    traceExporter: endpoint ? new OTLPHttpJsonTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }) : undefined,
    instrumentations: [new IORedisInstrumentation(), new PgInstrumentation()],
  });
}
