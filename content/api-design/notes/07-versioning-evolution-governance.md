---
title: "심화 — 버전 호환성, 스키마 진화, API 거버넌스"
order: 7
level: 심화
summary: "API 를 깨지 않고 바꾸는 법. 무엇이 깨지는 변경인지(필드 제거·타입 변경·enum 추가·의미 변경) 를 REST·Protobuf 별로 정리하고, 관대한 수신자 원칙, Protobuf 필드 번호 규칙과 reserved, buf breaking 으로 CI 에서 막는 법, URL·헤더·패키지 버전 전략, 폐기(Deprecation·Sunset 헤더) 절차와 사용량 측정, 스타일 린트·리뷰 체크리스트로 하는 API 거버넌스"
tags: [버전 관리, 하위 호환, 스키마 진화, buf breaking, reserved, Deprecation, Sunset, 거버넌스, 린트]
experiments: [api-grpc-unary-vs-stream]
---

## 깨지 않고 바꾸기

API 는 반드시 바뀐다. 문제는 바꿀 때 누가 깨지느냐다. 이 노트의 목표는 두 가지다.

1. 대부분의 변경을 **버전을 올리지 않고** 할 수 있게 한다.
2. 꼭 깨야 할 때는 **예고하고, 측정하고, 천천히** 깬다.

## 호환성의 두 방향

| 방향 | 질문 | 예 |
|---|---|---|
| **하위 호환** (backward) | 새 서버가 옛 클라이언트를 받을 수 있나 | 서버에 필드를 추가해도 옛 앱이 잘 돈다 |
| **상위 호환** (forward) | 옛 코드가 새 데이터를 받을 수 있나 | 옛 소비자가 새 필드가 든 메시지를 받아도 안 죽는다 |

서버만 배포하면 되는 REST API 는 하위 호환이 주 관심사다. 하지만 **메시지·이벤트**는 양쪽 다 필요하다. 생산자와 소비자가 서로 다른 시점에 배포되고, 큐에는 옛 메시지와 새 메시지가 섞여 있기 때문이다. [Kafka 의 Schema Registry](/kafka/notes/06-streams-connect-schema) 가 호환성 모드(BACKWARD·FORWARD·FULL)를 강제하는 이유다.

## 무엇이 깨지는 변경인가 — REST/JSON

| 변경 | 안전? | 이유 |
|---|---|---|
| 응답에 필드 추가 | ✓ (대부분) | 클라이언트가 모르는 필드를 무시한다면 |
| 요청에 **선택** 필드 추가 | ✓ | 기본값이 기존 동작과 같다면 |
| 요청에 **필수** 필드 추가 | ✗ | 옛 클라이언트는 보내지 않는다 |
| 응답 필드 제거·이름 변경 | ✗ | |
| 필드 타입 변경 (`"42"` → `42`) | ✗ | |
| enum 에 값 추가 (응답) | **△ 위험** | 모르는 값에 `switch` 가 크래시하는 클라이언트가 있다 |
| 기본값·정렬 순서 변경 | ✗ (조용히) | 형식은 같은데 의미가 바뀐다 — 가장 찾기 어렵다 |
| 에러 코드·상태 코드 변경 | ✗ | 클라이언트의 분기가 틀어진다 |
| 검증 강화 (최대 길이 축소) | ✗ | 어제 통과하던 요청이 오늘 400 |
| 검증 완화 | ✓ | |

**관대한 수신자 원칙**(Postel 의 법칙의 절반)을 클라이언트에 요구한다. "모르는 필드는 무시하고, 모르는 enum 값은 `UNKNOWN` 으로 처리하라." 이것을 API 문서에 **명시**해야 서버가 필드와 enum 을 자유롭게 추가할 수 있다. [OpenAPI](/api-design/notes/02-openapi-contract-first) 에서 응답 스키마의 `additionalProperties` 를 열어 두는 이유이기도 하다.

## Protobuf 의 진화 규칙

Protobuf 는 와이어에 **필드 번호**만 싣는다([03](/api-design/notes/03-protobuf-grpc)). 그래서 규칙이 명확하다.

