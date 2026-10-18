---
title: "클라우드 기본기 — 리전·AZ·VPC·서브넷·보안 그룹, 그리고 책임 공유"
order: 1
level: 기초
summary: "이 사이트에서 Docker·kind 로 직접 돌린 것들이 AWS 에서는 어떤 물리·네트워크 구조 위에 올라가는지: 리전과 가용 영역(AZ), VPC·서브넷(퍼블릭·프라이빗)·라우트 테이블·인터넷 게이트웨이·NAT 게이트웨이, 보안 그룹과 NACL, VPC 엔드포인트, 책임 공유 모델과 '매니지드' 의 정확한 의미, 로컬 실험과 클라우드의 차이 표"
tags: [AWS, 리전, 가용 영역, VPC, 서브넷, 보안 그룹, NAT, VPC 엔드포인트, 책임 공유 모델, LocalStack]
experiments: [aws-s3-sqs-pipeline, aws-iam-policy-eval]
---

## 이 주제의 관점

이 사이트에서는 Redis·Kafka·PostgreSQL·Kubernetes·S3 호환 저장소·관측 스택을 **전부 내 Mac 위에서** 돌렸다. 클라우드로 옮기면 같은 기능을 **매니지드 서비스**로 쓰게 된다. 이 주제는 새 서비스를 처음부터 외우는 대신, 이미 손으로 만져 본 것을 기준으로 "AWS 에서는 무엇이 같고 무엇이 달라지는가" 를 정리한다.

| 이 사이트에서 직접 | AWS 매니지드 | 노트 |
|---|---|---|
| Docker 컨테이너, kind 클러스터 | ECS·Fargate, EKS, EC2, Lambda | [03](/aws/notes/03-compute-containers) |
| Redis (Docker, Sentinel, Cluster) | ElastiCache, MemoryDB | [04](/aws/notes/04-data-stores) |
| PostgreSQL + pgvector | RDS for PostgreSQL, Aurora | [04](/aws/notes/04-data-stores) |
| Kafka, RabbitMQ, NATS | MSK, SQS·SNS, EventBridge, Kinesis | [05](/aws/notes/05-messaging-streaming) |
| Prometheus·Loki·Tempo·Grafana | CloudWatch, X-Ray, AMP·AMG, ADOT | [06](/aws/notes/06-observability-cost) |
| S3 호환 저장소(versitygw), MinIO | S3 | 이 노트, [05](/aws/notes/05-messaging-streaming) |
| OpenTofu `infra/local` | Terraform AWS 프로바이더, CDK, CloudFormation | [07](/aws/notes/07-multi-az-dr-well-architected) |

실험은 **LocalStack**(AWS API 를 흉내 내는 컨테이너)으로 돌린다. API 모양은 실제와 같지만 성능·한도·권한 강제는 다르다 — 그 차이 자체가 배울 거리다.

## 리전과 가용 영역

| 단위 | 정의 | 예 | 의미 |
|---|---|---|---|
| 리전 | 지리적으로 떨어진 독립 지역 | ap-northeast-2 (서울) | 데이터 주권, 지연, 서비스·가격이 리전마다 다름 |
| 가용 영역 (AZ) | 리전 안의 물리적으로 분리된 데이터센터 묶음 (전원·냉각·네트워크 독립) | ap-northeast-2a, 2b, 2c, 2d | **장애 격리 단위** — AZ 하나가 통째로 죽을 수 있다고 가정 |
| AZ 간 지연 | 같은 리전 안 | 보통 1~2ms 미만 | 동기 복제가 가능한 거리 |
| 엣지 로케이션 | CloudFront·Route 53 의 PoP | 수백 곳 | CDN·DNS ([네트워크 프로토콜 06](/network-protocols/notes/06-load-balancing-cdn)) |

**멀티 AZ 는 고가용성, 멀티 리전은 재해 복구**라고 기억하면 된다. 단일 AZ 에 모든 것을 두면 그 AZ 장애가 곧 서비스 장애다. 이 사이트의 [Redis Sentinel 실험](/redis/notes/11-replication-sentinel-cluster)에서 노드 하나를 죽였던 것이 AWS 에서는 "AZ 하나를 잃는" 상황에 대응한다.

