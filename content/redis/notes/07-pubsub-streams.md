---
title: 메시징 — List, Pub/Sub, Stream
order: 7
level: 중급
summary: 세 가지 메시징 방식의 전달 보장 차이, 컨슈머 그룹과 PEL, 언제 무엇을 쓸지
tags: [PubSub, Stream, 큐, 컨슈머그룹, XREADGROUP]
experiments: [list-queue, pubsub, streams]
---

## 비교표

| | List | Pub/Sub | Stream |
|---|---|---|---|
| 저장 | 소비될 때까지 | **안 함** | 영구 (트리밍 전까지) |
| 소비자 | 1개가 가져가면 끝 | 모든 구독자에게 | 그룹 내 분배 + 여러 그룹 |
| 재처리 | 꺼낸 뒤 실패하면 유실 (BLMOVE 로 보완) | 불가 | ACK 전까지 PEL 에 보관 |
| 과거 메시지 | 큐에 남은 것만 | 불가 | ID 로 임의 위치 읽기 |
| 용도 | 단순 작업 큐 | 실시간 알림, 캐시 무효화 방송 | 이벤트 로그, 내구성 큐 |

## List 큐

```
LPUSH jobs job:1
BRPOP jobs 0                 # 블로킹 대기 (0 = 무한)
BLMOVE jobs processing RIGHT LEFT 0   # 처리 중 목록으로 옮겨서 안전하게
```

`BRPOP` 으로 꺼낸 뒤 워커가 죽으면 메시지는 사라진다. `BLMOVE` 로 `processing` 리스트에 옮겨 두고 완료 시 `LREM` 하면 복구가 가능하다 (reliable queue 패턴).

## Pub/Sub

```
SUBSCRIBE news           # 구독 모드로 전환 (다른 명령 불가)
PSUBSCRIBE news.*        # 패턴
PUBLISH news "hello"     # 반환값: 받은 구독자 수
```

- **fire-and-forget**. 구독자가 없거나 네트워크가 끊겨 있으면 메시지는 그냥 사라진다.
- 구독 커넥션은 전용이어야 한다. ioredis 에서는 `redis.duplicate()` 로 별도 커넥션을 만든다.
- 클러스터에서는 모든 노드로 브로드캐스트되므로 비용이 크다. Redis 7 의 `SSUBSCRIBE` (sharded pub/sub) 가 이를 완화한다.
- 키 변경 알림: `notify-keyspace-events` 를 켜면 `__keyevent@0__:expired` 같은 채널로 만료 이벤트를 받을 수 있다 (역시 유실 가능).

## Stream

Kafka 의 토픽과 비슷한 append-only 로그. 각 엔트리는 `<밀리초>-<시퀀스>` ID 와 필드-값 쌍을 가진다.

```
XADD orders * item apple qty 3          # * = 자동 ID
XADD orders MAXLEN ~ 10000 * ...        # 대략 1만 개로 제한
XLEN orders
XRANGE orders - +                       # 전체
XREVRANGE orders + - COUNT 10           # 최근 10개
XREAD COUNT 10 BLOCK 5000 STREAMS orders $   # 새 메시지 블로킹 대기
```

### 컨슈머 그룹

여러 워커가 메시지를 **나눠서** 처리하고, 처리 완료를 ACK 로 알린다.

```
XGROUP CREATE orders workers $ MKSTREAM   # $ = 지금부터, 0 = 처음부터
XREADGROUP GROUP workers w1 COUNT 1 BLOCK 2000 STREAMS orders >
# > = 아직 아무에게도 전달되지 않은 메시지
XACK orders workers 1697000000000-0
```

- 전달됐지만 ACK 안 된 메시지는 **PEL(Pending Entries List)** 에 소비자 이름과 함께 남는다.
- `XPENDING orders workers` 로 확인, `XAUTOCLAIM orders workers w2 60000 0` 으로 60초 이상 방치된 메시지를 w2 가 가져간다.
- 같은 스트림에 여러 그룹을 만들면 각 그룹이 독립적으로 전체 메시지를 받는다 (fan-out).
- `XREADGROUP ... STREAMS orders 0` 은 **내 PEL** 을 다시 읽는다. 재시작 시 미처리분 복구에 사용.

### 트리밍

스트림은 자라기만 하므로 반드시 제한한다.
- `MAXLEN ~ N`: 대략 N 개 (radix 노드 단위로 지워서 빠름)
- `MINID ~ <id>`: 특정 ID 이전 삭제
- `XTRIM orders MAXLEN 1000`

## 선택 가이드

1. 유실돼도 되는 실시간 신호 (온라인 상태, 캐시 무효화) → **Pub/Sub**
2. 단순 백그라운드 작업, 워커 1종 → **List** (+BLMOVE)
3. 재처리·감사·여러 소비자 그룹·순서 보장 → **Stream**
4. 수백만 TPS, 장기 보관, 파티셔닝 → Kafka 같은 전용 시스템
