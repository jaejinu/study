---
title: "LLM 서빙 — prefill·decode, 연속 배칭, KV 캐시와 PagedAttention, 양자화"
order: 5
level: 심화
summary: "LLM 추론이 두 단계(입력 전체를 한 번에 처리하는 prefill, 토큰을 하나씩 만드는 decode)로 나뉘는 이유와 각각의 병목(연산 vs 메모리 대역폭), TTFT·TPOT·처리량의 정의와 관계, KV 캐시의 크기 계산과 메모리 단편화, PagedAttention, 정적 배칭 vs 연속 배칭, 접두(프롬프트) 캐시, 투기적 디코딩, 양자화(GGUF·AWQ·FP8)의 트레이드오프, vLLM·Ollama·TGI 비교, 그리고 이 Mac 에서 잰 실측(prefill 5,700 토큰/초, TPOT 6ms, 캐시 적중 347→13ms, 동시 4 대기열)"
tags: [서빙, prefill, decode, TTFT, TPOT, KV 캐시, PagedAttention, 연속 배칭, 양자화, vLLM, Ollama]
experiments: [mlops-ollama-serving]
---

## 추론은 두 단계다

LLM 이 답을 만드는 과정은 성격이 전혀 다른 두 단계로 나뉜다.

![prefill 과 decode, 배칭과 대기열](/diagrams/mlops-serving.svg)

| | **prefill** | **decode** |
|---|---|---|
| 하는 일 | 입력 토큰 전체를 한 번에 통과시켜 KV 캐시를 채우고 첫 토큰을 낸다 | 토큰을 하나씩 생성, 매 스텝 KV 캐시에 한 줄 추가 |
| 병렬성 | 입력 토큰 N 개를 **행렬 곱 한 번**으로 — GPU 가 바쁘다 | 스텝마다 토큰 **1개** — 행렬×벡터 |
| 병목 | **연산(FLOPs)** | **메모리 대역폭** (스텝마다 가중치 전체를 읽는다) |
| 지표 | **TTFT** (Time To First Token) | **TPOT** (Time Per Output Token) = 토큰 간 간격 |
| 늘리는 것 | 입력 길이 | 출력 길이 |

그래서 총 지연은:

```
총 지연 ≈ TTFT + TPOT × (출력 토큰 수 − 1)
```

실험 [`mlops-ollama-serving`](/mlops/lab/mlops-ollama-serving) 에서 이 식을 직접 확인했다: 측정 389ms, 추정 389ms.

### decode 가 메모리 대역폭에 묶이는 이유

1.5B 모델(bf16 이면 약 3GB, Ollama 의 4비트 양자화면 약 1GB)이 토큰 하나를 만들려면 **가중치 전체를 메모리에서 한 번 읽어야** 한다. 메모리 대역폭이 B GB/s 면 토큰 1개에 최소 `모델 크기 / B` 초가 든다.

```
Apple M 계열 (예: 100~400 GB/s), 1.5B 4비트 ≈ 1 GB
→ 이론 최소 TPOT ≈ 1GB / 200GB/s = 5ms   ←  실측 6ms
```

이 계산이 실측과 거의 맞는다는 것이 "decode 는 대역폭 병목" 의 증거다. 더 빠른 연산 장치를 붙여도 decode 는 빨라지지 않고, **더 작은 모델(양자화)·더 넓은 메모리 대역폭**이 빨라지게 한다.

### prefill 처리량

같은 실험에서 고유 접두를 붙인 약 2,000 토큰 입력의 TTFT 는 347ms → **prefill 약 5,700 토큰/초**. 출력(decode) 약 160 토큰/초의 35배다. 입력 토큰이 출력 토큰보다 훨씬 싸게 처리되는 이유이고, API 가격표에서 입력 토큰 단가가 출력의 1/3~1/5 인 이유이기도 하다.

## 지표 정리

| 지표 | 정의 | 사용자 경험 |
|---|---|---|
| TTFT | 요청 → 첫 토큰 | "응답이 시작되기까지" — 스트리밍 UI 에서 가장 중요 |
| TPOT (ITL) | 토큰 간 평균 간격 | 글자가 흘러나오는 속도. 사람이 읽는 속도(초당 5~10 단어)보다 빠르면 충분 |
| E2E 지연 | 요청 → 마지막 토큰 | 비스트리밍 API, 에이전트의 툴 호출 사이 |
| 처리량 | 서버 전체의 출력 토큰/초 | 비용 (GPU 1장이 시간당 몇 토큰을 만드나) |
| 동시성 | 동시에 처리 중인 요청 수 | 용량 |

