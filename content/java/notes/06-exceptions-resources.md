---
title: "예외 설계와 자원 관리 — checked vs unchecked, try-with-resources, 예외의 비용"
chapter: "1부 · 현대 자바 언어"
order: 6
level: 중급
summary: "Throwable 계층(Error·Exception·RuntimeException)과 checked 예외 논쟁, 언제 무엇을 던질지, 원인 연결(cause)과 정보를 잃지 않는 래핑, try-with-resources 의 닫는 순서와 suppressed 예외, finally 의 함정, 예외 생성 비용의 대부분이 스택 추적 채우기라는 실측(1214 vs 34 ns), 흐름 제어에 예외를 쓰지 말아야 하는 이유, Spring 의 예외 변환·트랜잭션 롤백 규칙"
tags: [Java, 예외, checked exception, try-with-resources, AutoCloseable, suppressed, 스택 추적]
experiments: []
---

## 예외 계층

```
Throwable
├── Error                    ← JVM 문제: OutOfMemoryError, StackOverflowError. 잡지 않는다
└── Exception                ← checked: 메서드 선언에 throws 필수 (IOException, SQLException)
    └── RuntimeException     ← unchecked: 선언 불필요 (NullPointerException, IllegalArgumentException)
```

| | checked | unchecked |
|---|---|---|
| 컴파일러 강제 | 잡거나 `throws` 로 선언해야 함 | 없음 |
| 의도 | 호출자가 **복구할 수 있는** 예상된 실패 | 프로그래밍 오류, 복구 불가 |
| 예 | 파일 없음, 네트워크 끊김 | null 역참조, 잘못된 인자, 상태 위반 |

### checked 예외 논쟁

checked 예외는 "실패를 무시하지 못하게" 하려는 의도였지만 현실에서는 문제가 많았다.

- 람다·스트림과 맞지 않는다: `list.forEach(f -> Files.readString(f))` 는 컴파일 오류(`IOException`).
- 여러 계층을 거치며 `throws` 가 퍼지거나, 귀찮아서 `catch (Exception e) {}` 로 삼키는 최악의 코드가 생긴다.
- 인터페이스에 구현 세부(`SQLException`)가 새어 나온다.

그래서 현대 자바 생태계(Spring·JPA·대부분의 라이브러리)는 **unchecked 를 기본** 으로 쓴다. 표준 라이브러리도 `UncheckedIOException` 을 추가했다. 지침:

| 상황 | 던질 것 |
|---|---|
| 잘못된 인자 | `IllegalArgumentException` (`Objects.requireNonNull` 은 NPE) |
| 지금 상태에서 불가능한 호출 | `IllegalStateException` |
| 지원하지 않는 연산 | `UnsupportedOperationException` |
| 찾는 것이 없음(업무) | 도메인 예외 `OrderNotFoundException extends RuntimeException`, 또는 `Optional`/`Result` |
| 예상되는 업무 실패를 호출자가 꼭 처리해야 함 | 반환 타입으로(`Result`, sealed — [5장](/java/notes/05-sealed-pattern-matching)) |

## 원인을 잃지 않는 래핑

```java
try { Integer.parseInt("abc"); }
catch (NumberFormatException e) {
    throw new IllegalArgumentException("주문 수량 파싱 실패", e);   // e 를 cause 로
}
```

```
주문 수량 파싱 실패 ← cause: For input string: "abc"
```

스택 트레이스에 `Caused by:` 로 원래 예외가 이어진다. 가장 흔한 실수는 `new X("실패: " + e.getMessage())` 처럼 **원인을 버리는 것** 이다 — 운영 로그에서 진짜 원인(어느 줄, 어떤 값)이 사라진다.

| 하지 마라 | 대신 |
|---|---|
| `catch (Exception e) {}` 빈 catch | 최소한 로그, 대개는 그냥 던지게 둔다 |
| `e.printStackTrace()` | 로거(구조화 로그, trace_id 포함 — [관측성: 로그](/observability/notes/05-logging-loki)) |
| 같은 예외를 잡고 로그하고 다시 던짐 | 로그는 **한 곳**(최상위 핸들러)에서 — 아니면 같은 오류가 5번 찍힌다 |
| `catch (Throwable t)` | `Error` 까지 잡지 않는다(OOM 후 계속 도는 좀비) |
| 원인 없이 새 예외 | 생성자에 `cause` 전달 |

## try-with-resources

`AutoCloseable` 을 구현한 자원(파일·소켓·DB 연결·락 래퍼)은 `try (...)` 에 선언하면 블록을 어떻게 나가든 닫힌다.

