---
title: "통합 테스트와 컨테이너 — 진짜 Redis·Postgres 로 경계를 검증한다"
order: 3
level: 중급
summary: "통합 테스트가 잡는 버그(SQL·직렬화·트랜잭션·원자성·설정), 진짜 의존성 vs 메모리 대체물(H2·ioredis-mock)의 함정, Testcontainers 의 동작(임시 컨테이너·대기 전략·포트 매핑·정리), CI 서비스 컨테이너와의 비교, 격리 전략(키 접두어·트랜잭션 롤백·스키마별·DB 템플릿), 병렬 실행과 정리, 속도 최적화(재사용·스냅샷), 그리고 이 사이트의 실험 프레임워크가 곧 통합 테스트라는 관점"
tags: [통합 테스트, Testcontainers, 서비스 컨테이너, 격리, 정리, Redis, PostgreSQL, CI]
experiments: [test-property-ratelimit]
---

## 통합 테스트가 잡는 것

단위 테스트는 로직을, 통합 테스트는 **경계**를 검증한다. 경계에서 나는 버그는 대역(mock·fake)으로는 거의 안 보인다.

| 버그 | 예 | 단위 테스트(대역)에서 |
|---|---|---|
| 쿼리 오류 | 오타 컬럼, 잘못된 JOIN, 인덱스 미사용 | mock 은 아무 SQL 이나 받는다 |
| 직렬화 | Date·BigInt·Buffer 변환, JSON 키 대소문자 | fake 는 객체를 그대로 저장 |
| **원자성·동시성** | GET→SET 경쟁, 잠금 순서, 교착 | 메모리 fake 는 원자적이다 |
| 트랜잭션 | 커밋 안 됨, 격리 수준 차이 | 대부분 흉내 안 냄 |
| 만료·TTL | 키가 예상보다 빨리/늦게 사라짐 | fake 마다 다름 |
| 설정 | 연결 문자열, 풀 크기, 타임아웃 | 대역은 설정을 안 씀 |
| 버전 차이 | Redis 7 vs 8 명령 동작, PG 확장 | — |

실험 [`test-property-ratelimit`](/testing/lab/test-property-ratelimit) 이 좋은 예다. GET→SET 으로 만든 레이트리미터는 순차 테스트로는 통과하지만, **진짜 Redis 에 동시 요청**을 보내면 fast-check 가 즉시 반례(한도 1, 동시 2 → 2건 허용)를 찾는다. 메모리 Map 으로 만든 fake 에서는 이 경쟁이 재현되지 않는다.

## 메모리 대체물의 함정

| 대체물 | 문제 |
|---|---|
| H2 / SQLite 로 PostgreSQL 대신 | SQL 방언·타입·잠금·인덱스가 다르다. "테스트는 통과, 운영은 실패" 의 고전 |
| ioredis-mock | 명령 일부만 지원, 원자성·Lua·만료 타이밍이 다르다 |
| 임베디드 Kafka | 실제 브로커 설정·리밸런스 동작과 다름 |

규칙: **운영과 같은 엔진·같은 메이저 버전**으로 테스트한다. 컨테이너가 그걸 싸게 만들었다.

## Testcontainers

테스트 코드가 직접 Docker 로 임시 컨테이너를 띄우고 끝나면 지운다.

```ts
import { GenericContainer, Wait } from "testcontainers";
import Redis from "ioredis";

let container: StartedTestContainer, redis: Redis;
beforeAll(async () => {
  container = await new GenericContainer("redis:8-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();                                             // 임의의 호스트 포트에 매핑
  redis = new Redis(container.getMappedPort(6379), container.getHost());
}, 60_000);
afterAll(async () => { redis.disconnect(); await container.stop(); });
```

| 요소 | 역할 |
|---|---|
| 임의 포트 매핑 | 여러 테스트·여러 개발자가 충돌 없이 (6379 고정이 아님) |
| **대기 전략** | 로그 메시지·포트·헬스체크 — "컨테이너 시작 ≠ 서비스 준비" |
| Ryuk(정리 컨테이너) | 테스트 프로세스가 죽어도 남은 컨테이너를 지운다 |
| 모듈 | `@testcontainers/postgresql` 등 — 연결 문자열 제공 |

### 대기 전략이 중요한 이유

"컨테이너가 떴다" 와 "연결을 받는다" 는 다르다. Postgres 는 초기화 중 한 번 재시작한다. 고정 `sleep(5)` 은 느리거나 부족하다 — [플레이키 테스트](/testing/notes/06-e2e-flaky-management) 의 시간 대기 문제와 같다. 이 사이트의 compose 파일이 `healthcheck` + `depends_on: condition: service_healthy` 를 쓰는 것도 같은 이유다([Docker Compose](/docker/notes/05-compose)).

