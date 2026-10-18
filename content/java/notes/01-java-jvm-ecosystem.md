---
title: "자바와 JVM 생태계 — JDK 배포판, LTS, 그리고 소스가 실행되기까지"
chapter: "1부 · 현대 자바 언어"
order: 1
level: 기초
summary: "자바 = 언어 + 바이트코드 + JVM + 표준 라이브러리라는 네 겹 구조, JDK·JRE·JVM 의 차이, OpenJDK 와 배포판(Temurin·Corretto·Zulu·Oracle) 선택, 6개월 릴리스와 LTS(17·21·25), javac·java·jshell·javap 로 소스가 바이트코드가 되어 실행되는 길, 단일 파일 실행과 모듈 경로, 그리고 이 사이트의 Docker JDK 실험 환경"
tags: [Java, JVM, JDK, OpenJDK, LTS, 바이트코드, javac, jshell, Temurin]
experiments: [java-hashmap-internals]
---

## 자바는 네 겹으로 되어 있다

"자바" 라는 말은 보통 네 가지를 한꺼번에 가리킨다. 이걸 분리해 두면 이후 장(JIT·GC·가상 스레드)이 훨씬 쉽게 읽힌다.

| 겹 | 무엇 | 예 |
|---|---|---|
| 언어 | 문법·타입 시스템(JLS 가 정의) | `record`, 제네릭, 람다, `sealed` |
| 바이트코드 | `.class` 파일 안의 스택 기계 명령(JVMS 가 정의) | `invokevirtual`, `getfield`, `areturn` |
| JVM | 바이트코드를 읽어 실행하는 가상 머신 | HotSpot(인터프리터 + C1/C2 JIT + GC) |
| 표준 라이브러리 | `java.base` 등 모듈 | `java.util`, `java.util.concurrent`, `java.net.http` |

이 분리 덕분에 **Kotlin·Scala·Clojure·Groovy** 도 같은 JVM 위에서 돈다. 언어만 다르고 결과물은 같은 바이트코드다. 반대로 JVM 개선(새 GC, 가상 스레드)은 이 언어들이 공짜로 누린다.

> Node.js 와 비교하면: Node 는 "JavaScript 언어 + V8 엔진 + libuv + Node 표준 라이브러리" 다. V8 이 JS 소스를 직접 받아 내부 바이트코드(Ignition)로 바꾸는 반면, 자바는 **컴파일러(javac)가 미리 바이트코드 파일을 만든다**. 실행 시점에 JIT 가 뜨거운 코드를 기계어로 바꾸는 점은 둘이 같다(→ [Node.js 01편: V8 과 libuv](/nodejs/notes/01-architecture-v8-libuv)).

## JDK · JRE · JVM

| 이름 | 구성 | 언제 |
|---|---|---|
| JVM | 실행 엔진(HotSpot 등) | 항상 JDK/JRE 안에 들어 있다 |
| JRE | JVM + 표준 라이브러리 | 실행만 할 때(현재는 별도 배포가 거의 없고 `jlink` 로 만든다) |
| JDK | JRE + 개발 도구(`javac`, `jar`, `javap`, `jshell`, `jcmd`, `jfr`, `jlink`) | 개발·운영 진단 모두 JDK 를 쓰는 편이 낫다 |

운영 컨테이너에 JRE 만 두면 이미지가 작아지지만 `jcmd`·`jfr` 같은 진단 도구가 없어 장애 때 곤란하다. 실무 타협은 **JDK 기반 이미지 + 필요 시 `jlink` 로 최소 런타임** 이다(→ [Java 4~6부 목차](/java/notes)의 컨테이너·운영 장).

## OpenJDK 와 배포판

자바의 소스는 **OpenJDK** 하나다. 배포판은 그것을 빌드·테스트·지원하는 회사가 다를 뿐 동작은 사실상 같다.

| 배포판 | 특징 |
|---|---|
| Eclipse **Temurin** (Adoptium) | 중립 재단, TCK 통과, 무료 — 이 사이트 실험이 쓰는 `eclipse-temurin:21-jdk` |
| Amazon **Corretto** | AWS 가 장기 패치, AWS 환경 기본값 |
| Azul **Zulu** | 다양한 플랫폼·구버전 지원 |
| **Oracle** OpenJDK / Oracle JDK | 최신 GA 는 무료 빌드, 장기 지원은 라이선스 정책 확인 필요 |
| Microsoft / Red Hat / SAP Machine | 각 클라우드·플랫폼 친화 |

