---
title: "타입·객체·불변성 — 원시 vs 참조, equals/hashCode 계약, record"
chapter: "1부 · 현대 자바 언어"
order: 2
level: 기초
summary: "원시 타입과 참조 타입이 메모리에서 어떻게 다른지, 박싱·언박싱과 Integer 캐시(127 == 127 은 true, 128 == 128 은 false), 객체 헤더와 크기, equals/hashCode 계약과 그것을 어겼을 때 HashSet 이 원소를 못 찾는 사고, 해시에 쓰는 필드를 바꾸는 키, record 가 자동으로 해 주는 것과 안 해 주는 것, 방어적 복사로 만드는 진짜 불변 객체"
tags: [Java, 원시 타입, 박싱, equals, hashCode, record, 불변성, 방어적 복사]
experiments: [java-hashmap-internals]
---

## 두 종류의 값

자바의 모든 값은 **원시(primitive)** 아니면 **참조(reference)** 다.

| | 원시 | 참조 |
|---|---|---|
| 종류 | `boolean byte short char int long float double` (8개) | 그 외 전부(객체·배열·`String`·`Integer`) |
| 변수에 든 것 | 값 자체 | 힙에 있는 객체를 가리키는 주소 |
| `null` | 불가 | 가능 |
| `==` | 값 비교 | **같은 객체인가** 비교 |
| 기본값(필드) | `0`, `false` | `null` |
| 제네릭 타입 인자 | 불가(`List<int>` 안 됨) | 가능 |

원시 값은 스택 프레임이나 객체 필드 안에 **그대로** 들어간다. `int[] a = new int[1000]` 은 4KB 짜리 연속 메모리 하나다. 반면 `Integer[]` 나 `List<Integer>` 는 주소 1000개 + `Integer` 객체 1000개(각각 헤더 포함)다 — 메모리는 몇 배, 캐시 효율은 훨씬 나쁘다.

### 객체는 얼마나 클까

HotSpot(64비트, 압축 참조 기본값)에서 객체는 **헤더(12바이트: 마크 워드 8 + 클래스 포인터 4) + 필드 + 8바이트 정렬 패딩** 이다.

| 객체 | 대략 크기 |
|---|---|
| `new Object()` | 16B |
| `Integer` | 16B (헤더 12 + int 4) |
| `Long` | 24B (헤더 12 + long 8 → 20 → 정렬 24) |
| `String "hello"` | 24B(String) + 24B(byte[5] 배열) ≈ 48B |
| `HashMap` 엔트리 1개 | `Node` 32B + 키·값 객체 |

> 자바 25 의 컴팩트 객체 헤더(Lilliput)는 헤더를 8바이트로 줄인다. 작은 객체가 많은 서비스에서 힙이 10~20% 줄 수 있다. 마크 워드에는 해시값·GC 나이·락 상태가 들어 있다 — 그래서 `synchronized` 와 `hashCode()` 가 객체마다 가능하다.

## 박싱과 Integer 캐시

`int` ↔ `Integer` 변환은 컴파일러가 자동으로 해 준다(오토박싱). 편하지만 두 가지 함정이 있다.

```java
Integer i1 = 127, i2 = 127, j1 = 128, j2 = 128;
System.out.println((i1 == i2) + " " + (j1 == j2) + " " + j1.equals(j2));
```

실행 결과(이 노트의 코드는 전부 `eclipse-temurin:21-jdk` 에서 실제로 돌렸다):

```
127 == 127: true, 128 == 128: false, equals: true
```

`Integer.valueOf` 는 −128~127 을 미리 만들어 둔 캐시에서 돌려준다. 그 범위 밖은 매번 새 객체라 `==` 가 `false` 다. **참조 타입은 항상 `equals` 로 비교한다.** 테스트에서는 작은 숫자만 써서 통과하다가 운영에서 ID 가 128 을 넘는 순간 터지는 버그의 고전이다.

두 번째 함정은 성능이다.

```java
Long sum = 0L;   for (long n = 0; n < 50_000_000; n++) sum += n;   // 매 반복 새 Long
long sum2 = 0L;  for (long n = 0; n < 50_000_000; n++) sum2 += n;  // 원시
```

