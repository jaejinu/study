---
title: "관측과 비용 — CloudWatch·X-Ray·ADOT 를 이 사이트의 Prometheus·Loki·Tempo 와, AWS 청구서를 FinOps 노트와 맞춰 보기"
order: 6
level: 중급
summary: "메트릭·로그·트레이스 세 신호가 AWS 에서 어떤 서비스가 되는지(CloudWatch Metrics·Logs·Logs Insights, X-Ray·Application Signals, 관리형 Prometheus·Grafana), OpenTelemetry 수집기(ADOT)로 한 번 계측해 어디로든 보내기, CloudTrail 감사, 그리고 비용 구조 — 데이터 전송·NAT·로그 수집·커스텀 메트릭 같은 숨은 비용, 태그와 비용 탐색기, 예산 알림"
tags: [CloudWatch, X-Ray, ADOT, OpenTelemetry, AMP, AMG, CloudTrail, 비용, NAT, 데이터 전송]
experiments: [aws-s3-sqs-pipeline]
---

## 세 신호 → AWS

| 신호 | 이 사이트에서 직접 | AWS 네이티브 | AWS 관리형 오픈소스 |
|---|---|---|---|
| 메트릭 | Prometheus + 알림 규칙 | CloudWatch Metrics · Alarms | Amazon Managed Service for Prometheus (AMP) |
| 로그 | Loki + Alloy | CloudWatch Logs · Logs Insights | OpenSearch Service, (Grafana 로 Loki 연결) |
| 트레이스 | Tempo (OTLP) | X-Ray, CloudWatch Application Signals | — (X-Ray 가 OTLP 수신) |
| 대시보드 | Grafana | CloudWatch Dashboards | Amazon Managed Grafana (AMG) |
| 감사 | (없음) | **CloudTrail** — 모든 API 호출 기록 | |

선택의 기준은 하나다. **계측은 OpenTelemetry 로 한 번 하고, 보내는 곳은 바꿀 수 있게.** 이 사이트의 앱은 이미 `@vercel/otel` 로 OTLP 를 내보내고 있으므로([관측성 06](/observability/notes/06-tracing-otel)), AWS 에서는 엔드포인트만 ADOT 수집기로 바꾸면 된다.

## CloudWatch

| 기능 | 핵심 | 이 사이트와 비교 |
|---|---|---|
| 기본 메트릭 | AWS 서비스가 자동으로 (EC2 CPU, SQS 깊이, RDS 커넥션…) | redis_exporter·kube-state-metrics 가 하던 일 |
| 커스텀 메트릭 | `PutMetricData` 또는 **EMF**(로그에 메트릭을 JSON 으로 섞어 쓰면 자동 추출) | prom-client `/api/metrics` |
| 차원 | 메트릭의 레이블 — **차원 조합마다 별도 메트릭 = 별도 요금** | Prometheus 카디널리티 ([FinOps 04](/finops/notes/04-data-observability-cost)) |
| Alarms | 임계값·이상 탐지·복합 알람 → SNS | Alertmanager |
| Logs | 로그 그룹·스트림, 보존 기간 설정 (기본 **무기한**!) | Loki 보존 |
| Logs Insights | 쿼리 언어로 로그 검색·집계 (스캔한 GB 과금) | LogQL ([관측성 05](/observability/notes/05-logging-loki)) |
| Metric Filter | 로그 패턴을 메트릭으로 | LogQL 메트릭 질의 |

```
# Logs Insights — 이 사이트의 구조화 로그(JSON)라면 필드가 자동 인식된다
fields @timestamp, msg, route, durationMs
| filter level = "error"
| stats count() by route
| sort count desc
```

> **로그 그룹 보존 기본값은 "만료 없음"** 이다. 만들고 잊으면 수집 요금 + 저장 요금이 계속 쌓인다. 첫 번째로 확인할 비용 항목이다.

## 트레이스 — X-Ray 와 Application Signals

X-Ray 는 서비스 맵과 트레이스를 보여 준다. 지금은 **OTLP 를 직접 받으므로** 이 사이트의 OTel 계측이 그대로 들어간다. Application Signals 는 그 위에 서비스별 RED 메트릭·SLO 를 자동으로 만든다 — [SRE 02](/sre/notes/02-sli-slo-error-budget)에서 레코딩 룰로 손수 만든 것을 서비스가 대신한다.

샘플링이 비용의 핵심이다. 모든 요청을 트레이스하면 비싸다. 헤드 샘플링(예 5%) + 에러·느린 요청만 남기는 테일 샘플링(ADOT 수집기의 tail sampling 프로세서)을 조합한다.

## ADOT — AWS 판 OpenTelemetry 수집기

