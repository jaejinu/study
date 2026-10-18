---
title: "전달 보장·중복 제거·우선순위·지연 큐 — 브로커가 약속하는 것과 앱이 해야 하는 것"
order: 4
level: 중급
summary: "at-most-once·at-least-once·exactly-once 가 각각 어디서 깨지는지를 생산·저장·소비 세 구간으로 나눠 보고, 실무의 답인 at-least-once + 멱등 소비자를 구현하는 세 가지 방법(처리 기록 테이블·자연 멱등·버전 비교), 생산 측 중복 제거, 순서가 깨지는 지점, 우선순위 큐의 함정, 지연 메시지를 만드는 네 가지 방법을 브로커별로 비교한다"
tags: [전달 보장, at-least-once, exactly-once, 멱등 소비자, 중복 제거, 순서, 우선순위 큐, 지연 메시지, 재시도]
experiments: [mq-rabbit-dlx-retry, mq-nats-jetstream-ack]
---

## 세 구간, 세 가지 실패

메시지는 세 구간을 지난다. 각 구간에서 유실이나 중복이 생긴다.

```
[생산자] ──① 발행──→ [브로커 저장] ──② 보관──→ [소비자 처리] ──③ 확인──→
```

| 구간 | 유실 원인 | 중복 원인 | 막는 장치 |
|---|---|---|---|
| ① 발행 | 확인 없이 보내고 브로커가 죽음 | 확인을 못 받아 재전송 (사실은 저장됐음) | 퍼블리셔 확인 / acks=all / PubAck + 생산 측 중복 제거 |
| ② 보관 | 메모리에만 있다가 재시작, 복제 안 됨 | — | 디스크 저장 + 복제 (quorum 큐, ISR, JetStream replicas) |
| ③ 소비 | 처리 전에 ack (자동 ack) 후 소비자 죽음 | 처리 후 ack 전에 소비자 죽음 → 재배달 | 처리 후 ack + **멱등 소비자** |

## 보장 수준

| 수준 | 의미 | 어떻게 |
|---|---|---|
| at-most-once | 많아야 한 번. 잃을 수 있다 | 확인 없이 발행, 받자마자 ack. core NATS, Redis Pub/Sub |
| at-least-once | 적어도 한 번. 중복될 수 있다 | 확인 받을 때까지 재전송, 처리 후 ack. **실무의 기본** |
| exactly-once | 정확히 한 번 | 브로커 **안에서만** 가능. 바깥 세계와는 불가능 |

"exactly-once" 는 조심해서 읽어야 한다. Kafka 의 트랜잭션은 "Kafka 에서 읽고 Kafka 에 쓰는" 경로 안에서 정확히 한 번을 보장한다. 하지만 소비자가 **이메일을 보내거나 결제 API 를 부르면** 그 부작용은 Kafka 트랜잭션 밖이다. 이메일 발송 후 오프셋 커밋 전에 죽으면 이메일은 두 번 간다. [분산 트랜잭션](/distributed-systems/notes/06-transactions-coordination) 노트가 말하는 "정확히 한 번의 실체" 는 결국 이것이다.

> 정확히 한 번 = **적어도 한 번 전달** + **멱등 처리**

## 멱등 소비자 — 세 가지 구현

### 1. 처리 기록 테이블 (가장 일반적)

메시지 ID 를 처리 결과와 **같은 트랜잭션**에 기록한다.

```sql
CREATE TABLE processed_messages (
  consumer   text NOT NULL,
  message_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);
```

```ts
await db.tx(async (t) => {
  const r = await t.query(
    "INSERT INTO processed_messages (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    ["inventory", msg.id],
  );
  if (r.rowCount === 0) return;                  // 이미 처리함 → 건너뜀
  await t.query("UPDATE stock SET qty = qty - $1 WHERE sku = $2", [msg.qty, msg.sku]);
});
ack(msg);                                         // 트랜잭션 커밋 후에 ack
```

처리와 기록이 같은 트랜잭션이라 "처리했는데 기록 못 함" 이 없다. 기록 테이블은 보존 기간(브로커의 재배달 가능 기간보다 길게)이 지나면 지운다.

### 2. 자연 멱등 연산

연산 자체를 여러 번 해도 같은 결과가 되도록 바꾼다.

| 멱등 아님 | 멱등 |
|---|---|
| `qty = qty - 1` | `qty = 41` (절대값 설정) |
| `INSERT INTO orders …` | `INSERT … ON CONFLICT (order_id) DO NOTHING` |
| `SADD` 는 원래 멱등, `INCR` 은 아님 | 집합에 넣기, 상태 전이 |
| "이메일 보내기" | "이메일 발송 요청을 (message_id 키로) 등록" → 발송 서비스가 멱등 키로 중복 차단 |

### 3. 버전·시퀀스 비교

