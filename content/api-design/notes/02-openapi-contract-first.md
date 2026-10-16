---
title: OpenAPI 와 계약 우선 설계 — 스키마, 코드 생성, 검증, 문서
order: 2
level: 기초
summary: "API 의 모양을 사람의 기억이 아니라 기계가 읽는 문서로 고정한다. OpenAPI 3.1 문서의 구조(paths·components·schemas·responses), JSON Schema 로 표현하는 제약, 코드 우선과 계약 우선의 차이, 스펙에서 클라이언트·서버 타입을 생성하고 요청·응답을 런타임에 검증하는 법, 목 서버와 계약 테스트, 문서 자동화, 그리고 흔한 함정"
tags: [OpenAPI, JSON Schema, 계약 우선, 코드 생성, 검증, Zod, 목 서버, 계약 테스트]
experiments: [api-idempotency-key]
---

## 왜 계약을 문서로 고정하나

[REST 설계 원칙](/api-design/notes/01-rest-principles) 에서 API 는 바꾸기 어려운 계약이라고 했다. 그런데 그 계약이 어디에 적혀 있나? 대개 세 곳에 흩어져 있다.

1. 서버 코드 (진짜 동작)
2. 위키 문서 (언젠가 맞았던 설명)
3. 클라이언트 개발자의 기억 (가장 최신일 수도, 가장 틀릴 수도)

셋이 어긋나면 버그는 통합 단계나 운영에서야 드러난다. **OpenAPI** 는 이 계약을 기계가 읽는 한 파일로 만든다. 그 파일에서 문서, 클라이언트 SDK, 서버 검증, 목 서버, 계약 테스트가 전부 나온다.

## OpenAPI 문서의 뼈대

```yaml
openapi: 3.1.0
info:
  title: Study Payments API
  version: 1.4.0
servers:
  - url: https://api.example.com/v1
paths:
  /payments:
    post:
      operationId: createPayment          # 코드 생성 시 함수 이름이 된다
      summary: 결제를 생성한다
      parameters:
        - in: header
          name: Idempotency-Key
          required: true
          schema: { type: string, format: uuid }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/PaymentCreate" }
      responses:
        "201":
          description: 생성됨
          headers:
            Idempotent-Replayed: { schema: { type: boolean } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Payment" }
        "422": { $ref: "#/components/responses/Problem" }
        "429": { $ref: "#/components/responses/RateLimited" }
components:
  schemas:
    PaymentCreate:
      type: object
      required: [amount, currency, order_id]
      additionalProperties: false
      properties:
        amount:   { type: integer, minimum: 1, maximum: 100000000, description: "최소 화폐 단위(원)" }
        currency: { type: string, enum: [KRW, USD] }
        order_id: { type: string, pattern: "^ord_[0-9A-Za-z]{20}$" }
    Payment:
      allOf:
        - $ref: "#/components/schemas/PaymentCreate"
        - type: object
          required: [id, status, created_at]
          properties:
            id:         { type: string, readOnly: true }
            status:     { type: string, enum: [pending, succeeded, failed] }
            created_at: { type: string, format: date-time }
  responses:
    Problem:
      description: 요청을 처리할 수 없음 (RFC 9457)
      content:
        application/problem+json:
          schema: { $ref: "#/components/schemas/Problem" }
```

구성 요소를 정리하면 이렇다.

| 부분 | 역할 |
|---|---|
| `paths` | URL × 메서드 = 오퍼레이션. 파라미터·요청 본문·응답 |
| `operationId` | 오퍼레이션의 안정적인 이름. SDK 함수 이름이 된다. **바꾸면 SDK 가 깨진다** |
| `components.schemas` | 재사용하는 데이터 모양. 3.1 부터 **JSON Schema 2020-12** 와 완전히 같다 |
| `components.responses` | 재사용하는 응답(에러 형식 등) |
| `securitySchemes` | 인증 방식(Bearer, OAuth2, API key) |

## 스키마로 표현할 수 있는 것 — 그리고 없는 것

JSON Schema 는 "형식" 을 꽤 많이 표현한다.

