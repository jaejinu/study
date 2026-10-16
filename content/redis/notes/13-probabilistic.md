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

## HyperLogLog 를 직관으로

동전을 던져 "앞면이 처음 나올 때까지 뒷면이 몇 번 연속 나왔나" 를 기록한다고 하자. 누군가 "가장 길었던 연속이 10번" 이라고 말하면, 그 사람은 대략 2^10 ≈ 1000번쯤 던졌을 것이라고 추정할 수 있다. HLL 은 원소마다 해시를 "동전 던지기" 로 보고 **선행 0 의 최대 길이**를 기록한다.

한 사람의 기록만 쓰면 운에 크게 좌우되므로, 해시의 앞 14비트로 **16384개 버킷**을 나누고 각 버킷의 최대값을 따로 기록한 뒤 **조화 평균**으로 합친다. 그래서:

| 값 | 의미 |
|---|---|
| 버킷 수 m = 16384 (2^14) | 메모리 = 16384 × 6비트 = 12KB |
| 표준 오차 1.04/√m | ≈ 0.81% |
| 작은 카디널리티 | 빈 버킷 수로 보정(선형 계수) — sparse 표현은 수백 바이트 |

`PFMERGE` 가 가능한 이유는 버킷별 **최대값**만 남기면 합집합이 되기 때문이다. 교집합은 직접 안 되고 포함-배제(|A|+|B|−|A∪B|)로 근사하는데, 오차가 커서 작은 교집합엔 쓰지 않는다.

```
127.0.0.1:6379> PFADD uv a b c
(integer) 1
127.0.0.1:6379> MEMORY USAGE uv
(integer) 120          ← 원소가 적으면 sparse 표현
127.0.0.1:6379> DEBUG OBJECT uv   (또는 OBJECT ENCODING)
...
127.0.0.1:6379> PFADD uv <1만 개 추가 후>
127.0.0.1:6379> MEMORY USAGE uv
(integer) 14392        ← dense 로 전환, 12KB + 헤더
```

## Bloom filter 크기 계산

원소 n 개, 거짓 양성률 p 를 원하면:

```
비트 수 m = −n·ln(p) / (ln 2)²
해시 수 k = (m/n)·ln 2
```

| n | p | m(비트) | 메모리 | k |
|---|---|---|---|---|
| 100만 | 1% | 958만 | 1.2MB | 7 |
| 100만 | 0.1% | 1438만 | 1.8MB | 10 |
| 1억 | 1% | 9.6억 | 120MB | 7 |

같은 100만 URL 을 Set 으로 저장하면 수십 MB 다. 정확도를 10배(1% → 0.1%) 올리는 비용은 메모리 1.5배에 불과하다 — 로그 관계이기 때문이다.

**용량을 넘기면** 거짓 양성률이 급격히 오른다. RedisBloom 의 `BF.RESERVE … EXPANSION 2` 는 가득 차면 두 배 크기의 필터를 하나 더 붙인다(조회는 모든 층을 확인).

## 비트맵 실전 — 리텐션 계산

```
# 가입 코호트(10-01 가입자) 중 7일 뒤에도 온 사람
BITOP AND retained:d7 signup:2026-10-01 dau:2026-10-08
BITCOUNT retained:d7                 → 3120
BITCOUNT signup:2026-10-01          → 10000   → D7 리텐션 31.2%

# 7일 연속 접속자
BITOP AND streak7 dau:10-02 dau:10-03 dau:10-04 dau:10-05 dau:10-06 dau:10-07 dau:10-08
```

| 주의 | 이유 |
|---|---|
| 오프셋은 조밀한 정수 ID | UUID 면 매핑 필요. 사용자 ID 가 1억 번대에서 시작하면 앞부분 12MB 가 낭비 |
| 큰 오프셋 첫 SETBIT | 0 으로 채운 대량 할당 → 지연 스파이크. 미리 `SETBIT key <max> 0` 로 확보 |
| BITOP 은 O(N) | 큰 비트맵끼리는 수 ms — 레플리카나 배치에서 |

## 무엇을 고를까 — 질문으로

| 질문 | 구조 | 이유 |
|---|---|---|
| 오늘 순방문자 몇 명? (대략) | HLL | 12KB, 날짜별·합치기 쉬움 |
| 오늘 순방문자 몇 명? (정확, ID 가 정수) | Bitmap | 정확하고 BITOP 으로 코호트 분석 |
| 이 URL 이미 크롤링했나? | Bloom | 없으면 확실, 메모리 작음 |
| 이 상품을 이미 추천했나(삭제도 필요)? | Cuckoo | 삭제 가능 |
| 검색어 상위 10개? | Top-K | 스트림에서 근사 상위 |
| 각 키가 몇 번 나왔나? | Count-Min Sketch | 과대 추정만, 메모리 고정 |
| 응답 시간 p99? | t-digest | 분위수 근사([Redis 8 모듈](/redis/notes/15-redis8-modules)) |

## 예시로 보기 — 이 프로젝트에서

이 사이트에 "노트별 순방문자" 를 붙인다면:

```ts
// 노트를 열 때
await redis.pfadd(`uv:note:${subject}/${slug}:${day}`, visitorId);
await redis.expire(`uv:note:${subject}/${slug}:${day}`, 90 * 86400);
// 주간 UV
await redis.pfmerge(`uv:note:${key}:week`, ...days.map((d) => `uv:note:${key}:${d}`));
const weekly = await redis.pfcount(`uv:note:${key}:week`);
```

노트가 200편이고 90일이면 키가 1만 8천 개, 대부분 sparse 라 수 MB 다. 같은 걸 Set 으로 하면 방문자 수에 비례해 커진다. 실험실의 **HyperLogLog**, **Bitmap DAU**, **Bloom filter** 실험이 오차와 메모리를 숫자로 보여 준다. 근사 구조의 오차를 그래프로 보여 줄 때는 신뢰 구간을 함께 표시하자 — 0.81% 는 "표준 오차" 라 실제 오차는 그 2~3배까지도 나온다.

## 실습 체크리스트

- [ ] `PFADD` 로 1만 개를 넣고 `PFCOUNT` 의 실제 오차율과 `MEMORY USAGE` 기록하기
- [ ] 이틀치 HLL 을 `PFMERGE` 하고 합집합 수가 두 값의 합보다 작은지 확인하기
- [ ] 위 공식으로 Bloom 크기를 계산하고 `BF.RESERVE`·`BF.INFO` 결과와 비교하기
- [ ] 비트맵으로 3일 연속 접속자를 `BITOP AND` 로 구하기
- [ ] 실험실의 HLL·Bitmap·Bloom 실험 세 개를 돌리기
