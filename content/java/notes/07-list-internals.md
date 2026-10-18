---
title: "List 계열 내부 — ArrayList 증가 정책, LinkedList 의 실체, ArrayDeque"
chapter: "2부 · 컬렉션과 자료구조"
order: 7
level: 중급
summary: "컬렉션 프레임워크 지도(Collection·List·Set·Queue·Deque·Map, Sequenced Collections), ArrayList 의 배열과 1.5배 증가·System.arraycopy, LinkedList 가 이론과 달리 거의 항상 느린 이유(포인터 추적·캐시 미스·노드 객체), 앞 삽입이 필요할 때 ArrayDeque, 실측(임의 get 2천 번 178ms vs 2만 번 1ms), 순회 중 수정과 ConcurrentModificationException·fail-fast, List.of·불변 뷰·subList 의 함정"
tags: [Java, ArrayList, LinkedList, ArrayDeque, 컬렉션, fail-fast, ConcurrentModificationException]
experiments: []
---

## 컬렉션 지도

```
Iterable
└── Collection
    ├── SequencedCollection (21) ─┬── List        ArrayList · LinkedList · CopyOnWriteArrayList
    │                             └── Deque       ArrayDeque · LinkedList · ConcurrentLinkedDeque
    ├── Set                       HashSet · LinkedHashSet(Sequenced) · TreeSet(Sorted/Navigable)
    └── Queue                     PriorityQueue · ArrayBlockingQueue · LinkedBlockingQueue
Map (Collection 아님)             HashMap · LinkedHashMap(Sequenced) · TreeMap · ConcurrentHashMap
```

자바 21 의 **Sequenced Collections** 는 "순서가 있는 컬렉션" 에 공통 메서드를 줬다: `getFirst()`, `getLast()`, `addFirst()`, `removeLast()`, `reversed()`. 예전에는 `list.get(list.size() - 1)`, `deque.peekLast()`, `linkedHashSet.iterator()...` 처럼 타입마다 달랐다.

| 고를 때 기본값 | |
|---|---|
| 순서 있는 목록 | `ArrayList` |
| 큐·스택·양쪽 끝 작업 | `ArrayDeque` |
| 키-값 | `HashMap`(순서 필요하면 `LinkedHashMap`, 정렬 필요하면 `TreeMap`) |
| 중복 없는 집합 | `HashSet` |
| 우선순위 | `PriorityQueue` |
| 여러 스레드 | `java.util.concurrent` 의 것들([11장](/java/notes/11-locks-juc)) |

## ArrayList — 배열 하나

`ArrayList` 의 실체는 `Object[] elementData` 와 `int size` 두 필드다.

| 연산 | 비용 | 이유 |
|---|---|---|
| `get(i)` / `set(i, x)` | O(1) | 배열 인덱싱 |
| `add(x)` (끝) | 분할 상환 O(1) | 가끔 배열을 키워 복사 |
| `add(0, x)` / `remove(0)` | O(n) | 뒤 원소 전부를 한 칸씩 `System.arraycopy` |
| `contains(x)` | O(n) | 처음부터 `equals` |

### 증가 정책

용량이 차면 새 배열을 **1.5배**(`old + old >> 1`)로 만들고 전체를 복사한다. 기본 생성자로 만든 리스트는 첫 `add` 때 용량 10 짜리 배열을 할당한다. 1.5배씩 늘리므로 n 개를 넣는 동안 복사 총량은 O(n) — 원소당 상수 비용(분할 상환)이다.

```java
List<Integer> x = new ArrayList<>(2_000_000);  // 미리 용량 지정
List<Integer> y = new ArrayList<>();           // 1.5배씩 증가
```

```
200만 add: 미리 용량 지정 38 ms, 기본(1.5배씩 증가) 31 ms
```

