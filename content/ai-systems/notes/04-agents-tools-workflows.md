---
title: 에이전트 — 툴 호출, 루프, 워크플로
order: 4
level: 중급
summary: 툴 호출의 동작 원리와 스키마 설계, 에이전트 루프(계획·실행·관찰)와 종료 조건, 멀티 에이전트와 오케스트레이션, 상태·체크포인트·재시도, 권한과 승인(human-in-the-loop), MCP, 비용·안전 가드. 예시 코드 포함
tags: [에이전트, 툴호출, 워크플로, MCP, human-in-the-loop, 오케스트레이션]
experiments: []
---

## 툴 호출의 원리

LLM 은 코드를 실행하지 않는다. **"이 툴을 이 인자로 호출해 달라"** 는 구조화 출력을 내고, 앱이 실행해 결과를 돌려주면 모델이 이어서 생각한다.

```ts
const tools = [{
  name: "search_notes",
  description: "학습 노트를 의미 검색한다. 사용자가 개념·방법을 물을 때 먼저 호출.",
  input_schema: { type: "object", properties: { query: { type: "string" }, subject: { type: "string", enum: ["redis","kafka","postgres"] } }, required: ["query"] },
}, {
  name: "redis_info",
  description: "로컬 Redis 의 INFO 섹션을 읽는다. 서버 상태 질문에 사용.",
  input_schema: { type: "object", properties: { section: { type: "string" } } },
}];

let messages = [{ role: "user", content: "Redis 메모리가 왜 늘어나는지 지금 상태 보고 설명해줘" }];
for (let i = 0; i < 8; i++) {                                  // 최대 반복
  const res = await client.messages.create({ model, max_tokens: 1024, tools, messages });
  messages.push({ role: "assistant", content: res.content });
  if (res.stop_reason !== "tool_use") break;                    // 최종 답
  const results = [];
  for (const block of res.content) if (block.type === "tool_use") {
    const out = await runTool(block.name, block.input);         // 권한 검사 + 실행 + 타임아웃
    results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out).slice(0, 8000) });
  }
  messages.push({ role: "user", content: results });
}
```

### 툴 설계 규칙

- **설명이 곧 프롬프트**: 언제 쓰는지, 언제 쓰지 말지, 인자 의미를 명확히. 모호하면 모델이 잘못 고른다.
- 작고 직교적으로. "모든 걸 하는 툴" 보다 3~10개의 명확한 툴.
- 입력은 JSON 스키마로 검증(enum, 범위). 출력은 **짧게**(토큰 비용) — 큰 결과는 요약·페이지네이션·ID 참조.
- 멱등하게. 재시도·중복 호출에 안전.
- 위험한 툴(삭제, 결제, 외부 전송)은 **승인 단계** 필수.

## 에이전트 루프와 종료

```
관찰(사용자 입력, 툴 결과) → 생각/계획 → 행동(툴 호출 또는 답변) → 관찰 …
```

종료 조건을 반드시 둔다: 최대 반복 수, 토큰/비용 예산, 시간, 같은 툴·인자 반복 감지, 사용자 승인 대기. 끝없이 도는 에이전트가 가장 흔한 사고.

## 패턴

| 패턴 | 설명 | 예 |
|---|---|---|
| **단일 툴 호출** | 한 번 호출 후 답 | 날씨, DB 조회 |
| **ReAct 루프** | 생각→행동→관찰 반복 | 조사, 디버깅 보조 |
| **계획-실행** | 먼저 단계 목록을 만들고 순서대로 | 다단계 작업 |
| **워크플로(정해진 그래프)** | 코드가 흐름을 정하고 LLM 은 노드에서만 | 문서 처리 파이프라인 — 예측 가능, 추천 기본값 |
| **오케스트레이터-워커** | 상위 에이전트가 하위 에이전트에 하위 과제 위임 | 리서치, 코드 리뷰 |
| **평가자-생성자** | 생성 → 다른 모델이 검토 → 수정 | 고품질 글, 코드 |

