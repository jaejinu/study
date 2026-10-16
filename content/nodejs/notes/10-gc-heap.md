---
title: "심화 — GC 와 힙 구조: Young · Old, Scavenge · Mark-Compact, 병행 마킹, 그리고 컨테이너 메모리"
order: 10
level: 심화
chapter: "3부 · V8 과 메모리"
summary: "V8 힙의 공간(new·old·code·large object)과 세대 가설, 짧게 사는 객체를 복사로 치우는 Scavenge 와 오래 사는 객체를 마킹·압축하는 Mark-Compact, 병렬·병행·증분 마킹으로 멈춤을 줄이는 법, 객체 300만 개를 버리면 Scavenge 31회·5ms·Old 3.6MB 지만 1/3 을 붙잡으면 Old 137MB·GC 64ms 가 된다는 실측, --max-old-space-size=32 에서 FATAL ERROR 재현, --trace-gc 읽는 법, 컨테이너 메모리 한도와 힙 상한을 맞추는 이유"
tags: [GC, V8, 힙, Scavenge, Mark-Compact, Orinoco, max-old-space-size, 컨테이너 메모리, trace-gc]
experiments: [node-gc-heap]
---

## 왜 세대로 나누나 — 세대 가설

"**대부분의 객체는 젊어서 죽는다.**" 요청 하나를 처리하며 만드는 임시 객체(파싱 결과, 중간 배열, 문자열)는 응답이 나가면 쓸모가 없다. 오래 사는 것은 캐시·연결·모듈 상태 같은 소수다.

그래서 V8 은 힙을 나눠 **젊은 쪽은 자주·싸게**, **늙은 쪽은 드물게·철저하게** 치운다.

## 힙의 공간

```bash
$ node -e 'console.log(require("v8").getHeapSpaceStatistics().map(x=>x.space_name+":"+(x.space_size>>10)+"KB").join(" "))'
read_only_space:0KB new_space:4096KB old_space:3104KB code_space:256KB … large_object_space:272KB …
```

| 공간 | 무엇 |
|---|---|
| **new_space** (Young) | 새로 만든 객체. 두 개의 반공간(semi-space)으로 나뉜다. 작다(MB 단위) |
| **old_space** (Old) | Young 에서 두 번 살아남아 **승격**된 객체 |
| code_space | JIT 가 만든 기계어 |
| large_object_space | 큰 객체(수백 KB 이상) — 처음부터 여기, 옮기지 않음 |
| (힙 밖) | Buffer·ArrayBuffer 바이트 — [05](/nodejs/notes/05-buffers-encoding) |

![V8 파이프라인과 GC 세대](/diagrams/node-v8-gc.svg)

## Scavenge — Young 의 GC

new_space 는 **From** 과 **To** 두 반쪽이다. 객체는 From 에 할당된다. From 이 차면:

1. 루트(스택, 전역, Old 에서 Young 을 가리키는 포인터 목록)에서 닿는 **살아 있는 객체만 To 로 복사**한다.
2. 이미 한 번 살아남은 객체는 To 대신 **Old 로 승격**한다.
3. From 을 통째로 비우고 From/To 를 맞바꾼다.

비용은 **살아남은 객체 수에 비례**한다 — 죽은 객체는 아예 보지 않는다. 대부분 죽으니 매우 싸다(보통 1ms 미만). 대신 "Old 에서 Young 을 가리키는 포인터" 를 추적하는 **쓰기 장벽(write barrier)** 비용이 프로그램 실행 중에 붙는다.

## Mark-Compact — Old 의 GC

1. **마킹:** 루트부터 그래프를 따라가 살아 있는 객체 표시
2. **스윕:** 죽은 객체 자리를 빈 공간 목록에
3. **압축(선택):** 단편화가 심한 페이지는 살아 있는 객체를 모아 옮김

Old 공간은 크니 이걸 한 번에 하면 수백 ms 멈춘다. V8 의 GC(Orinoco)는 멈춤을 줄이는 세 가지 기법을 쓴다.

| 기법 | 의미 |
|---|---|
| **병렬(parallel)** | 멈춘 동안 헬퍼 스레드 여럿이 같이 일함 |
| **증분(incremental)** | 마킹을 작은 조각으로 나눠 JS 실행 사이사이에 |
| **병행(concurrent)** | 헬퍼 스레드가 JS 실행과 **동시에** 마킹 (메인 스레드는 마지막 정리만) |

