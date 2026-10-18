---
title: "실전 지도 — 서비스 하나에 각 기술이 어디에 들어가나"
order: 0
level: 중급
summary: "기술을 하나씩 배우면 어디에 쓰는지가 안 보인다. 커머스 선착순 이벤트, 핀테크 결제·정산, 피드·콘텐츠(조회수·추천), AI 상담 챗봇(RAG), 사내 개발자 플랫폼 — 다섯 레퍼런스 서비스의 요청 흐름을 따라가며 지점마다 어떤 기술이 왜 들어가는지(그리고 대안은 무엇인지), 관측성은 각 서비스에서 어떤 신호를 보는지 정리한다. 기술에서 쓰임새로 거꾸로 찾는 색인 표, 회사 규모별로 스택이 자라는 방식, 이 사이트에서 각 서비스의 핵심 실험을 직접 돌려 보는 체크리스트까지"
tags: [시스템 디자인, 아키텍처, 실전, 기술 선택, 관측성, 레퍼런스 아키텍처]
experiments: [rate-limiter, api-idempotency-key, sd-feed-fanout, rag-mini, sre-burn-rate-under-chaos]
prereq: [system-design/01-design-method]
---

## 왜 이 지도가 필요한가

이 사이트에는 Redis, Kafka, PostgreSQL, Kubernetes, 관측성, AI 시스템 같은 주제가 서른 개 넘게 있다. 하나씩 공부하면 각 기술의 **동작**은 알게 되지만, 정작 이런 질문에는 답하기 어렵다.

- "주문 API 를 만든다면 Redis 는 어디에, Kafka 는 어디에 들어가나?"
- "PostgreSQL 이 있는데 왜 OpenSearch 를 또 두나? ClickHouse 는 언제?"
- "결제 서비스와 피드 서비스는 둘 다 Kafka 를 쓰는데, 쓰는 이유가 같은가?"

실무에서 기술은 **요청 흐름의 한 지점**에 들어간다. 그 지점에 어떤 제약(지연·정확성·처리량·비용)이 걸려 있는지가 기술을 고른다. 그래서 이 노트는 기술 목록이 아니라 **서비스 다섯 개의 요청 흐름**을 따라가며, 지점마다 "이 지점 → 이 기술 → 왜(대안은)" 를 적는다. 각 기술은 이 사이트의 해당 노트로 연결해 두었으니, 지도를 보고 필요한 노트로 내려가면 된다.

> 이 노트의 서비스들은 **유형**이다. 특정 회사의 실제 구성이 아니라, 그 유형의 서비스에서 흔히 보이는 구성을 설명용으로 단순화했다. 회사 이름은 공개 자료로 널리 알려진 경우에만 따로 모아 적었다(아래 "공개적으로 알려진 사례").

## 지도를 읽는 법 — 요청 경로의 일곱 지점

![서비스 하나의 요청 경로 — 엣지, 게이트웨이, 앱, 동기 저장소, 비동기 이벤트, 분석·검색, 그리고 모든 상자에 붙는 관측](/diagrams/in-practice-request-map.svg)

어떤 서비스든 요청은 대체로 같은 지점들을 지난다. 서비스마다 다른 것은 **어느 지점이 가장 아픈가**다.

| 지점 | 하는 일 | 대표 기술 | 이 지점의 핵심 제약 |
|---|---|---|---|
| ① 엣지 | 정적 자원 캐시, DDoS·봇 차단 | CDN, WAF | 전 세계 지연, 공격 흡수 |
| ② 게이트웨이 | TLS 종단, 인증, 레이트리밋, 라우팅 | Nginx, API 게이트웨이, 서비스 메시 | 모든 요청이 지나간다 — 여기가 느리면 다 느리다 |
| ③ 앱 서비스 | 비즈니스 규칙 | Java/Spring, Node.js, Kubernetes Pod | 스레드·이벤트 루프·커넥션 풀 |
| ④ 빠른 저장소 | 캐시, 카운터, 락, 세션 | Redis | 잃어도 되는가? 원자성은? |
| ⑤ 진실의 원천 | 주문·원장·사용자 | PostgreSQL (또는 관리형 RDB) | 트랜잭션, 일관성, 백업 |
| ⑥ 이벤트 | 다른 팀·시스템에 "일어난 일" 전달 | Kafka, RabbitMQ, SQS | 유실·중복·순서·지연(lag) |
| ⑦ 읽기 특화 저장소 | 검색, 집계, 의미 검색 | OpenSearch, ClickHouse, 벡터 인덱스 | 원본과의 지연, 재색인 |
| ⊕ 관측 | 모든 지점의 상태 | Prometheus, Loki, Tempo/OTel, SLO 알림 | 카디널리티, 비용, 알림 피로 |

기본 원칙 두 가지만 기억하면 아래 다섯 서비스가 같은 그림의 변주로 보인다.

1. **사용자가 기다리는 경로(동기)는 짧게, 기다리지 않는 일은 이벤트로(비동기)** — [비동기·메시징과 일관성](/architecture/notes/03-async-messaging-consistency).
2. **진실은 한 곳(PostgreSQL), 나머지는 파생(Redis·OpenSearch·ClickHouse)** — 파생 저장소는 날아가도 원본에서 다시 만들 수 있어야 한다. 파생을 만드는 표준 경로가 [아웃박스·CDC](/kafka/notes/08-cdc-outbox-debezium) 다.

---

## 1. 커머스 — 주문과 선착순 이벤트

**상황**: 평소에는 조용하다가, "오전 10시 한정 수량 쿠폰" 같은 이벤트가 열리는 순간 트래픽이 평소의 수십 배로 몰린다. 핵심 요구는 **초과 판매 0건**과 **이벤트 중에도 일반 주문은 살아 있기**다. 설계 방법은 [설계 방법](/system-design/notes/01-design-method)의 일곱 단계를 따른다.

