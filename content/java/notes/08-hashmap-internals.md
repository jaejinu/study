---
title: "HashMap 내부 — 해시 교란, 버킷, 트리화, 리사이즈, 그리고 계약 위반 사고"
chapter: "2부 · 컬렉션과 자료구조"
order: 8
level: 심화
summary: "HashMap 이 키를 찾는 세 단계(hashCode → 교란 h ^ h>>>16 → 인덱스 hash & (n-1)), 2의 거듭제곱 테이블과 적재율 0.75, 리사이즈가 그 한 번의 put 을 수백 배 느리게 만드는 실측, 같은 버킷의 체인이 8개를 넘으면 레드-블랙 트리로 바뀌는 트리화와 Comparable 이어야 효과가 있는 이유(상수 hashCode 키 8천 개: 9838 ns vs 71 ns), 해시 충돌 공격, LinkedHashMap 으로 만드는 LRU, 그리고 equals/hashCode 위반이 만드는 운영 사고"
tags: [Java, HashMap, 해시, 트리화, 리사이즈, 적재율, LinkedHashMap, LRU]
experiments: [java-hashmap-internals]
---

## HashMap 의 구조

```
table: Node[] (길이는 항상 2의 거듭제곱: 16, 32, 64 …)
  [0] → null
  [1] → Node(hash, key, value, next) → Node → …     ← 같은 버킷의 충돌은 연결 리스트
  [2] → TreeNode(레드-블랙 트리)                    ← 충돌이 많아지면 트리로 (트리화)
  …
```

![HashMap 의 버킷과 트리화](/diagrams/java-coll-hashmap.svg)

`get(key)` 는 세 단계다.

1. `key.hashCode()` — 키가 계산한 32비트 정수.
2. **교란**: `h ^ (h >>> 16)` — 상위 16비트를 하위에 섞는다.
3. **인덱스**: `hash & (table.length - 1)` — 길이가 2의 거듭제곱이라 나머지 연산 대신 비트 AND.

그 버킷에서 `hash` 가 같고 `equals` 가 참인 노드를 찾는다. 해시 비교를 먼저 하는 이유는 `equals` 가 비쌀 수 있기 때문이다(문자열은 길이만큼 비교).

### 왜 교란하나

인덱스는 해시의 **하위 비트만** 쓴다(테이블 16 이면 하위 4비트). 상위 비트만 다른 해시들은 전부 같은 버킷에 몰린다.

```java
static int spread(int h) { return h ^ (h >>> 16); }
// 0x10000, 0x20000, 0x30000, 0x40000 — 하위 4비트가 모두 0
```

```
hash=0x10000  하위4비트=0  교란 후 하위4비트=1
hash=0x20000  하위4비트=0  교란 후 하위4비트=2
hash=0x30000  하위4비트=0  교란 후 하위4비트=3
hash=0x40000  하위4비트=0  교란 후 하위4비트=4
```

교란 없이는 네 키가 모두 0번 버킷, 교란 후에는 흩어진다. `Float`·주소 기반 해시처럼 하위 비트가 비슷한 키가 흔해서 넣은 값싼 보정이다.

## 적재율과 리사이즈

원소 수가 `용량 × 적재율(0.75)` 을 넘으면 테이블을 두 배로 늘리고 **모든 노드를 새 테이블로 옮긴다**. 길이가 2의 거듭제곱이므로 각 노드는 원래 인덱스 `i` 또는 `i + 옛 길이` 둘 중 하나로만 간다(해시의 다음 비트 하나로 결정) — 해시를 다시 계산하지 않고 체인을 둘로 쪼개는 영리한 구현이다. 그래도 **전체를 한 번 훑는다**.

실험실의 [HashMap 내부 실험](/java/lab/java-hashmap-internals)은 put 하나하나의 시간을 3천 번 평균 낸다.

| 리사이즈를 일으킨 put | 그때 테이블 | 그 put 평균 | 주변 put 평균 | 배수 |
|---|---|---|---|---|
| 13번째 | 16 → 32 | 81 ns | 24 ns | 3× |
| 97번째 | 128 → 256 | 320 ns | 25 ns | 13× |
| 769번째 | 1024 → 2048 | 2,319 ns | 29 ns | 80× |
| 6145번째 | 8192 → 16384 | 18,015 ns | 31 ns | 580× |

