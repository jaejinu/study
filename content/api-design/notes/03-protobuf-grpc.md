---
title: "Protobuf 와 gRPC — 와이어 포맷, 필드 번호, HTTP/2, 네 가지 호출 방식"
order: 3
level: 중급
summary: "서비스 사이의 호출을 gRPC 로 하는 이유. Protobuf 가 바이트로 어떻게 인코딩되는지(태그·와이어 타입·varint)를 실제 바이트로 읽고, 필드 번호가 왜 계약의 핵심인지, gRPC 가 HTTP/2 위에서 스트림·헤더·트레일러를 어떻게 쓰는지, unary·서버 스트리밍·클라이언트 스트리밍·양방향 스트리밍의 쓰임, 그리고 실험으로 잰 unary·스트리밍·JSON 의 시간과 크기"
tags: [gRPC, Protobuf, HTTP/2, varint, 스트리밍, 코드 생성, 메타데이터]
experiments: [api-grpc-unary-vs-stream, api-grpc-deadline-cancel]
---

## 왜 서비스 사이에는 gRPC 를 쓰나

외부 공개 API 는 [REST + JSON](/api-design/notes/01-rest-principles) 이 기본값이다. 브라우저·curl·어떤 언어로든 바로 부를 수 있기 때문이다. 그런데 **내부 서비스끼리**는 사정이 다르다.

- 호출 수가 많다. 사용자 요청 하나가 내부 호출 수십 개로 퍼진다.
- 양쪽 다 우리 코드다. 스키마를 공유하고 코드를 생성할 수 있다.
- 스트리밍·데드라인·취소 같은 기능이 필요하다.

gRPC 는 이 조건에 맞춘 RPC 프레임워크다. 구성은 세 겹이다.

| 층 | 무엇 |
|---|---|
| IDL | `.proto` 파일 — 서비스와 메시지 정의. 계약의 원천 |
| 직렬화 | Protobuf — 작고 빠른 이진 인코딩 |
| 전송 | HTTP/2 — 한 연결 위의 다중 스트림, 헤더 압축, 흐름 제어 |

## .proto — 계약 파일

실험 `api-grpc-unary-vs-stream` 이 쓰는 정의다.

```protobuf
syntax = "proto3";
package study.catalog.v1;                   // 패키지에 버전을 넣는다

service Catalog {
  rpc GetItem(GetItemRequest) returns (Item);              // unary
  rpc ListItems(ListItemsRequest) returns (stream Item);   // 서버 스트리밍
}

message Item {
  int32  id       = 1;
  string name     = 2;
  int64  price    = 3;    // 돈은 정수 최소 단위
  repeated string tags = 4;
  bool   in_stock = 5;
}
```

`= 1`, `= 2` 가 **필드 번호**다. 와이어에는 필드 이름이 아니라 이 번호가 실린다. 이름은 바꿔도 되지만 **번호는 영원히 바꾸면 안 된다**. 이것이 Protobuf 진화 규칙의 전부라고 해도 과언이 아니다([07](/api-design/notes/07-versioning-evolution-governance)).

## 와이어 포맷 — 실제 바이트를 읽어 보자

실험이 `items[1]` 을 직렬화한 바이트를 출력한다. 앞부분만 풀어 보자.

```
08 01                          필드 1, 와이어 타입 0(varint) → id = 1
12 26 ec 83 81 … ec 8a a4      필드 2, 와이어 타입 2(길이 접두) → 길이 0x26=38바이트 UTF-8 → name
18 c0 b8 02                    필드 3, varint → price = 40000
22 08 6b 65 79 62 6f 61 72 64  필드 4, 길이 접두 8 → "keyboard"
22 08 77 69 72 65 6c 65 73 73  필드 4 반복 → "wireless"
22 04 73 61 6c 65              필드 4 반복 → "sale"
28 01                          필드 5, varint → in_stock = true
```

각 필드는 **태그 바이트** 하나로 시작한다. 태그 = `(필드 번호 << 3) | 와이어 타입`.