| 단계 | 이 지점 | 기술 | 왜 (대안) |
|---|---|---|---|
| 1 | 상품 페이지·이미지 | CDN + [캐시 계층](/architecture/notes/10-cache-layers-cdn) | 같은 페이지를 수만 명이 본다. 원본까지 오면 안 된다. (대안: 앱 캐시만 — 네트워크 비용·지연이 남는다) |
| 2 | 진입 제어 | [Nginx 레이트리밋](/nginx/notes/03-cache-tls-ratelimit) → [Redis 레이트리밋](/redis/notes/10-rate-limiting) | 사용자·IP 별 초당 요청 상한. 게이트웨이에서 거칠게, 앱에서 정밀하게. ([레이트리미터 사례](/system-design/notes/03-rate-limiter)) |
| 3 | 대기열 | Redis Sorted Set (도착 시각 점수) | "몇 번째로 기다리는 중" 을 보여 주고 일정 속도로만 입장시킨다. (대안: 그냥 받기 — DB 커넥션이 먼저 터진다) |
| 4 | 재고 차감 | Redis `DECR` 또는 [Lua 원자 스크립트](/redis/notes/05-transactions-lua) | 초당 수만 건 차감을 한 줄로 원자적으로. 0 아래로 내려가면 즉시 거절. (대안: [PostgreSQL 행 잠금](/postgres/notes/04-locks-deadlocks) `FOR UPDATE` — 정확하지만 한 행에 직렬화돼 처리량 한계) |
| 5 | 주문 확정 | PostgreSQL 트랜잭션 + [멱등 키](/api-design/notes/04-errors-retries-deadlines) | 주문의 진실은 RDB. 재고는 Redis 에서 "예약", 확정은 DB 에서. 사용자가 버튼을 두 번 눌러도 주문은 하나. |
| 6 | 후속 처리 | [아웃박스 → Kafka](/kafka/notes/08-cdc-outbox-debezium) | 알림·포인트·배송·검색 색인은 주문 응답을 기다리게 하지 않는다. DB 커밋과 이벤트 발행을 아웃박스로 원자적으로 묶는다. (대안: 앱에서 DB 저장 후 Kafka 전송 — 둘 중 하나만 성공하는 이중 쓰기 문제) |
| 7 | 상품 검색 | [OpenSearch + 한국어 분석기](/opensearch/notes/07-korean-and-ranking) | `LIKE '%키워드%'` 는 인덱스를 못 탄다. 형태소 분석·랭킹이 필요하다. |
| 8 | 판매 대시보드 | [ClickHouse](/clickhouse/notes/04-materialized-views-aggregation) | 분 단위 매출·전환율 집계. 주문 DB 에 집계 쿼리를 날리면 이벤트 중 주문이 느려진다. |
| 9 | 확장 | [Kubernetes HPA](/kubernetes/notes/14-scheduling-autoscaling-deep) + 사전 증설 | HPA 는 수십 초~분 단위로 반응한다 — 10시 정각 스파이크는 **미리** 늘려 둔다. |

**관측 — 이 서비스는 무엇을 보나**

| 신호 | 무엇 | 왜 |
|---|---|---|
| 메트릭 | 주문 API p99·에러율, 429 비율, 대기열 길이, 재고 잔량, Redis ops/s, DB 커넥션 풀 사용률 | 429 가 늘면 "보호가 작동 중", 5xx 가 늘면 "보호가 뚫림" — 둘은 다르다 |
| 비즈니스 메트릭 | 초당 주문 성공 수, 쿠폰 발급 수 vs 한정 수량 | **발급 수 > 수량** 이면 즉시 페이지 — 기술 지표가 정상이어도 사고다 |
| 로그 | 주문 ID·멱등 키·사용자 ID 를 담은 구조화 로그 ([Loki](/observability/notes/05-logging-loki)) | 고객 문의 "결제했는데 주문이 없어요" 를 주문 ID 하나로 추적 |
| 트레이스 | 게이트웨이 → 주문 → Redis → DB → Kafka 스팬 ([OTel](/observability/notes/06-tracing-otel)) | 느려졌을 때 어느 상자인지 한 번에 |
| SLO | "주문 요청의 99.9% 가 1초 안에 성공" + [번레이트 알림](/sre/notes/03-burn-rate-alerting) | 이벤트 10분 동안 에러 예산을 얼마나 태웠는지가 판단 기준 |

**흔한 사고**: 캐시 만료 순간 수천 요청이 DB 로 몰리는 [캐시 스탬피드](/redis/notes/08-caching-patterns), 백오프 없는 클라이언트 재시도가 장애를 키우는 [재시도 폭풍](/architecture/notes/04-resilience), Redis 재고와 DB 주문이 어긋나 "판 것보다 주문이 적은" 상태 — 그래서 주기적 대사(비교) 작업이 필요하다.

---

## 2. 핀테크 — 결제와 정산

**상황**: 지연보다 **정확성**이 먼저다. 1원이라도 틀리면 사고이고, 외부 결제사(PG)·은행은 느리고 가끔 "모름"(타임아웃)으로 답한다. 자세한 설계는 [결제·주문 사례](/system-design/notes/06-payments-orders)와 [결제와 원장](/architecture/notes/09-payments-ledger-consistency).

