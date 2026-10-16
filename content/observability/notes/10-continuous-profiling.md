---
title: "연속 프로파일링 — 네 번째 신호: 어느 코드 줄이 CPU·메모리를 쓰는가"
order: 10
level: 심화
summary: "메트릭·로그·트레이스가 답하지 못하는 '왜 CPU 가 높은가' 에 답하는 프로파일. 샘플링 프로파일러의 원리와 오버헤드, 프로파일 종류(CPU·wall·heap·alloc·lock·goroutine), flame graph 와 icicle·diff flame graph 읽는 법, Node 의 --cpu-prof·inspector·heap snapshot, 연속 프로파일링(Pyroscope·Parca·Grafana Profiles)의 아키텍처와 비용, eBPF 기반 무계측 프로파일링, 트레이스 span 과 프로파일을 잇는 법, 이 앱을 실제로 프로파일한 실험"
tags: [프로파일링, 연속 프로파일링, flame graph, Pyroscope, Parca, CPU 프로파일, 힙, inspector, --cpu-prof, eBPF]
experiments: [obs-cpu-profile]
---

[세 기둥](/observability/notes/01-three-pillars) 은 "무엇이 일어났나" 를 알려 준다. 메트릭: CPU 80%. 트레이스: `/api/assistant` 가 2초. 로그: 에러 없음. 그런데 **2초 중 어느 함수가 1.6초를 썼나?** 이 질문에 답하는 것이 **프로파일**이고, 이것을 항상 켜 두는 것이 **연속 프로파일링**이다. OpenTelemetry 는 프로파일을 네 번째 신호로 표준화하고 있다.

## 샘플링 프로파일러의 원리

모든 함수 호출을 기록(계측, instrumentation)하면 오버헤드가 수십 %다. 대신 **일정 간격으로 스택을 찍는다**(샘플링):

```
매 1ms(또는 100Hz):  현재 스레드의 콜 스택을 기록
  main → handler → renderNote → markdown.parse → tokenize
  main → handler → renderNote → markdown.parse → tokenize
  main → handler → db.query → (native)
  ...
같은 스택을 합쳐 개수를 센다 → "tokenize 가 샘플의 40%" = CPU 시간의 약 40%
```

- **통계적**이다: 짧은 함수는 놓칠 수 있지만, CPU 를 많이 쓰는 함수는 반드시 많이 찍힌다. 최적화 대상 찾기엔 충분하다.
- 오버헤드 = 샘플 빈도 × 스택 깊이. 100Hz 면 보통 **1~3%** → 프로덕션에 상시 켤 수 있다.
- **self time** 은 그 함수 자신이 실행 중이던 샘플, **total time** 은 자손 포함. 최적화는 self 가 큰 곳에서.

## 프로파일 종류

| 종류 | 무엇을 샘플링 | 답하는 질문 | Node 에서 |
|---|---|---|---|
| CPU (on-CPU) | CPU 위에서 실행 중인 스택 | 어디서 CPU 를 쓰나 | V8 CPU 프로파일러 |
| Wall-clock | 대기 포함 모든 스택 | 어디서 **시간**을 쓰나(I/O 대기 포함) | `--cpu-prof` 는 on-CPU 중심, wall 은 별도 |
| Heap (in-use) | 지금 살아 있는 할당 | 무엇이 메모리를 점유하나(누수) | heap snapshot, sampling heap profiler |
| Allocation | 할당 발생 위치 | 누가 GC 압력을 만드나 | `--heap-prof` |
| Lock / mutex | 락 대기 스택 | 경합 지점 | (Go·Java 에서 주로) |
| Off-CPU | 블로킹된 스택(eBPF) | 왜 기다리나 | eBPF `offcputime` — [eBPF](/ebpf) |

Node 같은 단일 이벤트 루프에서는 **on-CPU 가 곧 이벤트 루프 점유**다. CPU 프로파일의 상위 함수 = 이벤트 루프를 막아 **모든 요청의 지연**을 늘리는 범인([성능 04](/performance/notes/04-node-web-server-performance)).

