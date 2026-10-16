---
title: "메시징 운영과 관측 — 큐 깊이, 소비 지연, 재전달률로 장애를 먼저 본다"
order: 7
level: 심화
summary: "메시징 시스템의 장애는 대개 '조용히 쌓이는 것' 으로 시작한다. 큐 깊이·소비 지연(lag)·가장 오래된 메시지 나이·재전달률·dead letter 유입·생산/소비 속도 차이를 브로커별 어디서 읽는지(RabbitMQ 관리 API·Prometheus 플러그인, NATS /jsz, Kafka 랙, Redis XINFO/XPENDING), 이것으로 만드는 SLO 와 알림 규칙, 트레이스를 메시지 경계 너머로 잇는 법, 그리고 흔한 장애 시나리오와 런북"
tags: [운영, 관측, 큐 깊이, consumer lag, 재전달률, dead letter, Prometheus, 알림, 트레이스 전파, 런북]
experiments: [mq-rabbit-dlx-retry, mq-nats-jetstream-ack, mq-broker-benchmark]
---

## 메시징 장애는 조용하다

HTTP API 가 죽으면 사용자가 바로 에러를 본다. 메시징은 다르다. 소비자가 멈춰도 생산자는 계속 잘 보낸다. 큐에 쌓일 뿐이다. 몇 시간 뒤 "주문 확인 메일이 안 와요" 문의가 오고, 그때 큐에 300만 건이 쌓여 있는 것을 발견한다.

그래서 메시징 관측의 핵심은 **쌓이는 것을 쌓이는 동안 보는 것**이다.

## 봐야 할 신호

| 신호 | 의미 | 왜 중요한가 |
|---|---|---|
| **큐 깊이 / 랙** | 처리 안 된 메시지 수 | 소비가 생산을 못 따라감 |
| **가장 오래된 메시지 나이** | 맨 앞 메시지가 기다린 시간 | 사용자가 체감하는 지연. 깊이보다 직관적 |
| **생산 속도 vs 소비 속도** | 초당 들어오는 수 vs 나가는 수 | 깊이가 늘어날지 줄어들지의 예측 |
| **미확인(unacked) 수** | 소비자가 가져가서 처리 중인 수 | 소비자가 멈췄는데 연결은 살아 있는 경우 |
| **재전달률** | 재배달된 메시지 비율 | 소비자 크래시·타임아웃·독 메시지 |
| **dead letter 유입** | DLQ·DLT 에 들어온 수 | 영구 실패 — 사람이 봐야 함 |
| **소비자 수** | 붙어 있는 소비자 | 0 이면 아무도 처리 안 함 |
| **발행 실패·확인 지연** | nack, 타임아웃 | 브로커 과부하·디스크 문제 |

[관측성의 RED](/observability/notes/03-instrumentation-exporters)(Rate·Errors·Duration) 에 비추면, 메시징에서는 Duration 이 "처리 시간" 보다 **"대기 시간(메시지 나이)"** 으로 나타난다.

## 브로커별로 어디서 읽나

### RabbitMQ

```bash
# 관리 API (이 프로젝트: 15674, study/study)
curl -s -u study:study localhost:15674/api/queues | jq '.[] | {name, messages, messages_unacknowledged, consumers, "in": .message_stats.publish_details.rate, "out": .message_stats.ack_details.rate}'
```

운영에서는 **Prometheus 플러그인**(`rabbitmq_prometheus`, 포트 15692)을 긁는다. 이 프로젝트의 compose 는 15692 를 열지 않았다. 관측 스택에 붙이려면 포트를 추가하고 Prometheus 스크레이프 대상을 늘린다.

```promql
rabbitmq_queue_messages_ready{queue="orders"}                    # 대기 중
rabbitmq_queue_messages_unacked{queue="orders"}                  # 처리 중
rate(rabbitmq_global_messages_redelivered_total[5m])             # 재전달
rabbitmq_queue_consumers{queue="orders"} == 0                    # 소비자 없음
```

### NATS JetStream

```bash
curl -s localhost:18222/jsz?consumers=true | jq '.account_details[].stream_detail[] | {name, msgs: .state.messages, consumers: [.consumer_detail[] | {name, num_pending, num_ack_pending, num_redelivered}]}'
```

실험 `mq-nats-jetstream-ack` 끝의 컨슈머 정보가 바로 이 값들이다. `num_pending`(아직 안 보낸 것), `num_ack_pending`(보냈는데 미확인), `num_redelivered`(재배달 횟수). Prometheus 로는 `prometheus-nats-exporter` 를 붙인다. max_deliver 어드바이저리(`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>`)를 구독해 카운터로 세면 dead letter 유입 메트릭이 된다.

