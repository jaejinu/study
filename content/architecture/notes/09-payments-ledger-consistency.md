---
title: "결제와 원장 — 멱등 키, 이중 기입, 정산·대사, 정확히 한 번의 실체, 사가와 보상"
order: 9
level: 심화
summary: "돈이 오가는 시스템의 정합성 설계. 외부 결제 대행사(PG) 호출의 타임아웃이 왜 가장 어려운 문제인지(성공인지 실패인지 모른다), 멱등 키의 저장·만료·동시성 처리, 이중 기입 원장(차변·대변·잔액은 파생값)과 불변 기록, 결제 상태 머신, 정산과 대사(reconciliation)로 '우리 장부와 PG 장부' 를 맞추는 법, 정확히 한 번이 실제로는 '최소 한 번 + 멱등' 인 이유, 주문·결제·재고 사가와 보상, 금액 표현(정수·통화), 감사와 규제"
tags: [결제, 원장, 이중 기입, 멱등 키, 정산, 대사, 정확히 한 번, 사가, 보상 트랜잭션, 상태 머신]
experiments: [lua-atomic, transaction-multi, pg-transaction-isolation, cdc-outbox-debezium]
---

결제 시스템의 요구 사항은 단순하다: **돈이 사라지거나 두 번 빠져나가지 않는다.** 이 단순한 요구를 분산 시스템에서 지키는 것이 어려운 이유는, 돈의 일부가 **우리가 통제하지 못하는 시스템**(카드사·PG·은행)에 있고 그 시스템과의 통신이 실패할 수 있기 때문이다.

## 가장 어려운 문제: 타임아웃의 의미

```
우리 → PG: "10만 원 승인해 줘"   ──── 5초 ────▶ 타임아웃
```

이때 결제는 **승인됐는가?** 모른다. 세 가능성:

1. 요청이 PG 에 안 닿았다 → 미승인
2. PG 가 처리했지만 응답이 유실됐다 → **승인됨**
3. PG 가 아직 처리 중이다 → 곧 승인될 수도

"실패로 간주하고 재시도" 하면 2·3번에서 **이중 결제**. "실패로 간주하고 포기" 하면 2번에서 **돈은 빠졌는데 주문이 없음**. 정답은 둘 다 아니다: **결과를 모른다는 상태(PENDING/UNKNOWN)를 명시적으로 두고, 확인한다.**

```
타임아웃 → 결제 상태 UNKNOWN → PG 조회 API (멱등 키·주문번호로) 로 확인
                              → 조회도 실패하면 백그라운드 재조회 (지수 백오프)
                              → 최종적으로는 일일 대사가 잡는다
```

이 원칙이 이 노트 전체를 관통한다: **분산 결제에서 "모른다" 는 정상 상태이고, 시스템은 그것을 표현하고 해소해야 한다.**

## 멱등 키 — 재시도를 안전하게

클라이언트가 요청마다 고유 키를 만들고, 서버는 같은 키의 두 번째 요청에 **처리하지 않고 첫 번째 결과를 돌려준다**. Stripe·Toss 등 모든 결제 API 가 `Idempotency-Key` 헤더를 받는다.

```sql
create table idempotency_keys (
  key text primary key,
  request_hash text not null,         -- 같은 키로 다른 요청이 오면 거부
  status text not null,               -- processing | done
  response jsonb,
  created_at timestamptz default now()
);
```

```ts
async function charge(key: string, req: ChargeRequest) {
  // 1. 키 선점 (원자적) — 동시에 같은 키 두 요청이 와도 하나만 진행
  const inserted = await db.query(
    "insert into idempotency_keys (key, request_hash, status) values ($1, $2, 'processing') on conflict do nothing returning key",
    [key, hash(req)]);
  if (inserted.rowCount === 0) {
    const row = await db.one("select * from idempotency_keys where key = $1", [key]);
    if (row.request_hash !== hash(req)) throw new Error("422: 같은 키로 다른 요청");
    if (row.status === "processing") throw new Error("409: 처리 중 — 잠시 후 재시도");
    return row.response;                            // 이미 처리됨 → 같은 응답
  }
  // 2. 실제 처리 (PG 호출에도 같은 키를 전달 — 하위도 멱등하게)
  const res = await pg.approve({ ...req, idempotencyKey: key });
  // 3. 결과 저장
  await db.query("update idempotency_keys set status='done', response=$2 where key=$1", [key, res]);
  return res;
}
```

설계 포인트:

