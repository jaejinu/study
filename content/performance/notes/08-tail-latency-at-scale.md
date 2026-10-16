---
title: "심화 — 꼬리 지연과 대규모: 헤징, 적응형 타임아웃, 부하 차단, 백프레셔, LLM 서빙"
order: 8
level: 심화
summary: "Google 의 'The Tail at Scale' 이 말하는 꼬리 증폭과 변동성의 원인, 변동을 줄이는 기법(우선순위·작은 단위·GC 관리)과 변동을 견디는 기법(헤징 요청·tied request·마이크로 파티션·선택적 복제), 적응형 타임아웃과 재시도 예산, 부하 차단(load shedding)·우선순위·동시성 제한(AIMD, 그라디언트), 백프레셔와 준안정 장애(metastable failure), LLM 서빙 성능(TTFT·TPOT·토큰/초·연속 배칭·KV 캐시·프리픽스 캐시)과 이 앱의 도우미 메트릭"
tags: [Tail at Scale, 꼬리 지연, 헤징, 적응형 타임아웃, 재시도 예산, 부하 차단, 동시성 제한, 백프레셔, metastable, LLM 서빙, TTFT, KV 캐시]
experiments: [perf-k6-arrival-rate, perf-node-eventloop]
---

## 꼬리는 왜 생기고 왜 증폭되나

Dean & Barroso 의 "The Tail at Scale"(2013): 개별 서버의 p99 가 10ms 라도, 요청 하나가 서버 100대를 **팬아웃**하면 전체의 63% 가 10ms+ 를 겪는다. 규모가 커질수록 **드문 느림이 흔한 느림**이 된다.

![꼬리 지연 증폭과 대책](/diagrams/perf-tail-latency.svg)

변동성(variability)의 원인:

| 원인 | 예 |
|---|---|
| 자원 공유 | 같은 머신의 다른 프로세스, 같은 코어의 다른 스레드, 네트워크 스위치 큐 |
| 백그라운드 작업 | GC, 로그 압축(compaction), 체크포인트, 백업 |
| 큐잉 | 앞의 큰 요청 뒤에 선 작은 요청(head-of-line blocking) |
| 전력·온도 | CPU 주파수 조절(throttling) |
| 캐시 미스 | 특정 키만 디스크로 |
| 멈춤 | 이벤트 루프 블록, 락 대기, 스왑 |

전략은 두 갈래: **변동을 줄이거나**, **변동을 견디거나**.

## 변동 줄이기

- **서비스 등급 분리**: 대화형 요청에 우선순위, 배치는 낮은 큐. OS 레벨(nice, cgroup)과 앱 레벨(큐 분리).
- **큰 작업을 작게**: 긴 요청을 쪼개 작은 요청이 끼어들 수 있게(Node 의 양보, [이벤트 루프 실험](/performance/notes/04-node-web-server-performance)).
- **백그라운드 작업 관리**: 압축·GC 를 **동시에 모든 복제본**에서 하지 않도록 시차. 큰 힙보다 작은 힙 여러 개.
- **캐시·웜업**: 배포 직후의 콜드 캐시가 꼬리를 만든다 → 트래픽을 서서히(카나리, slow start).

## 변동 견디기 — 중복으로 꼬리를 자른다

### 헤징 요청(hedged request)

요청을 보내고 **p95 시간이 지나도 응답이 없으면 다른 복제본에 하나 더** 보낸다. 먼저 온 응답을 쓰고 나머지는 취소. 부하 증가는 ~5%(95% 는 헤지 전에 끝남), 꼬리는 극적으로 준다(논문: p99.9 1800ms → 74ms, 부하 +2%).