## Testcontainers vs CI 서비스 컨테이너

| | Testcontainers | CI 서비스 컨테이너 (GitHub Actions `services:`) |
|---|---|---|
| 정의 위치 | 테스트 코드 | 워크플로 YAML |
| 로컬에서 | 같은 코드로 그대로 | 개발자가 직접 띄워야 (compose) |
| 테스트별 다른 버전·설정 | 쉬움 | 어려움 |
| 시작 비용 | 테스트마다 (재사용 가능) | 잡당 한 번 |
| Docker 필요 | 테스트 실행 환경에 | 러너에 |

이 사이트의 CI 는 서비스 컨테이너 방식이다(`.github/workflows/ci.yml` 의 `services.redis`). 로컬에서는 `pnpm redis:docker` 로 같은 Redis 를 띄운다. 의존성이 하나뿐이라 이 방식이 단순하고 빠르다.

## 격리 — 테스트가 서로를 오염시키지 않게

| 전략 | 방법 | 장단점 |
|---|---|---|
| **키·이름 접두어** | 테스트마다 고유 접두어 (`test:<run-id>:`) | 싸다. 정리를 잊으면 쌓인다 |
| 트랜잭션 롤백 | 각 테스트를 트랜잭션으로 감싸고 끝에 ROLLBACK | 빠르고 깨끗. 테스트 대상이 자체 트랜잭션을 쓰면 안 됨 |
| 스키마·DB 별 | 테스트(워커)마다 스키마/DB 생성 | 병렬 안전. 생성 비용 |
| **템플릿 DB** | 마이그레이션된 DB 를 템플릿으로 `CREATE DATABASE … TEMPLATE` | PG 에서 수십 ms 에 깨끗한 DB |
| FLUSHDB / TRUNCATE | 테스트 전 전부 비움 | 병렬 실행 불가 |
| 컨테이너 별 | 테스트 파일마다 컨테이너 | 완전 격리, 가장 느림 |

이 사이트의 실험 프레임워크는 **접두어 방식**이다. 코드 실험의 `k(name)` 이 실험별 접두어를 붙이고, 실험이 `finally` 에서 자기 키를 지운다. 실험 `test-property-ratelimit` 도 `k("rl:*")` 로 만든 키를 끝에 정리한다.

### 정리(cleanup)는 `finally` 에

```ts
const r = new Redis(url);
try {
  // ... 테스트
} finally {
  const keys = await r.keys(k("*"));          // 실패해도 정리
  if (keys.length) await r.del(...keys);
  r.disconnect();
}
```

정리가 실패 경로에서 안 돌면 다음 실행이 오염된 상태로 시작한다. 장애 주입 실험이 Redis 를 멈춘 채 중단돼 3시간 동안 남은 사고는 정리가 프로세스 수명에 묶여 있었기 때문이다 — [SRE 포스트모템 예시](/sre/notes/05-incident-postmortem). 외부 상태를 바꾸는 테스트는 **프로세스가 죽어도 원복되는 장치**(TTL, 데드맨 스위치)를 같이 둔다.

## 병렬 실행

| 문제 | 대응 |
|---|---|
| 같은 키·테이블을 동시에 | 워커별 접두어·스키마 (`VITEST_POOL_ID`) |
| 포트 충돌 | 임의 포트 매핑 |
| 공유 DB 의 전역 설정 변경 (`CONFIG SET`) | 그 테스트는 직렬로 (`describe.sequential`) 또는 전용 컨테이너 |

이 사이트의 `vitest.config.ts` 는 `fileParallelism: false` 로 파일을 직렬 실행한다. 일부 실험이 `CONFIG SET`(예: AOF 설정)처럼 서버 전역 상태를 바꾸기 때문이다. 병렬화하려면 그런 실험을 분리해야 한다.

## 속도

| 기법 | 효과 |
|---|---|
| 컨테이너 재사용 (`withReuse()`) | 로컬에서 실행 간 컨테이너 유지 |
| 테스트 파일당 1회 시작 (`beforeAll`) | 테스트마다 시작하지 않는다 |
| 템플릿 DB·스냅샷 | 마이그레이션을 매번 돌리지 않는다 |
| 이미지 캐시 | CI 에서 이미지 pull 이 가장 느리다 — 작은 이미지(alpine) |
| 범위 제한 | 변경된 모듈의 통합 테스트만 ([CI 성능](/github-actions/notes/06-ci-performance)) |

