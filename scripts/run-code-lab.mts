// 사용: pnpm exec tsx scripts/run-code-lab.mts kafka|postgres [id]
import { listCodeExperiments } from "../src/code-lab";
import { runCodeExperiment } from "../src/code-lab/runner";

const subject = process.argv[2];
const only = process.argv[3];
let failed = 0;
for (const exp of listCodeExperiments(subject).filter((e) => !only || e.id === only)) {
  const r = await runCodeExperiment(exp, exp.id);
  console.log(`${r.ok ? "PASS" : "FAIL"} ${exp.id} (${(r.durationMs / 1000).toFixed(1)}s, ${r.steps.length} steps)`);
  if (!r.ok) {
    failed++;
    console.log("  error:", r.error);
    for (const s of r.steps.filter((s) => s.error)) console.log("  ✗", s.cmd, JSON.stringify(s.result)?.slice(0, 300));
  }
}
process.exit(failed ? 1 : 0);
