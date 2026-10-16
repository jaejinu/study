---
title: "정렬·TreeMap·NavigableMap·PriorityQueue — Comparator 계약과 TimSort"
chapter: "2부 · 컬렉션과 자료구조"
order: 9
level: 중급
summary: "Comparable 과 Comparator, comparing·thenComparing·reversed·nullsFirst 로 조합하는 비교자, 정렬 계약(대칭·추이·일관성)을 어기면 TimSort 가 'Comparison method violates its general contract!' 를 던지는 실측(50회 중 50회), (x,y)->x-y 오버플로, 객체 정렬은 안정(TimSort)·원시 정렬은 불안정(Dual-Pivot Quicksort), TreeMap 의 레드-블랙 트리와 floor·ceiling·headMap·tailMap 범위 조회, PriorityQueue 힙의 toString 이 정렬되지 않은 이유, 그리고 compareTo 와 equals 불일치의 함정"
tags: [Java, Comparator, Comparable, TimSort, TreeMap, NavigableMap, PriorityQueue, 힙]
experiments: []
---

## 비교의 두 가지 방법

| | `Comparable<T>` | `Comparator<T>` |
|---|---|---|
| 위치 | 클래스 자신이 구현(`compareTo`) | 바깥에서 만든 비교 객체(`compare`) |
| 개수 | 하나 — "자연 순서" | 여럿 — 상황마다 |
| 예 | `String`, `Integer`, `LocalDate` | 이름순·나이순·가격 내림차순 |

반환값 규약: 음수(앞), 0(같음), 양수(뒤).

### 비교자 조합

```java
record Person(String name, int age) {}
people.sort(Comparator.comparingInt(Person::age));                         // 나이 오름
people.sort(Comparator.comparingInt(Person::age).reversed()
                      .thenComparing(Person::name));                      // 나이 내림 → 이름
```

```
안정 정렬(나이) — 같은 나이는 입력 순서 유지: [영희, 지은, 철수, 민수]
나이 내림 → 이름: [민수30, 철수30, 영희25, 지은25]
```

| 조합 | 뜻 |
|---|---|
| `comparing(f)` / `comparingInt(f)` | 키 추출(원시 특화가 박싱 없음) |
| `thenComparing(g)` | 앞 비교가 같을 때 다음 기준 |
| `reversed()` | 뒤집기 — **사슬 전체** 를 뒤집는다(위치 주의) |
| `nullsFirst(c)` / `nullsLast(c)` | null 을 앞·뒤로 |
| `Comparator.naturalOrder()` / `reverseOrder()` | 자연 순서 |

> `comparing(Person::name).reversed().thenComparing(...)` 와 `comparing(Person::name).thenComparing(...).reversed()` 는 다르다. 뒤의 것은 둘째 기준까지 뒤집힌다.

## 정렬 계약

비교자는 다음을 지켜야 한다.

1. **대칭**: `sgn(c(a,b)) == -sgn(c(b,a))`
2. **추이**: a > b, b > c 이면 a > c
3. **일관성**: 같은 입력에 같은 답
4. `c(a,b) == 0` 이면 다른 원소 x 에 대해 `sgn(c(a,x)) == sgn(c(b,x))`

### 어기면 — TimSort 의 예외

```java
// 0 을 돌려주지 않는 비교자: 같은 값 a, a 에 대해 c(a,a) = 1 이고 대칭이 깨진다
big.sort((x, y) -> x < y ? -1 : 1);     // 원소 5000 개, 값 범위 0~49 (중복 많음)
```

```
seed 0: Comparison method violates its general contract!
0 을 돌려주지 않는 비교자(같은 값 대칭성 위반)로 5000개 정렬 50회 중 예외 50회
```

`List.sort`·`Arrays.sort(Object[])`·`Collections.sort` 는 **TimSort** 를 쓴다. TimSort 는 이미 정렬된 구간(run)을 찾아 병합하는데, 병합 중 계약이 깨진 증거를 발견하면 예외를 던진다. 무작위 결과를 내는 비교자로 2000 개를 정렬했을 때는 예외 없이 "운 좋게 통과" 했다 — **검출은 보장되지 않는다**. 예외가 안 나도 결과가 틀릴 수 있다.

이 예외는 운영에서 데이터가 특정 분포가 될 때만 나서 재현이 어렵다. 흔한 원인:

| 원인 | |
|---|---|
| 0 을 돌려주지 않음 | `a < b ? -1 : 1` |
| 가변 필드로 비교 | 정렬 도중 다른 스레드가 값을 바꿈 |
| `double` 을 `(int)(a - b)` 로 | 0.3 - 0.1 = 0.2 → (int) 0 → "같음" 으로 오판 |
| null 처리 누락 | 일부만 null 검사 |

