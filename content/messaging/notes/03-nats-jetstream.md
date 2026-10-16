---
title: "NATS 와 JetStream — 가벼운 pub/sub 위에 쌓는 스트림"
order: 3
level: 중급
summary: "core NATS 가 왜 at-most-once 인지(저장도 ack 도 없는 subject 라우팅), subject 계층과 와일드카드, 큐 그룹과 request-reply, 그 위에 얹는 JetStream 의 스트림(보존 정책·저장·복제)과 컨슈머(push/pull·ack 정책·ack_wait·max_deliver·nak 지연), msgID 중복 제거, max_deliver 어드바이저리로 하는 dead letter, KV·Object Store, 그리고 실험으로 잰 재전달 타임라인"
tags: [NATS, JetStream, subject, 와일드카드, 큐 그룹, request-reply, ack_wait, max_deliver, 중복 제거, KV]
experiments: [mq-nats-jetstream-ack, mq-broker-benchmark]
---

## core NATS — 쏘고 잊는 메시징

NATS 는 단일 바이너리, 수 MB 메모리로 뜨는 메시징 서버다. 기본 동작(core NATS)은 아주 단순하다.

- 메시지는 **subject**(문자열 주소)로 보낸다.
- 그 순간 그 subject 를 구독 중인 클라이언트에게 전달한다.
- **저장하지 않는다. ack 도 없다.** 구독자가 없으면 사라진다. 구독자가 느리면 서버가 그 연결을 끊는다(slow consumer).

즉 **at-most-once** 다. 그래서 빠르다. 실험 `mq-broker-benchmark` 에서 core NATS 는 다섯 경로 중 가장 빨랐다(약 27만 msg/s, p99 4.6ms). 대신 소비자가 잠깐 끊긴 사이의 메시지는 영영 없다.

어디에 쓸까. 잃어도 다음 값이 곧 오는 데이터다. 실시간 위치·센서 값, 캐시 무효화 방송, 서비스 디스커버리 하트비트, 그리고 아래의 request-reply.

### subject 와 와일드카드

subject 는 점으로 나눈 계층이다.

```
orders.created.kr
orders.paid.us
sensors.room1.temp
```

| 패턴 | 매칭 |
|---|---|
| `orders.*.kr` | `*` = 한 토큰 → `orders.created.kr`, `orders.paid.kr` |
| `orders.>` | `>` = 나머지 전부(끝에만) → `orders.created.kr`, `orders.paid.us.vip` |

RabbitMQ topic 익스체인지의 `*`·`#` 와 같은 역할이지만, NATS 는 익스체인지·바인딩 없이 **구독할 때 패턴을 쓰는 것**으로 끝이다.

### 큐 그룹 — 경쟁 소비자

같은 **큐 그룹 이름**으로 구독하면 메시지가 그룹 안의 한 명에게만 간다.

```ts
nc.subscribe("jobs.resize", { queue: "workers" });   // 워커 3대가 같은 이름으로 구독 → 나눠 받음
```

설정 없이 수평 확장이 된다. 하지만 core NATS 라 여전히 ack 가 없다. 워커가 처리 중 죽으면 그 작업은 사라진다.

### request-reply

```ts
// 서버
for await (const m of nc.subscribe("svc.price", { queue: "price" })) m.respond(encode(price(m.json())));
// 클라이언트
const res = await nc.request("svc.price", encode({ sku: 812 }), { timeout: 200 });
```

내부적으로 클라이언트가 임시 inbox subject 를 만들어 응답을 받는다. 큐 그룹과 합치면 **로드밸런서 없는 RPC** 가 된다. 서버를 늘리면 자동으로 분산된다. [gRPC](/api-design/notes/03-protobuf-grpc) 의 대안으로 NATS 를 서비스 메시처럼 쓰는 팀도 있다.

## JetStream — 저장과 ack 를 더하다

JetStream 은 NATS 서버에 내장된 영속 계층이다(`nats-server -js`). 두 개념이 핵심이다.

| 개념 | 역할 | 비유 |
|---|---|---|
| **스트림 (stream)** | subject 패턴에 맞는 메시지를 저장 | Kafka 토픽 (단, 파티션 대신 subject) |
| **컨슈머 (consumer)** | 스트림을 읽는 위치 + ack 상태 + 배달 정책 | Kafka 컨슈머 그룹의 오프셋 + RabbitMQ 의 ack 관리 |