엔티티 상태에 버전을 두고 더 오래된 메시지는 무시한다. 중복뿐 아니라 **순서 뒤바뀜**도 함께 막는다.

```sql
UPDATE orders SET status = $1, version = $2
WHERE id = $3 AND version < $2;     -- 영향 행 0 = 이미 더 새 상태
```

## 생산 측 중복 제거

소비 측 멱등이 근본 해법이지만, 브로커가 생산 측 중복을 줄여 주면 비용이 준다.

| 브로커 | 장치 | 범위 |
|---|---|---|
| Kafka | 멱등 프로듀서 (`enable.idempotence`, 기본 켜짐) | 프로듀서 세션 안 재전송 |
| NATS JetStream | `msgID` + duplicate_window | 창(기본 2분) 안 같은 ID |
| RabbitMQ | 없음 (플러그인 `message-deduplication`) | — |
| SQS FIFO | MessageDeduplicationId | 5분 |
| Redis Streams | 없음 — `XADD` 에 ID 를 직접 지정하면 같은 ID 는 거절 | 단조 증가 ID 한정 |

실험 `mq-nats-jetstream-ack` 에서 같은 `msgID` 로 다시 보내자 `{ seq: 1, duplicate: true }` 가 돌아왔다. 두 번째 메시지는 저장되지 않았다.

## 순서는 어디서 깨지나

[01 노트](/messaging/notes/01-queue-topic-log-models)에서 본 것처럼 순서 보장은 좁다. 깨지는 지점을 정리한다.

| 지점 | 예 |
|---|---|
| 병렬 소비자 | 소비자 둘이 m1, m2 를 나눠 받으면 완료 순서가 섞임 |
| prefetch + 비동기 처리 | 한 소비자 안에서도 동시에 처리하면 섞임 |
| 재시도 | 실패한 m1 이 재시도 큐를 다녀오면 m2·m3 뒤로 |
| 생산자 재전송 | Kafka 에서 `max.in.flight > 1` 이고 멱등 프로듀서가 아니면 재전송이 순서를 뒤집음 |
| 파티션 재배치 | 키→파티션 매핑이 바뀌면(파티션 수 변경) 같은 키가 다른 파티션으로 |

순서가 정말 필요하면 **키 단위**로 줄인다. 같은 주문 ID 의 메시지는 같은 파티션·같은 소비자에게 가게 하고, 그 키 안에서는 하나씩 처리한다. 소비자는 버전 비교(위의 방법 3)로 뒤바뀐 메시지를 견딘다.

## 우선순위 큐 — 생각보다 어렵다

"VIP 주문을 먼저" 같은 요구는 흔하다.

| 방법 | 장단점 |
|---|---|
| RabbitMQ 우선순위 큐 (`x-max-priority: 10`) | 간단. 단 **prefetch 로 이미 소비자에게 간 메시지는 재정렬 안 됨**. 큐가 비어 있으면 우선순위가 의미 없음 |
| 우선순위별 큐 + 소비자 분리 | 가장 예측 가능. VIP 전용 워커 풀 — [벌크헤드](/chaos/notes/03-resilience-patterns-verified)와 같은 격리 |
| 가중 폴링 | 높은 큐에서 3번, 낮은 큐에서 1번 꺼내기. 기아 방지 |
| Kafka | 우선순위 개념 없음. 토픽을 나눈다 |

엄격한 우선순위는 **기아(starvation)** 를 부른다. 높은 우선순위가 계속 들어오면 낮은 것은 영원히 처리되지 않는다. 가중치나 나이 기반 승격(오래 기다린 메시지의 우선순위를 올림)을 둔다.

## 지연 메시지 — 네 가지 방법

"30분 뒤에 결제 안 된 주문을 취소" 같은 지연 작업의 구현 방법이다.

| 방법 | 동작 | 장점 | 단점 |
|---|---|---|---|
| **브로커 기능** | NATS `nak(delay)`, SQS `DelaySeconds`, RabbitMQ 지연 플러그인 | 한 줄 | 브로커마다 다르고 최대 지연 제한(SQS 15분) |
| **TTL + DLX** (RabbitMQ) | TTL 큐에 넣었다가 만료되면 원래 큐로 | 플러그인 없이 클러스터 안전 | 지연 단계별로 큐를 만들어야 함 (메시지별 TTL 은 머리 막힘) |
| **Redis Sorted Set** | `ZADD delayed <실행시각> <id>` → 폴러가 `ZRANGEBYSCORE 0 <now>` 로 꺼냄 | 임의 지연, 취소 쉬움(`ZREM`) | 폴러 구현·원자적 꺼내기(Lua) 필요 |
| **DB 스케줄 테이블** | `run_at` 컬럼 + `SKIP LOCKED` 폴링 | 트랜잭션과 묶임, 조회·감사 쉬움 | 폴링 주기만큼 지연, 대량엔 부적합 |

