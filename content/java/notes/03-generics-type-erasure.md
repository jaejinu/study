---
title: "제네릭과 타입 소거 — PECS, 와일드카드, 소거가 남기는 흔적"
chapter: "1부 · 현대 자바 언어"
order: 3
level: 중급
summary: "제네릭이 컴파일 시점에만 존재하는 이유(타입 소거)와 그 결과 — List<String> 과 List<Integer> 가 런타임에 같은 클래스, new T() 와 instanceof List<String> 불가, 힙 오염과 나중에 터지는 ClassCastException, 브리지 메서드 — 그리고 와일드카드 extends/super 를 고르는 PECS 규칙, 제네릭 메서드, 경계 타입, 런타임에 타입 정보가 필요할 때의 우회(Class<T> 토큰, 슈퍼 타입 토큰)"
tags: [Java, 제네릭, 타입 소거, 와일드카드, PECS, 브리지 메서드, 힙 오염]
experiments: []
---

## 제네릭이 해 주는 일

제네릭 이전(자바 1.4)의 컬렉션은 `Object` 를 담았다.

```java
List list = new ArrayList();
list.add("a");
String s = (String) list.get(0);   // 매번 캐스팅, 틀리면 런타임 ClassCastException
```

제네릭은 이 캐스팅을 **컴파일러가 대신 검사하고 삽입** 하게 한다. `List<String>` 에 `Integer` 를 넣으려 하면 컴파일 오류가 난다. 즉 제네릭의 본질은 "**컴파일 시점의 타입 검사**" 다.

## 타입 소거 — 런타임에는 제네릭이 없다

자바는 하위 호환을 위해 제네릭 정보를 바이트코드에서 대부분 지운다(타입 소거). `List<String>` 은 런타임에 그냥 `List` 이고, 타입 변수 `T` 는 경계(없으면 `Object`)로 바뀐다. 컴파일러는 꺼낼 때 필요한 캐스트를 자동으로 끼워 넣는다.

```java
List<String> ls = new ArrayList<>();
List<Integer> li = new ArrayList<>();
System.out.println(ls.getClass() == li.getClass());
```

```
같은 런타임 클래스: true
```

### 소거의 결과로 안 되는 것들

| 안 되는 것 | 이유 | 대안 |
|---|---|---|
| `new T()` | 런타임에 T 가 뭔지 모름 | `Supplier<T>` 또는 `Class<T>` 를 받아 `clazz.getDeclaredConstructor().newInstance()` |
| `new T[10]` | 배열은 런타임에 원소 타입을 안다(실체화) — T 를 모름 | `List<T>`, 또는 `(T[]) new Object[n]`(주의) |
| `x instanceof List<String>` | 런타임에 `<String>` 이 없음 | `x instanceof List<?>` 후 원소 검사 |
| `static T field` | 정적 필드는 모든 인스턴스가 공유 — T 가 하나로 정해지지 않음 | 제네릭 메서드 |
| `catch (MyEx<T> e)` | 제네릭 예외 클래스 자체가 금지 | 예외는 비제네릭으로 |
| 오버로딩 `f(List<String>)`, `f(List<Integer>)` | 소거하면 시그니처가 같다 | 이름을 다르게 |

### 힙 오염 — 늦게 터지는 오류

로 타입(raw type)이나 경고를 무시한 캐스팅으로 제네릭 컬렉션에 엉뚱한 타입이 들어갈 수 있다. 런타임에 막을 정보가 없으니 **넣을 때는 조용하고, 꺼낼 때 터진다**.

```java
List<String> ls = new ArrayList<>();
List raw = ls;          // 로 타입 — 경고만
raw.add(42);            // 들어간다
String s = ls.get(0);   // 여기서 ClassCastException (컴파일러가 끼운 캐스트)
```

```
나중에 터지는 ClassCastException: class java.lang.Integer cannot be cast to class java.lang.String
```

오류가 발생 지점(add)이 아니라 사용 지점(get)에서 나므로 원인을 찾기 어렵다. **로 타입은 쓰지 않는다.** 레거시 API 경계에서 꼭 필요하면 `Collections.checkedList(list, String.class)` 로 감싸 넣는 순간 검사하게 할 수 있다.

### 브리지 메서드

```java
interface Box<T> { T get(); }
class StrBox implements Box<String> { public String get() { return "s"; } }
```

