---
title: "ZGC·Shenandoah 와 GC 튜닝 — 지연과 처리량 사이에서 수집기를 고르는 법"
chapter: "5부 · GC 와 성능"
order: 18
level: 심화
summary: "객체를 앱과 동시에 옮기는 저지연 수집기 ZGC(컬러드 포인터·로드 장벽·세대형 ZGC)와 Shenandoah(브룩스 포인터)의 원리, Serial·Parallel·G1·ZGC 의 선택 기준, 실측으로 본 '멈춤은 1ms, 대가는 CPU·시간', 튜닝 순서(측정 → 힙 크기 → 수집기 → 목표값), 하지 말아야 할 튜닝"
tags: [ZGC, Shenandoah, 저지연 GC, 로드 장벽, 컬러드 포인터, GC 튜닝, ParallelGC]
experiments: [java-gc-compare]
---

[G1](/java/notes/17-gc-basics-g1)은 Young GC 와 혼합 GC 에서 객체를 **멈춘 상태로** 옮긴다. 살아 있는 객체가 많을수록 멈춤이 길어진다. 수십 GB 힙에 큰 캐시를 둔 서비스라면 수십~수백 ms 멈춤을 피하기 어렵다. **ZGC** 와 **Shenandoah** 는 객체 이동까지 **앱이 실행되는 동안** 해서, 힙 크기와 상관없이 멈춤을 1ms 근처로 묶는다.

## 동시 이동이 어려운 이유

앱 스레드가 객체 A 를 읽는 순간 GC 가 A 를 다른 주소로 옮기고 있다면? 옛 주소를 읽으면 안 된다. 해법은 **참조를 읽을 때마다 확인하는 장벽**이다.

| | ZGC | Shenandoah |
|---|---|---|
| 기법 | **컬러드 포인터** — 64비트 참조의 상위 비트에 상태(표시됨·이동됨)를 기록 + **로드 장벽** | 객체에 전달 포인터(브룩스 포인터) → 이후 로드 장벽 방식으로 개선 |
| 장벽 | 참조를 **읽을 때** 상태 비트 확인, 이동 중이면 새 주소로 고쳐서(self-healing) 반환 | 읽기·쓰기 장벽 |
| 세대 | JDK 21 **세대형 ZGC**(`-XX:+ZGenerational`), JDK 23 부터 기본 | JDK 21+ 실험적 세대형 |
| 최대 힙 | 16TB | 수 TB |
| 제공 | OpenJDK 기본 포함 | Red Hat 계열·대부분 OpenJDK 빌드 |

> 로드 장벽은 **모든 참조 읽기**에 몇 개의 명령어를 더한다. 그래서 저지연 수집기는 같은 일을 할 때 **처리량이 수 % 떨어지고 CPU 를 더 쓴다**. 공짜 점심은 없다.

## 실측 — 멈춤은 줄고 시간은 늘었다

[실험 `java-gc-compare`](/java/lab/java-gc-compare)(같은 프로그램, 256MB 힙, CPU 2개):

| 수집기 | 멈춤 횟수 | 최대 멈춤 | p99 | 멈춤 합계 | 전체 실행 |
|---|---|---|---|---|---|
| Serial | 80 | 31.95ms | 31.95ms | 216.9ms | 356ms |
| G1 | 104 | 6.49ms | 6.30ms | 176.2ms | 335ms |
| **ZGC (세대형)** | 222 | **1.35ms** | 1.32ms | **33.5ms** | **572ms** |

```text
[0.048s][info][gc] GC(0) Major Collection (Warmup)
[0.070s][info][gc] GC(0) Major Collection (Warmup) 26M(10%)->112M(44%) 0.022s
```

- ZGC 는 사이클마다 짧은 세이프포인트(`ZMarkStartYoung`, `ZMarkEndYoung`, `ZRelocateStartYoung`)를 3~4번 거친다 → **횟수는 많지만 각각이 1ms 안쪽**. 멈춤 합계는 G1 의 1/5.
- 대신 **전체 실행은 G1 보다 70% 길었다**. CPU 2개에서 동시 수집 스레드가 앱과 CPU 를 나눠 썼고, 로드 장벽 비용이 더해졌다.
- 로그의 `0.022s` 는 **사이클 전체 시간**(대부분 동시)이지 멈춤이 아니다. ZGC 로그를 G1 처럼 읽으면 "22ms 멈췄다" 고 오해한다 — 멈춤은 `-Xlog:safepoint` 나 `Pause` 줄로 본다.