그래서 [01](/nodejs/notes/01-architecture-v8-libuv) 에서 본 것처럼 Node 프로세스에는 V8 헬퍼 스레드가 여러 개 있다.

## 실측 — 짧게 사는 객체 vs 오래 사는 객체

실험 `node-gc-heap` 은 객체 300만 개(`{ id, name, tags }`)를 만들되 한쪽은 바로 버리고, 다른 쪽은 1/3(100만 개)을 배열에 붙잡는다. `perf_hooks` 의 `gc` 항목으로 종류별 횟수와 시간을 셌다.

| 패턴 | minor (Scavenge) | major (Mark-Compact) | GC 시간 합 | Old 사용 | 루프 시간 |
|---|---|---|---|---|---|
| 짧게 삶 | 31회 | 0회 | **5ms** | 3.6 MB | 40ms |
| 오래 삶 | 46회 | 2회 | **64ms** (minor 44 + major 20) | **137.2 MB** | 114ms |

읽는 법:
- 만든 객체 수는 같다. **차이는 오래 붙잡았느냐**뿐이다.
- 붙잡은 쪽은 Scavenge 가 매번 살아남은 객체를 **복사하고 승격**해야 해서 minor GC 시간이 9배가 됐다(5 → 44ms).
- Old 가 137MB 로 커지며 Mark-Compact 가 두 번 돌았다.
- 결과적으로 같은 일을 하는 루프가 40 → 114ms. **할당을 줄이는 것보다 수명을 줄이는 것**이 GC 를 줄인다.

### 힙 상한을 넘으면 — 실측

```bash
$ node --max-old-space-size=32 -e 'const keep=[]; for(;;) keep.push({ big: "x".repeat(1024) + keep.length })'
<--- Last few GCs --->
[…]  33 ms: Scavenge (interleaved) 17.2 (26.2) -> 16.9 (48.9) MB, … allocation failure;
[…]  48 ms: Mark-Compact 32.5 (50.4) -> 29.7 (49.8) MB, … 7.58 / 0.00 ms …
<--- JS stacktrace --->
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

마지막 Mark-Compact 가 32.5MB 에서 29.7MB 밖에 못 줄였다 — 거의 다 살아 있으니까. 상한에 닿으면 V8 은 **프로세스를 abort** 한다(셸 종료 코드 134 = SIGABRT). 예외로 잡을 수 없다.

## --trace-gc 읽기

```
[32001:0x…]   6 ms: Scavenge 1.4 (2.0) -> 0.7 (3.0) MB, pooled: 0 MB, 0.21 / 0.00 ms  … allocation failure;
              ^시각   ^종류     ^전(커밋)   ^후(커밋)          ^메인 스레드 멈춤 / 병행 작업