## 예시로 보기 — 이 사이트의 실험 = 통합 테스트

```ts
// tests/experiments.test.ts 의 구조 (요약)
for (const exp of experiments) {
  it(exp.id, async () => {
    const res = await runExperiment(exp);       // 진짜 Redis 에 명령을 보내고
    expect(res.ok).toBe(true);                   // rec.check 가 하나라도 실패하면 ok=false
  });
}
```

- **대역 없음**: Redis 실험은 CI 의 진짜 `redis:8-alpine` 에 명령을 보낸다
- **단언**: 실험 안의 `rec.check("…", 조건)` 이 테스트 단언이다
- **사전조건**: `requires` 가 환경이 없으면 skip 사유를 돌려준다 — 모듈이 없는 Redis 에서 벡터 검색 실험을 건너뛰는 식
- **정리**: 실험별 키 접두어 + `finally`
- **두 얼굴**: 같은 코드가 CI 에서는 테스트로, 웹에서는 학습용 실험으로 돈다

셸·코드 실험(Docker·Kafka·PG·k8s)은 CI 에서 돌지 않는다. 필요한 의존성이 많기 때문이다. 이것을 CI 로 옮긴다면 Kafka·Postgres 서비스 컨테이너를 추가하고, k8s 가 필요한 실험은 kind 를 띄우는 야간 잡으로 분리하는 것이 현실적이다.

## 실전에서는 어디에 쓰이나

> "테스트는 통과했는데 운영에서 SQL 이 실패했다" 를 겪은 팀이 진짜 DB·캐시를 컨테이너로 띄워 경계를 검증할 때 이 노트가 쓰인다. Testcontainers 와 CI 서비스 컨테이너가 이 방식을 싸게 만들었다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 주문 리포지토리 | H2 에선 되던 쿼리가 PostgreSQL 에서 실패 | `@testcontainers/postgresql` 로 운영과 같은 메이저 버전 | H2·SQLite 대체(방언 차이) |
| 쿠폰·재고 차감(Redis) | 동시 요청 시 GET→SET 경쟁 | 진짜 Redis 에 동시 요청 + 키 접두어 격리 | ioredis-mock(원자성 재현 불가) |
| 이벤트 기반 백엔드 | 직렬화·컨슈머 설정 오류 | Kafka 컨테이너로 발행-소비 왕복 확인 | 임베디드 브로커(동작 차이) |
| 대형 모노레포 CI | 테스트마다 마이그레이션이 느림 | PostgreSQL 템플릿 DB 로 테스트마다 깨끗한 DB | 테스트 전 TRUNCATE(병렬 불가) |
| 의존성이 하나뿐인 작은 서비스 | 설정을 단순하게 | GitHub Actions `services:` 로 잡당 한 번 | 테스트 코드에서 컨테이너 관리 |

**이럴 땐 안 맞는다**
- Docker 를 쓸 수 없는 CI 러너·보안 환경: 컨테이너를 못 띄운다. 공유 테스트 DB + 스키마별 격리나 관리형 임시 DB 를 쓴다.
- 순수 계산 로직: 컨테이너 시작 비용만 든다. 단위 테스트로 충분하다.

**누가 매일 만나나** — 백엔드 개발자는 리포지토리·캐시 계층을 테스트할 때, 플랫폼·DevEx 엔지니어는 CI 의 서비스 컨테이너·이미지 캐시와 병렬 실행 격리를 설계할 때 만난다.

**면접·실무 단골 질문**
- Q. 통합 테스트에서 DB 를 메모리 DB 로 대체하면 안 되는 이유는? → SQL 방언·잠금·타입·인덱스가 달라 운영 버그를 놓친다.
- Q. 병렬 통합 테스트의 격리는? → 워커별 접두어·스키마, 트랜잭션 롤백, 템플릿 DB 중 고르고 전역 설정 변경 테스트는 직렬로.

## 실습 체크리스트

- [ ] `pnpm test` 로 Redis 실험 통합 테스트를 돌리고, Redis 를 끈 상태에서는 어떻게 되는지 확인하기
- [ ] 실험 `test-property-ratelimit` 의 비원자 구현을 메모리 Map fake 로 바꾸면 반례가 나오는지 생각해 보기
- [ ] `@testcontainers/postgresql` 로 `pg-transaction-isolation` 실험을 테스트로 감싸는 코드를 설계하기
- [ ] 이 사이트 실험 중 서버 전역 상태를 바꾸는 것을 찾아 병렬 실행이 왜 위험한지 적기
- [ ] Postgres 템플릿 DB 로 테스트마다 깨끗한 DB 를 만드는 SQL 을 써 보기