- **원자적 선점**이 핵심(`insert ... on conflict do nothing`, Redis 라면 `SET key NX` — [lua-atomic](/redis/lab/lua-atomic)). 조회 후 삽입은 경쟁 조건.
- **요청 해시 비교**: 같은 키로 금액이 다른 요청이 오면 버그거나 공격이다.
- **processing 에서 죽으면?** 키가 영원히 processing 으로 남는다 → 타임아웃(예: 5분) 후 UNKNOWN 으로 보고 PG 조회로 해소.
- **만료**: 24시간~7일. 그보다 늦은 재시도는 새 요청으로 간주.
- **하위 전파**: 우리 서버가 멱등해도 PG 호출이 멱등하지 않으면 소용없다. PG 에 같은 키(또는 주문번호)를 넘긴다.

## 이중 기입 원장 — 잔액은 저장하지 않는다

500년 된 회계 원칙이 분산 시스템에서도 최선이다. 모든 거래는 **두 계정에 같은 금액**을 반대 방향으로 기록하고, 차변 합 = 대변 합이 항상 성립한다.

```sql
create table ledger_entries (
  id bigserial primary key,
  tx_id uuid not null,               -- 한 거래의 분개들을 묶음
  account text not null,             -- 'user:17:wallet', 'merchant:3:payable', 'pg:clearing', 'fee:revenue'
  amount bigint not null,            -- 원 단위 정수, 차변 +, 대변 -
  currency char(3) not null,
  created_at timestamptz not null default now()
);
-- 거래 단위 균형 강제 (지연 제약 트리거 또는 삽입 함수에서 검증)
-- 잔액 = 파생값
select account, sum(amount) from ledger_entries where account = 'user:17:wallet' group by account;
```

10만 원 결제(수수료 3%) 한 건의 분개:

| account | amount | 의미 |
|---|---|---|
| `pg:clearing` | +100,000 | PG 에서 받을 돈 |
| `merchant:3:payable` | −97,000 | 가맹점에 줄 돈 |
| `fee:revenue` | −3,000 | 우리 수수료 수익 |
| **합** | **0** | 균형 |

왜 이렇게 하나:

- **불변(append-only)**: 행을 수정·삭제하지 않는다. 틀렸으면 **반대 분개**(reversal)를 추가한다. 감사 추적이 공짜.
- **잔액은 파생값**: `balance` 열을 업데이트하면 동시 업데이트 경쟁·불일치가 생긴다. 합계로 구하고, 성능이 필요하면 **스냅샷**(일 마감 잔액) + 이후 분개 합.
- **균형 검사가 버그 탐지기**: 어느 거래든 합이 0 이 아니면 버그다. 매일 전체 합 = 0 을 검사한다.
- **잔액 부족 검사**는 원장 쓰기와 **같은 트랜잭션**에서 직렬화 — `select ... for update` 로 계정 행을 잠그거나 SERIALIZABLE([pg-transaction-isolation](/postgres/lab/pg-transaction-isolation), [PG MVCC](/postgres/notes/03-mvcc-isolation)).

### 금액 표현

- **부동소수점 금지.** `0.1 + 0.2 ≠ 0.3`. 최소 단위 **정수**(원, 센트)로 저장한다. 통화마다 소수 자릿수가 다르다(KRW 0, USD 2, BHD 3).
- 금액과 **통화**는 항상 쌍. 환전은 별도 분개(환전 계정)로.
- 반올림 규칙을 명시하고(은행가 반올림 등) 분할 시 나머지 처리(1,000원을 3명에게: 334·333·333).

## 결제 상태 머신

```
CREATED ──승인 요청──▶ PENDING ──성공──▶ APPROVED ──매입──▶ CAPTURED ──정산──▶ SETTLED
                         │                  │                    │
                         ├─실패─▶ FAILED     └─취소─▶ CANCELED     └─환불─▶ REFUNDED (부분 가능)
                         └─타임아웃─▶ UNKNOWN ──조회──▶ (APPROVED | FAILED)
```

- 전이는 **허용 목록**으로만(`APPROVED → FAILED` 는 불가). DB 에선 `update ... where status = 'PENDING'` 조건부 업데이트로 경쟁을 막는다(낙관적 동시성).
- 상태 전이마다 **이벤트**를 남기고(outbox), 원장 분개는 상태 전이와 **같은 트랜잭션**.
- 승인(authorize)과 매입(capture)의 분리: 승인은 한도를 잡아 두고, 매입이 실제 청구. 배송 후 매입하는 커머스에서 흔하다.

## 정확히 한 번 — 실체는 "최소 한 번 + 멱등"

