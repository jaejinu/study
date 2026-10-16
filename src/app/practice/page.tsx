import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { getSubject } from "@/lib/subjects";
import { openaiConfigured, PRACTICE_MODEL, NO_KEY_MESSAGE } from "@/lib/practice/llm";
import { recentPractice } from "@/lib/practice/store";
import { readEvalReport } from "@/lib/practice/eval";
import { listNotes } from "@/lib/notes";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI 학습 모드" };

const MODES = [
  { href: "/practice/explain", icon: "✍", title: "설명해 보기", desc: "노트(또는 한 섹션)를 내 말로 설명하면, 노트의 핵심 개념 체크리스트와 대조해 점수·빠진 개념·틀린 주장(노트 근거 인용)·꼬리 질문을 돌려줍니다." },
  { href: "/practice/interview", icon: "🎤", title: "면접 모드", desc: "주제의 노트와 퀴즈 카드를 근거로 면접관이 질문합니다. 답할 때마다 짧은 평가와 꼬리 질문, 3~5턴 뒤 잘한 점·보완할 점·다시 볼 노트를 요약합니다." },
  { href: "#eval", icon: "⚖", title: "모델 비교", desc: "퀴즈 골든셋 30문항으로 로컬 모델(1.5B vs 3B)의 답을 키워드 재현율·심판 점수·지연·토큰으로 비교합니다. pnpm tsx scripts/eval-ask.mts" },
];