**TTFT·TPOT 는 사용자 지표, 처리량은 비용 지표**다. 둘은 배칭으로 서로 교환된다.

## KV 캐시

어텐션은 각 토큰이 앞선 모든 토큰의 Key·Value 를 본다. decode 스텝마다 앞 토큰들의 K·V 를 다시 계산하면 O(N²) 이 되므로, 계산해 둔 K·V 를 저장해 재사용한다 — **KV 캐시**.

### 크기

```
KV 캐시 = 2(K,V) × 층 수 × KV 헤드 수 × 헤드 차원 × 토큰 수 × 바이트
예) 7B급 (32층, KV 헤드 8 [GQA], 헤드 차원 128, fp16):
    2 × 32 × 8 × 128 × 2B = 131 KB / 토큰
    → 8K 컨텍스트 요청 1개 = 1 GB,  동시 32개 = 32 GB
```

KV 캐시가 **동시 요청 수의 상한**을 정한다. 모델 가중치보다 KV 캐시가 GPU 메모리를 더 먹는 경우가 흔하다. GQA(KV 헤드를 줄이는 구조)·KV 캐시 양자화(FP8, Ollama 의 `OLLAMA_KV_CACHE_TYPE=q8_0`)가 이 크기를 줄이는 기법이다.

### PagedAttention

예전 서버는 요청마다 **최대 길이만큼 연속 메모리**를 미리 잡았다. 실제로는 대부분 짧게 끝나므로 60~80% 가 낭비(내부 단편화)됐다.

vLLM 의 PagedAttention 은 운영체제의 가상 메모리처럼 KV 캐시를 **고정 크기 블록(예: 16토큰)** 으로 나누고, 요청마다 블록 테이블로 연결한다.

| | 연속 할당 | PagedAttention |
|---|---|---|
| 할당 단위 | 요청당 최대 길이 | 16토큰 블록, 필요할 때 |
| 낭비 | 60~80% | 4% 미만 (마지막 블록만) |
| 공유 | 불가 | 같은 접두를 가진 요청이 블록을 **공유** (copy-on-write) |
| 결과 | 동시 요청 적음 | 같은 GPU 로 동시 요청 2~4배 |

[운영체제 내부](/os-internals) 의 페이지 테이블·CoW 와 똑같은 아이디어다.

## 접두(프롬프트) 캐시

같은 접두(시스템 프롬프트, 긴 문서)로 시작하는 요청이 반복되면, 그 접두의 KV 캐시를 재사용해 prefill 을 건너뛴다.

| 실험 실측 (약 2,000 토큰 입력) | TTFT |
|---|---|
| 앞에 고유 문자열 → 캐시 미스 | **347ms** |
| 같은 입력 재전송 → 캐시 적중 | **13ms** |

캐시가 접두 단위로 동작하므로 **바뀌지 않는 부분을 앞에, 바뀌는 부분(사용자 질문)을 뒤에** 둬야 적중한다. API 공급자의 프롬프트 캐싱(Claude 의 `cache_control`, OpenAI 의 자동 캐싱)이 같은 원리이고 비용도 크게 할인된다 — [프롬프트 캐시·비용](/ai-systems/notes/05-prompt-cache-cost-latency).

> **벤치마크 함정:** 같은 프롬프트를 반복해서 재면 캐시 적중 숫자가 나온다. 실험의 '단일 요청 3회' 가 TTFT 10ms 로 나온 것이 바로 그 예다. 부하 테스트는 실제 트래픽처럼 **고유한 입력**으로 해야 한다([k6 부하 테스트](/performance/notes/03-k6-load-testing) 의 데이터 다양성).

## 배칭 — 처리량과 지연의 교환

decode 가 대역폭 병목이라는 것은 거꾸로 말하면, **가중치를 한 번 읽을 때 여러 요청의 토큰을 같이 만들면 거의 공짜**라는 뜻이다. 이것이 배칭이다.

| 방식 | 동작 | 문제 |
|---|---|---|
| 배칭 없음 (대기열) | 한 번에 하나 | 처리량 = 단일 요청 속도, 뒤 요청은 앞 요청이 끝날 때까지 대기 |
| 정적 배칭 | 요청 N 개를 모아 같이 시작, **가장 긴 요청이 끝날 때까지** 함께 | 짧은 요청이 긴 요청을 기다림, 빈 슬롯 낭비 |
| **연속 배칭** (iteration-level) | decode **스텝마다** 끝난 요청을 빼고 새 요청을 넣는다 | 구현이 복잡 (vLLM·TGI·TensorRT-LLM) |

