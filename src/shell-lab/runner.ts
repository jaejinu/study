import { execFile } from "node:child_process";
import type { ShellCtx, ShellExperiment, ShellResult, ShellStep, ShResult } from "./types";

const MAX_OUT = 6000;

export function exec(bin: string, args: string[], opts: { timeout?: number; input?: string } = {}): Promise<ShResult> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: opts.timeout ?? 60_000, env: process.env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ ok: !err, code, out: String(stdout).trim(), err: String(stderr || (err && !stderr ? err.message : "")).trim() });
      },
    );
    if (opts.input) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

function quote(a: string): string {
  return /[\s"'$|&;<>()]/.test(a) || a === "" ? JSON.stringify(a) : a;
}

function clip(s: string): string {
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n… (${s.length - MAX_OUT}자 생략)` : s;
}

export function createShellCtx(steps: ShellStep[]): ShellCtx {
  const push = (s: ShellStep) => steps.push(s);
  const sh: ShellCtx["sh"] = async (bin, args, opts = {}) => {
    const label = opts.label ?? `${bin} ${args.map(quote).join(" ")}`;
    const t0 = performance.now();
    const r = await exec(bin, args, { timeout: opts.timeout, input: opts.input });
    const ms = Math.round(performance.now() - t0);
    const output = clip([r.out, r.err].filter(Boolean).join(r.out && r.err ? "\n--- stderr ---\n" : ""));
    push({ cmd: label, output, ms, ok: r.ok });
    if (!r.ok && !opts.allowFail) throw new Error(`명령 실패 (exit ${r.code}): ${label}\n${r.err || r.out}`);
    return r;
  };
  return {
    sh,
    note: (text) => push({ cmd: text, output: "", ms: 0, ok: true, note: true }),
    check: (label, ok, detail) => {
      push({ cmd: `${ok ? "✓" : "✗"} ${label}`, output: detail ?? "", ms: 0, ok, note: true });
      if (!ok) throw new Error(`검증 실패: ${label}`);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    poll: async (label, fn, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? 90_000;
      const intervalMs = opts.intervalMs ?? 1000;
      const t0 = performance.now();
      let tries = 0;
      while (performance.now() - t0 < timeoutMs) {
        tries++;
        const v = await fn();
        if (v !== undefined) {
          push({ cmd: `⏳ ${label}`, output: `${tries}회 확인 후 만족`, ms: Math.round(performance.now() - t0), ok: true, note: true });
          return v;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      push({ cmd: `⏳ ${label}`, output: `시간 초과 (${timeoutMs}ms)`, ms: Math.round(performance.now() - t0), ok: false, note: true });
      throw new Error(`대기 시간 초과: ${label}`);
    },
    table: (label, columns, rows) => push({ cmd: label, output: "", ms: 0, ok: true, note: true, data: { type: "table", columns, rows } }),
    layers: (label, rows) => push({ cmd: label, output: "", ms: 0, ok: true, note: true, data: { type: "layers", rows } }),
    measure: async (label, fn) => {
      const t0 = performance.now();
      const value = await fn();
      const ms = Math.round(performance.now() - t0);
      push({ cmd: label, output: `${ms}ms`, ms, ok: true, note: true });
      return { value, ms };
    },
  };
}

export async function runShellExperiment(exp: ShellExperiment | undefined, id: string): Promise<ShellResult> {
  const ranAt = new Date().toISOString();
  if (!exp) return { id, ok: false, steps: [], durationMs: 0, error: `실험을 찾을 수 없음: ${id}`, ranAt };
  const steps: ShellStep[] = [];
  const ctx = createShellCtx(steps);
  const t0 = performance.now();
  try {
    if (exp.requires) {
      const problem = await exp.requires();
      if (problem) return { id, ok: false, steps, durationMs: 0, error: problem, ranAt };
    }
    if (exp.cleanup) {
      ctx.note("이전 실행 잔여물 정리");
      await exp.cleanup(ctx);
    }
    await exp.run(ctx);
    return { id, ok: true, steps, durationMs: Math.round(performance.now() - t0), ranAt };
  } catch (e) {
    return { id, ok: false, steps, durationMs: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e), ranAt };
  } finally {
    if (exp.cleanup) {
      try {
        ctx.note("정리");
        await exp.cleanup(ctx);
      } catch {
        /* 정리 실패는 무시 */
      }
    }
  }
}