평소 put 은 수십 ns 로 일정한데, 리사이즈를 일으키는 그 한 번은 테이블 크기에 비례해 커진다. 평균(분할 상환)은 여전히 O(1) 이지만 **특정 요청의 꼬리 지연** 으로 나타날 수 있다 — 수백만 개짜리 맵이면 한 번에 수십 ms.

| 대처 | |
|---|---|
| 크기를 알면 미리 | `HashMap.newHashMap(expected)` (19+) — `new HashMap<>(n)` 은 **용량** 이라 n 개를 넣으면 리사이즈가 날 수 있다 |
| 적재율 바꾸기 | 거의 하지 않는다. 낮추면 메모리 낭비, 높이면 충돌 증가 |
| 거대한 맵 | 애초에 프로세스 메모리에 둘지 고민(Redis·로컬 캐시 라이브러리 Caffeine) |

```
new HashMap<>(100) 은 실제 테이블 128, 리사이즈 없이 96개까지. 100개를 넣으려면 HashMap.newHashMap(100) (19+)
newHashMap(100) 에 100개: 100
```

## 충돌과 트리화

해시가 겹치면 같은 버킷의 체인이 길어지고, 그 버킷 조회는 O(체인 길이)가 된다. 자바 8 부터 한 버킷의 원소가 **8개(TREEIFY_THRESHOLD)** 를 넘고 테이블이 **64 이상(MIN_TREEIFY_CAPACITY)** 이면 체인을 **레드-블랙 트리** 로 바꾼다(64 미만이면 트리화 대신 리사이즈). 원소가 6개 이하로 줄면 다시 리스트로 돌아간다(UNTREEIFY_THRESHOLD — 8 과 6 사이의 간격은 경계에서 왔다 갔다 하지 않게 하는 히스테리시스).

트리 안에서 방향을 정하려면 비교가 필요하다. 순서는 **해시값 → 키가 `Comparable` 이면 `compareTo` → 마지막 수단(클래스 이름·identityHashCode)** 이다. 모든 키의 해시가 같으면 첫 단계가 소용없으니 **`Comparable` 여부가 결정적** 이다.

실험: `hashCode()` 가 항상 42 인 키 n 개를 넣고 각각 한 번씩 조회.

| n | 좋은 키(Integer) | 상수 hashCode | 상수 hashCode + Comparable |
|---|---|---|---|
| 1,000 | 37 ns | 1,058 ns | 80 ns |
| 2,000 | 75 ns | 1,795 ns | 45 ns |
| 4,000 | 5 ns | 4,044 ns | 50 ns |
| 8,000 | 5 ns | 9,839 ns | 71 ns |

- **Comparable 아님**: 트리화돼도 방향을 못 정해 양쪽 서브트리를 다 뒤진다 → n 에 비례(O(n)). n 이 8배일 때 약 9배.
- **Comparable**: `compareTo` 로 트리를 내려간다 → O(log n). 거의 일정하다.
- 좋은 키 행의 앞쪽 값이 큰 것은 JIT 워밍업 잡음이다(작은 n 은 측정 시간 자체가 짧다).

> 트리화는 **나쁜 해시에 대한 보험** 이지 해법이 아니다. 보험도 키가 `Comparable` 일 때만 제대로 듣는다. 키 클래스의 `hashCode` 는 모든 필드를 섞어(`Objects.hash(a, b)` 또는 record 자동 생성) 분포를 좋게 만든다.

### 해시 충돌 공격

같은 해시를 가진 문자열을 만들기는 쉽다.

```
"Aa".hashCode()=2112, "BB".hashCode()=2112
```

`"Aa"`, `"BB"` 를 조합하면 같은 해시의 문자열을 2ⁿ 개 만들 수 있다. 공격자가 HTTP 파라미터·JSON 키로 이런 문자열 수만 개를 보내면 서버의 해시 맵 하나가 O(n²) 으로 CPU 를 태운다(2011 년 여러 언어를 강타한 HashDoS). 자바 8 의 트리화가 이 공격을 O(n log n) 으로 줄였다 — `String` 이 `Comparable` 이기 때문이다. 그래도 요청 파라미터 수·JSON 크기 제한은 따로 둔다(Tomcat `maxParameterCount`).

## equals/hashCode 위반 사고