```ts
async function hedged<T>(call: (replica: number) => Promise<T>, hedgeAfterMs: number) {
  const ac = new AbortController();
  const first = call(0);
  const second = new Promise<T>((res, rej) => setTimeout(() => call(1).then(res, rej), hedgeAfterMs));
  try { return await Promise.race([first, second]); } finally { ac.abort(); }   // 진 쪽 취소
}
```
조건: 연산이 **멱등**(읽기), 복제본이 있고, 서버가 취소를 존중. 쓰기에는 쓰지 않는다. gRPC 는 내장(`hedgingPolicy`).

### tied request

두 복제본에 **동시에** 보내되 서로의 존재를 알려 주고, 한쪽이 시작하면 다른 쪽 큐에서 제거(취소 메시지). 헤징보다 큐잉 지연을 더 줄인다. 구현 복잡.

### 마이크로 파티션과 선택적 복제

데이터를 머신 수보다 훨씬 많은 작은 파티션으로 나눠(Redis 16384 슬롯 처럼) 핫 파티션만 다른 곳으로 옮기거나 **추가 복제**한다([파티셔닝](/distributed-systems/notes/07-partitioning)). 느린 머신은 파티션을 덜어 주면 된다(latency-induced probation).

### 좋은 것만 기다리기

100개 팬아웃에서 **95개 응답이 오면 결과를 낸다**(검색 결과 몇 개 빠져도 됨). 품질을 약간 희생해 꼬리를 자른다. 모든 응답이 필요한 경우(합계)엔 불가.

## 타임아웃과 재시도 — 꼬리를 폭풍으로 만들지 않기

- **고정 타임아웃**은 부하에 따라 너무 짧거나 길다. **적응형**: 최근 지연 분포의 p99 × 1.5 를 타임아웃으로(TCP RTO 처럼 EWMA + 분산). 상한·하한을 둔다.
- **재시도는 부하를 늘린다**: 서버가 느려서 타임아웃 → 재시도 → 더 느림 → 더 많은 재시도(retry storm). 대책: **지수 백오프 + 지터**, **재시도 예산**(최근 1분 요청의 10% 까지만 재시도 — Google SRE), 서버가 과부하면 `Retry-After`/즉시 거부로 재시도를 막기, 하위 계층 재시도는 1회만(계층마다 3회면 3^N).
- **데드라인 전파**: 요청 전체의 마감(예: 500ms)을 하위 호출에 넘겨 남은 시간만 기다리게(gRPC deadline, OTel baggage). 이미 늦은 요청에 자원 쓰지 않기.
[회복력 패턴](/architecture/notes/04-resilience) 의 서킷 브레이커·벌크헤드와 함께.

## 부하 차단(load shedding) — 느려지느니 거절한다

큐잉 이론의 결론: ρ ≥ 1 이면 지연은 발산한다. 과부하에서 유일한 해법은 **일부를 빨리 거절**해 나머지를 SLO 안에 처리하는 것이다. 거절(503, 수 ms)은 타임아웃(수 초)보다 사용자에게도 낫다 — 재시도·대체 경로가 가능하니까.

| 방법 | 동작 |
|---|---|
| **동시성 제한** | 처리 중 요청 수 상한(리틀의 법칙: 목표 지연 × 처리량). 넘으면 즉시 503. Envoy/Nginx `limit_conn`, 앱 미들웨어 |
| **적응형 동시성**(Netflix concurrency-limits) | AIMD 또는 그라디언트: 지연이 오르면 한도를 곱셈으로 줄이고, 안정되면 덧셈으로 늘림. TCP 혼잡 제어의 응용 |
| **큐 길이·대기 시간 상한** | 큐에서 N ms 이상 기다린 요청은 처리하지 않고 버림(이미 늦었다 — CoDel) |
| **우선순위 차단** | 과부하 시 낮은 등급(크롤러, 배치, 비로그인)부터 거절. 요청에 criticality 헤더 |
| **클라이언트 측 스로틀** | 서버가 거절 비율을 알려 주면 클라이언트가 확률적으로 자체 거절(adaptive throttling) |
| 이벤트 루프 기반 | Node: 루프 지연 > 임계면 503(`toobusy-js` 패턴) — 가장 단순하고 효과적 |

