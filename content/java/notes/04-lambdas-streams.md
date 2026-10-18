---
title: "람다·함수형 인터페이스·스트림 — 지연 평가, 수집기, 병렬 스트림의 함정"
chapter: "1부 · 현대 자바 언어"
order: 4
level: 중급
summary: "람다가 컴파일되는 방식(invokedynamic, 익명 클래스와의 차이), 표준 함수형 인터페이스와 메서드 참조, 실질적 final 캡처, 스트림 파이프라인의 지연 평가와 단락(peek 로 확인), 중간·최종 연산, 수집기(groupingBy·partitioningBy·toMap 의 중복 키), Optional 의 올바른 쓰임, 그리고 병렬 스트림이 공용 ForkJoinPool 을 쓰며 공유 컬렉션을 깨뜨리는 문제"
tags: [Java, 람다, 스트림, 함수형 인터페이스, Collectors, Optional, 병렬 스트림, ForkJoinPool]
experiments: []
---

## 람다는 무엇으로 컴파일되나

```java
Comparator<String> byLen = (a, b) -> Integer.compare(a.length(), b.length());
```

람다는 **함수형 인터페이스**(추상 메서드가 하나인 인터페이스)의 구현을 짧게 쓰는 문법이다. 예전 익명 클래스와 비슷해 보이지만 컴파일 방식이 다르다.

| | 익명 클래스 | 람다 |
|---|---|---|
| 클래스 파일 | `Outer$1.class` 가 하나씩 생김 | 없음 — 본문은 `Outer` 안의 private 정적 메서드 |
| 생성 | `new` 로 매번 객체 | `invokedynamic` 이 첫 호출에 구현 클래스를 만들고, 캡처가 없으면 **싱글턴** 재사용 |
| `this` | 익명 클래스 자신 | 바깥 클래스 |
| 상태(필드) | 가질 수 있음 | 없음 |

캡처가 없는 람다는 객체 생성이 없어 아주 싸다. 지역 변수를 캡처하면 그 값을 담은 객체가 매번 만들어진다.

### 실질적 final

람다는 지역 변수를 **값으로** 캡처한다. 그래서 캡처하는 변수는 대입이 한 번뿐이어야 한다(실질적 final).

```java
int count = 0;
list.forEach(x -> count++);     // 컴파일 오류
```

카운터가 필요하면 `stream().count()`, `AtomicInteger`, 또는 스트림 결과로 계산한다. 배열 한 칸(`int[] c = {0}`)으로 우회할 수 있지만 병렬에서 경합이 생긴다 — 아래 병렬 스트림 절 참고.

### 표준 함수형 인터페이스

| 인터페이스 | 시그니처 | 쓰임 |
|---|---|---|
| `Supplier<T>` | `() → T` | 지연 생성, 기본값 |
| `Consumer<T>` | `T → void` | `forEach` |
| `Function<T,R>` | `T → R` | `map` |
| `Predicate<T>` | `T → boolean` | `filter` |
| `BiFunction<T,U,R>` | `(T,U) → R` | `merge`, `reduce` |
| `UnaryOperator<T>` / `BinaryOperator<T>` | `T → T` / `(T,T) → T` | `replaceAll`, `reduce` |
| 원시 특화 | `IntPredicate`, `ToLongFunction<T>` … | 박싱 회피 |

메서드 참조 네 가지: `String::length`(인스턴스 메서드, 첫 인자가 수신자), `System.out::println`(특정 객체), `Integer::parseInt`(정적), `ArrayList::new`(생성자).

## 스트림 — 선언적 파이프라인

```
소스(컬렉션·배열·범위) → 중간 연산(filter·map·sorted …, 지연) → 최종 연산(collect·count·findFirst …, 실행 시작)
```

### 지연 평가와 단락

최종 연산이 호출되기 전까지 아무것도 실행되지 않는다. 그리고 원소는 **한 개씩 파이프라인 전체를 통과** 한다(단계별로 전체를 처리하지 않는다).

