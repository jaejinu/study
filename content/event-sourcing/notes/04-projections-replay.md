---
title: "프로젝션과 재생 — 읽기 모델, 체크포인트, 재구축, 결과적 일관성"
order: 4
level: 중급
summary: "이벤트 로그에서 읽기 모델을 만드는 프로젝터의 구조, 체크포인트를 프로젝션과 같은 트랜잭션에 저장해야 하는 이유, 멱등 프로젝션, 처음부터 재구축(블루·그린 테이블 교체), 프로젝션 지연과 '방금 쓴 것 읽기' 문제. 실험에서 10만 이벤트 재생 185ms, 증분 1,000개 6ms 를 잰다"
tags: [프로젝션, 읽기 모델, 체크포인트, 재구축, 결과적 일관성, CQRS]
experiments: [es-projection-rebuild]
---

## 프로젝터의 모양

프로젝터는 "이벤트 → 읽기 모델 갱신" 함수와 "어디까지 처리했나" 체크포인트로 이뤄진다.

```ts
async function runProjector() {
  for (;;) {
    const cp = await getCheckpoint("balances");                 // 마지막 global_position
    const batch = await query(
      "select global_position, stream_id, type, data from events where global_position > $1 order by global_position limit 5000",
      [cp],
    );
    if (batch.length === 0) { await sleep(200); continue; }
    await tx(async (c) => {
      for (const e of batch) await apply(c, e);                  // 읽기 모델 갱신
      await setCheckpoint(c, "balances", last(batch).global_position); // ★ 같은 트랜잭션
    });
  }
}
```

**체크포인트를 같은 트랜잭션에** 저장하는 것이 핵심이다.

| 순서 | 중간에 죽으면 |
|---|---|
| 읽기 모델 갱신 → (커밋) → 체크포인트 저장 | 재시작 시 같은 배치를 **다시 적용** → 잔액이 두 번 더해짐 |
| 체크포인트 저장 → 읽기 모델 갱신 | 배치를 **건너뜀** → 영원히 누락 |
| 둘을 한 트랜잭션 | 둘 다 되거나 둘 다 안 됨 ✓ |

읽기 모델이 다른 저장소(OpenSearch, Redis)라 한 트랜잭션이 불가능하면 **멱등 적용**으로 바꾼다: "잔액 += 10" 대신 "이벤트 ID 를 처리 기록에 넣고 없을 때만 적용", 또는 "이 스트림의 version 이 읽기 모델의 last_version 보다 클 때만 적용". 멱등 소비자의 일반론은 [메시징 노트 04](/messaging/notes/04-delivery-guarantees-delay).

## 실측 — 재생과 증분

[es-projection-rebuild](/event-sourcing/lab/es-projection-rebuild) 는 계좌 1,000개 × 100 = 이벤트 10만 개로 잔액 프로젝션을 만든다(배치 5,000, 배치마다 `unnest` 업서트 + 체크포인트를 한 트랜잭션).

| 작업 | 처리 이벤트 | 시간 | 비고 |
|---|---|---|---|
| 처음부터 재생 | 100,000 | 185ms | 약 54만 이벤트/초, 20 배치 |
| 이벤트 1,000개 추가 후 체크포인트부터 증분 | 1,000 | 6ms | 새 것만 |
| 읽기 모델을 지우고 재구축 | 101,000 | 202ms | 1억 개라면 같은 속도로 약 3분 |

재생 결과는 SQL 직접 집계(`sum(case when type=…)` group by)와 1,000개 계좌 모두 일치했다. 숫자를 바꿔 생각해 보자. 이 속도는 프로젝션 갱신이 **배치 업서트 한 번**이라서 나온다. 이벤트 하나마다 `update balances …` 를 하면 왕복 10만 번이 되어 수십 배 느려진다. 프로젝터 성능의 대부분은 **배치와 왕복 수**다 — [성능 노트 05](/performance/notes/05-data-access-bottlenecks)의 N+1 과 같은 이야기다.

