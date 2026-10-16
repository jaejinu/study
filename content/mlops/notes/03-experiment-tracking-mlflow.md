---
title: "실험 추적 — MLflow 로 파라미터·메트릭·아티팩트를 남기고 모델을 승격한다"
order: 3
level: 중급
summary: "실험 추적이 없으면 무엇이 무너지는가, MLflow 의 데이터 모델(experiment·run·params·metrics·tags·artifacts), 무엇을 기록해야 재현되는가(코드 해시·데이터 버전·환경), REST API 로 직접 기록하고 검색하기(runs/search 의 필터·정렬 문법), 아티팩트 저장소, 모델 레지스트리와 별칭(@champion) 기반 승격, 프롬프트도 실험으로 추적하기, 대안 도구(W&B·Langfuse·DVC) 비교, 그리고 이 사이트의 MLflow 실험"
tags: [MLflow, 실험 추적, 모델 레지스트리, 별칭, 아티팩트, 재현성, runs/search, 프롬프트 버전]
experiments: [mlops-mlflow-tracking]
---

## 추적하지 않은 실험은 일어나지 않은 실험이다

두 주 전에 정답률이 가장 좋았던 설정을 다시 만들 수 있는가? 대부분은 못 한다. 노트북 셀을 여러 번 고쳐 돌렸고, 그때의 데이터 파일은 덮어썼고, 결과는 슬랙 스크린샷에만 남았다.

실험 추적(experiment tracking)은 **run 마다 입력과 출력을 자동으로 기록**해 다음 세 가지를 가능하게 한다.

1. **비교** — 어떤 변수가 결과를 바꿨나 (temperature 0.7 vs 0)
2. **재현** — 그 결과를 정확히 다시 만든다 (코드·데이터·설정·환경)
3. **승격** — 가장 좋은 결과를 근거와 함께 배포 후보로 올린다

## MLflow 의 데이터 모델

```
experiment "qa-prompt-tuning"          ← 질문 하나 ("어떤 프롬프트가 가장 정확한가")
 ├─ run "t=0"                          ← 한 번의 시도
 │   ├─ params   temperature=0, model=qwen2.5:1.5b, prompt_version=v3   (문자열, 한 번 쓰면 불변)
 │   ├─ metrics  recall=0.084 (step 0), recall_per_card=[0.12, 0, 0.18 …] (step 별 시계열)
 │   ├─ tags     dataset=quiz-golden-v1, git_sha=…, mlflow.source.name=…   (수정 가능한 메타데이터)
 │   └─ artifacts eval.json, confusion.png, model/                      (파일)
 ├─ run "t=0.7"
 └─ run "t=1.2"
registered model "qa-assistant"
 ├─ version 1  (source = runs:/<run_id>/model)
 ├─ version 2  ← alias @champion
 └─ version 3  ← alias @challenger
```

| 요소 | 타입 | 성질 | 예 |
|---|---|---|---|
| params | 문자열 | 한 run 에서 키당 한 번만 기록(불변) | 하이퍼파라미터, 모델 이름, 프롬프트 버전 |
| metrics | 숫자 | (key, step, timestamp) 시계열 | 손실, 정확도, 카드별 점수 |
| tags | 문자열 | 수정 가능 | 데이터셋 버전, git 해시, 담당자 |
| artifacts | 파일 | 아티팩트 저장소(S3·로컬·프록시) | 평가 결과 JSON, 그래프, 모델 파일 |

params 가 **문자열**이라는 점이 검색에서 중요하다. `params.temperature = '0'` 처럼 따옴표로 비교해야 하고 숫자 크기 비교는 안 된다. 크기로 걸러야 하는 값이면 metric 으로도 기록한다.

## 무엇을 기록해야 재현되는가

| 범주 | 기록할 것 | MLflow 에서 |
|---|---|---|
| 코드 | git 커밋 해시, 더러운 작업 트리 여부 | tag `mlflow.source.git.commit` (자동), 스크립트 경로 |
| 데이터 | 데이터셋 이름·버전·해시, 분할 시드 | tag 또는 `mlflow.log_input` (dataset 엔터티) |
| 설정 | 모든 하이퍼파라미터, 프롬프트 템플릿 버전 | params |
| 환경 | 라이브러리 버전, 이미지 다이제스트, 하드웨어 | 아티팩트 `requirements.txt`, tag |
| 결과 | 요약 지표 + 문항별 결과 원본 | metrics + 아티팩트 |