| 와이어 타입 | 값 | 쓰는 타입 |
|---|---|---|
| 0 | VARINT | int32, int64, uint, bool, enum |
| 1 | I64 | fixed64, double |
| 2 | LEN | string, bytes, 하위 메시지, packed repeated |
| 5 | I32 | fixed32, float |

`0x08` = `1 << 3 | 0`, `0x12` = `2 << 3 | 2`, `0x18` = `3 << 3 | 0`. 직접 계산하면 맞는다.

**varint** 는 7비트씩 끊어 앞 비트로 "더 있음" 을 표시한다. 40000 은 `c0 b8 02` 세 바이트다. 작은 수는 1바이트로 끝난다. 그래서 ID 나 개수처럼 작은 정수가 많은 데이터에서 Protobuf 가 특히 작아진다. 음수가 자주 나오는 필드는 `sint32`(ZigZag 인코딩)를 써야 한다. 그냥 `int32` 로 -1 을 보내면 10바이트가 된다.

기본값(0, 빈 문자열, false)은 **아예 보내지 않는다**. 그래서 proto3 에서는 "0 을 보냄" 과 "안 보냄" 을 구분할 수 없다. 구분이 필요하면 `optional` 을 붙인다(필드 존재 여부를 추적).

### 크기 비교 — 실험 결과

| 형식 (항목 1000개) | 바이트 | 항목당 |
|---|---|---|
| Protobuf | 75,262 | 75 |
| JSON | 125,423 | 125 |
| JSON 배열 + gzip | 6,363 | 6 |
| Protobuf + gzip | 5,108 | 5 |

압축 전에는 Protobuf 가 JSON 의 60% 다. 필드 이름이 없고 정수가 짧기 때문이다. 하지만 gzip 을 걸면 둘 다 크게 줄고 차이가 작아진다. 이 데이터는 같은 패턴이 반복돼서 압축이 특히 잘 된다. 결론적으로 **크기만이 이유라면 JSON + 압축으로 충분할 때가 많다**. gRPC 를 고르는 진짜 이유는 계약·코드 생성·스트리밍·데드라인이다.

## HTTP/2 위의 gRPC

gRPC 호출 하나는 HTTP/2 **스트림** 하나다.

```
HEADERS   :method POST  :path /study.catalog.v1.Catalog/GetItem
          content-type: application/grpc   grpc-timeout: 200m   te: trailers
          (사용자 메타데이터: authorization, x-request-id …)
DATA      [1바이트 압축 플래그][4바이트 길이][Protobuf 메시지]
          ── 응답 ──
HEADERS   :status 200  content-type: application/grpc
DATA      [플래그][길이][메시지]
HEADERS   grpc-status: 0  grpc-message: ""        ← 트레일러 (끝에 오는 헤더)
```

알아 둘 점이 몇 가지 있다.

- **HTTP 상태는 거의 항상 200** 이다. 실제 결과는 트레일러의 `grpc-status` 에 있다. 그래서 일반 HTTP 프록시·로드밸런서의 "5xx 비율" 메트릭으로는 gRPC 에러를 볼 수 없다. gRPC 인식 프록시(Envoy, Nginx `grpc_pass`)나 앱 메트릭이 필요하다.
- **한 연결에 스트림 여러 개**가 동시에 흐른다(다중화). HTTP/1.1 의 "연결 하나에 요청 하나" 제약이 없다.
- **메타데이터는 HTTP 헤더**다. 그래서 값은 ASCII 만 된다. 실험 `api-grpc-deadline-cancel` 을 만들다 메타데이터에 한글 값을 넣었더니 호출이 즉시 `UNKNOWN` 으로 실패했다. 바이너리나 비 ASCII 값은 키를 `-bin` 으로 끝내야 base64 로 실린다.

### 다중화가 실제로 주는 것 — 실험 결과

| 방식 (항목 1000개, 로컬) | 시간 |
|---|---|
| gRPC unary 1000번 순차 (`await` 하나씩) | 165ms |
| gRPC unary 1000번 동시 (`Promise.all`) | 60ms |
| gRPC 서버 스트리밍 1번 | 13.5ms |
| JSON 배열 한 번 | 1.5ms |
| JSON 1000번 순차 (keep-alive) | 51ms |

세 가지를 읽을 수 있다.