> 이 결과는 "작은 힙 + 적은 CPU + 처리량 중심 배치" 라는 ZGC 에 불리한 조건이다. ZGC 의 진짜 이점은 **힙이 수십 GB 이고 생존 객체가 많을 때** G1 이 수백 ms 멈추는 상황에서 드러난다. 측정은 항상 **내 워크로드·내 힙·내 CPU** 로.

## 수집기 선택표

| 수집기 | 플래그 | 맞는 곳 | 피할 곳 |
|---|---|---|---|
| Serial | `-XX:+UseSerialGC` | 작은 힙(수백 MB), CPU 1~2개, 컨테이너의 작은 서비스·CLI | 큰 힙 (멈춤이 힙에 비례) |
| Parallel | `-XX:+UseParallelGC` | **처리량 최우선** 배치·ETL (멈춤은 길어도 총 시간 최소) | 대화형 서비스 |
| G1 | `-XX:+UseG1GC` (기본) | 대부분의 서버 앱, 힙 수 GB~수십 GB, p99 수십~200ms 허용 | 1ms 단위 지연 요구 |
| ZGC | `-XX:+UseZGC` (+ZGenerational, 23+ 기본) | 지연 민감(거래·게임·API 게이트웨이), 큰 힙, CPU 여유 | CPU 빠듯한 작은 컨테이너 |
| Shenandoah | `-XX:+UseShenandoahGC` | ZGC 와 비슷, Red Hat 환경 | — |
| Epsilon | `-XX:+UseEpsilonGC` | **회수 안 함** — GC 영향 없는 성능 측정, 아주 짧은 작업 | 운영 |

## 튜닝 순서 — 플래그부터 만지지 마라

1. **측정**: GC 로그(`-Xlog:gc*`)·JFR 로 현재 상태. 멈춤 분포(p99·최대), **GC 시간 비율**(전체 시간 중 GC), 할당률(MB/s), 승격률, 힙 사용 추이.
2. **목표 정하기**: SLO 에서 출발한다. "p99 200ms 중 GC 가 쓸 수 있는 몫" 처럼. 목표 없이 튜닝하면 끝이 없다([SLO](/sre/notes/02-sli-slo-error-budget)).
3. **힙 크기부터**: 대부분의 GC 문제는 **힙이 작아서**다. 살아 있는 데이터(Full GC 직후 힙 사용량)의 3~4배를 출발점으로. `-Xms = -Xmx` 로 고정하면 확장·축소 흔들림이 없다.
4. **할당을 줄여라**: 가장 효과 큰 튜닝은 코드다 — 불필요한 박싱, 거대한 임시 컬렉션, 스트림 체인의 중간 객체, 로그 문자열 미리 만들기. JFR 의 할당 프로파일로 상위 할당 지점을 찾는다([진단 도구](/java/notes/19-diagnostic-tools)).
5. **수집기 변경**: 위 표에 따라. 바꾸고 다시 측정.
6. **세부 플래그는 마지막**: `MaxGCPauseMillis`, `G1HeapRegionSize`, `ParallelGCThreads`, `ConcGCThreads` 등. 한 번에 하나씩.

### 하지 말아야 할 튜닝

| 하지 마라 | 이유 |
|---|---|
| 인터넷에서 본 `-XX:` 플래그 20개를 그대로 복사 | 버전마다 의미가 다르고 기본값이 더 낫다. 많은 플래그가 폐기됨 |
| `System.gc()` 호출 | Full GC 를 강제한다(`-XX:+DisableExplicitGC` 로 막는 게 낫다) |
| `MaxGCPauseMillis=10` 처럼 비현실적 목표 | G1 이 Young 을 아주 작게 만들어 GC 가 폭증 → 처리량 붕괴 |
| 측정 없이 수집기 교체 | 위 실측처럼 오히려 느려질 수 있다 |
| 메모리 누수를 힙 증가로 덮기 | 시간을 벌 뿐 — 결국 OOM. 힙 덤프로 원인 제거 |


