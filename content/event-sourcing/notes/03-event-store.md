---
title: "이벤트 스토어 — PostgreSQL append-only, 스트림·버전, 낙관적 동시성, 전역 순서"
order: 3
level: 중급
summary: "PostgreSQL 테이블 하나로 이벤트 스토어를 만드는 법: 스키마, unique(stream_id, version) 로 expected_version 검사, 충돌 재시도, 전역 위치(global_position)와 '빈 번호' 문제, 구독(폴링·LISTEN/NOTIFY·CDC), EventStoreDB·Kafka 와의 비교. 실험에서 동시 출금 20건이 정확히 10건만 성공하는 과정을 숫자로 본다"
tags: [이벤트 스토어, 낙관적 동시성, expected_version, PostgreSQL, 전역 순서, 구독]
experiments: [es-optimistic-concurrency, es-upcasting]
---

## 최소 스키마

```sql
create table events (
  global_position bigserial primary key,   -- 전체 순서 (프로젝션 체크포인트)
  stream_id       text not null,           -- 집합 ID: 'account-42'
  version         int  not null,           -- 스트림 안 순번 1, 2, 3 …
  type            text not null,           -- 'MoneyDeposited'
  schema          int  not null default 1, -- 데이터 스키마 버전
  data            jsonb not null,
  metadata        jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  unique (stream_id, version)              -- ★ 낙관적 동시성의 전부
);
create index on events (type, global_position);   -- 타입별 구독용 (선택)
```

| 열 | 왜 필요한가 |
|---|---|
| `global_position` | 프로젝션이 "어디까지 처리했나" 를 기억하는 체크포인트 ([노트 04](/event-sourcing/notes/04-projections-replay)) |
| `stream_id, version` | 집합 로딩(`where stream_id = $1 order by version`)과 동시성 검사 |
| `unique (stream_id, version)` | 같은 버전을 두 번 쓰지 못하게 → expected_version 검사 |
| `schema` | 읽을 때 업캐스터 선택 ([노트 06](/event-sourcing/notes/06-schema-evolution)) |

**append-only** 를 권한으로 강제하자. 앱 역할에는 `INSERT, SELECT` 만 주고 `UPDATE, DELETE` 는 주지 않는다. 사람 실수로 이벤트가 바뀌면 모든 프로젝션의 근거가 무너진다.

```sql
revoke update, delete on events from app_role;
```

## 낙관적 동시성 — expected_version

명령 처리기는 스트림을 읽을 때 본 **마지막 버전**을 기억했다가, 새 이벤트를 `version + 1` 로 넣는다. 그 사이 다른 명령이 먼저 `version + 1` 을 썼다면 유일 제약이 `23505 unique_violation` 으로 거부한다.

```ts
async function append(c, stream, expectedVersion, events) {
  let v = expectedVersion;
  try {
    await c.query("begin");
    for (const e of events) {
      v += 1;
      await c.query(
        "insert into events (stream_id, version, type, schema, data, metadata) values ($1,$2,$3,$4,$5,$6)",
        [stream, v, e.type, e.schema, e.data, e.metadata],
      );
    }
    await c.query("commit");
  } catch (err) {
    await c.query("rollback");
    if (err.code === "23505") throw new ConcurrencyError(stream, expectedVersion);
    throw err;
  }
}
```

- 한 명령이 이벤트 여러 개를 낼 수 있으니 **트랜잭션**으로 묶는다.
- `ConcurrencyError` 를 받으면 **다시 읽고 다시 결정**한다. 결정 규칙이 같은 결과를 낸다면 재시도는 안전하다.
- 재시도 사이에 지터를 둔다 — 같은 스트림을 노리는 명령들이 다시 동시에 부딪히지 않게.

![낙관적 동시성 타임라인](/diagrams/es-optimistic-concurrency.svg)

### 실측 — 동시 출금 20건

[es-optimistic-concurrency](/event-sourcing/lab/es-optimistic-concurrency) 는 잔액 100 계좌에 10원 출금 명령 20개를 동시에 보낸다(결정 단계에 0~5ms 지연을 넣어 경쟁을 키움).

