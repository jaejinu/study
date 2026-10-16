---
title: "심화 — Kafka 내부: 로그 세그먼트, 페이지 캐시, 복제 프로토콜, 컨트롤러"
order: 5
level: 심화
summary: 파티션이 디스크에 저장되는 구조(세그먼트·인덱스·타임인덱스), 순차 I/O 와 페이지 캐시·zero-copy 가 처리량을 만드는 원리, 리더·팔로워 복제와 ISR·high watermark·leader epoch, 프로듀서 배치와 압축의 실제 경로, KRaft 컨트롤러와 메타데이터 로그, 로그 컴팩션 동작
tags: [세그먼트, 페이지캐시, zero-copy, ISR, high-watermark, leader-epoch, KRaft, 컴팩션]
experiments: [kafka-produce-consume, kafka-offsets-replay]
---

## 파티션은 디렉터리, 세그먼트는 파일

```
/var/lib/kafka/data/orders-0/
  00000000000000000000.log        # 세그먼트 (오프셋 0 부터)
  00000000000000000000.index      # 오프셋 → 파일 위치 (희소: 4KB 마다)
  00000000000000000000.timeindex  # 타임스탬프 → 오프셋
  00000000000001048576.log        # 다음 세그먼트 (segment.bytes 1GB 또는 segment.ms 7일 마다 롤)
  leader-epoch-checkpoint
```

- 쓰기는 **활성 세그먼트 끝에 append** 만. 랜덤 쓰기가 없다.
- 읽기는 index 로 세그먼트 안 위치를 찾은 뒤 순차 읽기. 오프셋 N 조회 = 이진 탐색 + 짧은 스캔.
- 보존(retention)·컴팩션은 **세그먼트 단위**로 삭제한다. 활성 세그먼트는 지우지 않으므로 `retention.ms` 를 짧게 해도 `segment.ms` 가 길면 안 지워진다 — [토픽 노트](/kafka/notes/02-topics-partitions) 실습의 함정.

```bash
docker compose exec kafka ls -la /tmp/kraft-combined-logs/        # apache/kafka 이미지의 데이터 경로
docker compose exec kafka /opt/kafka/bin/kafka-dump-log.sh --files /tmp/kraft-combined-logs/lab_kafka_produce_consume_orders-0/00000000000000000000.log --print-data-log | head
```

## 왜 빠른가 — OS 에 맡긴다

1. **순차 I/O**: HDD 에서도 수백 MB/s. 랜덤 I/O 의 수천 배.
2. **페이지 캐시**: Kafka 는 자체 캐시를 두지 않고 커널 페이지 캐시에 기댄다. 최근 쓴 데이터는 메모리에 있어 소비자가 바로 읽는다. 그래서 브로커 JVM 힙은 작게(6GB 안팎), 나머지 RAM 은 페이지 캐시에.
3. **zero-copy**: `sendfile()` 로 페이지 캐시 → 소켓으로 커널 안에서 복사. 사용자 공간을 거치지 않는다. (TLS 를 쓰면 암호화 때문에 사용자 공간 복사가 생겨 처리량 ↓)
4. **배치**: 프로듀서는 파티션별로 `batch.size`/`linger.ms` 만큼 모아 한 요청에, 소비자는 `fetch.min.bytes`/`fetch.max.wait.ms` 로 모아 받는다. 브로커는 레코드 배치를 **해석하지 않고 그대로** 저장·전달(압축도 배치 단위로 프로듀서가 하고 소비자가 푼다).

메모리가 부족해 페이지 캐시가 밀리면(소비자가 오래된 데이터를 읽거나, 브로커에 다른 프로세스가 있으면) 디스크 읽기가 생기고 지연이 뛴다 — 브로커는 전용 머신으로.

## 복제 프로토콜

```
Producer ──▶ Leader (파티션 0 의 리더 브로커)
               ├── Follower A  fetch (pull)   ─┐ ISR
               └── Follower B  fetch (pull)   ─┘
```

- 팔로워가 리더에서 **fetch(pull)** 한다 (push 아님). 소비자와 같은 프로토콜.
- **ISR**(In-Sync Replicas): `replica.lag.time.max.ms`(기본 30초) 안에 리더를 따라온 레플리카 집합. 느린 팔로워는 ISR 에서 빠진다.
- **High Watermark(HW)**: ISR 전체가 복제한 마지막 오프셋. **소비자는 HW 까지만** 읽을 수 있다 — 커밋되지 않은(모든 ISR 에 없는) 메시지는 보이지 않아 리더 교체 시 "읽었는데 사라지는" 일을 막는다.
- `acks=all` 은 **ISR 전체** 가 쓰면 응답. `min.insync.replicas=2` 는 ISR 이 2 미만이면 쓰기를 거부(NotEnoughReplicas) — 가용성보다 내구성.
- **Leader epoch**: 리더가 바뀔 때마다 증가. 팔로워가 재합류할 때 epoch 로 "어디까지 잘라야 하나(truncate)" 를 정확히 판단 — 예전 HW 기반 방식의 데이터 불일치 버그를 고친 것.
- `unclean.leader.election.enable=false`(기본): ISR 밖 레플리카를 리더로 뽑지 않는다. 전부 죽으면 파티션이 불가용 — 유실보다 정지를 택한다.