```
Long 박싱 합계 213 ms vs long 15 ms
```

`sum += n` 은 `sum = Long.valueOf(sum.longValue() + n)` 이 되어 5천만 번 객체를 만든다(JIT 의 탈출 분석이 일부를 없애도 이 정도 차이가 난다). 집계 루프·카운터·대량 데이터에서는 원시 타입과 `IntStream`·`LongStream`, 원시 특화 컬렉션(Eclipse Collections·fastutil)을 고려한다.

| 함정 | 증상 | 대처 |
|---|---|---|
| `==` 로 박싱 값 비교 | 128 이상에서만 false | `equals`, 또는 원시로 언박싱 후 비교 |
| `null` 언박싱 | `Integer x = map.get(k); int y = x;` → NPE | `getOrDefault`, `Optional` |
| 삼항 연산자 언박싱 | `flag ? 1 : nullableInteger` → NPE | 양쪽 타입을 맞춘다 |
| 루프 안 박싱 | GC 압박·느림 | 원시 타입·원시 스트림 |

## equals 와 hashCode 의 계약

`Object.equals` 의 계약은 다섯 가지다: **반사성**(x.equals(x)), **대칭성**, **추이성**, **일관성**(바뀌지 않으면 같은 답), `x.equals(null) == false`. 그리고 가장 자주 어겨지는 규칙:

> `a.equals(b)` 가 참이면 `a.hashCode() == b.hashCode()` 여야 한다.

이걸 어기면 해시 기반 컬렉션이 깨진다. `HashSet`·`HashMap` 은 **해시로 버킷을 먼저 고르고, 그 버킷 안에서만 `equals` 로 찾기** 때문이다([HashMap 내부](/java/notes/08-hashmap-internals)).

```java
static final class Point {                 // equals 만 재정의, hashCode 는 잊음
    final int x, y;
    Point(int x, int y) { this.x = x; this.y = y; }
    @Override public boolean equals(Object o) { return o instanceof Point p && p.x == x && p.y == y; }
}
Set<Point> s = new HashSet<>(); s.add(new Point(1, 2));
System.out.println(s.contains(new Point(1, 2)));   // false!
```

```
hashCode 없는 Point contains: false
```

두 `Point` 는 `equals` 로는 같지만 `Object.hashCode()`(대개 객체마다 다른 값)가 달라 다른 버킷을 본다. 컴파일도 테스트도 조용히 통과하고, 운영에서 "캐시에 넣었는데 못 찾는다", "중복 제거가 안 된다" 로 나타난다.

### 해시에 쓰는 필드를 바꾸면

```java
Set<MutableKey> m = new HashSet<>();
MutableKey k = new MutableKey(1); m.add(k);
k.id = 2;                                // 해시에 쓰는 필드 변경
System.out.println(m.contains(k) + " size=" + m.size());
```

```
변경된 키 contains(k): false, size=1
```

원소는 여전히 집합 안에 있지만(size=1) 옛 해시의 버킷에 있어 아무도 찾지 못한다. 지울 수도 없다 — 메모리 누수의 한 형태다. **해시 키는 불변이어야 한다.**

## record — 값 객체를 한 줄로

```java
record P(int x, int y) {}
```

컴파일러가 만들어 주는 것:

| 생성됨 | 설명 |
|---|---|
| `private final` 필드 | `x`, `y` |
| 정식 생성자 | `P(int x, int y)` |
| 접근자 | `x()`, `y()` (get 접두어 없음) |
| `equals`/`hashCode` | 모든 구성 요소로 |
| `toString` | `P[x=1, y=2]` |

```
record P contains: true P[x=1, y=2]
```

record 가 **해 주지 않는 것**: 깊은 불변성. 구성 요소가 `List` 같은 가변 객체면 바깥에서 그 리스트를 바꿀 수 있다. 정식 생성자를 **간결한 형태(compact constructor)** 로 써서 방어적 복사와 검증을 넣는다.