| 스토어 | 성공 | 잔액 부족 거절 | 충돌 | 재시도 | 최종 잔액 | 중복 버전 |
|---|---|---|---|---|---|---|
| 유일 제약 + 재시도 | 10 | 10 | 0 | 55회 | 0 | 0 |
| 유일 제약, 재시도 없음 | 1 | 0 | 19 | 0 | 90 | 0 |
| 버전 검사 없음 | 20 | 0 | 0 | 0 | **-100** | 19 |

- 재시도가 있으면 **정확히 10건**만 성공하고 나머지 10건은 다시 읽었을 때 잔액 부족으로 정당하게 거절된다.
- 재시도가 없으면 19건이 사용자에게 "다시 시도하세요"(HTTP 409)로 돌아간다. 사용자 경험은 나쁘지만 데이터는 안전하다.
- 버전 검사가 없으면 20건이 모두 "잔액 100" 을 보고 출금한다. 같은 `version 2` 가 20번 기록됐다.

> 왜 행 잠금(`select … for update`)을 안 쓰나? 상태 테이블에서는 그게 정답이다([PostgreSQL 노트 04](/postgres/notes/04-locks-deadlocks)). 이벤트 스토어에는 잠글 "현재 행" 이 없다. 스트림의 다음 버전 자리를 유일 제약으로 선점하는 것이 같은 효과를 낸다. 낙관적 방식은 경합이 드물 때 빠르고, 경합이 잦으면 재시도 비용이 커진다.

## 전역 순서와 "빈 번호" 문제

프로젝션은 `global_position` 순서로 이벤트를 읽는다. 그런데 `bigserial` 은 **트랜잭션 커밋 순서가 아니라 번호를 받은 순서**다.

```
T1: nextval → 101 ……(아직 커밋 안 함)……………………… commit
T2: nextval → 102 → commit
프로젝션: "102 까지 처리" 를 기록 → 나중에 101 이 커밋되면 영영 건너뜀!
```

해결책:

| 방법 | 설명 |
|---|---|
| 지연 읽기 | `created_at < now() - interval '1 second'` 인 것만 처리(경험적, 긴 트랜잭션엔 불완전) |
| 트랜잭션 ID 기준 | `pg_current_xact_id()` 를 저장하고 `pg_snapshot_xmin(pg_current_snapshot())` 보다 작은 것만 처리 — 진행 중 트랜잭션 이전까지만 안전하게 |
| 단일 작성자 | 쓰기를 한 프로세스로 직렬화(처리량 제한) |
| CDC 구독 | WAL 의 커밋 순서대로 받는다 — [Debezium](/kafka/notes/08-cdc-outbox-debezium) |

작은 시스템이라면 "1초 지연 + 체크포인트 겹쳐 읽기 + 멱등 프로젝션" 으로 충분하다. 핵심은 **프로젝션이 같은 이벤트를 두 번 받아도 결과가 같게**(멱등) 만드는 것이다. MVCC 가시성 규칙 자체는 [PostgreSQL 노트 03](/postgres/notes/03-mvcc-isolation)에 있다.

## 구독 — 새 이벤트를 어떻게 알까

| 방식 | 지연 | 비고 |
|---|---|---|
| 폴링 (`where global_position > $cp limit 500`) | 폴링 간격 | 가장 단순, 대부분 이걸로 충분 |
| `LISTEN/NOTIFY` | ms | 알림으로 깨우고 실제 데이터는 폴링으로 읽기. 연결이 끊기면 알림 유실 → 폴링과 병행 |
| CDC(논리 복제) | ms | 커밋 순서 보장, 외부 시스템(Kafka)으로 발행까지 |
| 전용 스토어 구독 | ms | EventStoreDB 의 catch-up/persistent 구독 |

## 무엇으로 만들까