```java
static final class Res implements AutoCloseable {
    final String name;
    Res(String n) { name = n; System.out.println("open " + n); }
    @Override public void close() { System.out.println("close " + name); throw new IllegalStateException("close 실패 " + name); }
}
try (Res r1 = new Res("A"); Res r2 = new Res("B")) {
    throw new RuntimeException("본문 실패");
} catch (RuntimeException e) {
    System.out.println("잡힌 예외: " + e.getMessage());
    for (Throwable s : e.getSuppressed()) System.out.println("  suppressed: " + s.getMessage());
}
```

```
open A
open B
close B
close A
잡힌 예외: 본문 실패
  suppressed: close 실패 B
  suppressed: close 실패 A
```

세 가지를 확인할 수 있다.

1. **역순으로 닫는다** — 나중에 연 B 를 먼저. 의존하는 자원(커넥션 → 스테이트먼트)이 올바른 순서로 정리된다.
2. **본문 예외가 우선**한다. `close` 에서 난 예외는 버려지지 않고 `getSuppressed()` 에 붙는다.
3. 옛 `try/finally` 에서는 `finally` 의 `close()` 예외가 **본문 예외를 덮어써** 진짜 원인이 사라졌다. try-with-resources 가 이 문제를 고쳤다.

### finally 의 함정

```java
try { return 1; } finally { return 2; }    // 2 를 돌려주고, try 안의 예외도 삼킨다
```

`finally` 안에서 `return`·`throw` 를 하지 않는다. `finally` 는 정리만 한다.

## 예외의 비용

예외를 만드는 비용의 대부분은 **스택 추적 채우기**(`fillInStackTrace`)다 — 현재 호출 스택을 전부 걸어 프레임 정보를 기록한다.

```java
// 스택 추적 생략: (message, cause, enableSuppression=false, writableStackTrace=false)
static final class Fast extends RuntimeException { Fast(String m) { super(m, null, false, false); } }
```

```
예외 생성+throw 200000회: 스택 추적 1214 ns/회, 생략 34 ns/회
```

약 35배 차이다. 이 실험은 스택이 얕다 — 실제 Spring 서비스는 호출 스택이 100단계를 넘기도 해서 더 비싸다.

| 결론 | |
|---|---|
| 흐름 제어에 예외 쓰지 않기 | "없으면 예외" 를 루프에서 수천 번 → `Optional`·`contains` 먼저 |
| 검증 실패가 많은 API | 예외 대신 결과 객체로(대량 입력 검증) |
| 스택 추적 생략 | 정말 뜨거운 경로의 "예상된" 예외에만. 디버깅 정보를 잃는다 |
| JIT 의 함정 | 같은 곳에서 수천 번 난 내장 예외(NPE 등)는 JIT 가 스택 없는 미리 만든 예외로 바꿀 수 있다 — 로그에 메시지·스택이 비어 있으면 `-XX:-OmitStackTraceInFastThrow` |

## 업무 예외 설계

```java
public abstract class DomainException extends RuntimeException {
    private final String code;                      // 클라이언트가 분기할 기계용 코드
    protected DomainException(String code, String message) { super(message); this.code = code; }
    public String code() { return code; }
}
public final class InsufficientStockException extends DomainException {
    public InsufficientStockException(String sku, int requested, int available) {
        super("STOCK_INSUFFICIENT", "재고 부족 sku=%s 요청=%d 재고=%d".formatted(sku, requested, available));
    }
}
```

- 메시지에 **값**(어떤 sku, 몇 개)을 넣는다. "재고 부족" 만으로는 디버깅할 수 없다.
- 개인정보·비밀은 넣지 않는다(로그로 흘러간다).
- 기계용 `code` 는 API 에러 응답의 `type`(RFC 9457 Problem Details)으로 이어진다 → [API 설계: 에러·재시도](/api-design/notes/04-errors-retries-deadlines).

## 예시로 보기 — 이 프로젝트에서

이 사이트의 서버 코드(TypeScript)도 같은 원칙을 따른다.

- 실험 러너는 각 단계 실패를 잡아 **결과 객체**(`ok: false, error`)로 바꾼다 — 실험 실패는 예상되는 결과이지 서버 오류가 아니기 때문이다. 자바라면 `Result` 합 타입이다.
- 데드맨 스위치(`src/lib/deadman.ts`)를 쓰는 실험은 `try { 주입 } finally { 원복; guard.disarm() }` 구조다. 자바의 try-with-resources 로 옮기면 `try (var g = armUnpause(...)) { ... }` 로, `close()` 가 원복을 맡는 자원이 된다 — **정리를 잊을 수 없게 만드는 것** 이 핵심이다.
- `src/lib/lab-history.ts` 는 이력 저장이 실패해도 실험 결과에 영향을 주지 않도록 예외를 삼키되, 그 이유를 주석으로 남긴다. "삼키는 catch" 는 의도와 이유가 분명할 때만 쓴다.