## 재구축 — 이벤트 소싱의 초능력이자 운영 부담

읽기 모델에 버그가 있었다면? 고치고 **처음부터 다시** 만든다. 상태 저장에서는 불가능한 일이다.

안전한 재구축 절차(블루·그린):

```sql
-- 1. 새 테이블로 처음부터 (서비스는 계속 옛 테이블을 읽는다)
create table balances_v2 (like balances including all);
-- 2. 프로젝터 v2 가 global_position 0 부터 balances_v2 를 채우고 따라잡는다
-- 3. 지연이 0 에 가까워지면 원자적으로 교체
begin;
alter table balances rename to balances_old;
alter table balances_v2 rename to balances;
commit;
-- 4. 옛 프로젝터 중지, 확인 후 balances_old 삭제
```

| 재구축 함정 | 대책 |
|---|---|
| 재생이 너무 오래 걸린다 | 배치·병렬(스트림 해시로 파티션), 스냅샷형 프로젝션 |
| 재생 중 외부 부작용(메일 발송)이 다시 나간다 | **프로젝터는 부작용이 없어야 한다**. 알림은 별도 "반응기(reactor)" 가 처리 기록을 보고 한 번만 |
| 옛 이벤트 스키마를 못 읽는다 | 업캐스터 ([노트 06](/event-sourcing/notes/06-schema-evolution)) |
| 이벤트 1억 개 × 여러 프로젝션 | 이벤트 테이블 파티셔닝, 콜드 이벤트를 Parquet 로 내려 DuckDB 로 재생([데이터 엔지니어링](/data-engineering)) |

## 결과적 일관성과 "방금 쓴 것 읽기"

명령이 성공한 순간 이벤트는 저장됐지만, 프로젝터가 아직 처리하지 않았다면 목록 화면은 옛 값을 보여 준다. 사용자는 "출금했는데 잔액이 그대로네?" 라고 느낀다.

| 방법 | 설명 |
|---|---|
| 명령 응답에 결과 포함 | 출금 API 가 새 잔액을 바로 돌려준다 (쓰기 모델에서 계산) |
| 버전 대기 | 명령 응답에 `global_position` 을 주고, 읽기 API 가 체크포인트가 그 위치를 넘을 때까지 잠깐 기다림 |
| 클라이언트 낙관적 갱신 | 화면에 먼저 반영하고 나중에 맞춤 |
| 같은 트랜잭션 프로젝션 | 중요한 읽기 모델 하나는 명령 트랜잭션 안에서 바로 갱신 (같은 DB 일 때만) |

프로젝션 지연은 **SLI 로 관측**한다: `now() - (체크포인트 이벤트의 created_at)` 을 메트릭으로 내보내고 p99 가 몇 초를 넘으면 알림. 설정 방법은 [SRE 노트 02](/sre/notes/02-sli-slo-error-budget).

## 하나의 로그, 여러 읽기 모델

같은 이벤트로 목적이 다른 모델을 여럿 만든다. 이것이 CQRS 의 "Q" 쪽 자유다.

| 읽기 모델 | 저장소 | 질의 |
|---|---|---|
| 계좌 잔액 | PostgreSQL | 기본 키 조회 |
| 최근 거래 내역 | Redis List/Stream | 최신 50건 |
| 거래 검색 | OpenSearch | "스타벅스 3만원 이상" 전문 검색 ([OpenSearch 노트 05](/opensearch/notes/05-hybrid-search-rag)) |
| 일별 집계 | ClickHouse | 분석 대시보드 |

각 프로젝터는 자기 체크포인트를 가지므로 하나가 느려도 다른 것은 영향을 받지 않는다.

## 예시로 보기 — 이 프로젝트에서

이 사이트의 주간 학습 요약(첫 화면 "이번 주 학습")은 사실상 **프로젝션**이다. 지금은 하트비트마다 `study:day:<날짜>` 에 초를 바로 더하는 "같은 트랜잭션 프로젝션" 이다. 이것을 이벤트(`StudyHeartbeat`)로 저장했다면 "주 시작을 월요일이 아니라 일요일로" 같은 정의 변경 후 처음부터 재생해 과거 주간 요약을 다시 만들 수 있다.

