---
title: "sealed·패턴 매칭·switch 식 — 자바로 대수적 데이터 타입 다루기"
chapter: "1부 · 현대 자바 언어"
order: 5
level: 중급
summary: "switch 문에서 switch 식으로(화살표·yield·폴스루 없음), instanceof 패턴, sealed 클래스·인터페이스로 하위 타입을 닫는 이유, record 패턴으로 분해하기, when 가드, 컴파일러의 완전성 검사가 default 를 없애 주는 원리, Result 같은 합 타입을 자바로 만들기, 그리고 방문자 패턴·if-instanceof 사슬·다형성 메서드와의 비교"
tags: [Java, sealed, 패턴 매칭, switch 식, record 패턴, 대수적 데이터 타입, 완전성 검사]
experiments: []
---

## 왜 필요한가 — 닫힌 선택지

결제 결과는 성공·실패·보류 중 하나다. 모양(Shape)은 원·사각형·정사각형 중 하나다. 이렇게 **선택지가 정해진 데이터** 를 함수형 언어는 대수적 데이터 타입(ADT, 합 타입)으로 표현하고, 처리할 때 **모든 경우를 빠짐없이 다뤘는지 컴파일러가 검사** 한다. 자바 17~21 이 sealed + record + 패턴 매칭으로 이것을 갖게 됐다.

## switch 식

옛 `switch` 문은 폴스루(`break` 를 빼먹으면 다음 case 로 흘러감)와 값을 돌려주지 못하는 문제가 있었다. switch **식** 은 값을 만든다.

```java
int day = 3;
String kind = switch (day) {
    case 6, 7 -> "주말";                       // 여러 값, 화살표 — 폴스루 없음
    default -> {
        String t = "평일";
        yield t + "(" + day + ")";            // 블록에서 값을 돌려줄 때 yield
    }
};
```

```
평일(3)
```

| | switch 문(옛) | switch 식 |
|---|---|---|
| 결과 | 없음(문장) | 값 |
| 폴스루 | 기본 동작(`break` 필요) | 화살표 형태는 없음 |
| 완전성 | 검사 안 함 | 값을 만드는 식이면 **모든 경우를 다뤄야** 컴파일 |
| `null` | NPE | `case null` 을 명시할 수 있음(21) |

## instanceof 패턴

```java
Object o = "hello";
if (o instanceof String str && str.length() > 3)   // 검사와 캐스팅과 바인딩을 한 번에
    System.out.println(str.toUpperCase());
```

```
instanceof 패턴: HELLO
```

`str` 은 조건이 참인 범위에서만 쓸 수 있다(흐름 범위). `equals` 구현이 한 줄이 된다: `return o instanceof Point p && p.x == x && p.y == y;`([타입·객체](/java/notes/02-types-objects-immutability)의 예가 이 형태다).

## sealed — 하위 타입을 닫는다

```java
sealed interface Shape permits Circle, Rect, Square {}
record Circle(double r) implements Shape {}
record Rect(double w, double h) implements Shape {}
record Square(double side) implements Shape {}
```

`permits` 에 적힌 것만 `Shape` 를 구현할 수 있다. 하위 타입은 `final`(record 는 자동), `sealed`, `non-sealed` 중 하나여야 한다.

| 키워드 | 뜻 |
|---|---|
| `final` | 더 이상 확장 불가 |
| `sealed ... permits` | 지정한 것만 확장 |
| `non-sealed` | 이 지점부터 다시 열림(누구나 확장) |

**왜 닫나?** 열린 계층(일반 인터페이스)이면 누군가 나중에 `Triangle` 을 추가할 수 있으니, 컴파일러는 "모든 경우를 다뤘다" 고 판단할 수 없다. 닫으면 판단할 수 있다.

## 패턴 매칭 switch 와 완전성 검사

```java
static double area(Shape s) {
    return switch (s) {                                       // default 없음
        case Circle c -> Math.PI * c.r() * c.r();
        case Rect(double w, double h) when w == h -> w * w;    // 레코드 패턴 + 가드
        case Rect(double w, double h) -> w * h;                // 레코드 패턴(분해)
        case Square sq -> sq.side() * sq.side();
    };
}
```

```
3.14 6.0 4.0 9.0
```

- **타입 패턴** `case Circle c` — 타입 검사와 바인딩.
- **레코드 패턴** `case Rect(double w, double h)` — record 의 구성 요소를 꺼내 바로 쓴다. 중첩도 된다: `case Line(Point(var x1, var y1), Point p2)`.
- **가드** `when ...` — 추가 조건. 가드가 있는 case 는 같은 타입의 가드 없는 case 보다 **앞에** 와야 한다(뒤에 오면 도달 불가로 컴파일 오류).
- **완전성** — `Shape` 가 sealed 이므로 세 하위 타입을 다 다루면 `default` 가 필요 없다.

