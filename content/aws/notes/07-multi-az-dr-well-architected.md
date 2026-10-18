---
title: "심화 — 멀티 AZ·재해 복구·Well-Architected·IaC 로 하나의 설계로 묶기"
order: 7
level: 심화
summary: "AZ 장애와 리전 장애를 구분한 고가용성 설계, 정적 안정성과 셀 아키텍처, RPO·RTO 에 따른 네 가지 DR 전략(백업 복원·파일럿 라이트·웜 스탠바이·멀티 사이트 액티브), 데이터 계층별 복제 방식, Well-Architected 여섯 기둥으로 이 사이트의 설계 점검하기, Terraform·CDK·CloudFormation 으로 인프라를 코드로 두기, 그리고 LocalStack 으로 하는 로컬 우선 개발"
tags: [멀티 AZ, 재해 복구, RPO, RTO, 정적 안정성, 셀 아키텍처, Well-Architected, Terraform, CDK, LocalStack]
experiments: [aws-dynamodb-modeling, aws-s3-sqs-pipeline]
---

## 장애의 크기부터 구분한다

| 장애 범위 | 빈도 | 대비 | 비용 |
|---|---|---|---|
| 인스턴스·컨테이너 | 매일 | 여러 개 + 자동 교체 (ASG, ECS 서비스, Deployment) | 낮음 |
| **AZ** | 드물지만 실제로 일어남 | **멀티 AZ** — 모든 계층을 2~3 AZ 에 | 중간 (AZ 간 전송·대기 인스턴스) |
| 리전 | 매우 드묾 | 멀티 리전 DR | 높음 |
| 계정·자격 증명 사고 (삭제·랜섬) | 드물지만 치명적 | 다른 계정으로 백업 복사, 삭제 방지 | 낮음~중간 |
| 사람 실수 (잘못된 배포·DROP TABLE) | 흔함 | PITR, 버전 관리, 카나리, 롤백 | 낮음 |

대부분의 서비스에 맞는 기본은 **"멀티 AZ 는 반드시, 멀티 리전은 비즈니스가 요구할 때"** 다. 그리고 실제 사고의 큰 몫은 마지막 두 줄이다.

## 멀티 AZ 설계

| 계층 | 멀티 AZ 방법 |
|---|---|
| 로드밸런서 | ALB/NLB 는 기본적으로 여러 AZ 서브넷에 |
| 컴퓨트 | ASG·ECS·EKS 노드를 3 AZ 에 고르게 (토폴로지 분산 제약) |
| 캐시 | ElastiCache Multi-AZ + 자동 장애 조치 ([04](/aws/notes/04-data-stores)) |
| RDS | Multi-AZ (동기 대기 인스턴스) 또는 Aurora |
| DynamoDB·S3·SQS | 리전 서비스 — 이미 여러 AZ 에 저장 |
| NAT 게이트웨이 | **AZ 마다 하나** — 하나만 두면 그 AZ 장애로 다른 AZ 의 외부 통신까지 끊긴다 |

### 정적 안정성

AZ 하나가 죽었을 때 **새로 무언가를 만들지 않아도** 버티도록 미리 용량을 깔아 두는 것. 장애 순간에는 컨트롤 플레인(새 인스턴스 시작 API)도 붐비거나 장애일 수 있기 때문이다.

```
필요 용량 6대, 3 AZ 운영:
  - 반응형:   2 + 2 + 2  → AZ 하나 장애 시 4대, 2대를 새로 띄워야 함 (그 순간 API 가 느리면?)
  - 정적 안정: 3 + 3 + 3  → AZ 하나 장애 시 6대, 아무것도 안 해도 됨 (평소 50% 과잉)
```

[성능 공학 07](/performance/notes/07-capacity-planning)의 헤드룸 계산과 같은 이야기다. "N+1" 이 아니라 "**AZ 단위 N+1**" 로 센다.

### 셀 아키텍처

