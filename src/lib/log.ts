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
  // 서버리스(Vercel)는 파일 시스템이 읽기 전용이고 수집기(Alloy)도 없다 — stdout 만 쓴다
  if (process.env.VERCEL) return null;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    // 쓰기 오류(디스크 가득·권한)가 처리되지 않은 'error' 이벤트로 프로세스를 죽이지 않게
    stream.on("error", () => {
      stream = null;
    });
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