> AZ 이름(2a, 2b)은 **계정마다 실제 데이터센터와의 매핑이 다르다**. 계정 간에 같은 AZ 를 맞추려면 AZ ID(apne2-az1)를 쓴다.

## VPC — 내 사설 네트워크

**VPC**: 리전 안에서 내 계정 전용의 가상 네트워크(CIDR, 예 10.0.0.0/16). 그 안을 AZ 별 **서브넷**으로 나눈다.

```
VPC 10.0.0.0/16 (ap-northeast-2)
├─ AZ a ─ 퍼블릭 10.0.0.0/24   ← ALB, NAT 게이트웨이
│        └ 프라이빗 10.0.10.0/24 ← EKS 노드, 앱
│        └ 데이터  10.0.20.0/24 ← RDS, ElastiCache
├─ AZ b ─ (같은 구조)
└─ AZ c ─ (같은 구조)
```

| 구성 요소 | 하는 일 | 로컬 대응 |
|---|---|---|
| 서브넷 | VPC CIDR 의 한 조각, **AZ 하나에 속함** | Docker 브리지 네트워크 하나 |
| 라우트 테이블 | 서브넷의 트래픽을 어디로 보낼지 | `ip route` ([Linux 네트워크 02](/linux-network/notes/02-ip-ports-sockets)) |
| 인터넷 게이트웨이 (IGW) | VPC ↔ 인터넷 (양방향) | Docker 의 포트 공개 `-p` |
| **퍼블릭 서브넷** | 라우트에 `0.0.0.0/0 → IGW` 가 있는 서브넷 | |
| NAT 게이트웨이 | 프라이빗 서브넷이 **나가는** 인터넷만 (SNAT) | Docker 컨테이너의 기본 아웃바운드 MASQUERADE ([Docker 04](/docker/notes/04-volumes-networks)) |
| **프라이빗 서브넷** | IGW 경로가 없는 서브넷 — 밖에서 직접 못 들어온다 | |
| VPC 엔드포인트 | S3·SQS 등 AWS API 를 인터넷·NAT 없이 사설로 | 같은 Docker 네트워크 안 서비스 이름 |

![VPC 한 개, AZ 세 개](/diagrams/aws-vpc-layout.svg)

DB·캐시는 **프라이빗(데이터) 서브넷**에, 로드밸런서만 퍼블릭에 둔다. 앱이 S3·SQS 를 부를 때 NAT 를 거치면 **NAT 처리 요금**이 붙으므로 대량 트래픽은 **게이트웨이 엔드포인트(S3·DynamoDB, 무료)** 나 인터페이스 엔드포인트로 돌린다 — [FinOps 01](/finops/notes/01-cloud-cost-model)의 egress 비용과 직결된다.

## 보안 그룹과 NACL

| | 보안 그룹 (SG) | 네트워크 ACL |
|---|---|---|
| 붙는 곳 | ENI(인스턴스·Pod·RDS) | 서브넷 |
| 상태 | **상태 저장** — 나간 요청의 응답은 자동 허용 | 상태 없음 — 응답 포트(임시 포트)까지 따로 허용 |
| 규칙 | Allow 만 | Allow·Deny, 번호 순 평가 |
| 참조 | **다른 SG 를 출처로 지정 가능** ("앱 SG 에서 오는 6379 허용") | CIDR 만 |
| 실무 | 주력 | 서브넷 단위 거친 차단(보조) |

SG 끼리 참조하는 패턴이 핵심이다. "DB SG 는 앱 SG 에서 오는 5432 만 허용" 이라고 적으면 IP 가 바뀌어도 규칙이 유지된다. 이것은 Kubernetes NetworkPolicy 가 레이블로 Pod 를 고르는 것과 같은 발상이다([보안 06](/security/notes/06-kubernetes-security) 의 NetworkPolicy 실험).

## 책임 공유 모델

AWS 는 **클라우드 "의" 보안**(하드웨어, 하이퍼바이저, 매니지드 서비스의 소프트웨어)을, 고객은 **클라우드 "안" 의 보안**(데이터, IAM, 네트워크 설정, OS·앱)을 책임진다. 서비스가 매니지드일수록 경계가 위로 올라간다.