서비스 전체를 여러 독립 **셀**(각자 앱·DB·캐시 한 벌)로 나누고 고객을 셀에 배정한다. 나쁜 배포·독 요청·핫 테넌트의 영향이 셀 하나로 제한된다([아키텍처 08](/architecture/notes/08-multitenancy-saas)). 배포도 셀 하나씩 — 카나리의 인프라 판이다.

## 재해 복구 — RPO 와 RTO

| 용어 | 질문 |
|---|---|
| **RPO** (복구 시점 목표) | 얼마만큼의 **데이터**를 잃어도 되나 |
| **RTO** (복구 시간 목표) | 얼마 동안 **멈춰도** 되나 |

| 전략 | 평소 다른 리전에 | RPO | RTO | 비용 |
|---|---|---|---|---|
| 백업 & 복원 | 백업만 (S3 교차 리전 복제, AWS Backup) | 시간 | 수 시간~하루 | $ |
| 파일럿 라이트 | 데이터 복제본 + 꺼진 인프라 정의(IaC) | 분 | 수십 분~시간 | $$ |
| 웜 스탠바이 | 축소된 전체 스택이 돌고 있음 | 초~분 | 분 | $$$ |
| 멀티 사이트 액티브-액티브 | 양쪽이 트래픽을 받음 | 거의 0 | 거의 0 | $$$$ + 쓰기 충돌 설계 |

**액티브-액티브는 데이터 문제다.** 두 리전에서 같은 데이터를 쓰면 충돌 해결이 필요하다(DynamoDB 글로벌 테이블은 마지막 쓰기 승리, Aurora 글로벌은 단일 쓰기 리전). [분산 시스템 03](/distributed-systems/notes/03-consistency-models)의 PACELC 가 정확히 이 선택이다.

### 데이터 계층별 복제

| 데이터 | 리전 간 복제 |
|---|---|
| S3 | 교차 리전 복제 (CRR), 복제 시간 제어(RTC) |
| DynamoDB | 글로벌 테이블 (다중 쓰기, LWW) |
| Aurora | 글로벌 데이터베이스 (1초 미만 지연, 장애 시 보조 리전 승격) |
| RDS | 교차 리전 읽기 복제본 |
| ElastiCache | 글로벌 데이터스토어 |
| MSK | MirrorMaker 2 / MSK Replicator |

**DR 계획은 연습하지 않으면 없는 것과 같다.** 백업 복원을 실제로 해 보고, 걸린 시간이 RTO 안인지 잰다. [장애 실험실 04](/chaos/notes/04-gameday-and-automation)의 게임데이를 리전 단위로 하는 것이다.

## Well-Architected 여섯 기둥으로 점검하기

| 기둥 | 질문 | 이 사이트에서 이미 한 것 |
|---|---|---|
| 운영 우수성 | 변경을 작게·자주·되돌릴 수 있게 하나? 관측하나? | GitOps·카나리([Kubernetes 13](/kubernetes/notes/13-gitops-progressive-delivery)), 관측 스택, 포스트모템 |
| 보안 | 최소 권한, 추적 가능성, 모든 계층 방어 | [보안 주제](/security/notes/01-security-mindset-threat-modeling), [IAM](/aws/notes/02-iam) |
| 안정성 | 장애에서 자동 복구, 용량 계획, 변경 관리 | 장애 실험·데드맨 스위치, SLO·번레이트 |
| 성능 효율성 | 맞는 자원 선택, 측정 | [성능 공학](/performance/notes/01-language-of-performance), 부하 테스트 |
| 비용 최적화 | 쓰는 만큼, 가시성, 단위 비용 | [FinOps](/finops/notes/02-unit-economics) |
| 지속 가능성 | 활용률을 높이고 낭비를 줄임 | 빈 패킹, Graviton, 데이터 수명 주기 |

Well-Architected Tool 은 이 질문들을 체크리스트로 주고 "고위험 항목" 을 뽑아 준다. 설계 리뷰의 공통 언어로 쓰면 좋다 — [SRE 06](/sre/notes/06-capacity-release-change)의 PRR 과 같은 역할이다.

