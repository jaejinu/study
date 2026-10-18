---
title: "k6 부하 테스트 — 스크립트, 실행기, 임계값(SLO), 테스트 유형, Grafana 연동"
order: 3
level: 중급
summary: "k6 스크립트 구조(options·default·setup/teardown·그룹·체크), VU 기반 vs 도착률 기반 실행기와 시나리오, thresholds 로 SLO 를 코드화해 CI 에서 배포를 막는 법, smoke/load/stress/spike/soak/breakpoint 테스트의 목적과 설계, 결과 지표 해석(dropped_iterations, http_req_*), Prometheus remote write 로 Grafana 에서 실시간으로 보기, 부하 테스트의 윤리와 안전장치"
tags: [k6, 부하 테스트, VU, arrival-rate, thresholds, SLO, 스트레스, soak, spike, remote write]
experiments: [perf-k6-smoke, perf-k6-arrival-rate]
---

## k6 가 무엇인가

Grafana 의 오픈소스 부하 도구. 스크립트는 **JavaScript(ES 모듈)** 로 쓰고 엔진은 **Go** 라서 VU 수천 개도 가볍다. 결과는 내장 요약, JSON, 또는 Prometheus/InfluxDB/Grafana Cloud 로 스트리밍. 브라우저 테스트(k6 browser), gRPC, WebSocket 도 지원. `brew install k6`.

```js
// 최소 스크립트
import http from "k6/http";
import { check, sleep } from "k6";

export const options = { vus: 10, duration: "30s" };

export default function () {
  const res = http.get("http://127.0.0.1:3000/api/metrics");
  check(res, { "status 200": (r) => r.status === 200 });
  sleep(1);                         // think time (닫힌 모델에서 사용자 간격)
}
```

```
k6 run script.js
k6 run --vus 50 --duration 1m script.js          # 옵션 덮어쓰기
k6 run -e BASE=http://staging script.js          # __ENV.BASE
```

## 스크립트 생명주기

```js
export function setup() { /* 1회: 로그인 토큰, 테스트 데이터 생성 */ return { token }; }
export default function (data) { /* VU 마다 반복 */ }
export function teardown(data) { /* 1회: 정리 */ }
export function handleSummary(data) { return { "summary.json": JSON.stringify(data), stdout: textSummary(data) }; }
```

init 컨텍스트(파일 최상단)는 VU 마다 한 번 실행되고 여기서만 모듈 import·파일 읽기(`open()`)가 가능하다. `default` 안에서 파일을 읽으면 안 된다.

### 그룹·태그·체크

```js
import { group, check } from "k6";
group("노트 읽기", () => {
  const r = http.get(`${BASE}/redis/notes/01-redis-overview`, { tags: { page: "note" } });
  check(r, { "200": (x) => x.status === 200, "본문 있음": (x) => x.body.includes("Redis") });
});
```

`check` 는 **실패해도 테스트를 멈추지 않는다** — 통과율 메트릭(`checks`)이 될 뿐. 멈추려면 thresholds 에 `checks: ["rate>0.99"]` 를 건다. 태그는 메트릭을 나눠 보는 축(`http_req_duration{page:note}`).

## 실행기(executor) — 부하 모델을 고른다

| 실행기 | 모델 | 동작 | 언제 |
|---|---|---|---|
| `constant-vus` | 닫힌 | VU N개가 계속 반복 | 동시 사용자 수가 고정된 내부 도구 |
| `ramping-vus` | 닫힌 | VU 수를 단계적으로 | 전통적 "사용자 늘리기" |
| `constant-arrival-rate` | **열린** | 초당 R 요청을 **강제**. VU 는 자동 할당(`preAllocatedVUs`~`maxVUs`) | 공개 API, 현실적 처리량 목표 |
| `ramping-arrival-rate` | 열린 | 도착률을 단계적으로 | 포화점 찾기(breakpoint) |
| `per-vu-iterations` / `shared-iterations` | — | 정해진 횟수만 | 기능 검증, 데이터 적재 |
| `externally-controlled` | — | REST 로 VU 조절 | 수동 탐색 |