문항별 결과(어떤 문항을 틀렸나)를 **아티팩트로 꼭 남긴다.** 평균 점수만 남기면 "왜 떨어졌나" 를 나중에 조사할 수 없다.

## REST API 로 직접 써 보기

파이썬 SDK(`mlflow.log_param`)가 일반적이지만, 모든 기능은 REST API 이므로 어느 언어에서든 쓸 수 있다. 이 사이트의 실험은 TypeScript 에서 REST 로 기록한다.

```bash
M=http://localhost:15000/api/2.0/mlflow
# 1. 실험
curl -s -XPOST $M/experiments/create -d '{"name":"qa-temp-sweep"}'                 # → {"experiment_id":"1"}
# 2. run 시작
curl -s -XPOST $M/runs/create -d '{"experiment_id":"1","run_name":"t=0.7","start_time":'$(date +%s000)'}'
# 3. 한 번에 여러 개 기록 (호출 수를 줄인다)
curl -s -XPOST $M/runs/log-batch -d '{"run_id":"RUN","params":[{"key":"temperature","value":"0.7"}],
  "metrics":[{"key":"recall","value":0.155,"step":0,"timestamp":'$(date +%s000)'}]}'
# 4. 아티팩트 업로드 (서버가 --artifacts-destination 으로 프록시할 때)
curl -s -XPUT http://localhost:15000/api/2.0/mlflow-artifacts/artifacts/1/RUN/artifacts/eval.json --data-binary @eval.json
# 5. 종료
curl -s -XPOST $M/runs/update -d '{"run_id":"RUN","status":"FINISHED","end_time":'$(date +%s000)'}'
```

### 검색 문법

```bash
curl -s -XPOST $M/runs/search -d '{
  "experiment_ids": ["1"],
  "filter": "metrics.recall > 0.1 and params.model = '\''qwen2.5:1.5b'\'' and tags.dataset = '\''quiz-golden-v1'\''",
  "order_by": ["metrics.recall DESC", "params.temperature ASC"],
  "max_results": 5 }'
```

- `metrics.x` 는 숫자 비교(`>`, `<`, `=`), `params.x`·`tags.x` 는 문자열 비교(`=`, `!=`, `LIKE`)
- `attributes.status = 'FINISHED'`, `attributes.start_time > …` 로 run 속성도 걸 수 있다
- 정렬 키를 둘 이상 주면 동점 처리가 결정적이 된다

## 모델 레지스트리와 별칭

레지스트리는 "어떤 모델이 프로덕션에 있는가" 의 **단일 진실 공급원**이다.

```bash
curl -s -XPOST $M/registered-models/create -d '{"name":"qa-assistant"}'
curl -s -XPOST $M/model-versions/create -d '{"name":"qa-assistant","source":"runs:/RUN/model","run_id":"RUN"}'   # → version 3
curl -s -XPOST $M/registered-models/alias -d '{"name":"qa-assistant","alias":"champion","version":"3"}'
# 서빙 쪽은 버전 번호가 아니라 별칭으로 가져온다
curl -s "$M/registered-models/alias?name=qa-assistant&alias=champion"
```

| 방식 | 배포 코드 | 롤백 |
|---|---|---|
| 버전 번호 고정 | `models:/qa-assistant/3` | 코드 수정 + 재배포 |
| **별칭** | `models:/qa-assistant@champion` | 별칭을 이전 버전으로 옮기기만 |

예전의 "Staging/Production 단계(stage)" 는 MLflow 2.9 부터 **별칭으로 대체**됐다. 별칭은 여러 개를 자유롭게 정의할 수 있어서 `@champion`/`@challenger` 로 A/B 를, `@shadow` 로 섀도 배포를 표현한다. 이것은 [GitOps](/kubernetes/notes/13-gitops-progressive-delivery) 에서 이미지 태그 대신 다이제스트를 고정하고 승격을 git 커밋으로 하는 것과 같은 발상이다 — **"무엇이 배포돼 있나" 를 데이터로 남긴다.**

## 프롬프트도 실험이다

LLM 시스템에서 가장 자주 바뀌는 "모델" 은 프롬프트다. 프롬프트를 실험 추적에 넣는 방법:

| 방법 | 방식 |
|---|---|
| params 에 버전 | `prompt_version=v7` + 프롬프트 원문은 아티팩트 `prompt.txt` |
| 해시 | 프롬프트 원문의 SHA-256 앞 8자를 param 으로 — 같은 해시면 같은 프롬프트 |
| 전용 레지스트리 | MLflow Prompt Registry, Langfuse prompts — 버전·별칭(@production) 관리 |

