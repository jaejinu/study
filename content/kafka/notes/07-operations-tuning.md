---
title: "심화 — 운영과 튜닝: 파티션 수, 리밸런스, 모니터링, 보안, 용량"
order: 7
level: 심화
summary: 파티션 수 산정 공식과 함정, 브로커·프로듀서·컨슈머 핵심 설정 튜닝, 리밸런스 폭풍 줄이기, 꼭 봐야 할 메트릭(UnderReplicated·LAG·요청 지연)과 알림, 보안(TLS·SASL·ACL), 용량 계획과 티어드 스토리지, 업그레이드·재해 복구(MirrorMaker 2)
tags: [파티션, 튜닝, 리밸런스, 모니터링, LAG, SASL, ACL, MirrorMaker, 용량]
experiments: [kafka-consumer-groups]
---

## 파티션 수 정하기

```
파티션 수 ≥ max( 목표 처리량 / 파티션당 생산 처리량 , 목표 처리량 / 소비자당 소비 처리량 )
```
예: 목표 100MB/s, 파티션당 생산 10MB/s, 소비자당 20MB/s → max(10, 5) = 10 → 여유 2배 **20**.

- 늘릴 수는 있지만 줄일 수 없고, 늘리면 키→파티션 매핑이 바뀐다. 처음에 넉넉히.
- 너무 많으면: 브로커당 파일 핸들·메모리, 리더 선출 시간, 프로듀서 배치 효율 ↓, 컨트롤러 부담. 브로커당 수천, 클러스터 수만 개가 실무 상한 근처.
- 키 분포가 치우치면(핫 키) 파티션 수와 무관하게 한 파티션만 바쁘다 → 키 설계 ([토픽 노트](/kafka/notes/02-topics-partitions)).

## 핵심 설정 튜닝

**브로커**
```
num.network.threads=8 / num.io.threads=16          # 코어 수에 맞게
log.retention.hours=168 / log.segment.bytes=1GB
default.replication.factor=3 / min.insync.replicas=2
auto.create.topics.enable=false
log.cleaner.threads=2 (컴팩션 토픽 많으면)
JVM 힙 6GB, 나머지는 페이지 캐시 — 브로커 전용 노드
디스크: XFS, 데이터 디렉터리 여러 개(log.dirs), SSD 또는 많은 HDD
```

**프로듀서** (처리량 vs 지연)
```
acks=all, enable.idempotence=true
linger.ms=5~20 (모아 보내기), batch.size=64KB~256KB, compression.type=lz4|zstd
buffer.memory=64MB, max.in.flight.requests.per.connection=5
delivery.timeout.ms=120000 (재시도 총 상한)
```

**컨슈머**
```
fetch.min.bytes=1MB, fetch.max.wait.ms=500      # 배치 소비
max.poll.records=500, max.poll.interval.ms=300000 (처리 시간에 맞게)
session.timeout.ms=45000, heartbeat.interval.ms=15000
partition.assignment.strategy=CooperativeStickyAssignor
auto.offset.reset=earliest|latest (새 그룹의 시작 위치 — 명시!)
```

## 리밸런스 줄이기

리밸런스마다 그룹이 멈춘다. 원인과 대책:
- 배포 시 인스턴스 동시 재시작 → **순차 배포**, `group.instance.id`(static membership) 로 재시작 중 탈락 방지(`session.timeout.ms` 안에 돌아오면 리밸런스 없음).
- 처리가 길어 `max.poll.interval.ms` 초과 → 레코드 수 줄이기, 처리 비동기화, 간격 늘리기.
- GC 멈춤으로 하트비트 누락 → JVM 튜닝, `session.timeout.ms` 여유.
- CooperativeSticky 로 **바뀌는 파티션만** 이동(incremental rebalance).
- kafkajs: `sessionTimeout`, `heartbeatInterval`, `rebalanceTimeout`, 그리고 `eachBatch` 에서 `heartbeat()` 호출.

## 모니터링

| 메트릭 (JMX / kafka_exporter) | 의미 | 알림 |
|---|---|---|
| `UnderReplicatedPartitions` | ISR 이 복제 계수보다 작은 파티션 | > 0 지속 → 브로커/디스크 문제 |
| `OfflinePartitionsCount` | 리더 없는 파티션 | > 0 → 즉시 |
| `ActiveControllerCount` | 컨트롤러 수 | 합이 1 이 아니면 |
| **컨슈머 LAG** (`kafka_consumergroup_lag`) | 그룹별 밀린 양 | 증가 추세 |
| `RequestQueueTimeMs`, `TotalTimeMs` (Produce/Fetch) | 브로커 요청 지연 p99 | SLO 기준 |
| `BytesInPerSec` / `BytesOutPerSec` | 처리량 | 용량 계획 |
| `LogFlushRateAndTimeMs` | 디스크 flush | 디스크 포화 |
| 디스크 사용률, 네트워크, 페이지 캐시 히트 | OS | |

