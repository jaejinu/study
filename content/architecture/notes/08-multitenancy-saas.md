---
title: "멀티테넌시와 SaaS 아키텍처 — 격리 모델, RLS, 노이지 네이버, 비용 배분, 온보딩"
order: 8
level: 심화
summary: "한 시스템으로 여러 고객(테넌트)을 섬기는 법. 격리 스펙트럼(공유 스키마+tenant_id / 스키마 분리 / DB 분리 / 셀·스택 분리)과 각각의 비용·보안·운영 트레이드오프, PostgreSQL RLS 로 '코드가 where 를 빠뜨려도' 막는 법, 테넌트 컨텍스트 전파, 노이지 네이버를 막는 레이트리밋·쿼터·큐 분리·셀 아키텍처, 테넌트별 비용 배분과 관측(라벨 카디널리티), 온보딩·오프보딩·데이터 이전, 티어별 혼합 모델"
tags: [멀티테넌시, SaaS, tenant_id, RLS, 노이지 네이버, 셀 아키텍처, 레이트리밋, 쿼터, 비용 배분, 온보딩]
experiments: [rate-limiter, pg-row-locks]
---

SaaS 의 경제학은 **공유**에서 나온다: 고객 1,000곳이 서버 1,000벌이 아니라 한 벌을 나눠 쓴다. 그 대가로 세 가지 문제가 생긴다 — **데이터가 섞이지 않게**(격리), **한 고객이 다른 고객을 느리게 하지 않게**(노이지 네이버), **누가 얼마를 쓰는지 알게**(비용 배분). 이 노트는 그 셋을 설계 결정으로 바꾼다.

## 격리 스펙트럼

| 모델 | 구조 | 격리 | 테넌트당 비용 | 운영 | 맞는 경우 |
|---|---|---|---|---|---|
| **공유 스키마 (pool)** | 모든 테이블에 `tenant_id` 열 | 논리적(코드·RLS) | 가장 낮음 | 마이그레이션 1회 | 소규모 고객 다수, B2C, 무료 티어 |
| **스키마 분리** | 같은 DB, 테넌트마다 `schema` | 중간(search_path) | 낮음 | 마이그레이션 × N 스키마 | 수백 테넌트, 고객별 확장 필드 |
| **DB 분리 (silo)** | 테넌트마다 DB/인스턴스 | 강함(커넥션·자격 증명 분리) | 높음 | N 개 DB 의 백업·업그레이드 | 엔터프라이즈, 규제(데이터 위치) |
| **셀/스택 분리** | 테넌트 묶음마다 앱+DB 전체 | 가장 강함(장애 격리) | 셀 단위로 분할 상환 | 셀 배포 자동화 필수 | 대규모, 폭발 반경 제한 |

현실의 SaaS 는 **혼합**이다: 무료·스탠다드는 pool, 엔터프라이즈는 silo, 그리고 전체를 셀로 나눈다. 테넌트 메타데이터(어느 셀·어느 DB·어느 티어)를 담는 **컨트롤 플레인**이 라우팅을 결정한다.

```
요청 → 게이트웨이 (토큰에서 tenant 식별)
     → 컨트롤 플레인 조회 (tenant → cell-3, tier=enterprise, db=tenant_acme)
     → cell-3 의 앱 → tenant_acme DB
```

## 공유 스키마 — 가장 흔하고 가장 위험한

`tenant_id` 를 모든 테이블에 넣고 모든 쿼리에 `WHERE tenant_id = $1` 을 붙인다. 한 곳만 빠뜨려도 **다른 고객의 데이터가 보인다**. 이것이 멀티테넌시의 가장 흔한 사고이자 [IDOR](/security/notes/03-authn-authz) 의 대량 버전이다.

방어를 코드 리뷰에 맡기지 말고 **DB 가 강제**하게 한다.

### PostgreSQL RLS — where 를 빠뜨려도 막힌다

```sql
create table orders (
  id bigserial primary key,
  tenant_id uuid not null,
  amount int not null
);
alter table orders enable row level security;
alter table orders force row level security;          -- 테이블 소유자에게도 적용

create policy tenant_isolation on orders
  using (tenant_id = current_setting('app.tenant_id')::uuid)        -- 읽기·수정·삭제 대상 행
  with check (tenant_id = current_setting('app.tenant_id')::uuid);  -- 새로 쓰는 행

-- 앱 역할은 RLS 를 우회할 수 없게
create role app_user nologin;
grant select, insert, update, delete on orders to app_user;
-- (bypassrls 권한 없음, 테이블 소유자 아님)
```