이 측정에서는 차이가 거의 없다(오히려 반대로 나왔다). 복사는 `System.arraycopy`(메모리 블록 복사)라 빠르고, 시간의 대부분은 `Integer` 박싱이다. 용량 지정의 실익은 **메모리 피크**(복사 중 옛 배열과 새 배열이 동시에 존재)와 **크기를 정확히 알 때의 낭비 제거** 에 있다. 이런 미세 최적화는 측정하고 판단한다([성능: 측정 방법론](/performance/notes/02-measurement-methodology)).

> `trimToSize()` 는 남는 용량을 버린다. 큰 리스트를 만들고 오래 들고 있을 때만 의미가 있다.

## LinkedList — 이론과 현실

교과서: "LinkedList 는 삽입·삭제가 O(1) 이라 빠르다." 현실: **거의 항상 ArrayList 보다 느리다.**

```
순회 200000개: ArrayList 2 ms, LinkedList 2 ms
임의 get: ArrayList 2만 번 1 ms, LinkedList 2천 번 178 ms
앞에 5만 개 삽입: ArrayList.add(0) 73 ms, LinkedList.addFirst 1 ms, ArrayDeque.addFirst 1 ms
```

| 이유 | |
|---|---|
| `get(i)` 가 O(n) | 인덱스까지 노드를 따라간다(가까운 쪽 끝에서 시작해도 평균 n/4). 위 실측에서 **호출 수가 10분의 1인데도 178배 느렸다** |
| 노드 객체 | 원소마다 `Node`(prev·next·item, 약 24바이트) — 메모리 2~3배, GC 대상 증가 |
| 캐시 미스 | 노드가 힙 여기저기 흩어져 있어 순회할 때마다 포인터를 쫓는다. 배열은 연속 메모리라 CPU 프리페치가 동작한다 |
| "중간 삽입 O(1)" 의 함정 | 삽입 **위치를 찾는 것** 이 O(n)이다. 이미 그 위치의 `ListIterator` 를 들고 있을 때만 O(1) |

순회가 비슷하게 나온 것은 200,000 개 노드가 할당 순서대로 비교적 붙어 있었기 때문이다. 오래 돌며 삽입·삭제가 섞인 서비스에서는 노드가 흩어져 차이가 커진다. 메모리 계층의 지연 차이는 [DB 내부: 디스크와 메모리 계층](/db-internals/notes/01-disk-memory-hierarchy)에서 숫자로 볼 수 있다.

**LinkedList 를 쓸 곳은 거의 없다.** 양쪽 끝 작업이면 `ArrayDeque` 가 낫다.

## ArrayDeque — 원형 버퍼

`ArrayDeque` 는 배열을 **원형으로** 쓴다(`head`, `tail` 인덱스가 감싸 돈다). 앞·뒤 삽입·삭제가 모두 O(1) 이고, 노드 객체가 없어 `LinkedList` 보다 메모리·캐시 효율이 좋다. 실측에서 앞 삽입은 `LinkedList` 와 같은 수준(1ms)이었다.

| 용도 | 메서드 |
|---|---|
| 스택(LIFO) | `push`, `pop`, `peek` — `Stack` 클래스(동기화된 `Vector` 기반, 낡음) 대신 |
| 큐(FIFO) | `offer`, `poll`, `peek` |
| 슬라이딩 윈도우·BFS | 양쪽 끝 |

제약: `null` 을 넣을 수 없다(빈 칸 표시에 null 을 쓰기 때문). 스레드 안전하지 않다 — 생산자/소비자는 `ArrayBlockingQueue`·`LinkedBlockingQueue`.

## 순회 중 수정 — fail-fast

```java
List<Integer> nums = new ArrayList<>(List.of(1, 2, 3, 4));
for (Integer x : nums) if (x == 2) nums.remove(x);     // ConcurrentModificationException
nums.removeIf(x -> x % 2 == 0);                        // 올바른 방법
```

```
for-each 중 remove → ConcurrentModificationException
removeIf 후 [1, 3]
```

컬렉션은 구조가 바뀔 때마다 `modCount` 를 늘린다. 반복자는 만들 때의 `modCount` 를 기억했다가 `next()` 마다 비교해 다르면 즉시 실패한다(**fail-fast**). 이름과 달리 **동시성(멀티스레드) 검출 장치가 아니다** — 같은 스레드에서도 나고, 멀티스레드 경합은 못 잡을 수도 있다(best-effort).