## 사례로 보는 튜닝 — 세 가지 전형

**사례 1: 주문 API, G1, 힙 4GB, p99 가 가끔 800ms**

```text
[gc] GC(4512) Pause Young (Concurrent Start) (G1 Humongous Allocation) 3100M->2900M(4096M) 45ms
[gc] GC(4513) Pause Young (Normal) (G1 Evacuation Pause) ... (to-space exhausted) 610ms
[gc] GC(4514) Pause Full (G1 Compaction Pause) 3950M->2700M(4096M) 780ms
```

- 읽기: 살아 있는 데이터가 Full GC 후에도 2.7GB → 4GB 힙의 67%. 여유가 없어 복사할 빈 리전이 모자람(`to-space exhausted`) → Full GC.
- 원인 추적: JFR `OldObjectSample` 로 Old 의 큰 몫이 **로컬 캐시**(무제한 `ConcurrentHashMap`)임을 확인.
- 대처: 캐시에 크기·TTL 상한(Caffeine), 힙 6GB. 결과적으로 Full GC 0회, p99 120ms. **플래그는 하나도 안 바꿨다.**

**사례 2: 야간 정산 배치, 처리 시간이 길다**

- G1 의 멈춤 목표는 배치에 의미가 없다. `-XX:+UseParallelGC` 로 바꾸고 힙을 넉넉히 → 총 처리 시간 15% 단축(멈춤 하나하나는 길어졌지만 아무도 기다리지 않는다).

**사례 3: 실시간 호가 서비스, 힙 32GB, p999 가 1ms 를 넘으면 안 됨**

- G1 Young GC 가 생존 객체 수 GB 를 복사하느라 30~60ms. ZGC(세대형)로 바꾸고 CPU 를 25% 더 할당 → 최대 멈춤 0.5ms. 대가로 처리량 약 8% 감소를 받아들였다.

## 자주 보는 플래그와 의미

| 플래그 | 의미 | 기본/권장 |
|---|---|---|
| `-Xms` / `-Xmx` | 초기·최대 힙 | 서버는 같은 값으로 고정 |
| `-XX:MaxRAMPercentage` | 컨테이너 메모리 대비 최대 힙 % | 기본 25 → 서비스는 50~75 ([컨테이너 속 JVM](/java/notes/20-jvm-in-containers)) |
| `-XX:MaxGCPauseMillis` | G1 일시정지 목표 | 200 (현실적인 값으로만 낮춘다) |
| `-XX:ParallelGCThreads` / `ConcGCThreads` | STW·동시 GC 스레드 수 | CPU 수에서 자동 — 컨테이너 CPU 인식이 맞는지 확인 |
| `-XX:+AlwaysPreTouch` | 시작 시 힙 페이지를 미리 건드림 | 첫 GC·페이지 폴트 지연 제거 (시작은 느려짐) |
| `-XX:SoftMaxHeapSize` | ZGC 가 평소엔 이 이하로 유지하려 함 | 메모리 반납·밀도 향상 |
| `-Xlog:gc*:file=...:time,uptime,tags` | GC 로그 | 운영에서 **항상 켠다** (비용 거의 없음) |
| `-XX:+HeapDumpOnOutOfMemoryError` | OOM 시 힙 덤프 | 켠다 (컨테이너면 덤프 경로를 볼륨으로) |

## 예시로 보기 — 이 프로젝트에서

- [성능 공학 노트 08](/performance/notes/08-tail-latency-at-scale)의 **꼬리 지연** 관점에서 GC 는 대표적인 "가끔 크게 튀는" 원인이다. 팬아웃이 큰 서비스에선 한 서버의 GC 멈춤이 전체 요청의 p99 가 된다 — 그래서 헤징 요청·저지연 GC 를 함께 쓴다.
- Go 와 Node(V8 Orinoco)도 동시·증분 GC 로 멈춤을 줄였다. 언어는 달라도 "멈춤 vs CPU·처리량" 트레이드오프는 같다([Node.js 10편](/nodejs/notes/10-gc-heap)에서 V8 GC 와 비교).
- [Redis 노트 04](/redis/notes/04-persistence)의 fork 기반 RDB 처럼, "앱을 멈추지 않으려고 다른 데서 비용을 내는" 설계는 시스템 곳곳에서 반복된다.