완전성 검사의 진짜 가치는 **나중에** 나온다. 누군가 `Shape` 에 `Triangle` 을 추가하면, `default` 가 없는 모든 switch 가 **컴파일 오류** 가 된다. "새 결제 수단을 추가했는데 정산 로직 한 곳을 빠뜨린" 사고를 컴파일러가 막는다. 그래서 sealed 계층의 switch 에는 **일부러 default 를 쓰지 않는다** — default 는 이 안전망을 끈다.

> 다른 모듈에서 컴파일된 코드가 새 하위 타입을 만나면? 런타임에 `MatchException` 이 난다. 분리 컴파일 환경에서도 조용히 넘어가지 않는다.

## Result 타입 만들기

예외 대신 "성공 또는 실패" 를 값으로 돌려주는 패턴이다.

```java
sealed interface Result<T> permits Ok, Err {}
record Ok<T>(T value) implements Result<T> {}
record Err<T>(String reason) implements Result<T> {}

static Result<Integer> parse(String s) {
    try { return new Ok<>(Integer.parseInt(s)); }
    catch (NumberFormatException e) { return new Err<>("숫자 아님: " + s); }
}
static String show(Result<Integer> r) {
    return switch (r) {
        case Ok<Integer>(Integer v) -> "ok " + v;
        case Err<Integer>(String why) -> "err " + why;
    };
}
```

```
ok 42 / err 숫자 아님: 4x
```

| 예외로 실패 표현 | Result 로 실패 표현 |
|---|---|
| 호출자가 잊고 안 잡을 수 있음(언체크) | 반환 타입에 드러나 무시하기 어려움 |
| 스택 추적 비용([예외 노트](/java/notes/06-exceptions-resources)) | 객체 하나 |
| 프로그래밍 오류·드문 실패에 적합 | 예상되는 업무 실패(검증 실패, 재고 없음)에 적합 |

## 같은 문제를 푸는 세 가지 방법

| 방법 | 새 **타입** 추가 | 새 **연산** 추가 | 완전성 |
|---|---|---|---|
| 다형성 메서드(`shape.area()`) | 쉬움(클래스 하나) | 어려움(모든 클래스 수정) | 추상 메서드로 강제 |
| 방문자 패턴 | 어려움 | 쉬움 | 강제되지만 코드가 장황 |
| sealed + 패턴 매칭 switch | 컴파일러가 수정할 곳을 다 알려 줌 | 쉬움(switch 하나) | 강제 |

"표현 문제(expression problem)" 의 고전적 축이다. **타입은 거의 안 늘고 연산이 자주 늘면** sealed + switch, **타입이 자주 늘고 연산이 고정이면** 다형성 메서드가 낫다. 결제 수단·이벤트 종류·상태 기계처럼 도메인이 정한 닫힌 집합은 sealed 가 잘 맞는다.

## 상태 기계 예

```java
sealed interface OrderState permits Created, Paid, Shipped, Cancelled {}
record Created() implements OrderState {}
record Paid(String txId) implements OrderState {}
record Shipped(String tracking) implements OrderState {}
record Cancelled(String reason) implements OrderState {}

static OrderState pay(OrderState s, String txId) {
    return switch (s) {
        case Created c -> new Paid(txId);
        case Paid p -> p;                                   // 멱등: 이미 결제됨
        case Shipped sh -> throw new IllegalStateException("배송 후 결제 불가");
        case Cancelled c -> throw new IllegalStateException("취소된 주문: " + c.reason());
    };
}
```

허용되지 않는 전이가 한눈에 보이고, 상태가 추가되면 이 함수가 컴파일 오류로 알려 준다. [이벤트 소싱](/event-sourcing)에서 이벤트를 상태로 접는(fold) 리듀서를 쓸 때도 같은 모양이 된다.

## 예시로 보기 — 이 프로젝트에서

이 저장소의 TypeScript 는 같은 아이디어를 **판별 유니온(discriminated union)** 으로 쓴다.

```ts
// src/lab/registry.ts
export interface LabItem { kind: "shell" | "code"; id: string; ... }
// 사용하는 쪽
exp.kind === "shell" ? <ShellLabRunner ... /> : <CodeLabRunner ... />
```

자바라면 `sealed interface LabItem permits ShellLab, CodeLab` + `switch (item) { case ShellLab s -> ...; case CodeLab c -> ...; }` 가 된다. TypeScript 도 `switch (x.kind)` 에서 `never` 타입으로 완전성 검사를 할 수 있는데, 원리는 같다 — **닫힌 집합이어야 컴파일러가 빠뜨림을 찾을 수 있다**.

