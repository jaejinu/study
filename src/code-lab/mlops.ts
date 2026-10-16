import { loadQuiz, type QuizCard } from "@/lib/quiz";
import type { CodeExperiment } from "./types";

/**
 * MLOps · LLM 평가 실험. 로컬 Ollama(OpenAI 호환 /v1/chat/completions)와 MLflow REST 를 쓴다.
 *   OLLAMA_URL (기본 http://127.0.0.1:11434), MLOPS_MODEL (기본 qwen2.5:1.5b), MLFLOW_URL (기본 http://127.0.0.1:15000)
 */
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.MLOPS_MODEL ?? "qwen2.5:1.5b";
const MLFLOW = process.env.MLFLOW_URL ?? "http://127.0.0.1:15000";

async function requiresOllama(): Promise<string | null> {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { models?: { name: string }[] };
    if (!j.models?.some((m) => m.name === MODEL)) return `Ollama 는 떠 있지만 모델 ${MODEL} 이 없습니다: ollama pull ${MODEL}`;
    return null;
  } catch {
    return `Ollama(${OLLAMA}) 에 연결할 수 없습니다: brew install ollama && ollama serve && ollama pull ${MODEL}`;
  }
}

type ChatOpts = { maxTokens?: number; temperature?: number; system?: string };

/** 스트리밍 1회 호출: TTFT·총 시간·토큰 수·청크 간격을 잰다 */
async function chatStream(prompt: string, opts: ChatOpts = {}) {
  const t0 = performance.now();
  const res = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature ?? 0,
      seed: 7,
      max_tokens: opts.maxTokens ?? 64,
      messages: [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: prompt }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let ttft = 0;
  let chunks = 0;
  let last = 0;
  const gaps: number[] = [];
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const j = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[]; usage?: typeof usage };
      if (j.usage) usage = j.usage;
      const piece = j.choices?.[0]?.delta?.content;
      if (piece) {
        const now = performance.now();
        if (!ttft) ttft = now - t0;
        else gaps.push(now - last);
        last = now;
        chunks++;
        text += piece;
      }
    }
  }
  const total = performance.now() - t0;
  const outTokens = usage?.completion_tokens ?? chunks;
  const decodeMs = total - ttft;
  return {
    text,
    ttft,
    total,
    outTokens,
    promptTokens: usage?.prompt_tokens ?? 0,
    tpot: outTokens > 1 ? decodeMs / (outTokens - 1) : 0,
    gapP50: gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0,
  };
}

