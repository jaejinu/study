---
title: "클래스 로딩과 바이트코드 — javac 가 만든 것을 JVM 이 어떻게 읽어 들이는가"
chapter: "4부 · JVM 내부"
order: 14
level: 심화
summary: ".java 가 .class(바이트코드)가 되고, 클래스 로더 계층(부트스트랩·플랫폼·애플리케이션)이 그것을 찾아 로딩 → 링킹(검증·준비·해석) → 초기화하는 과정, 스택 기반 명령어를 javap 로 직접 읽는 법, 람다·문자열 연결이 invokedynamic 으로 바뀌는 이유, 클래스 로더 누수·NoClassDefFoundError·CDS 까지"
tags: [JVM, 클래스 로더, 바이트코드, javap, invokedynamic, CDS, 링킹]
experiments: [java-jit-warmup]
---

자바 코드는 CPU 가 바로 실행하는 기계어가 아니라 **바이트코드**로 컴파일된다. JVM 은 실행 중에 필요한 클래스를 그때그때 찾아 메모리에 올리고(지연 로딩), 검증한 뒤, 처음 쓰일 때 초기화한다. 이 과정을 알면 `ClassNotFoundException` 과 `NoClassDefFoundError` 의 차이, 앱 서버·플러그인의 클래스 로더 누수, 시작 시간이 긴 이유, 그리고 다음 노트의 [JIT 컴파일](/java/notes/15-jit-compilation)이 무엇을 입력으로 받는지가 보인다.

## 한 장으로 보는 흐름

```
Hello.java ──javac──▶ Hello.class (바이트코드 + 상수 풀 + 메타데이터)
                         │
            ┌────────────┴─────────────┐
            ▼                          │ 처음 참조될 때
     ClassLoader.loadClass()           │ (new, static 호출, 리플렉션 …)
     ① 로딩: 바이트 읽기 → Class 객체   │
     ② 링킹: 검증 → 준비 → (해석)       │
     ③ 초기화: <clinit> (static 블록)   ▼
            인터프리터가 바이트코드 실행 → 자주 쓰이면 JIT 이 기계어로
```

| 단계 | 하는 일 | 실패하면 |
|---|---|---|
| 로딩 | 클래스 이름으로 바이트를 찾아(JAR·디렉터리·모듈·네트워크) `Class` 객체를 만든다 | `ClassNotFoundException`(명시적 로딩), `NoClassDefFoundError`(컴파일 땐 있었는데 실행 땐 없음) |
| 검증 | 바이트코드가 타입·스택 규칙을 지키는지(스택 넘침, 잘못된 형 변환 등) | `VerifyError` |
| 준비 | static 필드 메모리 할당, 기본값(0·null) 채움 | — |
| 해석 | 상수 풀의 심볼 참조(클래스·메서드 이름)를 실제 참조로 바꿈. 보통 처음 쓸 때 게으르게 | `NoSuchMethodError`·`IncompatibleClassChangeError`(라이브러리 버전 불일치) |
| 초기화 | `static` 필드 대입과 `static {}` 블록(`<clinit>`) 실행. 클래스당 한 번, 스레드 안전 | `ExceptionInInitializerError` → 이후 같은 클래스는 `NoClassDefFoundError` |

> **흔한 함정:** static 초기화에서 예외가 한 번 나면 그 클래스는 "초기화 실패" 로 표시되고, 이후 모든 참조가 원인이 안 보이는 `NoClassDefFoundError: Could not initialize class X` 가 된다. 로그에서 **첫 번째** `ExceptionInInitializerError` 를 찾아야 한다.

## 클래스 로더 계층과 부모 위임

| 로더 | 로딩 대상 | 예 |
|---|---|---|
| 부트스트랩 | `java.base` 등 핵심 모듈 (C++ 구현, 자바에선 `null`) | `java.lang.String` |
| 플랫폼 | 나머지 JDK 모듈 | `java.sql`, `java.net.http` |
| 애플리케이션(시스템) | 클래스패스·모듈패스 | 내 코드, 라이브러리 JAR |
| 사용자 정의 | 앱 서버 웹앱별, 플러그인, 핫 리로드 | Tomcat `WebappClassLoader`, Spring Boot `LaunchedClassLoader` |

**부모 위임**: 로더는 먼저 부모에게 묻고, 부모가 못 찾을 때만 직접 찾는다. 그래서 내가 `java.lang.String` 을 만들어 넣어도 부트스트랩의 진짜가 이긴다(보안·일관성). 클래스의 정체성은 **(로더, 이름)** 쌍이라, 같은 이름의 클래스가 두 로더로 로딩되면 서로 다른 타입이다 — `ClassCastException: com.x.Foo cannot be cast to com.x.Foo` 같은 기묘한 에러의 원인.

### 실측 — 이 클래스가 어디서 왔나