소거 후 `Box.get()` 은 `Object get()` 이다. `StrBox` 는 `String get()` 만 정의했으니, 다형성이 동작하려면 `Object get()` 도 있어야 한다. 컴파일러가 **브리지 메서드** 를 몰래 만들어 준다.

```
StrBox 메서드: String get()
StrBox 메서드: Object get()  ← 브리지
```

스택 트레이스에 같은 메서드가 두 번 보이거나, 리플렉션으로 메서드를 나열할 때 "왜 하나 더 있지?" 싶은 것이 이것이다(`Method.isBridge()`).

## 공변·불공변과 와일드카드

배열은 **공변** 이다: `String[]` 는 `Object[]` 의 하위 타입. 그래서 이런 코드가 컴파일된다.

```java
Object[] arr = new String[1];
arr[0] = 42;   // 런타임 ArrayStoreException
```

제네릭은 **불공변** 이다: `List<String>` 은 `List<Object>` 의 하위 타입이 **아니다**. 위 같은 사고를 컴파일 시점에 막기 위해서다. 그런데 그러면 "숫자 리스트면 아무거나 받는 메서드" 를 어떻게 쓰나? 와일드카드다.

| 표기 | 뜻 | 할 수 있는 것 |
|---|---|---|
| `List<? extends Number>` | Number 또는 그 하위 타입의 리스트 | **꺼내기**(Number 로) — 넣기는 불가(null 제외) |
| `List<? super Integer>` | Integer 또는 그 상위 타입의 리스트 | **넣기**(Integer) — 꺼내면 Object |
| `List<?>` | 무언가의 리스트 | 꺼내면 Object, 넣기 불가 |

### PECS — Producer Extends, Consumer Super

> 매개변수가 값을 **생산(꺼내 줌)** 하면 `extends`, **소비(받아 넣음)** 하면 `super`.

```java
static <T> void copy(List<? super T> dst, List<? extends T> src) {
    for (T t : src) dst.add(t);
}
static double sum(Collection<? extends Number> xs) {
    double s = 0; for (Number n : xs) s += n.doubleValue(); return s;
}
List<Number> nums = new ArrayList<>();
copy(nums, List.of(1, 2));      // Integer 리스트 → Number 리스트
copy(nums, List.of(2.5));       // Double 리스트 → Number 리스트
```

```
PECS copy → [1, 2, 2.5], sum=5.5
```

`Collections.copy`, `Collections.max(Collection<? extends T>, Comparator<? super T>)`, `Stream.map(Function<? super T, ? extends R>)` 같은 표준 API 시그니처가 전부 이 규칙을 따른다. API 를 만들 때 매개변수에 와일드카드를 쓰면 **호출하는 쪽이 훨씬 유연해진다**. 반대로 **반환 타입에는 와일드카드를 쓰지 않는다** — 받는 쪽이 다루기 불편해진다.

## 제네릭 메서드와 경계

```java
// T 는 Comparable<? super T> 여야 한다 — 상위 타입이 비교를 구현해도 되게
static <T extends Comparable<? super T>> T max(List<? extends T> xs) {
    T best = xs.get(0);
    for (T x : xs) if (x.compareTo(best) > 0) best = x;
    return best;
}
```

`<T extends Comparable<? super T>>` 가 낯설어 보이지만 이유가 있다. `java.sql.Timestamp` 처럼 `Comparable<Date>` 를 구현한 하위 클래스도 받아들이려면 `super` 가 필요하다.

여러 경계: `<T extends Number & Comparable<T>>` — 클래스는 하나, 인터페이스는 여러 개.

## 런타임에 타입이 필요할 때

JSON 역직렬화처럼 "이 문자열을 `List<Order>` 로 만들어라" 는 런타임에 타입 정보가 필요하다. 소거 때문에 `List<Order>.class` 는 쓸 수 없다. 두 가지 우회가 있다.

1. **클래스 토큰**: `mapper.readValue(json, Order.class)` — 비제네릭 타입이면 충분.
2. **슈퍼 타입 토큰**: 익명 하위 클래스를 만들면 그 **상위 타입 선언의 제네릭 정보는 클래스 파일에 남는다**(소거되지 않는 몇 안 되는 곳).

```java
// Jackson
List<Order> orders = mapper.readValue(json, new TypeReference<List<Order>>() {});
// Spring
ResponseEntity<List<Order>> r = rest.exchange(url, GET, null, new ParameterizedTypeReference<List<Order>>() {});
```

`{}` 가 중요하다 — 익명 클래스를 만들어 `getGenericSuperclass()` 로 `List<Order>` 를 꺼낸다.

