---
title: AI/LLM 애플리케이션의 관측
order: 8
level: 심화
summary: LLM 호출이 일반 API 와 다른 점(비결정성·토큰 비용·긴 지연·품질), 무엇을 기록할지(프롬프트·응답·토큰·지연·툴 호출), OpenTelemetry GenAI 시맨틱 컨벤션, 비용·품질 대시보드, 평가와 피드백 루프, Langfuse/Phoenix 같은 LLM 전용 도구
tags: [LLM, 관측, 토큰, 비용, 평가, OpenTelemetry GenAI, Langfuse, RAG]
experiments: []
---

## LLM 호출은 왜 다른가

| 일반 API | LLM 호출 |
|---|---|
| 같은 입력 → 같은 출력 | **비결정적** (temperature, 모델 버전 변경) |
| 지연 수십 ms | **수 초**, 스트리밍이면 첫 토큰(TTFT)과 전체가 다름 |
| 비용 = 요청 수 | 비용 = **토큰 수** × 모델 단가 (입력/출력/캐시 각각) |
| 성공/실패가 명확 | 200 OK 인데 **틀린 답** — 품질이 별도 차원 |
| 입력이 구조화됨 | 프롬프트는 긴 자연어, 컨텍스트(RAG 문서)가 붙음 |

그래서 RED 외에 **토큰·비용·품질** 축이 필요하고, 디버깅엔 **실제 프롬프트와 응답**을 봐야 한다.

## 무엇을 기록하나

트레이스 하나 = 사용자 요청 하나. 그 안에 span 으로:

```
chat.request (user_id, session_id, feature)
 ├─ retrieval (query, top_k, 문서 ID 들, 점수, 지연)        ← RAG
 ├─ prompt.build (템플릿 버전, 컨텍스트 토큰 수)
 ├─ llm.call (model, temperature, input_tokens, output_tokens, cached_tokens, TTFT, 전체 지연, finish_reason, cost)
 │   └─ tool.call × N (툴 이름, 인자, 결과 크기, 지연)        ← 에이전트
 ├─ guardrail (PII 검사, 정책 위반 여부)
 └─ response (길이, 스트리밍 청크 수)
```

span 속성은 **OpenTelemetry GenAI 시맨틱 컨벤션**을 따른다:

```
gen_ai.system = "anthropic"         gen_ai.request.model = "claude-opus-5-5"
gen_ai.request.temperature          gen_ai.request.max_tokens
gen_ai.usage.input_tokens           gen_ai.usage.output_tokens
gen_ai.response.finish_reasons      gen_ai.response.model (실제 응답 모델 버전)
gen_ai.operation.name = "chat"      gen_ai.tool.name
```

프롬프트·응답 본문은 **이벤트/로그로** (크고, 민감할 수 있음). 운영에서는 샘플링·마스킹·보존 기간을 따로 둔다.

```ts
// 예: Claude API 호출을 span 으로 감싸기
await tracer.startActiveSpan("llm.call", { attributes: { "gen_ai.system": "anthropic", "gen_ai.request.model": model } }, async (span) => {
  const t0 = performance.now();
  const res = await client.messages.create({ model, max_tokens: 1024, messages });
  span.setAttributes({
    "gen_ai.usage.input_tokens": res.usage.input_tokens,
    "gen_ai.usage.output_tokens": res.usage.output_tokens,
    "gen_ai.usage.cache_read_input_tokens": res.usage.cache_read_input_tokens ?? 0,
    "gen_ai.response.finish_reasons": [res.stop_reason ?? ""],
    "study.llm.cost_usd": cost(model, res.usage),
    "study.llm.latency_ms": performance.now() - t0,
  });
  logger.info("llm.response", { trace_id: ..., prompt_hash, output_preview: text.slice(0, 200) });   // 본문은 로그로
  span.end();
});
```

## 메트릭

```promql
# 비용 (분당 달러)
sum by (model, feature) (rate(llm_cost_usd_total[5m])) * 60
# 토큰 처리량과 캐시 적중
sum(rate(llm_tokens_total{kind="input"}[5m])) ; sum(rate(llm_tokens_total{kind="cached"}[5m])) / sum(rate(llm_tokens_total{kind="input"}[5m]))
# 지연: TTFT p95 와 전체 p95 를 따로
histogram_quantile(0.95, sum by (le, model) (rate(llm_ttft_seconds_bucket[5m])))
histogram_quantile(0.95, sum by (le, model) (rate(llm_latency_seconds_bucket[5m])))
# 실패와 거절
sum(rate(llm_requests_total{outcome=~"rate_limited|overloaded|error"}[5m]))
sum(rate(llm_requests_total{finish_reason="max_tokens"}[5m]))      # 잘린 응답 비율
# 툴 호출
sum by (tool) (rate(llm_tool_calls_total[5m])) ; histogram_quantile(0.95, sum by (le, tool) (rate(llm_tool_latency_seconds_bucket[5m])))
```

알림 예: 시간당 비용 예산 초과, 429 급증, TTFT p95 > 3s, 특정 모델 에러율, 가드레일 차단율 급변(프롬프트 인젝션 시도?).

## 품질 — 평가와 피드백 루프

메트릭이 "빨랐다" 고 해도 "맞았는가" 는 모른다. 품질 신호를 **생산 데이터에서** 모은다.