생산자는 **그냥 subject 로 publish** 하면 된다. 스트림이 그 subject 를 잡고 있으면 저장된다. core NATS 앱을 거의 그대로 두고 신뢰성만 얹을 수 있다.

```ts
const jsm = await nc.jetstreamManager();
await jsm.streams.add({
  name: "ORDERS",
  subjects: ["orders.>"],
  storage: StorageType.File,          // Memory 도 가능
  retention: RetentionPolicy.Limits,  // 아래 표 참고
  max_age: nanos(7 * 24 * 3600_000),  // 7일 보존
  num_replicas: 3,                    // 클러스터에서 Raft 복제
  duplicate_window: nanos(120_000),   // msgID 중복 제거 창
});
```

### 보존 정책 — 같은 스트림, 다른 모델

| retention | 언제 지우나 | 모델 |
|---|---|---|
| `Limits` | 나이·크기·개수 한도에 닿으면 | **로그** (재생 가능, Kafka 와 같음) |
| `WorkQueue` | 어떤 컨슈머든 ack 하면 즉시 | **작업 큐** (RabbitMQ 와 같음) |
| `Interest` | 그 시점에 존재하는 모든 컨슈머가 ack 하면 | 팬아웃 + 정리 |

한 제품 안에서 [세 가지 모델](/messaging/notes/01-queue-topic-log-models)을 설정 하나로 고를 수 있다는 것이 JetStream 의 특징이다.

## 컨슈머 — 배달 정책의 전부

```ts
await jsm.consumers.add("ORDERS", {
  durable_name: "worker",              // 이름이 있으면 재시작해도 위치 유지
  ack_policy: AckPolicy.Explicit,      // 메시지마다 ack
  ack_wait: nanos(30_000),             // 30초 안에 ack 없으면 재배달
  max_deliver: 5,                      // 최대 5번 배달
  max_ack_pending: 1000,               // 미확인 최대 개수 (RabbitMQ prefetch 와 비슷)
  deliver_policy: DeliverPolicy.All,   // 처음부터 / New / ByStartTime …
  filter_subject: "orders.*.kr",       // 스트림의 일부만
});
```

pull 컨슈머가 현재 권장 방식이다. 소비자가 "N 개 줘" 하고 가져가므로 흐름 제어가 자연스럽고, 같은 durable 을 여러 인스턴스가 pull 하면 경쟁 소비자가 된다.

### 메시지 처리 동작

| 동작 | 의미 |
|---|---|
| `ack()` | 처리 완료 |
| `nak(delay)` | 실패, `delay` 뒤에 다시 보내 줘 — **지연 재시도가 한 줄** |
| `working()` | 아직 처리 중, ack_wait 타이머를 리셋 (긴 작업) |
| `term()` | 다시 보내지 마 — 영구 실패 |
| 아무것도 안 함 | ack_wait 가 지나면 재배달 |

RabbitMQ 에서 DLX 와 TTL 큐를 조합해야 했던 지연 재시도를 `nak(delay)` 로 바로 한다.

### 예시로 보기 — 실험 `mq-nats-jetstream-ack`

메모리 스트림과 `ack_wait 1s`, `max_deliver 3` 컨슈머를 만들고, 메시지 A 는 ack, B 는 무시, C 는 첫 배달에 `nak(300)` 한 뒤 두 번째에 ack 했다. 실제 기록이다.

```
    1ms  A  deliveryCount=1  ack
    1ms  B  deliveryCount=1  무응답
    1ms  C  deliveryCount=1  nak(300ms)
  302ms  C  deliveryCount=2  ack
 1002ms  B  deliveryCount=2  무응답
 2004ms  B  deliveryCount=3  무응답       ← max_deliver 도달, 더는 오지 않음
```

- B 의 재배달 간격은 1001ms, 1002ms — `ack_wait` 그대로다.
- C 는 정확히 약 300ms 뒤에 다시 왔다.
- B 가 3번째 배달 후 멈추자 서버가 **어드바이저리**를 발행했다.

```
$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.<STREAM>.worker
  { "stream_seq": 2, "deliveries": 3 }
```

