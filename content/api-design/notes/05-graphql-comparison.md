---
title: "GraphQL 과의 비교 — 클라이언트가 모양을 정할 때 생기는 것들"
order: 5
level: 중급
summary: "GraphQL 이 푸는 문제(오버페칭·언더페칭·여러 화면의 서로 다른 요구)와 대가(N+1 리졸버, HTTP 캐시 상실, 질의 복잡도 공격, 권한 검사의 위치). DataLoader 로 N+1 을 묶는 원리, 영속 질의와 복잡도 제한, REST·gRPC·GraphQL 을 어디에 쓸지 고르는 기준, 그리고 BFF 패턴"
tags: [GraphQL, N+1, DataLoader, 영속 질의, 복잡도 제한, BFF, 캐싱, 스키마]
experiments: [api-grpc-unary-vs-stream]
---

## GraphQL 이 푸는 문제

모바일 앱의 주문 상세 화면이 필요한 데이터를 떠올려 보자. 주문, 주문 항목, 각 항목의 상품 이름과 썸네일, 배송 상태. REST 로는 대개 이렇게 된다.

```
GET /orders/42                     → 주문 (필요 없는 필드 30개 포함)
GET /orders/42/items               → 항목 5개
GET /products/812, /products/813 …  → 상품 5번 (이름·썸네일만 필요한데 전체)
GET /shipments?order_id=42         → 배송
```

여기서 두 가지 문제가 보인다.

- **오버페칭**: 필요 없는 필드까지 받는다. 모바일 대역폭과 파싱 비용이 든다.
- **언더페칭**: 한 화면에 여러 번 왕복한다. RTT 가 큰 모바일에서 특히 느리다. [REST 노트](/api-design/notes/01-rest-principles) 에서 본 N+1 API 다.

GraphQL 은 **클라이언트가 필요한 모양을 질의로 보내고 서버가 그 모양대로 돌려주는** 방식이다.

```graphql
query OrderDetail($id: ID!) {
  order(id: $id) {
    id
    status
    items {
      quantity
      product { name thumbnailUrl }
    }
    shipment { carrier trackingNo status }
  }
}
```

왕복 1번, 필요한 필드만. 웹·iOS·안드로이드·관리자 화면이 서로 다른 모양을 원해도 서버 엔드포인트를 늘리지 않아도 된다.

## 스키마와 리졸버

GraphQL 서버는 **타입 스키마**와 필드마다의 **리졸버** 함수로 이뤄진다.

```graphql
type Order   { id: ID!  status: OrderStatus!  items: [OrderItem!]!  shipment: Shipment }
type OrderItem { quantity: Int!  product: Product! }
type Product { id: ID!  name: String!  thumbnailUrl: String }
type Query   { order(id: ID!): Order }
```

```ts
const resolvers = {
  Query: { order: (_, { id }) => db.orders.find(id) },
  Order: { items: (order) => db.orderItems.byOrder(order.id) },
  OrderItem: { product: (item) => db.products.find(item.productId) },   // ← 위험
};
```

실행 엔진이 질의 트리를 따라 내려가며 각 필드의 리졸버를 부른다. 이 단순함이 장점이자 함정이다.

## 함정 1 — 리졸버의 N+1

항목이 50개인 주문을 질의하면 `OrderItem.product` 리졸버가 50번 불리고, DB 질의도 50번 나간다. 목록 안의 목록이면 곱해진다. REST 에서 클라이언트가 하던 N+1 이 **서버 안으로 옮겨 왔을 뿐**이다.

해법은 **DataLoader** 다. 한 이벤트 루프 틱 동안 들어온 키를 모았다가 묶음 질의 한 번으로 바꾼다.

```ts
import DataLoader from "dataloader";

// 요청마다 새로 만든다 (캐시가 사용자 사이에 새지 않게)
const productLoader = new DataLoader<number, Product>(async (ids) => {
  const rows = await db.query("SELECT * FROM products WHERE id = ANY($1)", [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id) ?? new Error(`product ${id} 없음`));   // 순서를 맞춘다
});

const resolvers = {
  OrderItem: { product: (item, _, ctx) => ctx.productLoader.load(item.productId) },
};
```

