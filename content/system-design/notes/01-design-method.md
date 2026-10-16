---
title: "설계 방법 — 요구사항, 부하 추정, API, 데이터 모델, 확장, 병목, 장애"
order: 1
level: 기초
summary: "시스템 디자인 문제를 푸는 일곱 단계: 기능·비기능 요구사항 확정, 봉투 뒷면 계산(QPS·저장량·대역폭·메모리), API 와 데이터 모델, 고수준 그림, 병목과 확장, 장애 시나리오, 트레이드오프 정리. 외워 둘 숫자표와, 이 사이트의 실험으로 각 부품을 '증명' 하는 방법"
tags: [시스템 디자인, 부하 추정, 요구사항, 트레이드오프, 면접, 용량 계획]
experiments: [sd-url-shortener, sd-feed-fanout, sd-autocomplete]
---

## 일곱 단계

| 단계 | 질문 | 산출물 |
|---|---|---|
| 1. 요구사항 | 무엇을 해야 하나(기능)? 얼마나 잘(비기능: 지연·가용성·일관성)? 무엇은 안 하나? | 기능 3~5개, 비기능 숫자 |
| 2. 부하 추정 | 사용자·QPS·읽기:쓰기 비율·저장량·대역폭 | 숫자표 |
| 3. API | 핵심 엔드포인트, 멱등·페이지네이션 | 3~5개 시그니처 |
| 4. 데이터 모델 | 엔티티, 접근 패턴, 저장소 선택 | 스키마·키 설계 |
| 5. 고수준 설계 | 요청 경로 그림 | 박스와 화살표 |
| 6. 심화·확장 | 병목 찾기, 캐시·샤딩·비동기 | 수정된 그림 |
| 7. 장애·운영 | 무엇이 죽으면? 관측·알림 | 장애 표 |

> 순서를 지키는 이유: 숫자 없이 "Kafka 와 Redis 를 쓰겠습니다" 로 시작하면, 초당 10건짜리 시스템에 분산 시스템을 설계하게 된다. **요구사항과 숫자가 설계를 고른다.**

## 1. 요구사항 — 묻고 좁힌다

- **기능**: "URL 을 줄인다, 줄인 URL 로 가면 원래 주소로 보낸다, (선택) 통계를 본다."
- **비기능**: 리다이렉트 p99 < 50ms, 가용성 99.99%, 코드는 추측하기 어렵게, 링크는 10년 보관.
- **범위 밖**: 사용자 계정, 커스텀 도메인 — 명시적으로 뺀다.
- **비기능을 SLO 로**: "빠르게" 가 아니라 숫자로. SLO 설계는 [SRE 노트 02](/sre/notes/02-sli-slo-error-budget).

## 2. 봉투 뒷면 계산

외워 둘 숫자:

| 항목 | 값 |
|---|---|
| 하루 | 86,400초 ≈ 10⁵초 |
| 한 달 | ≈ 2.6 × 10⁶초 |
| 메모리 참조 / SSD 임의 읽기 / 같은 리전 왕복 / 대륙 간 왕복 | 100ns / 100µs / 0.5ms / 150ms |
| 1Gbps | ≈ 125MB/s |
| Redis 한 인스턴스 | 단순 명령 10만 QPS 수준 |
| PostgreSQL 한 대 | 단순 PK 조회 수만 QPS, 쓰기 수천~1만 TPS (디스크·fsync 의존) |

계산 예 — URL 단축기(하루 신규 1억, 읽기:쓰기 = 100:1):

| 항목 | 계산 | 결과 |
|---|---|---|
| 쓰기 QPS | 10⁸ / 10⁵ | 1,000/s (피크 ×3 → 3,000) |
| 읽기 QPS | × 100 | 100,000/s (피크 300,000) |
| 10년 레코드 | 10⁸ × 365 × 10 | 3.65 × 10¹¹ 개 |
| 저장량 | × 500B | ≈ 180TB |
| 코드 길이 | 62⁶ = 5.7×10¹⁰, 62⁷ = 3.5×10¹² | **7자** |
| 캐시 | 인기 20% × 하루 읽기분 | 수십 GB |

숫자가 결정을 바꾼다. 읽기 30만 QPS 는 DB 한 대로 안 된다 → 캐시가 필수. 180TB 는 한 대에 안 들어간다 → 샤딩 또는 키-값 저장소. 지연 숫자 감각은 [성능 노트 01](/performance/notes/01-language-of-performance), 용량 계획은 [성능 노트 07](/performance/notes/07-capacity-planning).

## 3. API

```http
POST /v1/links            { "url": "https://…", "idempotency_key": "…" }  → 201 { "code": "aZ3kP9x" }
GET  /{code}              → 301/302 Location: https://…
GET  /v1/links/{code}/stats?from=…&to=…
```

- 쓰기에는 **멱등 키** — 클라이언트 재시도로 링크가 두 개 생기지 않게([API 설계 노트 04](/api-design/notes/04-errors-retries-deadlines), 실험 [api-idempotency-key](/api-design/lab/api-idempotency-key)).
- 301(영구)은 브라우저가 캐시해 통계가 빠진다, 302 는 매번 서버를 거친다 — 요구사항(통계)에 따라 고른다.

## 4. 데이터 모델 — 접근 패턴부터

| 접근 패턴 | 빈도 | 키 |
|---|---|---|
| code → url | 매우 잦음 | code (기본 키) |
| url → code (중복 단축 방지) | 가끔 | url 해시 인덱스 |
| code 별 일 클릭 수 | 대시보드 | (code, day) |

