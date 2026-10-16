---
title: REST 설계 원칙 — 리소스, 메서드의 의미, 상태 코드, 멱등, 페이지네이션
order: 1
level: 기초
summary: "API 는 사용자가 바꾸기 어려운 계약이다. 리소스와 URL 을 고르는 법, GET·POST·PUT·PATCH·DELETE 의 의미와 안전·멱등 성질, 상태 코드를 고르는 기준과 에러 본문(RFC 9457), POST 를 멱등하게 만드는 Idempotency-Key, 오프셋 vs 커서 페이지네이션, 필터·정렬·부분 응답, 그리고 이 프로젝트의 API 를 직접 점검한다"
tags: [REST, HTTP, 멱등, 상태 코드, Problem Details, 페이지네이션, 커서, Idempotency-Key]
experiments: [api-idempotency-key, api-grpc-unary-vs-stream]
---

## API 는 바꾸기 어려운 계약이다

내부 함수는 리팩터링하면 끝이다. 공개된 API 는 다르다. 모바일 앱의 옛 버전, 파트너사의 배치 작업, 다른 팀의 서비스가 그 모양에 기대어 돌아간다. 그래서 API 설계의 목표는 "지금 편한 것" 이 아니라 **오래 버티고, 오해하기 어렵고, 바꿀 수 있는 것** 이다.

이 주제의 노트는 다음 순서로 간다.

| 노트 | 질문 |
|---|---|
| 01 (이 노트) | REST 로 무엇을 어떻게 표현하나 |
| [02 OpenAPI](/api-design/notes/02-openapi-contract-first) | 그 계약을 어떻게 기계가 읽게 쓰나 |
| [03 Protobuf·gRPC](/api-design/notes/03-protobuf-grpc) | 서비스 간 호출은 왜 다르게 하나 |
| [04 에러·재시도·데드라인](/api-design/notes/04-errors-retries-deadlines) | 실패를 어떻게 설계하나 |
| [05 GraphQL](/api-design/notes/05-graphql-comparison) | 클라이언트가 모양을 정하면 |
| [06 게이트웨이·인증·레이트리밋](/api-design/notes/06-gateway-auth-ratelimit) | 앞단에서 무엇을 막나 |
| [07 버전·진화·거버넌스](/api-design/notes/07-versioning-evolution-governance) | 깨지 않고 어떻게 바꾸나 |

## 리소스와 URL

REST 의 중심은 **리소스**(명사)다. 동작은 HTTP 메서드가 맡는다.

```
GET    /orders                 주문 목록
POST   /orders                 주문 생성
GET    /orders/42              주문 하나
PATCH  /orders/42              일부 수정
DELETE /orders/42              삭제(취소)
GET    /orders/42/items        하위 리소스
```

규칙 몇 가지가 대부분의 혼란을 막는다.

- **복수형 명사**: `/orders`, `/users`. 동사(`/createOrder`)를 URL 에 넣지 않는다.
- **계층은 소유 관계일 때만**: `/orders/42/items` 는 자연스럽다. `/users/7/orders/42/items/3/reviews` 처럼 깊어지면 `/reviews?item_id=3` 이 낫다.
- **ID 는 불투명하게**: 클라이언트가 ID 를 해석하지 않게 한다. 순차 정수는 개수를 노출하고 추측을 허용한다(IDOR 위험 — [인증과 인가](/security/notes/03-authn-authz)). 외부에는 UUIDv7·ULID 같은 정렬 가능한 무작위 ID 가 무난하다.
- **동작이 정말 명사로 안 될 때**: 상태 전이는 하위 리소스나 동작 리소스로. `POST /orders/42/cancellation`, `POST /payments/9/refunds`. "취소라는 사건을 만든다" 로 읽으면 REST 와 어긋나지 않는다.

## 메서드의 의미 — 안전과 멱등

HTTP 는 메서드마다 **약속**을 정의한다. 프록시·캐시·클라이언트 라이브러리·재시도 로직이 이 약속을 믿고 동작한다.

