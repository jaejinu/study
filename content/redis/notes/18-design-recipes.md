---
title: 심화 — 실전 설계 레시피 14가지
order: 18
level: 심화
summary: 세션 저장소, 지연 큐, 중복 제거, 좌석 선점, 활동 피드, 샤딩된 리더보드, 최근 본 상품, 온라인 상태, 카운터 집계, 기능 플래그, 간격 반복 복습 큐, 학습 연속 기록, 캡드 로그, 아웃박스 릴레이 — 각각의 자료구조 선택·키 설계·명령·만료·실패 처리·메모리 추정을 코드와 함께
tags: [설계, 레시피, 세션, 지연큐, 중복제거, 피드, 리더보드, 온라인상태, 카운터]
experiments: [zset-leaderboard, list-queue, distributed-lock, streams, bitmap-dau]
---

각 레시피는 **요구 → 자료구조 → 키·명령 → 함정 → 메모리** 순서다. 숫자는 추정 방법을 보여주기 위한 예.

## 1. 세션 저장소

요구: 웹 서버 N대 공유, 로그인 24h 유지, 강제 로그아웃, 사용자당 세션 목록.
```
HSET sess:{sid} uid 123 ua "…" created 1760000000      EXPIRE sess:{sid} 86400
SADD user:123:sessions {sid}                           # 강제 로그아웃용 역인덱스
# 요청마다: HGETALL sess:{sid} + EXPIRE 갱신(슬라이딩)  — 또는 접근 시각만 HSET
# 전체 로그아웃: SMEMBERS user:123:sessions → DEL 각 세션 → DEL 집합
```
함정: 요청마다 EXPIRE 는 쓰기 부하 — 남은 TTL 이 절반 이하일 때만 갱신. 역인덱스의 죽은 sid 는 로그아웃 시 정리(SREM). 메모리: 세션 300B × 100만 = 300MB.

## 2. 지연 큐 (N초 후 실행)

요구: "30분 뒤 미결제 주문 취소", 재시도 백오프.
```
ZADD delayed <실행시각ms> job:{id}                      # score = 실행 시각
# 워커 루프 (1초마다):
ZRANGEBYSCORE delayed -inf <now> LIMIT 0 100          → 후보
ZREM delayed job:{id}   (반환 1 이면 내가 가져감 — 원자적 claim)   → 실행
# 또는 Lua 로 ZRANGEBYSCORE + ZREM 을 묶어 한 번에 꺼내기
```
함정: 꺼낸 뒤 워커가 죽으면 유실 → "처리 중" ZSET 으로 옮기고(ZADD processing) 완료 시 삭제, 오래된 processing 은 복구. 정밀도는 폴링 주기.

## 3. 중복 제거 / 멱등 키

요구: 같은 웹훅·이벤트를 두 번 처리하지 않기(24h 창).
```
SET idem:{eventId} 1 NX EX 86400     → OK 면 처음, nil 이면 중복
```
결과까지 저장해 중복 요청에 같은 응답: `SET idem:{key} <응답JSON> NX EX …` 후 nil 이면 `GET` 으로 응답 반환. 대규모(수억)면 Bloom 필터(`BF.ADD`) 로 1차 필터 + 정확 저장소. [분산 락 실험](/redis/lab/distributed-lock)과 같은 원리.

## 4. 좌석·재고 선점

요구: 이중 판매 0, 미결제 10분 후 자동 해제, 대기열.
```
# 선점 (원자적)
SET seat:{show}:{no} {uid} NX PX 600000
# 여러 좌석 한 번에: Lua 로 전부 비어 있을 때만 선점 (하나라도 있으면 전부 실패)
# 확정: DB 트랜잭션 성공 후 PERSIST 또는 상태 키 변경; 실패/취소: 토큰 검증 DEL
# 대기열: ZADD queue <now> {uid}  / ZRANK queue {uid} = 내 순서 / ZPOPMIN queue N = 입장
```
함정: Redis 가 원천이 아니다 — 확정은 DB. failover 로 선점이 사라질 수 있으니 확정 전 DB 재확인. 재고 카운트형은 `DECR` 후 음수면 `INCR` 로 복구(또는 Lua).