### Kafka

```bash
kafka-consumer-groups.sh --bootstrap-server localhost:19092 --describe --group inventory
# GROUP      TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# inventory  orders  0          18234           18240           6
```

랙 = 로그 끝 − 커밋 오프셋. **파티션별로** 봐야 한다. 합계가 작아도 한 파티션만 멈춰 있을 수 있다(그 파티션의 독 메시지). 메시지 수 랙보다 **시간 랙**(맨 앞 미처리 메시지의 타임스탬프와 현재의 차이)이 SLO 와 직접 연결된다. Burrow·kafka-lag-exporter 가 이를 계산한다. [Kafka 운영](/kafka/notes/07-operations-tuning) 에 자세히 있다.

### Redis Streams

```bash
redis-cli XINFO GROUPS orders          # 그룹별 lag, pending, last-delivered-id
redis-cli XPENDING orders inventory - + 10   # 미확인 메시지, 소비자, 경과 시간, 배달 횟수
```

`XPENDING` 의 **배달 횟수**가 3 이상인 메시지가 독 메시지 후보다. Redis Streams 는 이를 자동으로 처리하지 않으므로 이 값을 보는 잡을 직접 둔다.

## SLO 와 알림

메시징의 SLO 는 "메시지가 생성된 뒤 N 초 안에 처리된다" 로 정하는 것이 사용자 경험과 가장 가깝다.

```
SLO: 주문 이벤트의 99% 는 발행 후 30초 안에 재고에 반영된다 (30일)
SLI: 소비자가 처리 완료 시 (now - event.created_at) 를 히스토그램으로 기록
```

알림 규칙은 증상 → 원인 순으로 둔다.

```yaml
groups:
  - name: messaging
    rules:
      - alert: QueueBacklogGrowing           # 증상: 계속 쌓인다
        expr: |
          rabbitmq_queue_messages_ready{queue="orders"} > 1000
          and deriv(rabbitmq_queue_messages_ready{queue="orders"}[10m]) > 0
        for: 10m
        labels: { severity: warning }
      - alert: OldestMessageTooOld           # 증상: SLO 직결
        expr: messaging_oldest_message_age_seconds{queue="orders"} > 30
        for: 5m
        labels: { severity: critical }
      - alert: NoConsumers                   # 원인: 아무도 안 듣는다
        expr: rabbitmq_queue_consumers{queue="orders"} == 0
        for: 2m
        labels: { severity: critical }
      - alert: DeadLetterInflow              # 원인: 영구 실패가 생긴다
        expr: increase(rabbitmq_queue_messages_published_total{queue=~".*dead.*"}[15m]) > 0
        labels: { severity: warning }
```

"큐 깊이 > 1000" 만으로 알림을 걸면 평소 배치 작업마다 울린다. **계속 늘어나는지**(`deriv`)와 **오래 기다리는지**(나이)를 함께 보는 이유다. 이 프로젝트의 [알림 파이프라인](/observability/notes/09-alerting-pipeline) 이 같은 구조(Prometheus → Alertmanager → 웹훅)다.

## 트레이스를 메시지 너머로 잇기

HTTP 요청은 헤더로 트레이스 컨텍스트(`traceparent`)가 따라간다. 메시지도 같은 일을 해야 한다. 그러지 않으면 트레이스가 생산자에서 끊기고, 소비자의 처리는 새 트레이스가 된다.

```ts
import { context, propagation, trace } from "@opentelemetry/api";

// 생산자: 현재 컨텍스트를 메시지 헤더에 주입
const headers: Record<string, string> = {};
propagation.inject(context.active(), headers);
ch.publish("events", "orders.created", body, { headers });          // RabbitMQ
await js.publish("orders.created", body, { headers: natsHeaders(headers) });   // NATS
await producer.send({ topic: "orders", messages: [{ value: body, headers }] }); // Kafka

// 소비자: 헤더에서 꺼내 링크 또는 부모로
const parent = propagation.extract(context.active(), msg.properties.headers);
const span = trace.getTracer("inventory").startSpan("orders.created process", {
  links: [{ context: trace.getSpanContext(parent)! }],   // 비동기 경계는 '부모' 보다 '링크' 가 정석
});
```

