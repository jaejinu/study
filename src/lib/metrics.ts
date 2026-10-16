import client from "prom-client";

/**
 * 앱 메트릭 (prom-client). /api/metrics 가 노출하고 Prometheus 가 5초마다 긁는다.
 * dev 모드의 HMR 로 모듈이 다시 로드돼도 레지스트리가 중복되지 않도록 global 에 보관한다.
 */
declare global {
  var __studyMetrics: ReturnType<typeof build> | undefined;
}

function build() {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: "study-app" });
  client.collectDefaultMetrics({ register: registry, prefix: "study_process_" });

  const experimentRuns = new client.Counter({
    name: "study_experiment_runs_total",
    help: "실험 실행 수 (주제·실험·결과)",
    labelNames: ["subject", "experiment", "outcome"] as const,
    registers: [registry],
  });
  const experimentDuration = new client.Histogram({
    name: "study_experiment_duration_seconds",
    help: "실험 실행 시간",
    labelNames: ["subject", "experiment"] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [registry],
  });
  const noteViews = new client.Counter({
    name: "study_note_views_total",
    help: "노트 조회 수",
    labelNames: ["subject", "level"] as const,
    registers: [registry],
  });
  const consoleCommands = new client.Counter({
    name: "study_console_commands_total",
    help: "콘솔 명령 수 (명령·결과)",
    labelNames: ["command", "outcome"] as const,
    registers: [registry],
  });
  const actionDuration = new client.Histogram({
    name: "study_action_duration_seconds",
    help: "서버 액션 처리 시간 (RED 의 Duration)",
    labelNames: ["action", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const llmTokens = new client.Counter({
    name: "study_llm_tokens_total",
    help: "LLM 토큰 사용량 (model, kind=input|output|cache_read|cache_write)",
    labelNames: ["model", "kind"] as const,
    registers: [registry],
  });
  const llmCost = new client.Counter({
    name: "study_llm_cost_usd_total",
    help: "LLM 추정 비용 (USD)",
    labelNames: ["model"] as const,
    registers: [registry],
  });
  const llmLatency = new client.Histogram({
    name: "study_llm_latency_seconds",
    help: "LLM 호출 지연 (phase=ttft|total)",
    labelNames: ["model", "phase"] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32],
    registers: [registry],
  });
  const llmToolCalls = new client.Counter({
    name: "study_llm_tool_calls_total",
    help: "LLM 툴 호출 수",
    labelNames: ["tool", "outcome"] as const,
    registers: [registry],
  });
  const alertsReceived = new client.Counter({
    name: "study_alerts_received_total",
    help: "Alertmanager 웹훅으로 받은 알림 수",
    labelNames: ["alertname", "severity", "status"] as const,
    registers: [registry],
  });
  return { registry, experimentRuns, experimentDuration, noteViews, consoleCommands, actionDuration, llmTokens, llmCost, llmLatency, llmToolCalls, alertsReceived };
}

export const metrics = globalThis.__studyMetrics ?? (globalThis.__studyMetrics = build());

/** 서버 액션을 감싸 Duration·outcome 을 기록 */
export async function timed<T>(action: string, fn: () => Promise<T>, isOk: (r: T) => boolean = () => true): Promise<T> {
  const end = metrics.actionDuration.startTimer({ action });
  try {
    const r = await fn();
    end({ outcome: isOk(r) ? "ok" : "error" });
    return r;
  } catch (e) {
    end({ outcome: "exception" });
    throw e;
  }
}
