---
title: "운영과 관측 — Actuator·Micrometer→Prometheus, OpenTelemetry 자바 에이전트, 그레이스풀 셧다운, 시작 시간(CDS·CRaC·GraalVM)"
chapter: "6부 · 빌드·프레임워크·운영"
order: 24
level: 심화
summary: "자바 서비스를 운영에 올릴 때 필요한 것들: Actuator 헬스·정보·메트릭 엔드포인트와 k8s 프로브 분리, Micrometer 가 만드는 JVM·HTTP·풀 메트릭과 Prometheus·Grafana 연결, 코드 수정 없이 트레이스를 주는 OpenTelemetry 자바 에이전트, SIGTERM 에서 요청을 잃지 않는 그레이스풀 셧다운과 preStop, 그리고 시작 시간·메모리를 줄이는 AppCDS·CRaC·GraalVM 네이티브 이미지 비교"
tags: [Actuator, Micrometer, Prometheus, OpenTelemetry, 그레이스풀 셧다운, CRaC, GraalVM, CDS]
experiments: [java-container-memory, java-jit-warmup]
---

이 노트는 4~6부를 운영으로 묶는다. [JIT 워밍업](/java/notes/15-jit-compilation), [GC](/java/notes/17-gc-basics-g1), [컨테이너 메모리](/java/notes/20-jvm-in-containers)를 **보이게** 만들고(관측), 배포할 때 요청을 잃지 않게 하고(셧다운), 시작을 빠르게 하는 것(시작 시간).

## Actuator — 운영 엔드포인트

```yaml
management:
  endpoints.web.exposure.include: health,info,prometheus,metrics
  endpoint.health:
    probes.enabled: true          # /actuator/health/liveness, /readiness
    show-details: when-authorized
  server.port: 8081               # 관리 포트를 분리 — 외부에 노출하지 않는다
```

| 엔드포인트 | 용도 | 주의 |
|---|---|---|
| `/actuator/health/liveness` | 프로세스가 살아 있나 (재시작 판단) | **외부 의존성(DB·Redis)을 넣지 마라** — DB 장애가 전 Pod 재시작 폭풍이 된다 |
| `/actuator/health/readiness` | 트래픽을 받아도 되나 | DB·필수 의존성, 워밍업 완료 여부 |
| `/actuator/prometheus` | Prometheus 텍스트 형식 메트릭 | 관리 포트에서만 |
| `/actuator/info`, `/conditions`, `/env`, `/heapdump`, `/threaddump` | 진단 | `env`·`heapdump` 는 **비밀이 들어 있다** — 노출 금지 또는 인증 |

k8s 프로브 연결은 [Pod·Deployment 노트](/kubernetes/notes/03-pod-deployment) 대로: `startupProbe`(긴 시작 허용) → `readinessProbe` → `livenessProbe`. 자바는 시작이 느리니 **startupProbe 없이 liveness 만 두면 시작 도중에 죽임을 당한다**.

## Micrometer → Prometheus → Grafana

Micrometer 는 메트릭의 "SLF4J" 다. 코드는 Micrometer API 로 쓰고 백엔드(Prometheus·OTLP·Datadog)는 의존성으로 고른다. `micrometer-registry-prometheus` 를 넣으면 `/actuator/prometheus` 에 이런 것들이 자동으로 나온다:

| 메트릭 | 무엇 | 쓰는 질의 |
|---|---|---|
| `http_server_requests_seconds` (히스토그램) | 요청 지연·상태 코드 (uri·method·status 레이블) | `histogram_quantile(0.99, sum by (le, uri) (rate(..._bucket[5m])))` |
| `jvm_memory_used_bytes{area,id}` | 힙/비힙 영역별 | 힙과 RSS 를 같은 패널에 |
| `jvm_gc_pause_seconds` | GC 멈춤 (cause, action) | p99 멈춤, `rate(sum)/1` = GC 시간 비율 |
| `jvm_threads_live_threads`, `_states_threads` | 스레드 수·상태 | BLOCKED 증가 = 락 경합 |
| `hikaricp_connections_active/pending` | 커넥션 풀 | pending > 0 지속 = 풀 고갈 ([트랜잭션 노트](/java/notes/23-spring-web-data-tx)) |
| `process_cpu_usage`, `jvm_compilation_time_ms` | CPU, JIT | 배포 직후 JIT 시간 급증 |
| `executor_*`, `cache_*` (Caffeine) | 스레드 풀·캐시 적중 | |