| 항목 | EC2 | RDS | Lambda | S3 |
|---|---|---|---|---|
| 물리·하이퍼바이저 | AWS | AWS | AWS | AWS |
| OS 패치 | **고객** | AWS | AWS | AWS |
| DB 엔진 패치 | 고객 | AWS (유지 관리 창은 고객이 정함) | — | — |
| 백업 설정·보존 | 고객 | 고객이 설정, AWS 가 실행 | — | 버전 관리·수명 주기는 고객 |
| 네트워크 노출 (SG, 퍼블릭 여부) | **고객** | **고객** | **고객** | **고객** (버킷 정책·퍼블릭 액세스 차단) |
| IAM·데이터 암호화 키 정책 | **고객** | **고객** | **고객** | **고객** |

**"매니지드" 는 운영 일부를 사는 것이지 설계 책임을 사는 것이 아니다.** 실제 사고 대부분은 마지막 두 줄(퍼블릭 S3 버킷, 과한 IAM 권한)에서 난다.

## 로컬 실험 ↔ AWS — 무엇이 달라지나

| 로컬에서 겪은 것 | AWS 에서 달라지는 점 |
|---|---|
| 포트 충돌을 피해 18083·19092 같은 포트를 골랐다 | 각 서비스가 자기 엔드포인트(DNS)를 갖는다. 포트 걱정 대신 SG·엔드포인트 정책 |
| `docker compose up` 이면 끝 | VPC·서브넷·SG·IAM·KMS 키·파라미터 그룹을 먼저 설계해야 한다 |
| 모든 게 같은 Mac 이라 지연이 0 에 가깝다 | AZ 간 1ms 안팎, 리전 간 수십~수백 ms. 동기 복제 위치가 설계 결정 |
| 자원이 공짜 (전기료만) | 시간·요청·저장·**전송**마다 요금. 켜 두면 돈 |
| LocalStack 은 IAM 을 강제하지 않는다 | 모든 API 호출이 IAM 평가를 거친다 ([02](/aws/notes/02-iam), [IAM 실험](/aws/lab/aws-iam-policy-eval)) |
| 장애 실험은 `docker pause` | AZ 장애, 서비스 이벤트, 한도(quota) 초과, 스로틀링 |

## 예시로 보기 — 이 프로젝트에서

이 사이트를 AWS 에 올린다면 이런 그림이 된다.

| 이 사이트 구성 | AWS 배치 |
|---|---|
| Next.js 앱 (Docker 이미지) | ECS Fargate 또는 EKS, 프라이빗 서브넷 2~3 AZ, 앞에 ALB(퍼블릭) |
| Redis (진행률·퀴즈·학습 시간) | ElastiCache for Redis, 데이터 서브넷, 앱 SG 에서만 6379 |
| PostgreSQL (실험용) | RDS Multi-AZ, 데이터 서브넷 |
| 노트 Markdown | 이미지에 포함 (또는 S3 + CloudFront) |
| 관측 | ADOT 수집기 → AMP(Prometheus) / CloudWatch Logs / X-Ray |
| 비밀 (OPENAI_API_KEY) | Secrets Manager, 태스크 역할로 읽기 ([보안 04](/security/notes/04-secrets-management)) |

[S3 → SQS 실험](/aws/lab/aws-s3-sqs-pipeline)은 LocalStack 위에서 버킷 알림·큐·DLQ 를 실제 aws CLI 로 만든다. 같은 명령에서 `--endpoint-url` 만 빼면 진짜 AWS 에 그대로 동작한다 — API 가 같다는 것이 에뮬레이터의 가치다.

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| NAT 게이트웨이를 한 AZ 에만 | 그 AZ 장애 시 모든 프라이빗 서브넷의 외부 통신 단절 | AZ 마다 NAT, 라우트는 같은 AZ 로 |
| S3 트래픽을 NAT 로 보냄 | GB 당 처리 요금이 쌓임 | 게이트웨이 VPC 엔드포인트 |
| 보안 그룹 소스를 0.0.0.0/0 으로 | DB·캐시가 인터넷에 노출될 위험 | 앱 보안 그룹을 소스로 참조 |
| CIDR 를 작게 잡음 | EKS Pod IP 가 모자라 확장 불가 | 처음부터 /16, 서브넷도 넉넉히 |
| 단일 AZ 배포 | AZ 하나 장애가 곧 전면 장애 | 최소 두 AZ, 가능하면 세 AZ |

