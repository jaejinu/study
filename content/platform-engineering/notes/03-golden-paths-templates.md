---
title: "골든 패스와 템플릿 — 스캐폴딩, 기본값의 힘, 탈출구"
order: 3
level: 중급
summary: "골든 패스(포장된 길)가 무엇이고 왜 강제보다 강한지, 소프트웨어 템플릿으로 새 서비스·리소스를 스캐폴딩하는 구조(입력 스키마·스켈레톤·후처리 단계), 템플릿에 넣어야 할 기본값(CI·관측·보안·카탈로그 등록), 템플릿이 만든 뒤에 낡는 문제와 업데이트 전략(재생성·코드모드·재사용 워크플로), 탈출구를 두는 법, 이 저장소의 '새 주제 추가' 를 골든 패스로 만드는 실험"
tags: [골든 패스, 템플릿, 스캐폴딩, Backstage Scaffolder, 기본값, cookiecutter, 재사용 워크플로, 탈출구]
experiments: [plat-golden-path-scaffold]
---

## 골든 패스란

골든 패스(paved road, 포장된 길)는 **조직이 권장하고 지원하는 한 가지 길**이다. "새 HTTP 서비스는 이 템플릿으로 만들면 CI·배포·대시보드·알림·보안 검사가 이미 붙어 있다." 다른 길로 가는 것은 금지가 아니다. 다만 그 길에서는 플랫폼의 지원을 받지 못한다.

![골든 패스 — 사전과 사후](/diagrams/plat-golden-path.svg)

| | 강제(mandate) | 골든 패스 |
|---|---|---|
| 채택 동기 | 규칙이라서 | 가장 쉬워서 |
| 예외 처리 | 승인 절차 | 그냥 다른 길로 가되 스스로 책임 |
| 플랫폼 팀의 일 | 감시·리뷰 | 길을 더 편하게 만들기 |
| 실패 신호 | 우회로(섀도 IT) | 골든 패스 이탈률 증가 → 길이 불편하다는 피드백 |

골든 패스의 이탈률은 플랫폼 팀에게 가장 정직한 사용자 피드백이다.

## 템플릿(스캐폴더)의 구조

Backstage Scaffolder, cookiecutter, Yeoman, `create-*` CLI 모두 비슷하게 생겼다.

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: nodejs-service
  title: Node.js HTTP 서비스
spec:
  owner: group:platform
  type: service
  parameters:                      # 1. 입력 스키마 (폼으로 렌더링)
    - title: 기본 정보
      required: [name, owner]
      properties:
        name: { type: string, pattern: '^[a-z][a-z0-9-]{2,30}$' }
        owner: { type: string, ui:field: OwnerPicker }
        tier: { type: string, enum: [critical, standard, experimental], default: standard }
  steps:                           # 2. 단계
    - id: fetch
      action: fetch:template       #    스켈레톤 복사 + 변수 치환
      input: { url: ./skeleton, values: { name: ${{ parameters.name }}, owner: ${{ parameters.owner }} } }
    - id: publish
      action: publish:github       #    저장소 생성
    - id: register
      action: catalog:register     #    카탈로그 등록
  output:
    links:
      - title: 저장소
        url: ${{ steps.publish.output.remoteUrl }}
