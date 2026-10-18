---
title: 설계 사례 — URL 단축기, 피드, 채팅, 좌석 예약, 결제
order: 6
level: 심화
summary: 전형적 시스템 설계 문제 다섯 개를 요구사항 → 핵심 결정 → 구성요소 → 실패 처리 → 확장 순서로 푼다. 각 사례가 이 사이트의 어느 노트·실험과 연결되는지 표시
tags: [시스템설계, URL단축기, 피드, 채팅, 예약, 결제, 사례]
experiments: []
---

## 푸는 순서 (면접이든 실무든)

1. 요구사항과 숫자 (읽기/쓰기 비율, 피크, 지연, 일관성)
2. 핵심 결정 2~3개 (어디가 어려운가)
3. 구성요소와 데이터 흐름
4. 실패와 엣지 (중복, 순서, 장애)
5. 확장 순서와 비용

## 사례 1: URL 단축기

**숫자**: 쓰기 100/s, 읽기 10,000/s (100:1), 리다이렉트 p99 < 50ms, 키 7자.

**핵심 결정**
- 키 생성: 카운터 + base62 (Redis `INCR` 로 전역 카운터, 샤드별 범위 할당) vs 해시(충돌 처리 필요) vs 미리 생성한 키 풀. → 카운터 범위 할당이 단순하고 빠르다.
- 읽기 경로: Redis 캐시(히트율 99%+, 인기 URL 편중) → DB.
- 301(영구, 브라우저 캐시, 분석 불가) vs 302(매번 서버 경유, 클릭 분석 가능).

**구성**: LB → 앱(무상태) → Redis(`short → long`, TTL 없음 또는 LFU 축출) → PostgreSQL(`urls(short PK, long, owner, created, expires)`). 클릭 이벤트는 Kafka 로 비동기 집계.

**실패**: 카운터 노드 장애 → 범위를 미리 받아 둔 앱은 계속 발급. 캐시 miss 폭주 → stampede 락. 악성 URL → 생성 시 검사 + 신고.

관련: [Redis 자료구조](/redis/notes/02-data-types), [캐싱 패턴](/redis/notes/08-caching-patterns), [레이트 리미팅](/redis/notes/10-rate-limiting).

## 사례 2: 뉴스피드

**숫자**: 사용자 1천만, 일 게시 1백만, 피드 조회 50,000/s, 팔로워 분포는 롱테일(유명인 100만+).

**핵심 결정**
- **Fan-out on write**(게시 시 팔로워 타임라인에 push) vs **on read**(조회 시 팔로잉 글 병합). → 혼합: 일반 사용자는 write, 유명인은 read 로 병합.
- 타임라인 저장: Redis List(사용자당 최근 500개 ID, LTRIM) — 메모리 1천만 × 500 × 8B ≈ 40GB → 활성 사용자만 유지, 비활성은 재구축.
- 랭킹: 시간순 vs 점수(관심도) — 점수는 ZSET.

**구성**: 게시 → PostgreSQL → Kafka post.created → fan-out 워커(팔로워 목록 조회 → Redis LPUSH 파이프라인) / 조회 → Redis LRANGE → ID 로 게시글 캐시(Hash) hydrate → 유명인 글 병합.

**실패**: fan-out 지연(이벤트 LAG) → 최종 일관성 허용. 삭제 전파 → 조회 시 삭제 플래그 확인. 핫 유명인 → 별도 큐.

관련: [List/ZSet 실험](/redis/lab/list-queue), [Kafka 컨슈머 그룹](/kafka/lab/kafka-consumer-groups), [CQRS 노트](/architecture/notes/05-data-modeling-cqrs-event-sourcing).

## 사례 3: 실시간 채팅

**숫자**: 동시 접속 100만, 메시지 10만/s, 전달 지연 < 200ms, 메시지 영구 보관.