열린 모델이 **조정 누락**을 피한다([성능의 언어](/performance/notes/01-language-of-performance)). `dropped_iterations` 가 0 이 아니면 `maxVUs` 가 모자라 목표 속도를 못 낸 것 — 서버가 그 속도를 못 받고 있다는 신호다.

### 시나리오 — 여러 부하를 한 테스트에

```js
export const options = {
  scenarios: {
    browse: { executor: "constant-arrival-rate", rate: 50, timeUnit: "1s", duration: "5m", preAllocatedVUs: 20, maxVUs: 200, exec: "browse" },
    api:    { executor: "ramping-arrival-rate", startRate: 10, timeUnit: "1s", stages: [{ target: 200, duration: "3m" }, { target: 200, duration: "2m" }], preAllocatedVUs: 50, maxVUs: 500, exec: "api", startTime: "30s" },
  },
};
export function browse() { … }
export function api() { … }
```

실제 트래픽은 **혼합**이다(읽기 90%, 쓰기 10%, 검색 5%). 시나리오 비율을 운영 로그에서 가져온다.

## 임계값(thresholds) — SLO 를 코드로

```js
export const options = {
  thresholds: {
    http_req_duration: ["p(95)<300", "p(99)<800"],          // 지연 SLO
    http_req_failed: ["rate<0.01"],                          // 오류 SLO
    "http_req_duration{page:note}": ["p(95)<500"],           // 태그별
    checks: ["rate>0.99"],
    dropped_iterations: ["count==0"],                        // 목표 속도 달성
    // abortOnFail: 즉시 중단 (soak 에서 돈 아끼기)
    "http_req_duration{scenario:api}": [{ threshold: "p(99)<1000", abortOnFail: true, delayAbortEval: "30s" }],
  },
};
```

임계값 실패 → **종료 코드 99**. CI 에서 그대로 게이트가 된다:

```yaml
# .github/workflows/perf.yml 발췌
- run: pnpm build && pnpm start &                      # 운영 빌드로!
- run: k6 run --summary-export k6.json tests/perf/smoke.js
- uses: actions/upload-artifact@v4
  with: { name: k6-summary, path: k6.json }
```

[GitHub Actions](/github-actions/notes/01-workflow-basics) 의 PR 체크에 넣으면 성능 회귀가 머지 전에 잡힌다([용량 계획·성능 회귀 CI](/performance/notes/07-capacity-planning)).

## 테스트 유형 — 질문이 다르다

| 유형 | 질문 | 모양 | 기간 |
|---|---|---|---|
| **Smoke** | 스크립트·시스템이 정상인가 | VU 1~5 | 1분 |
| **Load** (average) | 평상시 부하에서 SLO 를 지키나 | 운영 평균 도착률, 램프업 → 유지 → 램프다운 | 10~30분 |
| **Stress** | 피크 부하에서는? 어디서 깨지나 | 평균의 2~3배 | 10~30분 |
| **Spike** | 갑작스러운 폭주(세일 오픈)를 버티나, **회복**하나 | 0 → 10배 → 0 | 몇 분 |
| **Soak** (endurance) | 오래 돌리면 새는 게 있나(메모리, 커넥션, 디스크) | 평균 부하 | 수 시간~하루 |
| **Breakpoint** | 최대 처리량은? | 도착률을 계속 올림 | 깨질 때까지 |

Spike 에서 중요한 건 **지연이 느는 것보다 돌아오는가** — 큐가 안 빠지고 영원히 느려지면(metastable failure) 부하 차단이 필요하다([Tail at Scale](/performance/notes/08-tail-latency-at-scale)). Soak 에서는 메모리 그래프가 **계단**(새는 것)인지 **톱니**(GC 정상)인지 본다.