1. **명시적 피드백**: 👍/👎, 수정 여부, 재질문율. 트레이스 ID 와 함께 저장.
2. **암묵적 신호**: 응답 후 사용자가 같은 질문을 반복, 세션 이탈, 복사/채택.
3. **LLM-as-judge**: 샘플링한 응답을 다른 모델이 채점(정확성·근거성·톤). 비용이 들지만 자동화 가능. 채점 기준(rubric)을 버전 관리.
4. **오프라인 평가셋**: 대표 질문 + 기대 답/근거 100~500개. 프롬프트·모델 변경 시 CI 에서 돌린다 (회귀 방지).
5. **RAG 전용**: 검색 적합도(recall@k), 응답이 근거 문서에 기반하는지(grounding), 컨텍스트 사용률.

```
배포 → 트레이스 수집 → 나쁜 사례(👎, 낮은 judge 점수) 모음 → 평가셋에 추가 → 프롬프트/검색 개선 → 오프라인 평가 통과 → 배포
```

## 비용 관리

- **프롬프트 캐싱**: 시스템 프롬프트·긴 문서를 캐시하면 입력 비용 대폭 절감. `cache_read_input_tokens` 비율을 대시보드에.
- 모델 라우팅: 쉬운 요청은 작은 모델(Haiku), 어려운 것만 큰 모델. 라우팅 결정을 span 속성으로 남겨 효과 측정.
- 출력 토큰 제한, 스트리밍으로 체감 지연 개선.
- 사용자/테넌트별 예산과 레이트 리밋 (Redis 레이트 리미터 참고).

## 전용 도구

| 도구 | 특징 |
|---|---|
| **Langfuse** (오픈소스) | 트레이스·프롬프트 버전 관리·평가·비용 대시보드. OTel 수신 |
| **Arize Phoenix** (오픈소스) | 트레이스 + 평가 + 임베딩 시각화 |
| OpenLLMetry (Traceloop) | OTel 기반 자동 계측 SDK |
| LangSmith, Helicone, Braintrust | 상용/호스팅 |
| 범용: Grafana(Tempo+Loki) | 이 프로젝트 스택으로도 기본은 된다 — span 속성 + 로그 |

OTel 로 계측해 두면 백엔드 교체가 자유롭다. 프롬프트 본문 저장은 전용 도구가 편하다.

## 보안·규정

- 프롬프트·응답엔 개인정보가 섞인다. 저장 전 마스킹, 접근 통제, 보존 짧게.
- 프롬프트 인젝션 시도는 로그로 남겨 패턴을 학습 (가드레일 차단 이벤트).
- 모델 버전 고정과 변경 이력 — "갑자기 품질이 떨어졌다" 의 1순위 원인.

## 관련

- [AI 시스템 설계](/ai-systems/notes/01-llm-app-architecture) — 아키텍처 관점
- [트레이싱](/observability/notes/06-tracing-otel) — span 과 컨텍스트 전파
- [Redis 캐싱 패턴](/redis/notes/08-caching-patterns) — 시맨틱 캐시의 기반

## 실전에서는 어디에 쓰이나

> LLM 기능은 200 OK 를 내면서 틀린 답을 하고, 요청 수가 아니라 토큰 수로 돈이 나간다. 그래서 RED 외에 토큰·비용·품질 신호를 따로 잡아야 장애와 비용 사고를 알아챌 수 있다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 사내 문서 RAG 챗봇 | "답이 엉뚱하다" 신고 | 트레이스의 retrieval span(문서 ID·점수)으로 검색 문제인지 생성 문제인지 분리 | 프롬프트만 계속 수정 |
| AI 기능을 붙인 SaaS | 비용 급증 원인 | `sum by (model, feature) (rate(llm_cost_usd_total[5m]))`, 캐시 적중률 하락 확인 | 월말 청구서로 발견 |
| 고객 상담 챗봇 | "첫 응답이 늦다" 는 체감 | TTFT p95 와 전체 지연 p95 를 따로 | 전체 지연 하나 — 스트리밍 체감과 다르다 |
| 에이전트형 서비스 | 툴 루프로 토큰 폭주 | span 트리의 tool.call 반복·지연, `finish_reason=max_tokens` 비율 | 최종 응답 로그만 |
| 모델·프롬프트 교체 | 품질 회귀 방지 | 오프라인 평가셋을 CI 에서, 👎 사례를 평가셋에 추가 | 배포 후 사용자 반응으로 판단 |

**이럴 땐 안 맞는다**
- 프롬프트·응답 원문을 일반 로그에 전부 → 개인정보와 비용 문제가 생긴다. 마스킹·샘플링 후 전용 도구나 짧은 보존으로.
- 지연·에러율만으로 품질 판단 → 빠르고 성공해도 틀릴 수 있다. 피드백·LLM-as-judge·평가셋이 별도 축으로 필요하다.

**누가 매일 만나나** — ML·AI 엔지니어는 평가 점수와 나쁜 사례를, 백엔드는 토큰·TTFT·429 알림을, 제품·FinOps 담당은 기능별 비용([LLM 토큰 비용](/finops/notes/05-llm-token-cost))을 본다.

**면접·실무 단골 질문**
- Q. LLM 호출 관측이 일반 API 와 다른 점은? → 비결정성, 토큰 기반 비용, TTFT 와 전체 지연의 구분, 그리고 성공과 별개인 품질 축.

## 실습 체크리스트

- [ ] (API 키가 있다면) Claude 호출 하나를 span 으로 감싸고 Tempo 에서 토큰 속성 확인
- [ ] 비용 counter 와 TTFT 히스토그램을 `/api/metrics` 에 추가해 Grafana 패널 만들기
- [ ] 👍/👎 피드백을 trace_id 와 함께 Redis Hash 에 저장하는 액션 설계
- [ ] 평가셋 20개를 JSON 으로 만들고 CI 에서 돌리는 스크립트 구상