저장소 선택은 접근 패턴이 결정한다. 키 하나로 찾는 대량 데이터는 키-값 저장소(DynamoDB, Cassandra) 또는 샤딩된 RDB, 집계는 OLAP([ClickHouse](/clickhouse/notes/01-olap-columnar)).

## 5~6. 그림을 그리고 병목을 찾는다

```
클라이언트 ─▶ CDN/엣지 ─▶ LB ─▶ API 서버(무상태) ─▶ Redis 캐시 ─(미스)─▶ DB 샤드
                                        └──▶ 클릭 이벤트 ─▶ Kafka ─▶ 집계(ClickHouse)
```

병목 찾기 질문:

- 가장 많이 호출되는 경로는? → 그 경로의 모든 홉을 줄인다(캐시·CDN).
- 하나뿐인 것은? (카운터, 리더, 단일 DB) → 단일 장애점·경합점.
- 커지는 것은? (테이블, 큐, 팔로워 수) → 샤딩·분할·TTL.
- 쏠리는 것은? (인기 키, 셀럽) → 핫 키 대책 ([Redis 노트 19](/redis/notes/19-performance-tuning)).

## 7. 장애 시나리오

| 무엇이 죽으면 | 영향 | 대책 |
|---|---|---|
| 캐시 전체 | DB 에 30만 QPS 직격 | 다층 캐시, 요청 병합, 부하 차단 ([Redis 노트 08](/redis/notes/08-caching-patterns)) |
| DB 샤드 하나 | 그 샤드 링크만 실패 | 복제·자동 전환 |
| 한 리전 | 전체 | 다중 리전, DNS 전환 |
| 의존 서비스 지연 | 스레드 고갈 | 타임아웃·서킷 브레이커 ([장애 실험실 노트 03](/chaos/notes/03-resilience-patterns-verified)) |

## 트레이드오프를 말로

좋은 설계 답변은 "A 를 골랐고, 대가는 B 이며, C 가 바뀌면 D 로 간다" 의 연속이다.

- "코드는 카운터로 만든다. 충돌이 없고 짧다. 대가는 예측 가능성과 카운터 단일점이다. 그래서 카운터를 범위로 나눠 서버마다 블록을 할당하고, 코드를 섞는 순열을 건다."
- 실측 근거: [sd-url-shortener](/system-design/lab/sd-url-shortener) 에서 5만 개 해시 코드를 4자로 자르면 충돌 84개(기대 84.6), 5자면 2개, 6자면 0개였다.

## 이 주제의 사례들

각 사례는 같은 일곱 단계로 풀고, 핵심 부품을 실험으로 확인한다.

| 사례 | 핵심 결정 | 실험 |
|---|---|---|
| [URL 단축기](/system-design/notes/02-url-shortener) | 코드 생성(카운터·해시·순열), 읽기 캐시 | sd-url-shortener |
| [분산 레이트리미터](/system-design/notes/03-rate-limiter) | 알고리즘, 원자성, 장애 시 정책 | rate-limiter, test-property-ratelimit |
| [뉴스피드](/system-design/notes/04-news-feed) | fan-out on write vs read, 셀럽 | sd-feed-fanout |
| [채팅·알림](/system-design/notes/05-chat-notifications) | 연결, 순서, 전달 보장 | streams, pubsub |
| [결제·주문](/system-design/notes/06-payments-orders) | 멱등, 원장, 사가, 외부 PG | api-idempotency-key, es-optimistic-concurrency |
| [검색 자동완성](/system-design/notes/07-search-autocomplete) | 트라이 vs 사전순 인덱스, 캐시 | sd-autocomplete |

공통으로 반복되는 패턴이 보일 것이다: **읽기 경로는 미리 만들어 두고(캐시·타임라인·트라이), 쓰기 경로는 멱등하고 비동기로.**

## 예시로 보기 — 이 프로젝트에서

이 사이트에는 설계 부품을 "증명" 하는 실험이 이미 많다. 사례 노트마다 해당 실험을 연결한다.

| 부품 | 증거 실험 |
|---|---|
| 캐시 어사이드·스탬피드 | [cache-aside](/redis/lab/cache-aside), [cache-stampede](/redis/lab/cache-stampede) |
| 레이트리미터 | [rate-limiter](/redis/lab/rate-limiter), [test-property-ratelimit](/testing/lab/test-property-ratelimit) |
| 분산 락·펜싱 | [distributed-lock](/redis/lab/distributed-lock), [ds-fencing-token](/distributed-systems/lab/ds-fencing-token) |
| 큐·재시도 | [mq-rabbit-dlx-retry](/messaging/lab/mq-rabbit-dlx-retry), [chaos-retry-storm](/chaos/lab/chaos-retry-storm) |
| 이벤트 발행 | [cdc-outbox-debezium](/kafka/lab/cdc-outbox-debezium) |
| 부하 테스트 | [perf-k6-arrival-rate](/performance/lab/perf-k6-arrival-rate) |
| 사례 전용 | [sd-url-shortener](/system-design/lab/sd-url-shortener), [sd-feed-fanout](/system-design/lab/sd-feed-fanout), [sd-autocomplete](/system-design/lab/sd-autocomplete) |

## 실습 체크리스트

- [ ] 하루 활성 사용자 1,000만인 채팅 서비스의 메시지 QPS·저장량을 봉투 뒷면 계산하기
- [ ] 위 숫자표 없이 지연 숫자 다섯 개를 외워 적어 보기
- [ ] 아무 서비스나 골라 일곱 단계를 15분 안에 채워 보기
- [ ] 장애 표에 "캐시 전체 장애" 를 넣고 대책을 실험(cache-stampede)으로 확인하기
