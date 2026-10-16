---
title: "셀프서비스 인프라 — Terraform 모듈·Crossplane·GitOps 를 개발자 API 로"
order: 4
level: 중급
summary: "개발자가 티켓 없이 DB·큐·버킷을 얻는 셀프서비스의 세 가지 구현 방식(Terraform 모듈 + PR 자동화, Crossplane Composition, 플랫폼 API/오퍼레이터), 좋은 추상화 경계(개발자에게 노출할 것과 숨길 것), 정책 가드레일(크기·비용·보안·태그)을 코드로 검사하기, 승인이 필요한 변경과 자동 승인 변경의 구분, 프로비저닝 후 연결 정보(시크릿) 전달, 이 저장소의 compose 프로파일·infra/local 을 셀프서비스 관점으로 다시 보기"
tags: [셀프서비스, Terraform 모듈, Crossplane, Composition, XRD, GitOps, 정책, Atlantis, 가드레일]
experiments: [plat-catalog-validate]
---

## 셀프서비스의 정의

"셀프서비스 인프라" 는 개발자가 **사람의 개입 없이** 필요한 인프라를 얻고, 그 결과가 조직의 표준(보안·비용·태그·관측)을 자동으로 만족하는 상태를 말한다. 핵심은 두 축이다.

| 축 | 질문 |
|---|---|
| 인터페이스 | 개발자는 무엇을, 어떤 언어로 요청하나? (YAML 한 줄? 폼? API?) |
| 가드레일 | 요청이 표준을 어기면 누가, 언제 막나? (사람 리뷰? 정책 엔진?) |

인터페이스가 쉬워도 가드레일이 사람 리뷰면 결국 티켓 창구가 된다. 가드레일이 자동이어도 인터페이스가 Terraform 300줄이면 아무도 안 쓴다.

## 방식 1 — Terraform 모듈 + PR 자동화

가장 흔한 출발점이다. 플랫폼 팀이 잘 만든 모듈을 제공하고, 개발자는 모듈 호출 몇 줄을 PR 로 올린다([모듈 설계](/iac/notes/04-modules-registry)).

```hcl
# teams/orders/infra/main.tf — 개발자가 쓰는 전부
module "orders_db" {
  source  = "git::https://github.com/acme/tf-modules//postgres?ref=v4.2.0"
  name    = "orders"
  owner   = "team-orders"
  size    = "small"          # small | medium | large — 인스턴스 타입은 모듈이 정한다
  tier    = "standard"       # 백업·HA·모니터링 수준을 결정
}
```

```text
PR → plan 자동 실행(Atlantis·GitHub Actions) → plan 을 PR 코멘트로
   → 정책 검사(OPA/Conftest): 비용 상한·태그·공개 접근 금지
   → 통과 + 팀 리뷰 1명 → apply → 연결 정보는 시크릿 저장소로
```

| 장점 | 단점 |
|---|---|
| 기존 Terraform 지식·생태계 그대로 | 상태 파일 관리([상태 관리](/iac/notes/05-state-management-deep)), 드리프트 |
| plan 이 사람이 읽는 변경 미리보기 | 개발자에게 HCL·plan 출력이 여전히 낯설다 |
| 모듈 버전으로 표준을 배포 | 모듈 업그레이드가 각 팀의 PR 로 흩어진다 |

## 방식 2 — Crossplane Composition (쿠버네티스를 컨트롤 플레인으로)

Crossplane 은 클라우드 리소스를 쿠버네티스 커스텀 리소스로 다룬다. 플랫폼 팀은 **추상 API(XRD)** 와 그 **구현(Composition)** 을 정의하고, 개발자는 추상 리소스 하나를 만든다.