const fmtTime = (at: number) => new Date(at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default async function PracticePage() {
  const configured = openaiConfigured();
  const [recent, report] = await Promise.all([recentPractice(8), readEvalReport()]);
  const titles = new Map<string, string>();
  await Promise.all(
    [...new Set(recent.explain.map((e) => e.subject))].map(async (s) => {
      for (const n of await listNotes(s)) titles.set(`${s}/${n.slug}`, n.title);
    }),
  );
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="AI 학습 모드" subtitle="읽은 것을 말로 꺼내 보는 연습 — 설명하고, 질문받고, 모델이 얼마나 믿을 만한지까지 확인합니다." />
      {!configured && <div className="mb-5 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-[13.5px]">{NO_KEY_MESSAGE}</div>}
      {configured && <p className="mb-4 text-[12.5px] text-muted">현재 모델: {PRACTICE_MODEL} {process.env.OPENAI_BASE_URL ? `· ${process.env.OPENAI_BASE_URL}` : ""}</p>}

      <div className="grid gap-3 md:grid-cols-3">
        {MODES.map((m) => (
          <Link key={m.title} href={m.href} className="rounded-xl border border-border bg-surface p-4 transition-colors hover:border-muted">
            <div className="text-xl">{m.icon}</div>
            <div className="mt-1 font-semibold">{m.title}</div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">{m.desc}</p>
          </Link>
        ))}
      </div>

      <section className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold">최근 설명해 보기</h2>
          {recent.explain.length === 0 ? (
            <p className="text-[13px] text-muted">아직 기록이 없습니다. 노트 하단의 &ldquo;이 노트로 설명해 보기&rdquo; 에서 시작해 보세요.</p>
          ) : (
            <ul className="space-y-1.5 text-[13.5px]">
              {recent.explain.map((e) => (
                <li key={`${e.subject}/${e.slug}`} className="flex items-center gap-2">
                  <span className={`w-10 text-right font-semibold ${e.score >= 70 ? "text-ok" : e.score >= 40 ? "text-warn" : "text-accent"}`}>{e.score}</span>
                  <Link href={`/practice/explain?subject=${e.subject}&slug=${e.slug}`} className="min-w-0 flex-1 truncate hover:underline">
                    {titles.get(`${e.subject}/${e.slug}`) ?? e.slug}
                  </Link>
                  <span className="text-[11.5px] text-muted">{getSubject(e.subject)?.name} · {fmtTime(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold">최근 면접</h2>
          {recent.interview.length === 0 ? (
            <p className="text-[13px] text-muted">아직 기록이 없습니다.</p>
          ) : (
            <ul className="space-y-2 text-[13px]">
              {recent.interview.map((r) => (
                <li key={`${r.subject}-${r.at}`}>
                  <div className="flex items-center gap-2">
                    <Link href={`/practice/interview?subject=${r.subject}`} className="font-medium hover:underline">
                      {getSubject(r.subject)?.name ?? r.subject}
                    </Link>
                    <span className="text-muted">· {r.level} · {r.turns}턴 · {fmtTime(r.at)}</span>
                  </div>
                  <p className="clamp-2 text-muted">{r.summary.replace(/[#*>`-]/g, " ").replace(/\s+/g, " ").slice(0, 160)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section id="eval" className="mt-8 scroll-mt-16 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold">모델 비교 — AI 에게 묻기 품질 평가</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          퀴즈 카드 30장(주제별로 고르게, 시드 고정)을 &ldquo;AI 에게 묻기&rdquo; 와 같은 방식(검색 증강 포함)으로 각 모델에 묻고, 정답 키워드 재현율과 같은 심판 모델의 0~10점, 지연·토큰을 잽니다.
        </p>
        {!report ? (
          <p className="mt-3 text-[13px]">
            아직 결과가 없습니다. 실행: <code className="rounded bg-surface-2 px-1">OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 pnpm tsx scripts/eval-ask.mts</code>
          </p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead className="text-left text-[11.5px] text-muted">
                  <tr className="border-b border-border">
                    <th className="py-1.5 pr-3">모델</th>
                    <th className="pr-3 text-right">키워드 재현율</th>
                    <th className="pr-3 text-right">심판 점수 (0~10)</th>
                    <th className="pr-3 text-right">지연 p50</th>
                    <th className="pr-3 text-right">평균 지연</th>
                    <th className="pr-3 text-right">출력 토큰</th>
                    <th className="text-right">오류</th>
                  </tr>
                </thead>
                <tbody>
                  {report.models.map((m) => (
                    <tr key={m.model} className="border-b border-border/60">
                      <td className="py-1.5 pr-3 font-medium">{m.model}</td>
                      <td className="pr-3 text-right">{(m.recall * 100).toFixed(0)}%</td>
                      <td className="pr-3 text-right">{m.judge.toFixed(1)}</td>
                      <td className="pr-3 text-right">{(m.latencyP50Ms / 1000).toFixed(1)}초</td>
                      <td className="pr-3 text-right">{(m.latencyAvgMs / 1000).toFixed(1)}초</td>
                      <td className="pr-3 text-right">{Math.round(m.outputTokens / Math.max(1, m.n))}/문항</td>
                      <td className="text-right">{m.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11.5px] text-muted">
              {new Date(report.at).toLocaleString("ko-KR")} · 문항 {report.models[0]?.n ?? 0}개 · 시드 {report.seed} · 심판 {report.judge}
              {report.baseUrl ? ` · ${report.baseUrl}` : ""}
            </p>
            <details className="mt-3 text-[12.5px]">
              <summary className="cursor-pointer text-muted">문항별 결과 보기</summary>
              <ul className="mt-2 space-y-2">
                {[...new Set(report.items.map((i) => `${i.subject}|${i.q}`))].slice(0, 30).map((k) => {
                  const rows = report.items.filter((i) => `${i.subject}|${i.q}` === k);
                  return (
                    <li key={k} className="rounded border border-border bg-background p-2">
                      <div className="font-medium">
                        <span className="text-muted">[{getSubject(rows[0].subject)?.name ?? rows[0].subject}]</span> {rows[0].q}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-4 text-muted">
                        {rows.map((r) => (
                          <span key={r.model}>
                            {r.model}: 재현율 {(r.recall * 100).toFixed(0)}% · 심판 {r.judge ?? "-"} · {(r.ms / 1000).toFixed(1)}초
                          </span>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </details>
          </>
        )}
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-muted">
          OpenAI 키를 설정하면 같은 스크립트로 gpt-5-mini 도 비교할 수 있습니다: <code>OPENAI_API_KEY=sk-... pnpm tsx scripts/eval-ask.mts gpt-5-mini</code> (심판은 목록의 마지막 모델, <code>EVAL_JUDGE</code> 로 바꿀 수 있음). 결과 파일 <code>reports/eval-ask.json</code> 은 git 에 올라가지 않습니다.
        </p>
      </section>
    </div>
  );
}