**핵심 결정**
- 연결: WebSocket. 서버 한 대가 5~10만 연결 → 게이트웨이 10~20대. 연결은 **상태**이므로 "사용자 → 어느 게이트웨이" 매핑이 필요(Redis).
- 전달: 메시지를 받은 게이트웨이가 수신자의 게이트웨이로 전달 — Redis Pub/Sub(방 단위 채널) 또는 Kafka(내구성). → 실시간은 Pub/Sub, 저장은 Kafka → 메시지 DB(Cassandra/ScyllaDB, 파티션 키 = 방 ID, 클러스터링 = 시간).
- 순서: 방 단위 순서 보장(파티션 키 = 방 ID). 전역 순서 없음.
- 오프라인: 미전달 메시지는 DB 에서 재접속 시 동기화(마지막 수신 ID 기준). 푸시 알림은 별도.

**실패**: 게이트웨이 다운 → 클라이언트 재연결 + 재동기화(멱등 메시지 ID). Pub/Sub 유실 → DB 가 원천이라 재동기화로 복구. 핫 방(10만 명) → 방 샤딩 또는 fan-out 워커.

관련: [Pub/Sub 실험](/redis/lab/pubsub), [Stream 실험](/redis/lab/streams), [Nginx WebSocket](/nginx/notes/02-reverse-proxy-lb), [소켓 노트](/linux-network/notes/02-ip-ports-sockets).

## 사례 4: 좌석 예약 (티켓팅)

**숫자**: 오픈 순간 100만 요청/분, 좌석 1만 개, 이중 판매 0, 결제 10분 내 미완료 시 해제.

**핵심 결정**
- 대기열: 오픈 순간 폭주를 **대기열(Redis ZSET, score=입장 시각)** 로 흡수하고 초당 N 명만 입장(토큰 발급).
- 좌석 선점: `SET seat:{id} user NX PX 600000` 또는 Lua 로 "비어 있으면 선점" — 원자적. 선점 TTL 로 자동 해제.
- 확정: 결제 성공 시 DB 트랜잭션으로 영구 기록 + Redis 상태 갱신. DB 가 원천, Redis 는 빠른 경로.
- 멱등: 결제 콜백 중복(PG 재시도) → 주문 ID 멱등.

**구성**: 대기열 서비스(Redis) → 예약 API(Redis 선점 + 토큰 검증) → 결제 → 확정 워커(PostgreSQL, SKIP LOCKED 큐) → 만료 워커(keyspace 알림 또는 ZSET 스캔).

**실패**: Redis failover 로 선점 유실 → 확정 전 DB 재확인, AOF everysec + 짧은 TTL 로 피해 최소화. 결제 성공했는데 확정 실패 → Saga 보상(환불) 또는 재시도 큐. 봇 → 레이트 리밋·캡차.

관련: [분산 락 실험](/redis/lab/distributed-lock), [Lua 실험](/redis/lab/lua-atomic), [keyspace 알림](/redis/lab/keyspace-notifications), [PG 행 잠금](/postgres/lab/pg-row-locks), [비동기·Saga](/architecture/notes/03-async-messaging-consistency).

## 사례 5: 결제

**숫자**: 1,000 TPS, 정확성 최우선(이중 청구 0, 유실 0), 외부 PG 지연 수 초, 감사 7년.

**핵심 결정**
- **멱등 키** 필수: 클라이언트 요청 ID → 서버가 중복 요청에 같은 응답.
- 원장(ledger)은 **불변 추가 전용**(이벤트 소싱 적합): 모든 금액 이동이 차변/대변 쌍. 잔액은 집계 + 스냅샷.
- 외부 PG 호출: 타임아웃 후 상태 불명 → **조회 API 로 확인**(reconcile), 재시도는 같은 멱등 키.
- 강한 일관성: PostgreSQL 단일 리더, 동기 복제, SERIALIZABLE 또는 행 잠금으로 잔액 갱신. 샤딩은 계좌 ID 기준(한 계좌의 모든 거래가 한 샤드).
- 비동기: 영수증·알림·정산·사기 탐지는 이벤트(outbox).

**구성**: API(멱등 키 Redis NX + DB) → 결제 서비스(상태 머신: REQUESTED → AUTHORIZED → CAPTURED / FAILED) → PG 어댑터(타임아웃·서킷브레이커) → 원장 DB → outbox → Kafka → 하위 서비스. 일일 대사(reconciliation) 배치가 PG 정산 파일과 원장을 대조.