```bash
pnpm exec tsx scripts/run-code-lab.mts event-sourcing es-projection-rebuild
# 100000 이벤트 · 20 배치 · 185ms … 증분 1000 이벤트 · 6ms
```

## 심화 — 프로젝터를 운영 가능하게

### 체크포인트 테이블과 배치 업서트

```sql
create table projection_checkpoints (
  name        text primary key,          -- 'balances', 'balances_v2'
  position    bigint not null,
  updated_at  timestamptz not null default now()
);

-- 배치 하나: 이벤트를 계좌별로 먼저 접은 뒤(앱에서) 한 번에 업서트
insert into balances (account_id, balance, last_version)
select * from unnest($1::text[], $2::bigint[], $3::int[])
on conflict (account_id) do update
  set balance = balances.balance + excluded.balance,
      last_version = excluded.last_version
  where balances.last_version < excluded.last_version;   -- 이미 반영한 버전이면 무시(멱등)

update projection_checkpoints set position = $4, updated_at = now() where name = 'balances';
```

`where balances.last_version < excluded.last_version` 한 줄이 체크포인트가 어긋났을 때의 두 번째 안전망이다. 같은 배치를 두 번 받아도 잔액이 두 번 더해지지 않는다.

### 한 프로젝션에 프로젝터는 하나만

배포 중 옛 파드와 새 파드가 동시에 같은 프로젝션을 돌리면 같은 배치를 두 번 적용한다. 리더 선출 대신 PostgreSQL 권고 잠금이면 충분하다.

```ts
const { rows } = await c.query("select pg_try_advisory_lock(hashtext('proj:balances')) as ok");
if (!rows[0].ok) { log.info({ projection: "balances" }, "다른 인스턴스가 실행 중 — 대기"); return; }
```

잠금은 연결에 묶이므로, 프로세스가 죽으면 연결이 끊기며 자동으로 풀린다.

### 병렬로 — 스트림 해시 파티션

순서가 필요한 것은 **같은 스트림 안**뿐이다. 스트림을 해시로 나눠 워커 4개가 각자 체크포인트를 가지면 재구축이 대략 그만큼 빨라진다(DB 가 병목이 아닐 때).

```sql
select … from events
where global_position > $1 and abs(hashtext(stream_id)) % 4 = $2
order by global_position limit 5000;
-- 체크포인트 이름: 'balances#0' … 'balances#3'
```

대가: 파티션 사이 순서는 보장되지 않는다. "계좌 A → B 이체" 처럼 두 스트림을 함께 보는 읽기 모델은 잠깐 A 만 반영된 상태를 보일 수 있다.

### 독약 이벤트 — 한 건이 전체를 멈출 때

`apply` 가 특정 이벤트에서 계속 예외를 던지면 프로젝터는 그 자리에서 무한 재시도하고 지연이 끝없이 커진다.

| 전략 | 장점 | 단점 |
|---|---|---|
| 멈추고 알림 | 읽기 모델이 틀리지 않는다 | 고칠 때까지 지연 증가 |
| 건너뛰고 `projection_dead_letters` 에 기록 | 나머지는 최신 유지 | 해당 집합의 읽기 모델이 틀린 채 남는다 |

돈·재고처럼 틀리면 안 되는 모델은 **멈춤**, 검색 인덱스처럼 일부 누락이 허용되는 모델은 **건너뛰기**가 보통이다.

## 모니터링 — 지연을 두 가지로 재라

```ts
const lagSeconds = new Gauge({ name: "projection_lag_seconds", help: "체크포인트 이벤트 이후 경과", labelNames: ["projection"] });
const lagEvents  = new Gauge({ name: "projection_lag_events",  help: "head − checkpoint",            labelNames: ["projection"] });
// 주기적으로: head = max(global_position), cp = checkpoint
lagEvents.set({ projection: "balances" }, head - cp);
lagSeconds.set({ projection: "balances" }, head === cp ? 0 : (Date.now() - cpEventCreatedAt) / 1000);
```