## 결과 읽기

```
http_reqs......................: 471    36.2/s
http_req_duration..............: avg=1.85s min=31ms med=1.86s max=3.38s p(90)=3.12s p(95)=3.26s
  { expected_response:true }...: …                          # 2xx/3xx 만
http_req_failed................: 0.00%  0 out of 471
http_req_waiting (TTFB).........: …                          # 서버 처리 시간에 가장 가까움
http_req_connecting / tls_handshaking: …                     # 커넥션 재사용 안 되면 큼
dropped_iterations.............: 111                         # 목표 속도 미달
vus_max........................: 200
iteration_duration.............: …                          # sleep 포함
```

- `http_req_duration` = sending + waiting + receiving. **연결·TLS 제외**(별도 지표). 큰 응답이면 receiving 이 크다.
- 기본 요약엔 p99 가 없다 → `--summary-trend-stats "avg,med,p(95),p(99),max"`.
- `--summary-export` 는 레거시 JSON(바로 파싱 가능), `handleSummary` 는 자유 형식. 이 프로젝트의 실험은 전자를 파싱해 표로 만든다.

## Grafana 에서 실시간으로

```
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:19090/api/v1/write \
K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true \
k6 run -o experimental-prometheus-rw script.js
```

이 프로젝트의 Prometheus 는 remote write 수신이 켜져 있어(`--web.enable-remote-write-receiver`) 바로 들어간다. Grafana 에서 `k6_http_req_duration_p95` 류 메트릭을 앱의 RED 패널과 **같은 시간축**에 놓으면 "부하 → 앱 p99 → Redis ops/s" 가 한 화면에 보인다. 공식 k6 대시보드(ID 19665)도 있다. 테스트 ID 태그(`--tag testid=…`)로 실행을 구분한다.

## 데이터와 현실성

- 요청 데이터는 **분포**를 따라야 한다: 사용자 ID 를 `randomIntBetween(1, 1e6)` 으로 균등하게 뽑으면 캐시가 거의 안 맞아 비관적, 핫 키 20% 를 80% 로 뽑으면 낙관적. 운영 로그의 분포를 쓴다(`SharedArray` 로 CSV 로드).
- 상태 변화(쓰기 테스트)는 **격리된 데이터**(prefix `k6:`)로, 끝나면 teardown 에서 정리.
- 캐시 워밍 여부를 명시하고, 콜드 스타트 측정은 따로.

## 안전장치

1. **운영에 쏘지 않는다.** 스테이징, 또는 운영이면 사전 공지·시간대·제한 + 즉시 중단 가능(`abortOnFail`, Ctrl-C).
2. 외부 의존(결제 API, 이메일)은 **스텁**으로. 남의 서비스에 부하를 주는 건 공격이다.
3. 오토스케일·비용: 클라우드에서는 부하 테스트가 **요금**이 된다. 상한 설정.
4. 레이트리밋·WAF 가 테스트를 막으면 우회가 아니라 **허용 목록** 협의.
5. 결과를 **기록**(커밋, 환경, 날짜, 표)해 다음 비교의 기준선으로.

## 예시로 보기 — 이 프로젝트에서

`perf-k6-smoke`: VU 5 × 15초, `/api/metrics` + `/redis/notes`, 임계값 p95<500ms · 실패율<1%. 실험은 임시 디렉터리에 스크립트를 쓰고 `--summary-export` JSON 을 파싱해 표로 만든다. k6 종료 코드를 확인(0 = 임계값 통과, 99 = 실패)하는 것이 CI 게이트의 원리 그대로다.

`perf-k6-arrival-rate`: 같은 엔드포인트를 10/25/50 req/s 열린 모델로. 개발 서버의 포화점이 ~37 req/s 라는 것을 `dropped_iterations` 와 실제 req/s 로 찾는다. 운영 빌드에서 다시 돌리면 breakpoint 테스트가 된다 — `ramping-arrival-rate` 로 10 → 500 req/s 를 5분에 걸쳐 올리고 `abortOnFail` 임계값으로 자동 중단.