**실패**: 모든 경우에 "모르는 상태" 를 명시적으로 두고 조회로 확정. 부분 실패는 보상(환불). 장애 시 결제 중단(fail-closed)이 잘못된 승인보다 낫다.

관련: [PG 격리 실험](/postgres/lab/pg-transaction-isolation), [데드락 실험](/postgres/lab/pg-deadlock), [복원력 노트](/architecture/notes/04-resilience), [Kafka 전달 보장](/kafka/notes/04-delivery-guarantees).

## 공통으로 등장하는 것

- 원천은 하나(DB), 빠른 경로는 Redis, 비동기는 Kafka, 읽기 모델은 재구축 가능.
- 멱등성은 어디에나.
- 핫스팟(유명인, 인기 좌석, 큰 테넌트)은 항상 따로 처리.
- "모르는 상태" 를 설계에 포함.

## 실전에서는 어디에 쓰이나

> 다섯 사례는 면접 문제이면서 실제 서비스의 축소판이다. 실무에서는 "새 기능의 설계 리뷰" 나 "장애 후 구조 개선" 때 같은 순서(숫자 → 핵심 결정 → 실패)로 푼다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 마케팅 링크·QR 서비스 | 100:1 읽기 편중 리다이렉트를 빠르게 | 카운터 범위 할당 + base62, Redis 캐시, 클릭은 비동기 집계 | 해시 키 — 충돌 처리가 필요하다 |
| SNS·커뮤니티 앱 | 롱테일 팔로워 분포의 피드 | 일반 사용자 fan-out on write, 유명인은 조회 시 병합 | 전부 조회 시 병합 — 읽기 지연이 커진다 |
| 메신저·게임 내 채팅·고객 상담 | 수십만 동시 연결에 저지연 전달 | WebSocket 게이트웨이 + 사용자→게이트웨이 매핑, 저장은 방 ID 파티션 | 폴링 — 지연·부하가 크다 |
| 공연·스포츠 티켓팅, 한정판 판매 | 오픈 순간 폭주와 이중 판매 방지 | 대기열 ZSET + `SET NX PX` 좌석 선점 + DB 확정 | DB 행 잠금만 — 폭주를 버티기 어렵다 |
| 결제·정산 서비스 | 이중 청구·유실 0 | 멱등 키, 추가 전용 원장, "모르는 상태" 를 조회로 확정, 일일 대사 | 동기 승인만 믿기 — 타임아웃 시 상태가 불명확하다 |

**이럴 땐 안 맞는다**
- 사례의 숫자(동시 100만 등)를 그대로 작은 서비스에 적용하는 것 — 규모가 다르면 정답도 다르다. 내 서비스의 숫자를 먼저 채운다.
- 면접식 그림을 그대로 구현하는 것 — 실제로는 팀 역량·기존 인프라·비용이 결정을 바꾼다. 결정과 이유를 ADR 로 남긴다.

**누가 매일 만나나** — 백엔드 개발자는 시스템 설계 면접과 설계 문서 리뷰에서, 테크 리드는 신규 기능의 핫스팟(유명인·인기 좌석·큰 테넌트)을 미리 짚어야 할 때 만난다.

**면접·실무 단골 질문**
- Q. 티켓팅에서 이중 판매를 어떻게 막나 → 원자적 선점(`SET NX PX` 또는 Lua) + DB 확정 시 재확인, 선점 TTL 로 자동 해제.
- Q. 301 과 302 중 무엇을 쓰나 → 301 은 브라우저 캐시로 빠르지만 클릭 분석이 안 된다. 분석이 필요하면 302.

## 실습 체크리스트

- [ ] 사례 하나를 골라 NFR 표 → 구성도 → 실패 표를 직접 작성
- [ ] 좌석 선점을 Redis 콘솔에서 `SET seat:1 me NX PX 10000` 으로 두 번 시도해 보기
- [ ] 대기열을 ZSET 으로 구현해 입장 순서를 확인 (ZADD/ZRANGE/ZPOPMIN)
- [ ] 결제 상태 머신의 모든 전이와 멱등 처리 표 작성
