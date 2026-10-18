---
title: LLM 애플리케이션 아키텍처
order: 1
level: 기초
summary: LLM 을 제품에 넣을 때 생기는 구성요소(게이트웨이·프롬프트·컨텍스트·툴·메모리·평가)와 데이터 흐름, 스트리밍과 비동기, 모델 선택과 라우팅, 전형적인 실패 양상. 예시 코드와 다이어그램으로
tags: [LLM, 아키텍처, 게이트웨이, 스트리밍, 라우팅, 메모리]
experiments: [rag-mini]
---

## LLM 호출은 "함수" 가 아니라 "서비스"

`fetch(model, prompt)` 한 줄로 보이지만 실제 제품에선 이렇게 된다.

![LLM 앱 구성요소](/diagrams/llm-app-architecture.svg)

| 구성요소 | 역할 | 이 프로젝트에서 대응되는 것 |
|---|---|---|
| **게이트웨이** | 인증, 레이트 리밋, 모델 라우팅, 재시도, 비용 집계, 키 보관 | Nginx 레이트 리밋 + Redis 레이트 리미터 |
| **프롬프트 관리** | 템플릿·버전·A/B, 시스템 프롬프트 | git 으로 버전 관리 |
| **컨텍스트 조립** | RAG 검색, 사용자 메모리, 툴 결과를 토큰 예산 안에 | Redis 벡터 검색 실험 |
| **툴/함수 호출** | LLM 이 요청하면 실제 API·DB 를 호출해 결과를 돌려줌 | 서버 액션 |
| **메모리** | 세션 대화, 장기 선호, 요약 | Redis Hash/List + TTL |
| **캐시** | 정확 일치·시맨틱·프롬프트 캐시 | 시맨틱 캐시 실험 |
| **가드레일** | 입력(인젝션·PII) / 출력(정책·형식) 검사 | — |
| **관측** | 토큰·비용·지연·품질 트레이스 | OTel + Tempo (관측성 노트 08) |
| **평가** | 오프라인 평가셋, 온라인 피드백 | — |

## 요청 하나의 흐름 (예시: 문서 Q&A)

```
1. 사용자 질문 수신 → 인증 → 레이트 리밋 (Redis INCR)
2. 입력 가드레일: PII 마스킹, 인젝션 패턴 검사, 길이 제한
3. 캐시 조회: 정확 일치(SHA) → 시맨틱(벡터 KNN, 유사도 ≥ 0.92)
4. 컨텍스트 조립:
   - 시스템 프롬프트 (캐시 가능 접두어)
   - 사용자 메모리 요약 (Redis GET user:123:memory)
   - RAG: 질문 임베딩 → top-8 청크 → 재정렬 → top-4
   - 최근 대화 N턴 (Redis LRANGE session:abc -10 -1)
   - 토큰 예산 체크 (입력 ≤ 8k): 넘치면 오래된 대화부터 잘라냄
5. LLM 호출 (스트리밍, 툴 정의 포함, 타임아웃 30s, 재시도 429/5xx 2회 지수 백오프)
6. 툴 호출 루프: tool_use → 서버에서 실행 → tool_result → 다시 LLM (최대 N회)
7. 출력 가드레일: 형식 검증(JSON 스키마), 금칙어, 근거 인용 확인
8. 응답 스트리밍 + 저장(세션 append, 로그, 트레이스 속성: 토큰·비용)
9. 비동기 후처리: 대화 요약 갱신, 피드백 수집, 평가 샘플링
```

```ts
// 핵심 루프의 뼈대 (Claude API, 스트리밍 + 툴)
const stream = client.messages.stream({
  model: "claude-sonnet-5-5",
  max_tokens: 1024,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],   // 프롬프트 캐시
  tools: [searchNotesTool, getRedisInfoTool],
  messages: [...history, { role: "user", content: buildUserMessage(question, chunks) }],
});
for await (const event of stream) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") res.write(event.delta.text);
}
const final = await stream.finalMessage();
if (final.stop_reason === "tool_use") { /* 툴 실행 후 tool_result 로 재호출 */ }
```

## 동기 vs 비동기

- **채팅·검색 보조**: 동기 + 스트리밍. 첫 토큰(TTFT) 이 체감 품질. SSE 또는 WebSocket.
- **문서 요약·배치 분류·임베딩 생성**: 비동기. 큐(Kafka/Redis Stream/PG SKIP LOCKED)에 넣고 워커가 처리, 결과를 저장 후 알림. Claude 의 **Batch API** 는 50% 저렴하고 24시간 내 처리 — 대량 오프라인 작업에.
- 긴 에이전트 작업: 상태 머신 + 체크포인트(Redis/PG) — 중간에 죽어도 이어서. 워크플로 엔진(Temporal, Vercel Workflow).

## 모델 선택과 라우팅

