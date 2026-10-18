// 사용: pnpm backup  → backups/study-YYYYMMDD-HHMM.json
//       pnpm backup:restore backups/파일.json [merge|replace]
import fs from "node:fs/promises";
import { importBackup, writeBackupFile, type Backup } from "../src/lib/backup";

const [cmd, file, mode] = process.argv.slice(2);
if (cmd === "restore") {
  if (!file) throw new Error("복원할 파일 경로가 필요합니다");
  const b = JSON.parse(await fs.readFile(file, "utf8")) as Backup;
  const r = await importBackup(b, mode === "replace" ? "replace" : "merge");
  console.log(`복원 완료: 키 ${r.keys}개 (${mode === "replace" ? "덮어쓰기" : "합치기"})`);
} else {
  const r = await writeBackupFile();
  console.log(`백업 저장: ${r.file} (키 ${r.keys}개)${r.mirror ? `\n사본: ${r.mirror}` : ""}`);
}
process.exit(0);