| 위반 | 증상 |
|---|---|
| `equals` 만 재정의 | `contains`·`get` 이 같은 키를 못 찾음, 중복 제거 실패 ([2장](/java/notes/02-types-objects-immutability)의 Point) |
| 해시에 쓰는 필드를 넣은 뒤 변경 | 원소가 맵 안에 있는데 못 찾고 지울 수도 없음(누수) |
| `equals` 가 대칭이 아님(하위 클래스) | 넣은 순서에 따라 결과가 다름 |
| `hashCode` 가 가변 필드·시각·난수 사용 | 매번 다른 버킷 |
| JPA 엔티티의 `hashCode` 가 `id` 기반, 저장 전 id 가 null | 저장 전 `Set` 에 넣은 엔티티를 저장 후 못 찾음 |

JPA 엔티티는 equals/hashCode 를 **비즈니스 키**(이메일·주문번호 같은 자연 키)로 하거나, id 기반이면 `hashCode` 를 클래스 상수로 고정하는 패턴(`getClass().hashCode()`)을 쓴다.

## LinkedHashMap 과 LRU

`LinkedHashMap` 은 HashMap + **이중 연결 리스트** 로 순서를 기억한다. 생성자 세 번째 인자 `accessOrder=true` 면 **접근 순서** 를 기억하고, `removeEldestEntry` 를 재정의하면 크기 제한 LRU 캐시가 된다.

```java
Map<String, Integer> lru = new LinkedHashMap<>(16, 0.75f, true) {
    protected boolean removeEldestEntry(Map.Entry<String, Integer> e) { return size() > 3; }
};
for (String k : List.of("a", "b", "c")) lru.put(k, 1);
lru.get("a");          // a 를 최근으로
lru.put("d", 1);       // 가장 오래 안 쓴 b 를 축출
```

```
LinkedHashMap LRU(3): [c, a, d]
```

단, 스레드 안전하지 않다(`get` 도 순서를 바꾸는 **쓰기** 다). 운영 캐시는 **Caffeine**(W-TinyLFU, 동시성·만료·통계)을 쓴다. Redis 의 근사 LRU/LFU 축출과 비교해 보자 → [Redis 키 만료와 축출](/redis/notes/03-keys-expiration).

## 유용한 메서드

```java
m.merge("x", 1, Integer::sum);              // 없으면 1, 있으면 더하기 — 카운터
m.computeIfAbsent(k, kk -> new ArrayList<>()).add(v);   // 멀티맵
m.getOrDefault(k, 0);
m.putIfAbsent(k, v);
```

```
merge·computeIfAbsent: {x=2, list=0}
```

`computeIfAbsent` 의 함수 안에서 **같은 맵을 수정하지 않는다** — `HashMap` 은 `ConcurrentModificationException`, `ConcurrentHashMap` 은 교착이나 `IllegalStateException` 이 날 수 있다.

## 예시로 보기 — 이 프로젝트에서

- Redis 의 Hash 와 키 공간도 해시 테이블이다. 다만 Redis 는 리사이즈를 **점진적으로**(요청마다 버킷 몇 개씩 옮기는 rehashing) 해서 한 번의 명령이 수 ms 멈추지 않게 한다 → [Redis 내부](/redis/notes/16-internals-deep-dive). 자바 HashMap 은 위 표처럼 리사이즈를 한 번에 몰아서 한다 — 단일 스레드 이벤트 루프인 Redis 에게는 그 멈춤이 전체 서버의 멈춤이라 설계가 달라졌다.
- 이 사이트의 퀴즈 기록은 Redis Hash `quiz:stats:<subject>`(필드 = 카드 키). 자바 서버라면 `Map<String, QuizStat>` 이고, 카드 키를 `record CardKey(String note, String q)` 로 만들면 [2장](/java/notes/02-types-objects-immutability)의 equals/hashCode 가 자동이다.
- 실험실 [HashMap 내부](/java/lab/java-hashmap-internals)를 직접 돌려 위 두 표를 재현해 보자.

### 운영에서

- 힙 덤프에서 `HashMap$Node[]` 가 상위에 있으면 캐시처럼 쓰는 맵이 무한히 자라고 있는지 본다(만료 없는 static 맵은 누수의 고전).
- 응답 지연의 꼬리에 가끔 수십 ms 가 섞이면, 요청 경로에서 거대한 맵에 put 하는 곳(리사이즈)과 GC 를 함께 의심한다.

## 실전에서는 어디에 쓰이나