Anthropic 의 조언: **가능한 가장 단순한 구조**부터. 워크플로로 되면 에이전트를 쓰지 않는다.

## 상태와 내구성

긴 작업은 중간에 죽는다(배포, 타임아웃, 429).
- 각 단계의 입력·출력을 **체크포인트**(Redis Hash/PG 행)에 저장하고, 재시작 시 마지막 단계부터.
- 툴 호출은 멱등 키와 함께. 외부 부작용(이메일 발송)은 "이미 했는지" 기록.
- 워크플로 엔진(Temporal, Vercel Workflow, Inngest)은 이걸 프레임워크로 제공: 단계 재시도, 슬립, 사람 승인 대기.
- 대화 메모리: 최근 N턴 + 요약. Redis List(세션) + 요약 String, TTL.

## 사람 개입 (human-in-the-loop)

- 승인 게이트: 위험 툴 실행 전 사용자에게 보여 주고 확인. 상태를 "대기" 로 저장하고 웹훅/알림.
- 피드백: 결과에 대한 👍/👎 와 수정 — 평가셋 재료.
- 가시성: 에이전트가 무엇을 했는지 **단계 로그**를 UI 에 (이 사이트의 실험실 표처럼).

## MCP (Model Context Protocol)

툴·리소스·프롬프트를 표준 프로토콜로 노출하는 서버. 한 번 만든 MCP 서버를 여러 클라이언트(Claude Desktop, IDE, 자체 앱)가 쓴다. 이 프로젝트의 Redis 콘솔·실험 실행을 MCP 서버로 감싸면 Claude 가 직접 실험을 돌리며 설명할 수 있다 — 좋은 다음 프로젝트.

## 안전과 비용 가드

- 툴 권한 최소화: 읽기 전용 기본, 쓰기는 명시적 허용 목록, 네임스페이스 제한(`lab:*` 키만).
- 샌드박스: 코드 실행 툴은 격리 환경(컨테이너, Vercel Sandbox).
- 인젝션: 툴 결과(웹 페이지, 문서)에 들어 있는 지시를 따르지 않도록 시스템 프롬프트에 명시하고, 툴 결과를 데이터로 구분.
- 예산: 요청당 토큰·툴 호출 수·시간 상한. 초과 시 중단하고 사용자에게.
- 관측: 툴 호출마다 span(이름·인자 크기·지연·성공), 전체 비용 ([LLM 관측](/observability/notes/08-llm-observability)).

## 예시: "노트 기반 학습 도우미" 설계

1. 툴: `search_notes(query, subject?)`, `get_note(subject, slug)`, `run_experiment(subject, id)`(승인 필요), `get_progress()`.
2. 워크플로: 질문 → 검색 → (필요 시) 노트 본문 → 답 + 출처 + "이 실험을 돌려 볼까요?" 제안 → 승인 시 실행 → 결과 해석.
3. 상태: 세션 대화는 Redis List, 승인 대기 작업은 Hash(status=pending).
4. 가드: 실험은 `lab:*` 만, 콘솔 차단 명령 동일 적용, 요청당 툴 5회.
5. 평가: 질문 30개 평가셋, 근거성·출처 정확도.

> 이어서 읽기: [AI 에이전트 설계](/ai-agents) — AI 에이전트 설계 — 툴·MCP·메모리·가드레일을 별도 주제로

## 실습 체크리스트

- [ ] 위 툴 스키마 2개를 작성하고 `description` 을 다듬어 모델이 올바르게 고르는지 테스트 (API 키 필요)
- [ ] 루프에 최대 반복·비용 상한을 넣고 초과 시 메시지 확인
- [ ] `run_experiment` 에 승인 단계를 넣는 상태 머신을 Redis Hash 로 설계
- [ ] 툴 결과에 "이전 지시를 무시하고 …" 를 심어 모델이 따르는지 테스트하고 방어 프롬프트 추가