| 변경 | 안전? | 설명 |
|---|---|---|
| 새 번호로 필드 추가 | ✓ | 옛 코드는 모르는 필드를 건너뛰고 보존한다 |
| 필드 이름 변경 | ✓ (와이어) / ✗ (JSON 매핑·생성 코드) | 이진 와이어에는 이름이 없다. 하지만 JSON 변환과 코드는 깨진다 |
| 필드 삭제 | ✓ **단, 번호를 reserved 로** | 번호를 재사용하면 옛 데이터를 새 의미로 잘못 읽는다 |
| 필드 번호 변경 | ✗ | 다른 필드가 된다 |
| 타입 변경 | 대부분 ✗ | `int32 ↔ int64 ↔ bool` 은 와이어 호환이지만 값이 잘린다 |
| `repeated` ↔ 단일 | ✗ | |
| enum 값 추가 | ✓ (와이어) | 옛 코드는 숫자를 그대로 들고 있다. 첫 값은 반드시 `_UNSPECIFIED = 0` |
| 메시지를 `oneof` 로 옮기기 | 주의 | 기존 필드를 새 oneof 에 넣는 것은 깨질 수 있다 |

```protobuf
message Item {
  reserved 6, 9 to 11;          // 지운 필드의 번호 — 다시 쓰지 못하게
  reserved "legacy_sku";        // 이름도 (JSON 매핑 충돌 방지)
  int32 id = 1;
  string name = 2;
  int64 price = 3;
  repeated string tags = 4;
  bool in_stock = 5;
  Currency currency = 7;        // 새 필드는 새 번호로
}

enum Currency {
  CURRENCY_UNSPECIFIED = 0;     // 모르면 0 — 옛 데이터와 새 값의 안전한 기본
  CURRENCY_KRW = 1;
  CURRENCY_USD = 2;
}
```

번호 재사용이 왜 그렇게 위험할까. 6번이 원래 `int64 discount` 였고 지운 뒤 6번을 `bool gift_wrap` 으로 다시 썼다고 하자. 옛 클라이언트가 보낸 `discount = 5000` 이 새 서버에서 `gift_wrap = true` 로 읽힌다. 에러도 안 나고 조용히 틀린다.

## CI 에서 기계로 막기

사람의 리뷰는 놓친다. 깨지는 변경은 CI 에서 기계가 막아야 한다.

```bash
# Protobuf: main 브랜치 대비 깨지는 변경 검출
buf breaking --against ".git#branch=main"

#   catalog.proto:12:3: Field "6" with name "discount" on message "Item" was deleted without reserving the number "6".
#   catalog.proto:4:1:  Previously present RPC "GetItem" on service "Catalog" was deleted.

# OpenAPI: 두 스펙 비교
npx oasdiff breaking main.yaml pr.yaml --fail-on ERR
```

`buf breaking` 은 규칙 수준을 고를 수 있다. `FILE`(가장 엄격, 생성 코드까지), `PACKAGE`, `WIRE_JSON`, `WIRE`(이진 와이어 호환만). 서비스 사이 API 는 보통 `WIRE_JSON` 이 맞다.

```yaml
# buf.yaml
version: v2
lint:
  use: [STANDARD]          # 이름 규칙, 패키지 버전 접미사, enum 0 값 등
breaking:
  use: [WIRE_JSON]
```

## 깨야 할 때 — 버전 전략

| 방식 | 예 | 장점 | 단점 |
|---|---|---|---|
| URL 경로 | `/v1/orders`, `/v2/orders` | 명확, 라우팅·캐시·로그가 쉬움 | 리소스 전체가 복제되는 느낌 |
| 헤더 | `Accept: application/vnd.example.v2+json` | URL 이 깔끔 | 테스트·디버깅이 어렵고 캐시 키에 `Vary` 필요 |
| 날짜 버전 | `Stripe-Version: 2026-09-30` | 계정별로 고정, 점진 이동 | 서버가 버전별 변환 층을 유지해야 함 |
| 패키지 (gRPC) | `study.catalog.v1` → `v2` | 같은 서버가 두 서비스를 함께 제공 | 코드 생성이 두 벌 |

공개 API 는 URL 의 **메이저 버전**만 쓰는 것이 가장 흔하다. 마이너 변경은 버전을 올리지 않고 하위 호환으로 한다. Stripe 의 날짜 버전은 "계정마다 첫 호출 시점의 버전으로 고정하고, 서버 안에 버전 간 변환 함수를 쌓는" 방식이다. 옛 클라이언트를 영원히 지원하면서도 코어 코드는 최신 모양 하나만 유지한다.

## 폐기 — 예고하고, 측정하고, 끈다

옛 버전이나 필드를 없애는 절차다.