연속 배칭은 처리량을 수 배~수십 배 올린다. 대신 배치가 커질수록 스텝 하나가 조금씩 느려지고(TPOT 증가), 새 요청의 prefill 이 진행 중인 decode 스텝에 끼어들어 다른 요청의 TPOT 를 흔든다(**chunked prefill** 로 완화).

### 실측 — Ollama 는 대기열이다

| 동시 요청 | TTFT 최소 | TTFT 최대 | TPOT p50 | 전체 토큰/초 |
|---|---|---|---|---|
| 1 | 34ms | 34ms | 6.1ms | 152 |
| 2 | 32ms | 437ms | 6.3ms | 154 |
| 4 | 33ms | **1277ms** | 6.1ms | 154 |

TTFT 최대가 요청 수에 비례해 계단처럼 늘고, 처리량은 그대로다. 요청이 **순서대로 처리**되고 있다는 뜻이다(이 설정의 `OLLAMA_NUM_PARALLEL` 이 1). 연속 배칭 서버였다면 처리량이 동시성에 따라 늘고, TTFT 최대는 훨씬 덜 늘었을 것이다. 이 표가 [꼬리 지연](/performance/notes/08-tail-latency-at-scale) 의 대기열 이론 — 사용률이 오르면 대기 시간이 폭발한다 — 의 LLM 판이다.

## 그 밖의 가속 기법

| 기법 | 원리 | 효과 |
|---|---|---|
| **투기적 디코딩** | 작은 초안 모델이 토큰 k 개를 추측 → 큰 모델이 한 번에 검증, 맞는 만큼 채택 | 출력이 같으면서 TPOT 2~3배 개선 (초안 적중률에 의존) |
| **양자화** | 가중치를 16비트 → 8/4비트 | 메모리·대역폭 절반~1/4 → decode 가 그만큼 빨라짐 |
| FlashAttention | 어텐션을 메모리 계층을 고려해 타일로 계산 | 긴 컨텍스트 prefill 가속, 메모리 절약 |
| 텐서 병렬 | 한 층을 GPU 여러 장에 나눠 계산 | 큰 모델을 올리고 지연을 낮춤 (GPU 간 통신 비용) |
| 분리 서빙 (disaggregated) | prefill 노드와 decode 노드를 분리 | 서로 간섭 없이 각자 최적화 |

### 양자화 형식

| 형식 | 쓰는 곳 | 메모 |
|---|---|---|
| GGUF (Q4_K_M, Q8_0 …) | llama.cpp, **Ollama** | CPU·Apple Silicon 친화, 형식 하나에 모델·토크나이저 |
| AWQ / GPTQ (4비트) | vLLM, TGI | GPU 용 가중치 양자화, 보정 데이터 사용 |
| FP8 | 최신 GPU (H100+) | 품질 손실 거의 없이 메모리 절반 |

4비트는 대부분의 작업에서 품질 손실이 작지만 **수학·코드·긴 추론**에서 차이가 드러난다. 양자화한 모델도 골든셋으로 평가하고 승격한다([노트 02](/mlops/notes/02-eval-datasets-metrics)).

## 서빙 엔진 비교

| | Ollama | vLLM | TGI / TensorRT-LLM |
|---|---|---|---|
| 목표 | 개발자 로컬, 간편함 | 처리량 최대 GPU 서빙 | 프로덕션 GPU 서빙 |
| 배칭 | 제한적 (NUM_PARALLEL) | 연속 배칭 + PagedAttention | 연속 배칭 |
| 하드웨어 | CPU·Apple Silicon·GPU | NVIDIA/AMD GPU 중심 | NVIDIA 중심 |
| API | OpenAI 호환 | OpenAI 호환 | OpenAI 호환(일부) |
| multi-LoRA | 제한적 | 지원 | 지원 |

OpenAI 호환 API 가 사실상 표준이 됐기 때문에, 이 사이트의 AI 에게 묻기는 코드 한 줄 안 바꾸고 `OPENAI_BASE_URL` 만으로 OpenAI ↔ Ollama ↔ vLLM 을 오갈 수 있다.

## 용량 계획 — 예시

"동시 사용자 50명, TTFT p95 < 1초, 평균 입력 2,000·출력 300 토큰" 이면:

1. KV 캐시: 2,300 토큰 × 131KB × 50 ≈ 15GB → 가중치 + KV 가 GPU 메모리에 들어가나
2. decode: 배치 50 에서 TPOT 이 SLO 이내인가 (배치가 클수록 TPOT 증가)
3. prefill: 초당 새 요청 수 × 2,000 토큰이 prefill 처리량의 몇 % 인가
4. 접두 캐시 적중률을 올리면 2·3 이 모두 줄어든다