배포판 선택보다 중요한 것은 **버전을 고정하고 보안 패치를 따라가는 것**이다. 이미지 태그를 `21-jdk` 로 두면 패치 릴리스(21.0.x)를 따라가고, `21.0.5_11-jdk` 처럼 고정하면 재현성은 좋지만 갱신을 직접 챙겨야 한다(→ [보안: 컨테이너·공급망](/security/notes/05-container-supply-chain)).

## 릴리스 주기와 LTS

2018년부터 자바는 **6개월마다** 기능 릴리스(3월·9월)를 낸다. 그중 2년에 한 번이 **LTS**(장기 지원)다.

| 버전 | LTS | 주요 기능(이 노트 묶음에서 다루는 것) |
|---|---|---|
| 8 | ✓ | 람다, 스트림, `Optional`, `CompletableFuture` |
| 11 | ✓ | `var`(10), `HttpClient`, 단일 파일 실행 |
| 17 | ✓ | `record`(16), `sealed`, 텍스트 블록, `instanceof` 패턴 |
| 21 | ✓ | **가상 스레드**, `switch` 패턴 매칭, 레코드 패턴, Sequenced Collections, 세대별 ZGC |
| 25 | ✓ | 구조적 동시성·스코프 값(진행 중 기능의 정식화), 컴팩트 객체 헤더 등 |

실무 기준: **신규 서비스는 최신 LTS(21 이상)**. 8·11 에 머문 서비스는 GC·컨테이너 인식·가상 스레드 이점을 놓친다. 비 LTS(22, 23…)는 미리보기 기능을 맛보는 용도다.

미리보기(preview) 기능은 `--enable-preview` 없이는 컴파일조차 안 된다. 운영 코드에 쓰지 않는다는 뜻이다.

## 소스가 실행되기까지

```
Hello.java ──javac──▶ Hello.class (바이트코드) ──java──▶ 클래스 로더 → 검증 → 인터프리터 → (뜨거우면) C1 → C2 기계어
```

```java
// Hello.java
public class Hello {
    public static void main(String[] args) {
        int sum = 0;
        for (int i = 0; i < 10; i++) sum += i;
        System.out.println("sum=" + sum);
    }
}
```

```bash
javac Hello.java          # Hello.class 생성
java Hello                # sum=45
javap -c Hello            # 바이트코드 보기
```

`javap -c` 의 일부:

```
  public static void main(java.lang.String[]);
    Code:
       0: iconst_0
       1: istore_1           // sum = 0
       2: iconst_0
       3: istore_2           // i = 0
       4: iload_2
       5: bipush        10
       7: if_icmpge     20   // i >= 10 이면 탈출
      10: iload_1
      11: iload_2
      12: iadd
      13: istore_1           // sum += i
      14: iinc          2, 1 // i++
      17: goto          4
      20: getstatic     #7   // System.out
      ...
```

바이트코드는 **스택 기계**다. 레지스터 대신 피연산자 스택에 값을 올리고(`iload`) 연산(`iadd`)한다. 이 형식이 CPU 와 무관하기 때문에 "한 번 컴파일, 어디서나 실행" 이 된다. 실제 속도는 JIT 가 이 바이트코드를 CPU 기계어로 다시 컴파일하면서 나온다 — 자세한 것은 4부(JIT·바이트코드)에서.

### 단일 파일 실행과 jshell

자바 11부터 `java Hello.java` 로 컴파일 없이 바로 실행된다(메모리에서 컴파일). 스크립트처럼 실험할 때 유용하고, **이 사이트의 자바 실험도 전부 이 방식**이다.

```bash
java Hello.java           # javac 없이 실행
jshell                    # REPL
jshell> var m = new java.util.HashMap<String,Integer>()
jshell> m.put("a", 1)
$2 ==> null
```

## 클래스패스와 모듈 경로

| | 클래스패스(`-cp`) | 모듈 경로(`--module-path`) |
|---|---|---|
| 단위 | JAR 묶음 | `module-info.java` 가 있는 모듈 |
| 캡슐화 | 없음 — public 이면 다 보임 | `exports` 한 패키지만 공개 |
| 충돌 | 같은 클래스가 두 JAR 에 있으면 먼저 찾은 것(조용한 버그) | 분할 패키지 금지로 일찍 실패 |
| 현실 | 대부분의 애플리케이션 | JDK 자체·`jlink` 최소 런타임 |

실무 애플리케이션(Spring Boot 등)은 대부분 클래스패스다. 모듈 시스템의 가장 큰 실용적 영향은 **JDK 내부 API 캡슐화**다 — 17부터 `sun.misc.*` 같은 내부 API 를 리플렉션으로 열려면 `--add-opens` 가 필요하다. 오래된 라이브러리 업그레이드 때 마주치는 `InaccessibleObjectException` 이 이것이다.

## JVM 의 기본 옵션 감각