### 예시로 보기 — 두 브로커의 지연 재시도

실험 둘이 같은 문제를 다르게 푼다.

| | RabbitMQ (`mq-rabbit-dlx-retry`) | JetStream (`mq-nats-jetstream-ack`) |
|---|---|---|
| 구성 | work 큐 + retry 큐(TTL 400ms) + 익스체인지 2개 + dead 큐 | 컨슈머 설정 하나 |
| 지연 | 큐 TTL 로 고정 | `nak(300)` 으로 메시지마다 |
| 시도 횟수 | `x-death` 헤더에서 계산 | `info.deliveryCount` |
| 최대 횟수 | 소비자 코드 (또는 quorum 큐 `x-delivery-limit`) | `max_deliver: 3` |
| 실패 종착지 | dead 큐 | 어드바이저리 + 스트림에 남은 원본 |
| 실측 간격 | 402ms, 402ms (TTL 400) | 약 301ms (nak 300), ack_wait 재배달 1001ms |

### 재시도 간격 설계

재시도 간격은 [지수 백오프 + 지터](/api-design/notes/04-errors-retries-deadlines) 가 기본이다. 메시징에서는 단계가 더 길다. 1초 → 10초 → 1분 → 10분 → dead. 외부 시스템 장애는 몇 초가 아니라 몇 분 가기 때문이다. 그리고 dead 로 간 메시지에는 반드시 **사람이 보는 경로**(알림, 재처리 버튼)가 있어야 한다. 아무도 안 보는 dead 큐는 조용한 데이터 유실이다.

## 실전에서는 어디에 쓰이나

> 결제·재고·포인트처럼 "두 번 처리되거나 빠지면 돈이 틀어지는" 메시지를 다룰 때, 그리고 "30분 뒤 취소" 같은 지연 작업을 만들 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 결제 후처리 | 재배달로 같은 결제가 두 번 반영되는 것 방지 | 처리 기록 테이블에 message_id 를 처리와 같은 트랜잭션으로 | 브로커의 exactly-once — 외부 부작용엔 불가 |
| 커머스 재고 차감 | 중복과 순서 뒤바뀜 동시 대응 | 절대값 설정, 버전 비교 `UPDATE … WHERE version < $2` | `qty = qty - 1` — 중복 시 과차감 |
| 커머스 미결제 주문 자동 취소 | 정해진 시각에 실행되는 작업 | 브로커 지연 기능, Redis Sorted Set, DB `run_at` 테이블 | 크론으로 전체 스캔 — 지연·부하 |
| 고객 지원 SaaS | VIP 요청 우선 처리 | 우선순위별 큐 + 전용 워커 풀 | 엄격 우선순위 큐 — 낮은 쪽 기아 |
| 이메일·알림 발송 | 외부 장애 시 재시도 | 1초 → 10초 → 1분 → 10분 → dead, 사람이 보는 경로 | 즉시 반복 재시도 — 장애 악화 |

**이럴 땐 안 맞는다**
- 일부 유실이 허용되는 고빈도 지표·로그에 처리 기록 테이블 — DB 쓰기 비용만 는다. at-most-once 로 충분하다.
- 전체 순서 보장을 요구하는 설계 — 병렬성을 잃는다. 엔티티 키 단위 순서로 줄인다.

**누가 매일 만나나** — 백엔드가 소비자 코드에 멱등성을 넣을 때, 코드 리뷰에서 "ack 를 트랜잭션 커밋 전에 했다" 를 잡아낼 때.

**면접·실무 단골 질문**
- Q. exactly-once 는 가능한가? → 브로커 안에서만 가능하다. 실무의 답은 at-least-once 전달 + 멱등 처리다.
- Q. 멱등 소비자를 구현하는 방법은? → 같은 트랜잭션의 처리 기록 테이블, 자연 멱등 연산, 버전·시퀀스 비교.

## 실습 체크리스트

- [ ] 내 서비스의 메시지 소비자 하나를 골라 ①②③ 구간별로 유실·중복 가능성을 표로 적기
- [ ] 처리 기록 테이블 방식에서 `ack` 를 트랜잭션 **전**에 하면 어떤 실패가 생기는지 설명하기
- [ ] 재고 차감 소비자를 자연 멱등 연산으로 바꾸려면 메시지에 무엇이 들어 있어야 하는지 정하기
- [ ] Redis Sorted Set 지연 큐에서 여러 폴러가 같은 작업을 동시에 꺼내지 않게 하는 Lua 스크립트를 써 보기
- [ ] 두 실험을 돌려 RabbitMQ 와 JetStream 의 재시도 간격이 각각 무엇으로 정해지는지 표에 숫자로 채우기
