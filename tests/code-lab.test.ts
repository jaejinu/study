import { describe, expect, it } from "vitest";
import { getCodeExperiment } from "@/code-lab";
import { runCodeExperiment } from "@/code-lab/runner";

/**
 * CI 에서도 도는 코드 실험 — 외부 컨테이너 없이 프로세스 안(또는 CI 의 Redis 서비스)만으로 동작하는 것들.
 * Docker 컨테이너·클러스터·브로커가 필요한 실험은 로컬 실험실에서 돌린다.
 */
const PURE: [subject: string, id: string][] = [
  ["distributed-systems", "ds-lamport-vector-clock"],
  ["testing", "test-mutation-mini"],
  ["api-design", "api-grpc-unary-vs-stream"],
  ["api-design", "api-grpc-deadline-cancel"],
];
const WITH_REDIS: [subject: string, id: string][] = [
  ["distributed-systems", "ds-fencing-token"],
  ["testing", "test-property-ratelimit"],
  ["api-design", "api-idempotency-key"],
];

describe.each([...PURE, ...WITH_REDIS])("code-lab %s/%s", (subject, id) => {
  it("PASS", async () => {
    const exp = getCodeExperiment(subject, id);
    expect(exp, `${subject}/${id} 가 레지스트리에 없음`).toBeDefined();
    const r = await runCodeExperiment(exp, id);
    const failed = r.steps.filter((s) => s.error).map((s) => s.cmd);
    expect(r.ok, `${r.error ?? ""} ${failed.join(" | ")}`).toBe(true);
  }, 60_000);
});
