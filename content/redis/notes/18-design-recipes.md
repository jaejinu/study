---
title: 심화 — 실전 설계 레시피 10가지
order: 18
level: 심화
summary: 세션 저장소, 지연 큐, 중복 제거, 좌석 선점, 활동 피드, 샤딩된 리더보드, 최근 본 상품, 온라인 상태, 카운터 집계, 기능 플래그 — 각각의 자료구조 선택·키 설계·명령·만료·실패 처리·메모리 추정을 코드와 함께
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

## 공통 체크리스트

- [ ] 키마다 TTL 또는 정리 경로가 있는가 (영원히 자라는 키 없음)
- [ ] 빅 키(멤버 1만+)·핫 키 가능성 → 샤딩/로컬 캐시
- [ ] Redis 가 죽었을 때 각 기능의 동작 정의 (fail-open/closed)
- [ ] 원천이 Redis 인가 DB 인가 — 복구 방법
- [ ] 클러스터 전환을 대비한 해시태그
- [ ] 메모리 추정: 키 수 × (키 길이 + 값 + ~50B 오버헤드)
