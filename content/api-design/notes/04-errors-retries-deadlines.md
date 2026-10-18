---
title: "에러·재시도·데드라인·백프레셔 — 실패를 설계한다"
order: 4
level: 중급
summary: "분산 호출에서 실패는 기본값이다. gRPC 상태 코드 17개 중 무엇을 언제 쓰고 무엇을 재시도할지, 타임아웃이 아니라 데드라인으로 생각해야 하는 이유와 전파 방법, 취소가 서버의 헛일을 막는 원리, 재시도 정책(백오프·지터·예산·헤징)과 멱등성의 관계, 흐름 제어와 백프레셔, 그리고 실험으로 확인한 데드라인 전파 유무의 차이"
tags: [gRPC 상태 코드, 데드라인, 취소, 재시도, 백오프, 지터, 헤징, 백프레셔, 흐름 제어]
experiments: [api-grpc-deadline-cancel, api-idempotency-key]
---

## 실패는 예외가 아니라 응답의 한 종류다

로컬 함수 호출은 성공하거나 예외를 던진다. 원격 호출에는 세 번째 결과가 있다. **모름**이다. 요청이 서버에 닿았는지, 처리됐는지, 응답만 사라졌는지 알 수 없다. [분산 시스템이 어려운 이유](/distributed-systems/notes/01-why-hard) 의 핵심이다.

그래서 API 를 설계할 때는 성공 경로만큼 실패 경로를 정해야 한다.

- 어떤 실패를 어떤 코드로 알리나
- 클라이언트는 어떤 실패를 재시도해도 되나
- 얼마나 기다리고, 언제 포기하나
- 포기한 뒤 서버는 계속 일하나

## gRPC 상태 코드 — 무엇을 재시도할까

gRPC 는 HTTP 상태 대신 17개 코드를 쓴다. 중요한 것은 **재시도 가능 여부**다.

| 코드 | 이름 | 뜻 | 재시도 |
|---|---|---|---|
| 0 | OK | 성공 | — |
| 1 | CANCELLED | 호출자가 취소 | ✗ |
| 3 | INVALID_ARGUMENT | 입력이 틀림 (상태와 무관) | ✗ |
| 4 | DEADLINE_EXCEEDED | 시간 초과 — **처리됐을 수도 있다** | 멱등이면 △ |
| 5 | NOT_FOUND | 없음 | ✗ |
| 6 | ALREADY_EXISTS | 이미 있음 (생성 충돌) | ✗ |
| 7 | PERMISSION_DENIED | 권한 없음 | ✗ |
| 8 | RESOURCE_EXHAUSTED | 쿼터·레이트리밋 초과 | 백오프 후 △ |
| 9 | FAILED_PRECONDITION | 현재 상태에서 불가 (예: 비어 있지 않은 폴더 삭제) | ✗ (상태를 고친 뒤) |
| 10 | ABORTED | 동시성 충돌 (트랜잭션 중단) | ✓ 상위 수준에서 |
| 13 | INTERNAL | 서버 내부 불변식 깨짐 | 신중히 |
| 14 | UNAVAILABLE | 일시적 불가 (연결 실패, 서버 재시작) | ✓ 백오프 |
| 16 | UNAUTHENTICATED | 인증 실패 | 토큰 갱신 후 |

헷갈리는 짝을 정리하면 이렇다.

- **INVALID_ARGUMENT vs FAILED_PRECONDITION**: 요청 자체가 틀렸으면 전자, 요청은 맞는데 지금 상태가 안 맞으면 후자.
- **FAILED_PRECONDITION vs ABORTED vs UNAVAILABLE**: 클라이언트가 상태를 고쳐야 하면 첫째, 트랜잭션을 처음부터 다시 하면 되면 둘째, 같은 호출을 그대로 다시 하면 되면 셋째.
- **DEADLINE_EXCEEDED** 는 "처리 안 됨" 이 아니다. 서버가 처리한 뒤 응답이 늦었을 수 있다. 그래서 멱등하지 않은 호출은 함부로 재시도하면 안 된다. [멱등 키](/api-design/notes/01-rest-principles)가 필요한 이유다.

