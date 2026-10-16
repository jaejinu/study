---
title: 확률적 자료구조 — HyperLogLog, Bitmap, Bloom
order: 13
level: 심화
summary: 정확도를 조금 포기하고 메모리를 극적으로 줄이는 구조들, 각각의 오차와 용도
tags: [HyperLogLog, Bitmap, Bloom, 카디널리티, 근사]
experiments: [hyperloglog, bitmap-dau, bloom-filter]
---

## 왜 필요한가

"오늘 순방문자 수" 를 Set 으로 세면 1천만 명 × 수십 바이트 = 수백 MB. 매일 하나씩 두면 금방 GB 다.
정답이 10,000,000 인지 10,050,000 인지가 중요하지 않다면 **12KB** 로 충분하다.

## HyperLogLog

```
PFADD uv:2026-10-16 user1 user2 user3
PFCOUNT uv:2026-10-16                 # 근사 유니크 수
PFMERGE uv:week uv:10-10 uv:10-11 ... # 합집합 (역시 12KB)
PFCOUNT uv:week
```

- 표준 오차 **0.81%**. 원소 수와 무관하게 최대 12KB (원소가 적을 때는 sparse 표현으로 더 작음).
- 원리: 각 원소를 해시하고, 이진 표현에서 선행 0 의 최대 길이를 16384 개 레지스터에 기록. "0이 k개 연속 나올 확률 ≈ 2^-k" 에서 역산. 조화 평균으로 이상치 보정.
- 멤버십 질의("user1 왔었나?") 는 **불가**.
- `PFADD` 는 카운트가 바뀌면 1, 아니면 0 을 반환.
- 내부는 String 이라 `GET` 으로 바이트를 볼 수 있다 (HYLL 헤더).

## Bitmap

String 의 각 비트를 플래그로 쓴다. 오프셋 = 사용자 ID.

```
SETBIT dau:2026-10-16 1001 1       # user 1001 접속
GETBIT dau:2026-10-16 1001
BITCOUNT dau:2026-10-16            # 오늘 활성 사용자 수 (정확!)
BITOP AND both dau:10-15 dau:10-16 # 이틀 연속
BITOP OR  any  dau:10-15 dau:10-16 # 이틀 중 하루라도
BITPOS dau:2026-10-16 1            # 첫 번째 1 비트 위치
```

- ID 가 **조밀한 정수**일 때 효과적. 1억 명 = 100M bit = 12.5MB.
- ID 가 UUID 처럼 희소하면 매핑 테이블이 필요하거나 부적합.
- `SETBIT` 로 큰 오프셋을 처음 쓰면 그 크기만큼 한 번에 할당 (0 으로 채움) → 지연 발생 가능.
- 정확한 카운트라는 점에서 HLL 과 다르다. 대신 메모리는 사용자 수에 비례.

### Bitfield

```
BITFIELD stats SET u8 0 200 INCRBY u8 8 1 GET u16 0
```
임의 비트 폭의 정수 배열. 8비트 카운터 수백만 개를 한 키에.

## Bloom Filter

"이 원소가 집합에 **없다**" 는 확실히, "**있다**" 는 거짓 양성 확률로 답한다.
Redis 코어에는 없고 **RedisBloom** 모듈(Redis Stack) 이 제공한다.

```
BF.RESERVE seen 0.01 1000000      # 오차 1%, 예상 100만
BF.ADD seen url1
BF.EXISTS seen url1               # 1
BF.EXISTS seen url2               # 0 이면 확실히 없음
```

- 크롤러의 "이미 방문한 URL", 캐시 penetration 방지, 추천에서 "이미 본 상품" 제외.
- 삭제 불가 (Cuckoo filter `CF.*` 는 가능).
- 모듈 없이 흉내 내려면 k 개 해시 + `SETBIT`/`GETBIT` 를 Lua 로 묶는다.

## 비교

| 구조 | 질문 | 메모리 | 정확도 |
|---|---|---|---|
| Set | 있나? 몇 개? | O(N) | 정확 |
| HyperLogLog | 몇 개? | 12KB | ±0.81% |
| Bitmap | ID 가 있나? 몇 개? | O(max ID / 8) | 정확 |
| Bloom | 있나? | O(N·bits) 작음 | 거짓 양성 있음 |

> 실험실의 HyperLogLog 실험은 1만 개를 넣고 실제 오차와 `MEMORY USAGE` 를 보여준다.