| 제약 | 키워드 | 예 |
|---|---|---|
| 필수 필드 | `required` | `[amount, currency]` |
| 모르는 필드 거부 | `additionalProperties: false` | 오타 필드(`ammount`)가 조용히 무시되는 것을 막는다 |
| 범위·길이 | `minimum`, `maxLength`, `maxItems` | 거대한 배열로 서버를 괴롭히는 요청 차단 |
| 형식 | `format: uuid / date-time / email`, `pattern` | |
| 열거 | `enum` | 상태값 |
| 다형성 | `oneOf` + `discriminator` | 결제 수단별로 다른 필드 |
| 읽기/쓰기 전용 | `readOnly`, `writeOnly` | `id` 는 응답에만, `password` 는 요청에만 |

표현할 수 **없는** 것도 알아야 한다. "주문 금액은 재고 합계 이하", "같은 키·같은 본문이어야 함" 같은 **필드 간·상태 의존 규칙**은 스키마 밖이다. 이것은 422 로 응답하고 문서의 `description` 과 에러 `type` 으로 설명한다.

돈은 반드시 **정수 최소 단위**로. `amount: 39000.0` 같은 부동소수는 `0.1 + 0.2` 문제를 계약에 심는다. 큰 정수(64비트 ID)는 JavaScript 의 `Number` 가 2^53 위에서 정밀도를 잃으므로 **문자열**로 주는 것이 안전하다.

## 코드 우선 vs 계약 우선

| | 코드 우선 | 계약 우선 |
|---|---|---|
| 순서 | 서버 코드 → 애너테이션/데코레이터 → 스펙 생성 | 스펙 작성·리뷰 → 서버·클라이언트 생성 |
| 장점 | 빠르게 시작, 스펙이 코드와 어긋나지 않음 | 클라이언트·서버 병렬 개발, 설계 리뷰가 먼저 |
| 단점 | 설계 리뷰가 늦다. 구현 세부(내부 필드)가 새어 나간다 | 스펙과 구현이 어긋나지 않게 검증 장치가 필요 |
| 어울리는 곳 | 내부 API, 1인·소규모 | 공개 API, 여러 팀·SDK 를 내는 API |

현실에서는 섞어 쓴다. TypeScript 진영에서는 **Zod 스키마를 진실의 원천**으로 두고 거기서 런타임 검증과 OpenAPI 를 같이 생성하는 방식이 많이 쓰인다.

```ts
import { z } from "zod";

export const PaymentCreate = z.object({
  amount: z.number().int().min(1).max(100_000_000),
  currency: z.enum(["KRW", "USD"]),
  order_id: z.string().regex(/^ord_[0-9A-Za-z]{20}$/),
}).strict();                                  // additionalProperties: false

type PaymentCreate = z.infer<typeof PaymentCreate>;   // 타입도 같은 원천에서
// zod-to-openapi 같은 도구로 components.schemas 를 생성한다
```

## 스펙에서 무엇을 생성하나

```bash
# 클라이언트 타입 (TypeScript)
npx openapi-typescript openapi.yaml -o src/api/schema.d.ts

# 린트: 규칙 위반(operationId 누락, 에러 응답 없음, 복수형 아님)
npx @redocly/cli lint openapi.yaml

# 문서 사이트
npx @redocly/cli build-docs openapi.yaml -o docs/api.html

# 목 서버: 스펙의 example 로 응답
npx @stoplight/prism-cli mock openapi.yaml
```

생성된 타입을 쓰면 클라이언트 코드가 스펙과 어긋날 때 **컴파일이 깨진다**. 이것이 계약을 문서로 만드는 가장 큰 보상이다.

```ts
import type { paths } from "./api/schema";
type CreatePaymentBody = paths["/payments"]["post"]["requestBody"]["content"]["application/json"];
type CreatePaymentRes  = paths["/payments"]["post"]["responses"]["201"]["content"]["application/json"];
```

## 런타임 검증 — 경계에서 한 번

타입은 컴파일 시점의 약속일 뿐이다. 네트워크로 들어온 JSON 은 무엇이든 될 수 있다. 그래서 **신뢰 경계에서 한 번** 검증한다.

```ts
export async function POST(req: Request) {
  const parsed = PaymentCreate.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({
      type: "https://api.example.com/problems/validation",
      title: "요청 형식이 올바르지 않습니다",
      status: 400,
      errors: parsed.error.issues.map((i) => ({ pointer: "/" + i.path.join("/"), detail: i.message })),
    }, { status: 400, headers: { "Content-Type": "application/problem+json" } });
  }
  // 이 아래에서는 parsed.data 의 타입을 믿는다
}
```