Grafana 연동은 `pnpm obs:up` 상태에서 위의 `-o experimental-prometheus-rw` 를 붙이면 된다. 알림 규칙([알림 파이프라인](/observability/notes/09-alerting-pipeline))의 `HighLatency` 가 부하 중 firing 되는지 보는 것도 좋은 실험이다.

> 함께 읽기: [측정 방법론 — USE·RED·골든 시그널, 프로파일링 vs 트레이싱, 벤치마크의 함정](/performance/notes/02-measurement-methodology)

## 실전에서는 어디에 쓰이나

> 출시·이벤트 전에 "이 부하를 버티나" 를 미리 묻고, 배포마다 "느려지지 않았나" 를 자동으로 막는 곳에 부하 테스트가 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 세일·티켓 오픈 | 오픈 순간 폭주를 버티고 회복하나 | spike 테스트(0 → 10배 → 0) 후 회복 시간 확인 | 대기열(가상 대기실)로 유입 자체를 제어 |
| 공개 API 를 파는 SaaS | 약속한 처리량에서 SLO 를 지키나 | `constant-arrival-rate` 열린 모델 + thresholds | 닫힌 VU 모델은 조정 누락으로 낙관적 |
| 사내 플랫폼 CI | PR 마다 성능 회귀 차단 | 스모크 + thresholds, 종료 코드 99 를 게이트로 | 운영 APM 으로 사후 발견 |
| 게임·스트리밍 서버 런칭 | 장시간 운영 시 메모리·커넥션 누수 | 평균 부하 soak 수 시간, 힙 그래프가 계단인지 톱니인지 | 카나리 배포로 운영에서 관찰 |
| 인프라 증설 근거 마련 | 인스턴스 1대의 최대 처리량 | `ramping-arrival-rate` breakpoint + `abortOnFail` | 클라우드 사양표 추정 |

**이럴 땐 안 맞는다**
- 공지 없이 운영 환경이나 외부 API 에 부하 → 실제 장애이자 남의 서비스에 대한 공격이다. 스테이징과 스텁으로.
- 브라우저 렌더링·프론트 체감 성능 → HTTP 부하로는 안 보인다. k6 browser, Lighthouse, RUM 으로.

**누가 매일 만나나** — 백엔드·QA·성능 엔지니어가 이벤트 전 부하 리허설을 준비할 때, 플랫폼 팀이 CI 에 성능 게이트를 넣고 실패한 PR 의 요약을 읽을 때.

**면접·실무 단골 질문**
- Q. 닫힌 모델과 열린 모델의 차이는? → VU 루프는 서버가 느리면 요청을 덜 보내 조정 누락이 생긴다. 공개 서비스는 도착률 기반이 현실에 맞다.
- Q. `dropped_iterations` 가 0 이 아니면? → 목표 도착률을 못 냈다. `maxVUs` 부족이거나 서버가 그 속도를 못 받고 있다.

## 실습 체크리스트

- [ ] 스모크 스크립트를 `tests/perf/smoke.js` 로 저장하고 운영 빌드에 대해 돌려 임계값을 통과시킨다
- [ ] `ramping-arrival-rate` 로 breakpoint 테스트를 만들어 운영 빌드의 포화점을 찾는다
- [ ] 읽기 90% / 쓰기(진행률 토글) 10% 혼합 시나리오를 만든다
- [ ] `-o experimental-prometheus-rw` 로 Grafana 에 보내고 앱 RED 패널과 나란히 본다
- [ ] 10분 soak 를 돌리며 Node 힙(`process_resident_memory_bytes`)이 계단인지 톱니인지 본다
- [ ] GitHub Actions 에 스모크 테스트 잡을 추가해 PR 에서 돌게 한다