| 단계 | 이 지점 | 기술 | 왜 (대안) |
|---|---|---|---|
| 1 | API 진입 | mTLS·[인증/인가](/security/notes/03-authn-authz), 게이트웨이 | 금융은 서비스 간 통신도 신원을 확인한다 ([메시 mTLS](/service-mesh/notes/03-mtls-identity)) |
| 2 | 중복 방지 | `Idempotency-Key` 헤더 + DB 유니크 제약 | 네트워크 재시도로 같은 결제가 두 번 나가면 안 된다. 키·요청 해시·응답을 저장해 재생한다. (대안: Redis 에만 저장 — 유실되면 중복 결제. 최종 판정은 DB) |
| 3 | 결제 상태 | 상태 머신 (`요청됨 → 승인 대기 → 승인 → 정산`) | 허용되지 않은 전이를 코드가 아니라 DB 조건부 UPDATE 로 막는다 |
| 4 | 돈의 기록 | PostgreSQL 이중 기입 원장 (append-only) | 잔액을 UPDATE 하지 않고 차변·대변 행을 추가한다. 합계는 항상 0. 격리 수준은 [MVCC·격리](/postgres/notes/03-mvcc-isolation) 를 이해하고 고른다. (대안: [이벤트 소싱](/event-sourcing/notes/01-state-vs-facts) — 감사 추적이 자연스럽지만 운영 복잡도가 크다) |
| 5 | 동시 출금 | 낙관적 동시성(버전) 또는 행 잠금 | 같은 계좌에 동시 출금 두 건이 잔액을 음수로 만들지 않게 ([이벤트 소싱 낙관적 동시성](/event-sourcing/notes/03-event-store)) |
| 6 | 외부 PG 호출 | 타임아웃·[서킷 브레이커](/architecture/notes/04-resilience)·"모름" 상태 | 타임아웃은 실패가 아니라 **결과 미상**이다. 재조회·웹훅으로 확정한다. |
| 7 | 여러 단계 묶기 | [사가와 보상](/event-sourcing/notes/07-sagas-operations) | 재고 예약·결제·포인트를 분산 트랜잭션(2PC) 대신 단계별 보상으로. ([분산 트랜잭션](/distributed-systems/notes/06-transactions-coordination)) |
| 8 | 이벤트 | Kafka (아웃박스), 정확히 한 번은 **멱등 소비**로 | [전달 보장](/kafka/notes/04-delivery-guarantees) — 브로커 설정만으로 외부 부작용의 정확히 한 번은 안 된다 |
| 9 | 정산·대사 | 배치 + [데이터 품질 검사](/data-engineering/notes/06-data-quality-lineage-contracts) | 매일 우리 원장 ↔ PG 정산 파일 ↔ 은행 입금을 맞춘다. 어긋난 건은 사람이 본다. |
| 10 | 비밀·키 | [비밀 관리](/security/notes/04-secrets-management), [데이터 저장소 하드닝](/security/notes/07-datastore-hardening) | 카드·계좌 정보는 암호화·접근 감사 대상 |

**관측 — 이 서비스는 무엇을 보나**

| 신호 | 무엇 | 왜 |
|---|---|---|
| 메트릭 | 결제 승인률(PG 별), PG 응답 p99, "모름" 상태 건수와 나이, 멱등 키 재생 횟수 | 승인률이 떨어지면 우리 장애가 아니라 PG 장애일 수 있다 — PG 별로 나눠 본다 |
| 정합성 지표 | 대사 불일치 건수·금액, 원장 차변-대변 합 | **0 이 아니면 경보**. 지연 지표보다 우선한다 |
| 로그 | 결제 ID·멱등 키·PG 거래 ID 를 묶은 감사 로그 (변경 불가 보관) | 분쟁·감사 대응. 카드 번호는 절대 로그에 남기지 않는다(마스킹) |
| 트레이스 | 결제 요청 → PG 호출 → 웹훅 수신까지 하나의 흐름 | 비동기 웹훅은 스팬 링크·결제 ID 로 이어 붙인다 |
| SLO | 가용성 SLO 와 별개로 "정확성 SLO"(대사 불일치 0) | [SLI·SLO·에러 예산](/sre/notes/02-sli-slo-error-budget) — 돈 시스템은 SLI 가 하나가 아니다 |

---

## 3. 피드·콘텐츠 스트리밍 — 조회수와 추천

**상황**: 읽기가 쓰기보다 압도적으로 많고, 조회수·좋아요 같은 **카운터가 초당 엄청나게** 오르며, "정확히 몇 명" 보다 "빠르게 대략" 이 중요한 숫자가 많다. 피드 자체의 설계는 [뉴스피드 사례](/system-design/notes/04-news-feed).

| 단계 | 이 지점 | 기술 | 왜 (대안) |
|---|---|---|---|
| 1 | 영상·이미지 전송 | CDN + 오브젝트 스토리지(S3) | 바이트의 대부분은 미디어다. 앱 서버를 거치면 안 된다. ([로드 밸런싱·CDN](/network-protocols/notes/06-load-balancing-cdn)) |
| 2 | 타임라인 조회 | Redis LIST/ZSET 에 미리 만든 타임라인 | fan-out on write 로 읽기를 O(1) 에 가깝게. 팔로워가 매우 많은 계정만 읽을 때 합치는 하이브리드. ([Redis 데이터 타입](/redis/notes/02-data-types)) |
| 3 | 조회수·좋아요 | Redis `INCR` → 주기적으로 DB 에 합산 반영 | 매 조회마다 DB UPDATE 하면 한 행에 쓰기가 몰린다. 메모리에서 세고 묶어서 내린다. |
| 4 | 순 방문자 수 | [HyperLogLog](/redis/notes/13-probabilistic) | 고유 사용자 수를 키당 12KB 로 근사(표준 오차 약 0.81%). 정확한 집합은 메모리가 사용자 수에 비례해 커진다. |
| 5 | 랭킹·인기글 | Redis Sorted Set | 점수 갱신과 상위 K 조회가 로그 시간 |
| 6 | 시청·클릭 이벤트 | Kafka → [스트림 처리](/data-engineering/notes/05-stream-processing) | 추천 모델의 재료. 여러 소비자(추천·통계·정산)가 같은 로그를 각자 읽는다 ([컨슈머 그룹](/kafka/notes/03-consumer-groups)) |
| 7 | 통계·크리에이터 대시보드 | [ClickHouse](/clickhouse/notes/01-olap-columnar) | 수십억 행 이벤트를 열 단위로 집계. 행 저장 RDB 로는 스캔이 너무 크다 |
| 8 | 추천 후보·검색 | OpenSearch / 벡터 검색 ([하이브리드 검색](/opensearch/notes/05-hybrid-search-rag)) | 키워드(BM25)와 의미(임베딩)를 섞어 후보를 뽑는다 |
| 9 | 장기 보관·학습 데이터 | [레이크하우스(Parquet)](/data-engineering/notes/02-columnar-formats-lakehouse) | 오래된 이벤트는 싼 스토리지에, 모델 재학습·백필용 |

**관측 — 이 서비스는 무엇을 보나**