> 클래스·필드·메서드 **선언** 의 제네릭 정보(`class Repo implements Crud<Order, Long>`)는 클래스 파일의 `Signature` 속성에 남는다. Spring Data 가 `Repository<Order, Long>` 에서 엔티티 타입을 알아내는 방법이 이것이다. 지워지는 것은 **지역 변수·객체 인스턴스** 의 타입 인자다.

## 실무 지침

| 상황 | 권장 |
|---|---|
| 컬렉션을 받는 메서드 | `List<? extends T>`(읽기) / `Collection<? super T>`(쓰기) |
| 반환 타입 | 구체 타입(`List<T>`), 와일드카드 금지 |
| `@SuppressWarnings("unchecked")` | 가장 좁은 범위(변수 선언 한 줄)에, 왜 안전한지 주석과 함께 |
| 가변 인자 + 제네릭 `T...` | 힙 오염 경고 — 안전하면 `@SafeVarargs`(final/static 메서드) |
| 로 타입 | 쓰지 않는다 |

## 예시로 보기 — 이 프로젝트에서

이 사이트는 TypeScript 로 되어 있다. TypeScript 의 제네릭도 **컴파일 후 완전히 사라진다**(자바보다 더 철저한 소거 — 자바처럼 선언 시그니처를 남기지도 않는다). 그래서 이 저장소의 코드도 런타임 검증이 필요한 곳에서는 직접 검사한다.

- `src/lib/quiz.ts` 는 `JSON.parse(...) as QuizCard[]` 로 읽는다 — 자바의 로 타입 캐스트와 같은 위험(잘못된 JSON 이면 사용 지점에서 터짐)이다. 그 빈틈을 CI 의 `tests/content.test.ts` 가 런타임 검증으로 메운다. 자바라면 `TypeReference<List<QuizCard>>` 로 Jackson 이 필드별로 검증하면서 만들어 준다.
- 실험 레지스트리(`src/lab/registry.ts`)가 셸·코드 실험을 하나의 `LabItem` 으로 모으는 방식은, 자바라면 `sealed interface LabItem permits ShellLab, CodeLab` + 패턴 매칭으로 표현하는 것이 자연스럽다 → [sealed·패턴 매칭](/java/notes/05-sealed-pattern-matching).

### Spring 에서 자주 보는 장면

```java
public interface OrderRepository extends JpaRepository<Order, Long> {}   // 선언의 제네릭은 남는다 → 엔티티 타입을 안다
public <T> T get(String key, Class<T> type)                              // 캐시 추상화의 클래스 토큰
```

`RedisTemplate<String, Object>` 로 값을 꺼낼 때 `(Order) template.opsForValue().get(k)` 캐스트가 실패하면, 직렬화기(`Jackson2JsonRedisSerializer` vs `GenericJackson2JsonRedisSerializer`)가 타입 정보를 저장하는지부터 본다 — 소거된 타입을 런타임에 되살리는 방법이 직렬화기마다 다르기 때문이다.

## 정리

- 제네릭은 컴파일 시점 검사다. 런타임에는 대부분 지워진다(선언 시그니처는 남는다).
- 그래서 `new T()`, `instanceof List<String>`, 제네릭 배열이 안 되고, 로 타입은 힙 오염을 낳는다.
- 와일드카드는 PECS: 꺼내면 `extends`, 넣으면 `super`. 반환 타입에는 쓰지 않는다.
- 런타임 타입이 필요하면 `Class<T>` 토큰이나 슈퍼 타입 토큰(`TypeReference`).

다음: [람다·함수형 인터페이스·스트림](/java/notes/04-lambdas-streams). 앞: [타입·객체·불변성](/java/notes/02-types-objects-immutability).

## 실습 체크리스트

- [ ] `List<String>` 과 `List<Integer>` 의 `getClass()` 가 같은 것을 확인
- [ ] 로 타입으로 정수를 넣고, 예외가 add 가 아니라 get 에서 나는 것을 확인. `Collections.checkedList` 로 감싸면 add 에서 나는지 비교
- [ ] `javap -c` 로 제네릭 메서드 호출부에 `checkcast` 가 삽입된 것을 찾는다
- [ ] `copy(List<? super T>, List<? extends T>)` 를 직접 쓰고, 와일드카드를 빼면 어떤 호출이 컴파일 오류가 되는지 확인
- [ ] Jackson 의 `TypeReference` 에서 `{}` 를 빼면 무슨 일이 생기는지 확인
