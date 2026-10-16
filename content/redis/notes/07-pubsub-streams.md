---
title: 메시징 — List, Pub/Sub, Stream
order: 7
level: 중급
summary: 세 가지 메시징 방식의 전달 보장 차이, 컨슈머 그룹과 PEL, 언제 무엇을 쓸지
tags: [PubSub, Stream, 큐, 컨슈머그룹, XREADGROUP]
experiments: [list-queue, pubsub, streams, keyspace-notifications]
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

## Stream 의 내부 — 왜 메모리를 덜 먹나

Stream 은 **radix tree(rax)** 의 각 노드에 **listpack** 으로 여러 엔트리를 묶어 저장한다. 엔트리 ID 가 시간 순으로 증가하고 필드 이름이 대개 같으므로, 같은 노드 안에서는 **첫 엔트리 대비 차이만** 저장하고 필드 이름도 한 번만 적는다. 그래서 같은 데이터를 Hash 여러 개로 두는 것보다 훨씬 작다.

| 설정 | 의미 | 기본 |
|---|---|---|
| `stream-node-max-bytes` | 한 노드(listpack) 최대 크기 | 4096 |
| `stream-node-max-entries` | 한 노드 최대 엔트리 수 | 100 |

`MAXLEN ~ N` 의 `~` 가 빠른 이유가 여기 있다. 정확히 N 개로 자르려면 노드 중간을 잘라야 하지만, `~` 는 **노드 통째로만** 지워서 O(1) 에 가깝다.

## 컨슈머 그룹의 상태 기계

```
            XADD
              │
              ▼
    ┌──── 스트림 (엔트리) ─────┐
    │   last_delivered_id ──▶│  그룹별 커서
    └───────────────────────┘
              │ XREADGROUP >
              ▼
   PEL (보류 목록: id, 소비자, 전달 횟수, 마지막 전달 시각)
              │                         │
          XACK│                         │ idle > N ms
              ▼                         ▼
           (삭제)                 XAUTOCLAIM → 다른 소비자 PEL
```

```
127.0.0.1:6379> XPENDING orders workers
1) (integer) 3                       ← 보류 3건
2) "1729100000000-0"                 ← 가장 오래된 ID
3) "1729100000420-0"
4) 1) 1) "w1"
      2) "3"
127.0.0.1:6379> XPENDING orders workers - + 10
1) 1) "1729100000000-0"
   2) "w1"
   3) (integer) 93512               ← 93초째 ACK 안 됨
   4) (integer) 4                   ← 4번 전달됨 → 독 메시지 의심
```

**전달 횟수(delivery count)** 가 계속 오르는 메시지는 처리할 때마다 워커를 죽이는 "독 메시지" 일 가능성이 높다. 일정 횟수가 넘으면 별도 스트림(DLQ)으로 옮기고 ACK 하는 규칙을 둔다 — RabbitMQ 의 DLX, JetStream 의 `max_deliver` 와 같은 역할이다([메시징 — 전달 보장](/messaging/notes/04-delivery-guarantees-delay)).

## 전달 보장 정리

| 방식 | 보장 | 중복 가능 | 유실 가능 |
|---|---|---|---|
| Pub/Sub | at-most-once | 아니오 | 예(구독자 없거나 끊김) |
| List `BRPOP` | at-most-once | 아니오 | 예(꺼낸 뒤 워커 죽음) |
| List `BLMOVE` + 처리 후 `LREM` | at-least-once | 예(복구 시 재처리) | 아니오 |
| Stream + 컨슈머 그룹 | at-least-once | 예(XAUTOCLAIM 재전달) | 아니오(트리밍 전) |

at-least-once 라면 소비자는 **멱등**해야 한다. 메시지 ID 를 `SET processed:<id> 1 NX EX 86400` 으로 기록하고 이미 있으면 건너뛰는 것이 가장 간단한 방법이다.

## 운영 지표와 함정

| 지표 / 명령 | 볼 것 |
|---|---|
| `XINFO GROUPS orders` | `lag`(그룹이 아직 안 읽은 수), `pending` |
| `XINFO STREAM orders` | `length`, `first-entry`, 메모리 추정 |
| `XINFO CONSUMERS orders workers` | 소비자별 `idle`, `pending` |
| `INFO clients` `pubsub_clients` | 구독 커넥션 수 |
| `CLIENT LIST` 의 `omem` | Pub/Sub 구독자 출력 버퍼 — 느린 구독자가 메모리를 먹음 |

Pub/Sub 의 숨은 위험은 **느린 구독자**다. 서버는 메시지를 구독자 출력 버퍼에 쌓는데, 구독자가 못 따라가면 버퍼가 커지다가 `client-output-buffer-limit pubsub 32mb 8mb 60` 에 걸려 연결이 끊긴다. 끊기는 순간 메시지는 영영 사라진다.

## Redis Streams 와 Kafka

| | Redis Streams | Kafka |
|---|---|---|
| 저장 | 메모리(+영속화) | 디스크 세그먼트 |
| 보존 | MAXLEN/MINID 로 수만~수백만 | 일·주 단위, TB |
| 파티션 | 스트림 = 한 키 = 한 노드 | 토픽당 여러 파티션 |
| 처리량 | 노드당 수십만 msg/s | 클러스터로 수백만 |
| 소비 위치 | 그룹별 last_delivered_id + PEL | 그룹별 오프셋 |
| 운영 | 이미 Redis 가 있으면 0 | 별도 클러스터 |

메시징 주제의 브로커 벤치마크(`mq-broker-benchmark`)에서 같은 1만 메시지를 돌리면 Redis Streams 는 약 16만 msg/s, Kafka 는 약 11만 msg/s 가 이 노트북에서 나왔다. 규모가 작고 이미 Redis 가 있으면 Streams 로 시작하고, 보존·재처리·파티션이 필요해지면 Kafka 로 넘어가는 것이 흔한 경로다([메시징 — 네 브로커 비교](/messaging/notes/06-four-brokers-same-workload)).

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 Alertmanager 웹훅(`/api/alerts`)은 받은 알림을 List 에 `LPUSH` 하고 `LTRIM` 으로 최근 N개만 남긴다. 보는 쪽은 `LRANGE` 로 최근 것만 읽으므로 큐가 아니라 **캡드 로그** 용도다. 알림을 놓치면 안 되는 처리(예: 자동 복구 트리거)를 붙인다면 Stream + 컨슈머 그룹으로 바꿔 ACK 를 받아야 한다.
- 실험실의 **Pub/Sub**, **Streams**, **키스페이스 알림** 실험을 차례로 돌려 보면, 구독자가 없을 때 PUBLISH 가 0 을 돌려주는 것과 Stream 은 나중에 읽어도 메시지가 남는 것을 나란히 볼 수 있다.

## 실습 체크리스트

- [ ] 구독자 없이 `PUBLISH ch hi` 를 하고 반환값 0 을 확인하기
- [ ] `XADD` 로 10건 넣고 그룹을 만들어 `XREADGROUP` 으로 3건만 읽은 뒤 ACK 없이 `XPENDING` 확인하기
- [ ] `XAUTOCLAIM` 으로 다른 소비자가 오래된 보류 메시지를 가져오게 하기
- [ ] `XINFO GROUPS` 의 `lag` 값이 새 XADD 로 어떻게 변하는지 보기
- [ ] 메시징 주제의 브로커 벤치마크를 돌려 Redis Streams 와 다른 브로커를 비교하기
