---
title: "사례 — 결제·주문: 멱등, 원장, 사가, 외부 PG 와의 정합성"
order: 6
level: 심화
summary: "돈이 오가는 시스템의 설계 원칙: 모든 쓰기 API 의 멱등 키, 상태 머신으로 주문 수명 관리, 이중 기입 원장, 재고 예약과 결제를 잇는 사가와 보상, 외부 결제 대행사(PG) 타임아웃의 '모름' 상태 처리, 웹훅 검증, 대사(reconciliation). 이 사이트의 멱등 키·펜싱 토큰·이벤트 소싱 실험을 증거로 묶는다"
tags: [결제, 주문, 멱등 키, 원장, 사가, 대사, PG, 상태 머신]
experiments: [api-idempotency-key, es-optimistic-concurrency]
---

## 요구사항 — 정확성이 지연보다 앞선다

- 같은 주문에 두 번 청구하면 안 된다. 돈을 받았는데 주문이 없어도 안 된다.
- 결제 승인 p99 < 2초(외부 PG 지연 포함), 가용성 99.95%.
- 모든 돈의 움직임은 감사 가능해야 한다.
- 숫자: 피크 주문 3,000/s(블랙프라이데이), 일반 200/s — **처리량보다 정합성이 어렵다**.

## 원칙 1 — 모든 쓰기는 멱등

네트워크는 "요청이 처리됐는지" 를 알려 주지 않는다. 응답을 못 받은 클라이언트는 재시도하고, 서버는 **같은 요청이면 같은 결과**를 돌려줘야 한다.

```http
POST /v1/payments
Idempotency-Key: 7f2c…        ← 클라이언트가 만든다 (주문 ID 기반이 좋다)
{ "order_id": "o-881", "amount": 89000 }
```

```
1. SET idem:<key> "processing" NX EX 86400   ← 선점 실패 = 처리 중이거나 처리됨
2. 처리 → 결과를 idem:<key> 에 저장 (요청 본문 해시와 함께)
3. 같은 키 재요청 → 저장된 응답 재생 / 본문이 다르면 422
```

실험 [api-idempotency-key](/api-design/lab/api-idempotency-key) 에서 같은 키 동시 10번 → 결제 1건, 9건은 저장된 응답 재생, 키가 없으면 결제 10건이었다. 설계 세부는 [API 설계 노트 04](/api-design/notes/04-errors-retries-deadlines).

## 원칙 2 — 주문은 상태 머신

```
CREATED ─▶ STOCK_RESERVED ─▶ PAYMENT_PENDING ─▶ PAID ─▶ SHIPPED ─▶ DELIVERED
   │              │                  │  └─▶ PAYMENT_UNKNOWN ─(조회)─▶ PAID / FAILED
   └──────────────┴──────────────────┴──▶ CANCELLED (보상 완료)
```

- 허용된 전이만 코드로 정의한다(`PAID → CREATED` 같은 역행 금지).
- 전이는 **조건부 갱신**으로: `update orders set state='PAID' where id=$1 and state='PAYMENT_PENDING'` → 영향 행 0 이면 누군가 먼저 바꿨다. 이벤트 소싱이면 expected_version — [es-optimistic-concurrency](/event-sourcing/lab/es-optimistic-concurrency).

## 원칙 3 — 원장은 이중 기입, append-only

잔액 열을 `update` 하지 않는다. 모든 움직임을 두 계정에 반대 방향으로 기록한다.

| 거래 | 차변 | 대변 |
|---|---|---|
| 고객 결제 89,000 | PG 미수금 +89,000 | 매출 대기 +89,000 |
| PG 정산 입금 | 은행 +87,500, 수수료 비용 +1,500 | PG 미수금 −89,000 |
| 환불 | 매출 대기 −89,000 | PG 미수금 −89,000 |

거래마다 차변 합 = 대변 합이 불변식이고, 잔액은 분개의 합(파생값)이다 — 이벤트 소싱과 같은 철학이다([이벤트 소싱 노트 01](/event-sourcing/notes/01-state-vs-facts)). 상세는 [아키텍처 노트 09](/architecture/notes/09-payments-ledger-consistency).

## 원칙 4 — 여러 집합은 사가로

```
주문 생성 ─▶ 재고 예약 ─▶ 결제 승인 ─▶ 주문 확정
              └ 실패 → 주문 취소     └ 실패 → 재고 해제 → 주문 취소
```

재고 예약에는 **만료**를 둔다(예약 15분). 결제가 끝나지 않으면 예약이 자동 해제돼 재고가 묶이지 않는다. 사가·프로세스 매니저는 [이벤트 소싱 노트 07](/event-sourcing/notes/07-sagas-operations).

