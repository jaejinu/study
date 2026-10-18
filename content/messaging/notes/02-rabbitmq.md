---
title: "RabbitMQ — 익스체인지, 확인, prefetch, DLX 로 만드는 재시도"
order: 2
level: 중급
summary: "AMQP 0-9-1 의 모델(연결·채널·익스체인지·큐·바인딩), 네 가지 익스체인지(direct·topic·fanout·headers)로 라우팅을 설계하는 법, 소비자 ack/nack/reject 와 prefetch 가 처리량과 공정성을 정하는 원리, 퍼블리셔 확인으로 '보냈다' 를 증명하는 법, DLX·TTL 로 지연 재시도와 dead letter 를 만드는 법(실측 타임라인 포함), classic vs quorum 큐와 Streams"
tags: [RabbitMQ, AMQP, 익스체인지, 라우팅 키, ack, prefetch, 퍼블리셔 확인, DLX, TTL, quorum 큐]
experiments: [mq-rabbit-dlx-retry, mq-broker-benchmark]
---

## 구성 요소

RabbitMQ 는 [작업 큐 모델](/messaging/notes/01-queue-topic-log-models)의 대표 브로커다. 핵심은 **생산자가 큐에 직접 보내지 않는다**는 점이다.

```
생산자 ─publish(exchange, routing_key)─→ [익스체인지] ─바인딩 규칙─→ [큐] ─→ 소비자
```

| 요소 | 역할 |
|---|---|
| 연결 (connection) | TCP 연결 하나. 비싸다 — 앱당 소수만 |
| 채널 (channel) | 연결 위의 가상 연결. 스레드·작업마다 하나. 싸다 |
| 익스체인지 (exchange) | 메시지를 받아 바인딩 규칙에 따라 큐로 **복사·라우팅**. 메시지를 저장하지 않는다 |
| 큐 (queue) | 메시지를 저장하고 소비자에게 넘긴다 |
| 바인딩 (binding) | "이 익스체인지의 이 라우팅 키 → 이 큐" 규칙 |
| vhost | 논리적 격리 단위 (테넌트·환경 분리) |

생산자는 "주문이 생성됐다(`orders.created`)" 만 말하고, 누가 받을지는 **바인딩**이 정한다. 새 서비스가 주문 이벤트를 받고 싶으면 자기 큐를 만들어 바인딩만 추가하면 된다. 생산자 코드는 그대로다.

## 네 가지 익스체인지

| 타입 | 라우팅 규칙 | 쓰임 |
|---|---|---|
| **direct** | 라우팅 키가 바인딩 키와 정확히 같으면 | 작업 종류별 큐 (`resize`, `email`) |
| **topic** | 점으로 나눈 키를 패턴 매칭. `*` 는 한 단어, `#` 는 0개 이상 | 이벤트 라우팅 (`orders.*.kr`, `orders.#`) |
| **fanout** | 키 무시, 바인딩된 모든 큐로 | 방송 (캐시 무효화) |
| **headers** | 헤더 값으로 매칭 | 키로 표현하기 어려운 다차원 라우팅 (드묾) |

```
publish("events", "orders.created.kr")

topic 익스체인지 "events"
  ├─ "orders.created.*"  → inventory 큐     ✓
  ├─ "orders.#"          → audit 큐         ✓
  ├─ "*.created.kr"      → kr-analytics 큐  ✓
  └─ "payments.#"        → billing 큐       ✗
```

이름 없는 **기본 익스체인지**(`""`)는 direct 이고, 모든 큐가 자기 이름으로 자동 바인딩돼 있다. `sendToQueue("work", msg)` 가 사실은 `publish("", "work", msg)` 다.

어떤 큐에도 라우팅되지 않은 메시지는 **조용히 버려진다**. `mandatory: true` 로 보내면 브로커가 돌려준다(`basic.return`). 또는 익스체인지에 `alternate-exchange` 를 지정해 갈 곳 없는 메시지를 모은다.

## 소비자 ack — 언제 메시지가 사라지나