```bash
$ java -Xlog:class+load=info Lam | grep -E "Lam|LambdaForm|FileLoader"
[0.006s][info][class,load] java.lang.invoke.LambdaForm source: shared objects file
[0.012s][info][class,load] jdk.internal.loader.URLClassPath$FileLoader source: jrt:/java.base
[0.012s][info][class,load] Lam source: file:/w/
[0.012s][info][class,load] java.lang.invoke.LambdaMetafactory source: shared objects file
$ java -Xlog:class+load=info Lam | grep -c "class,load"
673
```

- `Hello World` 수준의 프로그램도 **클래스 673개**를 로딩한다. 대부분 `source: shared objects file` — 다음 절의 **CDS** 덕에 미리 파싱된 아카이브에서 매핑돼 싸다.
- 내 클래스 `Lam` 만 `file:/w/`(클래스패스)에서 왔다.

## 바이트코드 읽기 — 스택 기반 명령어

JVM 은 레지스터가 아니라 **피연산자 스택**에 값을 올리고 내리며 계산한다. `javap -c` 로 직접 본다. [JIT 워밍업 실험](/java/lab/java-jit-warmup)의 `work()`:

```java
static int work(int x) {
    int h = x;
    for (int i = 0; i < 20; i++) { h = h * 31 + (h >>> 7) ^ i; }
    return h;
}
```

```text
$ javap -c Warmup
  static int work(int);
    Code:
       0: iload_0          // x 를 스택에
       1: istore_1         // h = x (로컬 1)
       2: iconst_0
       3: istore_2         // i = 0 (로컬 2)
       4: iload_2
       5: bipush   20
       7: if_icmpge 28     // i >= 20 이면 28 로 점프
      10: iload_1
      11: bipush   31
      13: imul             // h * 31
      14: iload_1
      15: bipush   7
      17: iushr            // h >>> 7
      18: iadd             // (h*31) + (h>>>7)
      19: iload_2
      20: ixor             // ... ^ i  (연산자 우선순위: + 가 ^ 보다 먼저)
      21: istore_1
      22: iinc     2, 1    // i++
      25: goto     4
      28: iload_1
      29: ireturn
```

| 접두어 | 의미 | 예 |
|---|---|---|
| `i` `l` `f` `d` `a` | int·long·float·double·참조 | `iload`, `aload`, `areturn` |
| `load`/`store` | 로컬 변수 ↔ 스택 | `iload_1` = 로컬 1 을 스택에 |
| `invokevirtual` | 가상(오버라이드 가능) 메서드 호출 | `list.size()` |
| `invokeinterface` | 인터페이스 메서드 | `Runnable.run()` |
| `invokestatic`·`invokespecial` | static·생성자·private·super | `Math.max`, `<init>` |
| `invokedynamic` | 호출 대상을 **처음 실행할 때** 부트스트랩 메서드가 결정 | 람다, 문자열 연결, 레코드의 `toString` |

> 코드에서 `h * 31 + (h >>> 7) ^ i` 는 사람이 읽기에 `(h*31) + ((h>>>7) ^ i)` 처럼 보이지만, 바이트코드를 보면 `+` 를 먼저 하고 `^` 를 나중에 한다. **연산자 우선순위 버그를 바이트코드로 확인**하는 실전 기술이다.

## invokedynamic — 람다와 문자열 연결

```java
Function<Integer,Integer> f = x -> x * 2;
String s = "n=" + a.length + " p=" + new Point(1, 2);
```

```text
$ javap -c -p Lam | grep -E "invokedynamic|lambda\$main"
 0: invokedynamic #7,  0   // InvokeDynamic #0:apply:()Ljava/util/function/Function;
20: invokedynamic #22, 0   // InvokeDynamic #1:makeConcatWithConstants:(ILjava/lang/String;)Ljava/lang/String;
private static java.lang.Integer lambda$main$0(java.lang.Integer);
```

- 람다 본문은 `lambda$main$0` 이라는 **private static 메서드**가 되고, `invokedynamic` 이 처음 실행될 때 `LambdaMetafactory` 가 `Function` 구현 클래스를 **런타임에 만들어** 연결한다. 익명 클래스처럼 `.class` 파일이 늘지 않는다.
- 문자열 `+` 는 JDK 9 부터 `StringBuilder` 체인이 아니라 `StringConcatFactory.makeConcatWithConstants` 로 간다. 연결 전략을 컴파일러가 아니라 **런타임이** 고르므로, JDK 를 올리기만 해도 빨라질 수 있다.
- 첫 호출에 부트스트랩 비용이 있다. 람다가 아주 많은 애플리케이션의 시작 시간이 느린 이유 중 하나(→ [시작 시간 최적화](/java/notes/24-operations-observability)).

## 클래스 데이터 공유(CDS)와 시작 시간

JVM 시작의 상당 부분은 수천 개 클래스를 **찾고·파싱하고·검증**하는 일이다. CDS 는 그 결과를 아카이브 파일로 만들어 두고 다음 실행 때 메모리 매핑한다. 위 실측의 `source: shared objects file` 이 그것이다(JDK 기본 아카이브).