## 가장 어려운 부분 — 외부 PG 의 "모름"

PG 승인 요청이 타임아웃 나면 **승인됐는지 모른다**. 실패로 처리해 재시도하면 이중 청구, 성공으로 처리하면 돈을 못 받은 주문.

| 응답 | 상태 | 처리 |
|---|---|---|
| 승인 | PAID | 확정 |
| 거절 | FAILED | 사용자에게 안내, 보상 |
| 타임아웃·5xx | **PAYMENT_UNKNOWN** | 같은 멱등 키로 상태 조회 API 호출 → 결정, 조회도 실패면 지연 재조회 |
| 웹훅 도착 | 서명 검증 후 상태 반영 | 조회 결과와 웹훅이 둘 다 와도 조건부 전이로 한 번만 |

- PG 호출에도 우리 쪽 멱등 키(주문 ID)를 넘겨 PG 가 중복을 걸러 주게 한다.
- 웹훅은 위조될 수 있다: 서명 검증, 금액·주문 ID 대조, 재전송 대비 멱등.
- 타임아웃 값은 PG 의 처리 시간 분포를 보고 정한다(너무 짧으면 UNKNOWN 이 폭증) — [API 설계 노트 04](/api-design/notes/04-errors-retries-deadlines)의 데드라인.

## 대사 (reconciliation) — 최종 안전망

매일 PG 정산 파일과 우리 원장을 주문 ID 로 대조한다.

| 불일치 | 의미 | 조치 |
|---|---|---|
| PG 에 있고 우리에 없음 | 돈은 받았는데 주문 미확정 | 주문 확정 또는 환불 |
| 우리에 있고 PG 에 없음 | 확정했는데 돈 못 받음 | 조사·취소 |
| 금액 다름 | 부분 취소·수수료 오류 | 조정 분개 |

대사가 0 건이 아니라는 것을 전제로 설계한다. 자동 처리 규칙 + 사람 검토 큐. 데이터 품질 검사(누락·중복·관계 무결성)는 [데이터 엔지니어링 노트 06](/data-engineering/notes/06-data-quality-lineage-contracts)과 같은 도구다.

## 동시성 함정 모음

| 함정 | 증상 | 대책 |
|---|---|---|
| 재고 차감 경쟁 | 초과 판매 | 조건부 갱신(`stock >= qty`), 행 잠금, 또는 재고를 슬롯으로 쪼개기 ([PostgreSQL 노트 04](/postgres/notes/04-locks-deadlocks), 실험 [pg-row-locks](/postgres/lab/pg-row-locks)) |
| 결제 버튼 더블 클릭 | 이중 청구 | 멱등 키 + 버튼 비활성 |
| 만료된 락으로 처리 | 두 워커가 같은 주문 처리 | 펜싱 토큰 — 실험 [ds-fencing-token](/distributed-systems/lab/ds-fencing-token) |
| 이벤트 발행 누락 | 주문은 확정됐는데 배송 시스템이 모름 | Outbox + CDC — 실험 [cdc-outbox-debezium](/kafka/lab/cdc-outbox-debezium) |

## 면접식 후속 질문

1. 부분 환불을 원장에 어떻게 기록하나?
2. 결제 수단 여러 개(포인트 + 카드)를 한 주문에 쓰면 사가가 어떻게 바뀌나?
3. 블랙프라이데이 3,000/s 에서 재고 하나(인기 상품)에 주문이 몰리면?
4. 멱등 키는 얼마나 오래 보관해야 하나? (클라이언트 재시도 창 + 여유)

## 심화 — 한 트랜잭션 안에 무엇을 묶나

결제 확정 순간에 바뀌어야 하는 것은 셋이다: 주문 상태, 원장 분개, 다른 시스템에 알릴 이벤트. 이 셋이 따로 커밋되면 "돈은 받았는데 배송이 모름" 같은 틈이 생긴다. **같은 DB 트랜잭션**에 넣고, 바깥 세계(Kafka)로는 Outbox 로 내보낸다.

```sql
begin;
-- 1) 조건부 상태 전이: 이미 누가 바꿨으면 0행 → 롤백하고 현재 상태를 돌려준다
update orders set state = 'PAID', paid_at = now()
 where id = 'o-881' and state in ('PAYMENT_PENDING', 'PAYMENT_UNKNOWN');

-- 2) 이중 기입: 한 거래(txn_id)의 차변 합 = 대변 합
insert into ledger_entries (txn_id, account, direction, amount) values
  ('t-5521', 'pg_receivable', 'debit',  89000),
  ('t-5521', 'sales_pending', 'credit', 89000);

-- 3) 이벤트는 outbox 행으로 (CDC 가 Kafka 로 보낸다)
insert into outbox (aggregate_id, type, payload) values ('o-881', 'OrderPaid', '{"amount":89000}');
commit;
```