```ts
await ch.prefetch(10);                         // 미확인 메시지를 최대 10개까지만 받는다
await ch.consume("work", async (m) => {
  try {
    await handle(JSON.parse(m.content.toString()));
    ch.ack(m);                                 // 처리 완료 → 브로커가 삭제
  } catch (e) {
    ch.nack(m, false, false);                  // 실패 → requeue=false (DLX 가 있으면 그리로)
  }
}, { noAck: false });
```

| 동작 | 결과 |
|---|---|
| `ack` | 삭제 |
| `nack(requeue=true)` | 큐 **앞으로** 즉시 돌아온다 — 다시 실패하면 무한 루프(핫 루프) |
| `nack(requeue=false)` / `reject` | DLX 가 있으면 dead-letter, 없으면 삭제 |
| ack 없이 채널·연결이 끊김 | 미확인 메시지가 큐로 돌아와 **다른 소비자에게 재배달** — at-least-once 의 근원 |
| `noAck: true` (자동 확인) | 보내는 순간 삭제. 소비자가 죽으면 유실 — at-most-once |

소비자가 처리 후 ack 전에 죽으면 메시지는 다시 배달된다. 그래서 소비자는 **멱등**해야 한다([전달 보장](/messaging/notes/04-delivery-guarantees-delay)).

## prefetch — 처리량과 공정성의 손잡이

`prefetch(N)` 은 "ack 안 된 메시지를 소비자당 최대 N 개까지만" 이다.

| prefetch | 결과 |
|---|---|
| 0 (무제한) | 브로커가 큐 전체를 첫 소비자에게 밀어 넣는다. 소비자 메모리 폭발, 다른 소비자는 놀고 있음 |
| 1 | 가장 공정. 하지만 메시지마다 ack 왕복을 기다려 처리량이 RTT 에 묶인다 |
| 10~300 | 보통 적정. 처리 시간이 길면 작게, 짧으면 크게 |

[리틀의 법칙](/performance/notes/01-language-of-performance) 으로 대략 정할 수 있다. 소비자가 메시지를 처리하는 데 5ms, 브로커 왕복이 1ms 라면, 쉬지 않고 일하려면 왕복 동안 처리할 몇 개가 미리 와 있으면 된다. 실험 `mq-broker-benchmark` 는 prefetch 1000 으로 6.8만 msg/s 를 냈다.

## 퍼블리셔 확인 — "보냈다" 를 증명하기

`ch.publish()` 는 소켓 버퍼에 쓰고 바로 돌아온다. 브로커가 받았는지, 디스크에 썼는지는 모른다. 브로커가 그 순간 죽으면 메시지는 사라진다. **퍼블리셔 확인(confirm)** 을 켜면 브로커가 메시지마다 `basic.ack`(받아서 큐에 넣었음, persistent 면 디스크까지) 또는 `basic.nack` 을 돌려준다.

```ts
const ch = await conn.createConfirmChannel();
for (const m of batch) ch.publish("events", "orders.created", m, { persistent: true });
await ch.waitForConfirms();         // 묶음 전체가 확인될 때까지
```

메시지마다 확인을 기다리면 RTT 에 묶인다. **묶음으로 보내고 한 번에 기다리는 것**이 표준이다. 실험 `mq-rabbit-dlx-retry` 는 3건을 보내고 `waitForConfirms` 로 확인을 받았다.

내구성을 위해 세 가지가 **모두** 필요하다. 큐가 durable, 메시지가 persistent, 퍼블리셔 확인. 하나라도 빠지면 브로커 재시작에서 메시지를 잃을 수 있다.

## DLX + TTL — 지연 재시도와 dead letter

RabbitMQ 에는 "5초 뒤 다시" 라는 기능이 내장돼 있지 않다. 대신 두 기능을 조합한다.

- **DLX (dead letter exchange)**: 큐에 `x-dead-letter-exchange` 를 지정하면, 메시지가 거절되거나(`reject`/`nack requeue=false`), 만료되거나(TTL), 큐 길이 한도로 밀려날 때 버리지 않고 그 익스체인지로 보낸다.
- **TTL**: `x-message-ttl` 이 지나면 메시지가 만료된다.

이 둘로 이런 순환을 만든다.