```yaml
receivers:  { otlp: { protocols: { grpc: {}, http: {} } }, prometheus: { config: { scrape_configs: [...] } } }
processors: { batch: {}, tail_sampling: { policies: [ { name: errors, type: status_code, status_code: { status_codes: [ERROR] } } ] } }
exporters:
  awsxray: {}                                  # 트레이스 → X-Ray
  prometheusremotewrite: { endpoint: https://aps-workspaces.ap-northeast-2.amazonaws.com/workspaces/ws-…/api/v1/remote_write, auth: { authenticator: sigv4auth } }
  awscloudwatchlogs: { log_group_name: /study/app }
```

이 사이트의 Alloy(로그 수집)와 Prometheus 스크레이프 역할을 수집기 하나가 맡는다. EKS 에서는 DaemonSet 이나 사이드카로, ECS 에서는 사이드카 컨테이너로 붙인다.

## CloudTrail — 누가 무엇을 했나

모든 AWS API 호출(콘솔 클릭 포함)이 이벤트로 남는다. 보안 사고 조사, 변경 추적, IAM 최소 권한 산출(Access Analyzer 가 이 기록으로 정책 생성, [02](/aws/notes/02-iam))의 원천이다. 조직 전체 트레일을 별도 감사 계정의 S3 로 보내고 SCP 로 끄지 못하게 막는 것이 기본 가드레일이다([보안 08](/security/notes/08-web-api-llm-security)의 감사 로그).

## 비용 구조 — 청구서에서 놀라는 곳

[FinOps 01](/finops/notes/01-cloud-cost-model)의 일반론이 AWS 에서 구체적으로 나타나는 곳:

| 항목 | 왜 놀라나 | 대처 |
|---|---|---|
| **NAT 게이트웨이** | 시간당 요금 + **처리 GB 당** 요금. 프라이빗 서브넷의 S3·ECR·DynamoDB 트래픽이 전부 NAT 를 지나면 크다 | S3·DynamoDB 게이트웨이 엔드포인트(무료), ECR·SQS 인터페이스 엔드포인트 |
| AZ 간 전송 | 같은 리전이라도 AZ 를 넘으면 양방향 요금 | 같은 AZ 우선 라우팅(토폴로지 인식), 캐시 복제본 배치 |
| 인터넷 송신 | GB 당 | CloudFront 앞에 (오리진 송신이 싸다), 압축 |
| CloudWatch Logs 수집 | GB 당 수집 요금이 저장보다 훨씬 큼 | 로그 레벨·샘플링, 디버그 로그 끄기, 보존 기간 |
| 커스텀 메트릭·차원 | 메트릭 수 × 시간 | 고카디널리티 차원 제거, EMF 로 필요한 것만 |
| 유휴 리소스 | 안 쓰는 EBS·스냅샷·탄력적 IP·로드밸런서 | 태그 정책 + 정기 정리 |
| 매니지드 서비스 최소 비용 | EKS 컨트롤 플레인, MSK 브로커, RDS 인스턴스는 놀아도 과금 | 개발 환경 스케줄 정지, 서버리스 옵션 |

### 비용을 보는 도구

| 도구 | 쓰임 |
|---|---|
| 비용 할당 태그 | `team`, `service`, `env` 태그를 활성화해야 비용 탐색기에서 묶인다 ([FinOps 06](/finops/notes/06-governance)) |
| Cost Explorer | 서비스·태그·사용 유형별 추이 |
| AWS Budgets | 예산·예측 초과 알림 → SNS |
| Cost Anomaly Detection | 평소 대비 급증을 자동 탐지 |
| CUR (Cost and Usage Report) | 줄 단위 원본 → S3 → Athena/ClickHouse 로 분석 ([ClickHouse 01](/clickhouse/notes/01-olap-columnar)) |

## 로컬 실험 ↔ AWS — 무엇이 달라지나

| 로컬 | AWS |
|---|---|
| Prometheus 를 켜 두면 끝, 비용 0 | 메트릭 수·로그 GB·트레이스 수가 곧 요금 |
| 스크레이프 대상 직접 설정 | AWS 서비스 메트릭은 자동, 앱 메트릭은 수집기가 |
| 알림은 Alertmanager → 웹훅 | CloudWatch Alarm → SNS → (Lambda, Chatbot, 이메일) |
| 장애 실험은 `docker pause` | AWS Fault Injection Service (FIS) — AZ 장애·API 스로틀링 주입 ([장애 실험실 04](/chaos/notes/04-gameday-and-automation)) |

## 예시로 보기 — 이 프로젝트에서

이 사이트의 관측을 그대로 옮기면:

| 지금 | AWS |
|---|---|
| `/api/metrics` (prom-client) | ADOT 가 스크레이프 → AMP, Grafana 대시보드(AMG)는 프로비저닝 JSON 그대로 |
| `logs/app.jsonl` → Alloy → Loki | stdout JSON → CloudWatch Logs (보존 30일), Logs Insights |
| OTLP → Tempo | OTLP → ADOT → X-Ray (테일 샘플링) |
| alert-rules.yml (번레이트) | AMP 의 규칙 + Alertmanager(관리형) 또는 CloudWatch 복합 알람 |
| [S3 → SQS 실험](/aws/lab/aws-s3-sqs-pipeline)의 DLQ | `ApproximateNumberOfMessagesVisible > 0` 알람 → SNS |

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| 로그 그룹 보존을 설정하지 않음 | 수년치 로그가 쌓여 저장 요금이 수집 요금을 따라잡음 | 생성 시 보존 기간을 IaC 기본값으로 (예 30일), 장기 보관은 S3 로 내보내기 |
| 디버그 로그를 운영에서 켜 둠 | 수집 GB 가 10배로 | 동적 로그 레벨, 샘플링 |
| 요청 id·사용자 id 를 메트릭 차원으로 | 차원 조합마다 메트릭 → 커스텀 메트릭 요금 폭증 | 고카디널리티 값은 로그·트레이스로 ([FinOps 04](/finops/notes/04-data-observability-cost)) |
| 모든 요청을 트레이스 | 트레이스 비용·수집기 부하 | 헤드 + 테일 샘플링 |
| 알람 액션을 연결하지 않음 | ALARM 상태인데 아무도 모름 | 알람마다 SNS 대상, 알람 자체를 테스트 |
| 단일 지표 알람만 | 깜빡이는 알람, 피로 | 복합 알람·M-of-N 데이터 포인트·번레이트 ([SRE 03](/sre/notes/03-burn-rate-alerting)) |
| 비용은 월말에 확인 | 실수한 리소스가 한 달 내내 과금 | Budgets 알림 + Cost Anomaly Detection 을 첫날부터 |

## 실전에서는 어디에 쓰이나

> 관측과 비용은 "장애가 났는데 무엇을 봐야 하나" 와 "이번 달 청구서는 왜 이렇게 나왔나" 라는 두 질문에서 함께 등장한다. 관측 데이터 자체가 큰 비용 항목이기 때문이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 마이크로서비스 운영 | 벤더에 묶이지 않고 세 신호 수집 | OTel 계측 → ADOT 수집기 → AMP·CloudWatch Logs·X-Ray | 서비스별 전용 에이전트 — 교체 비용이 크다 |
| 스타트업 비용 급증 | 원인 모를 청구서 증가 | Cost Explorer + 비용 할당 태그, Cost Anomaly Detection | 월말에 수동 확인 — 이미 한 달치 과금 |
| 프라이빗 서브넷 데이터 처리 | NAT 처리 요금 폭증 | S3·DynamoDB 게이트웨이 엔드포인트 | NAT 유지 — GB 당 요금이 계속 붙는다 |
| 보안 사고 조사 | 누가 언제 무엇을 바꿨나 | 조직 CloudTrail → 감사 계정 S3, SCP 로 끄기 금지 | 계정별 개별 트레일 — 공격자가 끌 수 있다 |

**이럴 땐 안 맞는다**
- 이미 Prometheus·Grafana·Loki 를 잘 운영하는 조직 → CloudWatch 로 전부 옮길 이유가 약하다. AMP·AMG 같은 관리형 오픈소스나 기존 스택 유지.
- 요청 id·사용자 id 를 메트릭으로 보고 싶을 때 → 차원 조합마다 요금. 고카디널리티 값은 로그·트레이스로.

**누가 매일 만나나** — SRE 가 알람·대시보드를 만들고 로그 보존 기간을 정할 때, FinOps 담당·플랫폼 리드가 월간 비용 리뷰에서 NAT·로그 수집 항목을 짚을 때.

**면접·실무 단골 질문**
- Q. CloudWatch Logs 비용을 줄이려면? → 수집 GB 가 핵심. 로그 레벨·샘플링, 보존 기간 설정, 장기 보관은 S3 로.
- Q. 모든 요청을 트레이스해야 하나? → 아니다. 헤드 샘플링 + 에러·느린 요청을 남기는 테일 샘플링.

## 실습 체크리스트

- [ ] 이 사이트의 세 신호가 AWS 에서 각각 어디로 가는지 표 없이 말해 보기
- [ ] 로그 그룹 보존 기본값이 왜 위험한지 비용으로 설명하기
- [ ] 프라이빗 서브넷의 앱이 S3 에 하루 500GB 를 쓸 때 NAT 경유와 게이트웨이 엔드포인트의 비용 차이를 계산 방식으로 설명하기
- [ ] 위 ADOT 설정에서 테일 샘플링이 하는 일을 설명하기
- [ ] DLQ 메시지 수 알람을 CloudWatch 알람 + SNS 로 설계해 보기
