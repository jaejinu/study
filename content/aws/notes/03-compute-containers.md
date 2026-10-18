---
title: "컴퓨트와 컨테이너 — EC2·ECS·Fargate·EKS·Lambda 를 이 사이트의 Docker·kind 와 비교하기"
order: 3
level: 중급
summary: "어디까지를 내가 운영하고 어디부터를 AWS 에 맡기는가로 보는 컴퓨트 스펙트럼, EC2 인스턴스 패밀리와 구매 방식, ECS 의 태스크·서비스와 Fargate, EKS 의 컨트롤 플레인·노드 그룹·Karpenter, Lambda 의 실행 모델과 콜드 스타트·동시성 한도, 각 선택이 이 사이트의 kind 실험(HPA·롤아웃·네트워크 정책)과 어떻게 대응되는지"
tags: [EC2, ECS, Fargate, EKS, Lambda, Karpenter, 콜드 스타트, 컨테이너, 서버리스]
experiments: [aws-s3-sqs-pipeline]
---

## 컴퓨트 스펙트럼 — 누가 무엇을 운영하나

| | EC2 | ECS on EC2 | ECS on Fargate | EKS (관리형 노드) | EKS + Fargate | Lambda |
|---|---|---|---|---|---|---|
| OS·패치 | 나 | 나 | AWS | 나 (AMI 갱신) | AWS | AWS |
| 오케스트레이터 | 직접 | AWS (ECS) | AWS (ECS) | AWS 컨트롤 플레인 + 쿠버네티스 | 〃 | 없음 (이벤트 → 함수) |
| 단위 | 인스턴스 | 태스크 | 태스크 | Pod | Pod | 함수 호출 |
| 스케일 속도 | 분 | 초~분 | 수십 초 | 초(Pod)·분(노드) | 수십 초 | 밀리초~초 |
| 한 번에 최대 실행 | 무제한 | 무제한 | 무제한 | 무제한 | 무제한 | 15분 |
| 비용 단위 | 인스턴스·초 | 인스턴스 | vCPU·GB·초 | 인스턴스 + 클러스터 시간당 | vCPU·GB·초 | 요청 + GB·초 |

오른쪽으로 갈수록 **운영 부담은 줄고 제약은 늘어난다**. 이 사이트가 로컬에서 고른 것은 가장 왼쪽(Docker 를 직접)과 EKS 에 해당하는 kind 다.

## EC2 — 가상 머신

| 구분 | 의미 | 예 |
|---|---|---|
| 패밀리 | 용도별 CPU:메모리 비율 | m(범용), c(연산), r(메모리), t(버스트), g/p(GPU), i(로컬 NVMe) |
| 세대·프로세서 | 숫자와 접미사 | m7g(Graviton ARM), m7i(Intel), m7a(AMD) |
| 크기 | vCPU·메모리 배수 | large(2 vCPU) → xlarge(4) → 2xlarge(8) |
| 버스트형 t | 기준 CPU 를 넘으면 크레딧 소모 | 크레딧이 떨어지면 기준 성능으로 추락 — 성능 이상의 흔한 원인 |

**Graviton(ARM)** 은 같은 성능에 20~40% 싸다. 이 사이트를 돌리는 Mac 이 ARM 이라 이미지가 ARM 으로 빌드되는데, x86 서버로 보내려면 멀티 플랫폼 빌드가 필요하다([Docker 09](/docker/notes/09-buildkit-multiplatform)). Graviton 이면 그 걱정이 없다. 메모리 모델 차이(x86 TSO vs ARM 약한 순서)는 [동시성 05](/concurrency/notes/05-memory-model-visibility) 참고.

구매 방식(온디맨드·Savings Plan·스팟)은 [FinOps 01](/finops/notes/01-cloud-cost-model)에서 다뤘다.

## ECS 와 Fargate

**ECS**: AWS 자체 컨테이너 오케스트레이터. 쿠버네티스보다 개념이 적다.

| ECS | 쿠버네티스 대응 |
|---|---|
| 태스크 정의 (컨테이너들 + CPU·메모리 + 역할 + 로그 설정) | Pod 스펙 |
| 태스크 | Pod |
| 서비스 (원하는 태스크 수, 롤링 배포, ALB 연결) | Deployment + Service |
| 클러스터 | 클러스터 |
| 태스크 역할 / 실행 역할 | ServiceAccount(+IRSA) / kubelet 이 이미지 받을 권한 |
| 서비스 자동 확장 (대상 추적) | HPA |
| awsvpc 네트워크 모드 (태스크마다 ENI, SG 직접 부착) | CNI 가 Pod 마다 IP |

**Fargate**: 노드 없이 태스크·Pod 만 띄운다. 서버 패치·용량 계획이 사라지지만 GPU·특권 컨테이너·데몬셋이 안 되고, 같은 사양 EC2 보다 비싸다. 이 사이트의 [Falco](/security/notes/05-container-supply-chain)나 [eBPF 실험](/ebpf/notes/02-bpftrace-one-liners)처럼 **커널에 접근하는 일은 Fargate 에서 불가능**하다 — 노드가 내 것이 아니기 때문이다.