### Spring 에서

| 주제 | 알아야 할 것 |
|---|---|
| `@Transactional` 롤백 | 기본은 **unchecked 예외만 롤백**. checked 예외는 커밋된다 → `rollbackFor = Exception.class` |
| 예외 변환 | Spring 이 `SQLException` 을 `DataAccessException`(unchecked) 계층으로 변환 — `DuplicateKeyException` 등 |
| 전역 처리 | `@RestControllerAdvice` + `@ExceptionHandler` 에서 한 번만 로그하고 Problem Details 로 응답 |
| 자원 | `JdbcTemplate`·`RestClient` 가 연결을 닫아 주지만, 직접 연 `InputStream` 은 try-with-resources |

## 실전에서는 어디에 쓰이나

> 예외 설계는 운영 로그에서 원인을 찾을 수 있는지, 트랜잭션이 롤백되는지, 자원이 새는지를 정한다. 장애 대응 때 가장 먼저 읽는 것이 스택 트레이스와 `Caused by:` 체인이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 서비스(Spring) | checked 예외가 나도 롤백되지 않아 반쯤 저장된 주문 | unchecked 도메인 예외, 또는 `rollbackFor = Exception.class` | 결과 타입으로 실패 반환 후 명시적 처리 |
| 공개 API 의 에러 응답 | 일관된 에러 형식, 로그는 한 번만 | `@RestControllerAdvice` 에서 로그 + Problem Details(RFC 9457) | 컨트롤러마다 try/catch |
| 엑셀 업로드·대량 입력 검증 | 수천 건 실패마다 예외를 만드는 비용 | 예외 대신 검증 결과 객체에 누적 | 스택 추적 생략 예외(뜨거운 경로만) |
| 파일·소켓·DB 연결을 직접 다루는 배치 | 예외 경로의 자원 누수 → 커넥션 고갈 | try-with-resources, close 예외는 suppressed 로 보존 | `JdbcTemplate` 같은 프레임워크 템플릿에 위임 |
| 운영 로그의 "메시지 없는 NPE" | JIT 가 미리 만든 예외로 바꿔 스택 정보 손실 | `-XX:-OmitStackTraceInFastThrow` | 같은 예외의 첫 발생 로그 찾기 |

**이럴 땐 안 맞는다**
- 흐름 제어(없으면 예외 → 루프에서 수천 번): 스택 추적 비용이 크고 읽기 어렵다 → `Optional`·`contains` 로 먼저 확인.
- 모든 계층에서 잡고 로그하고 다시 던지기: 같은 오류가 여러 번 찍혀 로그가 오염된다 → 최상위 핸들러 한 곳에서만 로그.

**누가 매일 만나나** — 백엔드 개발자가 장애 로그의 `Caused by:` 를 따라 내려갈 때, SRE 가 Loki 에서 같은 에러가 다섯 번씩 찍힌 노이즈나 원인이 잘린 메시지를 볼 때 만난다.

**면접·실무 단골 질문**
- Q. Spring `@Transactional` 은 어떤 예외에 롤백하나? → 기본은 unchecked(RuntimeException·Error)만. checked 예외는 커밋된다.
- Q. try-with-resources 가 try/finally 보다 나은 점은? → 역순으로 닫고, 본문 예외를 우선하며, close 예외를 suppressed 로 보존해 원인이 덮이지 않는다.

## 정리

- 프로그래밍 오류는 unchecked, 예상되는 업무 실패는 도메인 예외 또는 반환 타입. 빈 catch 금지, 원인(cause)은 항상 연결.
- try-with-resources: 역순으로 닫고, 본문 예외가 우선하며, close 예외는 suppressed 로 남는다.
- 예외 비용의 대부분은 스택 추적. 흐름 제어에 쓰지 않는다.
- Spring `@Transactional` 은 기본적으로 checked 예외에 롤백하지 않는다.

다음: 2부 [List 계열 내부](/java/notes/07-list-internals). 앞: [sealed·패턴 매칭](/java/notes/05-sealed-pattern-matching).

## 실습 체크리스트

- [ ] 위 `Res` 예제로 닫는 순서와 suppressed 예외를 확인하고, 옛 try/finally 로 바꿨을 때 원인 예외가 사라지는 것을 재현
- [ ] `writableStackTrace=false` 예외와 일반 예외의 생성 비용을 직접 측정
- [ ] 원인 없이 감싼 예외와 cause 를 넘긴 예외의 스택 트레이스를 비교
- [ ] Spring 프로젝트에서 `@Transactional` 메서드가 checked 예외를 던질 때 DB 가 롤백되는지 확인
- [ ] `finally { return }` 이 try 안의 예외를 삼키는 것을 확인