## 실전에서는 어디에 쓰이나 — AWS 지도

> AWS 는 직접 돌리던 서버·DB·큐·관측 스택을 "API 로 빌려 쓰는" 기반이다. 실무에서 맡는 역할은 서비스 선택보다 네트워크·권한·장애 범위·비용을 처음에 바르게 짜는 쪽에 가깝다.

| 서비스·상황 | 이 주제의 어떤 부분이 | 더 읽기 |
|---|---|---|
| 신규 서비스 인프라 처음 깔기 | VPC·서브넷 3계층, 보안 그룹 참조, NAT·엔드포인트 | 이 노트 |
| CI·앱·사람의 접근 권한 정리 | 역할 위임, OIDC, 권한 경계·SCP | [IAM](/aws/notes/02-iam) |
| 컨테이너 앱 배포 플랫폼 고르기 | ECS·Fargate·EKS·Lambda 의 운영 부담과 제약 | [컴퓨트와 컨테이너](/aws/notes/03-compute-containers) |
| 캐시·DB 를 매니지드로 옮기기 | ElastiCache·RDS·Aurora·DynamoDB 의 장애 조치와 설계 | [데이터 스토어](/aws/notes/04-data-stores) |
| 비동기 작업·이벤트 연동 | SQS·SNS·EventBridge·MSK, DLQ | [메시징·스트리밍](/aws/notes/05-messaging-streaming) |
| 청구서가 갑자기 늘었을 때 | NAT·로그 수집·커스텀 메트릭 같은 숨은 비용 | [관측과 비용](/aws/notes/06-observability-cost) |
| 장애·감사 대비 설계 리뷰 | 멀티 AZ, RPO·RTO, Well-Architected, IaC | [멀티 AZ·DR](/aws/notes/07-multi-az-dr-well-architected) |

**회사 규모에 따라**
- 스타트업: 계정 하나, 리전 하나, 2 AZ 에 Fargate·RDS 같은 가장 매니지드한 조합으로 시작한다. 콘솔 작업이 섞이기 쉽다.
- 성장기: 환경별 계정 분리, Terraform·CDK 로 코드화, 비용 태그와 예산 알림이 들어온다. EKS 로 옮길지 고민하는 시기다.
- 대규모 조직: 조직(Organizations)·SCP 로 수백 개 계정을 가드레일로 묶고, 플랫폼 팀이 VPC·네트워크 허브·공용 모듈을 제공한다.

**이럴 땐 안 맞는다**
- 트래픽이 거의 없는 개인 프로젝트·정적 사이트 → VPC·NAT·RDS 를 다 깔면 최소 비용이 크다. 정적 호스팅이나 PaaS 가 싸고 단순하다.
- 커널·특수 하드웨어를 직접 다뤄야 하는 실험 → Fargate·Lambda 로는 불가. EC2 나 온프레미스.

**누가 매일 만나나** — 플랫폼·SRE 엔지니어는 VPC 설계와 보안 그룹 변경 리뷰를, 백엔드 개발자는 "왜 DB 에 연결이 안 되지" 를 디버깅하다 보안 그룹·서브넷 라우트를 처음 들여다본다. 보안 담당은 책임 공유 모델의 "고객 몫" 인 퍼블릭 노출 설정을 점검한다.

## 실습 체크리스트

- [ ] 서울 리전의 AZ 이름과 AZ ID 를 확인하고 왜 둘이 다른지 설명하기
- [ ] 위 VPC 그림을 3 AZ × (퍼블릭·프라이빗·데이터) 서브넷 CIDR 로 직접 나눠 보기
- [ ] "DB SG 는 앱 SG 에서 오는 5432 만 허용" 규칙을 적어 보고 IP 기반 규칙보다 나은 이유를 말하기
- [ ] 책임 공유 표에서 EC2 와 RDS 의 차이 세 가지를 설명하기
- [ ] [S3 → SQS 실험](/aws/lab/aws-s3-sqs-pipeline)을 돌리고 같은 명령을 실제 AWS 에서 쓰려면 무엇만 바꾸면 되는지 확인하기