"정확히 한 번 결제" 는 네트워크 위에서 **불가능**하다(두 장군 문제). 가능한 것은:

> **최소 한 번 전달** (재시도·재전송으로 유실 없음) **+ 멱등 처리** (중복은 효과 없음) **= 효과상 정확히 한 번**

이 조합이 모든 층에 있어야 한다:

| 층 | 최소 한 번 | 멱등 |
|---|---|---|
| 클라이언트 → API | 재시도 | Idempotency-Key |
| API → PG | 재시도 / 조회 | PG 측 주문번호 중복 거부 |
| 이벤트 발행 | outbox + CDC([Kafka 08](/kafka/notes/08-cdc-outbox-debezium)) | 이벤트 ID |
| 이벤트 소비 | 오프셋 커밋은 처리 후 | `processed_events` 테이블 |
| PG 웹훅 수신 | PG 가 재전송 | 웹훅 이벤트 ID 저장 |

Kafka 의 "exactly-once semantics" 도 **Kafka 내부**(읽기-처리-쓰기가 모두 Kafka 일 때)에 한정된다. 외부 DB·PG 가 끼면 다시 멱등 소비자가 필요하다([Kafka 04](/kafka/notes/04-delivery-guarantees)).

## 사가와 보상 — 주문·결제·재고

여러 서비스에 걸친 작업은 분산 트랜잭션(2PC) 대신 **사가**: 단계마다 로컬 트랜잭션을 커밋하고, 뒤에서 실패하면 앞 단계를 **보상**한다([아키텍처 03](/architecture/notes/03-async-messaging-consistency), [분산 06](/distributed-systems/notes/06-transactions-coordination)).

```
1. 재고 예약        ← 보상: 예약 해제
2. 결제 승인        ← 보상: 승인 취소 (매입 전) / 환불 (매입 후)
3. 주문 확정        ← (마지막 단계 — 피벗, 이후는 실패하면 안 됨)
4. 배송 요청        ← 재시도로 반드시 성공시킴
```

규칙:

- **보상은 되돌리기가 아니다.** 환불은 결제를 "없던 일" 로 만들지 않고 새 거래를 추가한다(원장에 반대 분개). 사용자는 두 건을 본다.
- 보상도 **실패할 수 있다** → 보상도 멱등·재시도 가능해야 하고, 최종적으로 사람이 처리하는 큐(수동 개입)로.
- **피벗 지점**: 되돌릴 수 없는 단계(돈이 나간 뒤 외부 발송) 이후는 앞으로만 간다(forward recovery).
- 오케스트레이션(중앙 조정자, 상태가 한 곳에 보임) 이 결제처럼 감사가 중요한 흐름엔 코레오그래피(이벤트 연쇄)보다 낫다. Temporal·Step Functions 같은 워크플로 엔진이 이것을 내구성 있게 실행한다.

## 정산과 대사 — 우리 장부 vs 그들의 장부

아무리 잘 설계해도 우리 기록과 PG 기록은 **어긋난다**(타임아웃 UNKNOWN, 웹훅 유실, PG 의 수동 처리, 부분 환불). 그래서 매일 **대사**(reconciliation)한다.

```
PG 정산 파일 (어제 거래 목록, CSV/SFTP)    우리 원장 (어제 pg:clearing 분개)
              └──────── 주문번호로 조인 ────────┘
  일치                     → 확정
  PG 에만 있음             → 우리가 놓친 승인 (UNKNOWN 이 실제론 승인) → 분개 추가 + 주문 처리 또는 취소
  우리에만 있음            → PG 가 거절/취소 (우리는 승인으로 앎) → 반대 분개 + 고객 연락
  금액 불일치              → 부분 환불·수수료 차이 → 조사 큐
```

- 대사 불일치 건수와 금액은 **핵심 지표**다. 0 이 아니면 알림.
- 대사는 원장이 불변이어서 가능하다. 잔액만 있는 시스템은 "어디서 틀렸는지" 를 못 찾는다.
- 정산 시점(T+1, T+2)과 가맹점 지급(payout)은 또 다른 원장 흐름이다.

## 감사와 규제

- 모든 상태 전이·분개에 **누가·언제·왜**(사용자, 시스템, 요청 ID, 트레이스 ID). 운영자의 수동 조정은 별도 계정과 승인 절차.
- 카드 정보는 저장하지 않는다 — PG 의 **토큰**만(PCI DSS 범위 축소). 로그에 카드 번호가 찍히지 않게 마스킹([보안 08](/security/notes/08-web-api-llm-security)).
- 원장 DB 는 PITR 백업과 장기 보존(법정 보존 기간 5년 등).