```yaml
# 플랫폼 팀: 개발자에게 노출할 API 를 정의 (XRD)
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata: { name: xpostgresinstances.platform.acme.io }
spec:
  group: platform.acme.io
  names: { kind: XPostgresInstance, plural: xpostgresinstances }
  claimNames: { kind: PostgresInstance, plural: postgresinstances }
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          properties:
            spec:
              properties:
                size: { type: string, enum: [small, medium, large] }
                tier: { type: string, enum: [standard, critical] }
---
# 개발자: 네임스페이스 안에서 Claim 하나
apiVersion: platform.acme.io/v1alpha1
kind: PostgresInstance
metadata: { name: orders-db, namespace: orders }
spec:
  size: small
  tier: standard
  writeConnectionSecretToRef: { name: orders-db-conn }   # 앱이 바로 마운트
```

Composition 이 이 Claim 을 실제 클라우드 DB·서브넷 그룹·파라미터 그룹·모니터링 리소스로 펼친다. 쿠버네티스 컨트롤러가 **계속 조정**하므로 누가 콘솔에서 바꿔도 되돌린다(Terraform 의 plan 주기와 다른 점, [대안 비교](/iac/notes/08-alternatives-design)).

| 장점 | 단점 |
|---|---|
| 지속 조정 — 드리프트 자동 복구 | 쿠버네티스가 인프라의 단일 장애점 |
| GitOps(ArgoCD)와 자연스럽게 결합 | Composition 디버깅이 어렵다(리소스 수십 개의 상태) |
| RBAC·네임스페이스로 팀 경계 | 프로바이더 성숙도가 클라우드마다 다름 |

## 방식 3 — 플랫폼 API·포털

요청 경로를 완전히 감추고 포털 폼이나 REST API 로 받는다. 내부적으로는 1·2번 중 하나를 호출한다. 개발자 경험은 가장 좋지만 플랫폼 팀이 **API 를 버전 관리하고 지원할 책임**이 생긴다([API 버전·거버넌스](/api-design/notes/07-versioning-evolution-governance)).

## 추상화 경계 — 무엇을 노출할 것인가

| 노출해야 하는 것 | 숨겨야 하는 것 |
|---|---|
| 의미 있는 선택: 크기 등급, 중요도, 데이터 분류, 보존 기간 | 인스턴스 타입 문자열, 서브넷 ID, 파라미터 그룹 |
| 결과물: 연결 문자열(시크릿), 대시보드 링크 | 내부 리소스 이름, 클라우드 계정 구조 |
| 비용 영향: "medium 은 월 약 $X" | 단가 계산식 |

나쁜 추상화의 신호는 두 가지다. **모든 파라미터를 그대로 노출**(그냥 래퍼일 뿐) 하거나, **꼭 필요한 선택을 막아서** 탈출이 잦아지는 것.

## 가드레일을 코드로

```rego
# policy/terraform/postgres.rego — plan JSON 을 검사
package terraform.postgres

deny[msg] {
  r := input.resource_changes[_]
  r.type == "aws_db_instance"
  r.change.after.publicly_accessible == true
  msg := sprintf("%s: DB 는 공개 접근이 금지됩니다", [r.address])
}

deny[msg] {
  r := input.resource_changes[_]
  not r.change.after.tags.owner
  msg := sprintf("%s: owner 태그가 필요합니다", [r.address])
}
```

| 변경 종류 | 처리 |
|---|---|
| 표준 범위 안 (small·standard, 태그 OK) | 자동 승인 |
| 비용 임계 초과, critical 등급 | 플랫폼·재무 승인 |
| 삭제(특히 데이터 리소스) | 별도 확인 + 백업 확인 |

자동 승인 범위를 넓히는 것이 플랫폼 팀의 목표다. 승인이 필요한 변경은 **줄어야** 한다.

## 연결 정보 전달

프로비저닝의 마지막 단계는 앱이 그 리소스에 붙는 것이다. 접속 문자열을 슬랙으로 보내는 순간 보안이 무너진다.

- Crossplane `writeConnectionSecretToRef`, Terraform → 시크릿 저장소(Vault·AWS Secrets Manager) → External Secrets 로 쿠버네티스 시크릿
- 가능하면 **비밀번호 대신 워크로드 신원**(IAM 인증, IRSA) — [시크릿 관리](/security/notes/04-secrets-management)