| 신호 | 무엇 | 왜 |
|---|---|---|
| 메트릭 | 피드 조회 p99, Redis 적중률·메모리, **Kafka 컨슈머 lag**, 팬아웃 워커 처리량 | 피드가 "느린 것"(p99) 과 "늦은 것"(게시 후 보이기까지, lag) 은 다른 사고다 |
| 신선도 | 게시 → 팔로워 피드 도착까지 시간, 조회수 반영 지연 | 사용자는 "내 글이 안 보여요" 로 신고한다 — 지연 메트릭으로는 못 본다 |
| 품질 | 추천 클릭률, 시청 완료율, 빈 피드 비율 | 시스템이 멀쩡해도 추천 모델이 망가질 수 있다 ([모델 관측·드리프트](/mlops/notes/06-model-observability-drift)) |
| 로그 분석 | 접근 로그를 [ClickHouse 로 분석](/clickhouse/notes/05-log-trace-analytics) | 로그 양이 크면 검색형(Loki/OpenSearch)보다 집계형이 싸다 |
| SLO | "피드 조회 99% 가 300ms 안에", "게시물 99% 가 1분 안에 팔로워에게 보임" | 지연 SLO 와 신선도 SLO 를 따로 둔다 |

---

## 4. AI 상담 챗봇 / RAG 서비스

**상황**: 고객 질문에 사내 문서(약관·FAQ·매뉴얼)를 근거로 답한다. 기존 웹 서비스와 다른 점은 **한 요청이 수 초 걸리고, 비용이 토큰 단위로 나가며, 답이 틀려도 HTTP 200** 이라는 것. 전체 구조는 [LLM 애플리케이션 아키텍처](/ai-systems/notes/01-llm-app-architecture).

| 단계 | 이 지점 | 기술 | 왜 (대안) |
|---|---|---|---|
| 1 | 진입 | 게이트웨이 + 사용자별 **토큰** 레이트리밋 | 요청 수가 아니라 토큰 수가 비용이다 ([게이트웨이·레이트리밋](/api-design/notes/06-gateway-auth-ratelimit)) |
| 2 | 입력 가드레일 | 개인정보 마스킹, 프롬프트 인젝션 탐지 | [웹·API·LLM 보안](/security/notes/08-web-api-llm-security) — 사용자 입력과 검색된 문서 모두 신뢰하지 않는다 |
| 3 | 캐시 | 정확 일치 캐시 → [시맨틱 캐시](/ai-systems/notes/05-prompt-cache-cost-latency) (Redis) | 비슷한 질문은 LLM 을 다시 부르지 않는다. 프롬프트 프리픽스 캐시로 긴 시스템 프롬프트 비용도 줄인다. |
| 4 | 문서 검색 | 하이브리드 검색: BM25 + 벡터 → RRF | 제품 코드·약관 조항 번호는 키워드가, 바꿔 말한 질문은 벡터가 잘 찾는다 ([임베딩·벡터 검색](/ai-systems/notes/02-embeddings-vector-search), [pgvector](/postgres/notes/08-jsonb-fulltext-pgvector)) |
| 5 | 컨텍스트 조립 | [RAG 설계](/ai-systems/notes/03-rag-design) — 청킹·재정렬·인용 | 근거 문서를 인용해 답하게 하고, 근거가 없으면 "모른다" 고 답하게 |
| 6 | LLM 호출 | 외부 API 또는 [자체 서빙](/mlops/notes/05-serving-batching-kv-cache) | 스트리밍으로 첫 토큰을 빨리. 429/5xx 는 백오프, 모델 폴백. |
| 7 | 툴 호출 | 주문 조회·환불 접수 같은 [툴](/ai-agents/notes/02-tool-design) | 쓰기 툴(환불)은 [권한·사람 승인](/ai-agents/notes/06-guardrails-permissions-approval) 뒤에. 모델을 믿지 말고 구조를 믿는다. |
| 8 | 대화 메모리 | Redis (세션) + 요약 | 긴 대화 전체를 매번 보내면 토큰이 선형으로 는다 ([메모리](/ai-agents/notes/04-memory-context)) |
| 9 | 문서 색인 파이프라인 | 문서 변경 → 큐 → 청킹·임베딩 워커 → 인덱스 | 약관이 바뀌었는데 옛 문서로 답하면 사고. 색인 나이를 관측한다. |
| 10 | 평가 | 골든셋 + LLM-as-judge, [평가 CI](/mlops/notes/07-eval-ci-prompt-regression) | 프롬프트 한 줄 수정이 품질을 떨어뜨렸는지 배포 전에 안다 |

**관측 — 이 서비스는 무엇을 보나** ([LLM 관측성](/observability/notes/08-llm-observability))

| 신호 | 무엇 | 왜 |
|---|---|---|
| 지연 | TTFT(첫 토큰까지), 전체 응답 시간, 검색 단계 시간 | 사용자가 체감하는 건 TTFT. 전체 시간은 출력 길이에 따라 원래 길다 |
| 비용 | 요청당 입력·출력 토큰, 캐시 적중률, 사용자·기능별 일 비용 | [LLM 토큰 비용](/finops/notes/05-llm-token-cost) — 한 사용자의 무한 루프가 청구서를 만든다 |
| 품질 | 좋아요·싫어요 피드백 비율, "모른다" 비율, 인용 없는 답 비율, judge 점수 샘플링 | HTTP 200 이 성공이 아니다. 품질 신호가 없으면 장애를 사용자 불만으로 안다 |
| 트레이스 | 요청 하나 = 검색 스팬 + LLM 스팬(모델·토큰 속성) + 툴 스팬 | "왜 이 답이 나왔나" 를 재현하려면 어떤 문서 청크가 들어갔는지까지 남긴다 |
| 로그 | 프롬프트·응답 로그 (개인정보 마스킹, 보존 기간 제한) | 디버깅과 평가 데이터의 원천. 동시에 개인정보 위험 — 보존 정책이 필수 |
| 안전 | 가드레일 차단 수, 인젝션 탐지 수, 승인 대기 툴 호출 수 | [에이전트 평가·관측·비용](/ai-agents/notes/07-eval-observability-cost) |

---

## 5. 사내 개발자 플랫폼 — 배포와 관측

**상황**: 사용자가 고객이 아니라 **사내 개발자**다. 목표는 "새 서비스를 하루 안에 운영 환경까지, 관측과 알림이 붙은 채로". 이 사이트 자체가 작은 예시다 ([이 저장소를 IDP 로](/platform-engineering/notes/07-this-repo-as-idp)).