요청마다 트랜잭션 시작에서 테넌트를 설정한다:

```ts
await client.query("begin");
await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);   // true = 트랜잭션 로컬
const r = await client.query("select * from orders");                            // where 없이도 자기 행만
await client.query("commit");
```

함정:

- `set_config(..., false)`(세션 범위)를 쓰면 **커넥션 풀**에서 다음 요청이 이전 테넌트 설정을 물려받는다. 반드시 트랜잭션 로컬(`true`) 또는 `SET LOCAL`.
- PgBouncer 트랜잭션 모드에서도 트랜잭션 로컬이면 안전하다.
- 테이블 소유자·슈퍼유저는 RLS 를 우회한다 → 마이그레이션 역할과 앱 역할을 **분리**([보안 07](/security/notes/07-datastore-hardening)).
- RLS 정책의 조건은 모든 쿼리에 붙는 술어다 → `tenant_id` 가 **모든 인덱스의 선두 열**이어야 성능이 유지된다(`(tenant_id, created_at)`).
- 고유 제약도 테넌트 범위로: `unique (tenant_id, email)`.

### 테넌트 컨텍스트 전파

테넌트는 **인증 토큰에서** 나온다. 요청 파라미터·헤더에서 받으면 위조된다.

```
JWT { sub: "user-17", tenant: "acme", tier: "enterprise" }
 → 미들웨어가 AsyncLocalStorage 에 tenant 저장
 → DB 어댑터가 트랜잭션 시작 시 set_config
 → 로그·트레이스·메트릭에 tenant 라벨
 → 큐 메시지 헤더에 tenant → 소비자가 같은 컨텍스트 복원
```

비동기 경계(큐·배치·크론)에서 컨텍스트를 잃는 것이 두 번째로 흔한 사고다. 메시지에 `tenant_id` 를 **필수 필드**로 두고, 소비자가 없으면 거부한다.

## 노이지 네이버 — 공정성은 공짜가 아니다

한 테넌트가 대량 가져오기를 돌리면 DB CPU·커넥션·큐가 차서 **모든** 테넌트가 느려진다. 방어는 계층별로:

| 계층 | 수단 | 이 사이트의 증거 |
|---|---|---|
| 진입 | 테넌트별 레이트리밋(토큰 버킷, 티어별 한도) | [rate-limiter 실험](/redis/lab/rate-limiter), [Redis 레이트리밋](/redis/notes/10-rate-limiting) |
| 동시성 | 테넌트별 동시 요청 상한(세마포어) | [벌크헤드](/chaos/notes/03-resilience-patterns-verified) |
| 비동기 | 테넌트별 큐 또는 공정 스케줄링(라운드 로빈 소비) | [Kafka 파티션 키](/kafka/notes/02-topics-partitions) |
| DB | 테넌트별 `statement_timeout`, 무거운 테넌트의 읽기를 복제본으로, 최종적으로 silo 로 승격 | [PG 운영](/postgres/notes/05-operations) |
| 저장 | 테넌트별 쿼터(행 수·저장량·API 호출) | — |

```ts
// 티어별 토큰 버킷 키: rl:{tenant}:{tier}
const limits = { free: { rate: 5, burst: 10 }, standard: { rate: 50, burst: 100 }, enterprise: { rate: 500, burst: 1000 } };
```

**큐의 공정성**: 테넌트 A 가 메시지 100만 개를 넣으면 FIFO 큐에서 테넌트 B 의 메시지 1개가 100만 개 뒤에 선다. 해법은 테넌트별 큐(관리 부담), 테넌트 키로 파티션을 나누고 소비자가 파티션을 돌아가며 읽기, 또는 **가중 공정 큐**(각 테넌트에서 차례로 N 개씩).

### 셀 아키텍처 — 폭발 반경을 테넌트 묶음으로

셀은 앱+DB+캐시+큐 한 벌이고, 테넌트는 정확히 하나의 셀에 산다. 한 셀의 장애·배포 실수·노이지 네이버는 그 셀의 테넌트만 다친다. AWS 의 많은 서비스, Slack, Salesforce 가 이 구조다.

- 셀 크기 = 최대 폭발 반경. "한 셀 장애로 고객 5% 이상이 영향받지 않는다" 가 설계 목표.
- 배포는 셀 단위 웨이브(카나리 셀 → 10% → 전체) — [점진 배포](/kubernetes/notes/13-gitops-progressive-delivery).
- 테넌트 이동(셀 재배치)이 가능해야 핫 셀을 식힐 수 있다 → 데이터 이전 도구가 필수.

