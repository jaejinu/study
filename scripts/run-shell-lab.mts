// 사용: pnpm exec tsx scripts/run-shell-lab.mts docker|kubernetes [id]
import { listShellExperiments } from "../src/shell-lab";
import { runShellExperiment } from "../src/shell-lab/runner";
import type { ShellSubject } from "../src/shell-lab/types";

const subject = process.argv[2] as ShellSubject;
const only = process.argv[3];
const list = listShellExperiments(subject).filter((e) => !only || e.id === only);
let failed = 0;
for (const exp of list) {
  const r = await runShellExperiment(exp, exp.id);
  const bad = r.steps.filter((s) => !s.ok);
  console.log(`${r.ok ? "PASS" : "FAIL"} ${exp.id} (${(r.durationMs / 1000).toFixed(1)}s, ${r.steps.length} steps)`);
  if (!r.ok) {
    failed++;
    console.log("  error:", r.error);
    for (const s of bad) console.log("  ✗", s.cmd, "\n   ", s.output.slice(0, 300).replace(/\n/g, "\n    "));
  }
}
process.exit(failed ? 1 : 0);
