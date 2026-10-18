---
title: "Gradle·Maven 과 의존성 — 해석 규칙, 충돌, BOM, 재현 가능한 빌드"
chapter: "6부 · 빌드·프레임워크·운영"
order: 21
level: 중급
summary: "자바 빌드 도구가 하는 일(의존성 해석·컴파일·테스트·패키징), Maven 의 '가장 가까운 것이 이긴다' 와 Gradle 의 '가장 높은 버전이 이긴다' 해석 규칙과 그 때문에 생기는 NoSuchMethodError, 의존성 트리 읽기, BOM·플랫폼으로 버전 맞추기, 잠금 파일과 재현 가능한 빌드, 빌드 캐시·병렬화, 공급망 보안(서명·SBOM·취약점 스캔)"
tags: [Gradle, Maven, 의존성, BOM, 전이 의존성, 재현 빌드, 의존성 잠금, SBOM]
experiments: []
---

자바 애플리케이션의 JAR 에는 내 코드보다 **라이브러리가 수십~수백 배** 많다. 빌드 도구의 핵심 일은 컴파일보다 **의존성 해석**이다. 런타임에 `NoSuchMethodError`·`ClassNotFoundException`·`NoClassDefFoundError` 가 터지는 대부분의 원인은 코드가 아니라 **어떤 버전이 클래스패스에 올라갔는가**다([클래스 로딩](/java/notes/14-classloading-bytecode)).

## 빌드 도구가 하는 일

| 단계 | Maven 페이즈 | Gradle 태스크 |
|---|---|---|
| 의존성 해석·다운로드 | (모든 페이즈 전) | `dependencies` 해석 |
| 컴파일 | `compile` | `compileJava` |
| 테스트 | `test` | `test` |
| 패키징 | `package` (jar/war) | `jar`, `bootJar` |
| 검증·설치·배포 | `verify`, `install`, `deploy` | `check`, `publish` |

| | Maven | Gradle |
|---|---|---|
| 설정 | `pom.xml` (선언형 XML) | `build.gradle(.kts)` (코틀린/그루비 DSL) |
| 모델 | 고정된 생명주기 + 플러그인 | 태스크 그래프 (입력·출력으로 증분) |
| 속도 | 단순, 예측 가능 | 증분 빌드·빌드 캐시·데몬으로 빠름 |
| 의존성 충돌 기본 규칙 | **가장 가까운(nearest) 선언이 이김** | **가장 높은 버전이 이김** |

## 전이 의존성과 충돌 — 두 도구의 다른 규칙

```text
내 앱
├── lib-A 1.0 ── jackson-databind 2.15.0
└── lib-B 2.0 ── lib-C 1.0 ── jackson-databind 2.17.1
```

| 도구 | 고르는 버전 | 이유 |
|---|---|---|
| Maven | **2.15.0** | 깊이 2(lib-A 를 거침) < 깊이 3(lib-B→lib-C). 같은 깊이면 먼저 선언된 것 |
| Gradle | **2.17.1** | 그래프 전체에서 가장 높은 버전 |

Maven 에서 lib-C 가 2.17 에만 있는 메서드를 부르면 → 컴파일은 되고(lib-C 는 이미 컴파일된 JAR) **런타임에** `NoSuchMethodError`. 이것이 자바의 대표적인 "내 컴퓨터에선 되는데" 다.

### 트리를 읽는 법

```bash
mvn dependency:tree -Dverbose -Dincludes=com.fasterxml.jackson.core
# [INFO] +- lib-a:1.0
# [INFO] |  \- com.fasterxml.jackson.core:jackson-databind:2.15.0
# [INFO] \- lib-b:2.0
# [INFO]    \- lib-c:1.0
# [INFO]       \- (com.fasterxml.jackson.core:jackson-databind:2.17.1 - omitted for conflict with 2.15.0)

./gradlew dependencyInsight --dependency jackson-databind --configuration runtimeClasspath
# com.fasterxml.jackson.core:jackson-databind:2.17.1
#    Selection reasons:
#       - By conflict resolution: between versions 2.17.1 and 2.15.0
```

