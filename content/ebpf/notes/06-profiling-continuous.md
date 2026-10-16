---
title: "프로파일링 — 스택 샘플링, flame graph, 연속 프로파일링"
order: 6
level: 심화
summary: "샘플링 프로파일러의 원리(타이머 인터럽트마다 스택 기록)와 perf 와 eBPF 프로파일러의 차이(커널 안 집계로 유저 복사 최소화), 스택 워킹의 세 가지 방법(프레임 포인터·DWARF·ORC/LBR)과 '[unknown]' 프레임이 생기는 이유, JIT 언어(Node·JVM)의 심볼 문제와 perf map, flame graph 읽는 법(폭=비율, 꼭대기=자기 시간, 색은 의미 없음)과 icicle·차분(diff) flame graph, on-CPU 와 off-CPU 를 함께 보는 법, 연속 프로파일링(Parca·Pyroscope)이 메트릭·로그·트레이스 다음의 네 번째 신호인 이유와 비용, 이 프로젝트의 Redis 를 99Hz 로 샘플링한 실제 결과"
tags: [프로파일링, flame graph, perf, 스택 샘플링, 프레임 포인터, DWARF, off-CPU, Parca, Pyroscope, 연속 프로파일링]
experiments: [ebpf-profile-flamegraph]
---

## 샘플링 프로파일러의 원리

정해진 주기(예: 99Hz)로 타이머 인터럽트가 걸릴 때마다 **지금 CPU 에서 돌고 있는 스택**을 기록한다. 충분히 모으면 "어떤 스택이 몇 번 찍혔나" 가 곧 "CPU 시간을 어디에 썼나" 의 추정치다.

- **99Hz 인 이유**: 100Hz 로 하면 다른 주기적 작업(10ms 타이머)과 위상이 맞아 같은 지점만 찍힌다(lockstep). 99 는 그걸 피한다.
- 오버헤드: 샘플당 수 µs × 99 × 코어 수 → 1% 미만. 그래서 운영에서 상시 켤 수 있다.
- 한계: 샘플링이라 **짧고 드문 함수**는 안 보인다. 그리고 CPU 를 쓰지 않는 시간(대기)은 전혀 안 보인다 → off-CPU 분석이 따로 필요하다.

### perf vs eBPF 프로파일러

| | `perf record` | eBPF(`profile`, bpftrace `profile:hz:99`, Parca agent) |
|---|---|---|
| 기록 | 모든 샘플을 파일로(perf.data, 수백 MB 가능) | **커널 안에서 스택별 카운트**를 맵에 집계 |
| 유저로 복사 | 샘플마다 | 주기적으로 요약만 |
| 후처리 | `perf script` 로 심볼화 | 도구가 심볼화 |
| 장점 | 정밀, 하드웨어 카운터, 성숙 | 낮은 오버헤드, 상시 실행 |

bpftrace 한 줄: `profile:hz:99 /pid == 16222/ { @[ustack, kstack] = count(); }` — 스택 자체를 맵의 키로 쓴다([02](/ebpf/notes/02-bpftrace-one-liners)).

## 스택 워킹 — '[unknown]' 은 왜 생기나

스택 샘플은 "반환 주소의 사슬" 을 거슬러 올라가 얻는다. 방법은 셋:

| 방법 | 원리 | 비용 | 문제 |
|---|---|---|---|
| **프레임 포인터** | rbp 레지스터가 이전 프레임을 가리키는 연결 리스트 | 거의 0 | 컴파일러가 최적화로 생략(`-fomit-frame-pointer`)하면 사슬이 끊긴다 |
| **DWARF** | 디버그 정보(.eh_frame)로 각 지점의 프레임 크기를 계산 | 스택 복사(수 KB/샘플) 필요 → 무겁다 | eBPF 안에서는 어렵다(최근 Parca 가 .eh_frame 테이블을 맵에 올려 해결) |
| **ORC / LBR** | 커널 전용 표(ORC), CPU 하드웨어 분기 기록(LBR) | 낮음 | 커널 전용 / 깊이 제한 |

