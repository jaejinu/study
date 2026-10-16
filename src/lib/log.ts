import fs from "node:fs";
import path from "node:path";
import { trace } from "@opentelemetry/api";

/**
 * 구조화(JSON) 로그. 한 줄에 하나, stdout 과 logs/app.jsonl 에 함께 쓴다.
 * Alloy 가 파일을 읽어 Loki 로 보내고, trace_id 로 Tempo 의 트레이스와 연결된다 (관측성 노트 05).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_FILE = path.join(process.cwd(), "logs", "app.jsonl");
let stream: fs.WriteStream | null = null;

function fileStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    return stream;
  } catch {
    return null;
  }
}

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const span = trace.getActiveSpan()?.spanContext();
  // 필드가 예약 키(level, msg 등)를 덮어쓰지 못하도록 예약 키를 마지막에 둔다
  const entry = {
    ...fields,
    ts: new Date().toISOString(),
    level,
    msg,
    service: "study-app",
    ...(span ? { trace_id: span.traceId, span_id: span.spanId } : {}),
  };
  const line = JSON.stringify(entry);
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
  fileStream()?.write(line + "\n");
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => log("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => log("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => log("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => log("error", msg, f),
};