```bash
kafka-topics.sh --describe --topic orders --bootstrap-server localhost:9092     # Leader, Replicas, Isr
# 레플리카가 ISR 에서 빠지면 Isr 목록이 줄어든다. 모니터링: UnderReplicatedPartitions > 0
```

## 프로듀서 내부 경로

```
send() → 직렬화 → 파티셔너(키 해시 / sticky) → RecordAccumulator (파티션별 배치 버퍼, buffer.memory)
      → Sender 스레드: linger.ms 또는 batch.size 도달 시 → 브로커별로 묶어 ProduceRequest (max.in.flight.requests.per.connection)
      → 압축 (배치 단위) → 응답 → 콜백 / future
```

- `max.in.flight.requests.per.connection > 1` + 재시도 = 순서 역전 가능 → **멱등 프로듀서**(enable.idempotence, 기본 on) 는 시퀀스 번호로 브로커가 순서·중복을 보장하며 in-flight 5 까지 허용.
- `buffer.memory` 가 차면 `max.block.ms` 동안 `send()` 가 블록 → 백프레셔.
- 압축: lz4(빠름), zstd(비율 좋음). 브로커 `compression.type=producer` 로 재압축 없이 저장.

## 컨슈머 내부

- `poll()` 이 하트비트 스레드와 별개로 레코드를 가져온다. `max.poll.interval.ms` 안에 다음 `poll()` 을 못 하면 그룹에서 쫓겨난다 — 처리가 느리면 `max.poll.records` 를 줄인다.
- 파티션별로 fetch 요청을 브로커(리더)마다 묶는다. `fetch.max.bytes`, `max.partition.fetch.bytes`.
- 오프셋 커밋은 `__consumer_offsets`(컴팩션 토픽, 50 파티션) 에 `(group, topic, partition) → offset` 메시지로. 그룹 코디네이터 브로커가 관리.

## KRaft 컨트롤러

- 컨트롤러 쿼럼(3 또는 5 노드)이 **메타데이터 로그**(`__cluster_metadata` 토픽, Raft 복제)에 브로커 등록·파티션 리더·ISR 변경을 기록한다. 브로커는 이 로그를 fetch 해 자기 메타데이터 캐시를 갱신.
- ZooKeeper 시절엔 컨트롤러 장애 조치에 수십 초, 파티션 수만 개에서 분 단위 걸리던 것이 수 초로.
- 이 프로젝트의 단일 노드는 broker+controller 겸임(`process.roles=broker,controller`). 운영은 분리.

```bash
kafka-metadata-quorum.sh --bootstrap-server localhost:9092 describe --status
kafka-metadata.sh --snapshot /tmp/kraft-combined-logs/__cluster_metadata-0/00000000000000000000.log   # 메타데이터 로그 보기
```

## 로그 컴팩션 동작

`cleanup.policy=compact` 토픽은 **키별 최신 값**만 남긴다.
```
세그먼트: (k1,v1)(k2,v1)(k1,v2)(k3,null)(k2,v2)   →   컴팩션 후: (k1,v2)(k2,v2) + tombstone k3 (delete.retention.ms 동안 유지)
```
- 활성 세그먼트는 컴팩션 대상이 아니다. "최신 값만 있다" 는 보장은 **결국**(eventually)이다.
- 소비자가 처음부터 읽으면 각 키의 최신 상태를 재구성 → 상태 저장소·캐시 워밍(Kafka Streams 의 changelog, Connect 의 offset 토픽).
- `min.cleanable.dirty.ratio` 로 컴팩션 빈도 조절.

## 실습 체크리스트

- [ ] `kafka-dump-log.sh` 로 실험 토픽의 세그먼트 파일을 열어 배치·오프셋·타임스탬프 구조 보기
- [ ] 토픽을 `--describe` 해 Leader/Replicas/Isr 읽기 (단일 노드라 모두 1)
- [ ] `segment.ms=60000`, `retention.ms=120000` 토픽을 만들고 메시지를 넣은 뒤 3분 후 세그먼트 삭제 확인
- [ ] `cleanup.policy=compact` 토픽에 같은 키로 여러 값을 넣고 `--from-beginning` 소비로 최신 값만 남는지 (활성 세그먼트 롤 이후)
- [ ] `kafka-metadata-quorum.sh describe --status` 로 KRaft 리더 확인