| 선택지 | 장점 | 단점 |
|---|---|---|
| PostgreSQL 테이블 | 이미 있다, 트랜잭션·SQL·백업, 프로젝션과 같은 DB 면 한 트랜잭션으로 갱신 | 전역 순서 문제, 수십억 이벤트면 파티셔닝 필요 |
| EventStoreDB / Kurrent | 스트림·구독·프로젝션이 1급 | 운영할 시스템이 하나 늘어난다 |
| Kafka | 발행·재처리·대용량 | 스트림(집합)별 expected_version 검사가 어렵다 → 스토어로는 부적합, 발행 채널로 |
| DynamoDB 등 | 조건부 쓰기로 낙관적 동시성 | 전역 순서는 스트림 기능(DynamoDB Streams)에 의존 |

## 예시로 보기 — 이 프로젝트에서

이 실험실의 이벤트 스토어 테이블은 실험마다 `lab_es_…_events` 로 만들고 끝나면 지운다. 직접 돌려 보려면:

```bash
pnpm pg:up
docker exec -it study-postgres psql -U study -c "
create table events (global_position bigserial primary key, stream_id text, version int, type text, data jsonb, unique (stream_id, version));
insert into events (stream_id, version, type, data) values ('acc-1', 1, 'MoneyDeposited', '{\"amount\":100}');
insert into events (stream_id, version, type, data) values ('acc-1', 1, 'MoneyWithdrawn', '{\"amount\":10}');"
# ERROR:  duplicate key value violates unique constraint "events_stream_id_version_key"  ← 이것이 충돌 신호
```

같은 원리가 이 저장소의 다른 곳에도 있다. Redis 의 `WATCH`/`MULTI` 낙관적 잠금([Redis 노트 05](/redis/notes/05-transactions-lua)), 그리고 멱등 키 실험 [api-idempotency-key](/api-design/lab/api-idempotency-key) 는 "먼저 자리를 차지한 쪽이 이긴다" 는 같은 모양의 동시성 제어다.

## 심화 — 스토어를 운영 수준으로

### append 를 한 번의 왕복으로

명령마다 `begin → insert × N → commit` 왕복이 여러 번이면 경합 창(w)이 넓어진다. 서버 함수로 묶으면 왕복이 1번이 된다.

```sql
create or replace function append_events(p_stream text, p_expected int, p_events jsonb)
returns bigint language plpgsql as $$
declare
  cur int;
  e jsonb;
  pos bigint;
begin
  select coalesce(max(version), 0) into cur from events where stream_id = p_stream;
  if p_expected >= 0 and cur <> p_expected then
    raise exception 'wrong expected version: % (actual %)', p_expected, cur using errcode = 'P0001';
  end if;
  for e in select * from jsonb_array_elements(p_events) loop
    cur := cur + 1;
    insert into events (stream_id, version, type, schema, data, metadata)
    values (p_stream, cur, e->>'type', (e->>'schema')::int, e->'data', e->'metadata')
    returning global_position into pos;
  end loop;
  return pos;   -- 마지막 global_position: '방금 쓴 것 읽기' 대기에 쓴다
end $$;
```

먼저 `max(version)` 을 확인하는 것은 빠른 실패용이고, 동시에 두 개가 통과해도 **최종 방어는 여전히 유일 제약**이다. `p_expected` 의 관례(EventStoreDB 와 비슷하게):

| 값 | 의미 |
|---|---|
| `0` | 스트림이 없어야 한다 (새 집합 생성 — 같은 주문 ID 로 두 번 생성 방지) |
| `n > 0` | 마지막 버전이 정확히 n 이어야 한다 |
| `-1` | 검사 안 함 (감사 로그처럼 순서만 중요한 스트림) |

### 재시도 — 한도와 지터

```ts
async function handle(cmd, maxAttempts = 5) {
  for (let i = 1; ; i++) {
    const { state, version } = await load(cmd.stream);
    const events = decide(state, cmd);                 // 순수 함수: 같은 입력 → 같은 결정
    try { return await append(cmd.stream, version, events); }
    catch (e) {
      if (!(e instanceof ConcurrencyError) || i >= maxAttempts) throw e;
      metrics.conflicts.inc({ aggregate: cmd.aggregate });
      await sleep(Math.random() * 2 ** i * 5);         // 0~10ms, 0~20ms, … 전체 지터
    }
  }
}
```