```bash
# 내 앱의 클래스까지 아카이브 (AppCDS, JDK 13+)
java -XX:ArchiveClassesAtExit=app.jsa -jar app.jar     # 한 번 돌려 아카이브 생성
java -XX:SharedArchiveFile=app.jsa -jar app.jar        # 이후 실행: 시작 시간 단축
```

Spring Boot 3.3+ 는 `-Djarmode=tools extract` 로 CDS 친화적 레이아웃을 만들어 준다. JDK 24 의 **AOT 캐시**(JEP 483)는 여기서 더 나아가 로딩·링킹된 상태까지 저장한다.

## 클래스 로더 누수 — 메타스페이스가 계속 자라는 이유

클래스 메타데이터는 힙이 아니라 **메타스페이스**(네이티브 메모리, [메모리 구조](/java/notes/16-memory-layout))에 있고, 클래스는 **그 클래스를 로딩한 로더가 수거될 때만** 내려간다. 그래서:

| 증상 | 원인 | 대처 |
|---|---|---|
| 재배포할 때마다 메타스페이스가 늘고 결국 `OutOfMemoryError: Metaspace` | 옛 웹앱 로더를 누군가(static 캐시, ThreadLocal, 등록 안 해제한 JDBC 드라이버·스레드)가 붙잡음 | 힙 덤프에서 로더의 GC 루트 경로 확인, 프로세스 재시작 배포(컨테이너) |
| 런타임에 클래스를 계속 생성(동적 프록시·스크립트 엔진·직렬화 라이브러리) | 같은 모양의 클래스를 캐시 없이 반복 생성 | 생성 결과 캐시, `-XX:MaxMetaspaceSize` 로 상한을 두어 빨리 실패 |

```bash
jcmd <pid> VM.classloader_stats      # 로더별 클래스 수·메타스페이스 크기
jcmd <pid> GC.class_histogram | head # 힙의 클래스별 인스턴스 수
```

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 Java 실험은 로컬 JDK 없이 `docker run eclipse-temurin:21-jdk` 안에서 `javac`·`javap`·`java` 를 돌린다([실험 코드](/java/lab/java-jit-warmup)). 소스를 임시 디렉터리에 쓰고 `/w` 로 마운트하므로 **클래스패스는 `file:/w/`** — 위 로딩 로그의 `Lam source: file:/w/` 가 그것이다.
- 컨테이너 이미지마다 JDK 기본 CDS 아카이브가 들어 있어, 같은 이미지로 여러 번 돌릴 때 시작 시간이 안정적이다. 이 저장소의 앱 이미지(`Dockerfile`)는 Node 라 해당 없지만, [Docker 빌드 캐시](/docker/notes/03-images-dockerfile)와 같은 발상(한 번 계산한 결과를 레이어·아카이브로 재사용)이다.
- 컨테이너는 짧게 살고 자주 다시 뜬다. 클래스 로딩·JIT 워밍업 비용이 롤링 배포마다 반복되는 셈이라, [Kubernetes 배포 전략](/kubernetes/notes/07-deploy-resources)의 readiness 지연·워밍업 트래픽 설계와 이어진다.

## 정리 표

| 질문 | 답 |
|---|---|
| `ClassNotFoundException` vs `NoClassDefFoundError` | 전자는 `Class.forName` 등 명시적 로딩 실패, 후자는 링크 시점에 사라졌거나 **초기화 실패** 후의 재참조 |
| 바이트코드를 왜 보나 | 컴파일러가 실제로 만든 것(오토박싱, 문자열 연결, 람다, 연산 순서)을 확인 |
| 람다는 익명 클래스와 뭐가 다른가 | `.class` 가 늘지 않고 첫 실행에 invokedynamic 으로 런타임 생성 |
| 시작 시간을 줄이려면 | AppCDS·AOT 캐시 → [GraalVM 네이티브·CRaC](/java/notes/24-operations-observability) 순으로 강해진다 |

## 실습 체크리스트

- [ ] `javap -c -p` 로 람다 하나와 문자열 연결 하나가 `invokedynamic` 이 되는 것 확인
- [ ] `-Xlog:class+load` 로 내 프로그램이 로딩하는 클래스 수를 세고, 그중 `shared objects file` 비율 보기
- [ ] static 블록에서 예외를 던지는 클래스를 두 번 참조해 첫 번째와 두 번째 에러가 어떻게 다른지 확인
- [ ] 실험 `java-jit-warmup` 의 `javap` 출력에서 `work()` 의 루프가 어느 명령어로 되돌아가는지(`goto 4`) 찾기
- [ ] `jcmd <pid> VM.classloader_stats` 로 로더별 클래스 수 보기
- [ ] 다음: [JIT 컴파일](/java/notes/15-jit-compilation) — 이 바이트코드가 어떻게 기계어가 되는가