| 옵션 | 뜻 |
|---|---|
| `-Xms` / `-Xmx` | 힙 초기·최대 크기 |
| `-XX:MaxRAMPercentage=75` | 컨테이너 메모리 한도의 75% 를 최대 힙으로(컨테이너에선 `-Xmx` 대신 이것) |
| `-XX:+UseG1GC` / `-XX:+UseZGC` | GC 선택(21 기본은 G1) |
| `-Xint` | JIT 끄고 인터프리터만 — 실험용([JMM 가시성 실험](/java/lab/java-jmm-visibility)에서 씀) |
| `-XX:+PrintFlagsFinal` | 실제 적용된 모든 플래그 |

```bash
java -XX:+PrintFlagsFinal -version | grep -E 'MaxHeapSize|UseG1GC|ActiveProcessorCount'
```

컨테이너 안에서는 JVM 이 cgroup 의 CPU·메모리 한도를 읽어 기본값을 정한다(10 이후). 한도가 없는 개발 컨테이너와 한도가 있는 운영 Pod 에서 같은 앱의 GC·스레드 수가 달라지는 이유다(→ [OS 내부: 스케줄러와 cgroup](/os-internals/notes/03-scheduler-cgroups)).

## 예시로 보기 — 이 프로젝트에서

이 저장소는 Next.js(Node) 앱이라 자바 코드가 없다. 대신 자바 실험은 **Docker 의 JDK 이미지** 로 돈다.

```bash
docker run --rm -v "$PWD":/w -w /w eclipse-temurin:21-jdk java HashMapLab.java
```

- 실험실의 각 자바 실험은 임시 디렉터리에 `.java` 파일을 쓰고, 위 명령으로 단일 파일 실행한 뒤 출력에서 숫자를 읽어 표로 만든다.
- 로컬에 JDK 를 설치하고 싶다면 `brew install openjdk@21`. 그래도 실험은 Docker 로 도는 편이 버전이 고정돼 재현성이 좋다.
- 같은 "런타임이 코드를 실행하는 방식" 을 Node 쪽에서 보고 싶다면 이 사이트의 [성능: Node 웹 서버](/performance/notes/04-node-web-server-performance) 노트와 비교해 보자. 이벤트 루프 하나로 동시성을 처리하는 Node 와, 스레드(그리고 가상 스레드)로 처리하는 자바의 차이가 이 노트 묶음 3부의 주제다.

### 실무에서 마주치는 장면

- "로컬에선 되는데 서버에서 `UnsupportedClassVersionError`" → 빌드한 JDK(예: 21)보다 실행 JDK(예: 17)가 낮다. 클래스 파일 버전(21 = 65)이 맞지 않는다. `javap -v X.class | grep major` 로 확인.
- Spring Boot 3 는 Java 17 이상을 요구한다. 8 → 17 이행은 `javax.*` → `jakarta.*` 패키지 이동이 가장 큰 일이다.
- "어떤 배포판을 쓸까" 보다 "어디서 패치를 받고, 이미지를 언제 다시 빌드하나" 를 먼저 정한다.

## 실전에서는 어디에 쓰이나 — Java 지도

> 자바는 커머스·금융·사내 시스템의 백엔드 API 와, Kafka·Elasticsearch 처럼 JVM 위에서 도는 데이터 인프라의 공통 기반이다. 실무에서는 "코드를 어떻게 쓰나"(1~3부)와 "JVM 을 어떻게 운영하나"(4~6부)를 둘 다 알아야 장애를 끝까지 따라갈 수 있다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 레거시 서비스 버전 업그레이드(8 → 17 → 21) | 이 노트 — LTS·배포판, 클래스 파일 버전, `javax` → `jakarta` | 이 노트 |
| 커머스·핀테크의 주문·결제 도메인 코드 | **1부 언어** — record·sealed 로 닫힌 상태 표현, 예외 설계 | [sealed·패턴 매칭](/java/notes/05-sealed-pattern-matching), [예외와 자원](/java/notes/06-exceptions-resources) |
| 캐시·집계·랭킹 같은 메모리 자료구조 | **2부 컬렉션** — HashMap 계약과 리사이즈, TreeMap·PriorityQueue | [HashMap 내부](/java/notes/08-hashmap-internals), [정렬·TreeMap·PQ](/java/notes/09-sorting-treemap-pq) |
| API 서버의 동시 요청·외부 API 병렬 호출·공유 카운터 | **3부 동시성** — 락·Atomic, 스레드 풀, CompletableFuture, 가상 스레드 | [락과 j.u.c](/java/notes/11-locks-juc), [가상 스레드](/java/notes/13-virtual-threads-structured) |
| 배포 직후 느린 응답, 계측 에이전트 동작 원리 | **4부 JVM 내부** — 클래스 로딩·바이트코드, JIT 웜업, 메모리 영역 | [클래스 로딩과 바이트코드](/java/notes/14-classloading-bytecode), [JIT 컴파일](/java/notes/15-jit-compilation) |
| 결제·게임 서버의 지연 스파이크, OOM 장애 조사 | **5부 GC·성능** — G1·ZGC 선택, JFR·힙 덤프·스레드 덤프 | [GC 기초와 G1](/java/notes/17-gc-basics-g1), [진단 도구](/java/notes/19-diagnostic-tools) |
| 쿠버네티스 위 Spring Boot 서비스 | **5·6부** — 컨테이너 메모리 한도, Actuator·Micrometer·OTel, 그레이스풀 셧다운 | [컨테이너 속 JVM](/java/notes/20-jvm-in-containers), [운영과 관측](/java/notes/24-operations-observability) |
| 사내 표준 백엔드 스택(Spring + JPA) | **6부 빌드·프레임워크** — 의존성 충돌·BOM, DI·프록시, `@Transactional`, N+1 | [Spring 핵심](/java/notes/22-spring-core), [Spring 웹·데이터·트랜잭션](/java/notes/23-spring-web-data-tx) |

