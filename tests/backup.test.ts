import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupMirrorDir } from "@/lib/backup";

describe("백업 사본 위치 (이 Mac 밖)", () => {
  const saved = process.env.STUDY_BACKUP_MIRROR;
  afterEach(() => {
    if (saved === undefined) delete process.env.STUDY_BACKUP_MIRROR;
    else process.env.STUDY_BACKUP_MIRROR = saved;
  });

  it("STUDY_BACKUP_MIRROR=off 면 끈다", () => {
    process.env.STUDY_BACKUP_MIRROR = "off";
    expect(backupMirrorDir()).toBeNull();
  });
  it("폴더를 지정하면 그 폴더", () => {
    process.env.STUDY_BACKUP_MIRROR = "/tmp/study-mirror";
    expect(backupMirrorDir()).toBe("/tmp/study-mirror");
  });
  it("지정하지 않으면 iCloud Drive 가 있을 때만 그 안의 Study Backups", () => {
    delete process.env.STUDY_BACKUP_MIRROR;
    const d = backupMirrorDir();
    if (d) expect(d).toBe(path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "Study Backups"));
    else expect(d).toBeNull(); // CI(리눅스)
  });
});