1. **동시 호출이 순차보다 3배 빠르다.** 연결 하나에 1000개 스트림이 다중화되기 때문이다. HTTP/1.1 이었다면 연결 수만큼만 병렬이다.
2. **스트리밍 한 번이 unary 1000번보다 12배 빠르다.** 왕복이 1번이다.
3. **그런데 JSON 배열 한 번이 스트리밍보다 빠르다.** 스트리밍은 메시지마다 프레이밍·직렬화·콜백 비용을 낸다. 작은 고정 목록이라면 한 번에 보내는 것이 가장 빠르다. 스트리밍의 가치는 "전체가 메모리에 다 올라오기 전에 첫 항목을 처리하는 것" 과 "끝이 없는 흐름" 에 있다.

## 네 가지 호출 방식

| 방식 | 정의 | 쓰임 |
|---|---|---|
| unary | `rpc Get(Req) returns (Res)` | 대부분의 호출 |
| 서버 스트리밍 | `returns (stream Res)` | 큰 결과를 조금씩, 실시간 피드, 진행 상황 알림, LLM 토큰 스트림 |
| 클라이언트 스트리밍 | `rpc Upload(stream Chunk) returns (Summary)` | 파일 업로드, 센서 데이터 묶음 전송 |
| 양방향 스트리밍 | `rpc Chat(stream Msg) returns (stream Msg)` | 채팅, 협업 편집, 게임, 양방향 동기화 |

서버 스트리밍 구현은 단순하다.

```ts
server.addService(Catalog.service, {
  ListItems(call: grpc.ServerWritableStream<{ count: number }, Item>) {
    for (let i = 0; i < call.request.count; i++) {
      if (call.cancelled) return;                 // 클라이언트가 떠나면 멈춘다
      if (!call.write(items[i])) {                // false = 버퍼가 찼다 (백프레셔)
        await once(call, "drain");                // 비울 때까지 기다린다
      }
    }
    call.end();
  },
});

// 클라이언트
for await (const item of client.ListItems({ count: 1000 })) render(item);
```

`write()` 가 `false` 를 돌려주면 HTTP/2 흐름 제어 창이 찼다는 뜻이다. 무시하고 계속 쓰면 메모리에 쌓인다. 백프레셔는 [04](/api-design/notes/04-errors-retries-deadlines) 에서 더 다룬다.

## 스트림 vs 메시징 — 언제 무엇을

양방향 스트리밍은 "메시지 브로커 없이 실시간 통신" 처럼 보인다. 하지만 둘은 다르다.

| | gRPC 스트림 | 메시지 브로커 ([메시징 비교](/messaging)) |
|---|---|---|
| 상대 | 지금 연결된 특정 상대 | 누가 받을지 몰라도 됨 |
| 연결이 끊기면 | 스트림이 끝난다. 재연결·재개는 앱 책임 | 메시지는 브로커에 남는다 |
| 보존 | 없음 | 있음 (재처리 가능) |
| 쓰임 | 요청-응답의 연장, 세션 동안의 실시간 대화 | 비동기 작업, 이벤트 전파, 서비스 분리 |

## 코드 생성과 언어 지원

```bash
# Go
protoc --go_out=. --go-grpc_out=. catalog.proto
# buf (현대적인 도구 체인 — 린트·호환성 검사·생성을 한 번에)
buf generate
```

Node 는 두 가지 길이 있다. 실험처럼 `@grpc/proto-loader` 로 **런타임에 .proto 를 읽는** 방식은 빌드 단계가 없어 편하지만 타입이 약하다. 운영 코드는 `ts-proto` 나 `@bufbuild/protobuf` 로 **TypeScript 타입을 생성**하는 편이 안전하다.

## 브라우저와 gRPC

브라우저는 HTTP/2 트레일러에 접근할 수 없어 순수 gRPC 를 못 부른다. 방법은 세 가지다.

| 방법 | 설명 |
|---|---|
| gRPC-Web | 브라우저 ↔ 프록시(Envoy)는 gRPC-Web, 프록시 ↔ 서버는 gRPC |
| Connect 프로토콜 | 같은 .proto 로 gRPC·gRPC-Web·JSON-over-HTTP 를 모두 받는 서버 |
| HTTP/JSON 트랜스코딩 | `google.api.http` 어노테이션으로 REST 경로를 자동 생성 ([06](/api-design/notes/06-gateway-auth-ratelimit)) |