| 메서드 | 안전(서버 상태 안 바꿈) | 멱등(여러 번 = 한 번) | 캐시 가능 | 쓰임 |
|---|---|---|---|---|
| GET | ✓ | ✓ | ✓ | 조회 |
| HEAD | ✓ | ✓ | ✓ | 헤더만 |
| PUT | ✗ | ✓ | ✗ | 전체 교체(없으면 생성) |
| DELETE | ✗ | ✓ | ✗ | 삭제 |
| PATCH | ✗ | ✗ (설계에 따라) | ✗ | 일부 수정 |
| POST | ✗ | ✗ | 드묾 | 생성, 처리 요청 |

**멱등**은 "같은 요청을 N 번 보내도 서버 상태가 한 번 보낸 것과 같다" 는 뜻이다. 응답까지 같을 필요는 없다. `DELETE /orders/42` 를 두 번 보내면 두 번째는 404 일 수 있지만 상태는 같다(삭제됨).

왜 중요할까. 네트워크는 응답을 잃는다. 클라이언트는 **요청이 처리됐는지 모른 채** 타임아웃을 맞는다. 멱등 요청이면 그냥 재시도하면 된다. 멱등이 아니면 재시도가 이중 처리를 만든다.

```http
PATCH /accounts/7      {"balance_delta": +1000}     ← 재시도하면 2000 이 더해진다 (멱등 아님)
PATCH /accounts/7      {"balance": 51000}           ← 재시도해도 51000 (멱등)
```

PATCH 를 멱등하게 설계할 수 있다면 그렇게 한다. "증가" 같은 연산이 필요하면 POST 에 멱등 키를 붙인다.

## POST 를 멱등하게 — Idempotency-Key

결제·주문 생성처럼 POST 가 필요한데 이중 처리는 절대 안 되는 경우의 표준 해법이다.

1. 클라이언트가 **요청마다** 고유 키(UUID)를 만든다. 재시도할 때는 **같은 키**를 다시 쓴다.
2. 서버는 키를 원자적으로 선점한다. Redis `SET key value NX EX 86400` 이나 DB 유니크 제약.
3. 선점에 성공한 요청만 실제 처리하고, 결과(상태 코드 + 본문)를 키에 저장한다.
4. 같은 키로 다시 오면 처리하지 않고 저장된 결과를 그대로 돌려준다.
5. 같은 키에 **다른 본문**이 오면 422 — 클라이언트 버그다.

### 예시로 보기 — 실험 `api-idempotency-key`

실험은 Node HTTP 서버로 `POST /payments` 를 만들고 위 다섯 단계를 구현했다. 실제로 돌린 결과다.

| 시나리오 | 결과 |
|---|---|
| 같은 키로 10개 **동시** 전송 | 실제 결제 1건, 응답 10개 모두 `pay_1`, 9개는 `Idempotent-Replayed: true` |
| 같은 키에 금액만 바꿔 재요청 | 422 |
| 한참 뒤 같은 키·같은 본문 재시도 | 재생 응답, 결제 수 그대로 1 |
| 키 없이 10개 동시 전송 | 결제 10건 — 이중 결제 |

마지막 줄이 이 패턴이 필요한 이유다. 키를 언제까지 보관할지(보통 24시간), 처리 도중 서버가 죽어 "처리 중" 이 남으면 어떻게 할지는 [결제와 원장](/architecture/notes/09-payments-ledger-consistency) 에서 더 깊게 다룬다.

## 상태 코드 — 클라이언트가 무엇을 해야 하는지 알려 준다

상태 코드를 고르는 질문은 하나다. **클라이언트가 이 응답을 보고 다음에 무엇을 해야 하는가?**