결과적으로:
- **커널 스택**은 거의 항상 잘 나온다(ORC).
- **유저 스택**은 바이너리가 프레임 포인터로 빌드됐는지에 달렸다. 많은 배포판 패키지가 프레임 포인터를 생략해 `[unknown]` 이 끝에 붙는다. 최근 Fedora·Ubuntu 24.04 가 기본으로 프레임 포인터를 켠 이유가 이것이다.
- Alpine 기반 `redis:8-alpine` 은 musl + 최적화 빌드라 유저 스택이 짧게 끊길 수 있다. 실험 `ebpf-profile-flamegraph` 가 이것을 직접 보여 준다.

## JIT 언어 — Node 와 JVM

JIT 가 만든 기계어는 디스크의 바이너리에 없으므로 심볼이 없다. 해결:

- **Node.js**: `node --perf-basic-prof` → `/tmp/perf-<pid>.map` 에 "주소 범위 → JS 함수명" 을 기록. perf·eBPF 도구가 이 파일을 읽는다. `--interpreted-frames-native-stack` 으로 인터프리터 프레임도. V8 은 프레임 포인터를 유지하므로 스택 사슬 자체는 끊기지 않는다.
- **JVM**: `-XX:+PreserveFramePointer` + `perf-map-agent` 또는 async-profiler.
- 컨테이너라면 맵 파일이 컨테이너 `/tmp` 에 있으므로 `/proc/<pid>/root/tmp/perf-<nspid>.map` 경로와 **네임스페이스 PID** 차이를 맞춰야 한다.

[성능 04](/performance/notes/04-node-web-server-performance) 의 `--cpu-prof`(V8 자체 프로파일러)와 비교하면: V8 프로파일러는 JS 만 정확히, eBPF 는 JS + libuv + 커널을 한 그림에.

## flame graph 읽는 법

```
┌─────────────────────────────────────────────── main ───────────────────────────────────────────────┐
├──────────────── aeMain ────────────────────────────────────┤├─── serverCron ───┤
├── aeProcessEvents ──────────────────────┤├ beforeSleep ┤      ├ databasesCron ┤
├ epoll_wait ┤├─── readQueryFromClient ──┤                        
              ├ processCommand ┤├ read ┤                          
              ├ call ┤                                            
              ├ setCommand ┤                                      
```

- **가로 폭 = 그 스택이 찍힌 비율**(CPU 시간). 왼쪽→오른쪽 순서는 알파벳순일 뿐 **시간 순서가 아니다**.
- **세로 = 호출 깊이**. 아래가 호출자, 위가 피호출자.
- **꼭대기(평평한 끝)** 가 실제로 CPU 를 쓴 함수(self time). 넓은 꼭대기가 최적화 대상이다.
- **색은 의미 없다**(기본은 무작위 따뜻한 색). 일부 도구는 커널/유저/JIT 를 색으로 구분한다.
- **icicle graph**: 위아래를 뒤집은 것(Pyroscope 기본). 같은 정보.
- **차분(differential) flame graph**: 두 프로파일의 차이를 빨강(증가)/파랑(감소)으로. 배포 전후 비교에 쓴다 — [SRE 06](/sre/notes/06-capacity-release-change) 의 카나리 분석에 프로파일을 더하는 방법.

![flame graph 읽기](/diagrams/ebpf-flamegraph.svg)

### 흔한 오독

| 오독 | 실제 |
|---|---|
| "왼쪽에 있으니 먼저 실행됐다" | 정렬 순서일 뿐 |
| "높은 탑이 문제다" | 깊이는 문제가 아니다. **넓이**가 문제다 |
| "이 함수가 30% 니까 이것만 고치면 30% 빨라진다" | 30% 는 그 함수와 **그 아래 전부**. self 는 꼭대기 폭만 |
| "flame graph 에 없으니 느리지 않다" | off-CPU(대기)는 on-CPU flame graph 에 안 나온다 |

## on-CPU 와 off-CPU

전체 지연 = on-CPU 시간 + off-CPU 시간(디스크·락·네트워크·런큐 대기). on-CPU flame graph 는 앞의 것만 보여 준다.