50번의 `load()` 가 `WHERE id = ANY([...50개])` 한 번이 된다. 같은 ID 는 요청 안에서 한 번만 조회한다. [Redis 파이프라인](/redis/notes/06-pipelining) 이나 실험 `api-grpc-unary-vs-stream` 에서 본 "왕복 1000번 vs 1번" 과 같은 원리다(로컬에서도 순차 1000번은 165ms, 한 번에는 1.5ms 였다).

## 함정 2 — HTTP 캐시를 잃는다

REST 의 `GET /products/812` 는 URL 이 곧 캐시 키다. CDN·브라우저·프록시가 그대로 캐시한다([캐시 계층](/architecture/notes/10-cache-layers-cdn)). GraphQL 은 보통 **모든 질의를 `POST /graphql` 하나로** 보낸다. URL 이 하나라서 HTTP 캐시가 거의 쓸모없다.

대응은 이렇다.

| 방법 | 설명 |
|---|---|
| 영속 질의 + GET | 질의 문자열 대신 해시를 `GET /graphql?id=sha256…&variables=…` 로 → CDN 캐시 가능 |
| 클라이언트 정규화 캐시 | Apollo·urql 이 응답을 `__typename:id` 로 쪼개 저장 |
| 서버 측 리졸버 캐시 | 필드·엔터티 단위로 Redis 캐시 (`@cacheControl(maxAge: 60)`) |

## 함정 3 — 질의가 무기가 된다

클라이언트가 모양을 정한다는 것은 **악의적인 클라이언트도 모양을 정한다**는 뜻이다.

```graphql
query {
  users(first: 1000) {
    friends(first: 1000) {
      friends(first: 1000) { posts(first: 1000) { comments(first: 1000) { id } } }
    }
  }
}
```

요청 하나가 10^15 개 노드를 요구한다. REST 는 서버가 정한 엔드포인트만 있으니 이런 일이 없다. GraphQL 서버는 반드시 다음을 둔다.

| 방어 | 내용 |
|---|---|
| 깊이 제한 | 중첩 7단 이상 거부 |
| 복잡도(비용) 제한 | 필드마다 비용, `first` 인자로 곱해 총합 상한 |
| 페이지 크기 상한 | `first` 최대 100 |
| 영속 질의 (허용 목록) | 빌드 때 등록된 질의만 실행. 임의 질의 차단 — 공개 앱이라면 가장 확실 |
| 타임아웃·레이트리밋 | 요청 수가 아니라 **복잡도 점수** 기준으로 ([06](/api-design/notes/06-gateway-auth-ratelimit)) |
| 인트로스펙션 끄기 | 운영에서 스키마 탐색 차단 (보안이라기보다 공격 표면 축소) |

## 함정 4 — 권한 검사의 위치

REST 는 엔드포인트마다 권한을 검사한다. GraphQL 은 같은 객체에 여러 경로로 닿을 수 있다. `order.customer.paymentMethods` 처럼 깊은 경로로 남의 결제 수단을 읽는 일이 생긴다. 권한 검사는 **진입 리졸버가 아니라 데이터 접근 층(또는 타입 리졸버)** 에 둔다. 어떤 경로로 와도 같은 검사를 거치게 한다. [인증과 인가](/security/notes/03-authn-authz)의 객체 수준 인가가 GraphQL 에서 더 중요해진다.

## 에러와 부분 성공

GraphQL 은 HTTP 200 에 `data` 와 `errors` 를 함께 돌려줄 수 있다.

```json
{
  "data": { "order": { "id": "42", "shipment": null } },
  "errors": [{ "message": "배송 서비스 응답 없음", "path": ["order", "shipment"], "extensions": { "code": "UNAVAILABLE" } }]
}
```

배송 서비스가 죽어도 주문 화면은 나온다. 장점이다. 하지만 모니터링 입장에서는 HTTP 200 이라 에러율 메트릭에 안 잡힌다. [gRPC 의 트레일러](/api-design/notes/03-protobuf-grpc) 와 같은 문제다. `errors[].extensions.code` 를 메트릭으로 따로 세야 한다.

