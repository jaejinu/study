import { exportBackup, listBackupFiles, summarize } from "@/lib/backup";
import { RecordsActions } from "./RecordsActions";
import { isReadOnly } from "@/lib/read-only";
import { ReadOnlyPageNotice } from "@/components/ReadOnlyNotice";

export const dynamic = "force-dynamic";
export const metadata = { title: "학습 기록" };

const LABEL: Record<string, string> = { "progress:read": "읽은 노트", "progress:checks": "체크리스트", "progress:lab": "통과한 실험", "quiz:stats": "퀴즈 기록(주제)", "study:time": "노트별 학습 시간", "study:day": "일별 학습 시간", "lab:runs": "실험 실행 이력", memo: "노트 메모" };

export default async function RecordsPage() {
  if (isReadOnly())
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-4 text-2xl font-bold tracking-tight">학습 기록</h1>
        <ReadOnlyPageNotice title="학습 기록·백업은 로컬에서만 동작합니다" commands={"pnpm backup                              # 로컬 Redis 의 기록을 backups/ 로 내보내기\npnpm backup:restore backups/파일.json   # 가져오기"}>
          읽기 전용 공개판은 진행 기록을 서버에 저장하지 않으므로 내보내거나 가져올 기록이 없습니다.
        </ReadOnlyPageNotice>
      </div>
    );
  let summary: Record<string, number> = {};
  let error = "";
  try {
    summary = summarize(await exportBackup());
  } catch (e) {
    error = (e as Error).message;
  }
  const files = await listBackupFiles();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight">학습 기록</h1>
      <p className="mt-1 text-sm text-muted">진행률·퀴즈 기록·학습 시간·실험 이력은 이 앱의 Redis 에만 저장됩니다. 내보내 두면 Redis 를 지우거나 다른 기기로 옮겨도 이어서 공부할 수 있습니다.</p>

      <section className="mt-6 rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-3 font-semibold">지금 저장된 기록</h2>
        {error ? (
          <p className="text-sm text-warn">Redis 에 연결할 수 없습니다 — {error}</p>
        ) : Object.keys(summary).length === 0 ? (
          <p className="text-sm text-muted">아직 기록이 없습니다. 노트를 읽음으로 표시하거나 퀴즈를 풀면 쌓입니다.</p>
        ) : (
          <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
            {Object.entries(summary).map(([k, n]) => (
              <li key={k} className="flex justify-between rounded border border-border px-3 py-1.5">
                <span>{LABEL[k] ?? k}</span>
                <span className="font-mono text-muted">{n}개 키</span>
              </li>
            ))}
          </ul>
        )}
        <RecordsActions />
      </section>

      <section className="mt-6 rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 font-semibold">자동 백업</h2>
        <p className="mb-3 text-[13px] text-muted">서버가 켜져 있으면 하루 한 번 <code>backups/</code> 폴더에 저장하고 최근 14개만 남깁니다. 터미널에서는 <code>pnpm backup</code>, 복원은 <code>pnpm backup:restore backups/파일.json</code>.</p>
        {files.length === 0 ? (
          <p className="text-sm text-muted">아직 자동 백업 파일이 없습니다.</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {files.slice(0, 14).map((f) => (
              <li key={f.name} className="flex justify-between font-mono">
                <span>{f.name}</span>
                <span className="text-muted">
                  {(f.size / 1024).toFixed(1)}KB · {new Date(f.mtime).toLocaleString("ko-KR")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
