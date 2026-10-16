---
title: "스냅샷과 성능 — 긴 스트림 로딩, 스냅샷 주기, 스트림 설계"
order: 5
level: 중급
summary: "이벤트가 수만 개인 집합의 로딩 비용과 스냅샷(어느 버전에서의 상태 + 꼬리 이벤트)으로 줄이는 방법, 스냅샷 주기·저장 위치·무효화, 스냅샷보다 먼저 볼 것(스트림을 짧게 — 기간별 마감), 이벤트 테이블 인덱스·파티셔닝. 실험에서 2만 이벤트 로딩 12.1ms → 스냅샷 1.1ms, 읽은 행 20,000 → 101"
tags: [스냅샷, 집합 로딩, 성능, 스트림 설계, 파티셔닝]
experiments: [es-projection-rebuild]
---

## 왜 느려지는가

명령 하나를 처리할 때마다 집합의 **모든 이벤트**를 읽어 접는다. 계좌 하나에 10년치 거래 2만 건이 있다면 출금 한 번에 2만 행을 읽는다.

[es-projection-rebuild](/event-sourcing/lab/es-projection-rebuild) 의 실측(뜨거운 집합 hot-1, 이벤트 20,000개, 3회 중앙값):

| 로딩 방식 | 읽은 행 | 시간 |
|---|---|---|
| 스냅샷 없음 | 20,000 | 12.1ms |
| 스냅샷(버전 19,900) + 꼬리 100개 | 101 | 1.1ms |

결과(잔액·버전)는 같았다. 12ms 가 별것 아닌 것 같아도, 이 집합에 초당 100 명령이 오면 로딩만으로 CPU 1.2초/초 — 한 코어를 다 쓴다. 그리고 그 12ms 동안 다른 명령이 같은 스트림에 쓰면 낙관적 동시성 충돌 확률이 커진다. **로딩이 길수록 경합 창이 넓어진다.**

## 스냅샷의 모양

```sql
create table snapshots (
  stream_id text primary key,
  version   int  not null,      -- 이 상태가 어느 버전까지 반영했나
  schema    int  not null,      -- 스냅샷 형식 버전 (집합 코드가 바뀌면 올린다)
  state     jsonb not null,
  taken_at  timestamptz not null default now()
);
```

```ts
async function load(stream: string) {
  const snap = await one("select version, schema, state from snapshots where stream_id = $1", [stream]);
  const usable = snap && snap.schema === CURRENT_SNAPSHOT_SCHEMA;
  let state = usable ? snap.state : initialState();
  const from = usable ? snap.version : 0;
  const tail = await query("select version, type, data from events where stream_id = $1 and version > $2 order by version", [stream, from]);
  for (const e of tail) state = apply(state, upcast(e));
  return { state, version: tail.at(-1)?.version ?? from };
}
```

- 스냅샷은 **캐시**다. 지워도 이벤트로 다시 만든다. 그러니 형식이 바뀌면 고치지 말고 **버린다**(`schema` 불일치 → 무시).
- 스냅샷 쓰기는 명령 처리와 **분리**한다(비동기 워커가 N 이벤트마다). 명령 트랜잭션에 넣으면 쓰기 지연이 늘어난다.

## 언제, 얼마나 자주

| 정책 | 장점 | 단점 |
|---|---|---|
| N 이벤트마다 (예: 100) | 꼬리 길이가 N 이하로 묶임 | 쓰기 증가 |
| 로딩 시간이 임계 넘으면 | 필요한 집합만 | 측정·트리거 코드 |
| 주기적 일괄 | 단순 | 뜨거운 집합이 사이에 길어짐 |

> 스냅샷부터 만들기 전에 질문하자: **스트림이 왜 이렇게 긴가?** 대부분 집합 경계가 너무 길게 살아서다.

## 스냅샷보다 나은 해결 — 스트림을 짧게

**기간 마감(closing the books)**: 회계는 매년 장부를 마감하고 이월 잔액으로 새 장부를 연다. 이벤트 소싱도 같다.