## REST · gRPC · GraphQL — 어디에 무엇을

| 기준 | REST + JSON | gRPC | GraphQL |
|---|---|---|---|
| 주 사용처 | 공개 API, 파트너, 웹훅 | 서비스 ↔ 서비스 | 여러 클라이언트(웹·앱)를 위한 앞단 |
| 계약 | OpenAPI | .proto | GraphQL 스키마 |
| 브라우저 | 그대로 | gRPC-Web/Connect 필요 | 그대로 |
| HTTP 캐시 | 강함 | 약함 | 약함 (영속 질의로 보완) |
| 스트리밍 | SSE·WebSocket 따로 | 1급 | Subscription (보통 WebSocket) |
| 성능 오버헤드 | 중간 | 낮음 | 리졸버·파싱 비용, N+1 위험 |
| 보안 표면 | 엔드포인트별 | 서비스별 | **질의 복잡도** 가 새 공격 면 |
| 도구·운영 성숙도 | 가장 넓음 | 넓음 | 넓지만 운영 노하우 필요 |

실제 시스템은 섞어 쓴다. 흔한 구조는 이렇다.

```
모바일 앱 ─┐
웹       ─┼─→ BFF (GraphQL 또는 화면별 REST) ─→ 내부 서비스들 (gRPC) ─→ DB·캐시·브로커
파트너   ───→ 공개 REST API (OpenAPI, 버전 고정)
```

## BFF — 클라이언트별 앞단

**BFF(Backend for Frontend)** 는 클라이언트 종류마다 전용 앞단 서비스를 두는 패턴이다. GraphQL 을 쓰지 않아도 같은 문제를 풀 수 있다. 모바일 BFF 가 화면에 맞춘 묶음 응답을 만들고, 내부 서비스 여러 개를 병렬로 부른다. GraphQL 은 "BFF 를 범용 질의 언어로 만든 것" 으로 볼 수 있다.

| | 화면별 BFF (REST) | GraphQL |
|---|---|---|
| 새 화면 요구 | BFF 엔드포인트 추가·배포 | 클라이언트가 질의만 바꿈 |
| 성능 예측 | 쉬움 (고정된 호출) | 질의마다 다름 |
| 팀 구조 | 프런트 팀이 BFF 소유 | 플랫폼 팀이 스키마 소유 |

## 예시로 보기 — 이 프로젝트에서

이 사이트의 주제 대시보드는 한 화면에 노트 목록, 진행률, 퀴즈 통계, 학습 시간, 환경 점검을 모은다. 서버 컴포넌트가 이것들을 **서버 안에서 병렬로** 가져와 한 번에 렌더링하므로, 브라우저 입장에서는 왕복이 1번이다. 사실상 BFF 가 페이지 렌더러 안에 들어 있는 구조다.

그런데 서버 안에서도 N+1 은 생긴다. 성능 노트의 실험 `perf-k6-redis-path` 가 찾은 것이 그 예다. 첫 화면이 주제마다 진행률을 따로 읽어 Redis 왕복이 `주제 수 × 3` 이 됐다. 이것을 `SMEMBERS` 한 번으로 읽어 메모리에서 나누도록 고쳤다. DataLoader 가 하는 일을 손으로 한 것이다.

## 실습 체크리스트

- [ ] 위 OrderDetail 질의를 REST 로 구현하면 왕복이 몇 번인지, GraphQL + DataLoader 면 DB 질의가 몇 번인지 세어 보기
- [ ] DataLoader 의 배치 함수가 왜 입력 키 순서대로 결과를 돌려줘야 하는지 설명하기
- [ ] 위의 중첩 질의 공격에 대해 깊이·복잡도·`first` 상한 중 무엇이 가장 효과적인지 근거와 함께 적기
- [ ] 내 서비스에 GraphQL 을 도입한다면 HTTP 캐시를 어떻게 되찾을지 정하기 (영속 질의? 클라이언트 캐시?)
- [ ] 이 사이트의 주제 대시보드가 부르는 데이터 원천을 나열하고, 그중 N+1 이 생길 수 있는 곳 찾기