`omitted for conflict`, `By conflict resolution` 이 보이면 누가 졌는지 확인한다.

## BOM 과 플랫폼 — 버전을 한 곳에서

여러 모듈로 된 라이브러리(Jackson, Netty, Spring, OpenTelemetry)는 모듈끼리 버전이 맞아야 한다. **BOM(Bill of Materials)** 은 "이 묶음은 이 버전들로 쓴다" 는 목록이다.

```xml
<!-- Maven: dependencyManagement 로 BOM 가져오기 -->
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson</groupId><artifactId>jackson-bom</artifactId>
      <version>2.17.1</version><type>pom</type><scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

```kotlin
// Gradle: platform 으로 같은 효과 + 버전 카탈로그
dependencies {
    implementation(platform("org.springframework.boot:spring-boot-dependencies:3.3.4"))
    implementation("com.fasterxml.jackson.core:jackson-databind")   // 버전 생략 → BOM 이 정함
}
```

Spring Boot 의 `spring-boot-dependencies` 가 수백 개 라이브러리 버전을 맞춰 두는 거대한 BOM 이다 — 버전을 직접 적을수록 이 보호를 잃는다.

## 스코프 — 무엇이 어디까지 따라가나

| Maven | Gradle | 컴파일 | 런타임 | 소비자에게 전이 |
|---|---|---|---|---|
| `compile` | `api` | ○ | ○ | ○ |
| — | `implementation` | ○ | ○ | **✕** (내부 구현 숨김 → 재컴파일 범위 축소) |
| `provided` | `compileOnly` | ○ | ✕ | ✕ (서블릿 API, Lombok) |
| `runtime` | `runtimeOnly` | ✕ | ○ | ○ (JDBC 드라이버) |
| `test` | `testImplementation` | 테스트만 | 테스트만 | ✕ |

라이브러리를 만들 때 `implementation` 을 기본으로 쓰면 소비자의 클래스패스가 깨끗해진다.

## 재현 가능한 빌드 — 같은 소스, 같은 결과

| 위험 | 대책 |
|---|---|
| 버전 범위 `[1.0,2.0)`, `+`, `latest.release` | 쓰지 않는다. 정확한 버전 |
| 전이 의존성이 어느 날 바뀜(저장소 재게시) | **잠금 파일**: Gradle `dependencyLocking { lockAllConfigurations() }` → `gradle.lockfile` 커밋 |
| JDK·빌드 도구 버전 차이 | Gradle **툴체인**(`java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }`), Maven Wrapper·Gradle Wrapper 를 저장소에 |
| JAR 안의 타임스탬프·순서 | `project.build.outputTimestamp`(Maven), `isPreserveFileTimestamps=false`(Gradle) |
| 원격 저장소 장애·변조 | 사내 프록시(Nexus·Artifactory), **체크섬·서명 검증**(Gradle `verification-metadata.xml`) |

[이 저장소의 `pnpm-lock.yaml`](/github-actions/notes/02-cache-matrix-artifacts)이 하는 역할과 정확히 같다 — 락 파일 해시를 CI 캐시 키로 쓰는 것까지.


## 멀티 모듈 구조 — 어디에 무엇을 두나

```text
settings.gradle.kts
  include("domain", "app-api", "app-batch", "infra-redis", "infra-kafka")