```java
record Order(String id, List<String> items) {
    Order {                                  // 간결한 생성자: 매개변수를 다시 대입할 수 있다
        Objects.requireNonNull(id);
        items = List.copyOf(items);          // 방어적 복사 + 불변 리스트
    }
}
List<String> src = new ArrayList<>(List.of("a"));
Order o = new Order("o1", src);
src.add("b");                                // 원본을 바꿔도
System.out.println(o.items());               // [a]
o.items().add("c");                          // UnsupportedOperationException
```

```
원본 수정 후 order.items=[a]
items.add → UnsupportedOperationException
```

| record 를 쓸 때 | 일반 클래스를 쓸 때 |
|---|---|
| DTO, API 요청·응답, 이벤트, 키, 결과 튜플 | 상태가 바뀌는 엔티티(JPA `@Entity`), 상속 계층, 지연 초기화 |
| 값으로 비교되어야 하는 것 | 정체성(id)으로 비교되어야 하는 것 |

> JPA 엔티티를 record 로 만들 수 없는 이유: 엔티티는 기본 생성자·가변 필드·프록시(상속)가 필요하다. 엔티티는 클래스로, API 경계의 DTO 는 record 로 나누는 것이 정석이다.

## 불변 객체 설계 체크리스트

1. 모든 필드 `private final`.
2. 세터 없음. 바꾸려면 새 객체를 돌려준다(`withPrice(...)`).
3. 클래스를 `final` 로(또는 record) — 하위 클래스가 가변성을 몰래 넣지 못하게.
4. 가변 구성 요소는 생성자에서 **복사해 들어오고**, 접근자는 **복사본이나 불변 뷰**를 돌려준다.
5. `this` 를 생성자 밖으로 새지 않게(리스너 등록 등) — 덜 만들어진 객체가 공개되면 [JMM 의 안전한 공개](/java/notes/10-threads-jmm) 보장이 깨진다.

불변 객체는 **스레드 간에 공유해도 동기화가 필요 없다**. `final` 필드는 생성자가 끝나면 다른 스레드에 올바르게 보이는 것이 JMM 으로 보장된다(final 필드 의미론). 동시성 버그의 상당수는 "공유하지 않거나, 불변으로 공유한다" 로 사라진다(→ [동시성](/concurrency)).

### 문자열은 불변이다

`String` 은 불변이라 해시를 한 번 계산해 캐시하고, 문자열 상수 풀에서 공유할 수 있다. 대신 반복문 안에서 `s += x` 는 매번 새 문자열을 만든다 — 루프에서는 `StringBuilder`. (단순한 `a + b + c` 한 줄은 컴파일러가 `invokedynamic` 기반 연결로 최적화하므로 걱정할 필요 없다.)

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 Redis 키(`quiz:stats:<subject>`, `progress:read`)는 **문자열이 곧 정체성** 이다. 자바로 같은 일을 할 때 복합 키를 `subject + ":" + slug` 문자열로 만들 수도, `record QuizKey(String subject, String slug)` 로 만들 수도 있다. record 쪽이 타입 안전하고 `equals`/`hashCode` 가 자동이다. 문자열 연결은 구분자 충돌(`a:b` + `c` vs `a` + `b:c`) 위험이 있다.
- Kafka 메시지 키나 이벤트(→ [이벤트 소싱](/event-sourcing))를 자바로 표현할 때 record 가 딱 맞는다: 불변, 값 비교, `toString` 로그.
- 실험실의 [HashMap 내부 실험](/java/lab/java-hashmap-internals)은 `hashCode` 가 상수(42)인 키로 조회 시간이 키 수에 비례해 늘어나는 것을 보여 준다 — "계약은 지켰지만 분포가 나쁜" 경우다. 위의 `Point` 는 "계약 자체를 어긴" 경우다. 둘 다 HashMap 을 망가뜨리지만 증상이 다르다(느려짐 vs 못 찾음).

### Spring 서비스에서

```java
public record CreateOrderRequest(@NotBlank String userId, @NotEmpty List<Item> items) {
    public CreateOrderRequest { items = List.copyOf(items); }
}
public record Item(String sku, int qty) {}
```

Jackson 2.12+ 은 record 를 생성자로 역직렬화한다. 요청 DTO 를 record 로 두면 컨트롤러·서비스를 지나며 누군가 값을 바꾸는 사고가 원천 차단된다.

