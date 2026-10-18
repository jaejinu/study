---
title: "계약 테스트 — 서비스를 같이 띄우지 않고 호환성을 검증한다"
order: 4
level: 중급
summary: "마이크로서비스에서 E2E 가 무너지는 이유, 계약 테스트의 아이디어(소비자의 기대를 계약으로 기록하고 제공자가 검증), 소비자 주도 계약(Pact)의 흐름(소비자 테스트 → 계약 파일 → 브로커 → 제공자 검증 → can-i-deploy), 프로바이더 상태, 스키마 기반 대안(OpenAPI 차이 검사, buf breaking, Schema Registry 호환성), 이벤트·메시지 계약, 무엇을 계약에 넣고 무엇을 뺄까, 그리고 이 사이트의 API·실험 결과 형식에 적용하기"
tags: [계약 테스트, Pact, 소비자 주도, can-i-deploy, OpenAPI, buf breaking, Schema Registry, 호환성]
experiments: []
---

## 서비스가 늘면 E2E 가 무너진다

서비스 A 가 B 를, B 가 C 를 부른다. 셋을 모두 띄운 E2E 환경에서 테스트하면:

- 환경 하나 띄우는 데 수십 분, 테스트 데이터 준비가 지옥
- C 의 사소한 장애로 A 의 테스트가 실패 (원인 찾기 어려움)
- 팀마다 배포 속도가 다른데 모두가 같은 통합 환경을 기다림

그런데 E2E 가 실제로 잡는 버그의 상당수는 **"B 가 응답 필드 이름을 바꿨는데 A 가 몰랐다"** 같은 인터페이스 불일치다. 이것만 따로, 싸게 검증하는 것이 계약 테스트다.

## 계약이란

**소비자가 제공자에게 기대하는 것**의 명세다. 요청 형태와, 그 요청에 대해 소비자가 **실제로 쓰는** 응답 부분.

```
소비자(web) 가 제공자(user-api) 에게:
  GET /users/42  (Accept: application/json)
  → 200, body: { id: 42 (정수), email: (문자열) }      ← web 이 쓰는 필드만
  GET /users/999
  → 404
```

제공자가 응답에 필드를 추가하는 것은 계약 위반이 아니다. `email` 을 `emailAddress` 로 바꾸거나 `id` 를 문자열로 바꾸면 위반이다. [API 버전·진화](/api-design/notes/07-versioning-evolution-governance) 의 "관대한 수신자" 원칙과 같은 기준이다.

## 소비자 주도 계약 — Pact

```
① 소비자 테스트            ② 계약 파일 공유            ③ 제공자 검증
web 의 테스트가              pact.json 을 브로커에       user-api 의 CI 가 브로커에서
Pact 목 서버와 대화          게시 (버전·브랜치 태그)      모든 소비자의 계약을 가져와
→ 상호작용 기록                                        진짜 서버에 재생해 검증
                                  ④ can-i-deploy
                         "이 버전을 prod 에 배포해도 되나?" — 배포된 상대 버전과의 검증 결과로 답
```

### 1. 소비자 쪽 (TypeScript)

```ts
import { PactV4, MatchersV3 as M } from "@pact-foundation/pact";
const pact = new PactV4({ consumer: "web", provider: "user-api" });

test("사용자 조회", () =>
  pact.addInteraction()
    .given("user 42 exists")                                   // 프로바이더 상태
    .uponReceiving("a request for user 42")
    .withRequest("GET", "/users/42")
    .willRespondWith(200, (b) => b.jsonBody({ id: M.integer(42), email: M.email() }))
    .executeTest(async (server) => {
      const user = await fetchUser(server.url, 42);           // 진짜 클라이언트 코드
      expect(user.email).toContain("@");
    }));
```

- 소비자의 **진짜 HTTP 클라이언트 코드**가 목 서버를 상대로 돈다 → 클라이언트 버그도 잡힌다
- 매처(`integer`, `email`, `like`)로 **값이 아니라 형태**를 계약한다 — 제공자의 테스트 데이터와 무관하게

### 2. 제공자 쪽

```ts
await new Verifier({
  provider: "user-api",
  providerBaseUrl: "http://localhost:8080",
  pactBrokerUrl: process.env.PACT_BROKER_URL,
  stateHandlers: { "user 42 exists": () => db.insertUser({ id: 42, email: "a@b.c" }) },
  publishVerificationResult: true,
}).verifyProvider();
```

**프로바이더 상태**(`given`)는 "이 상호작용이 성립하려면 제공자가 어떤 데이터를 갖고 있어야 하나" 다. 제공자가 핸들러로 그 상태를 만든다.

### 3. can-i-deploy

