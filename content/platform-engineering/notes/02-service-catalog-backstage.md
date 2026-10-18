---
title: "서비스 카탈로그와 Backstage — 소유권, catalog-info.yaml, 플러그인"
order: 2
level: 기초
summary: "서비스 카탈로그가 해결하는 문제(누가 소유하나, 무엇에 의존하나, 문서·대시보드는 어디 있나), Backstage 의 엔티티 모델(Component·API·Resource·System·Domain·Group·User)과 관계, catalog-info.yaml 작성법과 등록 방식, 소유권을 강제하는 방법, 플러그인·TechDocs·스코어카드, 카탈로그가 썩지 않게 하는 운영 습관, 이 저장소의 subjects.ts 를 카탈로그로 변환해 보기"
tags: [서비스 카탈로그, Backstage, catalog-info.yaml, 소유권, 엔티티, TechDocs, 스코어카드, 개발자 포털]
experiments: [plat-catalog-validate]
---

## 카탈로그가 답해야 하는 질문

장애가 났을 때 가장 먼저 필요한 정보는 기술이 아니라 **사람과 관계**다.

- 이 서비스의 소유 팀은? 온콜은 누구?
- 이 서비스가 의존하는 DB·큐·외부 API 는? 반대로 이 서비스에 의존하는 것은?
- 런북·대시보드·로그 쿼리·소스 저장소는 어디?
- 지금 어떤 버전이 어느 환경에 배포돼 있나?

이 정보가 위키 페이지 수십 개와 사람 머릿속에 흩어져 있으면 장애 대응 첫 10분이 "누구한테 물어보지" 로 사라진다. 서비스 카탈로그는 이것을 **기계가 읽을 수 있는 한 곳**으로 모은다.

## Backstage 의 엔티티 모델

Backstage(Spotify 가 만들고 CNCF 에 기증)의 카탈로그는 몇 가지 엔티티 종류(kind)와 그 사이의 관계로 이뤄진다.

| kind | 의미 | 예 |
|---|---|---|
| Component | 배포·소유되는 소프트웨어 단위 | `checkout-service`, `web-frontend` |
| API | 컴포넌트가 제공·소비하는 인터페이스 | `orders-grpc`, `payments-openapi` |
| Resource | 컴포넌트가 쓰는 인프라 | `orders-postgres`, `cache-redis`, `events-kafka-topic` |
| System | 함께 기능을 이루는 컴포넌트·API·리소스의 묶음 | `ordering` |
| Domain | 비즈니스 영역 단위로 시스템을 묶음 | `commerce` |
| Group / User | 조직 구조와 사람 | `team-orders`, `jdoe` |
| Template | 새 컴포넌트를 만드는 스캐폴더 템플릿 | `nodejs-service` |
| Location | 다른 카탈로그 파일들을 가리키는 포인터 | 저장소의 `catalog-info.yaml` 목록 |

관계는 방향이 있다: `ownedBy`, `partOf`, `providesApi`, `consumesApi`, `dependsOn`. 카탈로그는 이것으로 **의존 그래프**를 그린다. "orders-postgres 가 죽으면 영향받는 컴포넌트는?" 이 그래프 질의가 된다.

## catalog-info.yaml

각 저장소 루트에 둔다. 쿠버네티스 매니페스트와 같은 모양이다.

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: checkout-service
  description: 장바구니 결제 흐름을 처리한다
  annotations:
    github.com/project-slug: acme/checkout-service     # 소스·PR·CI 플러그인이 쓴다
    backstage.io/techdocs-ref: dir:.                   # 저장소의 docs/ 를 TechDocs 로
    grafana/dashboard-selector: "tags @> 'checkout'"   # 대시보드 플러그인
    pagerduty.com/service-id: PABC123                  # 온콜
  tags: [nodejs, grpc]
  links:
    - url: https://runbooks.acme.dev/checkout
      title: 런북
spec:
  type: service
  lifecycle: production          # experimental | production | deprecated
  owner: group:team-orders       # 반드시 그룹. 사람 개인은 퇴사한다
  system: ordering
  providesApis: [checkout-grpc]
  consumesApis: [payments-openapi]
  dependsOn:
    - resource:orders-postgres
    - resource:cache-redis
