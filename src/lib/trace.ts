import type Redis from "ioredis";

/** 실험 실행 중 기록되는 한 단계 */
export interface Step {
  /** 사람이 읽는 명령 표기. 예: `SET user:1 alice EX 10` */
  cmd: string;
  /** JSON 직렬화 가능한 결과 */
  result: unknown;
  /** 명령 소요 시간(ms) */
  ms: number;
  /** 설명/주석 단계 (명령이 아닌 로그) */
  note?: boolean;
  /** 에러로 끝난 단계 */
  error?: boolean;
}

export interface Recorder {
  steps: Step[];
  /** 설명 줄을 추가한다 */
  note: (text: string) => void;
  /** 임의의 비동기 작업을 측정하고 기록한다 */
  measure: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** 기대값 검증. 실패하면 단계에 기록하고 예외를 던진다 (vitest 에서도 그대로 실패) */
  check: (label: string, ok: boolean, detail?: unknown) => void;
  /** ioredis 클라이언트를 감싸 모든 호출을 기록한다 */
  wrap: (client: Redis, alias?: string) => Redis;
  sleep: (ms: number) => Promise<void>;
}

export function toSerializable(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Error) return { error: value.message };
  if (Array.isArray(value)) return value.map(toSerializable);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toSerializable(v);
    return out;
  }
  return value;
}

function fmtArg(a: unknown): string {
  if (typeof a === "string") return /\s/.test(a) || a === "" ? JSON.stringify(a) : a;
  if (typeof a === "number" || typeof a === "bigint") return String(a);
  if (Buffer.isBuffer(a)) return JSON.stringify(a.toString("utf8"));
  if (Array.isArray(a)) return a.map(fmtArg).join(" ");
  if (a && typeof a === "object") return JSON.stringify(a);
  return String(a);
}

/** ioredis 메서드명을 Redis 명령 표기로 바꾼다. (hgetall → HGETALL, zrevrangeWithScores 등은 그대로 대문자) */
function cmdName(method: string): string {
  return method.replace(/Buffer$/, "").toUpperCase();
}

const PASSTHROUGH = new Set([
  "then", "catch", "finally", "status", "options", "connect", "disconnect", "quit",
  "on", "once", "off", "emit", "duplicate", "defineCommand", "constructor",
]);

export function createRecorder(): Recorder {
  const steps: Step[] = [];

  const note = (text: string) => {
    steps.push({ cmd: text, result: null, ms: 0, note: true });
  };

  const measure = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      const r = await fn();
      steps.push({ cmd: label, result: toSerializable(r), ms: round(performance.now() - t0) });
      return r;
    } catch (e) {
      steps.push({ cmd: label, result: toSerializable(e), ms: round(performance.now() - t0), error: true });
      throw e;
    }
  };

  const wrapPipeline = (pipeline: unknown, alias: string, kind: "MULTI" | "PIPELINE") => {
    const queued: string[] = [];
    return new Proxy(pipeline as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop);
        if (typeof prop !== "string" || typeof value !== "function") return value;
        if (prop === "exec") {
          return async () => {
            const t0 = performance.now();
            const res = await (value as () => Promise<[Error | null, unknown][] | null>).call(target);
            const flat = res === null ? null : res.map(([err, r]) => (err ? { error: err.message } : toSerializable(r)));
            steps.push({
              cmd: `${alias}${kind === "MULTI" ? "MULTI" : "PIPELINE"} { ${queued.join(" ; ")} } → EXEC`,
              result: flat,
              ms: round(performance.now() - t0),
              error: res === null,
            });
            return res;
          };
        }
        if (PASSTHROUGH.has(prop)) return value.bind(target);
        return (...args: unknown[]) => {
          queued.push(`${cmdName(prop)} ${args.map(fmtArg).join(" ")}`.trim());
          const r = (value as (...a: unknown[]) => unknown).apply(target, args);
          // 체이닝 유지: pipeline.set().get() 형태
          return r === target ? receiver : r;
        };
      },
    });
  };

  const wrap = (client: Redis, alias = ""): Redis => {
    const prefix = alias ? `[${alias}] ` : "";
    return new Proxy(client, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof prop !== "string" || typeof value !== "function") return value;
        if (PASSTHROUGH.has(prop)) return value.bind(target);
        if (prop === "multi" || prop === "pipeline") {
          return (...args: unknown[]) =>
            wrapPipeline((value as (...a: unknown[]) => unknown).apply(target, args), prefix, prop === "multi" ? "MULTI" : "PIPELINE");
        }
        return async (...args: unknown[]) => {
          const label =
            prop === "call"
              ? `${prefix}${String(args[0]).toUpperCase()} ${args.slice(1).map(fmtArg).join(" ")}`.trim()
              : `${prefix}${cmdName(prop)} ${args.map(fmtArg).join(" ")}`.trim();
          const t0 = performance.now();
          try {
            const r = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            steps.push({ cmd: label, result: toSerializable(r), ms: round(performance.now() - t0) });
            return r;
          } catch (e) {
            steps.push({ cmd: label, result: toSerializable(e), ms: round(performance.now() - t0), error: true });
            throw e;
          }
        };
      },
    });
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const check = (label: string, ok: boolean, detail?: unknown) => {
    steps.push({ cmd: `${ok ? "✓" : "✗"} ${label}`, result: toSerializable(detail ?? null), ms: 0, note: true, error: !ok });
    if (!ok) throw new Error(`검증 실패: ${label}`);
  };

  return { steps, note, measure, check, wrap, sleep };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
