import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { InterviewChat } from "@/components/practice/InterviewChat";
import { Markdown } from "@/components/Markdown";
import { listNotes } from "@/lib/notes";
import { loadQuiz } from "@/lib/quiz";
import { getSubject, subjects } from "@/lib/subjects";
import { openaiConfigured, NO_KEY_MESSAGE } from "@/lib/practice/llm";
import { getInterviewHistory } from "@/lib/practice/store";
import { isAiEnabled } from "@/lib/read-only";
import { AiDisabledPage } from "@/components/ReadOnlyNotice";

export const dynamic = "force-dynamic";
export const metadata = { title: "면접 모드" };

export default async function InterviewPage({ searchParams }: { searchParams: Promise<{ subject?: string }> }) {
  if (!isAiEnabled()) return <AiDisabledPage title="면접 모드" />;
  const { subject: sid } = await searchParams;
  const configured = openaiConfigured();
  const subject = sid ? getSubject(sid) : undefined;

  if (!subject) {
    const rows = (await Promise.all(subjects.map(async (s) => ({ s, n: (await listNotes(s.id)).length, q: (await loadQuiz(s.id)).length })))).filter((x) => x.n > 0);
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="면접 모드" subtitle="면접을 볼 주제를 고르세요. 질문은 그 주제의 노트와 퀴즈 카드에서 나옵니다." />
        {!configured && <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-[13.5px]">{NO_KEY_MESSAGE}</div>}
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
          {rows.map(({ s, n, q }) => (
            <Link key={s.id} href={`/practice/interview?subject=${s.id}`} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:border-muted">
              <span className={`grid h-6 w-6 place-items-center rounded text-[11px] font-bold text-white ${s.color}`}>{s.mark}</span>
              <span className="flex-1">{s.name}</span>
              <span className="text-[11px] text-muted">노트 {n} · 카드 {q}</span>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  const history = await getInterviewHistory(subject.id);
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <Link href="/practice" className="hover:text-foreground">AI 학습 모드</Link>
        <span>/</span>
        <Link href="/practice/interview" className="hover:text-foreground">면접 모드</Link>
      </div>
      <PageHeader title={`면접 모드 · ${subject.name}`} subtitle="난이도를 고르고 시작하세요. 답할 때마다 짧은 평가와 꼬리 질문이 이어지고, 3~5번 답한 뒤 요약을 받으면 기록에 남습니다." />
      {!configured && <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-[13.5px]">{NO_KEY_MESSAGE}</div>}
      <InterviewChat subject={subject.id} subjectName={subject.name} configured={configured} />
      {history.length > 0 && (
        <section className="mt-10 border-t border-border pt-5">
          <h2 className="mb-2 text-sm font-semibold">지난 면접 요약 (최근 {history.length}회)</h2>
          <div className="space-y-2">
            {history.map((h) => (
              <details key={h.at} className="rounded-lg border border-border bg-surface px-4 py-2 text-[13px]">
                <summary className="cursor-pointer">
                  {new Date(h.at).toLocaleString("ko-KR")} · {h.level} · {h.turns}턴
                </summary>
                <div className="mt-2">
                  <Markdown content={h.summary} small />
                </div>
                {h.notes.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
                    {h.notes.map((n) => (
                      <Link key={n} href={n} className="text-info hover:underline">{n}</Link>
                    ))}
                  </div>
                )}
              </details>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