## 예시로 보기 — 이 사이트의 실험으로 증명하는 조각들

| 조각 | 증거 실험 |
|---|---|
| 멱등 키 원자적 선점 | [lua-atomic](/redis/lab/lua-atomic) (Lua 로 확인+쓰기 원자화), `SET NX` |
| 잔액 차감 경쟁 | [transaction-multi](/redis/lab/transaction-multi), [watch-optimistic-lock](/redis/lab/watch-optimistic-lock) |
| 격리 수준과 이상 현상 | [pg-transaction-isolation](/postgres/lab/pg-transaction-isolation) |
| 이벤트 발행 정합성 | [cdc-outbox-debezium](/kafka/lab/cdc-outbox-debezium) |
| 펜싱(오래된 작업자의 쓰기 거부) | [ds-fencing-token](/distributed-systems/lab/ds-fencing-token) |
| 재시도 안전성 | [chaos-retry-storm](/chaos/lab/chaos-retry-storm) |

## 실전에서는 어디에 쓰이나

> 멱등 키·이중 기입 원장·대사는 돈·포인트·재화처럼 "사라지거나 두 번 빠지면 안 되는 값" 을 다루는 순간 등장한다. 결제사만의 이야기가 아니다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 결제 연동 | PG 타임아웃 뒤 재시도로 이중 결제 | UNKNOWN 상태 + PG 조회, 같은 멱등 키를 PG 까지 전달 | 실패로 간주하고 재시도 — 이중 결제 |
| 공개 결제 API 제공(예: Stripe API 의 `Idempotency-Key` 헤더) | 클라이언트 재시도를 안전하게 | 키 원자적 선점 + 요청 해시 비교 + 첫 응답 재반환 | 클라이언트에 재시도 금지 요청 — 지켜지지 않는다 |
| 핀테크 지갑·포인트·게임 재화 | 동시 차감으로 잔액 불일치 | 추가 전용 이중 기입 원장, 잔액은 합계 + 스냅샷 | `balance` 열 직접 UPDATE — 경쟁과 추적 불가 |
| 마켓플레이스 정산(판매자 지급) | 우리 장부와 PG 정산 파일의 차이 | 일일 대사 배치, 불일치 건수·금액을 지표로 알림 | 월말 수작업 맞추기 — 원인 추적이 늦다 |
| 구독 SaaS 결제·환불 | 주문·결제·재고에 걸친 실패 처리 | 사가 + 보상(취소·환불을 새 분개로), 피벗 이후는 앞으로만 | 2PC — 외부 PG 는 참여할 수 없다 |

**이럴 땐 안 맞는다**
- 금액을 부동소수점으로 저장·계산 — 오차가 누적된다. 최소 단위 정수 + 통화 코드를 쌍으로 쓴다.
- 감사가 중요한 결제 흐름을 이벤트 연쇄(코레오그래피)만으로 — 상태가 흩어져 추적이 어렵다. 오케스트레이션·워크플로 엔진을 쓴다.

**누가 매일 만나나** — 핀테크·커머스 백엔드 개발자는 PG 연동 코드의 타임아웃·웹훅 처리를 쓸 때, 데이터 엔지니어·정산 담당은 대사 리포트의 불일치를 조사할 때 만난다.

**면접·실무 단골 질문**
- Q. 결제 요청이 타임아웃되면 어떻게 하나 → 성공·실패를 모르는 상태로 두고 PG 조회로 확정, 끝내 모르면 대사가 잡는다.
- Q. 잔액 열을 두지 않는 이유 → 동시 갱신 경쟁과 불일치 추적 불가. 불변 분개의 합으로 구하고 스냅샷으로 성능을 보완한다.

## 실습 체크리스트

- [ ] study PostgreSQL 에 `ledger_entries` 를 만들고 결제·부분 환불을 분개로 기록한 뒤 거래별 합 = 0, 계정별 잔액을 쿼리로 확인
- [ ] 위 `charge()` 의 멱등 키 선점을 같은 키로 동시에 10번 호출해 PG 호출이 1번만 일어나는지 검증
- [ ] 결제 상태 머신의 허용 전이를 표로 쓰고, 조건부 UPDATE 로 `APPROVED → FAILED` 가 막히는지 확인
- [ ] PG 정산 파일과 원장을 조인하는 대사 SQL 을 쓰고 의도적으로 한 건을 어긋나게 만들어 불일치 리포트에 나오는지 보기