### dead letter — 큐가 아니라 어드바이저리

JetStream 에는 dead letter 큐가 따로 없다. max_deliver 에 닿은 메시지는 **스트림에 그대로 남아 있고**(Limits 보존이면), 서버는 그 순번(`stream_seq`)을 어드바이저리로 알려 준다. 패턴은 이렇다.

1. 어드바이저리 subject 를 구독한다.
2. `stream_seq` 로 원본 메시지를 다시 읽는다(`jsm.streams.getMessage(stream, { seq })`).
3. dead letter 스트림이나 DB 에 옮기고 알림을 보낸다.

실험의 컨슈머 상태(`ack_floor_stream_seq: 1`)도 볼 만하다. B(seq 2) 가 끝내 ack 되지 않아 "여기까지 다 처리됨" 의 바닥이 1 에 머물러 있다.

## msgID — 서버가 막는 중복

프로듀서가 발행 후 PubAck 를 못 받으면 재시도한다. 그런데 사실 서버는 이미 저장했을 수 있다. 그 재시도가 중복을 만든다. JetStream 은 발행 시 `msgID` 를 주면 **duplicate window 안의 같은 ID 를 저장하지 않는다**.

```ts
await js.publish("orders.created", data, { msgID: "order-42" });   // seq 1, duplicate: false
await js.publish("orders.created", data, { msgID: "order-42" });   // seq 1, duplicate: true  ← 저장 안 함
```

실험에서 같은 msgID 재발행이 `{ seq: 1, duplicate: true }` 를 돌려줬다. Kafka 의 멱등 프로듀서, [API 의 Idempotency-Key](/api-design/notes/01-rest-principles) 와 같은 발상이다. 단 **생산 측 중복**만 막는다. 소비 측 중복(ack 전에 죽어 재배달)은 소비자가 멱등해야 막힌다([04](/messaging/notes/04-delivery-guarantees-delay)).

## KV 와 Object Store

JetStream 스트림 위에 만든 편의 API 다.

```ts
const kv = await js.views.kv("config");
await kv.put("feature.new_checkout", "on");
for await (const e of await kv.watch()) console.log(e.key, e.string());   // 변경 구독
```

KV 는 키마다 마지막 값을 남기는 스트림이다. 버전 이력, 변경 감시(watch), CAS(`update(key, value, revision)`)를 지원한다. etcd·Consul 처럼 설정 배포·리더 선출 용도로 쓸 수 있다. Object Store 는 큰 파일을 청크로 나눠 저장한다.

## 다른 브로커와 비교

| | core NATS | JetStream | RabbitMQ | Kafka |
|---|---|---|---|---|
| 저장 | ✗ | ✓ | ✓ | ✓ |
| 기본 보장 | at-most-once | at-least-once | at-least-once | at-least-once |
| 재생 | ✗ | ✓ (Limits) | Streams 만 | ✓ |
| 지연 재시도 | — | `nak(delay)` | DLX + TTL | 재시도 토픽 직접 구현 |
| 라우팅 | subject 와일드카드 | 같음 | 익스체인지·바인딩 | 토픽 + 키 |
| 운영 무게 | 매우 가벼움 | 가벼움 | 중간 | 무거움 (KRaft 로 가벼워짐) |
| 엣지·IoT | 강함 (리프 노드) | 강함 | 보통 | 약함 |

## 실습 체크리스트

- [ ] `pnpm mq:up` 후 http://localhost:18222/jsz 에서 실험 중 스트림·컨슈머 수가 바뀌는 것 보기
- [ ] 실험 `mq-nats-jetstream-ack` 의 기록에서 B 와 C 의 재배달 간격이 각각 무엇으로 정해지는지 설명하기
- [ ] 같은 스트림을 `retention: WorkQueue` 로 바꾸면 A 를 ack 한 뒤 스트림 메시지 수가 어떻게 달라지는지 예측하기
- [ ] max_deliver 어드바이저리를 받아 원본을 `getMessage` 로 읽어 dead letter 스트림에 옮기는 코드를 의사코드로 쓰기
- [ ] core NATS 가 적합한 데이터와 JetStream 이 필요한 데이터를 내 서비스에서 하나씩 찾기
