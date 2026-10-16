---
title: 컨슈머 그룹·오프셋·리밸런스
order: 3
level: 중급
summary: 그룹이 파티션을 나누는 규칙, 오프셋 커밋 시점과 LAG, 리밸런스가 일어나는 이유와 비용, 재처리
tags: [컨슈머그룹, 오프셋, 커밋, LAG, 리밸런스, replay]
experiments: [kafka-consumer-groups, kafka-offsets-replay]
---

## 그룹과 파티션 할당

- 그룹 안에서 **파티션 하나는 컨슈머 하나에만** 할당된다.
- 파티션 3, 컨슈머 2 → 2:1. 컨슈머 4 → 하나는 논다.
- 그룹이 다르면 서로 간섭 없이 전체를 읽는다 (fan-out).

할당 전략(`partition.assignment.strategy`): Range(기본), RoundRobin, Sticky, **CooperativeSticky**(리밸런스 시 전부 멈추지 않음).

## 오프셋 커밋

컨슈머는 처리한 위치를 내부 토픽 `__consumer_offsets` 에 커밋한다. 커밋은 "다음에 읽을 오프셋".

```
자동 커밋 (enable.auto.commit=true, 5초마다)
  처리 전에 커밋될 수 있다 → 크래시 시 메시지 유실 (at-most-once 에 가까움)
수동 커밋 (처리 후 commit)
  처리 후 커밋 전에 크래시 → 재시작 시 다시 받음 (at-least-once). 처리는 멱등해야 한다
```

```ts
// kafkajs: eachMessage 가 정상 반환되면 자동으로 오프셋을 커밋 (autoCommit 옵션)
await consumer.run({ eachMessage: async ({ partition, message }) => { await handle(message); } });
// 배치 + 수동
await consumer.run({ eachBatch: async ({ batch, resolveOffset, commitOffsetsIfNecessary }) => { for (const m of batch.messages) { await handle(m); resolveOffset(m.offset); } await commitOffsetsIfNecessary(); } });
```

## LAG

```
LAG = 파티션의 최신 오프셋(log-end) − 그룹의 커밋 오프셋
```

```bash
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group workers
# TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG CONSUMER-ID
```

LAG 이 계속 늘면 소비가 생산을 못 따라가는 것. 컨슈머 추가(파티션 수 안에서), 처리 병렬화, 배치 크기 조정.

## 리밸런스

컨슈머가 **들어오거나 나가거나**(크래시, 배포, `max.poll.interval.ms` 초과로 "죽은 것으로" 판단) 파티션이 재할당된다.
- Eager 리밸런스: 전원 멈춤 → 재할당 → 재개 (stop-the-world).
- Cooperative: 바뀌는 파티션만 이동.
- `session.timeout.ms`(하트비트 없으면 탈락), `max.poll.interval.ms`(poll 간격이 길면 탈락 — 처리가 오래 걸리면 올려야 한다).
- **static membership** (`group.instance.id`) 으로 재시작 시 리밸런스를 피할 수 있다.

리밸런스 중엔 그룹 전체가 잠시 멈춘다. 배포 때 컨슈머를 한꺼번에 재시작하면 리밸런스 폭풍이 난다.

## 재처리 (replay)

```bash
# 그룹을 모두 멈춘 뒤
kafka-consumer-groups.sh --reset-offsets --to-earliest --execute --group workers --topic orders --bootstrap-server localhost:9092
kafka-consumer-groups.sh --reset-offsets --to-datetime 2026-10-16T00:00:00.000 --execute ...
kafka-consumer-groups.sh --reset-offsets --shift-by -100 --execute ...
```

- 버그 수정 후 다시 처리, 새 소비자 서비스를 과거부터 따라잡게 하기.
- 재처리를 전제로 **소비자 로직은 멱등**하게 (같은 메시지 두 번 처리해도 결과 동일: upsert, 처리한 ID 기록).

> 이어서 읽기: [NATS 와 JetStream — 가벼운 pub/sub 위에 쌓는 스트림](/messaging/notes/03-nats-jetstream) — NATS 큐 그룹·JetStream 컨슈머와 비교

## 실습 체크리스트

- [ ] 같은 그룹 컨슈머 2개 → `--describe` 로 파티션이 나뉜 것 확인 (실험실)
- [ ] 컨슈머 하나를 죽이고 다시 `--describe` → 남은 컨슈머가 전부 받는 리밸런스 확인
- [ ] `--reset-offsets --to-earliest` 후 재소비 (실험실)
- [ ] 처리 중 일부러 예외를 던져 at-least-once 재전달을 관찰