## 인프라를 코드로 — Terraform·CDK·CloudFormation

| 도구 | 언어 | 상태 | 특징 |
|---|---|---|---|
| CloudFormation | YAML/JSON | AWS 가 관리 (스택) | AWS 만, 드리프트 감지, 롤백 내장 |
| CDK | TypeScript·Python 등 → CloudFormation 생성 | CloudFormation | 프로그래밍 언어로 추상화(Construct), 테스트 쉬움 |
| Terraform / OpenTofu | HCL | 직접 관리 (원격 백엔드) | 멀티 클라우드·SaaS 프로바이더, 이 사이트의 [`infra/local`](/iac/notes/07-provider-kubernetes-docker) |

이 사이트의 IaC 노트에서 배운 원칙이 그대로 적용된다: 원격 상태와 잠금(S3 + 잠금, [IaC 05](/iac/notes/05-state-management-deep)), 단계별 상태 분리(네트워크 / 데이터 / 앱), plan 을 PR 에 붙이고 정책 검사(checkov·OPA, [IaC 06](/iac/notes/06-drift-policy-testing)), 드리프트 감지.

```hcl
# 실험에서 만든 큐와 DLQ 를 Terraform 으로
resource "aws_sqs_queue" "dlq"    { name = "lab-dlq"; message_retention_seconds = 1209600 }
resource "aws_sqs_queue" "events" {
  name                       = "lab-events"
  visibility_timeout_seconds = 30
  receive_wait_time_seconds  = 20
  redrive_policy = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 3 })
}
```

### LocalStack 으로 로컬 우선 개발

Terraform AWS 프로바이더는 엔드포인트를 바꿀 수 있어서, 같은 코드를 LocalStack 에 먼저 apply 해 볼 수 있다(`tflocal`). [S3 → SQS 실험](/aws/lab/aws-s3-sqs-pipeline)과 [DynamoDB 실험](/aws/lab/aws-dynamodb-modeling)이 aws CLI 로 한 일을 Terraform 으로 옮기면, PR 마다 LocalStack 에서 리소스 생성과 API 흐름을 검증하는 CI 가 된다.

에뮬레이터가 **보장하지 않는 것**을 기억해야 한다.

| 검증 가능 | 검증 불가 (실제 계정 필요) |
|---|---|
| API 호출 순서·파라미터 | IAM 권한 ([IAM 실험](/aws/lab/aws-iam-policy-eval)이 보여 줌) |
| 리소스 간 연결(알림·DLQ) | 한도·스로틀링·성능 |
| 앱의 SDK 사용 | 네트워크(VPC·SG·엔드포인트) |
| IaC 의 문법·의존성 | 비용·리전별 기능 차이 |

## 예시로 보기 — 이 프로젝트에서

이 사이트를 AWS 에 올리는 최소 설계를 여섯 기둥으로 정리하면:

| 결정 | 근거 |
|---|---|
| 노트·퀴즈는 ECS Fargate 2 AZ (또는 정적 호스팅 + CloudFront) | 실험은 로컬, 읽기 전용은 가볍게 |
| 진행률 Redis → DynamoDB 단일 테이블 (`PK=SUBJECT#…`) | 서버 관리 없음, 사용량 적어 온디맨드가 쌈, PITR |
| 백업 & 복원 DR (RPO 하루, RTO 수 시간) | 개인 학습 사이트의 정당한 수준 |
| Terraform 3 단계 상태 (네트워크·데이터·앱) + GitHub OIDC 배포 | IaC·보안 노트의 원칙 그대로 |
| 예산 알림 월 $10 | 학습용 계정의 사고 방지 |

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| 장애 시 오토스케일링으로 용량을 늘릴 계획 | 같은 순간 모두가 같은 용량을 원해 제어 평면이 막힘 | 정적 안정성 — 미리 깔아 둔 용량 |
| 백업만 하고 복원은 안 해 봄 | 정작 필요할 때 복원 실패·RTO 초과 | 정기 복원 연습과 시간 측정 |
| 백업을 같은 계정·리전에만 | 계정 탈취·리전 장애 때 함께 잃음 | 교차 계정·교차 리전 복사, 불변 백업 |
| 액티브-액티브를 먼저 선택 | 충돌 해결·비용 폭증 | RPO·RTO 요구에서 거꾸로 전략 선택 |
| 콘솔에서 손으로 만든 인프라 | DR 리전에 똑같이 재현 불가 | Terraform·CDK 로 코드화 |