재시도 소진은 HTTP 409 로 돌려준다. 500 이 아니다 — 서버 고장이 아니라 "다른 변경이 먼저 왔다" 는 정상 신호다.

### "빈 번호" 를 안전하게 — 트랜잭션 ID 로 읽기

```sql
alter table events add column tx_id xid8 not null default pg_current_xact_id();
create index on events (tx_id, global_position);

-- 체크포인트를 (tx_id, global_position) 쌍으로 저장하고, 아직 진행 중일 수 있는 트랜잭션은 제외
select * from events
where (tx_id, global_position) > ($1::xid8, $2::bigint)
  and tx_id < pg_snapshot_xmin(pg_current_snapshot())
order by tx_id, global_position
limit 500;
```

`global_position` 하나로 정렬하면 "작은 번호를 늦게 커밋" 한 이벤트를 놓칠 수 있다. **트랜잭션 ID 순서**로 읽고 "모든 진행 중 트랜잭션보다 앞선 것" 만 처리하면 빈 번호를 건너뛰지 않는다. 대가: 긴 트랜잭션 하나가 xmin 을 붙잡으면 **모든 구독이 그 지점에서 멈춘다**.

### 알림으로 깨우기

```sql
create function notify_event() returns trigger language plpgsql as $$
begin perform pg_notify('events', new.global_position::text); return null; end $$;
create trigger events_notify after insert on events for each statement execute function notify_event();
```

`for each statement` 로 배치 insert 에 알림 한 번. 알림은 "깨우기" 용이고 데이터는 위 질의로 읽는다.

## 모니터링 — 스토어에서 볼 것

| 신호 | 수집 | 장애 때 모습 |
|---|---|---|
| append 지연 p99 | 앱 히스토그램 | 디스크·락 문제면 전 스트림에서 함께 오른다 |
| 충돌률 (23505 / append) | 앱 카운터, 집합 종류별 | 특정 집합만 오르면 뜨거운 스트림 → 경계 재검토 |
| 재시도 소진(409) 수 | 앱 카운터 | 사용자 체감 오류. SLO 대상 |
| 가장 오래된 트랜잭션 나이 | `pg_stat_activity` | tx_id 방식 구독 전체 정지의 원인 |
| 이벤트 테이블 증가량 | `pg_stat_user_tables.n_tup_ins`, `pg_total_relation_size` | 파티셔닝·아카이브 계획 |

```sql
-- 구독을 멈추게 하는 긴 트랜잭션 찾기
select pid, now() - xact_start as age, state, left(query, 80)
from pg_stat_activity where xact_start is not null order by xact_start limit 5;
```

로그 수준도 정하자. 충돌은 정상 흐름이므로 매번 WARN 을 찍으면 로그가 폭주하고 진짜 경고가 묻힌다. 충돌은 **메트릭 + DEBUG**, 재시도 소진만 WARN, `stream_id`·`expected`·`actual` 버전을 필드로 남긴다. PostgreSQL 쪽 운영 지표는 [PostgreSQL 노트 05](/postgres/notes/05-operations).

## 흔한 실수와 오해

- **버전을 `max(version)+1` 로 계산하고 유일 제약은 없음**: 동시에 두 명령이 같은 번호를 계산한다. 계산은 해도 되지만 제약이 없으면 무의미하다.
- **이벤트 저장 후 Kafka 에 따로 발행(이중 쓰기)**: 둘 중 하나만 성공하는 순간이 생긴다. 이벤트 테이블 자체를 아웃박스로 보고 CDC·폴링으로 발행한다([Kafka 노트 08](/kafka/notes/08-cdc-outbox-debezium)).
- **global_position 은 빈틈없이 연속이다**: 롤백된 트랜잭션이 받은 시퀀스 번호는 돌아오지 않는다. 빈 번호는 영원히 빌 수 있다 — "다음 번호가 올 때까지 기다림" 은 무한 대기가 된다.
- **충돌을 500 으로 응답**: 클라이언트가 무작정 재시도하고 오류율 SLO 가 망가진다.