```java
// 비즈니스 메트릭은 직접
Counter orders = Counter.builder("orders_placed_total").tag("channel", ch).register(registry);
Timer.Sample s = Timer.start(registry); ... s.stop(registry.timer("payment_call_seconds", "pg", "toss"));
```

> **레이블 카디널리티**: `uri` 에 경로 변수가 그대로 들어가면(`/orders/12345`) 시계열이 폭발한다. Spring 은 템플릿(`/orders/{id}`)으로 넣어 주지만, 직접 만든 메트릭에 사용자 id·주문 id 를 레이블로 넣지 마라([관측 비용](/finops/notes/04-data-observability-cost)).

Grafana 는 공개 대시보드 "JVM (Micrometer)" 를 출발점으로, 이 저장소의 [RED·SLO 패널 방식](/observability/notes/11-slo-dashboard-burn-rate)대로 서비스 SLI 를 맨 위에 둔다.

## OpenTelemetry 자바 에이전트 — 코드 수정 없는 트레이스

```bash
java -javaagent:/otel/opentelemetry-javaagent.jar \
     -Dotel.service.name=order-api \
     -Dotel.exporter.otlp.endpoint=http://tempo:4318 \
     -Dotel.traces.sampler=parentbased_traceidratio -Dotel.traces.sampler.arg=0.1 \
     -jar app.jar
```

- 에이전트가 **바이트코드를 계측**(클래스 로딩 시점에 변형 — [클래스 로딩](/java/notes/14-classloading-bytecode))해 Spring MVC·JDBC·Hikari·Kafka·Redis(Lettuce)·HTTP 클라이언트 호출에 span 을 자동으로 만든다. 코드 수정 0.
- 로그에 `trace_id` 를 넣으면(Logback MDC 자동) Grafana 에서 로그 → 트레이스로 점프한다 — 이 사이트의 앱이 Loki·Tempo 로 하는 것과 같은 구성([트레이싱](/observability/notes/06-tracing-otel)).
- 대가: 시작 시간 +수 초, 메모리 +수십 MB, 요청당 약간의 CPU. 샘플링으로 조절.
- Spring Boot 3 는 Micrometer Tracing(OTel 브리지)으로 에이전트 없이도 트레이스를 낼 수 있다 — 자동 계측 범위는 에이전트가 더 넓다.

## 그레이스풀 셧다운 — 배포할 때 요청을 잃지 않기

k8s 가 Pod 을 내릴 때 일어나는 일은 **동시에** 두 가지다: (1) 엔드포인트에서 Pod 제거(전파에 수 초), (2) 컨테이너에 SIGTERM. 앱이 SIGTERM 을 받자마자 죽으면, 아직 이 Pod 을 가리키는 로드밸런서·kube-proxy 의 요청이 실패한다.

```yaml
# application.yml
server.shutdown: graceful
spring.lifecycle.timeout-per-shutdown-phase: 25s
```

```yaml
# Deployment
spec:
  terminationGracePeriodSeconds: 40
  containers:
    - lifecycle:
        preStop: { exec: { command: ["sh", "-c", "sleep 10"] } }   # 엔드포인트 제거가 퍼질 때까지 기다림
```

```text
t=0   SIGTERM 대신 preStop 실행 (10s 대기) — 그동안 새 요청도 처리
t=10  SIGTERM → readiness DOWN, 새 요청 거부, 진행 중 요청 완료 대기 (최대 25s)
t=35  컨텍스트 종료(@PreDestroy, 풀 닫기, Kafka 컨슈머 커밋)
t=40  아직 살아 있으면 SIGKILL
```

시간 예산: `preStop + 셧다운 타임아웃 < terminationGracePeriodSeconds`. 그리고 PID 1 문제 — 셸 스크립트로 `java` 를 띄우면 SIGTERM 이 자바에 전달되지 않는다(`exec java …` 또는 tini, [Docker 노트](/docker/notes/08-internals-namespaces-cgroups)). [네트워크 노트의 연결 드레이닝](/network-protocols/notes/06-load-balancing-cdn)과 같은 이야기다.

## 시작 시간과 메모리 — 네 가지 선택

[JIT 워밍업 실험](/java/lab/java-jit-warmup)이 보여 주듯 자바는 "시작은 느리고 나중에 빠르다". 짧게 사는 워크로드·빠른 스케일 아웃·서버리스에선 이게 문제다.