> HashMap 은 자바 서버의 메모리 캐시·인덱스·집계 거의 전부에 쓰인다. 계약 위반은 "넣었는데 못 찾음", 리사이즈는 가끔 튀는 꼬리 지연, 무한히 자라는 맵은 메모리 누수로 운영에 나타난다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 API 의 상품 메타 로컬 캐시 | 요청마다 DB 를 치지 않기 | 크기 제한·만료가 있는 Caffeine, 단일 스레드면 `LinkedHashMap` LRU | Redis 공유 캐시 |
| 배치의 대량 조인·집계(수백만 키) | 리사이즈 반복과 꼬리 지연 | `HashMap.newHashMap(expected)` 로 미리 크기 지정 | DB 에서 집계, 정렬 후 병합 |
| 공개 HTTP API 서버 | 같은 해시 문자열을 대량으로 보내는 HashDoS | 트리화(`String` 은 Comparable) + 파라미터 수·본문 크기 제한 | 게이트웨이·WAF 의 요청 크기 제한 |
| JPA 엔티티를 `Set` 에 담는 도메인 코드 | 저장 전후 hashCode 가 바뀌어 못 찾음 | 비즈니스 키 기반 equals/hashCode, 또는 클래스 상수 hashCode | 저장 전에 id 를 미리 발급(UUID) |
| 장애 조사: 힙이 계속 자람 | 만료 없는 static 맵 누수 | 힙 덤프에서 `HashMap$Node[]` 를 확인하고 만료 있는 캐시로 교체 | 키 특성이 맞으면 `WeakHashMap` |

**이럴 땐 안 맞는다**
- 여러 스레드가 동시에 쓰는 맵: `HashMap` 은 깨진다 → `ConcurrentHashMap`([락과 j.u.c](/java/notes/11-locks-juc)).
- 여러 서버 인스턴스가 함께 봐야 하는 캐시: 프로세스 메모리라 인스턴스마다 내용이 다르다 → Redis 같은 공유 캐시.
- 정렬·범위 조회가 필요할 때 → `TreeMap`([다음 노트](/java/notes/09-sorting-treemap-pq)).

**누가 매일 만나나** — 백엔드 개발자가 캐시나 키 클래스를 직접 만들 때, SRE·성능 담당이 힙 덤프 상위의 맵과 가끔 튀는 응답 지연을 분석할 때 만난다.

**면접·실무 단골 질문**
- Q. HashMap 의 get 은 어떻게 동작하나? → hashCode → 상위 비트 교란 → `hash & (n-1)` 로 버킷 선택 → 버킷 안에서 hash·equals 비교. 체인이 길면 트리로 바뀐다.
- Q. 자바 8 의 트리화는 언제, 왜 하나? → 버킷 원소가 8개를 넘고 테이블이 64 이상일 때 레드-블랙 트리로. 나쁜 해시·충돌 공격에 대한 보험이고, 키가 Comparable 일 때 O(log n) 이 된다.

## 정리

- 조회 = hashCode → 교란(h ^ h>>>16) → `hash & (n-1)` → 버킷 안 hash·equals 비교.
- 0.75 를 넘는 put 은 테이블을 두 배로 늘려 전체를 옮긴다 — 그 put 만 수백 배 느리다. 크기를 알면 `newHashMap(n)`.
- 버킷이 8개를 넘고 테이블이 64 이상이면 트리화. 키가 `Comparable` 일 때만 O(log n) 이 된다.
- 해시 키는 불변, equals 와 hashCode 는 함께. LRU 는 `LinkedHashMap`(단일 스레드) 또는 Caffeine.

다음: [정렬·TreeMap·PriorityQueue](/java/notes/09-sorting-treemap-pq). 앞: [List 계열 내부](/java/notes/07-list-internals).

## 실습 체크리스트

- [ ] [HashMap 내부 실험](/java/lab/java-hashmap-internals)을 돌려 리사이즈 표와 충돌 표를 확인
- [ ] 상수 hashCode 키 클래스에 `Comparable` 을 붙이기 전후의 조회 시간을 직접 측정
- [ ] `new HashMap<>(100)` 과 `HashMap.newHashMap(100)` 에 100 개를 넣을 때 리사이즈 여부를 추론하고 설명
- [ ] `"Aa"`·`"BB"` 조합으로 같은 해시의 문자열 1024 개를 만들어 `HashMap` 에 넣고 조회 시간을 본다
- [ ] `LinkedHashMap` 으로 크기 3 LRU 를 만들고 `get` 이 순서를 바꾸는 것을 확인