```

세 부분이 핵심이다.

1. **입력 스키마** — 사용자가 결정해야 하는 것만 묻는다. 이름·소유자·중요도 정도. 나머지는 기본값.
2. **스켈레톤** — 변수가 치환되는 파일 트리. 여기에 조직의 모범 사례가 들어간다.
3. **후처리 단계** — 저장소 생성, 카탈로그 등록, 클라우드 리소스 요청, 채널 생성 같은 부수 효과.

## 스켈레톤에 넣어야 할 기본값

기본값은 "대부분의 서비스가 바꾸지 않아도 되는 올바른 선택" 이어야 한다.

| 영역 | 기본값 예 | 관련 노트 |
|---|---|---|
| CI | lint·test·이미지 빌드·스캔을 재사용 워크플로로 호출 | [캐시·매트릭스](/github-actions/notes/02-cache-matrix-artifacts) |
| 배포 | GitOps 매니페스트, 카나리 기본 | [GitOps·점진 배포](/kubernetes/notes/13-gitops-progressive-delivery) |
| 관측 | OTel 자동 계측, RED 대시보드, 기본 SLO·번레이트 알림 | [SLO 와 에러 버짓](/sre/notes/02-sli-slo-error-budget) |
| 보안 | 비루트 컨테이너, 최소 권한 SA, 시크릿은 외부 저장소 | [보안](/security) |
| 리소스 | requests/limits, HPA, PDB | [스케줄링·오토스케일](/kubernetes/notes/14-scheduling-autoscaling-deep) |
| 카탈로그 | `catalog-info.yaml`(owner 필수) | [서비스 카탈로그](/platform-engineering/notes/02-service-catalog-backstage) |
| 테스트 | 단위·통합 테스트 골격, 계약 테스트 자리 | [테스트 전략](/testing/notes/01-test-pyramid-trophy) |
| 문서 | README, 런북 골격, ADR 폴더 | [온콜·런북](/sre/notes/04-oncall-runbooks) |

중요도(tier)에 따라 기본값을 바꾸는 것도 흔하다. `critical` 이면 PDB·다중 AZ·엄격한 SLO, `experimental` 이면 비용을 아끼는 설정.

## 템플릿의 가장 큰 약점 — 만든 다음날부터 낡는다

템플릿은 **생성 시점의 복사본**이다. 6개월 뒤 플랫폼이 CI 단계를 바꿔도 이미 만든 서비스 100개는 옛 버전 그대로다. 대응 전략:

| 전략 | 방식 | 장단점 |
|---|---|---|
| 얇은 스켈레톤 + 공유 부품 | 스켈레톤엔 호출만 두고 실체는 재사용 워크플로·Helm 라이브러리 차트·Terraform 모듈 | 업데이트가 한 곳. 가장 권장 |
| 재생성·차이 병합 | cruft·copier 처럼 템플릿 버전을 기록해 두고 새 버전과 3-way 병합 | 커스터마이즈가 많으면 충돌 |
| 코드모드(대량 PR) | 스크립트로 모든 저장소에 변경 PR 을 연다 | 강력하지만 리뷰 부담 |
| 스코어카드로 추적 | "CI 워크플로 v3 이상" 같은 규칙으로 낡은 곳을 가시화 | 고치진 않지만 우선순위를 준다 |

원칙: **스켈레톤에는 바뀌지 않을 것만, 바뀔 것은 참조로.**

```yaml
# 스켈레톤의 .github/workflows/ci.yml — 실체는 플랫폼 저장소에 있다
jobs:
  ci:
    uses: acme/platform-workflows/.github/workflows/node-ci.yml@v3
    with: { node-version: 22 }
    secrets: inherit