### 뺄셈 비교자의 오버플로

```java
ov.sort((x, y) -> x - y);    // [Integer.MIN_VALUE, 5, -3]
```

```
(x,y)->x-y 오버플로 정렬 결과: [-3, 5, -2147483648]  ← MIN_VALUE 가 맨 앞이 아닐 수 있음
```

`5 - Integer.MIN_VALUE` 는 int 범위를 넘어 음수가 된다. 그래서 MIN_VALUE 가 5 보다 "크다" 고 판정됐다. **항상 `Integer.compare(x, y)` 나 `Comparator.comparingInt` 를 쓴다.**

## 안정 정렬과 알고리즘

| 대상 | 알고리즘 | 안정 | 이유 |
|---|---|---|---|
| 객체(`Object[]`, `List`) | TimSort | **안정** | 같은 키의 입력 순서를 지켜야 다단계 정렬이 가능 |
| 원시 배열(`int[]`) | Dual-Pivot Quicksort | 불안정 | 원시값은 같으면 구별할 수 없으니 안정성 불필요, 더 빠름 |
| 병렬 `Arrays.parallelSort` | 분할 병합 | 객체는 안정 | 큰 배열에서 ForkJoin |

안정성 덕분에 위 예에서 나이로 정렬하면 같은 25살인 영희·지은이 입력 순서대로 남는다. "먼저 이름순으로 정렬하고, 다시 나이순으로 정렬" 하면 나이가 같은 사람끼리는 이름순이 유지된다 — 표 UI 에서 여러 열을 차례로 클릭해 정렬하는 동작이 이것이다.

TimSort 는 실제 데이터에 흔한 "부분적으로 정렬된" 입력에서 O(n) 에 가깝게 끝난다. 최악 O(n log n), 추가 메모리 O(n).

## TreeMap 과 NavigableMap

`TreeMap` 은 **레드-블랙 트리** 다. 키가 항상 정렬돼 있고 get/put/remove 가 O(log n).

| | HashMap | TreeMap |
|---|---|---|
| 조회 | 평균 O(1) | O(log n) |
| 순서 | 없음 | 키 정렬 |
| 범위 조회 | 불가 | `subMap`, `headMap`, `tailMap` |
| 근접 조회 | 불가 | `floorKey`, `ceilingKey`, `lowerKey`, `higherKey` |
| null 키 | 1개 허용 | 불가(비교 불가) |

```java
TreeMap<Integer, String> tm = new TreeMap<>(Map.of(10, "a", 20, "b", 30, "c", 40, "d"));
tm.floorKey(25);        // 25 이하 중 최대 → 20
tm.ceilingKey(25);      // 25 이상 중 최소 → 30
tm.headMap(30);         // 30 미만 → {10, 20}
tm.tailMap(30, true);   // 30 이상 → {30, 40}
```

```
floorKey(25)=20, ceilingKey(25)=30, headMap(30)={10=a, 20=b}, tailMap(30,true)={30=c, 40=d}
```

근접 조회가 필요한 실무 예:

| 문제 | TreeMap 사용 |
|---|---|
| 요금 구간표(구간 하한 → 요율) | `floorEntry(amount)` |
| 일관 해싱 링(해시 위치 → 노드) | `ceilingEntry(hash)`, 없으면 `firstEntry()` — [분산: 파티셔닝](/distributed-systems/notes/07-partitioning) |
| 시계열에서 "그 시각 직전 값" | `floorEntry(timestamp)` |
| 예약 겹침 검사 | 시작 시각 키로 앞뒤 예약 확인 |

여러 스레드에서 쓰려면 `ConcurrentSkipListMap`(락 없는 스킵 리스트, 같은 NavigableMap 인터페이스). Redis 의 Sorted Set 도 스킵 리스트다 → [Redis 내부](/redis/notes/16-internals-deep-dive).

### compareTo 와 equals 의 불일치

`TreeMap`·`TreeSet` 은 **`equals` 가 아니라 `compareTo` 로** 같음을 판정한다. 둘이 다르면 이상한 일이 생긴다.

```java
new BigDecimal("1.0").equals(new BigDecimal("1.00"))     // false (스케일이 다름)
new BigDecimal("1.0").compareTo(new BigDecimal("1.00"))  // 0
// HashSet 에는 두 개, TreeSet 에는 하나
```

비교자가 이름만 비교하면 이름이 같은 다른 사람이 `TreeSet` 에서 사라진다. TreeSet·TreeMap 의 비교자는 **같다고 할 것만 0 을 돌려주게** 끝까지 기준을 둔다(`thenComparing(Person::id)`).

## PriorityQueue — 이진 힙