- **off-CPU flame graph**: `sched_switch` 에서 나가는 스레드의 스택과 시각을 기록하고, 다시 들어올 때 차이를 그 스택에 더한다([03](/ebpf/notes/03-bcc-libbpf-tools) 의 `offcputime`).
- **wakeup 분석**: 누가 깨웠나까지 붙이면 "이 스레드는 저 스레드의 락 해제를 기다렸다" 가 보인다.
- Redis 의 경우: on-CPU 는 `processCommand` 계열, off-CPU 는 대부분 `epoll_wait`(유휴)다. off-CPU 에 `fsync`·`write` 가 보이면 영속성이 지연을 만든다.

## 연속 프로파일링 — 네 번째 신호

메트릭(무엇이)·로그(무슨 일이)·트레이스(어디서) 다음은 **프로파일(어떤 코드가)**이다. 상시 낮은 주기로 모든 프로세스를 샘플링해 시계열로 저장한다.

| 도구 | 방식 | 특징 |
|---|---|---|
| **Parca** (Polar Signals) | eBPF 에이전트(DaemonSet), 언어 무관 | DWARF 언와인딩을 eBPF 로, pprof 형식 저장 |
| **Grafana Pyroscope** | 언어별 SDK + eBPF 에이전트(Grafana Alloy 의 `pyroscope.ebpf`) | Grafana 와 통합, 트레이스↔프로파일 연결(span 프로파일) |
| Google Cloud Profiler / Datadog | 관리형 | — |

가치:
- "지난주 화요일 14시에 CPU 가 튄 순간의 스택" 을 **사후에** 볼 수 있다. 장애 재현이 필요 없다.
- 배포 전후 차분 flame graph 로 성능 회귀를 코드 수준에서 잡는다.
- **비용 최적화**: 클러스터 전체 CPU 의 상위 스택을 보면 "JSON 직렬화가 전체 CPU 의 8%" 같은 사실이 나온다([FinOps](/finops)).

비용: 에이전트 CPU 1% 안팎, 저장소는 프로파일이 압축돼 메트릭보다는 크고 로그보다는 작다. 보존은 보통 7~30일.

이 프로젝트의 관측 스택(Grafana Alloy 가 이미 돈다)에 Pyroscope 를 붙이는 것이 자연스러운 다음 단계다: Alloy 에 `pyroscope.ebpf` 컴포넌트 + Pyroscope 서버 컨테이너 하나.

## 예시로 보기 — 이 프로젝트에서

실험 `ebpf-profile-flamegraph`:
1. `redis-benchmark` 로 study-redis 에 부하를 준다.
2. 동시에 bpftrace `profile:hz:99` 를 Redis PID 로 필터해 커널+유저 스택별 카운트를 모은다.
3. 상위 스택을 표로 보여 주고, 커널 프레임과 유저 프레임 비율을 센다.

결과를 읽는 포인트:
- 커널 스택 상위는 네트워크 송수신(`tcp_sendmsg`, `sock_read_iter` 계열)과 `epoll` 이다 — Redis 의 일이 대부분 I/O 라는 [Redis 내부](/redis/notes/16-internals-deep-dive) 설명의 증거.
- 유저 스택이 짧게 끊기거나 `[unknown]` 이 많으면 그것이 이 노트의 "프레임 포인터 없는 빌드" 문제다.

## 실습 체크리스트

- [ ] 실험 `ebpf-profile-flamegraph` 를 돌리고 상위 스택에서 커널/유저 비율 읽기
- [ ] bpftrace 출력을 `stackcollapse-bpftrace.pl` + `flamegraph.pl`(Brendan Gregg 의 FlameGraph 저장소)로 SVG flame graph 만들기
- [ ] Node 앱을 `--perf-basic-prof` 로 실행하고 같은 방법으로 프로파일해 JS 함수명이 보이는지 확인
- [ ] 부하 전후 두 프로파일로 차분 flame graph 만들기(`difffolded.pl`)
- [ ] Pyroscope 컨테이너 + Alloy `pyroscope.ebpf` 로 연속 프로파일링을 붙이고 Grafana 에서 Redis 프로파일 조회
