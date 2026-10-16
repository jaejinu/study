import { createRecorder } from "@/lib/trace";
import type { CodeExperiment, CodeResult } from "./types";
import { isReadOnly, READ_ONLY_MESSAGE } from "@/lib/read-only";

export async function runCodeExperiment(exp: CodeExperiment | undefined, id: string): Promise<CodeResult> {
  const ranAt = new Date().toISOString();
  if (!exp) return { id, ok: false, steps: [], durationMs: 0, error: `실험을 찾을 수 없음: ${id}`, ranAt };
  if (isReadOnly()) return { id, ok: false, steps: [], durationMs: 0, error: READ_ONLY_MESSAGE, ranAt };
  const rec = createRecorder();
  const t0 = performance.now();
  try {
    if (exp.requires) {
      const problem = await exp.requires();
      if (problem) return { id, ok: false, steps: [], durationMs: 0, error: problem, ranAt };
    }
    await exp.run({ rec, k: (name) => `lab_${exp.id.replace(/-/g, "_")}_${name}` });
    return { id, ok: true, steps: rec.steps, durationMs: Math.round(performance.now() - t0), ranAt };
  } catch (e) {
    return { id, ok: false, steps: rec.steps, durationMs: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e), ranAt };
  }
}