| 순회 중 삭제 방법 | |
|---|---|
| `list.removeIf(pred)` | 가장 좋다 |
| `Iterator.remove()` | 반복자 자신이 지우면 modCount 를 맞춘다 |
| 새 리스트로 `filter` | 원본을 안 바꾸고 싶을 때 |
| 인덱스 루프를 **뒤에서부터** | 앞에서부터 지우면 인덱스가 밀려 원소를 건너뛴다 |

동시 수정이 필요하면 `CopyOnWriteArrayList`(쓰기마다 배열 전체 복사 — 읽기가 압도적으로 많을 때, 예: 리스너 목록)나 `ConcurrentHashMap`·`ConcurrentLinkedQueue`.

## 불변 리스트와 뷰

| 생성 | 수정 | null | 원본과 연결 |
|---|---|---|---|
| `List.of(a, b)` | 불가 | **불가**(NPE) | 없음 |
| `List.copyOf(c)` | 불가 | 불가 | 없음(복사) |
| `Collections.unmodifiableList(l)` | 불가 | 가능 | **있음** — 원본이 바뀌면 보인다(읽기 전용 뷰) |
| `Arrays.asList(arr)` | `set` 가능, `add`/`remove` 불가 | 가능 | **배열과 공유** |
| `stream().toList()` (16+) | 불가 | 가능 | 없음 |
| `Collectors.toList()` | 가능(명세상 보장은 없음) | 가능 | 없음 |

`subList(from, to)` 는 **원본의 뷰** 다. 원본 구조가 바뀌면 subList 를 쓰는 순간 `ConcurrentModificationException`. 큰 리스트의 일부를 오래 들고 있으면 원본 전체가 GC 되지 않는다(메모리 누수) — 필요하면 `new ArrayList<>(list.subList(...))` 로 복사한다.

## 예시로 보기 — 이 프로젝트에서

- Redis 의 List 는 작을 때 listpack(연속 메모리), 커지면 quicklist(listpack 노드들의 연결 리스트)다 → [Redis 자료구조](/redis/notes/02-data-types). "연속 메모리가 빠르지만 중간 삽입은 비싸다" 는 같은 트레이드오프를 Redis 는 **두 구조의 혼합** 으로 풀었다. 자바의 `ArrayList`/`LinkedList` 는 둘 중 하나를 고르게 한다.
- 이 사이트 서버(Node)의 실험 결과 `steps` 배열은 끝에 `push` 만 한다 — 자바라면 `ArrayList` 의 분할 상환 O(1) 경로다.
- 최근 N 개만 유지하는 로그(`src/lib/lab-history.ts` 는 Redis Stream 의 `MAXLEN ~ 50`)를 자바 메모리에서 하려면 `ArrayDeque` 에 `addLast` 하고 크기를 넘으면 `removeFirst` — 원형 버퍼라 O(1) 이다.

### Spring 서비스에서

```java
// 페이지 결과를 받아 일부만 응답에 쓸 때
List<Order> page = repo.findAll(...);
return page.subList(0, Math.min(10, page.size()));     // 뷰 — 원본이 응답 직렬화 때까지 살아 있다
return List.copyOf(page.subList(0, Math.min(10, page.size())));   // 복사가 안전
```

JPA 엔티티의 `@OneToMany List<Item>` 는 Hibernate 가 자기 컬렉션(`PersistentBag`)으로 바꿔 넣는다. 이 필드를 `List.of(...)` 로 교체하면 변경 추적이 끊긴다 — 엔티티 컬렉션은 `clear()` + `addAll()` 로 내용을 바꾼다.

## 실전에서는 어디에 쓰이나