| 축 | 선택 |
|---|---|
| 난이도 | 분류·추출·짧은 응답 → 작은 모델(Haiku). 추론·긴 생성·코드 → 큰 모델(Opus/Sonnet) |
| 지연 | 대화형은 TTFT < 1s 목표. 작은 모델 + 스트리밍 |
| 비용 | 입력 토큰이 대부분. 프롬프트 캐시·컨텍스트 압축이 모델 교체보다 효과 클 때가 많다 |
| 컨텍스트 | 긴 문서는 큰 컨텍스트 모델 또는 RAG |
| 라우팅 | 규칙(요청 종류) → 분류기(작은 모델이 난이도 판정) → 폴백(큰 모델 실패 시 작은 모델, 또는 반대) |

라우팅 결정은 span 속성(`study.llm.route`)으로 남겨 효과를 측정한다.

## 전형적 실패와 대응

| 실패 | 증상 | 대응 |
|---|---|---|
| 환각 | 그럴듯한 거짓 | RAG + 인용 강제, "근거 없으면 모른다", 평가셋 |
| 프롬프트 인젝션 | 문서/사용자 입력이 지시를 덮어씀 | 입력과 지시 분리, 도구 권한 최소화, 출력 검증 |
| 컨텍스트 초과 | 400 에러 또는 잘림 | 토큰 계산, 예산 기반 트리밍, 요약 |
| 429/과부하 | 간헐적 실패 | 지수 백오프 + 지터, 큐잉, 폴백 모델 |
| 비용 폭주 | 청구서 | 토큰 메트릭·예산 알림, 캐시, 사용자별 한도 |
| 품질 저하 | 모델 버전 변경 후 | 모델 버전 고정, 평가셋 CI |
| 느린 TTFT | 긴 프롬프트 | 프롬프트 캐시, 컨텍스트 줄이기, 스트리밍 |
| 툴 루프 폭주 | 에이전트가 끝없이 호출 | 최대 반복 수, 예산, 사람 승인 지점 |

## 실전에서는 어디에 쓰이나 — AI 시스템 지도

> AI 시스템 엔지니어링은 모델을 만드는 일이 아니라, 외부 모델 호출을 게이트웨이·컨텍스트 조립·툴·캐시·가드레일·관측으로 감싸 "믿고 돈 낼 수 있는 기능" 으로 만드는 일이다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 사내 문서·위키 Q&A 챗봇 | 질문 임베딩 → 근거 검색 → 인용 있는 답변 | [RAG 설계 — 청킹부터 인용까지](/ai-systems/notes/03-rag-design) |
| 커머스 상품 검색·추천의 의미 검색 | 임베딩, ANN 인덱스, 하이브리드 검색 | [임베딩과 벡터 검색](/ai-systems/notes/02-embeddings-vector-search) |
| 고객 상담·업무 자동화 에이전트 | 툴 호출 루프, 워크플로, 사람 승인 | [에이전트 — 툴 호출, 루프, 워크플로](/ai-systems/notes/04-agents-tools-workflows) |
| LLM 기능 출시 후 비용·지연 급증 | 프롬프트 캐싱, 응답 캐시, 모델 라우팅, 배치 | [프롬프트·캐시·비용·지연](/ai-systems/notes/05-prompt-cache-cost-latency) |
| 모델·프롬프트 변경 후 품질 회귀 | 평가셋 CI, 가드레일, 레드팀 | [평가·가드레일·안전](/ai-systems/notes/06-evaluation-guardrails-safety) |
| 대량 문서 요약·분류 같은 오프라인 작업 | 큐 + 워커 비동기 처리, 배치 API | 이 노트의 "동기 vs 비동기" |

**회사 규모에 따라**
- 스타트업: 외부 모델 API 하나에 프롬프트·간단한 RAG 로 빠르게 출시하고, 비용 메트릭과 레이트리밋부터 붙인다.
- 성장기: LLM 게이트웨이로 키·라우팅·재시도·비용 집계를 모으고, 평가셋을 CI 에 넣어 모델 교체를 안전하게 한다.
- 대규모 조직: 플랫폼 팀이 공용 게이트웨이·벡터 저장소·가드레일·관측을 제공하고, 제품 팀은 프롬프트와 툴만 만든다.

**이럴 땐 안 맞는다**
- 규칙·정규식·SQL 로 정확히 풀리는 문제(형식 검증, 정해진 계산) — LLM 은 느리고 비싸며 확률적이다. 결정적 코드를 쓴다.
- 틀린 답 하나가 큰 피해로 이어지는데 사람 검토가 불가능한 자동 실행 — 승인 지점 없이 LLM 출력으로 바로 행동하지 않는다.

**누가 매일 만나나** — 백엔드·AI 엔지니어는 컨텍스트 조립과 툴 호출 코드를 쓸 때, ML 엔지니어는 평가셋과 모델 라우팅을 다룰 때, SRE 는 429·TTFT·토큰 비용 대시보드를 볼 때 만난다.

## 관련

- [임베딩과 벡터 검색](/ai-systems/notes/02-embeddings-vector-search), [RAG 설계](/ai-systems/notes/03-rag-design)
- [LLM 관측](/observability/notes/08-llm-observability)
- [Redis 캐싱 패턴](/redis/notes/08-caching-patterns), [Redis 레이트 리미팅](/redis/notes/10-rate-limiting)
- [시스템 아키텍처: 복원력 패턴](/architecture/notes/04-resilience)