## EKS — 매니지드 쿠버네티스

| 구성 | 누가 | kind 실험과의 차이 |
|---|---|---|
| 컨트롤 플레인 (API 서버·etcd·스케줄러) | AWS (멀티 AZ, 시간당 요금) | kind 는 컨테이너 하나 안에 다 있다 |
| 데이터 플레인 | 관리형 노드 그룹, 자체 관리 노드, Fargate, **Karpenter**, EKS Auto Mode | kind 노드 = Docker 컨테이너 |
| 네트워크 | VPC CNI — Pod 가 VPC IP 를 직접 받음 | kindnet, Calico (study-netpol) |
| 로드밸런서 | AWS Load Balancer Controller → ALB/NLB | NodePort·port-forward |
| 스토리지 | EBS CSI(AZ 단위 볼륨!), EFS CSI | local-path |
| 신원 | IRSA / Pod Identity ([02](/aws/notes/02-iam)) | ServiceAccount 만 |

EKS 에서 처음 부딪히는 함정들:

- **EBS 볼륨은 AZ 에 묶인다.** StatefulSet Pod 가 다른 AZ 로 재스케줄되면 볼륨을 붙이지 못해 Pending 이 된다([Kubernetes 06](/kubernetes/notes/06-storage-statefulset)). 토폴로지 인식 스케줄링(WaitForFirstConsumer)이 필요하다.
- **VPC CNI 의 IP 고갈.** Pod 마다 VPC IP 를 쓰므로 서브넷이 작으면 Pod 를 못 띄운다. 접두사 위임(prefix delegation)이나 넉넉한 CIDR.
- **노드 오토스케일링.** HPA 가 Pod 를 늘려도 자리가 없으면 Pending — Cluster Autoscaler 나 Karpenter 가 노드를 추가한다. Karpenter 는 Pending Pod 를 보고 **알맞은 인스턴스 타입을 직접 골라** 띄우고, 비어 가는 노드를 통합(consolidation)해 비용을 줄인다([Kubernetes 14](/kubernetes/notes/14-scheduling-autoscaling-deep)).

## Lambda — 함수 단위 실행

이벤트(HTTP·SQS·S3·EventBridge·스케줄)가 오면 함수를 실행하고, 끝나면 돈을 내지 않는다.

| 개념 | 설명 |
|---|---|
| 실행 환경 | 경량 VM(Firecracker) 안의 런타임. 끝나도 잠시 재사용(웜) |
| **콜드 스타트** | 새 실행 환경을 만들 때의 지연 — 런타임·패키지 크기·VPC 연결·초기화 코드에 따라 수백 ms ~ 수 초 |
| 동시성 | 동시에 도는 실행 환경 수. 계정·리전 한도가 있고, 예약 동시성으로 함수별 상한·보장 |
| 프로비저닝된 동시성 | 미리 데워 둔 환경 — 콜드 스타트 제거, 대신 상시 비용 |
| 최대 실행 시간 | 15분 |
| SQS 트리거 | 배치로 가져와 실행, 실패하면 가시성 타임아웃 뒤 재시도 → DLQ ([05](/aws/notes/05-messaging-streaming)) |

Lambda 는 [S3 → SQS 실험](/aws/lab/aws-s3-sqs-pipeline)의 "소비자" 자리에 가장 자연스럽게 들어간다. 업로드 이벤트 → SQS → Lambda 가 처리, 실패가 반복되면 DLQ. 실험에서 본 "삭제하지 않으면 재전달" 이 Lambda 에서는 "함수가 예외를 던지면 재전달" 이 된다. 함수는 **멱등**해야 한다.

Lambda 가 맞지 않는 경우: 지속 연결(웹소켓 대량), 15분 넘는 작업, 매우 높은 지속 처리량(컨테이너가 쌈), 커넥션 풀에 민감한 DB 접근(RDS Proxy 필요).

## 로컬 실험 ↔ AWS — 무엇이 달라지나

| 이 사이트에서 한 것 | AWS 에서 |
|---|---|
| [HPA 실험](/kubernetes/notes/14-scheduling-autoscaling-deep) — Pod 만 늘림 | 노드도 늘어야 한다 (Karpenter) — 수십 초~분의 지연과 비용 |
| [Argo Rollouts 카나리](/kubernetes/notes/13-gitops-progressive-delivery) | ALB 가중치·App Mesh/Gateway API 로 트래픽 분할, CodeDeploy 의 ECS 블루/그린 |
| [NetworkPolicy 실험](/security/notes/06-kubernetes-security) (Calico) | VPC CNI 의 네트워크 정책 지원 또는 Pod 용 보안 그룹 |
| kind 노드 장애 = 컨테이너 정지 | 노드 장애 + AZ 장애 + 스팟 회수(2분 예고) |
| 로컬 이미지 `kind load` | ECR 에 푸시, 이미지 스캔·서명 ([보안 05](/security/notes/05-container-supply-chain)) |

## 예시로 보기 — 이 프로젝트에서

이 사이트를 AWS 에 올린다면 선택지는 셋이다.