## 운영에서 부딪히는 것들

| 문제 | 원인 | 대응 |
|---|---|---|
| 로드밸런싱이 한 서버로 쏠림 | L4 LB 는 연결 단위로 나눈다. gRPC 는 연결 하나를 오래 쓴다 | 클라이언트 측 LB(round_robin + DNS), L7 프록시, 서비스 메시 |
| 유휴 연결이 몰래 끊김 | NAT·LB 의 유휴 타임아웃 | keepalive ping 설정 (`grpc.keepalive_time_ms`) |
| 메시지 크기 초과 | 기본 수신 한도 4MB | 큰 데이터는 스트리밍으로 쪼개기 |
| 에러가 메트릭에 안 보임 | HTTP 200 + grpc-status | gRPC 상태 코드별 메트릭·트레이스 |

## 실전에서는 어디에 쓰이나

> gRPC 는 사용자 요청 하나가 내부 호출 수십 개로 퍼지는 마이크로서비스 구조에서, 그리고 서버가 결과를 조금씩 흘려보내야 할 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 마이크로서비스 내부 호출 | 언어가 다른 서비스 간 타입 안전한 호출 | `.proto` 를 공유 저장소에 두고 언어별 코드 생성 | REST + OpenAPI — 브라우저·디버깅은 쉽다 |
| AI 서비스 추론 서버 | 토큰을 생성되는 대로 흘려보내기 | 서버 스트리밍 RPC, 흐름 제어 존중 | SSE — 브라우저 직결이면 더 단순 |
| 모바일 게임·채팅 | 세션 동안 양방향 실시간 메시지 | 양방향 스트리밍, keepalive | WebSocket + 메시지 브로커(오프라인 보존) |
| IoT 데이터 업로드 | 단말이 측정값 묶음을 전송 | 클라이언트 스트리밍 + 요약 응답 | MQTT — 불안정한 네트워크·많은 단말에 강하다 |

**이럴 땐 안 맞는다**
- 브라우저·외부 파트너가 직접 부르는 공개 API → 순수 gRPC 는 브라우저에서 못 부른다. REST 나 gRPC-Web·트랜스코딩.
- 응답 크기만 줄이려는 목적 → JSON + gzip 으로 충분한 경우가 많다. gRPC 의 가치는 계약·스트리밍·데드라인이다.

**누가 매일 만나나** — 백엔드 개발자가 `.proto` 필드를 추가할 때, SRE·플랫폼 엔지니어가 L4 로드밸런서 뒤 연결 쏠림이나 HTTP 200 속 gRPC 에러를 메트릭에서 놓칠 때.

**면접·실무 단골 질문**
- Q. Protobuf 필드 번호는 왜 바꾸면 안 되나? → 와이어에 이름이 아니라 번호가 실린다. 바꾸면 다른 필드가 된다. 삭제한 번호는 `reserved`.
- Q. gRPC 를 L4 LB 뒤에 두면 생기는 문제? → 긴 연결 하나에 스트림이 몰려 한 서버로 쏠린다. 클라이언트 측 LB 나 L7 프록시.

## 실습 체크리스트

- [ ] 실험 `api-grpc-unary-vs-stream` 을 돌리고 hex 출력에서 태그 바이트 5개를 직접 해석하기
- [ ] `price` 를 `int64` 에서 `sint64` 로 바꾸면 음수 가격이 몇 바이트가 되는지 계산하기
- [ ] 동시 unary 가 순차보다 빠른 이유를 HTTP/2 다중화로 설명하고, HTTP/1.1 이었다면 어떻게 달라질지 적기
- [ ] 스트리밍보다 JSON 배열 한 번이 빠른 결과를 보고, 그래도 스트리밍을 고를 상황 두 가지를 적기
- [ ] 메타데이터 값에 한글을 넣으면 왜 실패하는지, `-bin` 키로 어떻게 해결하는지 정리하기