```

## 탈출구(escape hatch)

골든 패스가 모든 요구를 덮을 수는 없다. 탈출구가 없으면 사람들은 골든 패스 전체를 버린다.

- **부분 탈출**: 기본 Helm 값에 `extraContainers`, `extraEnv` 같은 확장점을 둔다.
- **단계 교체**: 재사용 워크플로에 `run-tests: false` + 자체 단계 허용.
- **원본 노출**: 추상화 아래의 Kubernetes 매니페스트·Terraform 을 직접 쓸 수 있게 한다(대신 지원 범위 밖임을 명시).
- **탈출 기록**: 탈출한 서비스를 스코어카드에 표시해 "왜 탈출했나" 를 플랫폼 백로그로 수집.

## 템플릿도 코드다 — 템플릿을 테스트하기

템플릿이 깨지면 그 템플릿으로 만든 모든 새 서비스가 첫날부터 실패한다. 그래서 플랫폼 팀은 템플릿 자체에 CI 를 건다.

| 검사 | 방법 | 잡아내는 것 |
|---|---|---|
| 렌더링 | 대표 입력 3~5개로 템플릿을 실제로 생성 | 변수 오타, 조건 분기 누락 |
| 빌드·테스트 | 생성된 프로젝트에서 `lint`·`test`·`docker build` 실행 | 스켈레톤이 컴파일조차 안 되는 경우 |
| 정책 | 생성물에 조직 정책(라이선스 헤더, owner, 리소스 limit) 적용 | 기본값이 정책을 어김 |
| 골든 파일 비교 | 생성 결과를 저장된 기대값과 diff | 의도치 않은 변경 |
| 엔드투엔드(주기적) | 샌드박스 조직에 실제로 저장소·배포까지 만들고 지움 | 외부 API 변경, 권한 문제 |

이 중 앞의 세 가지는 [통합 테스트](/testing/notes/03-integration-containers)와 같은 감각으로 몇 분 안에 돈다. 실험 `plat-golden-path-scaffold` 가 하는 일이 바로 1번과 3번이다.

## 입력을 적게 묻는 기술

폼에 필드가 20개인 템플릿은 아무도 끝까지 채우지 않는다.

- **추론할 수 있는 건 묻지 않는다**: 저장소 이름은 서비스 이름에서, 소유 팀은 로그인 사용자의 기본 그룹에서.
- **나중에 바꿔도 되는 건 기본값으로**: 레플리카 수, 메모리 크기.
- **되돌리기 어려운 것만 묻는다**: 이름(URL·DNS·메트릭 레이블에 박힌다), 데이터 분류(개인정보 여부), 중요도 등급.
- **검증을 폼에서**: 이름 패턴·중복 여부를 입력 즉시 검사해 생성 후 실패를 없앤다.

## 예시로 보기 — 이 프로젝트에서

이 저장소에서 "새 주제 추가" 는 사실상 골든 패스가 있다. 지금은 사람이 기억해야 하는 단계가 많다.

| 단계 | 파일 | 실수하면 |
|---|---|---|
| 1. 주제 정의 | `src/lib/subjects.ts` (id·track·nav·setup) | id 가 전역 경로와 겹침 → 화면 진입 불가(CI 가 검사) |
| 2. 환경 점검 | `src/lib/env-checks.ts` | 대시보드 카드가 빈 상태 |
| 3. 실험 배선 | `src/lab/registry.ts`, `ShellSubject`/`CodeSubject` 타입, 실험 파일 | 실험실이 비어 보임 |
| 4. 콘텐츠 | `content/<id>/notes/*.md`, `quiz.json` | frontmatter 에 `: ` 따옴표 누락 → 노트가 조용히 사라짐(CI 가 검사) |

실험 `plat-golden-path-scaffold` 는 이 4단계 중 콘텐츠 부분을 **템플릿으로** 만든다. 임시 디렉터리에 노트 1편·퀴즈·실험 스텁을 생성하고, 이 저장소의 콘텐츠 규칙(필수 필드, level 값, 콜론 따옴표)으로 검사한 뒤 지운다. 일부러 따옴표를 빠뜨린 변형도 만들어 **규칙이 실제로 잡는지** 확인한다 — 골든 패스의 가치는 "틀리기 어렵게 만드는 것" 이니까.

여기서 배울 점 하나: 이 저장소의 CI 콘텐츠 검사(`tests/content.test.ts`)는 템플릿이 아니라 **사후 검사**다. 골든 패스는 사전에(생성 시점에) 올바르게 만들고, 정책 검사는 사후에(변경 시점에) 어긋남을 잡는다. 둘 다 필요하다.

## 실습 체크리스트

- [ ] 실험 `plat-golden-path-scaffold` 를 실행하고, 콜론 따옴표 누락 변형이 실제로 검사에 걸리는지 확인하기
- [ ] 내가 만든 서비스 하나를 떠올려 "템플릿이 있었다면 기본으로 들어갔어야 할 것" 다섯 가지를 적기
- [ ] 스켈레톤에 둘 것과 공유 부품(재사용 워크플로·모듈)으로 뺄 것을 나눠 보기
- [ ] 골든 패스 이탈 사례 하나를 상상하고, 그 사람이 쓸 수 있는 탈출구를 설계하기