```sql
-- 원장 불변식 검사 (배치·알림용): 결과가 한 행이라도 나오면 사고다
select txn_id, sum(case direction when 'debit' then amount else -amount end) as diff
  from ledger_entries group by txn_id having sum(case direction when 'debit' then amount else -amount end) <> 0;
```

금액은 **정수(원·센트 단위)** 로 저장한다. 부동소수점 `0.1 + 0.2` 오차가 원장에 들어가면 대사에서 영원히 1원이 안 맞는다. 통화가 여럿이면 `(amount, currency)` 를 함께 두고 환산은 별도 분개로 기록한다.

### 웹훅 서명 검증

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyWebhook(rawBody: Buffer, sigHeader: string, ts: string, secret: string) {
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;           // 5분 넘은 것은 재전송 공격으로 본다
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(sigHeader);
  return a.length === b.length && timingSafeEqual(a, b);                        // 상수 시간 비교
}
```

- 서명은 **파싱 전 원본 바이트**로 계산한다. JSON 을 파싱했다 다시 직렬화하면 공백·키 순서가 바뀌어 서명이 안 맞는다.
- 서명이 맞아도 금액·주문 ID 를 우리 DB 와 대조한다. 웹훅 처리 자체도 `event_id` 유일 제약으로 멱등하게.

### 타임아웃 값은 분포로 정한다

PG 승인 지연이 p50 400ms, p99 1.8s, p99.9 6s 라면 타임아웃 2초는 요청의 약 1% 를 UNKNOWN 으로 만든다. 피크 3,000/s 에서 **초당 30건**이 조회 경로로 간다. 타임아웃 8초로 늘리면 UNKNOWN 은 줄지만 사용자가 오래 기다리고 스레드·연결이 그만큼 묶인다(리틀의 법칙 — [노트 01](/system-design/notes/01-design-method)). 그래서 보통 "사용자에겐 3초 후 '처리 중' 화면, 백엔드는 조회·웹훅으로 마저 확정" 으로 둘을 분리한다.

## 모니터링·로그 — 돈 시스템의 핵심 지표

| 지표 | 정상 | 알림 기준 예 |
|---|---|---|
| 승인 성공률 (PG·카드사별) | 평소 기준선 | 특정 PG 만 5%p 하락 → PG 장애, 라우팅 전환 검토 |
| `PAYMENT_UNKNOWN` 체류 건수·최대 체류 시간 | 0 에 수렴 | 10분 넘게 남은 건 존재 → 조회 워커 정지 |
| 멱등 키 재생 비율 | 낮고 안정 | 급증 → 클라이언트 재시도 폭증(네트워크·앱 버그) |
| 웹훅 서명 실패 수 | 0 | 1건이라도 → 비밀 키 교체 누락 또는 위조 시도 |
| 원장 불균형 거래 수 | **항상 0** | 0 이 아니면 즉시 호출 |
| 대사 불일치 건수·금액 | 작은 상수 | 금액 합계 기준으로 알림 |
| Outbox 미발행 행 수·가장 오래된 행 나이 | 수 초 | 증가 → CDC 정지, 배송·알림 시스템이 모름 |

결제 로그에는 카드 번호·CVC 를 절대 남기지 않는다(PCI DSS). `order_id`, `idempotency_key`, `pg_tid`, 상태 전이(`from → to`), PG 응답 코드, 지연을 남기면 고객 문의 "돈은 빠졌는데 주문이 없어요" 를 주문 ID 하나로 끝까지 추적할 수 있다. 감사 로그는 append-only 저장소에 별도 보관 — [보안 노트 07](/security/notes/07-datastore-hardening).

## 흔한 실수와 오해

- **타임아웃을 실패로 처리** → 사용자가 다시 결제 → 이중 청구. 타임아웃은 "모름" 이다.
- **멱등 키를 서버가 요청마다 새로 생성** → 재시도마다 키가 달라 멱등이 무의미. 키는 클라이언트(또는 주문 ID)에서 와야 한다.
- **잔액 열 `update`** → 누가 언제 왜 바꿨는지 사라지고, 동시 갱신 경합. 원장은 append-only, 잔액은 파생값.
- **상태 전이를 `select` 후 `update`** → 두 워커가 같은 주문을 확정. 조건부 `update ... where state = …` 의 영향 행으로 판정.
- **환불을 원 거래 삭제로** → 감사 불가. 반대 분개를 새로 쓴다.

## 스스로 점검

1. **주문 상태·원장·이벤트를 왜 한 트랜잭션에 묶고, Kafka 발행은 왜 Outbox 로 하나?** — 셋이 따로 커밋되면 틈이 생긴다. DB 와 Kafka 를 한 트랜잭션으로 묶을 수 없으니 outbox 행을 같은 트랜잭션에 쓰고 CDC 가 내보낸다.
2. **PG p99 가 1.8s 인데 타임아웃을 2초로 두면 피크 3,000/s 에서 무슨 일이?** — 약 1%, 초당 30건이 UNKNOWN 이 되어 조회 경로로 간다.
3. **웹훅 서명을 파싱된 JSON 으로 검증하면 왜 실패하나?** — 재직렬화로 바이트가 바뀐다. 원본 바이트로 계산해야 한다.
4. **원장에서 "항상 0" 이어야 하는 지표는?** — 거래별 차변 합 − 대변 합. 0 이 아닌 거래가 하나라도 있으면 사고다.

## 예시로 보기 — 이 프로젝트에서

```bash
pnpm exec tsx scripts/run-code-lab.mts api-design api-idempotency-key       # 같은 키 10번 → 결제 1건
pnpm exec tsx scripts/run-code-lab.mts event-sourcing es-optimistic-concurrency   # 동시 출금 20건 → 정확히 10건
pnpm exec tsx scripts/run-code-lab.mts distributed-systems ds-fencing-token  # 만료된 락의 늦은 쓰기 거부
```

세 실험이 결제 설계의 세 기둥(중복 요청, 동시 변경, 늦게 깨어난 작업자)을 각각 증명한다.

## 실전에서는 어디에 쓰이나

> 돈이 오가는 모든 기능에서 "두 번 청구하지 않고, 받은 돈을 잃지 않는다" 를 지켜야 할 때 이 노트가 쓰인다. 처리량보다 정합성이 어렵고, 외부 결제 대행사(PG)의 타임아웃이 가장 까다로운 지점이다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 결제 버튼 | 더블 클릭·재시도로 인한 이중 청구 | 주문 ID 기반 멱등 키 — Stripe 는 `Idempotency-Key` 헤더를 공식 API 로 제공 | 버튼 비활성만(네트워크 재시도는 못 막음) |
| PG 연동 결제 승인 | 타임아웃 시 승인 여부를 모름 | `PAYMENT_UNKNOWN` 상태 + 상태 조회 API + 서명 검증된 웹훅 | 타임아웃을 실패로 처리(이중 청구) |
| 핀테크 지갑·포인트 | 잔액 불일치와 감사 불가 | 이중 기입 append-only 원장, 잔액은 분개 합 | 잔액 열 `update` |
| 커머스 주문 → 재고 → 결제 | 여러 단계 중 실패 시 정리 | 만료 있는 재고 예약 + 사가 보상, 상태 머신 조건부 전이 | 분산 트랜잭션(2PC) |
| 정산·재무 시스템 | PG 정산 파일과 내부 기록 차이 | 일 단위 대사, 불일치 유형별 자동 규칙 + 사람 검토 큐 | 월말 수기 대조 |

**이럴 땐 안 맞는다**
- 결제 기능을 직접 다 만들기: 카드 정보 처리는 PCI DSS 부담이 크다. PG·결제 플랫폼의 호스팅 결제창·토큰화를 쓰고 이 노트의 원칙은 연동 계층에 적용한다.
- 무료 포인트·좋아요처럼 감사가 필요 없는 카운터에 원장: 과한 구조다. 원자적 증감이면 충분하다.

**누가 매일 만나나** — 백엔드 개발자는 결제 API 의 멱등·상태 전이를 구현할 때, 데이터·재무 엔지니어는 대사 불일치를 처리할 때, SRE 는 `PAYMENT_UNKNOWN` 체류 건수와 Outbox 미발행 행을 알림으로 볼 때 만난다.

**면접·실무 단골 질문**
- Q. PG 호출이 타임아웃나면? → 실패가 아니라 "모름". 같은 멱등 키로 상태를 조회하고, 웹훅과 조회 결과는 조건부 전이로 한 번만 반영한다.
- Q. 주문 상태·원장·이벤트를 어떻게 일관되게 바꾸나? → 같은 DB 트랜잭션에 쓰고 이벤트는 Outbox 행으로, CDC 가 Kafka 로 내보낸다.

## 실습 체크리스트

- [ ] 주문 상태 머신에서 허용 전이 표를 만들고 역행 전이를 막는 SQL 쓰기
- [ ] PG 타임아웃 → UNKNOWN → 조회 → 확정 흐름을 시퀀스 다이어그램으로 그리기
- [ ] 결제·환불·정산 입금을 이중 기입 분개로 적고 합이 0 인지 확인하기
- [ ] 대사 불일치 세 유형에 대한 자동 처리 규칙 정하기