OpenTelemetry 의 메시징 시맨틱 규약은 비동기 경계를 **링크**로 잇기를 권한다. 소비가 몇 시간 뒤에 일어날 수도 있고, 메시지 하나가 여러 소비자에게 갈 수도 있기 때문이다. [분산 트레이싱](/observability/notes/06-tracing-otel) 노트의 Tempo 에서 링크를 따라 생산자의 트레이스로 건너갈 수 있다.

## 흔한 장애와 런북

| 장애 | 첫 신호 | 확인 | 조치 |
|---|---|---|---|
| 소비자 전멸 | 소비자 수 0, 깊이 급증 | 배포 직후? OOM? 연결 오류? | 롤백, 소비자 재시작, 일시적으로 소비자 수 증설 |
| 독 메시지 | 재전달률 급증, 한 파티션 랙만 증가 | `XPENDING` 배달 횟수, x-death, max_deliver 어드바이저리 | DLQ 로 격리, 원인 수정 후 재처리 |
| 느린 의존성 | 미확인 수 증가, 처리 시간 증가 | 소비자 트레이스의 하위 호출 | 타임아웃·[서킷 브레이커](/chaos/notes/03-resilience-patterns-verified), prefetch 축소 |
| 브로커 디스크·메모리 알람 | 발행 지연·차단 (RabbitMQ flow control) | 브로커 메트릭 | 소비 속도 확보, 큐 길이 제한, 보존 기간 단축 |
| 재처리 폭주 | 재처리 후 하류 서비스 과부하 | 소비 속도 그래프 | 재처리 소비자에 속도 제한 |
| 리밸런스 폭풍 (Kafka) | 랙이 주기적으로 튐 | 그룹 조인 로그 | `max.poll.interval.ms`, 정적 멤버십, 협력적 리밸런싱 |

### 백로그를 비울 때 걸리는 시간

깊이 D, 생산 속도 P, 소비 속도 C 일 때 백로그가 사라지는 시간은 D ÷ (C − P) 다. C 가 P 보다 겨우 조금 크면 영원히 걸린다. 예를 들어 깊이 50만, 생산 900/s, 소비 1000/s 면 5000초(1시간 23분)다. 소비자를 2배로 늘려 2000/s 가 되면 455초다. 단 소비자를 늘리면 **하류 의존성**(DB, 외부 API)이 그 부하를 받는다. 백로그를 비우다 DB 를 쓰러뜨리는 것이 흔한 2차 장애다.

## 예시로 보기 — 이 프로젝트에서 관측 붙이기

관측 스택(`pnpm obs:up`)에 메시징을 붙이는 순서다.

1. **RabbitMQ**: compose 의 rabbitmq 에 `127.0.0.1:15692:15692` 를 추가하고, `observability/prometheus.yml` 에 `rabbitmq:15692` 스크레이프를 넣는다.
2. **NATS**: `natsio/prometheus-nats-exporter` 를 `-jsz=all http://nats:8222` 로 띄운다.
3. **Kafka**: kafka-lag-exporter 또는 JMX exporter.
4. **Grafana**: 큐마다 "깊이·가장 오래된 나이·in/out 속도·재전달·DLQ 유입" 다섯 패널.
5. **알림**: 위 네 규칙을 `alert-rules.yml` 에.

실험을 돌리면서 이 패널을 보면 숫자가 실제로 움직이는 것을 볼 수 있다. `mq-rabbit-dlx-retry` 는 retry 큐가 400ms 마다 차고 비는 것을, `mq-nats-jetstream-ack` 는 `num_redelivered` 가 오르는 것을, `mq-broker-benchmark` 는 1만 건이 들어왔다 나가는 속도를 보여 준다.

## 실습 체크리스트

- [ ] 실험 `mq-rabbit-dlx-retry` 를 돌리는 동안 관리 API 를 1초마다 조회해 work·retry·dead 큐 깊이 변화를 기록하기
- [ ] 위 RabbitMQ 관리 API 명령으로 in/out 속도를 읽고, 백로그 소진 시간 공식에 넣어 보기
- [ ] "큐 깊이 > 1000" 단독 알림이 왜 나쁜지, 어떤 상황에서 오탐·미탐이 나는지 적기
- [ ] 생산자에서 `traceparent` 를 메시지 헤더에 넣고 소비자에서 링크로 이으면 Tempo 에서 어떻게 보이는지 그려 보기
- [ ] 독 메시지 런북을 내 서비스용으로 5단계(감지·격리·원인·수정·재처리)로 써 보기