```
account-42-2025 : … 18,000 이벤트 … → AccountClosedForPeriod{balance: 1,203,000}
account-42-2026 : BalanceCarriedForward{balance: 1,203,000} → 새 거래들
```

새 스트림은 짧고, 옛 스트림은 읽기 전용 아카이브가 된다. 업무 언어("연말 결산")와 맞는다는 것이 큰 장점이다.

다른 예: 쇼핑몰의 "상품" 집합이 모든 재고 변동을 담으면 끝없이 길어진다. "입고 배치(lot)" 단위로 스트림을 나누면 각 스트림은 입고~소진까지만 산다. [노트 02](/event-sourcing/notes/02-event-modeling)의 "집합은 작게" 와 같은 원리다.

## 이벤트 테이블 자체의 성능

| 질의 | 필요한 인덱스 |
|---|---|
| 집합 로딩 `where stream_id = $1 and version > $2 order by version` | `unique (stream_id, version)` 가 그대로 쓰인다 |
| 프로젝션 `where global_position > $1 order by global_position limit n` | 기본 키 |
| 타입별 구독 `where type = any($1) and global_position > $2` | `(type, global_position)` |

이벤트가 수십억 개면 `global_position` 범위로 **파티셔닝**하고 오래된 파티션을 저렴한 저장소로 옮긴다. [PostgreSQL 노트 06](/postgres/notes/06-partitioning-scale)의 파티션 프루닝이 프로젝션 체크포인트 질의에 그대로 맞는다. JSONB 페이로드가 크면 TOAST 로 빠지므로, 자주 필터링하는 필드는 열로 승격한다.

| 규모 | 권장 |
|---|---|
| ~수천만 이벤트 | 단일 테이블 + 위 인덱스 |
| 수억 | 범위 파티셔닝, 스냅샷, 프로젝션 배치 최적화 |
| 수십억 | 콜드 이벤트 아카이브(Parquet), 스트림 마감, 전용 스토어 검토 |

## 쓰기 쪽 캐시 — 메모리 안 집합

뜨거운 집합을 서버 메모리에 올려 두고(버전과 함께) 다음 명령에서 꼬리만 읽는 방법도 있다. 여러 서버가 있으면 같은 집합 명령을 **같은 서버로 라우팅**(집합 ID 해시)해야 효과가 있다. Akka·Orleans 의 액터 모델이 이 방식이다. 캐시가 틀려도 expected_version 충돌로 잡히므로 안전하다 — 충돌 나면 캐시를 버리고 다시 읽는다.

## 예시로 보기 — 이 프로젝트에서

실험에서 스냅샷 로딩은 "스냅샷 1행 + 꼬리 100행" 을 읽었다.

```bash
pnpm exec tsx scripts/run-code-lab.mts event-sourcing es-projection-rebuild
# 스냅샷 없음: 이벤트 20000행 읽기 · 12.1ms
# 스냅샷(버전 19900) + 꼬리 100행: 101행 · 1.1ms
```

이 사이트의 퀴즈 기록도 같은 고민을 한다. 카드 하나의 답안 이벤트가 몇 년 쌓여도 "현재 상자·다음 기한" 만 필요하므로, 지금 Redis Hash 에 저장된 `quiz:stats` 가 사실상 **항상 최신인 스냅샷**이다([Redis 노트 18](/redis/notes/18-design-recipes)의 간격 반복 레시피).

## 실습 체크리스트

- [ ] 실험의 hot-1 을 이벤트 20만 개로 늘리면 로딩 시간이 어떻게 될지 예상하고 확인하기
- [ ] 스냅샷 schema 가 바뀐 상황에서 load() 가 스냅샷을 무시하고 전부 재생하는지 코드로 보이기
- [ ] 내가 아는 도메인에서 "기간 마감" 으로 스트림을 끊을 수 있는 곳 찾기
- [ ] 이벤트 테이블에 `(type, global_position)` 인덱스가 필요한 질의를 EXPLAIN 으로 확인하기