![RabbitMQ DLX + TTL 지연 재시도 순환](/diagrams/mq-rabbit-dlx-retry.svg)

```
work.x ─→ [work 큐, DLX=retry.x] ─→ 소비자
               │ nack(requeue=false)
               ▼
retry.x ─→ [retry 큐, TTL=400ms, DLX=work.x]   (소비자 없음 — 만료만 기다림)
               │ 400ms 후 만료
               ▼
           work.x 로 돌아감 ─→ 다시 소비자
```

소비자는 RabbitMQ 가 붙여 주는 `x-death` 헤더에서 "work 큐에서 몇 번 거절됐나" 를 읽어 시도 횟수를 안다. 3번째 실패면 dead 큐로 보내고 ack 한다.

### 예시로 보기 — 실험 `mq-rabbit-dlx-retry`

정상(good), 한 번만 실패(flaky), 항상 실패(poison) 메시지를 보낸 실제 타임라인이다.

```
    2ms  good    시도 1  처리 성공 → ack
    2ms  flaky   시도 1  실패 → nack → retry 큐 (TTL 400ms)
    2ms  poison  시도 1  실패 → nack → retry 큐
  404ms  flaky   시도 2  처리 성공 → ack
  404ms  poison  시도 2  실패 → nack → retry 큐
  806ms  poison  시도 3  3번째 실패 → dead 큐로 보내고 ack
```

dead 큐에 도착한 poison 메시지의 `x-death` 헤더는 RabbitMQ 가 기록한 여정이다.

```json
[
  { "queue": "…_retry", "reason": "expired",  "count": 2, "exchange": "…_retry.x" },
  { "queue": "…_work",  "reason": "rejected", "count": 2, "exchange": "…_work.x" }
]
```

재시도 간격은 402ms, 402ms 로 TTL 400ms 를 지켰다. `requeue=true` 를 썼다면 실패 메시지가 즉시 돌아와 1초에 수천 번 실패하며 CPU 를 태웠을 것이다.

### 주의 — 메시지별 TTL 의 함정

큐 전체 TTL(`x-message-ttl`) 대신 메시지마다 `expiration` 을 줄 수도 있다. 하지만 RabbitMQ 는 **큐의 머리에 있는 메시지만** 만료를 검사한다. 60초짜리 메시지가 앞에 있으면 그 뒤의 1초짜리 메시지는 60초 동안 갇힌다. 그래서 지연 단계별로 큐를 따로 둔다(`retry.1s`, `retry.10s`, `retry.60s`). 지연 메시지 플러그인(`rabbitmq_delayed_message_exchange`)도 있지만 클러스터 복제가 안 되는 제약이 있다.

## 큐 종류 — classic, quorum, stream

| | classic | quorum | stream |
|---|---|---|---|
| 복제 | 없음 (4.0 부터 미러링 제거) | Raft 로 과반 복제 | Raft, 로그 복제 |
| 내구성 | 노드 하나 | 노드 장애에도 유지 | 노드 장애에도 유지 |
| 모델 | 작업 큐 | 작업 큐 | 로그 (재생 가능, 오프셋) |
| 독 메시지 대응 | 없음 | `x-delivery-limit` 로 재배달 횟수 제한 | — |
| 쓰임 | 임시·비중요 | **운영 기본값** | 팬아웃 대량·재처리 |

RabbitMQ 4.x 에서는 중요한 큐를 **quorum 큐**로 만드는 것이 권장이다. [Raft](/distributed-systems/notes/05-consensus) 로 과반이 기록해야 확인을 주므로 노드 하나를 잃어도 메시지가 남는다. `x-delivery-limit` 은 위의 "3번 실패하면 dead" 를 브로커가 직접 해 준다.

```ts
await ch.assertQueue("orders", {
  durable: true,
  arguments: { "x-queue-type": "quorum", "x-delivery-limit": 5, "x-dead-letter-exchange": "dead.x" },
});
```

## 흔한 운영 실수