```bash
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --all-groups     # LAG 즉시 확인
# Prometheus: kafka_exporter (LAG) + JMX exporter (브로커 내부) → Grafana "Kafka Overview" 대시보드
```
[관측성 노트](/observability/notes/03-instrumentation-exporters) 의 exporter 패턴. KEDA 는 이 LAG 으로 소비자를 스케일한다 ([k8s 노트 14](/kubernetes/notes/14-scheduling-autoscaling-deep)).

## 보안

- **전송 암호화**: `listeners=SSL://` + keystore/truststore. zero-copy 가 깨져 CPU ↑.
- **인증 SASL**: PLAIN(테스트), SCRAM-SHA-512(비밀번호), OAUTHBEARER(토큰), GSSAPI(Kerberos). mTLS 도 가능.
- **인가 ACL**: `kafka-acls.sh --add --allow-principal User:app --operation Read --topic orders --group app-workers`. 기본은 `allow.everyone.if.no.acl.found=false` 로 거부.
- 네트워크: 브로커는 내부망만, 클라이언트는 전용 리스너. 쿼터(`producer_byte_rate`)로 테넌트 격리.

## 용량 계획

```
일 데이터 = 메시지/초 × 평균 크기 × 86400
디스크 = 일 데이터 × 보존일 × 복제 계수 × (1 + 여유 30%)
예: 5,000 msg/s × 1KB = 430GB/일 × 7일 × 3 = 9TB (+30% ≈ 12TB)
네트워크 = 생산 + 생산 × (복제 계수 − 1) + 소비 × 소비자 그룹 수
```
- **티어드 스토리지**(Kafka 3.6+): 오래된 세그먼트를 S3 로 내리고 브로커 디스크는 핫 데이터만. 보존을 길게 가져가도 비용이 낮다.
- 브로커 추가 후 파티션 재배치(`kafka-reassign-partitions.sh`) — 네트워크 부하, 쓰로틀 설정.

## 업그레이드·재해 복구

- 롤링 업그레이드: 브로커 하나씩, `inter.broker.protocol.version` 단계적 상향. KRaft 는 `kafka-features.sh`.
- **MirrorMaker 2**: Connect 기반으로 클러스터 간 토픽·오프셋·ACL 복제 (액티브-패시브 DR, 리전 간). 소비자 오프셋 변환 지원.
- 백업은 "토픽 복제" 다 — 스냅샷 개념이 없다. 중요 데이터의 원천은 DB 에 두고 Kafka 는 재생 가능한 파이프라인으로.

## 흔한 장애

| 증상 | 원인 | 대응 |
|---|---|---|
| LAG 폭증 | 소비자 느림/죽음, 리밸런스 루프 | 소비자 로그, `max.poll.interval`, 스케일 |
| NotEnoughReplicas | ISR < min.insync | 브로커/디스크 복구, 임시로 min.insync 조정(내구성 트레이드오프) |
| 디스크 꽉 참 | 보존 과다, 컴팩션 지연 | 보존 단축, 티어드 스토리지 |
| 프로듀서 TimeoutException | 브로커 과부하, 네트워크, buffer 가득 | 배치/압축, 브로커 추가 |
| 메시지 순서 뒤섞임 | in-flight > 1 + 재시도, 멱등성 off | enable.idempotence |
| 컨슈머가 중복 처리 | 커밋 전 크래시 | 멱등 소비자 ([전달 보장](/kafka/notes/04-delivery-guarantees)) |

> 이어서 읽기: [메시징 운영과 관측 — 큐 깊이, 소비 지연, 재전달률로 장애를 먼저 본다](/messaging/notes/07-operations-observability) — 브로커 공통 운영 지표(가장 오래된 메시지 나이) · [데이터·관측 비용 — 볼륨 × 보존 × 카디널리티](/finops/notes/04-data-observability-cost) — 보존 기간과 저장 비용

## 실습 체크리스트

- [ ] kafkajs 프로듀서에서 `linger.ms`(kafkajs 는 배치 API 로) 와 압축 유무로 처리량 비교 스크립트
- [ ] 소비자 2개를 `group.instance.id` 로 static membership 설정 후 하나를 재시작해 리밸런스가 안 일어나는지 (`--describe` 로 확인)
- [ ] kafka_exporter 를 compose 에 추가하고 Grafana 에서 LAG 그래프 그리기
- [ ] 파티션 수 공식으로 가상의 서비스 산정, 보존 7일 디스크 계산