## Flame graph 읽기

```
[────────────────────── main (100%) ──────────────────────]
[──────── handler (70%) ────────][──── gc (20%) ────][idle]
[─ renderNote (55%) ─][db (15%)]
[─ md.parse (50%) ─]
[tokenize 40%][..]
```

- **가로 폭 = 샘플 비율**(시간 아님, 순서 아님). 왼쪽→오른쪽 정렬은 알파벳순일 뿐이다.
- **세로 = 스택 깊이.** 위로 갈수록 호출된 쪽(flame graph) 또는 아래로(icicle).
- **넓고 평평한 꼭대기**가 self time 이 큰 함수 = 최적화 대상.
- 특수 노드: `(garbage collector)` 가 넓으면 할당을 줄여라, `(idle)` 은 이벤트 루프 대기(좋은 것), `(program)` 은 V8 내부/네이티브.
- **diff flame graph**: 배포 전후 프로파일을 빼서 빨강(늘어남)/파랑(줄어듦)으로. 성능 회귀의 원인 함수를 바로 짚는다.

## Node 에서 프로파일 얻는 법

```bash
# 1. 시작부터 끝까지 (CLI)
node --cpu-prof --cpu-prof-dir=./profiles server.js     # 종료 시 *.cpuprofile
node --heap-prof server.js                               # 할당 프로파일

# 2. 실행 중인 프로세스에 붙기
node --inspect server.js     # chrome://inspect → Profiler 탭에서 Start/Stop

# 3. 코드에서 (이 사이트의 obs-cpu-profile 실험이 쓰는 방식)
import { Session } from "node:inspector/promises";
const s = new Session(); s.connect();
await s.post("Profiler.enable"); await s.post("Profiler.start");
// ... 워크로드 ...
const { profile } = await s.post("Profiler.stop");      // .cpuprofile JSON

# 4. 힙 스냅샷 (누수 조사)
import v8 from "node:v8";  v8.writeHeapSnapshot();       # Chrome DevTools Memory 탭에서 두 스냅샷 비교
```