```ts
// Node 미들웨어: 이벤트 루프 지연 기반 차단
import { monitorEventLoopDelay } from "node:perf_hooks";
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
export function shedIfBusy(req, res, next) {
  if (h.percentile(50) / 1e6 > 70) { res.setHeader("Retry-After", "1"); return res.status(503).end(); }
  next();
}
```

## 백프레셔와 준안정 장애

**백프레셔**: 소비자가 느리면 생산자를 **늦춘다**(큐를 무한히 쌓지 않는다). TCP 윈도, Node 스트림의 `highWaterMark`/`drain`, Kafka 컨슈머의 `pause()`, Reactive Streams 의 `request(n)`. 백프레셔가 없는 큐는 메모리를 먹고 지연을 숨기다가 터진다.

**준안정 장애(metastable failure)**: 일시적 과부하(스파이크)가 지나갔는데도 시스템이 **스스로 회복하지 못하는** 상태. 원인은 되먹임 루프 — 재시도 폭풍, 캐시가 비어 DB 부하가 유지, 타임아웃된 요청이 자원을 계속 점유, GC 가 GC 를 부름. 2021 년 논문(Bronson et al.)이 이름 붙였고 큰 장애의 상당수가 이것이다. 예방 = 위의 모든 것(재시도 예산, 부하 차단, 캐시 워밍, 데드라인). 회복 = **부하를 강제로 줄이기**(트래픽 차단, 재시작) — 스파이크 테스트가 "회복하는가" 를 봐야 하는 이유([k6 테스트 유형](/performance/notes/03-k6-load-testing)).

## LLM 서빙 성능

LLM 호출은 전형적 API 와 다른 지연 구조를 가진다. 지표부터:

| 지표 | 뜻 | 사용자 체감 |
|---|---|---|
| **TTFT**(Time To First Token) | 요청 → 첫 토큰. 프롬프트 처리(prefill) 시간 ∝ 입력 토큰 수 | "응답이 시작되는 느낌" |
| **TPOT**(Time Per Output Token) / ITL | 토큰 사이 간격(decode). 보통 10~50ms | 타이핑 속도. 사람 읽기 속도(~5 토큰/초)보다 빠르면 충분 |
| **총 지연** | TTFT + TPOT × 출력 토큰 수 | 긴 답은 수십 초 — 스트리밍 필수 |
| **처리량** | 토큰/초 (서버 전체) | 비용 |
| 토큰 비용 | 입력·출력 단가 × 토큰 | [프롬프트 캐시·비용](/ai-systems/notes/05-prompt-cache-cost-latency) |

서버 측(자체 호스팅·vLLM 등)의 핵심 기법:
- **연속 배칭(continuous batching)**: 디코딩은 토큰 하나당 GPU 를 거의 못 채운다 → 여러 요청을 한 배치로, 끝난 요청 자리에 새 요청을 바로 끼움. 처리량 수 배~수십 배, TPOT 약간 ↑.
- **KV 캐시**: 어텐션 키·값을 재계산하지 않고 보관. GPU 메모리를 먹어 동시 요청 수의 상한 = 메모리. PagedAttention(vLLM)이 조각화를 줄인다.
- **프리픽스 캐시**: 같은 시스템 프롬프트/문서의 KV 를 재사용 → TTFT 급감. Anthropic 의 프롬프트 캐시가 API 레벨의 같은 아이디어 — 캐시된 입력은 비용 1/10, TTFT ↓.
- 양자화(INT8/FP8), 투기적 디코딩(작은 모델이 초안 → 큰 모델이 검증, TPOT ↓), 텐서 병렬.