## 스스로 점검

1. 유일 제약 `(stream_id, version)` 하나로 낙관적 동시성이 되는 원리는? — 다음 버전 "자리" 를 먼저 차지한 쪽만 insert 에 성공하고, 늦은 쪽은 23505 를 받아 다시 읽는다.
2. 새 주문 생성 시 expected_version 을 0 으로 주는 이유는? — 같은 ID 로 스트림이 이미 있으면 실패시켜 중복 생성을 막는다.
3. tx_id 기반 구독에서 프로젝션이 갑자기 전부 멈췄다. 가장 먼저 볼 것은? — `pg_stat_activity` 의 오래된 트랜잭션(유휴 상태의 열린 트랜잭션 포함).
4. 이벤트 스토어로 PostgreSQL 대신 Kafka 를 쓰자는 제안에 무엇을 묻나? — 스트림별 expected_version 검사, 집합 하나 로딩(키로 조회) 방법.

## 실전에서는 어디에 쓰이나

> 이벤트 소싱을 실제로 구현하는 첫날, "이벤트를 어디에 어떤 규칙으로 저장하고 동시 변경을 어떻게 막나" 를 정할 때 등장한다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 핀테크 지갑·포인트 | 동시 출금으로 잔액이 음수가 되는 것 방지 | `unique(stream_id, version)` + 지터 재시도, 소진 시 409 | 상태 테이블 행 잠금 — 이력은 따로 |
| 커머스 주문 생성 | 같은 주문 ID 중복 생성 방지 | expected_version 0 으로 새 스트림 생성 | 존재 확인 후 insert — 경쟁 조건 |
| 이벤트 기반 SaaS | 프로젝션이 이벤트를 빠뜨리지 않게 | tx_id + global_position 체크포인트, 또는 CDC 구독 | `bigserial` 순서만 — 빈 번호로 누락 |
| 규제 산업 감사 로그 | 저장된 이벤트 변조 방지 | 앱 역할에 INSERT·SELECT 만, UPDATE·DELETE 회수 | 앱 규칙에만 의존 |
| 이벤트를 다른 서비스로 발행 | 저장과 발행의 불일치 방지 | 이벤트 테이블을 아웃박스로 보고 폴링·CDC 발행 | 저장 후 브로커에 이중 쓰기 |

**이럴 땐 안 맞는다**
- Kafka 를 이벤트 스토어로 쓰는 것 — 스트림별 expected_version 검사와 집합 하나 로딩이 어렵다. 발행 채널로만 쓴다.
- 한 스트림에 초당 수천 명령이 몰리는데 낙관적 동시성만 믿는 것 — 재시도가 폭주한다. 집합 경계부터 다시 나눈다.

**누가 매일 만나나** — 백엔드가 명령 처리기와 append 함수를 쓸 때, DBA·SRE 가 오래 열린 트랜잭션 때문에 구독이 전부 멈춘 장애를 볼 때.

**면접·실무 단골 질문**
- Q. 유일 제약 하나로 낙관적 동시성이 되는 원리는? → 다음 버전 자리를 먼저 차지한 쪽만 insert 에 성공하고, 늦은 쪽은 23505 를 받아 다시 읽고 다시 결정한다.
- Q. 동시성 충돌을 500 이 아니라 409 로 돌려주는 이유는? → 서버 고장이 아니라 "다른 변경이 먼저 왔다" 는 정상 신호이기 때문이다.

## 실습 체크리스트

- [ ] 위 psql 예시로 같은 버전을 두 번 넣어 23505 를 직접 받아 보기
- [ ] 실험 es-optimistic-concurrency 의 재시도 횟수가 결정 지연(0~5ms)을 늘리면 어떻게 바뀔지 예상하고 코드로 확인하기
- [ ] 앱 역할에서 UPDATE·DELETE 권한을 빼는 SQL 작성하기
- [ ] "빈 번호" 문제가 실제로 생기는 두 트랜잭션 순서를 psql 두 창으로 재현하기