| 단계 | 이 지점 | 기술 | 왜 (대안) |
|---|---|---|---|
| 1 | 서비스 생성 | [골든 패스 템플릿](/platform-engineering/notes/03-golden-paths-templates) + [서비스 카탈로그](/platform-engineering/notes/02-service-catalog-backstage) | 새 서비스가 로그 형식·메트릭·헬스체크·소유자 정보를 처음부터 갖고 태어난다 |
| 2 | 빌드·테스트 | [GitHub Actions](/github-actions/notes/01-workflow-basics) + [Docker 이미지](/docker/notes/03-images-dockerfile) | 캐시·매트릭스로 빠르게, 이미지에 커밋 SHA 태그 |
| 3 | 공급망 보안 | 이미지 스캔·SBOM·서명 ([컨테이너 공급망](/security/notes/05-container-supply-chain)) | 취약한 베이스 이미지가 운영에 들어가기 전에 막는다 |
| 4 | 인프라 | [Terraform](/iac/notes/02-terraform-core-model) + [드리프트 감지](/iac/notes/06-drift-policy-testing) | 콘솔 클릭 대신 코드 리뷰를 거친 변경. 누가 손으로 바꾼 것을 찾아낸다 |
| 5 | 배포 | [GitOps·점진 배포](/kubernetes/notes/13-gitops-progressive-delivery) + [메시 카나리](/service-mesh/notes/06-canary-traffic-split) | 트래픽 1% → 10% → 100%, 각 단계에서 SLO 를 보고 자동 롤백 |
| 6 | 권한 | [Kubernetes 보안](/security/notes/06-kubernetes-security) (RBAC·NetworkPolicy) | 팀은 자기 네임스페이스만. 기본 거부 네트워크 |
| 7 | 관측 기본값 | Prometheus·Loki·Tempo·Grafana ([Kubernetes 관측](/observability/notes/07-kubernetes-observability)) | 플랫폼이 수집기를 깔아 두면 서비스는 표준 형식으로 내보내기만 한다 |
| 8 | 알림·온콜 | [SLO 대시보드·번레이트](/observability/notes/11-slo-dashboard-burn-rate) → [알림 파이프라인](/observability/notes/09-alerting-pipeline) → [런북](/sre/notes/04-oncall-runbooks) | 증상(사용자 영향) 기반 알림만 사람을 깨운다 |
| 9 | 비용 | [Kubernetes 비용 배분](/finops/notes/03-kubernetes-cost) | 팀별 requests 대비 실제 사용량 — 과다 예약이 비용의 주범 |
| 10 | 신뢰성 연습 | [게임데이](/chaos/notes/04-gameday-and-automation), [포스트모템](/sre/notes/05-incident-postmortem) | 장애 대응을 평소에 연습하고, 일어난 장애에서 배운다 |

**관측 — 이 서비스는 무엇을 보나**

| 신호 | 무엇 | 왜 |
|---|---|---|
| 플랫폼 SLO | 배포 파이프라인 성공률·소요 시간, 클러스터 API 가용성 | 플랫폼도 제품이다 ([플랫폼 관측·SLO](/platform-engineering/notes/06-platform-observability-slo)) |
| DORA | 배포 빈도, 리드타임, 변경 실패율, 복구 시간 ([DORA·DevEx](/platform-engineering/notes/05-dora-devex-metrics)) | 플랫폼이 개발 속도를 실제로 올렸는지의 증거 |
| 관측 비용 | 시계열 수·카디널리티, 로그 수집량 ([데이터·관측 비용](/finops/notes/04-data-observability-cost)) | `user_id` 라벨 하나가 시계열을 폭발시킨다 |
| 배포 이벤트 | 배포·설정 변경을 대시보드 주석으로 | 장애의 상당수는 변경 직후다 — "무엇이 바뀌었나" 가 첫 질문 |
| 프로파일 | [연속 프로파일링](/observability/notes/10-continuous-profiling) | CPU·메모리 회귀를 배포 단위로 비교 |

---

## 다섯 서비스를 겹쳐 보면

같은 기술이라도 **서비스마다 맡는 역할이 다르다**. ●는 핵심 역할, ○는 보조 역할.

| 기술 | 커머스 이벤트 | 핀테크 결제 | 피드·콘텐츠 | AI 챗봇 | 개발자 플랫폼 |
|---|---|---|---|---|---|
| Redis | ● 재고 차감·대기열·레이트리밋 | ○ 멱등 키 1차 캐시 | ● 타임라인·카운터·랭킹 | ● 시맨틱 캐시·세션 | ○ |
| PostgreSQL | ● 주문의 진실 | ● 원장 | ○ 메타데이터 | ○ pgvector·대화 기록 | ○ 카탈로그 |
| Kafka | ○ 주문 후속 이벤트 | ● 아웃박스·정산 이벤트 | ● 시청·클릭 로그 | ○ 색인 파이프라인 | ○ 감사 이벤트 |
| OpenSearch | ● 상품 검색 | ○ 거래 내역 검색 | ○ 콘텐츠 검색 | ● 하이브리드 검색 | ○ 로그 검색 |
| ClickHouse | ○ 판매 대시보드 | ○ 정산 분석 | ● 통계·로그 분석 | ○ 토큰 사용 분석 | ○ 관측 백엔드 |
| Kubernetes | ● 사전 증설·HPA | ○ | ○ | ○ GPU 서빙 | ● 플랫폼 그 자체 |
| 관측의 1순위 신호 | 초과 발급 0, 429 vs 5xx | 대사 불일치 0 | 신선도(lag) | 품질·토큰 비용 | DORA·배포 성공률 |

읽는 법: **"Kafka 를 쓴다" 는 같은 말이 결제에서는 "유실되면 안 되는 사실의 기록", 피드에서는 "여러 소비자가 나눠 읽는 대용량 로그"** 를 뜻한다. 그래서 설정(복제 수·acks·보존 기간)도 다르다.

---

## 실전에서는 어디에 쓰이나 — 기술 → 대표 쓰임새 역방향 색인

거꾸로, 기술 이름에서 출발해 "어디에 쓰고 어디엔 쓰지 말아야 하나" 를 찾는 표.