```java
List<String> trace = new ArrayList<>();
Optional<Integer> first = Stream.of(1, 2, 3, 4, 5)
    .peek(x -> trace.add("peek " + x))
    .filter(x -> x % 2 == 0)
    .map(x -> x * 10)
    .findFirst();
```

```
지연 평가: [peek 1, peek 2] → 20
```

`findFirst` 가 2 를 찾자마자 멈춰서 3·4·5 는 아예 보지 않았다(단락). 무한 스트림(`Stream.iterate`)이 가능한 이유다. 반대로 `sorted()` 는 **상태 있는 중간 연산** 이라 모든 원소를 모아야 한다 — 무한 스트림에 쓰면 끝나지 않는다.

| 연산 | 성격 |
|---|---|
| `filter`, `map`, `flatMap`, `peek` | 무상태 중간 |
| `sorted`, `distinct`, `limit`, `skip` | 상태 있는 중간(`limit` 은 단락) |
| `findFirst`, `anyMatch`, `allMatch` | 단락 최종 |
| `collect`, `reduce`, `count`, `forEach` | 최종 |

> `peek` 는 디버깅용이다. 부수 효과를 넣는 곳이 아니다 — JDK 9 부터 `count()` 는 크기를 알 수 있으면 파이프라인을 건너뛰어 `peek` 가 아예 실행되지 않을 수도 있다.

스트림은 **한 번만** 쓸 수 있다.

```
스트림 재사용 → stream has already been operated upon or closed
```

## 수집기

```java
record Emp(String name, String dept, int salary) {}
var emps = List.of(new Emp("a","dev",100), new Emp("b","dev",300), new Emp("c","ops",200));

Map<String, Double> avg = emps.stream()
    .collect(Collectors.groupingBy(Emp::dept, TreeMap::new, Collectors.averagingInt(Emp::salary)));
Map<Boolean, List<String>> part = emps.stream()
    .collect(Collectors.partitioningBy(e -> e.salary() >= 200, Collectors.mapping(Emp::name, Collectors.toList())));
```

```
groupingBy 평균: {dev=200.0, ops=200.0}, partitioningBy: {false=[a], true=[b, c]}
```

`groupingBy(분류, 맵 팩토리, 하위 수집기)` 는 SQL 의 `GROUP BY` 다. 하위 수집기로 `counting()`, `summingLong`, `mapping`, `toSet`, `maxBy` 를 조합한다.

### toMap 의 중복 키

```
toMap 중복 키 → Duplicate key a (attempted merging values 1 and 1)
```

`Collectors.toMap(k, v)` 는 키가 겹치면 예외를 던진다. 운영 데이터에 중복이 하나라도 섞이면 터진다. **병합 함수를 항상 명시**한다: `toMap(k, v, (a, b) -> b)`(나중 값) 또는 `Integer::sum`.

| 원하는 것 | 수집기 |
|---|---|
| 리스트 | `.toList()`(16+, 불변) / `Collectors.toList()`(가변일 수 있음) |
| 개수 세기 | `groupingBy(f, counting())` |
| 키 → 객체(중복 없음 보장) | `toMap(f, identity())` |
| 키 → 객체(중복 가능) | `toMap(f, identity(), (a, b) -> a)` |
| 문자열 합치기 | `joining(", ")` |
| 순서 유지 맵 | `toMap(..., LinkedHashMap::new)` |

## Optional

`Optional` 은 **반환 타입** 에서 "없을 수 있음" 을 표현하려고 만들어졌다.

| 하라 | 하지 마라 |
|---|---|
| `findById(id): Optional<User>` | 필드·매개변수·컬렉션 원소를 Optional 로 |
| `opt.map(User::email).orElse("-")` | `opt.isPresent()` 후 `opt.get()`(null 체크와 다를 게 없다) |
| `orElseGet(() -> 비싼계산())` | `orElse(비싼계산())` — 값이 있어도 항상 계산된다 |
| `orElseThrow(() -> new NotFound(id))` | `Optional.of(null)` (NPE) — `ofNullable` |

## 병렬 스트림의 함정