/** 비스트리밍 짧은 호출 (judge 용) */
async function chat(prompt: string, opts: ChatOpts = {}): Promise<string> {
  const res = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: opts.temperature ?? 0,
      seed: 7,
      max_tokens: opts.maxTokens ?? 160,
      messages: [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { choices: { message: { content: string } }[] };
  return j.choices[0]?.message.content ?? "";
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// ------------------------------------------------------------------ 서빙 지표
export const mlopsOllamaServing: CodeExperiment = {
  id: "mlops-ollama-serving",
  subject: "mlops",
  title: "로컬 LLM 서빙 지표: TTFT·TPOT·토큰/초를 재고, 동시 요청 1·2·4 에서 대기열이 지연을 어떻게 바꾸는지 본다",
  category: "서빙",
  summary: "Ollama 의 OpenAI 호환 스트리밍 API 로 같은 프롬프트를 보내 첫 토큰까지 시간(TTFT, prefill), 토큰 간 간격(TPOT, decode), 출력 토큰/초를 측정하고, 동시 요청을 늘렸을 때 개별 지연과 전체 처리량이 어떻게 갈리는지(배칭 vs 대기열) 표로 비교한다",
  notes: ["05-serving-batching-kv-cache", "01-ml-system-lifecycle"],
  description: `
LLM 응답 시간은 한 숫자가 아니다. **TTFT**(입력 전체를 한 번에 처리하는 prefill, 입력이 길수록 길다) 와 **TPOT**(토큰을 하나씩 만드는 decode, 메모리 대역폭에 묶인다) 로 나뉘고, 총 지연 ≈ TTFT + TPOT × (출력 토큰 − 1) 이다.
동시 요청이 늘면 서버는 둘 중 하나를 한다: **배칭**(여러 요청의 decode 를 한 스텝에 묶어 처리량을 올림 — vLLM 의 연속 배칭) 또는 **대기열**(한 번에 하나씩, 뒤 요청의 TTFT 가 앞 요청 길이만큼 늘어남). Ollama 는 \`OLLAMA_NUM_PARALLEL\` 만큼만 동시에 돌린다.
이 실험은 같은 프롬프트를 1·2·4 동시로 보내 개별 TTFT 분포와 전체 토큰/초를 비교한다. 숫자는 이 Mac(Apple Silicon, ${MODEL}) 기준이다.
`,
  code: `curl -N localhost:11434/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "qwen2.5:1.5b", "stream": true, "stream_options": {"include_usage": true},
  "temperature": 0, "max_tokens": 64,
  "messages": [{"role": "user", "content": "Redis 파이프라인을 두 문장으로 설명해 줘"}] }'
# 첫 data: 청크 도착 = TTFT, 이후 청크 간격 = TPOT, 마지막 청크의 usage.completion_tokens = 출력 토큰
# 동시성: 같은 요청을 N 개 병렬로 → 개별 TTFT 가 늘어나는지(대기열) / 전체 토큰/초가 늘어나는지(배칭)`,
  requires: requiresOllama,
  async run({ rec }) {
    const prompt = "Redis 파이프라인이 왕복 시간(RTT)을 줄이는 원리를 한국어 두 문장으로 설명해 줘.";
    rec.note(`모델 ${MODEL}, temperature 0, max_tokens 64. 첫 호출은 모델 로딩(콜드 스타트)을 포함하므로 따로 잰다`);
    const cold = await rec.measure("워밍업 호출 (모델이 메모리에 없으면 로딩 시간 포함)", () => chatStream(prompt));
    rec.steps.push({ cmd: "워밍업 결과", result: { TTFT_ms: Math.round(cold.ttft), 총_ms: Math.round(cold.total), 출력토큰: cold.outTokens, 입력토큰: cold.promptTokens }, ms: 0 });

    const single = [];
    for (let i = 0; i < 3; i++) single.push(await chatStream(prompt));
    const s = single[single.length - 1];
    rec.steps.push({
      cmd: "단일 요청 3회 (웜)",
      result: single.map((x, i) => ({ 회차: i + 1, TTFT_ms: Math.round(x.ttft), TPOT_ms: r1(x.tpot), 출력토큰: x.outTokens, 총_ms: Math.round(x.total), "토큰/초": r1((x.outTokens / x.total) * 1000) })),
      ms: 0,
    });
    rec.check("출력 토큰이 생성되고 TTFT·TPOT 가 측정됐다", s.outTokens > 1 && s.ttft > 0 && s.tpot > 0, { ttft: s.ttft, tpot: s.tpot });
    const est = s.ttft + s.tpot * (s.outTokens - 1);
    rec.check("총 지연 ≈ TTFT + TPOT × (출력 토큰 − 1) (오차 10% 이내)", Math.abs(est - s.total) / s.total < 0.1, { 측정: Math.round(s.total), 추정: Math.round(est) });

    // 프롬프트(접두) 캐시: 같은 입력을 다시 보내면 서버가 이전 KV 캐시를 재사용해 prefill 을 건너뛴다.
    // 앞에 고유 문자열을 붙이면 캐시가 깨져 진짜 prefill 비용이 드러난다.
    const nonce = () => `[요청 ${Math.random().toString(36).slice(2, 10)}] `;
    const body = `${"Redis 는 단일 스레드 이벤트 루프로 명령을 순서대로 실행한다. 파이프라인은 여러 명령을 한 번에 보내 왕복을 줄인다. ".repeat(40)}\n질문: 파이프라인의 효과를 한 문장으로.`;
    const shortMiss = await chatStream(nonce() + prompt);
    const longMiss = await chatStream(nonce() + body);
    const longHitPrompt = nonce() + body;
    await chatStream(longHitPrompt);
    const longHit = await chatStream(longHitPrompt);
    rec.steps.push({
      cmd: "prefill 비용과 프롬프트(KV) 캐시 — 앞에 고유 문자열을 붙여 캐시를 깬 경우 vs 같은 입력을 다시 보낸 경우",
      result: [
        { 경우: "짧은 입력, 캐시 미스", 입력토큰: shortMiss.promptTokens, TTFT_ms: Math.round(shortMiss.ttft), TPOT_ms: r1(shortMiss.tpot) },
        { 경우: "긴 입력, 캐시 미스", 입력토큰: longMiss.promptTokens, TTFT_ms: Math.round(longMiss.ttft), TPOT_ms: r1(longMiss.tpot), "prefill 토큰/초": Math.round((longMiss.promptTokens / longMiss.ttft) * 1000) },
        { 경우: "긴 입력, 같은 입력 재전송(캐시 적중)", 입력토큰: longHit.promptTokens, TTFT_ms: Math.round(longHit.ttft), TPOT_ms: r1(longHit.tpot) },
      ],
      ms: 0,
    });
    rec.check("입력이 길면 TTFT(prefill)가 늘어난다 — 캐시 미스끼리 비교", longMiss.ttft > shortMiss.ttft * 2, { 짧은: Math.round(shortMiss.ttft), 긴: Math.round(longMiss.ttft) });
    rec.check("같은 입력을 다시 보내면 접두 캐시로 TTFT 가 크게 줄어든다", longHit.ttft < longMiss.ttft / 2, { 미스: Math.round(longMiss.ttft), 적중: Math.round(longHit.ttft) });
    rec.check("TPOT(decode)는 입력 길이·캐시와 거의 무관하다 (±50%)", Math.abs(longMiss.tpot - shortMiss.tpot) / shortMiss.tpot < 0.5, { 짧은: r1(shortMiss.tpot), 긴: r1(longMiss.tpot) });
    rec.note("위 '단일 요청 3회' 의 TTFT 가 아주 짧은 것도 같은 프롬프트라 캐시에 맞았기 때문이다. 벤치마크를 잴 때 캐시 적중/미스를 섞으면 숫자가 거짓말을 한다 — AI 노트 05 의 프롬프트 캐시와 같은 원리.");

    const rows: Record<string, unknown>[] = [];
    const byConc: Record<number, { ttftMax: number; ttftMin: number; tps: number }> = {};
    for (const conc of [1, 2, 4]) {
      const t0 = performance.now();
      const results = await Promise.all(Array.from({ length: conc }, () => chatStream(nonce() + prompt)));
      const wall = performance.now() - t0;
      const ttfts = results.map((x) => x.ttft);
      const tokens = results.reduce((a, x) => a + x.outTokens, 0);
      byConc[conc] = { ttftMax: Math.max(...ttfts), ttftMin: Math.min(...ttfts), tps: (tokens / wall) * 1000 };
      rows.push({
        동시: conc,
        "TTFT 최소_ms": Math.round(Math.min(...ttfts)),
        "TTFT 최대_ms": Math.round(Math.max(...ttfts)),
        "TPOT p50_ms": r1(pct(results.map((x) => x.tpot), 50)),
        "벽시계_ms": Math.round(wall),
        "전체 토큰/초": r1((tokens / wall) * 1000),
      });
    }
    rec.steps.push({ cmd: "동시 요청 1·2·4 (캐시 미스가 되도록 요청마다 고유 접두)", result: rows, ms: 0 });
    rec.check("동시 4 에서 가장 늦은 요청의 TTFT 가 단일보다 길다 (대기열이든 배칭이든 공짜는 없다)", byConc[4].ttftMax > byConc[1].ttftMax, { 단일: Math.round(byConc[1].ttftMax), 동시4: Math.round(byConc[4].ttftMax) });
    const queued = byConc[4].ttftMax > byConc[4].ttftMin * 2.5;
    rec.note(
      queued
        ? `동시 4 의 TTFT 가 ${Math.round(byConc[4].ttftMin)}ms ~ ${Math.round(byConc[4].ttftMax)}ms 로 계단처럼 벌어졌다 → 요청이 대기열에서 차례를 기다린다 (OLLAMA_NUM_PARALLEL 이 작음). 전체 토큰/초는 ${r1(byConc[1].tps)} → ${r1(byConc[4].tps)}.`
        : `동시 4 의 TTFT 가 고르게 늘었다 → 요청들이 함께 처리(배칭)된다. 전체 토큰/초 ${r1(byConc[1].tps)} → ${r1(byConc[4].tps)} — 처리량은 오르고 개별 지연은 늘어나는 배칭의 전형.`,
    );
    rec.note("vLLM 같은 연속 배칭 서버는 decode 스텝마다 요청을 넣고 빼서 GPU 를 꽉 채운다. 처리량(토큰/초)과 개별 지연(TTFT·TPOT)의 교환을 SLO 로 정해야 한다 — 노트 05.");
  },
};

// ------------------------------------------------------------------ 평가 하네스
const STOP = new Set(["그리고", "하지만", "때문에", "있다", "없다", "한다", "된다", "이다", "것이", "것을", "수", "등", "더", "the", "and", "for", "with"]);
const JOSA = ["에서", "으로", "에게", "까지", "부터", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만"];
function keywords(s: string): string[] {
  const out = new Set<string>();
  for (let w of s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
    if (/[가-힣]$/.test(w)) for (const j of JOSA) if (w.length - j.length >= 2 && w.endsWith(j)) { w = w.slice(0, -j.length); break; }
    if (w.length >= 2 && !STOP.has(w)) out.add(w);
  }
  return [...out];
}
function keywordRecall(gold: string, answer: string): number {
  const g = keywords(gold);
  if (!g.length) return 0;
  const a = answer.toLowerCase();
  return g.filter((w) => a.includes(w)).length / g.length;
}

/** 여러 주제에서 결정적으로 카드를 고른다 (매번 같은 골든셋) */
async function goldenSet(n: number): Promise<(QuizCard & { subject: string })[]> {
  const subjects = ["redis", "kafka", "postgres", "kubernetes", "docker", "observability"];
  const out: (QuizCard & { subject: string })[] = [];
  for (let i = 0; out.length < n && i < 10; i++) {
    for (const s of subjects) {
      const cards = await loadQuiz(s);
      if (cards[i * 2]) out.push({ ...cards[i * 2], subject: s });
      if (out.length >= n) break;
    }
  }
  return out;
}

const ANSWER_SYS = "너는 백엔드 엔지니어링 튜터다. 질문에 한국어로 2~3문장, 핵심 용어를 정확히 써서 답하라.";

export const mlopsEvalHarness: CodeExperiment = {
  id: "mlops-eval-harness",
  subject: "mlops",
  title: "평가 하네스: 이 사이트 퀴즈를 골든셋으로 모델을 채점하고, LLM-as-judge 의 위치 편향을 직접 잰다",
  category: "평가",
  summary: "여러 주제의 퀴즈 카드 10장을 골든셋으로 모델에 질문하고, (1) 정답 키워드 재현율, (2) 같은 모델을 판사로 쓴 0~10 점, (3) 정답과 모델 답을 A/B 순서를 바꿔 두 번 비교시키는 쌍대 판정으로 '순서에 따라 판정이 뒤집히는 비율'(위치 편향)을 측정해 표로 보여 준다",
  notes: ["02-eval-datasets-metrics", "07-eval-ci-prompt-regression"],
  description: `
"모델이 좋아졌나?" 는 감이 아니라 **고정된 골든셋 + 정해진 지표** 로 답해야 한다. 이 실험은 사이트의 퀴즈 카드(질문·정답)를 골든셋으로 쓴다.
세 가지 지표를 비교한다:
- **키워드 재현율**: 정답의 핵심 단어가 답변에 몇 % 들어 있나. 싸고 결정적이지만 표현이 다르면 놓친다.
- **LLM 판사 점수(0~10)**: 의미를 보지만 판사 모델의 편향을 그대로 물려받는다.
- **쌍대 비교 + 순서 뒤집기**: 같은 두 답을 A/B 순서만 바꿔 두 번 묻는다. 판정이 따라 바뀌면 그 판사는 내용이 아니라 **위치**를 보고 있다.
판사로 같은 1.5B 모델을 쓰는 것은 일부러다 — 작은 판사가 얼마나 흔들리는지가 이 실험의 결과다.
`,
  code: `golden = quiz 카드 10장 (redis·kafka·postgres·k8s·docker·관측성)
for card in golden:
  answer = model(card.q)
  recall = |keywords(card.a) ∩ answer| / |keywords(card.a)|
  judge  = model("질문/정답/답변 → 0~10 점수만")
  ab = model("A=정답, B=답변 중 더 정확한 것?")   # 순서 1
  ba = model("A=답변, B=정답 중 더 정확한 것?")   # 순서 2
  flip = (ab 가 고른 답 ≠ ba 가 고른 답)            # 위치 편향`,
  requires: requiresOllama,
  async run({ rec }) {
    const N = 10;
    const golden = await goldenSet(N);
    rec.note(`골든셋 ${golden.length}장: ${[...new Set(golden.map((g) => g.subject))].join(", ")} 퀴즈에서 결정적으로 선택. 모델 ${MODEL}, temperature 0`);
    const rows: Record<string, unknown>[] = [];
    let flips = 0;
    let firstPicks = 0;
    let goldWins = 0;
    let selfWins = 0;
    let decided = 0;
    const recalls: number[] = [];
    const judges: number[] = [];
    await rec.measure(`골든셋 ${golden.length}장 × (답변 1 + 판사 1 + 쌍대 2) 호출`, async () => {
      for (const card of golden) {
        const answer = (await chat(card.q, { system: ANSWER_SYS, maxTokens: 160 })).trim();
        const recall = keywordRecall(card.a, answer);
        const judgeRaw = await chat(`다음 질문에 대한 답변을 정답과 비교해 0~10 점으로 채점하라. 숫자 하나만 출력하라.\n질문: ${card.q}\n정답: ${card.a}\n답변: ${answer}\n점수:`, { maxTokens: 6 });
        const judge = Math.max(0, Math.min(10, Number(judgeRaw.match(/\d+(\.\d+)?/)?.[0] ?? NaN)));
        const ask = (a: string, b: string) => chat(`질문: ${card.q}\n\n답 A: ${a}\n\n답 B: ${b}\n\n어느 답이 더 정확한가? 'A' 또는 'B' 한 글자만 출력하라.`, { maxTokens: 3 });
        const pick = (s: string) => (/^\s*a/i.test(s) ? "A" : /^\s*b/i.test(s) ? "B" : "?");
        const p1 = pick(await ask(card.a, answer)); // A=정답
        const p2 = pick(await ask(answer, card.a)); // A=모델 답
        const choice1 = p1 === "A" ? "정답" : p1 === "B" ? "모델" : "?";
        const choice2 = p2 === "A" ? "모델" : p2 === "B" ? "정답" : "?";
        const flip = choice1 !== "?" && choice2 !== "?" && choice1 !== choice2;
        if (choice1 !== "?" && choice2 !== "?") {
          decided++;
          if (flip) flips++;
          if (p1 === "A") firstPicks++;
          if (p2 === "A") firstPicks++;
          if (!flip && choice1 === "정답") goldWins++;
          if (!flip && choice1 === "모델") selfWins++;
        }
        recalls.push(recall);
        if (Number.isFinite(judge)) judges.push(judge);
        rows.push({
          주제: card.subject,
          질문: card.q.slice(0, 34) + (card.q.length > 34 ? "…" : ""),
          "키워드 재현율": `${Math.round(recall * 100)}%`,
          판사점수: Number.isFinite(judge) ? judge : "파싱 실패",
          "순서1(A=정답)": choice1,
          "순서2(A=모델)": choice2,
          뒤집힘: flip ? "예" : "",
        });
      }
    });
    rec.steps.push({ cmd: "카드별 결과", result: rows, ms: 0 });
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const summary = {
      "평균 키워드 재현율": `${Math.round(avg(recalls) * 100)}%`,
      "평균 판사 점수": r1(avg(judges)),
      "쌍대 판정 가능": `${decided}/${golden.length}`,
      "순서 바꾸면 판정이 뒤집힌 비율": decided ? `${Math.round((flips / decided) * 100)}%` : "-",
      "첫 번째(A) 를 고른 비율": decided ? `${Math.round((firstPicks / (decided * 2)) * 100)}%` : "-",
      "두 순서 모두 정답을 고른 비율": decided ? `${Math.round((goldWins / decided) * 100)}%` : "-",
      "두 순서 모두 자기(모델) 답을 고른 비율": decided ? `${Math.round((selfWins / decided) * 100)}%` : "-",
    };
    rec.steps.push({ cmd: "요약", result: summary, ms: 0 });
    rec.check("골든셋 전체에 답변·키워드 점수가 계산됐다", recalls.length === golden.length);
    rec.check("판사 점수를 절반 이상 숫자로 파싱했다 (형식 지시 준수율)", judges.length >= golden.length / 2, { 파싱: judges.length });
    rec.check("쌍대 판정을 순서 두 가지로 모두 받았다 (위치 편향 측정 가능)", decided >= golden.length / 2, { decided });
    rec.note(
      flips > 0
        ? `순서만 바꿨는데 ${flips}/${decided} 건의 판정이 뒤집혔다. 이 판사는 내용보다 자리에 반응한다 — 실무에서는 두 순서로 물어 일치한 것만 세거나(뒤집히면 무승부), 더 큰 판사 모델을 쓴다.`
        : "이번 골든셋에서는 순서를 바꿔도 판정이 뒤집히지 않았다. 그래도 순서 교차는 항상 해 두는 것이 원칙이다.",
    );
    if (decided && selfWins / decided >= 0.5)
      rec.note(`같은 모델이 판사이면 사람이 쓴 정답보다 자기 답을 ${selfWins}/${decided} 건에서 일관되게 골랐다 — 자기 선호 편향(self-preference). 판사는 평가 대상과 다른, 더 강한 모델로.`);
    rec.note("키워드 재현율과 판사 점수가 어긋나는 카드를 보라 — 한 지표만 믿으면 안 되는 이유다. 평가 CI 는 이 표를 기준선과 비교해 회귀를 막는다 (노트 07).");
  },
};

// ------------------------------------------------------------------ MLflow 실험 추적
type MlflowRun = { info: { run_id: string; run_name?: string; status: string; artifact_uri: string }; data: { metrics?: { key: string; value: number }[]; params?: { key: string; value: string }[] } };

async function mlflow<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const url = `${MLFLOW}/api/2.0/mlflow/${path}`;
  const res = await fetch(method === "GET" && body ? `${url}?${new URLSearchParams(body as Record<string, string>)}` : url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MLflow ${path} ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export const mlopsMlflowTracking: CodeExperiment = {
  id: "mlops-mlflow-tracking",
  subject: "mlops",
  title: "실험 추적: temperature 를 바꿔 가며 평가를 돌리고 MLflow 에 파라미터·메트릭·아티팩트를 남긴 뒤, 검색으로 최고 run 을 고른다",
  category: "실험 추적",
  summary: "MLflow REST API 로 실험을 만들고, temperature 0·0.7·1.2 세 run 에서 같은 골든셋(퀴즈 5장)의 키워드 재현율과 응답 길이를 기록한다. 결과 JSON 을 아티팩트로 올리고, runs/search 로 '점수 내림차순' 최고 run 을 찾아 모델 레지스트리에 등록했다가 실험과 함께 정리한다",
  notes: ["03-experiment-tracking-mlflow", "02-eval-datasets-metrics"],
  description: `
"그때 뭘 바꿨더니 좋아졌더라?" 를 기억에 맡기면 재현이 안 된다. **실험 추적**은 run 마다 *입력*(파라미터·데이터 버전·코드 커밋)과 *출력*(메트릭·아티팩트)을 남겨 비교·재현·승격을 가능하게 한다.
MLflow 의 단위: **experiment**(질문 하나) ⊃ **run**(한 번의 시도) — run 에 params(문자열, 불변) · metrics(숫자, step 별 시계열) · tags · artifacts(파일). 좋은 run 은 **모델 레지스트리**에 버전으로 등록되고 별칭(@champion)으로 배포된다.
이 실험은 temperature 만 바꾼 세 run 을 남기고 검색으로 최고 run 을 고른다. UI: http://localhost:15000 (실험은 끝나면 지우므로 보고 싶으면 마지막 단계 전에 UI 를 열어 둘 것).
`,
  code: `POST /api/2.0/mlflow/experiments/create       {"name": "lab-temp-sweep-…"}
POST /api/2.0/mlflow/runs/create              {"experiment_id": "…", "run_name": "t=0.7"}
POST /api/2.0/mlflow/runs/log-batch           {"run_id": "…", "params": [{"key":"temperature","value":"0.7"}], "metrics": [{"key":"recall","value":0.42,"step":0,"timestamp":…}]}
PUT  /api/2.0/mlflow-artifacts/artifacts/<exp>/<run>/artifacts/eval.json     # 아티팩트 업로드
POST /api/2.0/mlflow/runs/search              {"experiment_ids":["…"], "order_by":["metrics.recall DESC"], "max_results":1}
POST /api/2.0/mlflow/registered-models/create {"name": "…"}  →  model-versions/create {"source": "runs:/<run>/eval.json"}`,
  requires: async () => {
    const o = await requiresOllama();
    if (o) return o;
    try {
      const r = await fetch(`${MLFLOW}/health`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? null : "MLflow 가 응답하지 않습니다: pnpm mlflow:up (15000)";
    } catch {
      return "MLflow(15000) 가 꺼져 있습니다: pnpm mlflow:up (처음엔 이미지 pull 1분)";
    }
  },
  async run({ rec }) {
    const name = `lab-temp-sweep-${Date.now().toString(36)}`;
    const modelName = `${name}-model`;
    const exp = await rec.measure(`experiments/create ${name}`, () => mlflow<{ experiment_id: string }>("POST", "experiments/create", { name }));
    const golden = (await goldenSet(5)).slice(0, 5);
    rec.note(`골든셋 5장, 모델 ${MODEL}. 같은 데이터·같은 코드에서 temperature 만 바꾼다 (한 번에 한 변수)`);
    const runs: { id: string; t: number; recall: number; len: number }[] = [];
    try {
      for (const t of [0, 0.7, 1.2]) {
        const run = await mlflow<{ run: MlflowRun }>("POST", "runs/create", { experiment_id: exp.experiment_id, run_name: `t=${t}`, start_time: Date.now(), tags: [{ key: "mlflow.source.name", value: "study/code-lab/mlops.ts" }, { key: "dataset", value: "quiz-golden-v1" }] });
        const runId = run.run.info.run_id;
        const details: { q: string; recall: number; answer: string }[] = [];
        for (const card of golden) {
          const answer = (await chat(card.q, { system: ANSWER_SYS, maxTokens: 120, temperature: t })).trim();
          details.push({ q: card.q, recall: keywordRecall(card.a, answer), answer });
        }
        const recall = details.reduce((a, d) => a + d.recall, 0) / details.length;
        const len = details.reduce((a, d) => a + d.answer.length, 0) / details.length;
        const now = Date.now();
        await mlflow("POST", "runs/log-batch", {
          run_id: runId,
          params: [
            { key: "temperature", value: String(t) },
            { key: "model", value: MODEL },
            { key: "max_tokens", value: "120" },
          ],
          metrics: [
            { key: "recall", value: recall, timestamp: now, step: 0 },
            { key: "answer_len", value: len, timestamp: now, step: 0 },
            ...details.map((d, i) => ({ key: "recall_per_card", value: d.recall, timestamp: now, step: i })),
          ],
        });
        // 아티팩트: 카드별 답변 JSON
        const art = await fetch(`${MLFLOW}/api/2.0/mlflow-artifacts/artifacts/${exp.experiment_id}/${runId}/artifacts/eval.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(details, null, 2) });
        await mlflow("POST", "runs/update", { run_id: runId, status: "FINISHED", end_time: Date.now() });
        runs.push({ id: runId, t, recall, len });
        rec.steps.push({ cmd: `run t=${t}: log-batch(params 3, metrics ${2 + details.length}) + 아티팩트 eval.json (${art.status})`, result: { run_id: runId.slice(0, 8), recall: r1(recall * 100) + "%", 평균답변길이: Math.round(len) }, ms: 0 });
      }
      const search = await rec.measure("runs/search order_by metrics.recall DESC", () =>
        mlflow<{ runs: MlflowRun[] }>("POST", "runs/search", { experiment_ids: [exp.experiment_id], order_by: ["metrics.recall DESC", "params.temperature ASC"], max_results: 3 }),
      );
      const table = search.runs.map((r) => ({
        run: r.info.run_name,
        temperature: r.data.params?.find((p) => p.key === "temperature")?.value,
        recall: r1((r.data.metrics?.find((m) => m.key === "recall")?.value ?? 0) * 100) + "%",
        answer_len: Math.round(r.data.metrics?.find((m) => m.key === "answer_len")?.value ?? 0),
        status: r.info.status,
      }));
      rec.steps.push({ cmd: "검색 결과 (점수 내림차순)", result: table, ms: 0 });
      rec.check("세 run 이 모두 FINISHED 로 기록되고 검색된다", search.runs.length === 3 && search.runs.every((r) => r.info.status === "FINISHED"));
      const best = search.runs[0];
      const filtered = await mlflow<{ runs?: MlflowRun[] }>("POST", "runs/search", { experiment_ids: [exp.experiment_id], filter: "params.temperature = '0'" });
      rec.check("filter 'params.temperature = \\'0\\'' 로 run 1개를 찾는다 (params 는 문자열)", (filtered.runs ?? []).length === 1);
      const hist = await mlflow<{ metrics: { step: number; value: number }[] }>("GET", "metrics/get-history", { run_id: best.info.run_id, metric_key: "recall_per_card" });
      rec.steps.push({ cmd: `metrics/get-history recall_per_card (최고 run, step = 카드 번호)`, result: hist.metrics.map((m) => `${m.step}:${Math.round(m.value * 100)}%`).join("  "), ms: 0 });
      rec.check("step 별 메트릭 시계열 5개가 남았다", hist.metrics.length === 5);
      const arts = await fetch(`${MLFLOW}/api/2.0/mlflow-artifacts/artifacts/${exp.experiment_id}/${best.info.run_id}/artifacts/eval.json`);
      rec.check("아티팩트(eval.json)를 다시 내려받을 수 있다 — 재현의 근거", arts.ok, arts.status);

      await rec.measure(`registered-models/create ${modelName} + model-versions/create (source=runs:/best)`, async () => {
        await mlflow("POST", "registered-models/create", { name: modelName, description: "temperature sweep 최고 run (실험용)" });
        const mv = await mlflow<{ model_version: { version: string } }>("POST", "model-versions/create", { name: modelName, source: `runs:/${best.info.run_id}/eval.json`, run_id: best.info.run_id });
        await mlflow("POST", "registered-models/alias", { name: modelName, alias: "champion", version: mv.model_version.version });
        return mv.model_version.version;
      });
      const byAlias = await mlflow<{ model_version: { version: string; run_id: string } }>("GET", "registered-models/alias", { name: modelName, alias: "champion" });
      rec.check("별칭 @champion 이 최고 run 을 가리킨다 (배포는 버전 번호가 아니라 별칭을 본다)", byAlias.model_version.run_id === best.info.run_id);
      rec.note(`최고 run: ${best.info.run_name}. 작은 골든셋(5장)에서의 차이는 잡음일 수 있다 — 실무에서는 여러 시드·더 큰 골든셋으로 신뢰 구간을 본다 (노트 02).`);
    } finally {
      // 등록 모델 삭제는 DELETE 메서드 (POST 로 보내면 404 로 조용히 남는다)
      await mlflow("DELETE", "registered-models/delete", { name: modelName }).catch((e) => rec.note(`등록 모델 삭제 실패: ${(e as Error).message}`));
      await mlflow("POST", "experiments/delete", { experiment_id: exp.experiment_id }).catch(() => {});
      rec.note(`정리: 등록 모델 ${modelName} 삭제, 실험 ${name} 삭제(MLflow 는 soft delete — 휴지통에서 30일 등 정책으로 영구 삭제)`);
    }
  },
};