| 기술 | 가장 흔한 쓰임 | 쓰지 말아야 할 곳 | 이 사이트 노트 |
|---|---|---|---|
| Redis | 캐시, 세션, 레이트리밋, 카운터, 랭킹, 분산 락 | 유일한 원본 저장소(돈·주문), 메모리보다 큰 데이터 | [캐싱 패턴](/redis/notes/08-caching-patterns), [설계 레시피](/redis/notes/18-design-recipes) |
| PostgreSQL | 트랜잭션이 필요한 원본 데이터, 대부분의 서비스의 첫 DB | 수십억 행 분석 집계, 초당 수십만 건 단일 카운터 | [개요](/postgres/notes/01-postgres-overview), [파티셔닝·확장](/postgres/notes/06-partitioning-scale) |
| Kafka | 팀 간 이벤트, CDC, 재처리 가능한 로그, 대용량 수집 | 작업 하나하나의 재시도·지연 큐, 소규모 팀의 간단한 작업 큐 | [개요](/kafka/notes/01-kafka-overview), [Kafka 가 아닐 때](/messaging/notes/05-when-not-kafka) |
| RabbitMQ·SQS | 작업 큐, 재시도·DLQ, 지연 메시지 | 오래 보관·재생해야 하는 이벤트 로그 | [RabbitMQ](/messaging/notes/02-rabbitmq), [AWS 메시징](/aws/notes/05-messaging-streaming) |
| OpenSearch | 전문 검색, 로그 검색, 하이브리드(BM25+벡터) | 원본 저장소, 강한 일관성이 필요한 조회 | [역색인](/opensearch/notes/01-inverted-index-analyzers), [로그 분석](/opensearch/notes/04-aggregations-log-analysis) |
| ClickHouse | 이벤트·로그 분석, 실시간 대시보드, 관측 백엔드 | 행 단위 잦은 UPDATE·DELETE, 트랜잭션 | [OLAP·열 저장](/clickhouse/notes/01-olap-columnar) |
| 벡터 인덱스 (pgvector 등) | RAG 문서 검색, 유사 항목 추천 | 정확한 키 조회, 제품 코드·번호 검색(키워드가 낫다) | [임베딩·벡터 검색](/ai-systems/notes/02-embeddings-vector-search) |
| Nginx | 리버스 프록시, TLS 종단, 정적 캐시, 거친 레이트리밋 | 복잡한 비즈니스 규칙, 사용자별 정밀 과금 | [리버스 프록시·LB](/nginx/notes/02-reverse-proxy-lb) |
| Docker | 빌드 산출물 표준화, 로컬 개발 환경 | "VM 처럼" 상태를 안에 쌓아 두기 | [개요](/docker/notes/01-docker-overview) |
| Kubernetes | 여러 서비스의 배포·자가 치유·확장 | 서비스 한두 개뿐인 초기 팀(운영 비용이 이득보다 크다) | [개요](/kubernetes/notes/01-kubernetes-overview) |
| 서비스 메시 | mTLS 기본값, 카나리 트래픽 분할, 서비스 간 관측 | 서비스가 몇 개 안 될 때 | [메시가 푸는 문제](/service-mesh/notes/01-what-mesh-solves) |
| Terraform | 클라우드·클러스터 인프라의 코드화와 리뷰 | 앱 배포마다 바뀌는 값(GitOps 영역) | [왜 IaC](/iac/notes/01-why-iac) |
| GitHub Actions | 빌드·테스트·배포 파이프라인 | 오래 도는 운영 작업·스케줄러 대용 | [워크플로 기초](/github-actions/notes/01-workflow-basics) |
| Prometheus | 수치 메트릭, 알림, SLO 계산 | 사용자 ID·요청 ID 같은 고카디널리티 라벨, 로그 대용 | [PromQL](/observability/notes/02-prometheus-promql) |
| Loki | 라벨로 좁혀서 보는 로그 | 전문 검색 위주 분석(OpenSearch 가 낫다) | [로깅·Loki](/observability/notes/05-logging-loki) |
| OpenTelemetry | 서비스 간 트레이스, 표준 계측 | 모든 요청 100% 저장(샘플링 필요) | [트레이싱·OTel](/observability/notes/06-tracing-otel) |
| SLO·번레이트 | 사람을 깨울지 결정, 배포 속도 조절 | 내부 리소스 지표(CPU)에 SLO 걸기 | [번레이트 알림](/sre/notes/03-burn-rate-alerting) |
| Java (Spring) | 트랜잭션 많은 업무 시스템, 대규모 팀의 백엔드 | 아주 작은 함수형 작업(기동 시간·메모리) | [Spring 웹·데이터·트랜잭션](/java/notes/23-spring-web-data-tx) |
| Node.js | I/O 위주 API, BFF, 실시간 연결 | CPU 무거운 계산(이벤트 루프를 막는다) | [아키텍처](/nodejs/notes/01-architecture-v8-libuv) |
| LLM + RAG | 문서 근거 질의응답, 요약, 분류 | 정확한 계산·결정적 규칙(코드가 낫다), 근거 없는 사실 답변 | [RAG 설계](/ai-systems/notes/03-rag-design) |
| AI 에이전트 | 여러 툴을 조합하는 다단계 작업 | 순서가 고정된 작업(워크플로가 싸고 예측 가능) | [에이전트란](/ai-agents/notes/01-what-is-an-agent) |
| AWS 관리형 서비스 | 운영 인력이 적을 때 DB·큐·스토리지 | 이식성이 최우선인 핵심 부품(종속 비용을 계산하고) | [컴퓨트·컨테이너](/aws/notes/03-compute-containers), [데이터 저장소](/aws/notes/04-data-stores) |

> 표의 "쓰지 말아야 할 곳" 은 절대 금지가 아니라 **더 나은 선택지가 흔한 곳**이다. 이유와 대안이 설명될 때만 예외를 둔다.

---

## 회사 규모별로 스택이 어떻게 달라지나

![스타트업 → 성장기 → 대규모로 갈수록 상자가 늘고, 상자를 늘리는 이유가 바뀐다](/diagrams/in-practice-stack-growth.svg)