이 계산은 [용량 계획](/performance/notes/07-capacity-planning) 의 리틀의 법칙(동시성 = 도착률 × 체류 시간)과 같은 틀이다.

## 예시로 보기 — 이 프로젝트에서

```bash
# 실험과 같은 측정을 직접: 스트리밍으로 첫 청크·청크 간격을 본다
curl -N localhost:11434/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"qwen2.5:1.5b","stream":true,"stream_options":{"include_usage":true},
  "max_tokens":64,"messages":[{"role":"user","content":"[req-'$RANDOM'] Redis 파이프라인을 두 문장으로"}]}'

# Ollama 동시 처리 수를 늘려 배칭 효과를 비교 (재시작 필요)
OLLAMA_NUM_PARALLEL=4 ollama serve
```

`OLLAMA_NUM_PARALLEL=4` 로 다시 띄우고 실험 [`mlops-ollama-serving`](/mlops/lab/mlops-ollama-serving) 을 돌리면 동시 4 의 TTFT 최대와 전체 토큰/초가 어떻게 바뀌는지 직접 볼 수 있다. 이 사이트의 LLM 메트릭(`study_llm_latency_seconds{phase="ttft"}`)은 Grafana 에서 같은 지표를 실시간으로 보여 준다 — [LLM 관측](/observability/notes/08-llm-observability).

## 실전에서는 어디에 쓰이나

> LLM 을 직접 서빙하거나 API 모델의 지연·비용을 설계할 때, TTFT·TPOT·KV 캐시·배칭이 용량과 비용을 정한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 사내 GPU 로 LLM API 제공 | 같은 GPU 로 동시 요청 수 늘리기 | vLLM 류 연속 배칭 + PagedAttention | Ollama — 제한적 배칭, 대기열 |
| 스트리밍 채팅 서비스 | 응답이 시작되기까지의 체감 지연 | TTFT 를 SLO 로, chunked prefill, 접두 캐시 | 처리량만 최적화 — TTFT 꼬리 증가 |
| 긴 시스템 프롬프트의 RAG·에이전트 | 반복 접두의 prefill 비용 | 고정 부분을 앞에 두어 접두·프롬프트 캐시 적중 | 매 요청 전체 prefill — 비용·TTFT 증가 |
| 노트북·온디바이스 추론 | 작은 메모리·대역폭 안에서 실행 | GGUF 4비트 양자화, Ollama·llama.cpp | fp16 원본 — 메모리 초과 |
| 코딩 어시스턴트 자동완성 | 짧은 출력의 토큰 간격 단축 | 투기적 디코딩, 작은 모델 | 큰 모델 단독 decode — TPOT 큼 |

**이럴 땐 안 맞는다**
- 트래픽이 적고 들쭉날쭉한 초기 서비스의 GPU 자체 서빙 — 유휴 GPU 비용이 API 요금보다 크기 쉽다.
- 같은 프롬프트를 반복하는 벤치마크 — 캐시 적중 숫자가 나온다. 고유한 입력으로 잰다.

**누가 매일 만나나** — ML·플랫폼 엔지니어가 GPU 용량 계획과 서빙 엔진을 고를 때, 백엔드가 스트리밍 UI 의 TTFT 를 SLO 로 잡고 대시보드에 올릴 때.

**면접·실무 단골 질문**
- Q. prefill 과 decode 의 병목은 어떻게 다른가? → prefill 은 연산, decode 는 메모리 대역폭. 그래서 양자화가 decode 를 빠르게 한다.
- Q. KV 캐시가 동시성 상한을 정하는 이유는? → 요청·토큰마다 메모리를 차지하기 때문. PagedAttention·GQA·KV 양자화로 줄인다.

## 실습 체크리스트

- [ ] 실험 `mlops-ollama-serving` 을 돌리고 "총 지연 ≈ TTFT + TPOT × (출력−1)" 를 숫자로 확인하기
- [ ] 이 Mac 의 메모리 대역폭을 찾아 이론 최소 TPOT 를 계산하고 실측과 비교하기
- [ ] 7B 모델(32층, KV 헤드 8, 헤드 차원 128)의 토큰당 KV 캐시 크기를 직접 계산하기
- [ ] `OLLAMA_NUM_PARALLEL=4` 로 재시작해 동시 4 실측 표가 어떻게 바뀌는지 기록하기
- [ ] AI 에게 묻기의 시스템 프롬프트가 접두 캐시에 유리한 구조인지(고정 부분이 앞에 있는지) 코드에서 확인하기