```

등록 방식은 세 가지다.

| 방식 | 장점 | 단점 |
|---|---|---|
| UI 에서 URL 등록 | 시작이 쉽다 | 사람이 잊는다 |
| Location 엔티티로 목록 관리 | 한 곳에서 관리 | 목록 갱신이 수동 |
| **디스커버리**(GitHub 조직 전체를 스캔해 `catalog-info.yaml` 자동 수집) | 새 저장소가 자동으로 들어온다 | 파일이 없는 저장소는 안 보인다 → 템플릿이 파일을 기본으로 생성하게 |

## 소유권 — 카탈로그의 가장 중요한 필드

`owner` 가 없거나 틀린 카탈로그는 쓸모가 없다. 소유권을 지키는 방법:

1. **템플릿이 owner 를 필수 입력으로** 받는다([골든 패스](/platform-engineering/notes/03-golden-paths-templates)).
2. CI 에서 `catalog-info.yaml` 을 검사한다 — owner 가 실재하는 Group 인지, lifecycle 값이 유효한지.
3. **고아 탐지**: 정기적으로 owner Group 이 사라졌거나 구성원이 0 인 엔티티를 찾아 알린다.
4. 온콜 도구·코드 소유자(CODEOWNERS)와 **같은 원천**에서 소유자를 가져온다. 두 군데에 적으면 반드시 어긋난다.

## 플러그인 — 카탈로그가 포털이 되는 방법

Backstage 자체는 카탈로그와 UI 틀이다. 가치는 엔티티 페이지에 붙는 플러그인에서 나온다.

| 플러그인 영역 | 엔티티 페이지에 보이는 것 | 이 사이트의 대응 |
|---|---|---|
| CI/CD | 최근 GitHub Actions 실행·실패 | [CI 성능](/github-actions/notes/06-ci-performance) |
| 쿠버네티스 | 배포된 Pod·버전·재시작 | kind 클러스터 상태 카드 |
| 관측 | Grafana 대시보드·알림 상태 | 관측성 대시보드의 최근 알림 |
| TechDocs | 저장소의 Markdown 문서를 사이트로 | 이 사이트의 노트 렌더링 |
| 비용 | 컴포넌트별 클라우드 비용 | [FinOps 거버넌스](/finops/notes/06-governance) |
| 스코어카드 | "프로덕션 준비" 체크리스트 점수 | 실험 `plat-catalog-validate` |

### 스코어카드(Tech Insights)

스코어카드는 엔티티마다 규칙을 평가해 점수를 매긴다.

```text
checkout-service   ★★★☆☆
  ✓ owner 가 Group
  ✓ 런북 링크 있음
  ✓ SLO 정의 있음
  ✗ 의존 이미지에 CRITICAL CVE 2건
  ✗ 런타임이 지원 종료(Node 18)
```

점수는 **비교와 대화의 재료**지 처벌 수단이 아니다. 낮은 점수의 원인이 플랫폼 기본값 부족이라면, 고칠 곳은 팀이 아니라 플랫폼이다.

## 카탈로그가 썩지 않게

| 썩는 방식 | 막는 방법 |
|---|---|
| 서비스는 사라졌는데 엔티티는 남음 | 디스커버리 + 저장소 아카이브 시 자동 제거 |
| 의존 관계가 실제와 다름 | 트레이스(서비스 맵)에서 실제 호출 그래프를 뽑아 선언과 비교 |
| 문서 링크 깨짐 | 링크 체커를 CI 에 |
| 아무도 안 봄 | 장애 대응·온보딩·PR 리뷰 흐름에서 카탈로그를 **경유**하게 |

마지막이 가장 중요하다. 사람이 일하는 흐름 위에 있지 않은 카탈로그는 반드시 낡는다.

## 모델링 함정과 판단 기준

카탈로그를 처음 만들 때 가장 오래 고민하는 것은 "무엇을 엔티티 하나로 볼까" 다.

| 질문 | 권장 | 이유 |
|---|---|---|
| 모노레포 안의 서비스 다섯 개는? | Component 다섯 개, Location 하나 | 소유자·배포 단위가 다르면 따로 |
| 같은 서비스의 스테이징·프로덕션은? | Component 하나, 환경은 주석·플러그인으로 | 엔티티가 환경마다 늘면 관계가 폭발 |
| 공용 Redis 클러스터 하나를 여러 팀이 쓰면? | Resource 하나, 소유는 플랫폼 팀 | "누가 용량을 늘리나" 가 명확해진다 |
| 라이브러리(npm 패키지)는? | Component(type: library) | 취약점 영향 분석에 필요 |
| 크론 잡·배치는? | Component(type: job 등 사용자 정의) | 장애·소유 관점은 서비스와 같다 |

일반 원칙은 **소유와 배포의 경계 = 엔티티의 경계**다. 같은 사람이 같은 주기로 배포한다면 하나로 묶고, 다르면 나눈다.

### 의존 그래프를 실제와 맞추는 법

선언된 `dependsOn` 은 사람이 쓴 것이라 금방 틀린다. 관측 데이터에서 실제 호출을 뽑아 비교하면 차이가 보인다.

```text
선언: checkout-service dependsOn [orders-postgres, cache-redis]
트레이스 서비스 맵(최근 7일): checkout-service → orders-postgres, cache-redis, payments-api, feature-flags
차이: payments-api, feature-flags 가 선언에 없음 → 카탈로그 PR 자동 생성
```

[분산 트레이싱](/observability/notes/06-tracing-otel)의 서비스 그래프가 이 비교의 원천이다. 반대로 선언에는 있는데 호출이 0 인 의존은 이미 사라진 연결일 가능성이 높다.

## 예시로 보기 — 이 프로젝트에서

이 사이트의 `src/lib/subjects.ts` 는 형태만 다를 뿐 카탈로그다. 주제 하나가 Component 하나, 트랙이 System/Domain, 환경 준비 명령이 의존 Resource 와 비슷하다.

```ts
{
  id: "kafka",
  track: "data",                 // ≈ system / domain
  name: "Kafka",
  description: "...",
  nav: [ /* 대시보드·노트·퀴즈·실험실 */ ],
  setup: [{ label: "브로커", cmd: "pnpm kafka:up" }],   // ≈ dependsOn: resource:kafka
}
```

실험 `plat-catalog-validate` 는 이 목록을 Backstage 형식으로 바꾼다.

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: kafka
  description: 분산 이벤트 스트리밍
  tags: [data]
spec:
  type: learning-subject
  lifecycle: production
  owner: group:study
  system: data
```