상세 정보는 `google.rpc.Status` 의 `details` 에 구조화해 실는다(`BadRequest.FieldViolation`, `RetryInfo`, `QuotaFailure`). REST 의 [Problem Details](/api-design/notes/01-rest-principles) 와 같은 역할이다.

## 타임아웃이 아니라 데드라인

**타임아웃**은 "이 호출을 최대 N 초 기다린다" 다. **데드라인**은 "이 요청 전체가 시각 T 까지 끝나야 한다" 다. 차이는 호출이 여러 단계로 이어질 때 드러난다.

```
사용자 → API(예산 500ms) → 주문 서비스 → 재고 서비스 → DB
```

각 단계가 자기 타임아웃 500ms 를 따로 가지면, 최악의 경우 전체는 1.5초를 넘긴다. 사용자는 이미 500ms 에 떠났는데 아래 단계들은 계속 일한다. 데드라인을 넘기면 각 단계가 **남은 시간**만큼만 기다린다.

gRPC 는 데드라인을 `grpc-timeout` 헤더로 실어 보낸다. 서버는 `call.getDeadline()` 으로 남은 시간을 알 수 있고, 하위 호출에 그대로 넘길 수 있다.

```ts
// 중계 서버의 핸들러
Chain(call, cb) {
  downstream.SlowWork(call.request, metadata, { parent: call }, cb);   // 데드라인·취소 전파
}
```

grpc-js 에서는 `{ parent: call }` 하나로 데드라인과 취소가 함께 전파된다. Go 는 `ctx` 를 넘기면 되고, Java 는 `Context` 가 자동으로 따라간다.

![데드라인 전파 유무에 따른 하위 서버의 헛일 — 실측 타임라인](/diagrams/api-deadline-propagation.svg)

### 예시로 보기 — 실험 `api-grpc-deadline-cancel`

1초 걸리는 `SlowWork` 와, 그것을 다시 부르는 `Chain` 을 한 서버에 띄우고 잰 결과다.

| 경우 | 클라이언트가 본 것 | 서버(하위)가 한 일 |
|---|---|---|
| `SlowWork` 에 데드라인 200ms | `DEADLINE_EXCEEDED` @205ms | 남은 시간 194ms 를 받음, 205ms 에 취소를 보고 멈춤 |
| `SlowWork` 를 300ms 에 `cancel()` | `CANCELLED` @303ms | 307ms 에 멈춤 |
| `Chain` (전파함), 데드라인 300ms | `DEADLINE_EXCEEDED` @301ms | 하위가 남은 시간 300ms 를 받음, 306ms 에 멈춤 |
| `Chain` (전파 안 함), 데드라인 300ms | `DEADLINE_EXCEEDED` @303ms | 하위는 데드라인 없음, **1025ms 까지 끝까지 일함** |

마지막 줄이 핵심이다. 사용자는 300ms 에 에러를 받고 떠났는데, 하위 서버는 아무도 기다리지 않는 응답을 1초 동안 계산했다. 평소에는 티가 안 난다. 하지만 서버가 느려진 상황에서는 이 헛일이 큐를 더 밀고, 더 많은 타임아웃이 나고, 더 많은 헛일이 생긴다. 장애가 장애를 키우는 고리다([준안정 장애](/performance/notes/08-tail-latency-at-scale)).

## 취소 — 서버가 들어야 할 신호

데드라인을 넘기거나 클라이언트가 떠나면 gRPC 서버의 call 에 `cancelled` 가 켜진다. 하지만 **핸들러가 그것을 보지 않으면 아무 일도 일어나지 않는다**. 실험의 핸들러는 50ms 마다 확인한다.

```ts
SlowWork: async (call, cb) => {
  for (let step = 0; step < call.request.ms / 50; step++) {
    if (call.cancelled) return;    // 확인하지 않으면 끝까지 돈다
    await doSomeWork();
  }
  cb(null, { stepsDone });
}
```

실제 코드에서는 루프보다 I/O 가 대부분이므로 **취소 신호를 I/O 까지 넘기는 것**이 중요하다. Node 라면 `AbortController` 를 만들어 `call.on("cancelled", () => ac.abort())` 로 연결하고, 그 `signal` 을 `fetch`·DB 드라이버·하위 gRPC 호출에 넘긴다. REST 에서도 같은 원리다. 클라이언트 연결이 끊기면 `req.signal` 이 abort 된다.