**회사 규모에 따라**
- 스타트업: Spring Boot + JPA 로 빠르게 만들고 JVM 설정은 기본값 그대로 쓴다. 문제는 대개 N+1·트랜잭션 경계 같은 6부 쪽에서 먼저 터진다.
- 성장기: 컨테이너 메모리 한도·GC·스레드 풀 크기를 맞추고 Actuator·Micrometer 로 JVM 메트릭을 대시보드에 올린다. 5부가 필요해지는 시기다.
- 대규모 조직: 플랫폼팀이 표준 베이스 이미지·BOM·OTel 에이전트를 제공하고, JFR 수집·GC 선택·가상 스레드 전환 같은 런타임 결정을 중앙에서 내린다.

**이럴 땐 안 맞는다**
- 수십 ms 안에 떠야 하는 서버리스 함수·CLI: JVM 시작과 JIT 웜업 비용이 크다 → Go·Node, 또는 GraalVM 네이티브 이미지·CRaC([운영과 관측](/java/notes/24-operations-observability)).
- 메모리 수십 MB 로 도는 작은 사이드카·에이전트: 힙·메타스페이스·스레드 스택의 기본 비용이 부담이다 → Go·Rust.
- 데이터 분석·모델 학습 코드: 생태계가 Python 중심이다 → 자바는 그 앞뒤의 서빙 API·데이터 파이프라인(Kafka·Spark)에서 만난다.

**누가 매일 만나나** — 백엔드(Spring) 개발자는 코드 리뷰에서 equals·스트림·트랜잭션을, SRE·플랫폼 엔지니어는 OOMKilled·GC 일시정지·스레드 덤프를, 데이터 엔지니어는 Kafka·Spark·Elasticsearch 의 힙과 GC 설정을 만난다.

## 정리

- 자바 = 언어 · 바이트코드 · JVM · 표준 라이브러리. JVM 개선은 모든 JVM 언어가 함께 누린다.
- 신규는 최신 LTS(21+). 배포판은 Temurin/Corretto 등 아무거나 괜찮지만 버전 고정·패치 정책이 핵심.
- `javac` 가 만든 스택 기계 바이트코드를 JVM 이 인터프리트하다가 JIT 로 기계어화한다.
- `java File.java` 단일 파일 실행과 `jshell` 은 실험의 가장 빠른 도구다.

다음: [타입·객체·불변성](/java/notes/02-types-objects-immutability) — 자바 객체가 메모리에서 무엇이고, `equals`/`hashCode` 계약이 왜 [HashMap](/java/notes/08-hashmap-internals)의 생명줄인지.

## 실습 체크리스트

- [ ] `docker run --rm -it eclipse-temurin:21-jdk jshell` 로 REPL 을 띄우고 `System.getProperty("java.version")` 확인
- [ ] 위 `Hello.java` 를 `javac` 후 `javap -c` 로 바이트코드를 읽고, 반복문이 `goto`·`if_icmpge` 로 바뀐 것 확인
- [ ] `java -XX:+PrintFlagsFinal -version` 에서 `MaxHeapSize` 를 확인하고, `docker run -m 512m ...` 로 메모리 한도를 주었을 때 어떻게 바뀌는지 비교
- [ ] `javap -v` 로 클래스 파일 major 버전(21 → 65)을 확인
- [ ] 실험실의 [HashMap 내부 실험](/java/lab/java-hashmap-internals)을 실행해 Docker JDK 환경이 동작하는지 확인
