---
title: "IAM — 정책 평가 논리, 역할 위임, 권한 경계·SCP, 그리고 Pod 의 신원"
order: 2
level: 중급
summary: "IAM 의 주체(사용자·역할·서비스)와 정책 종류(신원·리소스·권한 경계·SCP·세션), 요청 하나가 거치는 평가 순서(명시적 Deny 우선, 천장 정책, 기본 거부), 정책 문법(Action·Resource·Condition·정책 변수), 역할 위임(AssumeRole·신뢰 정책·외부 ID)과 임시 자격 증명, EKS 의 IRSA·Pod Identity, 최소 권한을 실제로 만드는 방법, 에뮬레이터가 IAM 을 강제하지 않는다는 함정"
tags: [IAM, 정책 평가, 명시적 Deny, 권한 경계, SCP, AssumeRole, IRSA, Pod Identity, 최소 권한, STS]
experiments: [aws-iam-policy-eval]
---

## 누가, 무엇을, 어디에

AWS 의 모든 API 호출은 **"주체(principal)가 리소스에 액션을 해도 되는가"** 의 판정을 거친다. 이 판정이 IAM 이다. [보안 03](/security/notes/03-authn-authz)의 인증·인가 구분으로 보면, 서명된 요청으로 주체를 확인하는 것이 인증(SigV4), 정책 평가가 인가다.

| 주체 | 성격 | 자격 증명 |
|---|---|---|
| IAM 사용자 | 사람·오래 사는 프로그램 | 장기 액세스 키 — **가능하면 쓰지 않는다** |
| IAM 역할 | 맡을 수 있는 권한 묶음 | STS 가 발급하는 **임시** 자격 증명(15분~12시간) |
| AWS 서비스 | Lambda·EC2·ECS 가 역할을 맡음 | 인스턴스 프로필, 태스크 역할 |
| 연합 신원 | SSO(IAM Identity Center), OIDC(GitHub Actions·EKS) | 외부 토큰 → AssumeRoleWithWebIdentity |

현대적인 기본값은 **사람은 SSO, 기계는 역할, 장기 키는 없음**이다. [GitHub Actions OIDC](/github-actions/notes/05-runners-and-security)가 바로 "CI 가 장기 키 없이 역할을 맡는" 방식이다.

## 정책의 종류

| 정책 | 붙는 곳 | 권한을 **주는가** | 역할 |
|---|---|---|---|
| 신원 기반 정책 | 사용자·그룹·역할 | 예 | "이 역할은 무엇을 할 수 있다" |
| 리소스 기반 정책 | S3 버킷, SQS 큐, KMS 키, Lambda | 예 (Principal 지정) | "이 버킷에 누가 들어올 수 있다", 교차 계정 |
| 권한 경계 (boundary) | 사용자·역할 | **아니오 — 천장만** | "이 역할이 아무리 받아도 여기까지" (위임된 관리자) |
| SCP (조직) | 계정·OU | **아니오 — 천장만** | "이 계정에서는 리전 X 만, 루트 사용 금지" |
| 세션 정책 | AssumeRole 호출 시 | 아니오 — 천장만 | 일회성으로 더 좁히기 |
| (RCP) 리소스 제어 정책 | 조직 | 아니오 — 리소스 쪽 천장 | 조직 밖 접근 차단 |

**천장 정책은 아무것도 허용하지 않는다.** SCP 가 `s3:*` 를 허용해도 신원 정책이 없으면 S3 는 거부다. 천장과 바닥의 **교집합**이 실제 권한이다.

## 평가 순서

```
1. 관련된 모든 정책을 모은다 (SCP, RCP, 리소스 정책, 신원 정책, 권한 경계, 세션 정책)
2. 어디든 명시적 Deny 가 맞으면 → 거부 (끝)
3. SCP·RCP·권한 경계·세션 정책 중 Allow 하지 않는 것이 있으면 → 거부 (천장)
4. 신원 정책 또는 (같은 계정의) 리소스 정책이 Allow 하면 → 허용
5. 아무 Allow 도 없으면 → 기본 거부
```

교차 계정 요청은 4번이 **AND** 로 바뀐다. 상대 계정의 리소스 정책이 나를 허용 **하고** 내 신원 정책도 허용해야 한다.