| 관점 | 스타트업 | 성장기 | 대규모 |
|---|---|---|---|
| 병목 | 개발·운영할 **사람** | 팀끼리 서로 막는 **조직** | 한 장애가 전체를 죽이는 **폭발 반경** |
| 앱 구조 | 모놀리스 하나 | 도메인별 서비스 몇 개 ([설계 원칙](/architecture/notes/01-principles-tradeoffs)) | 수백 개 서비스, 셀·리전 격리 ([운영 아키텍처](/architecture/notes/07-operations-architecture)) |
| 데이터 | 관리형 PostgreSQL 한 대가 거의 다 한다 (검색·큐·JSON 까지) | 읽기 복제, 파티셔닝, Redis 캐시, 검색 분리 | 샤딩, 목적별 저장소, 레이크하우스 |
| 비동기 | DB 테이블 큐(`SKIP LOCKED`)나 Redis | Kafka + 아웃박스로 팀 간 이벤트 | 스트림 처리, 스키마 레지스트리·데이터 계약 |
| 배포 | PaaS 또는 컨테이너 하나 | Kubernetes + GitOps | 내부 개발자 플랫폼, 메시·점진 배포 |
| 관측 | 관리형 SaaS 하나 + 에러 추적 | Prometheus·Loki·Tempo, SLO·온콜 체계 | 자체 관측 백엔드(대용량 집계), 관측 비용 관리 |
| AI | LLM API + pgvector 로 시작 | 평가 골든셋·시맨틱 캐시·비용 대시보드 | 모델 서빙·평가 CI·가드레일 플랫폼 |
| 비용 관점 | 클라우드 크레딧·관리형으로 시간 절약 | 단위 경제(요청당 비용) 측정 시작 ([단위 경제](/finops/notes/02-unit-economics)) | FinOps 조직, 예약·스팟, 팀별 차지백 |

원칙은 하나다: **상자는 "지금 아픈 문제" 가 있을 때만 늘린다.** 상자 하나마다 백업·업그레이드·보안 패치·알림·온콜이 따라온다. 스타트업이 Kafka·Kubernetes·서비스 메시를 처음부터 다 들이면, 제품 대신 인프라를 만들게 된다. 반대로 대규모 조직이 "PostgreSQL 하나로 다 한다" 를 고집하면 한 팀의 무거운 집계 쿼리가 모든 팀의 주문을 느리게 만든다. 용량을 숫자로 판단하는 법은 [용량 계획](/performance/notes/07-capacity-planning).

---

## 공개적으로 알려진 사례

회사 이름은 해당 회사가 직접 공개했거나 오픈소스로 널리 알려진 것만 적는다. 구체적인 규모 수치는 시점마다 달라지므로 적지 않았다 — 원문(각 회사 엔지니어링 블로그·공식 문서)에서 확인하자.

| 사례 | 무엇을 보여 주나 | 관련 노트 |
|---|---|---|
| Kafka 는 LinkedIn 에서 활동 로그·데이터 파이프라인용으로 만들어져 Apache 프로젝트가 되었다 | "이벤트 로그" 라는 쓰임새의 기원 | [Kafka 개요](/kafka/notes/01-kafka-overview) |
| Netflix 의 Chaos Monkey — 운영 환경 인스턴스를 무작위로 종료해 복원력을 검증 | 카오스 엔지니어링의 출발점 | [카오스 원칙](/chaos/notes/01-chaos-principles) |
| Spotify 가 사내 개발자 포털로 만든 Backstage 를 오픈소스로 공개(CNCF 프로젝트) | 서비스 카탈로그·골든 패스 | [서비스 카탈로그·Backstage](/platform-engineering/notes/02-service-catalog-backstage) |
| Google 의 SRE 책 — SLO·에러 예산·toil 개념을 정리해 공개 | SLO 기반 운영 | [SRE 원칙](/sre/notes/01-sre-principles-toil) |
| Stripe API 의 `Idempotency-Key` 헤더 (공식 API 문서) | 결제 API 멱등 키 패턴 | [에러·재시도·데드라인](/api-design/notes/04-errors-retries-deadlines) |
| Cloudflare 가 엔지니어링 블로그에서 HTTP 분석 파이프라인에 ClickHouse 를 쓴다고 공개 | 대용량 이벤트 분석에 열 저장 OLAP | [ClickHouse 로그·트레이스 분석](/clickhouse/notes/05-log-trace-analytics) |

---

## 흔한 실수와 오해

| 실수 | 왜 문제인가 | 대신 |
|---|---|---|
| "유명한 회사가 쓰니까" 기술을 고른다 | 그 회사의 규모·조직 문제를 같이 들여온다 | 지금의 숫자(QPS·데이터량·팀 수)로 고른다 |
| Redis 를 원본 저장소로 쓴다 | 영속성 설정·장애 조치 중 마지막 쓰기를 잃을 수 있다 | 원본은 RDB, Redis 는 재생성 가능한 파생 |
| DB 저장 후 Kafka 전송을 앱에서 순서대로 한다 | 둘 중 하나만 성공하는 이중 쓰기 | 아웃박스 + CDC |
| 관측을 "나중에" 붙인다 | 첫 장애 때 아무것도 안 보인다 | 골든 패스에 메트릭·로그·트레이스 기본값 |
| 모든 서비스에 같은 SLO 신호(가용성·지연)만 건다 | 결제의 정확성, 피드의 신선도, AI 의 품질을 놓친다 | 서비스마다 "사용자가 아픈 순간" 을 SLI 로 |
| LLM 답의 HTTP 200 을 성공으로 센다 | 틀린 답이 정상으로 집계된다 | 품질 신호(피드백·judge·인용률)를 메트릭으로 |

## 스스로 점검

1. 선착순 쿠폰 재고 차감을 PostgreSQL `FOR UPDATE` 대신 Redis 에서 하는 이유와, 그 대가로 추가해야 하는 장치는?
2. 결제 서비스에서 PG 타임아웃은 왜 "실패" 가 아니라 "모름" 인가? 무엇으로 확정하나?
3. 피드 서비스에서 p99 지연이 정상인데 사용자가 "내 글이 안 보여요" 라고 한다. 어떤 신호를 보나?
4. RAG 챗봇의 관측에서 웹 서비스에 없던 신호 세 가지는?
5. 직원 다섯 명 스타트업에 Kafka 를 권하지 않는 이유는? 무엇으로 대신하나?

---

## 예시로 보기 — 이 프로젝트에서

이 사이트를 띄우는 `docker-compose.yml` 자체가 위 지도의 축소판이다.