| 실수 | 증상 | 대응 |
|---|---|---|
| 요청마다 연결 열기 | 연결 폭주, 메모리 | 연결은 앱당 하나, 채널을 나눠 쓴다 |
| prefetch 무제한 | 한 소비자 OOM, 나머지 유휴 | prefetch 10~300 |
| `requeue=true` 로 실패 처리 | CPU 100%, 로그 폭주 | DLX + TTL 재시도 |
| 큐에 소비자 없이 계속 쌓임 | 디스크·메모리 알람 → 생산자 차단 | 큐 길이 한도(`x-max-length`) + 알림 ([07](/messaging/notes/07-operations-observability)) |
| 큐를 수만 개 생성 | 메타데이터 부하 | 큐를 줄이고 라우팅으로 나눈다 |
| 메모리 알람 | 브로커가 **모든 생산자를 멈춤**(flow control) | 소비 속도 확보, 큐 길이 제한 |

## 실전에서는 어디에 쓰이나

> 메시지마다 라우팅·재시도·dead letter 를 다르게 다뤄야 하는 작업 큐에서 RabbitMQ 의 익스체인지·ack·prefetch·DLX 가 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 후처리 | 주문 이벤트를 재고·알림·감사로 나눠 보내기 | topic 익스체인지 + 서비스별 큐 바인딩 | 생산자가 각 서비스를 직접 호출 — 결합 |
| 이미지·영상 변환 서비스 | 느린 작업을 워커 여러 대에 공정 분배 | 같은 큐 경쟁 소비 + prefetch 조절 | Kafka — 소비자 수 ≤ 파티션 수 |
| 외부 결제·메일 API 연동 | 일시 장애 시 지연 재시도, 영구 실패 격리 | DLX + TTL 재시도 큐, N회 실패 후 dead 큐 | `requeue=true` — 핫 루프 |
| 핀테크 거래 알림 | 노드 장애에도 메시지 보존 | quorum 큐 + persistent + 퍼블리셔 확인 | classic 큐 — 노드 하나에 의존 |
| 국가·등급별 이벤트를 다루는 SaaS | 조건별 라우팅을 브로커에서 | `orders.*.kr` 같은 topic 바인딩 | 조건마다 토픽을 만들고 소비자가 거름 |

**이럴 땐 안 맞는다**
- 같은 이벤트를 며칠 뒤 다시 처리(재생)해야 할 때 — ack 된 메시지는 사라진다. 로그 모델(Kafka, RabbitMQ Streams, JetStream Limits)을 쓴다.
- 초당 수십만 건 이상의 이벤트 수집·분석 파이프라인 — 로그 브로커가 맞다.

**누가 매일 만나나** — 백엔드가 소비자의 ack·prefetch·재시도 정책을 짤 때, SRE 가 메모리 알람으로 생산자가 멈춘(flow control) 장애를 풀 때.

**면접·실무 단골 질문**
- Q. 실패를 `nack(requeue=true)` 로 처리하면? → 큐 앞으로 즉시 돌아와 무한 실패 루프가 된다. DLX + TTL 로 지연 재시도한다.
- Q. RabbitMQ 에서 메시지를 잃지 않으려면? → durable 큐, persistent 메시지, 퍼블리셔 확인 세 가지와 처리 후 ack. 노드 장애까지 견디려면 quorum 큐.

## 실습 체크리스트

- [ ] `pnpm mq:up` 후 관리 UI(http://localhost:15674, study/study)에서 실험 중 생기는 큐·익스체인지·바인딩을 지켜보기
- [ ] 실험 `mq-rabbit-dlx-retry` 의 타임라인에서 flaky 와 poison 의 경로 차이를 설명하기
- [ ] 실험 코드의 `nack(m, false, false)` 를 `nack(m, false, true)` 로 바꾸면 무슨 일이 생길지 예측하기 (돌리지는 말 것)
- [ ] topic 익스체인지로 `orders.{created|paid|cancelled}.{kr|us}` 이벤트를 국가별 분석 큐와 전체 감사 큐로 라우팅하는 바인딩을 설계하기
- [ ] 작업 큐를 quorum 큐 + `x-delivery-limit` 로 바꾸면 실험의 dead 처리 코드 중 무엇이 필요 없어지는지 적기