```bash
pact-broker can-i-deploy --pacticipant web --version $GIT_SHA --to-environment production
```

브로커는 "web 의 이 버전" 과 "production 에 배포된 user-api 버전" 사이의 검증 결과를 알고 있다. 검증이 없거나 실패면 배포를 막는다. **서로 다른 속도로 배포하는 팀들 사이의 안전장치**다.

## 소비자 주도 vs 스키마 기반

| | 소비자 주도 (Pact) | 스키마 기반 |
|---|---|---|
| 계약의 원천 | 소비자 테스트가 기록한 실제 사용 | 제공자가 공개한 스키마 (OpenAPI·proto·Avro) |
| 검증 | 제공자가 소비자 기대를 재생 | 스키마 변경을 이전 버전과 비교 |
| 장점 | "아무도 안 쓰는 필드" 는 자유롭게 변경 가능 — 실제 사용만 보호 | 도입이 쉽다, 소비자 협조 불필요 |
| 단점 | 소비자 팀이 테스트를 써야 함, 브로커 운영 | 실제로 안 쓰는 필드 변경도 막음 (보수적) |
| 맞는 곳 | 내부 마이크로서비스, 소비자를 아는 경우 | 공개 API, 소비자를 모르는 경우, 이벤트 |

### 스키마 기반 도구

| 대상 | 도구 | 검사 |
|---|---|---|
| OpenAPI | `oasdiff breaking old.yaml new.yaml` | 필수 필드 추가, 필드 삭제, 타입 변경, enum 축소 |
| Protobuf | `buf breaking --against '.git#branch=main'` | 필드 번호 재사용, 타입 변경 — [Protobuf·gRPC](/api-design/notes/03-protobuf-grpc) |
| Avro/JSON Schema 이벤트 | Schema Registry 호환성 모드 (BACKWARD·FORWARD·FULL) | 등록 시점에 거부 — [Kafka Schema Registry](/kafka/notes/06-streams-connect-schema) |
| GraphQL | `graphql-inspector diff` | 필드 삭제·타입 변경 |

OpenAPI 를 계약으로 쓰면 **응답을 스키마로 검증하는 테스트**도 같이 둔다. 문서와 실제 구현이 어긋나면(문서는 `email` 필수인데 구현은 null 을 보냄) 스키마 비교만으로는 못 잡는다.

## 이벤트·메시지 계약

비동기 메시지는 소비자가 더 많고 더 늦게 바뀐다. 메시지 계약은 특히 중요하다.

```ts
// Pact 메시지 계약: 소비자가 기대하는 이벤트 형태
pact.expectsToReceive("an OrderCreated event")
  .withContent({ orderId: M.uuid(), amount: M.integer(89000), currency: M.regex(/^[A-Z]{3}$/, "KRW") })
  .verify(async (msg) => handleOrderCreated(msg.contents));
```

[Outbox + CDC](/kafka/notes/08-cdc-outbox-debezium) 처럼 DB 테이블 행이 그대로 이벤트가 되는 구조에서는, **테이블 스키마 변경이 곧 이벤트 계약 변경**이다. 마이그레이션 리뷰에 계약 검사를 넣어야 한다.

## 무엇을 계약에 넣나

| 넣는다 | 빼다 |
|---|---|
| 소비자가 실제로 읽는 필드와 타입 | 소비자가 무시하는 필드 |
| 상태 코드, 에러 형태 (Problem Details) | 정확한 에러 메시지 문구 |
| 필수 헤더 (Content-Type, 인증 방식) | 서버 내부 헤더 |
| 페이지네이션 커서 형태 | 특정 데이터 값 (형태 매처로) |
| 비즈니스 규칙 검증 | ← 계약 테스트가 아니라 제공자의 기능 테스트 |

계약 테스트는 **호환성**을 검증하지 **정확성**을 검증하지 않는다. "할인 계산이 맞나" 는 제공자의 단위·통합 테스트 몫이다.

## 예시로 보기 — 이 프로젝트에서

이 사이트에는 서비스가 하나지만, 계약이 숨어 있는 곳이 있다.

| 경계 | 제공자 | 소비자 | 계약 |
|---|---|---|---|
| `/api/ask` SSE 이벤트 | 라우트 | `AskPanel.tsx` | `{type: "text"\|"tool_start"\|"tool_result"\|"usage"\|"error"\|"done", …}` |
| 실험 결과 | `runCodeExperiment` | 실험 화면, 도우미 `summarizeResult`, 결과 비교 | `{ok, steps[{cmd, result, ms, note?, error?}], durationMs}` |
| `/api/alerts` 웹훅 | Alertmanager | 앱 | Alertmanager 웹훅 v4 JSON |
| 퀴즈 파일 | 노트 작성자(사람·에이전트) | 퀴즈·간격 반복·평가 하네스 | `{note, q, a}` |