domain/          순수 도메인 (외부 의존성 최소 — 프레임워크 없음)
infra-redis/     domain 의 포트 구현 (Lettuce/Redisson)
infra-kafka/     domain 의 포트 구현 (spring-kafka)
app-api/         Spring Boot 앱 1 — domain + infra-* 조립
app-batch/       Spring Boot 앱 2 — 같은 domain 재사용
build-logic/     컨벤션 플러그인 (자바 버전·테스트·정적 분석 설정을 한 곳에)
```

| 원칙 | 이유 |
|---|---|
| 의존 방향은 안쪽으로 (app → infra → domain) | 헥사고날·클린 아키텍처의 의존 규칙([아키텍처 원칙](/architecture/notes/01-principles-tradeoffs))을 빌드가 강제 |
| 모듈 사이엔 `implementation` | 한 모듈 내부 변경이 다른 모듈 재컴파일을 일으키지 않음 |
| 공통 설정은 컨벤션 플러그인 | 수십 개 `build.gradle` 의 복붙 제거 |
| 버전은 `libs.versions.toml`(버전 카탈로그) 한 파일 | 업그레이드 PR 이 한 줄 |

```toml
# gradle/libs.versions.toml
[versions]
spring-boot = "3.3.4"
testcontainers = "1.20.1"
[libraries]
testcontainers-pg = { module = "org.testcontainers:postgresql", version.ref = "testcontainers" }
[plugins]
spring-boot = { id = "org.springframework.boot", version.ref = "spring-boot" }
```

## 자주 만나는 빌드 에러와 원인

| 에러 | 대개의 원인 | 확인 |
|---|---|---|
| `NoSuchMethodError` (런타임) | 컴파일 때와 다른 버전이 클래스패스에 | `dependencyInsight`, 충돌 해석 규칙 |
| `ClassNotFoundException` (런타임) | `compileOnly`/`provided` 를 런타임에 필요로 함 | 스코프 |
| `Could not resolve …` | 저장소 미설정, 사내 프록시 인증, 오프라인 | `--refresh-dependencies`, 저장소 순서 |
| `Unsupported class file major version 65` | Java 21 로 컴파일한 클래스를 17 에서 실행 | 툴체인·런타임 JDK 일치 |
| 테스트만 깨짐 | `testImplementation` 에만 있는 다른 버전 | `testRuntimeClasspath` 트리 |

## 빠른 빌드

| 기법 | Gradle | Maven |
|---|---|---|
| 데몬 (JVM 재사용·JIT 워밍업 유지) | 기본 | `mvnd` (Maven Daemon) |
| 증분 컴파일 | 기본 | 제한적 |
| 로컬·원격 **빌드 캐시** | `--build-cache` (태스크 출력 재사용) | 확장 필요 |
| 병렬 | `--parallel` (모듈 병렬) | `-T 1C` |
| 설정 캐시 | `--configuration-cache` | — |
| 테스트 분할 | `maxParallelForks`, CI 샤딩 | Surefire `forkCount` |

CI 에서는 `~/.gradle/caches`·`~/.m2/repository` 를 락 파일 해시 키로 캐시한다([CI 성능](/github-actions/notes/06-ci-performance)).

## 공급망 보안

- **취약점 스캔**: OWASP Dependency-Check, `trivy fs .`(락 파일·JAR 스캔), GitHub Dependabot. Log4Shell(2021) 이 전이 의존성 깊숙이 있었던 것이 교훈이다.
- **SBOM**: CycloneDX Maven/Gradle 플러그인으로 빌드마다 생성 → 새 CVE 가 나오면 영향 범위를 SBOM 검색으로 수 분 안에 답한다([공급망 노트](/security/notes/05-container-supply-chain)).
- **서명**: Maven Central 은 PGP 서명 필수. 내부 아티팩트는 Sigstore(cosign)로.
- **의존성 확인**: Gradle 의존성 검증 파일(`gradle/verification-metadata.xml`)에 체크섬을 기록해 저장소 변조를 막는다.

## 예시로 보기 — 이 프로젝트에서

- 이 저장소는 pnpm 이라 규칙이 다르다: npm 계열은 **같은 패키지의 여러 버전이 공존**할 수 있어(중첩 node_modules) "가장 가까운 것이 이긴다" 충돌이 덜하지만, 그 대가로 크기가 커진다. 자바 클래스패스는 **이름당 하나**만 이긴다 — 그래서 충돌 해석 규칙이 중요하다.
- [플랫폼 엔지니어링의 골든 패스](/platform-engineering/notes/03-golden-paths-templates)에서 사내 BOM(`company-platform-bom`)과 Gradle 컨벤션 플러그인을 제공하는 것이 자바 조직의 전형적 "포장된 길" 이다.
- [테스트 비용 노트](/testing/notes/07-mutation-testing-cost)의 테스트 샤딩·캐시가 Gradle 빌드 캐시와 같은 원리다(입력 해시 → 출력 재사용).

## 실전에서는 어디에 쓰이나

> 빌드와 의존성 관리는 "로컬에선 되는데 운영에서 `NoSuchMethodError`", 대형 취약점 대응, 느린 CI 의 원인이다. 여러 팀이 같은 라이브러리를 쓰는 조직일수록 버전 정렬이 곧 운영 안정성이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 마이크로서비스 수십 개를 운영하는 조직 | 서비스마다 다른 Jackson·Netty 버전으로 인한 충돌 | 사내 BOM·버전 카탈로그 + Gradle 컨벤션 플러그인(골든 패스) | 서비스별 자율 관리 |
| 라이브러리 업그레이드 PR | 런타임 `NoSuchMethodError` | `dependencyInsight`·`mvn dependency:tree` 로 어느 버전이 이겼는지 확인 | 강제 버전·exclusion |
| Log4Shell 같은 대형 취약점 공개 | 어느 서비스가 영향받는지 즉시 파악 | 빌드마다 CycloneDX SBOM 생성·검색, Dependabot·trivy 스캔 | 서비스별 수동 조사 |
| 핀테크·공공의 감사 대응 | 같은 소스 → 같은 산출물 증명 | 잠금 파일, 툴체인, Wrapper, 체크섬 검증 | 빌드 서버 스냅숏 보관 |
| 모듈이 많은 저장소의 CI | 빌드 시간이 수십 분 | Gradle 빌드 캐시·병렬·설정 캐시, 락 파일 해시로 CI 캐시 | Bazel 같은 빌드 시스템 |
| 사내 공용 라이브러리 배포 | 소비자 클래스패스 오염 | `implementation` 을 기본, `api` 는 꼭 노출할 것만 | 셰이딩으로 내부 의존성 숨기기 |

**이럴 땐 안 맞는다**
- 버전 범위·`latest.release`: 어느 날 같은 소스의 빌드 결과가 바뀐다 → 정확한 버전 + 잠금 파일.
- Spring Boot 프로젝트에서 BOM 이 관리하는 라이브러리 버전을 개별 지정: 묶음 정합성 보호를 잃는다 → BOM 프로퍼티나 Boot 버전째 올린다.

**누가 매일 만나나** — 백엔드 개발자가 의존성 업그레이드 PR 과 런타임 에러를 다룰 때, 플랫폼 엔지니어가 사내 BOM·CI 캐시를 관리할 때, 보안 담당이 새 CVE 의 영향 범위를 조사할 때 만난다.

**면접·실무 단골 질문**
- Q. Maven 과 Gradle 의 버전 충돌 해석은 어떻게 다른가? → Maven 은 가장 가까운 선언이, Gradle 은 그래프 전체에서 가장 높은 버전이 이긴다.
- Q. Gradle 의 `implementation` 과 `api` 의 차이는? → `api` 는 소비자에게 전이되고, `implementation` 은 숨겨져 재컴파일 범위와 클래스패스 오염을 줄인다.

## 실습 체크리스트

- [ ] 같은 라이브러리의 두 버전을 서로 다른 깊이로 끌어오는 프로젝트를 Maven·Gradle 로 각각 빌드해 어떤 버전이 이기는지 확인
- [ ] `dependencyInsight` / `dependency:tree -Dverbose` 로 "omitted for conflict" 찾기
- [ ] BOM 을 도입하고 개별 버전 선언을 지운 뒤 트리가 그대로인지 확인
- [ ] Gradle `dependencyLocking` 으로 lockfile 을 만들고 CI 캐시 키에 넣기
- [ ] `trivy fs .` 로 내 프로젝트의 의존성 취약점 스캔, CycloneDX SBOM 생성
- [ ] 다음: [Spring 핵심](/java/notes/22-spring-core)