| 선택 | 맞는 이유 | 맞지 않는 이유 |
|---|---|---|
| ECS Fargate | 컨테이너 하나, 운영 부담 최소 | 셸 실험(docker·kubectl)은 돌릴 수 없다 — 노트·퀴즈만 서비스 |
| EKS | 이 사이트의 k8s·GitOps 학습을 실제로 | 컨트롤 플레인 요금 + 운영 부담이 개인 사이트엔 큼 |
| Lambda (Next.js 어댑터) | 트래픽이 거의 없으면 사실상 무료 | 실험·SSE 스트리밍·Redis 연결 유지와 궁합이 나쁨 |

학습 사이트의 결론은 "노트·퀴즈 읽기 전용은 Fargate(또는 정적 호스팅), 실험은 계속 로컬" 이다. 실험이 Docker 소켓·특권 컨테이너·kind 를 쓰기 때문이다.

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| t 계열을 꾸준한 부하에 | 크레딧 소진 후 성능 급락 | m·c 계열, 또는 unlimited 모드 비용 확인 |
| 컨테이너에 메모리 한도 없음 | 노드 전체 OOM | 요청·한도 설정 ([운영체제 03](/os-internals/notes/03-scheduler-cgroups)) |
| 단일 AZ 노드 그룹 | AZ 장애 = 서비스 장애 | 서브넷을 여러 AZ 에, 토폴로지 분산 |
| 노드 역할 권한을 Pod 가 공유 | 한 Pod 침해 = 노드 권한 전부 | IRSA·Pod Identity, IMDS 홉 제한 |
| Lambda 에서 VPC·대형 패키지 | 긴 콜드 스타트 | 필요할 때만 VPC, 패키지 경량화, 프로비저닝된 동시성 |
| 스팟 회수에 대비 없음 | 2분 뒤 갑자기 종료 | 종료 알림 처리, PDB, 여러 인스턴스 타입 |
| 이미지 태그 `latest` | 어느 버전이 도는지 모름, 롤백 불가 | 다이제스트·불변 태그, ECR 태그 불변성 |

## 실전에서는 어디에 쓰이나

> 컴퓨트 선택은 새 서비스를 어디에 띄울지 정할 때, 그리고 운영 부담·비용이 커져 플랫폼을 옮길지 고민할 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 소규모 팀의 웹 API | 서버 관리 없이 컨테이너 몇 개 운영 | ECS on Fargate + ALB, 서비스 자동 확장 | EKS — 학습·운영 비용이 팀 규모에 비해 크다 |
| 여러 팀이 쓰는 사내 플랫폼 | 표준 배포·GitOps·정책을 공용으로 | EKS + Karpenter, IRSA, ALB Controller | 팀별 ECS — 도구 표준화가 어렵다 |
| 파일 업로드 후처리·이미지 변환 | 들쑥날쑥한 이벤트를 쓴 만큼만 과금 | S3 → SQS → Lambda, 멱등 처리 + DLQ | 상시 워커 컨테이너 |
| 배치·ML 학습 작업 | 큰 연산을 싸게 | EC2 스팟·GPU 인스턴스, 종료 알림 처리 | 온디맨드 — 안전하지만 비싸다 |

**이럴 땐 안 맞는다**
- 15분 넘는 작업·대량 웹소켓·꾸준히 높은 처리량 → Lambda 는 제약과 비용이 맞지 않는다. 컨테이너로.
- 커널 접근(eBPF·Falco)·특권 컨테이너·DaemonSet → Fargate 불가. EC2 노드 기반 EKS·ECS 로.

**누가 매일 만나나** — 플랫폼 엔지니어가 노드 오토스케일링·AMI 갱신·스팟 회수를 다룰 때, 백엔드 개발자가 배포 후 Pending Pod 나 Lambda 콜드 스타트 지연을 조사할 때.

**면접·실무 단골 질문**
- Q. ECS 와 EKS 중 무엇을? → 쿠버네티스 생태계·이식성이 필요하면 EKS, 개념이 적고 운영이 가벼운 쪽은 ECS. 팀 규모와 기존 역량으로 판단.
- Q. StatefulSet Pod 가 다른 AZ 에서 Pending 인 이유? → EBS 볼륨이 AZ 에 묶여 있다. WaitForFirstConsumer·토폴로지 인식 스케줄링.

## 실습 체크리스트

- [ ] 컴퓨트 스펙트럼 표를 보고 "패치는 누가 하나" 를 서비스마다 말하기
- [ ] ECS 태스크 정의와 쿠버네티스 Pod 스펙을 필드 단위로 대응시켜 보기
- [ ] EBS 볼륨이 AZ 에 묶여 StatefulSet 이 Pending 되는 시나리오를 설명하기
- [ ] Lambda 의 콜드 스타트를 줄이는 방법 세 가지를 말하기
- [ ] [S3 → SQS 실험](/aws/lab/aws-s3-sqs-pipeline)의 소비자를 Lambda 로 바꾼다면 실패·재시도·DLQ 가 어떻게 동작할지 그려 보기