1. **예고**: 문서와 응답 헤더로 알린다.

   ```http
   Deprecation: @1798761600          ← 폐기 결정 시각 (RFC 9745)
   Sunset: Thu, 31 Dec 2026 23:59:59 GMT   ← 동작이 멈추는 시각 (RFC 8594)
   Link: <https://api.example.com/docs/migrate-v2>; rel="deprecation"
   ```

   Protobuf 는 `[deprecated = true]` 옵션을 단다. 생성 코드에 경고가 붙는다.

2. **측정**: 누가 아직 쓰는지 안다. 버전·엔드포인트·필드별 호출 수를 API 키와 함께 메트릭으로 남긴다.

   ```promql
   sum by (api_key, version) (rate(api_requests_total{version="v1"}[1d]))
   ```

3. **연락**: 사용량이 남은 키의 주인에게 직접 알린다. 공지만으로는 절대 0 이 되지 않는다.

4. **브라운아웃**: 종료 몇 주 전에 짧은 시간(예: 매주 화요일 10분) 일부러 실패시킨다. 알림을 무시하던 팀이 로그에서 에러를 보고 움직인다.

5. **종료**: `410 Gone` + 이전 안내 링크.

## 거버넌스 — 일관성을 유지하는 장치

서비스가 수십 개가 되면 API 마다 페이지네이션 방식, 에러 형식, 이름 규칙이 제각각이 된다. 사용자는 API 하나를 배울 때마다 새로 배워야 한다. 거버넌스는 이것을 막는 **규칙 + 자동 검사 + 리뷰**다.

| 장치 | 내용 |
|---|---|
| 스타일 가이드 | 이름(snake_case vs camelCase), 복수형, 에러 형식(RFC 9457), 페이지네이션(커서), 시각 형식(RFC 3339 UTC) |
| 린터 | Spectral·Redocly(OpenAPI), `buf lint`(Protobuf)로 가이드를 코드로 강제 |
| 호환성 검사 | `buf breaking`, `oasdiff` 를 CI 에 |
| 설계 리뷰 | 새 API·깨지는 변경은 구현 전에 스펙으로 리뷰 |
| 카탈로그 | 모든 API 의 스펙·소유 팀·상태(실험/안정/폐기 예정)를 한 곳에 |
| 성숙도 표시 | `v1alpha1` → `v1beta1` → `v1`. alpha 는 예고 없이 바뀔 수 있음을 명시 |

규칙은 **린터가 검사할 수 있는 것**부터 시작한다. 사람이 기억해야 하는 규칙은 지켜지지 않는다.

## 예시로 보기 — 이 프로젝트에서

실험의 `Item` 메시지에 통화를 추가한다고 해 보자.

1. `Currency currency = 7;` 을 추가한다. 번호 6 은 비어 있지만 쓰지 않는다. 혹시 과거에 썼다면 `reserved 6;`.
2. enum 의 0 은 `CURRENCY_UNSPECIFIED`. 옛 클라이언트가 보낸 메시지(필드 7 없음)는 0 으로 읽힌다. 서버는 0 을 KRW 로 해석하는 규칙을 문서에 적는다.
3. `buf breaking` 은 이 변경을 통과시킨다. 반대로 `price` 를 `double` 로 바꾸면 막는다.

이 사이트의 노트 frontmatter 도 하나의 스키마다. 필드(`experiments`, `level`)를 추가할 때 옛 노트에 그 필드가 없어도 렌더러가 기본값으로 처리하도록 한 것이 관대한 수신자 원칙이다. 반대로 주제 id 를 `search` 에서 `opensearch` 로 바꾼 일은 **깨지는 변경**이었다. 그 주소로 들어오던 링크가 모두 다른 곳(전역 검색)으로 가게 됐고, 노트 안의 링크를 일괄 치환해야 했다. URL 도 계약이다.

## 실습 체크리스트

- [ ] 위 "깨지는 변경" 표에서 enum 값 추가가 왜 △ 인지, 클라이언트 코드 예시로 설명하기
- [ ] `Item` 의 필드 하나를 지우고 번호를 재사용했을 때 옛 데이터가 어떻게 잘못 읽히는지 구체적인 값으로 시나리오 쓰기
- [ ] `buf` 를 설치해 실험의 proto(실험 코드의 `CATALOG_PROTO`)로 `buf lint` 를 돌리고 지적 사항 고치기
- [ ] 내가 쓰는 공개 API 하나의 버전 전략(URL/헤더/날짜)과 폐기 정책을 찾아 정리하기
- [ ] v1 엔드포인트 폐기 계획을 다섯 단계(예고·측정·연락·브라운아웃·종료)로 날짜와 함께 세워 보기