AI 도우미의 스트림 이벤트(`text`·`tool_start`·`tool_result`·`usage`·`error`)도 판별 유니온이다. 자바로 옮기면 sealed 인터페이스 + record 다섯 개가 되고, 클라이언트의 이벤트 처리 switch 가 새 이벤트 종류를 빠뜨리면 컴파일이 실패한다.

## 실전에서는 어디에 쓰이나

> 결제 수단·주문 상태·이벤트 종류처럼 도메인이 정한 닫힌 집합을 다루는 코드에서, "새 경우를 추가했는데 한 곳을 빠뜨린" 사고를 컴파일 오류로 바꾸는 도구다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 결제 수단 처리 | 새 결제 수단 추가 시 정산·환불 로직 누락 | `sealed interface PaymentMethod` + default 없는 switch | 다형성 메서드(`method.settle()`) |
| 커머스 주문 상태 기계 | 허용되지 않는 상태 전이 | sealed 상태 + 패턴 매칭 switch 로 전이 함수 작성 | enum + 전이 표, 상태 기계 라이브러리 |
| 이벤트 소싱 리듀서 | 이벤트를 상태로 접을 때 이벤트 종류 누락 | sealed 이벤트 계층 + 레코드 패턴 | 이벤트별 핸들러 등록(방문자 패턴) |
| 재고·검증 같은 예상되는 업무 실패 | 호출자가 예외를 잊고 안 잡는 문제 | `sealed interface Result permits Ok, Err` 반환 | 도메인 예외 + 전역 핸들러 |
| AI 서비스의 스트리밍 이벤트(텍스트·도구 호출·사용량·에러) | 새 이벤트 종류를 처리 코드가 빠뜨림 | sealed 인터페이스 + record, 완전성 검사 | JSON `type` 문자열로 분기 |

**이럴 땐 안 맞는다**
- 플러그인처럼 외부에서 하위 타입이 계속 추가되는 확장 지점: 닫으면 확장할 수 없다 → 열린 인터페이스 + 다형성.
- 타입은 자주 늘고 연산은 고정인 경우: 타입이 늘 때마다 모든 switch 를 고쳐야 한다 → 다형성 메서드(표현 문제의 다른 축).
- 자바 17 미만 런타임에 묶인 서비스: 기능이 없다 → enum·방문자 패턴.

**누가 매일 만나나** — 백엔드 개발자가 결제·주문 도메인 모델을 설계하거나 "상태 하나 추가" PR 을 올릴 때, 리뷰어가 빠진 분기를 찾는 대신 컴파일러에 맡길 때 만난다.

**면접·실무 단골 질문**
- Q. sealed 계층의 switch 에 default 를 쓰지 않는 이유는? → default 가 완전성 검사를 꺼서, 새 하위 타입을 추가해도 컴파일 오류로 드러나지 않는다.
- Q. 예외 대신 Result 타입은 언제 쓰나? → 검증 실패·재고 없음처럼 예상되는 업무 실패에. 프로그래밍 오류는 예외로.

## 정리

- switch 식은 값을 만들고, 폴스루가 없고, 완전성을 검사한다.
- sealed 는 하위 타입을 닫아 "모든 경우" 를 컴파일러가 알 수 있게 한다.
- 레코드 패턴으로 분해하고 `when` 으로 거른다. sealed 계층의 switch 에는 default 를 쓰지 않는다 — 그래야 새 타입이 컴파일 오류로 드러난다.
- 예상되는 업무 실패는 `Result` 같은 합 타입으로, 프로그래밍 오류는 예외로.

다음: [예외 설계와 자원 관리](/java/notes/06-exceptions-resources). 앞: [람다·스트림](/java/notes/04-lambdas-streams).

## 실습 체크리스트

- [ ] 위 `Shape` 에 `Triangle` 을 `permits` 에 추가하고, `default` 없는 switch 가 컴파일 오류를 내는 것을 확인
- [ ] 같은 switch 에 `default` 를 넣으면 오류가 사라지는 것 — 즉 안전망이 꺼지는 것 — 을 확인
- [ ] 가드 있는 `case Rect(...) when` 을 가드 없는 case 뒤로 옮겨 "dominated" 오류를 본다
- [ ] 주문 상태 기계를 sealed + record 로 만들고 허용되지 않는 전이를 예외로 막는다
- [ ] `case null` 을 넣은 switch 와 넣지 않은 switch 에 null 을 넘겨 차이를 본다
