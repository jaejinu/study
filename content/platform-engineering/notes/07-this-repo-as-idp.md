---
title: "심화 — 이 저장소를 작은 IDP 로 보기"
order: 7
level: 심화
summary: "이 학습 사이트를 내부 개발자 플랫폼의 축소판으로 해부한다. subjects.ts 가 서비스 카탈로그, compose 프로파일과 pnpm 스크립트가 셀프서비스 인프라, 실험 레지스트리가 플러그인 체계, env-checks 가 상태 점검, tests/content.test.ts 가 정책을 코드로, deadman.ts 가 안전한 기본값 역할을 한다. 각 부분의 설계 결정과 실제로 겪은 장애·개선을 플랫폼 원칙과 연결하고, 다음에 추가할 IDP 기능(owner, 스코어카드, 템플릿 CLI)을 설계한다"
tags: [IDP, 카탈로그, 셀프서비스, 정책을 코드로, 플러그인, 스코어카드, 사례 연구]
experiments: [plat-catalog-validate, plat-golden-path-scaffold, plat-dora-metrics]
---

## 왜 이 저장소를 예로 드나

플랫폼 엔지니어링 개념은 큰 조직의 이야기처럼 들린다. 하지만 원리는 규모와 무관하다. "여러 사용자가 같은 일을 반복하고, 그 반복에 실수가 끼어들고, 누군가 그 반복을 흡수하는 도구를 만든다." 이 저장소는 주제가 서른 개를 넘으면서 정확히 그 지점을 지났다. 실제로 겪은 사건들이 있어서 교재로 좋다.

## 구성 요소 지도

![이 저장소를 IDP 로 본 구성](/diagrams/plat-idp-map.svg)

| IDP 구성 요소 | 이 저장소의 대응물 | 규모 (이 노트 작성 시점) |
|---|---|---|
| 서비스 카탈로그 | `src/lib/subjects.ts` | 주제 34개, 트랙 5개 |
| 개발자 포털 | Next.js 사이트 — 첫 화면·대시보드·⌘K 검색 | |
| 셀프서비스 인프라 | `docker-compose.yml` 프로파일 + `package.json` 스크립트 | 프로파일 12개, compose 스크립트 25개 |
| 상태 점검 | `src/lib/env-checks.ts` 의 주제별 점검 카드 | 주제별 분기 31개 |
| 플러그인 체계 | `src/lab/registry.ts` — Shell/Code 실험을 주제에 꽂는다 | |
| 정책을 코드로 | `tests/content.test.ts` (CI) | 검사 12개 |
| 안전한 기본값 | `src/lib/deadman.ts`, compose `-p study` 고정 | |
| 문서(TechDocs) | `content/<subject>/notes/*.md` 렌더링 | |
| DORA·관측 | `/api/metrics`, Grafana, GitHub Actions 기록 | |

## 1. 카탈로그 — subjects.ts

```ts
export interface Subject {
  id: SubjectId;          // URL 경로이자 식별자
  track: TrackId;         // 묶음 (Backstage 의 system/domain)
  name: string; tagline: string; description: string;
  mark: string; color: string;
  nav: NavItem[];         // 대시보드·노트·퀴즈·실험실 링크
  setup: { label: string; cmd: string }[];   // 환경 준비 명령 (≈ dependsOn)
}
```

**설계 결정**: 카탈로그를 YAML 이 아니라 **타입 있는 TypeScript** 로 둔다. `SubjectId` 유니온 타입 덕에 실험의 `subject` 필드에 오타가 있으면 컴파일이 실패한다. Backstage 가 런타임에 YAML 을 검증하는 일을 여기선 컴파일러가 한다.

**겪은 일**: 주제 id `search` 가 전역 검색 페이지 `/search` 와 겹쳐서 주제 화면에 들어갈 수 없었다. 이름 충돌은 카탈로그의 고전적인 문제다. 대응은 두 단계였다 — id 를 `opensearch` 로 바꾸고, **CI 에 "주제 id 가 전역 라우트와 겹치지 않는다" 검사를 추가**했다. 사건을 규칙으로 바꾼 것이다.

**빠진 것**: `owner` 필드. 개인 저장소라 필요 없었지만, 팀이었다면 가장 먼저 넣을 필드다([카탈로그와 소유권](/platform-engineering/notes/02-service-catalog-backstage)). 실험 `plat-catalog-validate` 가 이 공백을 점수표에 드러낸다.