`PriorityQueue` 는 배열로 표현한 **최소 힙** 이다. 가장 작은 원소를 꺼내는 데 O(log n), 맨 앞 보기 O(1).

```java
PriorityQueue<Integer> pq = new PriorityQueue<>(List.of(5, 1, 4, 2, 3));
```

```
PriorityQueue toString(힙 배열 순서) [1, 2, 4, 5, 3] vs poll 순서 [1, 2, 3, 4, 5]
```

`toString()`·반복자는 **내부 배열 순서** 라 정렬돼 있지 않다. 힙은 "부모 ≤ 자식" 만 보장한다. 정렬된 순서가 필요하면 `poll()` 로 꺼내거나 정렬해서 본다. 디버깅하다가 "우선순위 큐가 정렬이 안 된다" 고 착각하는 고전이다.

| 문제 | |
|---|---|
| 상위 K 개 | 크기 K 의 **최소** 힙을 유지하고 더 큰 것이 오면 교체 — O(n log K) |
| 작업 스케줄러 | 실행 시각 순 — `DelayQueue`(스레드 안전, 시각이 될 때까지 꺼내지 않음) |
| 다익스트라·A* | 거리 순 |
| 여러 정렬 리스트 병합 | 각 리스트의 머리를 힙에 |

최대 힙은 `new PriorityQueue<>(Comparator.reverseOrder())`. 원소의 우선순위 필드를 넣은 뒤 바꾸면 힙이 깨진다 — 꺼내서 바꾸고 다시 넣는다.

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 검색(`src/lib/search.ts`)은 점수로 정렬한 뒤 상위 N 개를 자른다 — 결과가 수백 개뿐이라 전체 정렬로 충분하다. 수백만 개라면 크기 N 의 최소 힙으로 상위 N 개를 고르는 쪽이 낫다.
- Redis 의 Sorted Set 은 TreeMap 의 근접·범위 조회를 서버에서 해 준다(`ZRANGEBYSCORE`, `ZRANGEBYLEX`) → [시스템 디자인: 검색 자동완성](/system-design/notes/07-search-autocomplete)의 사전순 범위 조회가 `TreeMap.subMap(prefix, prefix + "￿")` 와 같은 일이다.
- 간격 반복 퀴즈의 "기한 지난 카드부터" 는 기한 시각을 키로 한 우선순위 큐 문제다(이 사이트는 Redis Hash 를 읽어 메모리에서 정렬한다).

### Spring 서비스에서

```java
// 정렬 가능한 API 파라미터를 비교자로
Comparator<Order> c = switch (sort) {
    case "price" -> Comparator.comparing(Order::price);
    case "date" -> Comparator.comparing(Order::createdAt).reversed();
    default -> Comparator.comparing(Order::id);
};
```

대부분의 정렬은 DB(`ORDER BY`, 인덱스)에 맡기고, 메모리 정렬은 여러 소스를 합친 뒤에만 한다. 페이지네이션 정렬에는 반드시 **유일한 마지막 기준**(id)을 둔다 — 그렇지 않으면 같은 값의 순서가 페이지마다 바뀐다(→ [API 설계: REST 원칙](/api-design/notes/01-rest-principles)의 커서 페이지네이션).

## 정리

- 비교자는 `comparing`·`thenComparing`·`reversed` 로 조합하고, 뺄셈 대신 `Integer.compare`.
- 계약을 어기면 TimSort 가 예외를 던질 수 있다 — 하지만 검출은 보장되지 않는다.
- 객체 정렬은 안정(TimSort), 원시 정렬은 불안정(Dual-Pivot Quicksort).
- TreeMap 은 정렬·범위·근접 조회. 같음은 compareTo 로 판정하니 equals 와 일치시킨다.
- PriorityQueue 의 toString 은 힙 배열 순서다.

다음: 3부 [스레드와 자바 메모리 모델](/java/notes/10-threads-jmm). 앞: [HashMap 내부](/java/notes/08-hashmap-internals).

## 실습 체크리스트

- [ ] `(x, y) -> x < y ? -1 : 1` 비교자로 중복이 많은 리스트를 정렬해 계약 위반 예외를 재현
- [ ] `(x, y) -> x - y` 로 `Integer.MIN_VALUE` 가 섞인 리스트를 정렬해 오버플로를 확인하고 `Integer::compare` 로 고친다
- [ ] 이름만 비교하는 비교자로 `TreeSet<Person>` 을 만들어 이름이 같은 사람이 사라지는 것을 확인
- [ ] `TreeMap.floorEntry` 로 요금 구간표를 구현
- [ ] `PriorityQueue` 로 100만 개 중 상위 10 개를 크기 10 힙으로 고르고 전체 정렬과 시간을 비교