## 실전에서는 어디에 쓰이나

> 이 노트의 개념은 설계 리뷰·감사·사고 후 회고에서 "AZ 하나가, 리전 하나가 사라지면?" 이라는 질문을 받을 때 등장한다. 답은 기술보다 RPO·RTO 라는 비즈니스 숫자에서 시작한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 결제 서비스 | AZ 장애 순간에도 결제 유지 | 3 AZ 정적 안정성(용량을 미리 깔기), RDS Multi-AZ | 장애 시 오토스케일 — 제어 평면이 붐비면 실패 |
| 핀테크 규제 대응 | 리전 장애 DR 계획 증빙 | 파일럿 라이트 또는 웜 스탠바이 + 정기 복원 연습 | 백업 & 복원만 — RTO 요구를 못 맞출 수 있다 |
| 대형 B2B SaaS | 한 고객·한 배포의 사고가 전체로 번지지 않게 | 셀 아키텍처, 셀 단위 배포 | 단일 대형 클러스터 + 카나리 |
| 랜섬웨어·계정 탈취 대비 | 백업까지 함께 지워지는 것 방지 | 교차 계정·교차 리전 불변 백업 | 같은 계정 스냅샷 — 함께 잃는다 |
| 모든 규모의 인프라 변경 | 재현 가능한 인프라 | Terraform·CDK, PR 마다 plan·정책 검사, LocalStack 선검증 | 콘솔 수작업 — DR 리전에 재현 불가 |

**이럴 땐 안 맞는다**
- 요구 RPO·RTO 가 없는데 액티브-액티브부터 → 쓰기 충돌 설계와 비용이 폭증한다. 요구에서 거꾸로 전략을 고른다.
- 개인·내부 도구 → 멀티 리전은 과하다. 멀티 AZ + 백업 & 복원이면 충분하다.

**누가 매일 만나나** — SRE·플랫폼 엔지니어가 게임데이·복원 연습을 계획할 때, 아키텍트가 Well-Architected 리뷰로 고위험 항목을 뽑을 때.

**면접·실무 단골 질문**
- Q. RPO 와 RTO 의 차이? → 잃어도 되는 데이터 양 vs 멈춰도 되는 시간. 둘이 DR 전략과 비용을 정한다.
- Q. 정적 안정성이란? → AZ 하나를 잃어도 새로 만들지 않고 버티도록 AZ 단위 N+1 로 용량을 미리 둔다.

## 실습 체크리스트

- [ ] [클라우드 기초](/aws/notes/01-cloud-fundamentals)의 VPC 그림을 보고, AZ 하나가 사라졌을 때 남는 용량으로 버틸 수 있는지(정적 안정성) 계산하기
- [ ] 장애 범위 표의 다섯 줄 각각에 대한 이 사이트의 대비책을 말해 보기
- [ ] 정적 안정성 계산을 "필요 용량 10대, 2 AZ" 로 다시 해 보기 (AZ 당 10대)
- [ ] RPO 15분·RTO 1시간이 요구될 때 네 DR 전략 중 무엇을 고를지 근거와 함께 정하기
- [ ] 실험에서 만든 SQS 큐·DLQ·S3 알림을 Terraform 으로 써 보기
- [ ] 에뮬레이터로 검증할 수 없는 것 네 가지를 설명하고, 각각 어디서 검증할지 정하기