`head === cp` 일 때 0 으로 두는 것이 중요하다. 그러지 않으면 밤새 새 이벤트가 없을 때 "지연 8시간" 경보가 울린다.

```
# PromQL 알림: 5분 이상 5초 넘게 뒤처짐
max by (projection) (projection_lag_seconds) > 5
# 진행이 멈췄는지 (지연 이벤트 수가 줄지 않음)
delta(projection_lag_events[10m]) >= 0 and projection_lag_events > 0
```

| 그래프 모양 | 의심할 것 |
|---|---|
| lag_events 가 직선으로 증가 | 프로젝터 정지 — 독약 이벤트, 잠금 대기, 프로세스 다운 |
| 배포 직후 큰 봉우리 후 감소 | 재구축 따라잡기 (정상, 미리 공지) |
| 낮에만 출렁임 | 처리량 부족 → 배치 크기·병렬도 |
| lag_seconds 만 크고 lag_events 는 작음 | 이벤트가 드문데 하나가 오래 걸림 → 느린 apply |

배치마다 `{projection, from, to, count, ms}` 구조화 로그를 남기면, 지연 경보가 울렸을 때 "어느 위치에서 멈췄는지" 가 로그 한 줄로 나온다. 경보 설계는 [관측성 노트 04](/observability/notes/04-grafana-alerting).

## 흔한 실수와 오해

- **프로젝터 안에서 `now()` 를 쓴다**: 재생할 때마다 결과가 바뀐다. 시간은 이벤트의 `occurred_at` 에서 가져온다.
- **프로젝터가 다른 읽기 모델을 조회한다**: 그 모델의 진행 위치에 따라 결과가 달라진다. 필요한 값은 이벤트에서 직접 접어 자기 모델에 둔다.
- **읽기 모델로 쓰기 결정을 내린다**: 프로젝션은 뒤처질 수 있다. "잔액이 충분한가" 는 집합(쓰기 모델)에서 판단한다.
- **재구축 시간을 모른다**: 장애로 읽기 모델을 날렸을 때 복구 시간(RTO)이 곧 재구축 시간이다. 실험처럼 10만 개 202ms 라면 1억 개는 몇 분 — 숫자로 알고 있어야 한다.

## 스스로 점검

1. 같은 배치가 두 번 적용돼도 결과가 같게 하는 방법 두 가지는? — 체크포인트를 같은 트랜잭션에 저장, 읽기 모델에 `last_version` 을 두고 더 큰 버전만 반영.
2. 프로젝션 지연 메트릭이 새벽에 계속 올라간다. 정말 장애인가? — 새 이벤트가 없어서 시간 기반 지연이 커지는 착시일 수 있다. head 와 체크포인트가 같으면 0 으로 보고해야 한다.
3. 프로젝터를 병렬화할 때 무엇을 기준으로 나누나? — 스트림 ID 해시. 스트림 안 순서만 지키면 된다.
4. 독약 이벤트를 만났을 때 멈출지 건너뛸지는 무엇으로 정하나? — 틀린 읽기 모델의 비용(돈·재고는 멈춤, 검색은 건너뛰고 기록).

## 실습 체크리스트

- [ ] 실험 es-projection-rebuild 를 돌리고 배치 크기를 500·50,000 으로 바꿨을 때 시간 변화를 예상해 보기
- [ ] 체크포인트를 트랜잭션 밖에서 저장하면 어떤 순서로 죽었을 때 잔액이 두 번 더해지는지 그려 보기
- [ ] 프로젝션 지연을 Prometheus 메트릭으로 내보내는 코드 스케치하기
- [ ] 같은 이벤트로 만들 수 있는 읽기 모델 세 개를 저장소와 함께 적기
