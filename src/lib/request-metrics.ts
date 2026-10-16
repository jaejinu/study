import { metrics } from "@/lib/metrics";

/** @opentelemetry/sdk-trace-base 의 ReadableSpan 중 쓰는 부분만 (그 패키지는 @vercel/otel 의 간접 의존성) */
type EndedSpan = { attributes: Record<string, unknown>; duration: [number, number] };

/**
 * 요청 RED 메트릭 — Next.js 가 요청마다 만드는 루트 스팬(BaseServer.handleRequest)이 끝날 때
 * 라우트 패턴·상태 코드·소요 시간을 prom-client 히스토그램에 기록한다 (관측성 노트 12 · 사이트 SLO).
 *
 * 왜 스팬에서? App Router 에는 "모든 응답" 을 가로채는 훅이 없다(proxy 는 응답 코드를 모른다).
 * 반면 Next 는 모든 요청을 루트 스팬으로 감싸고 끝날 때 http.status_code·next.route 를 붙인다.
 * 그래서 트레이스를 Tempo 로 보내지 않아도(익스포터 없음) 이 프로세서만으로 SLI 가 나온다.
 *
 * 라벨 카디널리티: route 는 URL 이 아니라 패턴(/[subject]/notes/[slug]) 이라 수십 개로 묶인다.
 */
export class RequestMetricsProcessor {
  onStart(): void {}
  onEnd(span: EndedSpan): void {
    const a = span.attributes;
    if (a["next.span_type"] !== "BaseServer.handleRequest") return;
    const route = String(a["next.route"] ?? a["http.route"] ?? "unmatched");
    // 메트릭 수집 자체와 정적 자원은 SLI 에서 뺀다 (스크레이프가 SLI 를 부풀리지 않게)
    if (route === "/api/metrics" || route.startsWith("/_next")) return;
    const method = String(a["http.method"] ?? "GET");
    const target = String(a["http.target"] ?? "");
    const kind = route.startsWith("/api/")
      ? "api"
      : a["next.rsc"] === true
        ? "rsc"
        : method === "POST"
          ? "action" // 서버 액션은 페이지 경로로 POST 된다
          : "page";
    if (target.startsWith("/_next")) return;
    const [s, ns] = span.duration;
    metrics.httpDuration?.observe({ route, method, kind, code: String(a["http.status_code"] ?? 0) }, s + ns / 1e9);
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