`.parallel()` 한 줄로 병렬화되지만 세 가지를 알고 써야 한다.

**1) 공유 가변 상태는 깨진다.**

```java
List<Integer> unsafe = new ArrayList<>();
IntStream.range(0, 100_000).parallel().forEach(unsafe::add);   // 경합
List<Integer> safe = IntStream.range(0, 100_000).parallel().boxed().toList();
```

```
병렬 + ArrayList.add 결과 크기 81096 (기대 100000), collect/toList 는 100000
```

원소가 조용히 사라졌다(때로는 `ArrayIndexOutOfBoundsException`). 병렬 스트림에서는 **부수 효과 대신 수집기**로 결과를 만든다. 수집기는 스레드마다 부분 결과를 만들고 마지막에 합친다.

**2) 공용 ForkJoinPool 을 쓴다.** 병렬 스트림은 JVM 전체가 공유하는 `ForkJoinPool.commonPool()`(병렬도 = CPU − 1)에서 돈다. 웹 서버에서 요청마다 병렬 스트림 안에 **블로킹 I/O** 를 넣으면 공용 풀이 다 막혀 다른 요청의 병렬 스트림·`CompletableFuture`(기본 실행기)까지 멈춘다.

**3) 항상 빠르지 않다.** 분할 비용·합치는 비용이 있다. `LinkedList` 나 `Stream.iterate` 는 잘 쪼개지지 않는다. CPU 집약적이고, 원소가 많고(수만 이상), 소스가 잘 쪼개지는(`ArrayList`, 배열, `IntStream.range`) 경우에만 측정 후 쓴다.

| 쓸 만한 경우 | 쓰지 말 경우 |
|---|---|
| 대용량 배열의 CPU 계산(이미지·통계) | 웹 요청 처리 중 I/O |
| 독립적인 원소별 계산 | 순서가 중요한 부수 효과 |
| 배치 작업(전용 풀에서) | 원소가 수백 개 이하 |

> 전용 풀에서 돌리려면 `new ForkJoinPool(4).submit(() -> list.parallelStream()...).get()` 패턴이 있지만, 요즘은 가상 스레드나 명시적 `ExecutorService` 가 의도를 더 잘 드러낸다 → [Executor·CompletableFuture](/java/notes/12-executors-completablefuture).

## 스트림 vs 반복문

스트림이 항상 낫지 않다. 예외 처리(체크 예외를 던지는 람다는 감싸야 한다), 중간에 `break`, 여러 값을 동시에 갱신하는 로직은 반복문이 읽기 쉽다. 성능도 간단한 루프는 반복문이 약간 빠르다 — 차이는 대개 무시할 만하고, 읽기 쉬운 쪽을 고른다.

## 예시로 보기 — 이 프로젝트에서

이 저장소의 TypeScript 코드는 스트림과 같은 파이프라인을 배열 메서드로 쓴다. 차이는 **JS 배열 메서드는 즉시(eager) 평가** 라는 점이다.

```ts
// src/lib/search.ts 의 패턴 — 각 단계가 새 배열을 만든다
hits.filter((h) => h.kind === "note").sort((a, b) => b.score - a.score).slice(0, limit);
```

자바 스트림이라면 `filter → sorted → limit` 이 지연 평가되어 중간 배열을 만들지 않는다(단, `sorted` 는 전부 모은다). 첫 화면이 주제 34개의 노트를 모으는 `src/app/page.tsx` 도 자바로 쓰면 `subjects.stream().map(...).collect(groupingBy(Subject::track))` 가 된다.

### Spring 서비스에서

```java
Map<Long, List<OrderItem>> byOrder = items.stream().collect(groupingBy(OrderItem::orderId));
// N+1 대신: 주문 id 목록으로 아이템을 한 번에 가져와 메모리에서 묶는다 (→ 성능: 데이터 접근 병목)
```

[성능: 데이터 접근 병목](/performance/notes/05-data-access-bottlenecks)의 N+1 해결이 정확히 이 모양이다.

## 실전에서는 어디에 쓰이나