그리고 **프롬프트 버전을 서빙 로그와 트레이스에 같이 남긴다.** 관측에서 품질이 떨어졌을 때 "어떤 프롬프트 버전부터" 를 바로 알 수 있다([LLM 관측](/observability/notes/08-llm-observability)).

## 도구 비교

| 도구 | 강점 | 자체 호스팅 |
|---|---|---|
| MLflow | 표준적, 레지스트리 내장, REST·여러 언어 | O (단일 서버 + DB + 아티팩트 저장소) |
| Weights & Biases | 시각화·협업 UI, 스윕 | 주로 SaaS |
| Langfuse / LangSmith | LLM 트레이스·프롬프트 관리·평가 데이터셋 | Langfuse O |
| DVC | 데이터·파이프라인 버전을 git 과 함께 | O (git + 원격 저장소) |
| 직접 (Postgres 테이블) | 단순, 기존 인프라 | O |

규모가 작으면 "Postgres 테이블 하나에 run 을 JSON 으로" 도 충분하다. 핵심은 도구가 아니라 **모든 평가 실행이 자동으로 기록되는 습관**이다.

## 운영 시 주의

- **백엔드 저장소**: 기본 파일 저장은 동시 쓰기에 약하다. 팀이 쓰면 Postgres/MySQL 백엔드.
- **아티팩트 크기**: 모델 파일은 수 GB. 아티팩트 저장소(S3 등)와 수명 주기 정책 필요.
- **삭제는 soft delete**: `experiments/delete` 는 휴지통으로 옮길 뿐이고 이름은 그대로 점유된다. 영구 삭제는 `mlflow gc`.
- **인증**: 기본 서버는 인증이 없다. 사내망이라도 리버스 프록시 인증을 둔다([Nginx](/nginx/notes/03-cache-tls-ratelimit)).

## 예시로 보기 — 이 프로젝트에서

`pnpm mlflow:up` 은 MLflow 2.22 를 SQLite 백엔드 + 로컬 아티팩트(볼륨 `mlflow-data`)로 **http://localhost:15000** 에 띄운다. 실험 [`mlops-mlflow-tracking`](/mlops/lab/mlops-mlflow-tracking) 이 하는 일:

1. 실험 `lab-temp-sweep-…` 생성
2. temperature 0·0.7·1.2 세 run — 각 run 에서 퀴즈 5문항에 답하게 하고 `recall`, `answer_len`, 카드별 `recall_per_card`(step=카드 번호) 를 log-batch 로 기록
3. 문항별 답변을 `eval.json` 아티팩트로 업로드
4. `runs/search order_by metrics.recall DESC` 로 최고 run 을 찾고, `filter "params.temperature = '0'"` 으로 문자열 필터 확인
5. 최고 run 을 레지스트리에 등록하고 `@champion` 별칭 → 별칭으로 조회해 run 이 일치하는지 확인
6. 등록 모델과 실험 삭제

한 번 돌린 결과(5문항, 1.5B):

| run | recall | 평균 답변 길이 |
|---|---|---|
| t=0.7 | 15.5% | 229자 |
| t=1.2 | 9.1% | 227자 |
| t=0 | 8.4% | 224자 |

5문항에서 이 차이는 [평가 노트](/mlops/notes/02-eval-datasets-metrics) 의 신뢰 구간 표로 보면 잡음 범위다. **추적 도구가 좋은 run 을 골라 주지만, 그 선택이 통계적으로 의미 있는지는 사람이 판단해야 한다.** UI 에서 보고 싶으면 실험 마지막 정리 단계 전에 http://localhost:15000 을 열어 두거나, 정리 부분을 주석 처리하고 돌린다.

## 실습 체크리스트

- [ ] `pnpm mlflow:up` 후 실험 `mlops-mlflow-tracking` 을 돌리고 runs/search 결과 표를 읽기
- [ ] 같은 실험을 다시 돌려 최고 run 이 바뀌는지 확인하고, 바뀐다면 그 이유를 신뢰 구간으로 설명하기
- [ ] curl 로 `runs/search` 의 `filter` 에 `metrics.recall > 0.1` 을 넣어 직접 질의하기
- [ ] 프롬프트 원문의 해시를 param 으로 기록하는 코드를 한 줄 써 보기
- [ ] `@champion` 별칭을 이전 버전으로 옮기는 것이 왜 "롤백" 인지 설명하기