## 재시도 — 도움이 되기도, 장애를 키우기도

재시도는 일시적 실패를 가린다. 하지만 잘못 쓰면 [재시도 폭풍](/chaos/notes/03-resilience-patterns-verified) 이 된다. 규칙을 정리한다.

1. **재시도 가능한 코드만**: `UNAVAILABLE`, (멱등이면) `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`.
2. **지수 백오프 + 지터**: 100ms, 200ms, 400ms… 에 무작위성을 섞는다. 모두가 같은 순간에 재시도하는 동기화를 깬다.
3. **재시도 예산**: 재시도가 전체 요청의 10% 를 넘으면 멈춘다. 의존성이 진짜 죽었을 때 부하를 몇 배로 키우지 않는다.
4. **한 층에서만**: 클라이언트·게이트웨이·서비스가 각자 3번씩 재시도하면 3×3×3 = 27배가 된다.
5. **데드라인 안에서만**: 남은 시간이 백오프보다 짧으면 재시도하지 않는다.

gRPC 는 이것을 **서비스 설정**으로 선언할 수 있다.

```json
{
  "methodConfig": [{
    "name": [{ "service": "study.catalog.v1.Catalog", "method": "GetItem" }],
    "timeout": "0.5s",
    "retryPolicy": {
      "maxAttempts": 3,
      "initialBackoff": "0.05s",
      "maxBackoff": "0.5s",
      "backoffMultiplier": 2,
      "retryableStatusCodes": ["UNAVAILABLE"]
    }
  }],
  "retryThrottling": { "maxTokens": 10, "tokenRatio": 0.1 }
}
```

`retryThrottling` 이 재시도 예산이다. 실패마다 토큰 1개를 빼고 성공마다 0.1개를 채운다. 토큰이 절반 아래로 떨어지면 재시도를 멈춘다.

### 헤징 — 느린 것을 기다리지 않는다

**헤징(hedging)** 은 첫 요청의 응답이 일정 시간(보통 p95) 안에 안 오면 다른 서버에 같은 요청을 하나 더 보내고 먼저 온 응답을 쓰는 것이다. 실패가 아니라 **꼬리 지연**에 대한 대책이다. 비용은 요청 몇 % 증가다. 멱등한 읽기에만 쓴다.

```json
"hedgingPolicy": { "maxAttempts": 2, "hedgingDelay": "0.03s", "nonFatalStatusCodes": ["UNAVAILABLE"] }
```

자세한 원리는 [꼬리 지연과 대규모](/performance/notes/08-tail-latency-at-scale) 에 있다.

## 흐름 제어와 백프레셔

빠른 생산자와 느린 소비자 사이에는 무엇인가 쌓인다. 쌓이는 곳을 정하지 않으면 메모리가 정한다(OOM).

HTTP/2 는 스트림마다, 연결마다 **흐름 제어 창**을 둔다. 받는 쪽이 `WINDOW_UPDATE` 로 "이만큼 더 보내도 된다" 고 알려 줄 때까지 보내는 쪽은 멈춘다. gRPC 스트리밍에서 이것이 `write()` 의 반환값으로 올라온다.

```ts
if (!call.write(msg)) await once(call, "drain");   // 창이 찼다 → 기다린다
```

이것을 무시하면 grpc-js 가 내부 버퍼에 계속 쌓는다. 소비자가 느린 동안 서버 메모리가 오른다.

백프레셔를 시스템 전체로 넓히면 선택지는 넷이다.

| 전략 | 동작 | 예 |
|---|---|---|
| 기다리게 하기 | 생산자를 멈춘다 | HTTP/2 흐름 제어, TCP, 바운디드 큐 |
| 버리기 | 넘치는 것을 버린다 | NATS core 의 느린 소비자, UDP |
| 거절하기 | 즉시 에러로 알린다 | 503/`RESOURCE_EXHAUSTED`, [부하 차단](/performance/notes/08-tail-latency-at-scale) |
| 쌓아 두기 | 내구성 있는 버퍼로 흡수 | 메시지 브로커 ([메시징 비교](/messaging/notes/01-queue-topic-log-models)) |