## Day 2 — 만든 다음이 진짜 일이다

프로비저닝(Day 1)은 쉽다. 셀프서비스의 품질은 그 뒤에 결정된다.

| Day 2 작업 | 셀프서비스가 지원해야 하는 것 | 흔한 함정 |
|---|---|---|
| 크기 변경 | `size: small → medium` 한 줄 변경으로 | 다운타임이 있는 변경인데 경고가 없음 |
| 버전 업그레이드 | 모듈·Composition 버전만 올리면 엔진 업그레이드 | 팀마다 버전이 흩어져 플랫폼이 5개 버전을 지원 |
| 백업·복구 | tier 에 따라 자동 백업, 복구 절차는 런북 | 복구를 한 번도 연습하지 않음 |
| 비용 가시성 | 리소스마다 owner 태그 → 팀별 비용 | 태그 없는 리소스가 "공용" 으로 쌓임([쇼백](/finops/notes/02-unit-economics)) |
| 삭제 | Claim·모듈 호출을 지우면 정리, 데이터는 보존 기간 | 삭제 보호 없이 DB 가 바로 사라짐 |
| 소유자 이동 | 팀 개편 시 owner 일괄 변경 | 고아 리소스 |

특히 **삭제**는 셀프서비스의 가장 위험한 동작이다. 데이터 리소스에는 `deletion_protection`, 유예 기간(soft delete), 마지막 스냅샷을 기본값으로 둔다. "지우기 쉽게" 와 "실수로 지우기 어렵게" 를 동시에 만족해야 한다.

## 예시로 보기 — 이 프로젝트에서

이 저장소에는 두 종류의 셀프서비스가 있다.

**1. compose 프로파일 = 가장 단순한 셀프서비스.** 학습자는 `pnpm kafka:up` 만 알면 된다. 이미지 버전, 포트, 헬스체크, 볼륨, 프로젝트 이름(`-p study`)은 숨겨져 있다. 추상화 경계가 명확하다.

| 노출 | 숨김 |
|---|---|
| `pnpm <대상>:up` / `:down` | 이미지 태그, 환경 변수, 볼륨 이름 |
| 대시보드 환경 점검 카드의 "없음 → 이 명령" 안내 | 포트 충돌 회피 규칙(사용자의 다른 프로젝트 포트를 피함) |

이 경계가 잘 작동한다는 증거와 깨진 순간이 둘 다 있다. 공식 MinIO 이미지를 받을 수 없게 되자 `pnpm lake:up` 의 구현을 versitygw 로 바꿨는데, 사용자 명령은 그대로였다 — 추상화가 변경을 흡수했다. 반대로 compose 스크립트 일부에 `-p study` 가 빠져 있어서 다른 폴더에서 실행하면 같은 이름의 컨테이너가 충돌했다 — **기본값의 누락이 셀프서비스를 깨뜨린** 사례다.

**2. `infra/local` = Terraform 2단계 스택.** `pnpm tf:cluster`·`pnpm tf:platform` 은 kind 클러스터와 그 위의 Redis 를 OpenTofu 로 만든다([프로바이더 실습](/iac/notes/07-provider-kubernetes-docker)). 모듈화하고 변수를 `size`·`tier` 수준으로 줄이면 방식 1 의 축소판이 된다.

## 실습 체크리스트

- [ ] 내가 자주 요청하는 인프라 하나(DB·버킷·큐)를 골라 "개발자에게 노출할 입력 3개" 로 줄여 보기
- [ ] 위 Rego 예시를 참고해 이 저장소 `infra/local` 의 plan JSON(`tofu show -json`)에 owner 태그 검사를 적용해 보기
- [ ] `pnpm` 스크립트 중 하나를 골라 숨겨진 결정(이미지·포트·볼륨·프로젝트 이름)을 모두 적어 보기 — 그것이 추상화가 흡수하는 인지 부하다
- [ ] 자동 승인 / 승인 필요 / 금지 세 칸으로 인프라 변경 유형을 분류해 보기