```

| 보이는 것 | 의미 |
|---|---|
| `Scavenge` 가 수십 ms 간격 | 정상 |
| `Mark-Compact` 가 자주, 후 크기가 줄지 않음 | 살아 있는 데이터가 많다 — 누수 의심([11](/nodejs/notes/11-memory-leaks)) |
| `Mark-Compact (reduce)` | 메모리 압박에 응답한 축소 |
| 멈춤(첫 숫자)이 수십 ms 이상 | p99 지연에 직접 보인다 |

## 힙 상한과 컨테이너

| 설정 | 무엇을 제한 |
|---|---|
| `--max-old-space-size=N` (MB) | Old 공간 |
| `--max-semi-space-size=N` (MB) | Young 반공간 크기 — 키우면 Scavenge 횟수↓, 각 멈춤↑ |
| 컨테이너 `memory.max` (cgroup) | **프로세스 전체**(힙 + 힙 밖 Buffer + 네이티브 + 스택) |

기본 힙 상한은 시스템 메모리에 따라 V8 이 정한다(`v8.getHeapStatistics().heap_size_limit` 로 확인). 최근 Node 는 컨테이너의 cgroup 한도를 읽어 반영하지만, **명시적으로 정하는 것이 안전하다.**

규칙: **`--max-old-space-size` 는 컨테이너 한도의 70~75%**. 나머지는 Young·코드·Buffer·스레드 스택·네이티브 라이브러리 몫이다.

이걸 어기면 두 가지 중 하나가 일어난다.
- 힙 상한 > 컨테이너 한도: V8 은 "아직 여유 있다" 며 GC 를 미루다가 커널이 먼저 **OOM 킬(exit 137, OOMKilled)** — 힙 덤프도 로그도 없이 죽는다. [운영체제 내부 03](/os-internals/notes/03-scheduler-cgroups) 의 `os-cgroup-limits` 실험이 이것이다.
- 힙 상한이 너무 작음: 메모리가 남는데 FATAL ERROR(exit 134).

```dockerfile
ENV NODE_OPTIONS="--max-old-space-size=384"   # 컨테이너 limit 512Mi 일 때
```

## GC 를 줄이는 방법

| 방법 | 효과 |
|---|---|
| 핫 경로의 임시 객체 줄이기 (중간 배열·클로저·`{...spread}`) | Scavenge 횟수↓ |
| 캐시에 **상한과 TTL** (LRU) | Old 성장 방지 |
| 큰 데이터는 스트리밍 ([06](/nodejs/notes/06-streams-backpressure)) | 거대한 Old 객체 방지 |
| 숫자 배열은 TypedArray | 원소마다 객체(HeapNumber)가 아니라 연속 메모리 |
| 객체 풀링 | 대개 역효과 — 오래 사는 객체를 늘려 승격·쓰기 장벽 비용↑. 측정 후에만 |

## young 공간 크기 조절 — 실측

young 공간(semi-space)이 작으면 Scavenge 가 자주 돈다. 단기 객체를 대량으로 만드는 서버라면 `--max-semi-space-size`(MB)로 늘려 볼 수 있다. 같은 프로그램(300만 객체, 1/3 유지)을 세 번씩 돌린 결과다.

```bash
$ node semi.mjs                              # 기본값
{"minor":27,"major":2,"gcMs":96.5,"loop":207}
$ node --max-semi-space-size=64 semi.mjs
{"minor":18,"major":2,"gcMs":59.8,"loop":163}
```

| 설정 | minor GC 횟수 (3회 모두) | GC 총 시간 (3회) |
|---|---|---|
| 기본 | 27 | 66 ~ 97ms |
| `--max-semi-space-size=64` | 17 ~ 18 | 60 ~ 85ms |

횟수는 일관되게 3분의 1 줄었지만, 총 시간은 실행마다 흔들려 이 규모에서는 뚜렷한 이득이 없다. young 공간이 커지면 한 번의 Scavenge 가 복사할 생존 객체도 늘어서다. 이런 플래그는 **반드시 실제 부하에서 p99 지연과 GC 시간을 재고 나서** 바꾼다. 감으로 바꾸면 메모리만 더 쓴다.

## 예시로 보기 — 이 프로젝트에서

- **mtime 캐시는 의도적으로 Old 를 쓴다.** `src/lib/notes.ts` 의 `metaCache`·`noteCache` 는 노트 수(약 300)만큼만 크고 상한이 자연히 정해져 있다. 노트 본문 전체(수 MB)가 Old 에 상주하지만 파일 수 이상 늘지 않으니 누수가 아니다. 무한히 늘 수 있는 키(사용자 ID, 질문 문자열)로 캐시를 만든다면 반드시 LRU 상한이 필요하다.
- **서버 메트릭으로 GC 보기.** `/api/metrics` 의 `study_process_nodejs_gc_duration_seconds`(prom-client 기본 메트릭, kind=minor/major/incremental)와 `study_process_nodejs_heap_size_used_bytes` 를 Grafana 에 그리면 위 표의 "짧게 삶/오래 삶" 차이를 운영 중에 볼 수 있다.
- **컨테이너 배포.** `k8s/web.yaml` 의 web Deployment 는 `limits: { memory: 512Mi }` 다. 이 노트의 규칙대로라면 `NODE_OPTIONS=--max-old-space-size=384` 를 함께 두는 편이 안전하다(현재는 기본값에 맡김 — 개선 여지).

## 실습 체크리스트

- [ ] 실험 `node-gc-heap` 을 돌려 두 패턴의 GC 횟수·시간·Old 크기 비교
- [ ] `node --trace-gc` 로 위 루프를 돌리고 Scavenge·Mark-Compact 줄 읽기
- [ ] `--max-semi-space-size=1` 과 `=64` 로 Scavenge 횟수·멈춤 비교
- [ ] `--max-old-space-size=32` 로 OOM 을 재현하고 종료 코드(134) 확인
- [ ] Docker 에서 `--memory=128m` 컨테이너로 같은 코드를 힙 상한 없이 돌려 137 로 죽는 것과 비교