클라이언트(이 앱 같은 LLM 앱)에서의 성능:
- **스트리밍**(SSE)으로 TTFT 만 체감되게. 툴 루프는 각 단계의 지연이 더해지니 단계 수를 줄이고 병렬 툴 호출.
- 긴 컨텍스트는 TTFT 와 비용을 함께 올린다 → RAG 로 필요한 것만([RAG 설계](/ai-systems/notes/03-rag-design)).
- 타임아웃은 토큰 단위(마지막 토큰 이후 N초)로 — 총 시간 타임아웃은 긴 답을 끊는다.
- 꼬리: 공급자 측 큐잉·레이트리밋(429) → 재시도 예산 + 모델 폴백(작은 모델로 강등). 헤징은 비용이 2배라 신중히.

## 예시로 보기 — 이 프로젝트에서

**포화 실험의 재해석**(`perf-k6-arrival-rate`): 50 req/s 에서 p50 이 1초로 뛴 것은 서버가 **거절하지 않고 큐에 쌓았기** 때문이다. 이벤트 루프 지연 기반 차단을 넣으면 일부 요청이 503(수 ms)을 받는 대신 나머지는 30ms 를 유지한다 — "느려지느니 거절" 의 실험. `shedIfBusy` 를 `/api/metrics` 앞에 붙여 다시 재 보자(성공 요청의 p99 vs 거절 비율).

**이벤트 루프 실험**(`perf-node-eventloop`): "큰 작업을 작게" 가 변동을 어떻게 줄이는지의 실물.

**도우미의 LLM 메트릭**: `src/lib/metrics.ts` 는 토큰(입력·출력·캐시 적중), 비용 추정, 지연, 툴 호출 수를 내보내고 Grafana 의 LLM 패널에 있다([LLM 관측](/observability/notes/08-llm-observability)). 여기에 **TTFT**(스트림 첫 청크까지)와 **TPOT**(청크 간 간격의 p50) 히스토그램을 추가하면 LLM 서빙 지표가 완성된다 — `/api/assistant` 의 SSE 루프에서 첫 `content_block_delta` 시각을 재면 된다. 프롬프트 캐시 적중률(`cache_read_input_tokens / input_tokens`)이 오르면 TTFT 와 비용이 같이 떨어지는 것을 볼 수 있다.

**카오스와의 연결**: `chaos-redis-hang` 에서 타임아웃이 없으면 요청이 영원히 큐에 머문다 — 데드라인·부하 차단이 없는 시스템의 준안정 장애 입구다. 타임아웃(ms) 과 재시도(횟수·백오프)가 설정된 ioredis 클라이언트가 어떻게 다른지 [장애 카탈로그](/chaos/notes/02-failure-catalog) 에서 비교할 수 있다.

> 이어서 읽기: [LLM 서빙 — prefill·decode, 연속 배칭, KV 캐시와 PagedAttention, 양자화](/mlops/notes/05-serving-batching-kv-cache) — LLM 서빙의 배칭·KV 캐시 실측

## 실습 체크리스트

- [ ] 이벤트 루프 지연 기반 부하 차단 미들웨어를 넣고 50 req/s 실험을 다시 돌려 "성공 요청의 p99" 와 "503 비율" 을 기록한다
- [ ] Redis 읽기에 헤징(두 복제본, p95 후 두 번째 요청)을 구현하고 복제본 하나를 `DEBUG SLEEP` 으로 느리게 한 뒤 p99 차이를 본다
- [ ] 재시도에 지수 백오프 + 지터 + 재시도 예산(10%)을 넣고, 서버를 느리게 했을 때 총 요청 수가 폭발하지 않는지 확인한다
- [ ] `/api/assistant` 에 TTFT·TPOT 히스토그램을 추가하고 프롬프트 캐시 적중 전후를 비교한다
- [ ] 스파이크 테스트(0 → 10배 → 0) 후 p99 가 원래로 돌아오는 시간을 재고, 돌아오지 않으면 어떤 되먹임 때문인지 찾는다