[IAM 정책 평가 실험](/aws/lab/aws-iam-policy-eval)은 이 순서를 작은 평가기로 구현해 사례 12개를 판정한다. 주요 사례:

| 사례 | 결정 | 이유 |
|---|---|---|
| 보고서 버킷 읽기 | Allow | 신원 정책의 Allow |
| 남의 접두사에 쓰기 | 기본 거부 | `reports/${aws:username}/*` 정책 변수로 자기 것만 |
| MFA 없이 삭제 | **명시적 Deny** | `Bool aws:MultiFactorAuthPresent false` 조건 |
| us-east-1 에서 읽기 | **명시적 Deny** | SCP 의 리전 잠금 (NotAction 으로 IAM·STS 만 예외) |
| DynamoDB 쓰기 | 기본 거부 | 신원 정책은 `dynamodb:*` 이지만 권한 경계가 GetItem 만 |
| 신원 정책 없이 audit 버킷 읽기 | Allow | 같은 계정의 버킷 정책 |
| 같은 버킷을 HTTP 로 | **명시적 Deny** | 버킷 정책 `aws:SecureTransport false` |

## 정책 문법의 함정

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ReadOwn", "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::reports/${aws:username}/*" },
    { "Sid": "ListOwnPrefix", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::reports",
      "Condition": { "StringLike": { "s3:prefix": ["${aws:username}/*"] } } }
  ]
}
```

| 함정 | 설명 |
|---|---|
| 버킷과 객체 ARN 이 다르다 | `ListBucket` 은 버킷 ARN(`arn:aws:s3:::reports`), `GetObject` 는 객체 ARN(`…/reports/*`) |
| `Version` 생략 | 2008 버전으로 해석되어 `${…}` 정책 변수가 문자 그대로 비교됨 |
| `NotAction` + Allow | "이것 빼고 전부 허용" — 새 서비스가 생기면 자동으로 허용된다. Deny 와 함께만 쓴다 |
| 와일드카드 액션 | `s3:*` 는 `PutBucketPolicy`(권한 확대)까지 포함 |
| 조건 키 오타 | 존재하지 않는 키는 조건이 **거짓**이 되어 조용히 무력화 |
| 액션은 대소문자 무시, 리소스는 구분 | 실험의 "S3:getobject" 사례 |

## 역할 위임 — AssumeRole

역할에는 **신뢰 정책**(누가 이 역할을 맡을 수 있나)과 **권한 정책**(맡으면 무엇을 할 수 있나)이 있다.

```json
// 신뢰 정책 — 다른 계정의 특정 역할이 외부 ID 와 함께 올 때만
{ "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::111122223333:role/ci-deployer" },
  "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "sts:ExternalId": "a7f3…" } } }
```

`sts:AssumeRole` 은 **임시 자격 증명**을 돌려준다. 만료가 있으므로 유출 피해가 시간으로 제한된다. **외부 ID** 는 서드파티 서비스가 다른 고객의 역할을 맡도록 속는 "혼동된 대리인" 문제를 막는다.

### EKS 의 Pod 신원 — IRSA 와 Pod Identity

노드의 인스턴스 역할을 Pod 들이 공유하면 모든 Pod 가 같은 권한을 갖는다. 그래서 **ServiceAccount 단위로 역할**을 준다.

| 방식 | 동작 |
|---|---|
| IRSA | 클러스터의 OIDC 공급자를 IAM 에 등록, SA 에 역할 ARN 어노테이션 → Pod 의 SA 토큰으로 AssumeRoleWithWebIdentity |
| EKS Pod Identity | 에이전트(DaemonSet)가 자격 증명을 내려줌, 역할-SA 연결을 EKS API 로 관리 (OIDC 설정 불필요) |

이 사이트의 [Kubernetes RBAC 실험](/security/lab/sec-k8s-rbac)이 "SA 마다 최소 권한" 을 쿠버네티스 안에서 했다면, IRSA·Pod Identity 는 그 SA 가 **AWS API** 에서 갖는 권한이다. 두 층을 모두 좁혀야 한다.

## 최소 권한을 실제로 만드는 법

1. **넓게 시작하지 말고 거부에서 시작**: 필요한 액션을 추가해 간다.
2. **IAM Access Analyzer**: 실제 CloudTrail 사용 기록으로 정책을 생성하고, 쓰지 않은 권한을 찾는다.
3. **정책 검증을 CI 에**: Access Analyzer 의 정책 검증 API, checkov·tfsec 로 `*` 와 위험 조합을 막는다([IaC 06](/iac/notes/06-drift-policy-testing)).
4. **권한 경계로 위임**: 팀이 역할을 만들 수 있게 하되 경계를 반드시 붙이게 한다.
5. **SCP 로 가드레일**: 루트 사용 금지, 허용 리전, CloudTrail 끄기 금지.

## 에뮬레이터의 한계 — 로컬 통과 ≠ 권한 검증

[실험](/aws/lab/aws-iam-policy-eval)의 두 번째 부분은 LocalStack 에 **정책이 하나도 없는 사용자**를 만들고 그 키로 S3 에 쓴다. **성공한다.** LocalStack 무료판은 IAM 을 저장만 하고 강제하지 않으며, `simulate-custom-policy` 도 구현돼 있지 않다.

| 확인 | LocalStack | 실제 AWS |
|---|---|---|
| 권한 없는 PutObject | 성공 | AccessDenied |
| 정책 시뮬레이터 | 미구현 | 결정과 일치한 문장 반환 |

그래서 권한은 (1) 코드로 관리하며 정적 분석, (2) 실제 계정의 스테이징에서 `simulate-principal-policy` 와 통합 테스트로 검증한다. 에뮬레이터는 **API 흐름**을 검증하는 도구이지 **권한**을 검증하는 도구가 아니다.

## 예시로 보기 — 이 프로젝트에서

이 사이트를 AWS 에 올릴 때의 역할 설계:

| 역할 | 권한 | 비고 |
|---|---|---|
| 앱 태스크 역할 | Secrets Manager `GetSecretValue` (OPENAI 키 하나), CloudWatch Logs 쓰기 | 장기 키 없음 |
| CI 배포 역할 | ECR 푸시, ECS 서비스 업데이트 | GitHub OIDC 신뢰, `repo:jaejinu/study:ref:refs/heads/main` 조건 |
| 사람 (본인) | SSO 권한 세트, 운영은 읽기 전용 기본 + 쓰기는 별도 세트 | MFA 필수 |

## 흔한 실수

| 실수 | 결과 | 바로잡기 |
|---|---|---|
| `"Action": "*"`, `"Resource": "*"` 로 시작해 나중에 줄이기 | 나중은 오지 않는다 | 필요한 액션·ARN 부터 좁게, Access Analyzer 로 생성 |
| 장기 액세스 키를 코드·CI 에 저장 | 유출 시 무기한 악용 | 역할 위임(AssumeRole), OIDC 연동, 임시 자격 증명 |
| 노드 역할에 앱 권한을 붙임 | 같은 노드의 모든 Pod 가 그 권한을 가짐 | IRSA·Pod Identity 로 서비스 계정별 역할 |
| `NotAction`·`NotResource` 를 Allow 와 함께 | 의도보다 훨씬 넓은 허용 | Deny 와 함께만 쓰거나 피하기 |
| 버킷 정책만 보고 안전하다고 판단 | 신원 정책·ACL·퍼블릭 액세스 차단 설정이 함께 작용 | 평가 순서 전체로 추론, 계정 수준 퍼블릭 차단 켜기 |
| LocalStack 통과를 권한 검증으로 여김 | 실제 계정에서 AccessDenied 또는 과허용 | 정책 시뮬레이터·스테이징 계정에서 확인 |

## 실습 체크리스트

- [ ] [IAM 정책 평가 실험](/aws/lab/aws-iam-policy-eval)의 12개 사례 중 명시적 Deny 3개가 각각 어느 정책에서 나왔는지 설명하기
- [ ] 평가 순서 5단계를 외우고 교차 계정일 때 무엇이 바뀌는지 말하기
- [ ] `ListBucket` 과 `GetObject` 의 Resource ARN 차이를 실제 정책으로 써 보기
- [ ] GitHub Actions 가 장기 키 없이 배포하도록 신뢰 정책(OIDC)을 써 보기
- [ ] "에뮬레이터 통과는 권한 검증이 아니다" 를 실험 결과로 설명하기