| 코드 | 의미 | 클라이언트 행동 |
|---|---|---|
| 200 OK | 성공, 본문 있음 | 사용 |
| 201 Created | 생성됨 | `Location` 헤더의 새 리소스 확인 |
| 202 Accepted | 접수, 처리는 나중 | 상태 리소스를 폴링하거나 웹훅 대기 |
| 204 No Content | 성공, 본문 없음 | 끝 |
| 304 Not Modified | 캐시가 아직 유효 | 캐시 사용 |
| 400 Bad Request | 형식이 틀림 | 고쳐서 다시 — 재시도 무의미 |
| 401 Unauthorized | 인증 안 됨 | 로그인·토큰 갱신 |
| 403 Forbidden | 인증은 됐지만 권한 없음 | 권한 요청 |
| 404 Not Found | 없음 (또는 존재를 숨김) | — |
| 409 Conflict | 현재 상태와 충돌 (버전 충돌, 처리 중) | 다시 읽고 판단 |
| 412 Precondition Failed | `If-Match` 실패 — 남이 먼저 바꿈 | 다시 읽고 병합 |
| 422 Unprocessable Content | 형식은 맞는데 의미가 틀림 | 입력 수정 |
| 429 Too Many Requests | 레이트리밋 | `Retry-After` 만큼 기다림 |
| 500 | 서버 버그 | 제한적으로 재시도 |
| 502/503/504 | 상류·과부하·타임아웃 | 백오프 재시도 |

흔한 실수 두 가지가 있다.

- **모든 에러를 200 으로 감싸기**: `{"success": false}`. 프록시·모니터링·재시도 로직이 전부 성공으로 본다. 에러율 알림이 울리지 않는다.
- **4xx 와 5xx 를 섞기**: 클라이언트 잘못을 500 으로 내면 서버 에러율이 오르고 온콜이 깬다. 서버 잘못을 400 으로 내면 아무도 고치지 않는다.

### 에러 본문 — Problem Details (RFC 9457)

에러 본문의 모양도 계약이다. 표준 형식을 쓰면 클라이언트 라이브러리가 일관되게 다룬다.

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://api.example.com/problems/insufficient-stock",
  "title": "재고가 부족합니다",
  "status": 422,
  "detail": "상품 812 의 재고는 2개인데 5개를 주문했습니다",
  "instance": "/orders/req-7f3a",
  "errors": [{ "pointer": "/items/0/quantity", "detail": "최대 2" }],
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

`type` 은 기계가 분기하는 키, `title`·`detail` 은 사람이 읽는 문장이다. `trace_id` 를 넣으면 사용자가 보낸 스크린샷 하나로 [트레이스](/observability/notes/06-tracing-otel)를 찾을 수 있다.

## 동시 수정 — ETag 와 낙관적 잠금

두 관리자가 같은 상품을 동시에 편집하면 나중 저장이 먼저 저장을 덮는다(lost update). HTTP 는 이를 위한 장치를 이미 갖고 있다.

```http
GET /products/812
ETag: "v17"

PUT /products/812
If-Match: "v17"
{ ...수정된 전체... }

→ 412 Precondition Failed    (그 사이 누가 v18 로 바꿨다)
```

서버는 DB 의 버전 컬럼으로 `UPDATE ... WHERE id = 812 AND version = 17` 을 실행하고, 영향받은 행이 0 이면 412 를 돌려준다. PostgreSQL 노트의 격리 수준과 같은 문제를 HTTP 층에서 푸는 방법이다.

## 페이지네이션 — 오프셋 vs 커서

목록 API 는 반드시 페이지를 나눈다. 방법은 두 가지가 있다.

| | 오프셋 `?page=3&size=20` | 커서 `?after=eyJpZCI6...&limit=20` |
|---|---|---|
| 구현 | `LIMIT 20 OFFSET 40` | `WHERE (created_at, id) < ($1, $2) ORDER BY ... LIMIT 20` |
| 깊은 페이지 | 느려진다 — DB 가 앞의 행을 다 읽고 버린다 | 일정 — 인덱스에서 바로 시작 |
| 중간 삽입·삭제 | 항목이 **중복되거나 빠진다** | 안정적 |
| 임의 페이지 이동 | 가능 ("37페이지로") | 불가 (앞/뒤만) |
| 전체 개수 | 쉽다 (`COUNT(*)`, 비쌈) | 보통 안 준다 |

피드·로그·주문 내역처럼 계속 쌓이는 목록은 **커서**가 맞다. 관리 화면의 표처럼 페이지 번호가 필요하고 데이터가 작으면 오프셋도 괜찮다. PostgreSQL 실험실의 `pg-keyset-pagination` 실험이 깊은 오프셋이 얼마나 느려지는지 실제로 잰다.