## 실전에서는 어디에 쓰이나

> 수집기 선택과 GC 튜닝은 "지연이냐 처리량이냐" 를 정하는 일이다. 거래·게임·API 게이트웨이처럼 지연에 민감한 서비스와, 야간 정산처럼 총 처리 시간만 중요한 배치는 서로 다른 답을 갖는다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 실시간 호가·거래 서비스(큰 힙) | G1 의 수십 ms 멈춤이 p999 를 깸 | 세대형 ZGC + CPU 여유 확보, 처리량 일부 감소를 수용 | Shenandoah, 힙과 객체 수 줄이기 |
| 야간 정산·ETL 배치 | 총 처리 시간 단축 | `-XX:+UseParallelGC` + 넉넉한 힙 | G1 기본값 유지 |
| 커머스 주문 API(G1) | 가끔 Full GC 로 p99 급등 | 플래그보다 힙 크기·캐시 상한을 먼저 | 수집기 교체 |
| 1GB 이하 작은 컨테이너 서비스 | 적은 CPU 에서 GC 비용 최소화 | G1 이나 Serial 을 명시하고 측정으로 결정 | 네이티브 이미지 |
| 팬아웃이 큰 MSA | 한 서버의 GC 멈춤이 전체 p99 가 됨 | 저지연 GC + 헤징 요청 | 팬아웃 축소 |
| 성능 회귀 테스트 | GC 영향을 뺀 코드 자체 성능 | Epsilon GC(회수 안 함) | JMH 의 GC 프로파일러 |

**이럴 땐 안 맞는다**
- CPU 가 빠듯한 작은 컨테이너에 ZGC: 동시 수집이 앱과 CPU 를 나눠 써 전체 실행 시간이 오히려 늘었다(위 실측) → G1.
- 인터넷의 `-XX:` 플래그 묶음 복사, `MaxGCPauseMillis=10` 같은 비현실적 목표: GC 가 폭증해 처리량이 무너진다 → 측정 → 목표 → 힙 → 할당 → 수집기 → 세부 플래그 순서.

**누가 매일 만나나** — SRE·성능 엔지니어가 SLO 와 GC 로그를 맞대어 튜닝할 때, 플랫폼팀이 서비스 유형별 JVM 표준 옵션을 정할 때 만난다.

**면접·실무 단골 질문**
- Q. G1 과 ZGC 중 무엇을 고르나? → 대부분은 G1. 큰 힙에 밀리초 미만 지연이 필요하고 CPU 여유가 있으면 ZGC, 처리량 배치는 Parallel. 반드시 내 워크로드로 잰다.
- Q. GC 튜닝은 어디서부터 하나? → 측정과 목표, 그다음 힙 크기와 할당 줄이기. 세부 플래그는 마지막에 하나씩.

## 실습 체크리스트

- [ ] 실험 `java-gc-compare` 에서 세 수집기의 "최대 멈춤" 과 "전체 실행 시간" 순위가 서로 반대인 것을 확인
- [ ] 같은 실험을 힙 2GB·장수 객체를 늘려(링 버퍼 키우기) 돌려 G1 과 ZGC 의 최대 멈춤 차이가 벌어지는지 보기
- [ ] `-XX:+UseParallelGC` 를 추가해 전체 실행 시간이 가장 짧은지 확인
- [ ] ZGC 로그에서 사이클 시간과 실제 멈춤(`-Xlog:safepoint`)을 구분해 읽기
- [ ] 내 서비스의 GC 시간 비율을 JFR 로 재고, SLO 대비 GC 가 문제인지 먼저 판단
- [ ] 다음: [진단 도구](/java/notes/19-diagnostic-tools)