## API 설계에 녹이기

| 결정 | 권장 |
|---|---|
| 기본 데드라인 | 클라이언트 라이브러리에 기본값을 둔다. 데드라인 없는 호출은 사고의 씨앗 |
| 데드라인 헤더 (REST) | `x-request-deadline` 이나 `Request-Timeout` 같은 헤더로 남은 예산을 전달 |
| 재시도 안내 | 429·503 에는 `Retry-After`, gRPC 는 `RetryInfo` 상세 |
| 멱등성 표시 | 문서에 오퍼레이션별 멱등 여부를 명시. gRPC 는 `option idempotency_level = IDEMPOTENT;` |
| 부분 실패 | 묶음 API 는 항목별 결과를 돌려준다(전부 성공/전부 실패를 강요하지 않는다) |

## 실전에서는 어디에 쓰이나

> 이 노트의 개념은 "한 서비스가 느려졌을 뿐인데 전체가 무너졌다" 는 장애 회고에서 가장 자주 등장한다. 재시도·타임아웃 설정 몇 줄이 장애를 가리기도, 키우기도 한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 → 재고 → 결제 체인 | 사용자는 떠났는데 하위 서비스가 계속 일함 | 데드라인 전파(`{ parent: call }`, Go `ctx`), 취소를 I/O 까지 | 단계별 고정 타임아웃 — 합이 예산을 넘는다 |
| 핀테크 결제 승인 호출 | 타임아웃 후 재시도로 이중 승인 | `DEADLINE_EXCEEDED` 는 멱등 키가 있을 때만 재시도 | 재시도 금지 + 상태 조회 API 로 확인 |
| 대규모 SaaS 백엔드 | 의존성 장애 시 재시도 폭풍 | 지수 백오프 + 지터, 재시도 예산, 한 층에서만 재시도 | 서킷 브레이커로 빠른 실패 |
| 검색·추천 읽기 API | p99 꼬리 지연 | 멱등 읽기에 헤징 요청 | 캐시·복제본 늘리기 |
| AI 서비스 토큰 스트리밍 | 느린 클라이언트 때문에 서버 메모리 증가 | `write()` 반환값으로 백프레셔, 바운디드 버퍼 | 넘치면 끊고 재연결하게 |

**이럴 땐 안 맞는다**
- 멱등하지 않은 쓰기를 무조건 자동 재시도 → 이중 처리. 멱등 키를 붙이거나 재시도를 사람·상위 흐름에 맡긴다.
- 비동기로 처리해도 되는 긴 작업에 긴 데드라인 → 202 + 작업 리소스나 큐로 바꾼다.

**누가 매일 만나나** — 백엔드 개발자가 클라이언트 라이브러리의 기본 타임아웃·재시도를 정할 때, SRE 가 장애 중 재시도 트래픽이 원래 부하를 몇 배로 키운 그래프를 볼 때.

**면접·실무 단골 질문**
- Q. 타임아웃과 데드라인의 차이? → 호출 하나의 대기 한도 vs 요청 전체의 마감 시각. 데드라인은 남은 시간을 하위로 전파한다.
- Q. 어떤 에러를 재시도하나? → `UNAVAILABLE`, 멱등이면 `DEADLINE_EXCEEDED`, 백오프 후 `RESOURCE_EXHAUSTED`. 입력 오류는 재시도 무의미.

## 실습 체크리스트

- [ ] 실험 `api-grpc-deadline-cancel` 을 돌리고 "전파 안 함" 행에서 하위가 끝까지 일한 시간을 확인하기
- [ ] 핸들러에서 `call.cancelled` 확인을 지우면 데드라인 200ms 사례에서 서버가 몇 ms 일하는지 예상하고 확인하기
- [ ] 위 상태 코드 표에서 내 서비스의 에러 다섯 가지를 골라 코드를 매겨 보기
- [ ] 클라이언트·게이트웨이·서비스가 각각 3회 재시도할 때 최악의 요청 배수를 계산하고 줄이는 방법 적기
- [ ] [장애 실험실](/chaos/notes/03-resilience-patterns-verified) 의 재시도 폭풍 실험과 이 노트의 재시도 예산을 연결해 설명하기