## 5. 활동 피드 (fan-out on write)

요구: 팔로워 타임라인, 최근 500개, 삭제 반영.
```
# 게시: 팔로워마다 LPUSH feed:{follower} {postId} ; LTRIM feed:{follower} 0 499   (파이프라인)
# 조회: LRANGE feed:{uid} 0 19 → MGET post:{id}… (또는 HGETALL 파이프라인) → 삭제된 글은 건너뜀
# 유명인: 팔로워 10만+ 는 fan-out 하지 않고 조회 시 ZSET(유명인 글 시간순) 과 병합
```
메모리: 활성 사용자 100만 × 500 × ~20B = 10GB → 활성 7일 사용자만 유지하고 나머지는 접속 시 재구축. [List 실험](/redis/lab/list-queue).

## 6. 리더보드 (대규모·샤딩)

요구: 1억 플레이어, 실시간 순위, 상위 100, 내 주변.
```
ZADD lb:{season} score uid ; ZINCRBY
ZREVRANGE lb 0 99 WITHSCORES ; ZREVRANK lb uid ; ZREVRANGE lb rank-5 rank+5
```
1억 멤버 ZSET ≈ 10GB 단일 키 = 핫 키·빅 키. 샤딩: `lb:{season}:{uid % 64}` 로 나누고 상위 100 은 각 샤드 top-100 을 병합. 정확한 전역 순위는 "점수 구간별 카운트" 로 근사(`ZCOUNT` 합산). 동점 처리: score = 점수 × 1e6 + (최대시각 − 달성시각) 으로 먼저 달성한 사람이 위.

## 7. 최근 본 상품

```
ZADD recent:{uid} <now> {productId}      # 같은 상품 다시 보면 시각만 갱신
ZREMRANGEBYRANK recent:{uid} 0 -51        # 50개 유지
EXPIRE recent:{uid} 2592000               # 30일
ZREVRANGE recent:{uid} 0 9
```
List 로 하면 중복 제거가 안 된다(LREM 필요). ZSET 이 맞다.

## 8. 온라인 상태 / 하트비트

```
# 접속 중: 30초마다 SET online:{uid} 1 EX 60      → 존재하면 온라인
# 친구 중 온라인: MGET online:{f1} online:{f2} …   (파이프라인)
# 대규모 집계: SETBIT online:{minuteBucket} uid 1 → BITCOUNT, BITOP OR 로 "최근 5분 접속"
```
`EXISTS` 폭주 대신 Bitmap 집계가 싸다. [Bitmap 실험](/redis/lab/bitmap-dau).

## 9. 카운터 집계 (조회수·좋아요)

```
INCR views:{postId}                             # 실시간
HINCRBY views:hourly:{yyyymmddhh} {postId} 1     # 시간별 집계 (한 해시에 여러 글)
# 배치: 주기적으로 HGETALL → DB 반영 → DEL (write-behind)
```
함정: 같은 사용자 중복 조회 제외는 `PFADD views:uniq:{postId} {uid}` (HLL) 로 근사. 좋아요 토글은 `SADD/SREM likes:{postId}` + `SCARD`. 핫 글은 로컬 캐시 + 주기 반영.

## 10. 기능 플래그 / 설정

```
HSET flags new-checkout enabled 1 percent 10 allow "1,2,3"
# 앱: 10초 로컬 캐시 + HGETALL, 또는 CLIENT TRACKING 으로 변경 푸시
# 변경 알림: PUBLISH flags:changed new-checkout
```
사용자 % 롤아웃: `hash(uid) % 100 < percent`. 플래그는 작고 읽기가 압도적 → 로컬 캐시가 핵심, Redis 는 원천.

## 11. 간격 반복 복습 큐 (이 사이트의 퀴즈)

요구: 카드마다 다음 복습 시각, "지금 복습할 카드" 를 빠르게, 사용자·주제별.

현재 구현(`src/lib/study.ts`): `quiz:stats:<주제>` Hash 에 카드 키 → JSON(`box`, `due` …). 기한 지난 카드를 찾으려면 Hash 를 통째로 읽어 앱에서 거른다 — 카드가 수십 장이라 충분하다.