## 실전에서는 어디에 쓰이나

> 원시·참조, equals·hashCode, record 는 "값을 어떻게 비교하고 공유하나" 의 문제다. 캐시 키, DTO, 이벤트, 대량 집계 루프처럼 값이 많이 오가는 곳에서 조용한 버그나 GC 압박으로 나타난다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 API 의 요청·응답 DTO | 계층을 지나며 누군가 값을 바꾸는 사고 | record DTO + Jackson 생성자 역직렬화, 가변 리스트는 `List.copyOf` | Lombok `@Value`, 불변 클래스 직접 작성 |
| 핀테크 정산 배치의 금액 합산 | 수천만 건 루프의 박싱으로 느려지고 GC 압박 | `long`·`LongStream` 같은 원시 타입으로 누적 | 원시 특화 컬렉션(fastutil 등) |
| 게임 서버의 복합 키 캐시 | "넣었는데 못 찾는다" | 복합 키를 record 로 — equals/hashCode 자동, 불변 | 문자열 연결 키(구분자 충돌 위험) |
| SaaS 의 도메인 이벤트 발행(Kafka) | 발행한 이벤트가 나중에 바뀌거나 로그가 읽기 어려움 | 이벤트를 record 로: 불변, 값 비교, `toString` 로그 | Avro·Protobuf 생성 클래스 |
| 회원·주문 ID 비교 로직 | 테스트는 통과, 운영에서 ID 128 이상부터 실패 | 박싱 타입은 `equals`, 또는 원시로 언박싱 후 비교 | 정적 분석으로 박싱 `==` 비교 탐지 |

**이럴 땐 안 맞는다**
- JPA 엔티티를 record 로: 기본 생성자·가변 필드·프록시가 필요해 쓸 수 없다 → 엔티티는 클래스, API 경계 DTO 만 record.
- 상속 계층이 필요한 모델: record 는 final 이다 → 일반 클래스, 또는 sealed 인터페이스 + record 조합.

**누가 매일 만나나** — 백엔드 개발자가 DTO·키 클래스를 만들 때와 "Map 에서 못 찾음", "Long 비교가 가끔 틀림" 을 디버깅할 때. 데이터 엔지니어는 대량 집계 코드의 박싱 비용을 프로파일러에서 만난다.

**면접·실무 단골 질문**
- Q. equals 만 재정의하면 무슨 일이 생기나? → 해시 기반 컬렉션이 다른 버킷을 봐서 `contains`·`get` 이 실패한다. hashCode 도 같은 필드로 재정의한다.
- Q. `Integer a = 1000, b = 1000; a == b` 는? → false. −128~127 캐시 밖은 서로 다른 객체다. 참조 타입은 equals 로 비교한다.

## 정리

- 원시는 값, 참조는 주소. `==` 는 참조 비교 — 박싱 값은 항상 `equals`.
- 박싱은 Integer 캐시(−128~127)와 루프 안 객체 생성이라는 두 함정이 있다.
- `equals` 를 재정의하면 `hashCode` 도 반드시. 해시 키는 불변.
- record 는 값 객체의 정답이지만 깊은 불변성은 간결한 생성자의 방어적 복사로 직접 만든다.

다음: [제네릭과 타입 소거](/java/notes/03-generics-type-erasure). 앞: [자바와 JVM 생태계](/java/notes/01-java-jvm-ecosystem).

## 실습 체크리스트

- [ ] `Integer a = 1000, b = 1000; a == b` 와 `-XX:AutoBoxCacheMax=2000` 옵션을 준 경우를 비교해 본다
- [ ] equals 만 재정의한 클래스를 `HashSet` 에 넣고 `contains` 가 false 가 되는 것을 재현한 뒤, `hashCode` 를 추가해 고친다
- [ ] 가변 `List` 를 담은 record 를 만들고, 간결한 생성자에 `List.copyOf` 를 넣기 전후 동작을 비교한다
- [ ] `jshell` 에서 `new P(1,2).equals(new P(1,2))` 와 `==` 를 비교한다
- [ ] [HashMap 내부 실험](/java/lab/java-hashmap-internals)을 돌려 나쁜 hashCode 의 조회 비용 표를 확인한다
