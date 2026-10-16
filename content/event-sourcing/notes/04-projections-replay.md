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

## 실습 체크리스트

- [ ] 실험 es-projection-rebuild 를 돌리고 배치 크기를 500·50,000 으로 바꿨을 때 시간 변화를 예상해 보기
- [ ] 체크포인트를 트랜잭션 밖에서 저장하면 어떤 순서로 죽었을 때 잔액이 두 번 더해지는지 그려 보기
- [ ] 프로젝션 지연을 Prometheus 메트릭으로 내보내는 코드 스케치하기
- [ ] 같은 이벤트로 만들 수 있는 읽기 모델 세 개를 저장소와 함께 적기
