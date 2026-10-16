import Link from "next/link";
import { fmtDuration, type WeeklyStudy as Weekly } from "@/lib/study";
import { subjects } from "@/lib/subjects";
import { Card } from "./ui";

export function WeeklyStudyCard({ weekly, dueBySubject }: { weekly: Weekly; dueBySubject: Record<string, number> }) {
  const max = Math.max(60, ...weekly.days.map((d) => d.seconds));
  const top = Object.entries(weekly.bySubject).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const dueTotal = Object.values(dueBySubject).reduce((a, b) => a + b, 0);
  const name = (id: string) => subjects.find((s) => s.id === id)?.name ?? id;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">이번 주 학습</h2>
        <span className="text-sm text-muted">
          7일 합계 <span className="font-mono text-foreground">{fmtDuration(weekly.totalSeconds)}</span>
        </span>
      </div>
      <div className="mt-4 grid gap-6 md:grid-cols-[1fr_260px]">
        <div>
          <div className="flex h-24 items-end gap-2">
            {weekly.days.map((d) => (
              <div key={d.date} className="flex flex-1 flex-col items-center gap-1" title={`${d.date}: ${fmtDuration(d.seconds)}`}>
                <span className="text-[10px] text-muted">{d.seconds > 0 ? fmtDuration(d.seconds) : ""}</span>
                <div className="w-full rounded-t bg-info/70" style={{ height: `${Math.max(2, (d.seconds / max) * 70)}px` }} />
                <span className="text-[11px] text-muted">{d.label}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">노트를 읽는 동안 탭이 보이고 활동이 있을 때만 30초 단위로 기록됩니다 (Redis `study:day:*`).</p>
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <div className="mb-1 text-xs text-muted">주제별 (7일)</div>
            {top.length === 0 ? (
              <p className="text-muted">아직 기록이 없습니다. 노트를 읽기 시작하면 쌓입니다.</p>
            ) : (
              <ul className="space-y-0.5">
                {top.map(([id, sec]) => (
                  <li key={id} className="flex justify-between">
                    <Link href={`/${id}`} className="hover:underline">{name(id)}</Link>
                    <span className="font-mono text-muted">{fmtDuration(sec)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">복습 기한이 지난 카드</div>
            {dueTotal === 0 ? (
              <p className="text-muted">없음 — 퀴즈를 풀면 틀린 카드가 1일·3일·7일·14일 간격으로 돌아옵니다.</p>
            ) : (
              <ul className="space-y-0.5">
                {Object.entries(dueBySubject).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([id, n]) => (
                  <li key={id} className="flex justify-between">
                    <Link href={`/${id}/quiz`} className="text-warn hover:underline">{name(id)} 퀴즈</Link>
                    <span className="font-mono text-warn">{n}장</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