## 비용 배분 — 누가 얼마를 쓰나

가격 정책과 수익성은 테넌트별 비용을 알아야 정할 수 있다.

- **직접 측정**: API 호출 수, 저장량, 처리 시간, LLM 토큰(테넌트 라벨). 사용량 기반 과금이면 이것이 청구서다.
- **배분**: 공유 인프라 비용을 사용량 비율로 나눈다(DB CPU 시간 비율, 요청 수 비율). 정확하지 않아도 **상대 순위**가 맞으면 쓸모 있다.
- **관측의 함정**: 메트릭에 `tenant` 라벨을 붙이면 카디널리티가 테넌트 수만큼 곱해진다. 테넌트 10만 × 엔드포인트 50 × 상태 5 = 2,500만 시계열. 해법: 메트릭은 **티어** 라벨만, 테넌트별은 **로그/트레이스**(고카디널리티 친화)나 상위 N 테넌트만 별도 집계([관측성 05](/observability/notes/05-logging-loki)).

## 온보딩·오프보딩·데이터 이전

| 단계 | pool | silo |
|---|---|---|
| 온보딩 | 행 하나(tenants 테이블) — 초 단위 | DB 프로비저닝·마이그레이션 — 분 단위, 자동화 필수([IaC](/iac)) |
| 스키마 변경 | 1회 | N 회 — 실패한 테넌트 추적, 롤링 마이그레이션 |
| 오프보딩(삭제 요청, GDPR) | `delete where tenant_id` — 모든 테이블·백업·로그·캐시·검색 인덱스에서 | DB 삭제 + 백업 만료 |
| 내보내기 | 테넌트 범위 덤프 도구 | `pg_dump` |
| 티어 승격(pool→silo) | 데이터 이전: 복사 → 이중 쓰기 → 전환 → 정리 | — |

오프보딩은 **삭제 대상 목록**이 있어야 가능하다. 테넌트 데이터가 사는 모든 저장소(PG, Redis 키 접두사, S3 접두사, OpenSearch 인덱스, 로그)를 등록해 두지 않으면 "다 지웠다" 를 증명할 수 없다. Redis 키는 `t:{tenant}:...` 접두사로, 클러스터라면 해시 태그 `{tenant}` 로 같은 슬롯에 모아 삭제를 쉽게 한다([Redis 클러스터](/redis/notes/11-replication-sentinel-cluster)).

## 예시로 보기 — 이 프로젝트를 SaaS 로 만든다면

이 학습 사이트의 진행률은 Redis `progress:read` 하나다(사용자 1명). 여러 학습자를 받으려면:

1. **키 설계**: `t:{org}:u:{user}:progress:read`. 조직 단위 집계(팀 대시보드)는 `{org}` 해시 태그로 같은 슬롯.
2. **노트·실험 콘텐츠**는 공유(모든 테넌트 동일) → 테넌트 데이터는 진행률·퀴즈 기록·학습 시간뿐. 전형적인 **pool** 모델.
3. **실험 실행**은 공유 Redis/PG/Kafka 를 건드린다 → 테넌트별 접두사(`k()` 함수가 이미 실험 접두사를 붙인다)와 실험 동시 실행 상한(벌크헤드). 장애 주입 실험은 테넌트에 열면 안 된다(공유 인프라를 멈춤) — 기능 플래그로 관리자만.
4. **비용**: AI 도우미의 LLM 토큰을 `tenant` 별로 기록(현재 `study_llm_tokens_total` 에 라벨 추가) → 사용량 기반 과금의 기초.

> 설계 사례에 멀티테넌시를 적용해 보려면 [설계 사례](/architecture/notes/06-design-cases) 의 URL 단축기·채팅 사례를 '테넌트별 한도' 관점으로 다시 그려 보자.

## 실습 체크리스트

- [ ] study PostgreSQL 에 위 `orders` 테이블과 RLS 정책을 만들고, `set_config` 없이 조회하면 0행, 테넌트 A 로 설정하면 A 의 행만 보이는 것 확인
- [ ] `set_config(..., false)` 로 세션 범위 설정을 한 뒤 같은 커넥션에서 다른 테넌트 요청을 흉내 내 누수를 재현하고 `true` 로 고치기
- [ ] `rate-limiter` 실험의 키를 `rl:{tenant}` 로 바꿔 티어별 한도를 적용하는 코드를 설계해 보기
- [ ] 내 서비스의 테넌트 데이터가 사는 저장소를 전부 나열해 오프보딩 체크리스트 만들기