## 2. 셀프서비스 인프라 — compose 프로파일

```json
"kafka:up":      "docker compose -p study --profile kafka up -d kafka",
"cdc:up":        "docker compose -p study --profile kafka --profile postgres --profile cdc up -d kafka postgres connect",
"lake:up":       "docker compose -p study --profile lake up -d s3"
```

**설계 결정**: 한 개의 compose 파일 + 프로파일. 학습자는 필요한 것만 띄운다(비용 = 노트북 메모리). 포트는 사용자의 다른 프로젝트와 겹치지 않는 대역으로 고정했다.

**겪은 일 두 가지**:

1. 공식 MinIO 이미지를 공개 레지스트리에서 받을 수 없게 되자 `lake:up` 이 깨졌다. 구현을 versitygw 로 바꿨지만 **사용자 명령은 그대로** — 추상화가 변경을 흡수했다([셀프서비스 인프라](/platform-engineering/notes/04-self-service-infrastructure)).
2. 스크립트 일부에 `-p study` 가 없어 다른 폴더(git worktree)에서 실행하면 프로젝트 이름이 달라져 같은 컨테이너 이름이 충돌했다. **모든 스크립트에 기본값을 강제**하는 것으로 해결 — 기본값의 일관성이 셀프서비스의 신뢰를 만든다.

## 3. 플러그인 체계 — 실험 레지스트리

```ts
const SHELL = new Set([...]);   // 셸 명령 실험을 가진 주제
const CODE  = new Set([...]);   // 코드 실험을 가진 주제
export function listLab(subject) { /* 두 종류를 합쳐 반환 */ }
export function findExperiment(id, preferSubject) { /* 모든 주제에서 찾기 */ }
```

새 주제는 실험 파일 하나와 Set 에 이름 하나를 추가하면 실험실이 생긴다. Backstage 플러그인처럼 **확장점이 정해져 있어서** 코어(실험 실행기·결과 화면)를 건드리지 않는다.

**겪은 일**: 노트가 다른 주제의 실험을 참조하면 화면에서 조용히 사라지는 버그가 있었다(아키텍처 노트의 "증거 실험" 13개). 확장점이 "자기 주제만" 을 가정했던 것이다. `findExperiment` 로 교차 참조를 허용하고, 콘텐츠 검사가 **존재하지 않는 id** 를 잡도록 바꿨다.

## 4. 정책을 코드로 — 콘텐츠 검사

| 정책 | 왜 생겼나 |
|---|---|
| frontmatter YAML 이 파싱된다 | title 에 `: ` 가 있으면 YAML 이 깨지고, 노트 로더는 오류를 삼켜 **노트가 조용히 사라졌다** |
| level 은 기초·중급·심화 | 목록 화면의 그룹이 깨짐 |
| 노트·실험·다이어그램 링크 존재 | 여러 사람(에이전트)이 동시에 쓰면서 깨진 링크가 생김 |
| experiments id 실재 | 위의 교차 참조 버그 |
| 퀴즈 note·용어집 link 실재 | 이름 변경(search → opensearch) 후 남은 참조 |
| 주제 id ≠ 전역 라우트 | 위의 충돌 사건 |

이 정책들은 **모두 실제 사건에서 나왔다.** 플랫폼 정책이 늘어나는 건강한 방식이다 — 상상한 위험이 아니라 겪은 위험을 코드로 막는다. 반대로 정책을 처음 켤 때 기존 위반을 먼저 해소해야 했던 점은 [정책의 폭발 반경](/platform-engineering/notes/06-platform-observability-slo)과 같다.

## 5. 안전한 기본값 — 데드맨 스위치

장애 주입 실험이 중간에 끊기자 Redis 가 3시간 멈춘 채 남은 사고가 있었다. 포스트모템의 액션은 "실험마다 조심하자" 가 아니라 **공용 기본값**이었다.

```ts
const guard = armUnpause("study-redis", 60);   // 주입 직전, 독립 프로세스가 60초 뒤 원복 예약
await exec("docker", ["pause", "study-redis"]);
try { /* 실험 */ } finally {
  await exec("docker", ["unpause", "study-redis"]);
  guard.disarm();                               // 정상 종료면 해제
}
```