그리고 YAML 파서로 유효성을 확인하고, 주제마다 노트·퀴즈·실험·환경 점검 카드가 있는지 점수를 매긴다. **빠진 항목이 있으면 그 주제는 '프로덕션 준비' 가 덜 된 것**이다. 이 저장소에는 `owner` 개념이 없다는 점도 그 결과에서 드러난다 — 개인 프로젝트에선 괜찮지만 팀 저장소였다면 가장 먼저 추가할 필드다.

## 실전에서는 어디에 쓰이나

> 서비스가 수십·수백 개가 되어 "누가 소유하나, 무엇에 의존하나, 런북은 어디 있나" 를 사람에게 물어야 답이 나올 때 카탈로그가 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 마이크로서비스가 많은 커머스의 장애 대응 | 장애 서비스의 소유 팀·온콜을 즉시 찾기 | `catalog-info.yaml` 의 owner + 온콜 도구 연동 엔티티 페이지 | 위키 표(금방 낡는다) |
| 핀테크의 공용 DB·큐 영향 분석 | "이 Postgres 가 죽으면 누가 영향받나" | Resource 엔티티와 `dependsOn` 그래프 질의 | 트레이스 서비스 맵만 보기 |
| 보안 취약점 대응(사내 플랫폼) | 취약한 라이브러리를 쓰는 서비스 목록 | 라이브러리를 Component(type: library)로 등록, 소유자에게 일괄 알림 | 저장소 전체 grep |
| 성장기 SaaS 의 "프로덕션 준비" 점검 | 어느 서비스가 SLO·런북·대시보드가 없나 | 스코어카드(Tech Insights)로 규칙 평가 | 분기별 수동 체크리스트 |

**이럴 땐 안 맞는다**
- 서비스가 손에 꼽을 만큼 적은 조직 — 카탈로그 유지 비용이 이득보다 크다. 저장소 README 와 CODEOWNERS 로 충분하다.
- 사람이 일하는 흐름(장애 대응·온보딩·PR) 밖에 놓인 카탈로그 — 반드시 낡는다. 디스커버리와 CI 검사로 일상 흐름에 묶지 못하면 시작하지 않는 편이 낫다.

**누가 매일 만나나** — 온콜 SRE 는 장애 첫 10분에 엔티티 페이지에서 소유자·대시보드·런북을 찾을 때, 플랫폼 엔지니어는 고아 엔티티 탐지와 플러그인 연동을 할 때, 신입 개발자는 온보딩 중 "이 시스템은 어떻게 생겼나" 를 볼 때 만난다.

**면접·실무 단골 질문**
- Q. 카탈로그가 썩지 않게 하려면? → 디스커버리로 자동 수집, owner 를 템플릿에서 필수로, CI 검사, 트레이스로 선언된 의존과 실제 호출을 비교.
- Q. 엔티티 경계는 어떻게 정하나? → 소유와 배포의 경계가 엔티티의 경계다. 환경별로 엔티티를 나누지 않는다.

## 실습 체크리스트

- [ ] 내가 아는 서비스 하나로 `catalog-info.yaml` 을 써 보고 `owner`·`system`·`dependsOn`·`providesApis` 를 채우기
- [ ] 실험 `plat-catalog-validate` 를 실행해 변환된 YAML 과 완성도 점수표를 확인하기
- [ ] 장애가 났다고 가정하고, 카탈로그 없이 "이 DB 에 의존하는 서비스" 를 찾는 데 몇 단계가 필요한지 세 보기
- [ ] 스코어카드 규칙 다섯 개를 정의하고, 각 규칙이 실패했을 때 고칠 주체가 팀인지 플랫폼인지 적기