카드가 수만 장이 되면 ZSet 인덱스를 추가한다.

```
HSET quiz:stats:redis <cardKey> <json>               # 상세 (원본)
ZADD quiz:due:redis <due_ms> <cardKey>               # 인덱스: score = 다음 복습 시각
ZRANGEBYSCORE quiz:due:redis -inf <now> LIMIT 0 20   # 지금 복습할 20장 — O(log N + 20)
ZCOUNT quiz:due:redis -inf <now>                     # 기한 지난 수 (첫 화면 배지)
```

함정: Hash 와 ZSet 두 키를 함께 바꿔야 하므로 Lua 나 MULTI 로 묶는다(같은 주제 = 같은 해시태그 `{quiz:redis}` 로 클러스터 대비). 레시피 2(지연 큐)와 같은 구조다.

## 12. 학습 연속 기록(streak)

```
SETBIT streak:{uid} <dayIndex> 1          # dayIndex = 서비스 시작일로부터 일수
BITPOS streak:{uid} 0 -1 BIT              # (거꾸로) 마지막 0 위치 → 연속 일수 계산
BITCOUNT streak:{uid}                     # 총 학습 일수
```

1년 365비트 = 46바이트. 사용자 100만이면 46MB. 연속 일수 계산은 앱에서 오늘부터 거꾸로 `GETBIT` 하거나 `BITFIELD` 로 8일치를 한 번에 읽는다.

## 13. 최근 N개 로그 (이 사이트의 알림 목록)

```
LPUSH alerts:recent <json>
LTRIM alerts:recent 0 199              # 200개만
LRANGE alerts:recent 0 49              # 최근 50개
```

`src/lib/alerts.ts` 가 이렇게 한다(파이프라인으로 두 명령을 한 번에). 순서만 필요하고 재처리가 필요 없는 **캡드 로그**의 정석. 소비자가 확인(ACK)해야 하는 작업이면 Stream 으로([레시피 비교는 Pub/Sub·Stream 노트](/redis/notes/07-pubsub-streams)).

## 14. 아웃박스 릴레이 큐

요구: DB 커밋과 이벤트 발행을 일치시키되 Kafka 는 없다.

```
# 앱: DB 트랜잭션 안에서 outbox 테이블에 INSERT (Redis 아님!)
# 릴레이 워커: outbox 미발행 행을 읽어 Redis Stream 에 XADD → 행에 published=true
XADD events:order MAXLEN ~ 100000 * type OrderCreated id 42
# 소비자 그룹이 처리, 멱등 키로 중복 흡수
```

원본은 DB, Redis Stream 은 전달 통로다. "DB 와 Redis 에 동시에 쓰기" 는 이중 쓰기 문제를 만든다([Kafka — CDC 와 Outbox](/kafka/notes/08-cdc-outbox-debezium), [아키텍처 — 비동기 메시징과 일관성](/architecture/notes/03-async-messaging-consistency)).

## 레시피를 고르는 표

| 요구 | 레시피 | 핵심 자료구조 |
|---|---|---|
| 공유 세션 | 1 | Hash + TTL + 역인덱스 Set |
| 나중에 실행 | 2, 11 | ZSet(score=시각) |
| 중복 제거 | 3 | String `SET NX EX` |
| 선점·좌석 | 4 | `SET NX PX` + Lua |
| 피드 | 5 | List + LTRIM |
| 순위 | 6 | ZSet(+샤딩) |
| 최근 본 것 | 7 | ZSet(score=시각) |
| 온라인 | 8 | String TTL / Bitmap |
| 카운터 | 9 | String INCR / Hash HINCRBY / HLL |
| 플래그 | 10 | Hash + 로컬 캐시 |
| 연속 기록 | 12 | Bitmap |
| 최근 로그 | 13 | List + LTRIM |
| 이벤트 전달 | 14 | Stream + 컨슈머 그룹 |

## 용량 추정 연습

"일 활성 10만 명, 사용자당 세션 2개(300B), 최근 본 상품 50개, 노트 학습 기록" 이라면:

| 항목 | 계산 | 크기 |
|---|---|---|
| 세션 | 10만 × 2 × (300B + 오버헤드 100B) | 80MB |
| 최근 본 상품 | 10만 × 50 × 25B(listpack) | 125MB |
| 일별 UV(HLL) | 노트 200 × 90일 × 평균 2KB(sparse/dense 혼합) | 36MB |
| 여유(단편화 1.3 + fork COW) | ×2 | ~480MB |

→ maxmemory 512MB, 컨테이너 1GB 가 출발점. 실제로는 [용량 계획](/performance/notes/07-capacity-planning)처럼 부하 테스트로 확인한다.

## 공통 체크리스트

- [ ] 키마다 TTL 또는 정리 경로가 있는가 (영원히 자라는 키 없음)
- [ ] 빅 키(멤버 1만+)·핫 키 가능성 → 샤딩/로컬 캐시
- [ ] Redis 가 죽었을 때 각 기능의 동작 정의 (fail-open/closed)
- [ ] 원천이 Redis 인가 DB 인가 — 복구 방법
- [ ] 클러스터 전환을 대비한 해시태그
- [ ] 메모리 추정: 키 수 × (키 길이 + 값 + ~50B 오버헤드)

## 실전에서는 어디에 쓰이나

> 이 노트의 레시피 이름이 곧 실무 기능 이름이다. 기획서에 "최근 본 상품", "온라인 표시", "30분 뒤 자동 취소" 가 나오면 여기서 출발한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 미결제 주문 자동 취소 | N분 뒤 실행 | ZSet 지연 큐(score = 실행 시각), `ZREM` 으로 claim | 브로커 지연 메시지, 스케줄러 |
| 공연·항공 좌석 선점 | 이중 판매 0, 미결제 자동 해제 | `SET NX PX` + Lua 다중 선점, 확정은 DB | DB 잠금 + 만료 배치 |
| 메신저·게임 접속 표시 | 친구 중 누가 온라인인가 | 하트비트 `SET EX`, 대규모는 Bitmap | 프레즌스 전용 서버 |
| SNS 타임라인 | 팔로워 피드를 빠르게 | fan-out on write + `LTRIM`, 유명인은 조회 시 병합 | fan-out on read |
| 학습·운동 앱 연속 기록 | 연속 일수·총 일수 | Bitmap `SETBIT` + `BITCOUNT` | DB 일별 행 |

**이럴 땐 안 맞는다**
- 결제 확정 상태를 Redis 원본으로 — failover 로 선점·상태가 사라질 수 있다. 확정은 DB 에서 하고 Redis 는 빠른 경로.
- DB 와 Redis 에 동시에 쓰는 이벤트 발행 — 이중 쓰기 불일치. 아웃박스 → Stream 릴레이.

**누가 매일 만나나** — 백엔드 개발자가 기획을 데이터 구조로 옮길 때, 아키텍트가 설계 리뷰에서 용량 추정(키 수 × 크기 × 여유)을 요구할 때.

**면접·실무 단골 질문**
- Q. 1억 플레이어 리더보드는 → 샤딩된 ZSet, 상위는 샤드별 top-N 병합, 전역 순위는 구간 카운트로 근사.
- Q. 지연 큐에서 두 워커가 같은 작업을 가져가지 않게 → `ZREM` 반환값 1 인 쪽만 실행, 또는 Lua 로 꺼내기.

## 실습 체크리스트

- [ ] 레시피 2(지연 큐)를 콘솔로 구현해 `ZRANGEBYSCORE … <now>` 로 기한 지난 작업만 꺼내기
- [ ] 레시피 11 처럼 `quiz:due:redis` ZSet 인덱스를 만들어 기한 지난 카드 수를 `ZCOUNT` 로 세기
- [ ] 레시피 13 의 `LPUSH` + `LTRIM` 으로 최근 5개만 남는 캡드 로그 만들기
- [ ] 용량 추정 표를 자신의 서비스 숫자로 다시 계산하기
- [ ] 실험실의 리더보드·리스트 큐·분산 락·스트림·비트맵 DAU 실험을 레시피 번호와 짝지어 돌리기