커서는 **불투명한 문자열**로 준다. 내부 컬럼(`created_at`, `id`)을 base64 로 감싸 두면 나중에 정렬 키를 바꿔도 클라이언트가 깨지지 않는다.

```json
{
  "data": [ ... 20개 ... ],
  "page": { "next_cursor": "eyJjIjoiMjAyNi0xMC0xNlQxMjowMDowMFoiLCJpIjo4MTJ9", "has_more": true }
}
```

## 필터·정렬·부분 응답

```
GET /orders?status=paid&created_after=2026-10-01&sort=-created_at,id&fields=id,total,status
```

- **필터**는 단순한 `key=value` 로 시작한다. 복잡한 검색이 필요하면 별도 검색 리소스(`POST /orders/search`)나 [검색 엔진](/opensearch)을 둔다. 임의 SQL 같은 필터 언어는 인덱스 없는 질의를 허용해 DB 를 위험하게 한다.
- **정렬**은 허용 목록으로 제한한다. 인덱스가 없는 정렬을 열어 두면 한 요청이 DB 를 멈출 수 있다.
- **부분 응답**(`fields=`)은 모바일처럼 대역폭이 귀한 클라이언트에 유용하다. 이 요구가 커지면 [GraphQL](/api-design/notes/05-graphql-comparison) 이 후보가 된다.

## 큰 응답과 왕복 횟수

API 성능은 대부분 **왕복 횟수**에서 결정된다. 실험 `api-grpc-unary-vs-stream` 에서 같은 1000개 항목을 받는 데 걸린 시간이다(로컬, 같은 프로세스).

| 방식 | 시간 |
|---|---|
| JSON 배열 한 번 (`GET /items`) | 1.5ms |
| JSON 1000번 순차 (`GET /items/:id`, keep-alive) | 51ms |
| gRPC unary 1000번 순차 | 165ms |

로컬에서도 1000번 왕복은 수십 배 느리다. 네트워크 RTT 가 1ms 만 돼도 순차 1000번은 1초가 넘는다. 클라이언트가 목록을 받아 항목마다 상세를 다시 부르는 **N+1 API** 를 만들지 말자. 목록 응답에 화면에 필요한 필드를 넣거나 묶음 조회(`GET /items?ids=1,2,3`)를 제공한다. [Redis 파이프라인](/redis/notes/06-pipelining) 과 같은 원리다.

## 예시로 보기 — 이 프로젝트에서

이 사이트도 HTTP API 를 갖고 있다. 위 원칙으로 점검해 보자.

| 엔드포인트 | 현재 | 점검 |
|---|---|---|
| `GET /api/metrics` | Prometheus 텍스트 | 안전·멱등. 인증 없음 — 내부망 전용이어야 한다 |
| `POST /api/alerts` | Alertmanager 웹훅 수신 | Alertmanager 는 재시도한다 → 같은 알림이 두 번 올 수 있다. `fingerprint + startsAt` 로 중복을 걸러야 멱등 |
| `POST /api/ask` | AI 질문, SSE 스트리밍 응답 | 멱등 아님(비용 발생). 레이트리밋이 없다 → [06](/api-design/notes/06-gateway-auth-ratelimit) 에서 다룬다 |
| `GET /api/ask` | 설정 조회 | 안전 |

`POST /api/alerts` 의 중복 처리 같은 질문을 스스로 던지는 것이 API 설계 감각이다.

## 실습 체크리스트

- [ ] 실험 `api-idempotency-key` 를 돌리고, 키 없이 10번 보냈을 때 결제가 10건이 되는 것을 확인하기
- [ ] 같은 키·다른 본문이 왜 422 여야 하는지(200 이나 409 가 아닌 이유) 한 문장으로 설명하기
- [ ] 내가 아는 API 하나를 골라 모든 에러가 200 으로 오지 않는지, 4xx·5xx 가 섞여 있지 않은지 점검하기
- [ ] PostgreSQL 실험 `pg-keyset-pagination` 을 돌려 깊은 오프셋의 비용을 숫자로 보기
- [ ] 이 사이트의 `POST /api/alerts` 를 멱등하게 만드는 설계를 적어 보기 (키는 무엇으로?)