이제 Redis·Kafka·설정을 건드리는 실험 8곳이 모두 이 헬퍼를 쓰고, CI 의 단위 테스트가 "원복 실행·해제" 를 검증한다. **한 실험의 사고 → 플랫폼 기본값 → 모든 실험의 보호**. 플랫폼 팀이 포스트모템에서 찾아야 할 액션의 모범이다.

## 6. 측정 — DORA 와 그 한계

실험 `plat-dora-metrics` 는 이 저장소의 GitHub 기록으로 DORA 를 계산한다. 결과(리드타임 중앙값 2분 안팎, 변경 실패율 0%)가 "엘리트" 처럼 보이지만, 리뷰·배포 단계가 없는 개인 저장소라는 맥락을 빼면 오해다([DORA 와 개발자 경험](/platform-engineering/notes/05-dora-devex-metrics)). 이 저장소에서 더 의미 있는 지표는 따로 있다.

| 이 저장소에 맞는 지표 | 측정 방법 |
|---|---|
| 새 주제 하나를 추가하는 데 걸리는 시간 | 등록 커밋 → 콘텐츠 커밋 간격 |
| 콘텐츠 검사 위반 건수 추세 | CI 실패 로그 |
| 실험의 환경 의존 실패율 | requires 메시지 vs 실행 실패 |
| 카탈로그 완성도 | `plat-catalog-validate` 점수 |

## 다음에 추가할 IDP 기능 — 설계

| 기능 | 설계 | 효과 |
|---|---|---|
| `owner`·`lifecycle` 필드 | Subject 에 추가, 콘텐츠 검사로 필수화 | 카탈로그 완성도의 마지막 공백 |
| 스코어카드 페이지 | `plat-catalog-validate` 로직을 서버 컴포넌트로 → `/platform` 대시보드 | 어느 주제가 덜 갖춰졌는지 상시 표시 |
| 주제 템플릿 CLI | `pnpm new:subject <id> <track>` — 4단계(카탈로그·점검·레지스트리·콘텐츠)를 한 번에 | 골든 패스의 "사전" 쪽 ([골든 패스](/platform-engineering/notes/03-golden-paths-templates)) |
| 실험 결과 이력 | 실행 결과를 Redis Stream 에 기록 → 추이 그래프 | 실험 신뢰성의 SLI |
| 의존 이미지 고정 | compose 이미지를 다이제스트로 고정, 주기적 갱신 PR | MinIO 사건 같은 외부 의존 장애 예방 |

## 예시로 보기 — 이 프로젝트에서

이 노트 자체가 "예시" 이므로, 세 실험을 순서대로 돌려 보는 것이 실습이다.

```bash
pnpm exec tsx scripts/run-shell-lab.mts platform-engineering plat-catalog-validate     # 카탈로그 완성도
pnpm exec tsx scripts/run-shell-lab.mts platform-engineering plat-golden-path-scaffold # 템플릿 + 정책 검사
pnpm exec tsx scripts/run-shell-lab.mts platform-engineering plat-dora-metrics         # DORA
```

세 결과를 나란히 보면 IDP 의 세 기둥 — **무엇이 있나(카탈로그), 어떻게 만드나(골든 패스), 잘 흐르나(측정)** — 이 한 저장소 안에서 어떻게 생겼는지 보인다. 관련해서 [IaC 대안과 설계](/iac/notes/08-alternatives-design), [FinOps 거버넌스](/finops/notes/06-governance), [뮤테이션 테스트와 테스트 비용](/testing/notes/07-mutation-testing-cost)도 같은 "플랫폼 관점" 으로 읽어 볼 만하다.

## 실습 체크리스트

- [ ] 세 실험을 모두 실행하고, 카탈로그 완성도가 가장 낮은 주제 하나를 골라 무엇이 빠졌는지 확인하기
- [ ] "다음에 추가할 IDP 기능" 중 하나(예: `pnpm new:subject`)의 입력·출력·검사 규칙을 구체적으로 설계하기
- [ ] 이 저장소의 콘텐츠 검사 규칙 중 하나를 골라, 그 규칙이 없을 때 어떤 사건이 다시 일어날지 설명하기
- [ ] 내가 아는 조직의 플랫폼에서 "사건 → 규칙 → 기본값" 으로 이어진 사례를 하나 찾아 적기