**응답도 검증하라**는 조언이 있다. 운영에서 매 요청 검증은 비용이 들지만, 테스트·스테이징에서 응답을 스펙과 대조하면 "서버가 실수로 내부 필드를 내보냄" 같은 사고를 잡는다.

## 계약 테스트 — 스펙과 구현이 같은지

스펙만 있고 서버가 어긋나면 의미가 없다. 확인하는 방법이 세 단계로 있다.

| 방법 | 무엇을 확인 | 도구 예 |
|---|---|---|
| 스펙 기반 퍼징 | 스펙의 모든 오퍼레이션에 경계값을 보내 5xx·스펙 위반 응답 찾기 | Schemathesis |
| 소비자 주도 계약 | 클라이언트가 "내가 쓰는 필드" 를 기록 → 서버가 그 기대를 만족하는지 CI 에서 검증 | Pact |
| 응답 스냅샷 검증 | 통합 테스트에서 실제 응답을 스키마로 검증 | ajv, zod |

```bash
# 스펙의 모든 엔드포인트를 무작위 입력으로 두드려 본다
schemathesis run openapi.yaml --base-url http://localhost:3000 --checks all
```

Schemathesis 는 `maxLength` 를 넘는 문자열, 빈 배열, 유니코드 경계값을 자동으로 만든다. 사람이 쓴 테스트가 놓치는 500 을 놀라울 만큼 잘 찾는다.

## 예시로 보기 — 이 프로젝트에서

실험 `api-idempotency-key` 의 `POST /payments` 를 스펙으로 쓰면 위 문서가 된다. 이 스펙이 있었다면 다음 결정들이 **코드 리뷰 전에** 문서에서 드러났을 것이다.

- `Idempotency-Key` 가 `required: true` 인가? (실험은 선택이었고, 그래서 키 없이 10번 → 결제 10건이 났다)
- 422 와 409 응답이 문서에 있는가? 클라이언트는 둘을 다르게 처리해야 한다.
- `Idempotent-Replayed` 헤더가 응답 헤더로 선언돼 있는가?

이 사이트의 `/api/ask` 처럼 **SSE 스트리밍** 응답은 OpenAPI 로 표현하기 어렵다. `text/event-stream` 콘텐츠 타입과 이벤트 종류를 `description` 과 예시로 적고, 이벤트 본문 스키마는 `components.schemas` 에 따로 둔다. gRPC 처럼 스트리밍이 1급인 계약이 필요하면 [Protobuf](/api-design/notes/03-protobuf-grpc) 가 더 낫다.

## 흔한 함정

| 함정 | 결과 | 대응 |
|---|---|---|
| `additionalProperties` 를 안 막음 | 오타 필드가 무시되고 기본값으로 처리 | 요청 스키마는 `false` (응답은 확장 가능하게 열어 둘 수 있다) |
| `nullable` 과 "필드 없음" 을 혼용 | PATCH 에서 "지우기" 와 "안 바꾸기" 를 구분 못 함 | PATCH 는 JSON Merge Patch(RFC 7396) 의미를 명시 |
| enum 에 값 추가 | 옛 클라이언트가 모르는 값을 받고 크래시 | 클라이언트는 모르는 enum 을 `unknown` 으로 처리하도록 문서화 ([07](/api-design/notes/07-versioning-evolution-governance)) |
| `operationId` 변경 | 생성된 SDK 의 함수 이름이 바뀌어 빌드 깨짐 | 린트 규칙으로 변경 감지 |
| 예시(example) 없음 | 목 서버가 쓸모없는 값을 냄 | 모든 스키마에 현실적인 example |
| 스펙만 있고 CI 검증 없음 | 몇 달 뒤 스펙과 서버가 다름 | 퍼징·계약 테스트를 CI 에 |

## 실습 체크리스트

- [ ] 실험 `api-idempotency-key` 의 `POST /payments` 를 OpenAPI 3.1 로 써 보고 `@redocly/cli lint` 통과시키기
- [ ] 같은 스키마를 Zod 로 쓰고 `z.infer` 타입과 생성된 OpenAPI 타입이 같은지 비교하기
- [ ] 스펙에 `additionalProperties: false` 를 넣고, 오타 필드를 보냈을 때 400 이 나는지 확인하기
- [ ] Prism 목 서버로 클라이언트를 먼저 개발해 보기 — 서버 없이 화면을 만들 수 있는지
- [ ] 이 사이트의 `/api/ask` 이벤트(text·tool_start·tool_result·usage·done·error)를 스키마로 정리해 보기
