import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { armDeadman } from "@/lib/deadman";

/** 데드맨 스위치: 실험 프로세스와 독립적으로 원복 명령을 실행하고, disarm 하면 실행하지 않는다 */
describe("deadman switch", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deadman-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("장전하면 N 초 뒤 원복 명령이 실행된다", async () => {
    const f = path.join(dir, "fired");
    armDeadman(`touch '${f}'`, 1);
    expect(existsSync(f)).toBe(false);
    await new Promise((r) => setTimeout(r, 1800));
    expect(existsSync(f)).toBe(true);
  });

  it("disarm 하면 원복 명령이 실행되지 않는다", async () => {
    const f = path.join(dir, "disarmed");
    const g = armDeadman(`touch '${f}'`, 1);
    g.disarm();
    g.disarm(); // 두 번 호출해도 안전
    await new Promise((r) => setTimeout(r, 1800));
    expect(existsSync(f)).toBe(false);
  });
});