`.cpuprofile` 은 Chrome DevTools(Performance → Load profile) 나 [speedscope](https://www.speedscope.app) 에 끌어다 놓으면 flame graph 가 된다. 0x, clinic flame 은 같은 데이터를 HTML 로 만든다.

## 연속 프로파일링 — 항상 켜 둔다

필요할 때 붙이는 프로파일러는 **문제가 재현될 때만** 쓸모 있다. 새벽 3시에 10분간 CPU 가 튀었다면 이미 늦었다. 연속 프로파일링은 에이전트가 **10초마다** 프로파일을 찍어 서버로 보내고, 시간 범위·라벨(서비스·버전·Pod)로 조회한다.

```
앱 (SDK 또는 eBPF 에이전트) ──10초마다 pprof──▶ 프로파일 저장소 ──▶ Grafana (Explore Profiles)
                                                 Pyroscope / Parca    시간 범위·라벨로 합치고 diff
```

| | Pyroscope (Grafana) | Parca | 상용(Datadog, Polar Signals) |
|---|---|---|---|
| 수집 | 언어별 SDK(push) + eBPF(Alloy) | eBPF 에이전트(무계측) + pull | 에이전트 |
| 저장 | 객체 스토리지 | 열 저장(FrostDB/Arrow) | SaaS |
| Grafana | 네이티브 데이터소스 | 플러그인 | — |
| Node 지원 | `@pyroscope/nodejs`(CPU wall·heap) | eBPF 는 JIT 심볼 해석이 어려움(perf map 필요) | 좋음 |

이 프로젝트의 관측 스택(Grafana·Alloy·Tempo)에 Pyroscope 를 더하는 것이 가장 자연스럽다: compose 에 `grafana/pyroscope` 서비스, 앱에 SDK 3줄.

```ts
import Pyroscope from "@pyroscope/nodejs";
Pyroscope.init({ serverAddress: "http://localhost:14040", appName: "study-app", tags: { env: "dev" } });
Pyroscope.start();     // CPU wall + heap 을 10초 간격으로 push
```

### eBPF 기반 무계측 프로파일링

에이전트가 커널의 `perf_event` 로 모든 프로세스의 스택을 샘플링한다. 코드 변경 없이 **노드의 모든 프로세스**가 보인다(Redis, PostgreSQL, 앱 전부). JIT 언어(Node·Java)는 JIT 된 함수의 심볼을 알려면 `--perf-basic-prof`(Node)로 perf map 을 내보내야 한다. 네이티브 프로그램(Redis·Postgres·Go)은 바로 된다 — [eBPF](/ebpf) 주제의 프로파일 실험.

### 비용

- 오버헤드: CPU 1~3%, 메모리 수십 MB.
- 저장: 서비스당 하루 수백 MB~수 GB(스택은 중복이 많아 압축이 잘 됨). 보존 7~30일이 보통.
- 라벨 카디널리티: 메트릭처럼 Pod·버전 정도만. 요청 ID 를 라벨로 쓰면 안 된다(그건 트레이스와의 연결로).

## 트레이스와 프로파일 잇기

트레이스: "이 요청의 `render` span 이 1.6초". 프로파일: "그 시간에 CPU 를 쓴 함수". 둘을 이으면 **느린 span 을 클릭 → 그 span 동안의 flame graph** 가 된다.

방법: 프로파일 샘플에 **현재 span ID 를 라벨로** 붙인다(Pyroscope 의 span profiles, OTel 프로파일 신호의 `trace_id/span_id` 링크). Grafana Tempo 에서 span 을 열면 "Profiles for this span" 버튼이 생긴다. 이 프로젝트가 로그에 `trace_id` 를 넣어 로그↔트레이스를 잇는 것([06 트레이싱](/observability/notes/06-tracing-otel))과 같은 원리를 한 단계 더 내려간 것이다.

## 예시로 보기 — 이 앱 프로파일하기

실험 `obs-cpu-profile` 은 실행 중인 프로세스 안에서 inspector 세션을 열고 2초간 의도적인 워크로드(JSON 왕복, 정렬, 해시)를 돌리며 프로파일을 찍는다. 결과:

| 볼 것 | 의미 |
|---|---|
| 샘플 수·평균 간격 | 500µs 간격 × 2초 ≈ 수천 샘플 |
| self time 상위 함수 | `heavyHash`, `stringify`/`parse`, 정렬 비교 함수가 상위 |
| `(garbage collector)` 비율 | JSON 왕복이 만든 임시 객체의 GC 비용 |
| 저장된 `logs/cpu-profile-*.cpuprofile` | speedscope 에 드롭해 flame graph 로 |

실제 앱에 적용하려면: 개발 서버를 `NODE_OPTIONS=--cpu-prof` 로 띄우고 [k6 부하](/performance/notes/03-k6-load-testing) 를 30초 건 뒤 종료 → 프로파일에서 노트 렌더링(markdown 파싱·하이라이트)이 상위에 오는지 확인. 오면 렌더 결과 캐시가 다음 최적화다([캐시 계층](/architecture/notes/10-cache-layers-cdn)).

> 이어서 읽기: [프로파일링 — 스택 샘플링, flame graph, 연속 프로파일링](/ebpf/notes/06-profiling-continuous) — eBPF 스택 샘플링의 원리

## 실습 체크리스트

- [ ] `obs-cpu-profile` 을 실행하고 저장된 `.cpuprofile` 을 speedscope 에서 열어 self time 상위 함수를 찾기
- [ ] 개발 서버를 `--cpu-prof` 로 띄우고 노트 페이지에 부하를 준 뒤 flame graph 에서 가장 넓은 꼭대기 함수를 확인
- [ ] 같은 워크로드에서 `JSON.stringify` 를 제거한 버전과 diff 해 `(garbage collector)` 비율이 어떻게 바뀌는지 보기
- [ ] compose 에 Pyroscope 를 추가하고 Grafana 의 Explore Profiles 에서 앱 프로파일을 시간 범위로 조회