| 지도의 지점 | 이 저장소에서 |
|---|---|
| 게이트웨이 | `nginx` (레이트리밋·프록시 캐시 실험), `nginx-tls` |
| 앱 | `web` (Next.js) |
| 빠른 저장소 | `redis` — 캐시·벡터 검색·시맨틱 캐시 실험 |
| 진실의 원천 | `postgres` (pgvector 포함) |
| 이벤트 | `kafka` + `connect` (Debezium CDC), `rabbitmq`, `nats` |
| 읽기 특화 | `opensearch`, `clickhouse`, `s3` (레이크하우스 실험) |
| 관측 | `prometheus`·`alertmanager`·`redis-exporter`, `loki`·`alloy`, `tempo`, `grafana` |
| AI 운영 | `mlflow` (실험 추적) |
| 플랫폼 | `k8s/` (ArgoCD·모니터링), `infra/local` (OpenTofu), `.github/workflows` |

## 정리

- 기술은 **요청 흐름의 한 지점**에 들어가고, 그 지점의 제약(지연·정확성·처리량·비용)이 기술을 고른다.
- 기본 골격은 같다: 짧은 동기 경로 + 이벤트 기반 비동기 경로, 진실은 한 곳(RDB) + 나머지는 파생(Redis·OpenSearch·ClickHouse).
- 서비스마다 "가장 아픈 지점" 이 다르다 — 커머스는 순간 동시성, 결제는 정확성, 피드는 읽기량·신선도, AI 는 품질·토큰 비용, 플랫폼은 배포 속도와 기본값.
- 관측의 1순위 신호도 서비스마다 다르다 — 초과 발급 0, 대사 불일치 0, 컨슈머 lag, 품질·비용, DORA.
- 같은 기술도 역할이 다르다(결제의 Kafka ≠ 피드의 Kafka). 그래서 설정도 다르다.
- 상자는 지금 아픈 문제가 있을 때만 늘린다. 규모가 커지면 병목이 사람 → 조직 → 폭발 반경으로 옮겨 간다.

## 실습 체크리스트

각 레퍼런스 서비스의 "가장 아픈 지점" 을 이 사이트 실험으로 직접 확인한다.

**커머스 — 선착순 이벤트**
- [ ] [레이트리미터](/redis/lab/rate-limiter) 로 사용자별 초당 상한을 걸어 보고, [Nginx burst·nodelay](/nginx/lab/nginx-rate-limit-burst) 와 결과를 비교한다
- [ ] [Lua 원자 스크립트](/redis/lab/lua-atomic) 로 "확인 후 차감" 을 한 번에 처리하고, [행 잠금 실험](/postgres/lab/pg-row-locks) 에서 `FOR UPDATE` 가 얼마나 기다리게 하는지 잰다
- [ ] [캐시 스탬피드](/redis/lab/cache-stampede) 로 인기 상품 캐시가 만료될 때 원본에 몰리는 요청을 본다
- [ ] [아웃박스·CDC](/kafka/lab/cdc-outbox-debezium) 로 주문 INSERT 가 Kafka 이벤트가 되는 과정을 확인한다

**핀테크 — 결제·정산**
- [ ] [Idempotency-Key](/api-design/lab/api-idempotency-key) 로 같은 결제를 동시에 10번 보내도 한 번만 처리되는지 본다
- [ ] [낙관적 동시성](/event-sourcing/lab/es-optimistic-concurrency) 으로 동시 출금 20건이 잔액 불변식을 깨지 않는지 확인한다
- [ ] [트랜잭션 격리](/postgres/lab/pg-transaction-isolation) 에서 READ COMMITTED 와 REPEATABLE READ 의 차이를 직접 만든다
- [ ] [데이터 품질 검사](/data-engineering/lab/de-quality-checks) 를 대사 작업처럼 읽어 본다 — 불량 행을 찾는 SQL 이 곧 대사 쿼리의 뼈대다

**피드·콘텐츠**
- [ ] [뉴스피드 팬아웃](/system-design/lab/sd-feed-fanout) 으로 push·pull·하이브리드의 쓰기·읽기 비용을 비교한다
- [ ] [HyperLogLog](/redis/lab/hyperloglog) 로 순 방문자를 근사하고, [ZSET 리더보드](/redis/lab/zset-leaderboard) 로 인기 순위를 만든다
- [ ] [컨슈머 그룹](/kafka/lab/kafka-consumer-groups) 으로 추천·통계 소비자가 같은 이벤트를 각자 받는 것을 확인한다
- [ ] [ClickHouse 로그 분석](/clickhouse/lab/ch-log-analytics) 으로 같은 로그를 Loki 와 ClickHouse 에서 집계해 비교한다

**AI 상담 챗봇 / RAG**
- [ ] [미니 RAG](/ai-systems/lab/rag-mini) 로 청킹 → 검색 → 프롬프트 조립을 따라간다
- [ ] [하이브리드 검색 RRF](/opensearch/lab/search-hybrid-rrf) 와 [pgvector](/postgres/lab/pg-vector-search) 로 키워드·벡터 순위 차이를 본다
- [ ] [시맨틱 캐시](/ai-systems/lab/semantic-cache) 와 [LLM 토큰 비용](/finops/lab/finops-llm-token-cost) 으로 캐시가 비용·지연을 얼마나 바꾸는지 잰다
- [ ] [간접 프롬프트 인젝션](/ai-agents/lab/agent-prompt-injection) 으로 검색 문서 속 지시가 툴을 부르는 위험과 방어를 확인한다
- [ ] [평가 하네스](/mlops/lab/mlops-eval-harness) 로 골든셋 채점과 judge 편향을 본다

**사내 개발자 플랫폼**
- [ ] [롤링 업데이트와 롤백](/kubernetes/lab/k8s-rolling-update), [메시 트래픽 분할](/service-mesh/lab/mesh-traffic-split) 로 점진 배포를 해 본다
- [ ] [장애 중 번레이트](/sre/lab/sre-burn-rate-under-chaos) 와 [알림 파이프라인](/observability/lab/alert-pipeline-redis-down) 으로 장애가 알림이 되기까지를 본다
- [ ] [로그 파이프라인](/observability/lab/loki-log-pipeline) 으로 구조화 로그가 LogQL 로 검색되기까지를 따라간다
- [ ] [IaC 드리프트 감지](/iac/lab/iac-drift-detect) 와 [DORA 지표](/platform-engineering/lab/plat-dora-metrics) 로 플랫폼의 "변경" 을 관측한다