| 기술 | 원리 | 시작 시간 (중간 크기 Spring 앱 기준 대략) | 대가 |
|---|---|---|---|
| 기본 JVM | 클래스 로딩·JIT 를 런타임에 | 3~8s, 피크 성능까지 수십 초 | — |
| **AppCDS / AOT 캐시** (JDK 24) | 클래스 파싱·로딩 결과를 아카이브 | 30~50% 단축 | 빌드 단계 하나 추가, 거의 무료 |
| **CRaC** (Coordinated Restore at Checkpoint) | 워밍업된 프로세스 메모리를 체크포인트로 저장, 복원 | 수십~수백 ms, **JIT 된 상태 그대로** | 리눅스 CRIU 필요, 체크포인트에 비밀이 남음, 열린 소켓 재연결 처리 |
| **GraalVM 네이티브 이미지** | 빌드 시 전체 프로그램을 AOT 컴파일(닫힌 세계 가정) | 50~200ms, 메모리 1/3~1/5 | 빌드 수 분·수 GB 메모리, 리플렉션·동적 프록시 설정 필요, 피크 처리량은 JIT 보다 낮을 수 있음(PGO 로 보완) |

선택 기준: 수명이 긴 서비스(수시간~수일)는 기본 JVM + AppCDS 로 충분하다. 오토스케일이 잦거나 콜드 스타트가 SLO 에 들어오면 CRaC 나 네이티브. CLI·서버리스 함수는 네이티브가 정답에 가깝다. 어느 쪽이든 [컨테이너 메모리 실험](/java/lab/java-container-memory)의 교훈 — 힙과 힙 밖을 합쳐 컨테이너 한도 안에 — 은 그대로다.

## 운영 체크리스트 — 한 장

| 영역 | 확인 |
|---|---|
| 메모리 | `MaxRAMPercentage` 50~75, 힙 밖 여유, `ExitOnOutOfMemoryError`, 덤프 경로 볼륨 |
| GC | 2GB 미만에서도 G1 명시, GC 로그 상시, `jvm_gc_pause_seconds` p99 패널 |
| CPU | `ActiveProcessorCount` 명시, 스로틀링 메트릭(`container_cpu_cfs_throttled_periods_total`) |
| 프로브 | startup → readiness(의존성) → liveness(프로세스만) |
| 셧다운 | `server.shutdown=graceful`, preStop sleep, `exec java` |
| 관측 | Actuator 관리 포트 분리, Micrometer→Prometheus, OTel 에이전트·trace_id 로그 |
| 진단 | JFR 상시(`maxage=1h`), JDK 디버그 컨테이너 절차([진단 도구](/java/notes/19-diagnostic-tools)) |
| 시작 | AppCDS 아카이브를 이미지에 |

## 예시로 보기 — 이 프로젝트에서

- 이 사이트의 Node 앱은 `prom-client` 로 `/api/metrics` 를, `@vercel/otel` 로 Tempo 트레이스를 낸다. 자바에선 각각 Micrometer + Actuator, OTel 자바 에이전트가 같은 자리다. 이 저장소의 Prometheus·Grafana·Tempo·Loki 스택(`pnpm obs:up`)에 자바 서비스를 붙여도 대시보드·알림 규칙은 그대로 쓸 수 있다.
- [SRE 노트의 SLO 기반 카나리](/sre/notes/07-slo-driven-automation)는 자바의 워밍업을 고려해야 한다 — 카나리 Pod 의 첫 수십 초는 JIT 때문에 느리니 분석 시작 전 대기(초기 지연)를 둔다.
- [플랫폼 엔지니어링의 골든 패스](/platform-engineering/notes/03-golden-paths-templates)에 위 체크리스트를 템플릿 기본값으로 넣는 것이 조직 차원의 해법이다.

## 실습 체크리스트

- [ ] Actuator 를 관리 포트로 분리하고 `/actuator/prometheus` 를 이 저장소 Prometheus 에 스크레이프 대상으로 추가
- [ ] liveness 에 DB 헬스를 넣었다가 DB 를 멈추면 무슨 일이 생기는지(재시작 폭풍) 예상해 보고, readiness 로 옮기기
- [ ] OTel 자바 에이전트로 띄우고 Tempo 에서 HTTP → JDBC span 확인, 로그의 trace_id 로 점프
- [ ] `server.shutdown=graceful` + preStop 없이/있이 롤링 배포 중 k6 로 에러율 비교
- [ ] AppCDS 아카이브 유무로 시작 시간 비교
- [ ] 4~6부를 마쳤다면: [Java 목차](/java/notes)로 돌아가 1~3부의 언어·컬렉션·동시성과 연결해 보기