> 람다·스트림은 "조회해서 걸러 묶어 응답한다" 는 거의 모든 백엔드 코드에 쓰인다. 운영 사고는 주로 병렬 스트림, `toMap` 중복 키, Optional 오용에서 나온다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 관리 화면 | 주문을 상태별로 묶어 건수·금액 집계 | `groupingBy(상태, counting())`, `toMap` 은 병합 함수 명시 | SQL `GROUP BY` 로 DB 에서 집계 |
| 서비스 계층의 N+1 해결 | 연관 데이터를 한 번에 조회해 붙이기 | ID 목록 `map` → IN 조회 → `toMap(id, identity())` 로 매핑 | JPA fetch join, 배치 크기 설정 |
| 데이터 배치의 대량 통계 계산 | CPU 집약 계산 가속 | 배열·`IntStream.range` 소스에 측정 후 `parallel()`(전용 풀) | 명시적 `ExecutorService`, Spark 같은 분산 처리 |
| 웹 요청 중 여러 외부 API 호출 | 호출을 동시에 보내 응답 시간 단축 | 병렬 스트림 대신 전용 Executor·가상 스레드 | `CompletableFuture` 조합 |
| 리포지토리 조회 메서드 | "없을 수 있음" 을 반환 타입에 표현 | `Optional<User> findById`, `orElseThrow` | null 반환 + 문서화 |

**이럴 땐 안 맞는다**
- 웹 서버 요청 경로에서 블로킹 I/O 를 병렬 스트림으로: 공용 ForkJoinPool 이 막혀 다른 요청까지 멈춘다 → 전용 Executor·가상 스레드.
- checked 예외·중간 `break`·여러 값 동시 갱신이 얽힌 로직: 반복문이 더 읽기 쉽다.
- 필드·매개변수에 Optional: 설계 의도와 다르다 → 반환 타입에만 쓴다.

**누가 매일 만나나** — 백엔드 개발자가 코드 리뷰에서 매일 만나고, 운영 중 `IllegalStateException: Duplicate key` 나 "가끔 원소가 사라짐" 을 볼 때 이 노트로 돌아온다.

**면접·실무 단골 질문**
- Q. 스트림의 지연 평가란? → 최종 연산 전엔 아무것도 실행되지 않고, 원소가 한 개씩 파이프라인 전체를 통과하며, `findFirst` 같은 연산은 중간에 멈춘다(단락).
- Q. 웹 서버에서 병렬 스트림을 조심해야 하는 이유는? → JVM 전체가 공용 ForkJoinPool 을 공유해 블로킹 하나가 다른 요청을 막고, 공유 가변 상태는 깨진다.

## 정리

- 람다는 `invokedynamic` 으로 연결되고, 캡처 없는 람다는 객체를 만들지 않는다.
- 스트림은 지연·한 원소씩·단락. `sorted` 같은 상태 연산과 한 번만 쓸 수 있다는 점에 주의.
- `toMap` 은 병합 함수를 항상 주고, `Optional` 은 반환 타입에만.
- 병렬 스트림: 부수 효과 금지, 공용 풀 블로킹 금지, 측정 후에만.

다음: [sealed·패턴 매칭·switch 식](/java/notes/05-sealed-pattern-matching). 앞: [제네릭과 타입 소거](/java/notes/03-generics-type-erasure).

## 실습 체크리스트

- [ ] `peek` 로 지연 평가와 단락을 직접 확인하고, `sorted()` 를 중간에 넣으면 순서가 어떻게 바뀌는지 본다
- [ ] 중복 키가 있는 데이터로 `toMap` 을 호출해 예외를 재현하고 병합 함수로 고친다
- [ ] `parallel().forEach(list::add)` 로 원소 유실을 재현하고 `toList()` 로 고친다
- [ ] `ForkJoinPool.commonPool().getParallelism()` 을 확인하고, `-Djava.util.concurrent.ForkJoinPool.common.parallelism=2` 로 바꿔 본다
- [ ] 반복문과 스트림으로 같은 집계를 써 보고 어느 쪽이 읽기 쉬운지 비교한다