> 목록은 대부분 `ArrayList` 로 끝나지만, 순회 중 삭제·뷰 공유·큐 구현에서 운영 버그와 메모리 누수가 나온다. 어떤 구조가 메모리에서 어떻게 생겼는지가 선택의 근거다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 대부분의 서비스 코드(조회 결과 목록) | 순서 있는 목록 저장·인덱스 접근 | `ArrayList`, 크기를 정확히 알면 용량 지정 | `List.of`·`toList()` 불변 리스트 |
| 모니터링·시세 처리의 최근 N 건 유지 | 슬라이딩 윈도우를 O(1)로 | `ArrayDeque` 에 `addLast` + 넘치면 `removeFirst` | Redis Stream `MAXLEN`, 링 버퍼 라이브러리 |
| 게임 서버의 맵 탐색(BFS)·작업 스택 | 양쪽 끝 삽입·삭제 | `ArrayDeque` 를 큐·스택으로(`Stack` 대신) | 스레드 간이면 `ArrayBlockingQueue` |
| 사내 프레임워크의 이벤트 리스너 목록 | 순회 중 등록·해제로 `ConcurrentModificationException` | `CopyOnWriteArrayList` — 읽기가 압도적일 때 | 순회 전에 스냅숏 복사 |
| JPA 엔티티의 `@OneToMany` 컬렉션 | 컬렉션 교체 시 변경 추적이 끊김 | `clear()` + `addAll()` 로 내용만 바꿈 | 연관 엔티티를 하나씩 추가·삭제 |

**이럴 땐 안 맞는다**
- "중간 삽입이 O(1)" 이라며 `LinkedList`: 위치를 찾는 데 O(n)이고 노드·캐시 미스로 거의 항상 느리다 → `ArrayList`, 양쪽 끝이면 `ArrayDeque`.
- 큰 리스트의 `subList` 를 오래 보관: 원본 전체가 GC 되지 않는다 → `new ArrayList<>(list.subList(...))` 로 복사.

**누가 매일 만나나** — 백엔드 개발자가 `ConcurrentModificationException`, `List.of` 에 `add` 하다 난 `UnsupportedOperationException` 을 만났을 때, 성능 리뷰에서 자료구조 선택을 설명해야 할 때.

**면접·실무 단골 질문**
- Q. ArrayList 와 LinkedList 는 언제 무엇을 쓰나? → 거의 항상 ArrayList, 양쪽 끝 작업이면 ArrayDeque. LinkedList 는 노드 객체와 포인터 추적 때문에 느리다.
- Q. fail-fast 반복자는 멀티스레드 검출기인가? → 아니다. modCount 비교라 같은 스레드에서도 나고, 멀티스레드 경합은 못 잡을 수도 있다.

## 정리

- 목록은 `ArrayList`, 양쪽 끝은 `ArrayDeque`. `LinkedList` 는 이론과 달리 거의 항상 느리다(노드·포인터 추적·캐시 미스).
- `ArrayList` 는 1.5배씩 늘어나는 배열 — 끝 추가는 분할 상환 O(1), 앞 삽입은 O(n).
- 순회 중 삭제는 `removeIf`. fail-fast 는 동시성 검출기가 아니다.
- `List.of` 는 불변·null 불가, `unmodifiableList`·`subList`·`Arrays.asList` 는 원본과 연결된 뷰다.

다음: [HashMap 내부](/java/notes/08-hashmap-internals). 앞: [예외와 자원](/java/notes/06-exceptions-resources).

## 실습 체크리스트

- [ ] `LinkedList.get(i)` 를 반복 호출하는 코드와 `ArrayList` 를 비교 측정해 차이를 재현
- [ ] for-each 안에서 `remove` 해 `ConcurrentModificationException` 을 보고, `removeIf`·`Iterator.remove()` 로 고친다
- [ ] `Arrays.asList(arr)` 의 `set` 이 원본 배열을 바꾸고 `add` 는 실패하는 것을 확인
- [ ] `List.of(1, null)` 이 NPE 인 것과 `stream().toList()` 는 null 을 허용하는 것을 비교
- [ ] `ArrayDeque` 로 스택과 큐를 구현하고 `Stack` 클래스 대신 쓴다