예를 들어 SSE 이벤트 계약은 이렇게 소비자 쪽 테스트로 고정할 수 있다.

```ts
// AskPanel 이 기대하는 이벤트 형태를 zod 스키마로 — 라우트의 출력에 그대로 적용
const AskEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_start"), name: z.string(), input: z.record(z.unknown()) }),
  z.object({ type: z.literal("usage"), model: z.string(), input: z.number(), output: z.number(), costUsd: z.number() }),
  z.object({ type: z.literal("done") }),
  // …
]);
// 통합 테스트: 실제 /api/ask 스트림의 모든 이벤트가 AskEvent.parse 를 통과해야 한다
```

퀴즈 파일은 사람과 에이전트가 손으로 쓰는 "계약" 이다. `{note, q, a}` 에서 `note` 가 실제 노트 slug 인지 검사하는 작은 테스트 하나가 많은 깨진 링크를 막는다. 실험 [`test-property-ratelimit`](/testing/lab/test-property-ratelimit) 처럼 생성기로 다양한 입력을 만들어 계약(스키마)을 검증하는 것도 가능하다 — [속성 기반 테스트](/testing/notes/05-property-based-testing).

## 실전에서는 어디에 쓰이나

> 팀마다 서비스를 따로 배포하는데 "B 팀이 필드 이름을 바꿔 A 팀 화면이 깨졌다" 가 반복될 때 계약 테스트가 등장한다. 전체 E2E 환경을 띄우지 않고 인터페이스 호환성만 싸게 확인한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 마이크로서비스 커머스(주문↔회원↔결제) | 독립 배포 중 응답 형태 불일치 | Pact 소비자 테스트 → 브로커 → 제공자 검증 → `can-i-deploy` | 공유 통합 환경의 E2E(느리고 불안정) |
| 공개 REST API 를 제공하는 SaaS | 소비자를 모르는 상태에서 깨는 변경 방지 | `oasdiff breaking` 으로 OpenAPI 이전 버전과 비교 | 버전별 엔드포인트 복제 |
| gRPC 기반 사내 플랫폼 | proto 필드 번호 재사용·타입 변경 | CI 에서 `buf breaking` | 리뷰어 눈으로 확인 |
| 이벤트 스트리밍(주문 이벤트) | 소비자가 많고 늦게 바뀌는 메시지 형태 | Schema Registry 호환성 모드(BACKWARD 등)로 등록 시점 거부 | 소비자별 방어 코드 |
| 모바일 앱 + 백엔드 | 구버전 앱이 오래 남아 있음 | 앱 버전별 계약을 브로커에 두고 배포 전 검증 | 강제 업데이트 |

**이럴 땐 안 맞는다**
- 소비자와 제공자가 한 저장소·한 배포 단위인 모놀리스: 타입 체크와 통합 테스트가 이미 같은 일을 한다.
- 비즈니스 정확성 검증: 계약 테스트는 호환성만 본다. "할인이 맞게 계산되나" 는 제공자의 단위·통합 테스트로.

**누가 매일 만나나** — 백엔드·모바일 개발자는 API 응답을 바꾸는 PR 에서 계약 검증이 실패할 때, 플랫폼 팀은 Pact 브로커·Schema Registry 를 운영하고 배포 파이프라인에 `can-i-deploy` 를 넣을 때 만난다.

**면접·실무 단골 질문**
- Q. 응답에 필드를 추가하는 것은 깨는 변경인가? → 관대한 수신자라면 아니다. 삭제·이름 변경·타입 변경·요청 필수 필드 추가가 깨는 변경이다.
- Q. 소비자 주도 계약과 스키마 기반의 차이는? → 전자는 실제 사용만 보호해 유연, 후자는 소비자 협조 없이 도입 가능하지만 보수적이다.

## 실습 체크리스트

- [ ] `/api/ask` 의 SSE 이벤트 종류를 라우트 코드에서 모두 찾아 위 스키마를 완성하기
- [ ] 퀴즈 파일의 `note` 필드가 실제 노트 파일과 일치하는지 검사하는 테스트를 설계하기
- [ ] OpenAPI 에서 "응답 필드 추가" 와 "요청 필수 필드 추가" 가 각각 누구에게 깨지는 변경인지 설명하기
- [ ] Pact 의 can-i-deploy 가 없으면 서로 다른 속도로 배포하는 두 팀 사이에 어떤 사고가 나는지 시나리오로 쓰기
- [ ] Outbox 테이블 컬럼 추가가 이벤트 소비자에게 깨지는 변경인지 판단 기준을 적기
