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

## 예시로 보기 — 이 프로젝트에서

```bash
pnpm exec tsx scripts/run-code-lab.mts api-design api-idempotency-key       # 같은 키 10번 → 결제 1건
pnpm exec tsx scripts/run-code-lab.mts event-sourcing es-optimistic-concurrency   # 동시 출금 20건 → 정확히 10건
pnpm exec tsx scripts/run-code-lab.mts distributed-systems ds-fencing-token  # 만료된 락의 늦은 쓰기 거부
```

세 실험이 결제 설계의 세 기둥(중복 요청, 동시 변경, 늦게 깨어난 작업자)을 각각 증명한다.

## 실습 체크리스트

- [ ] 주문 상태 머신에서 허용 전이 표를 만들고 역행 전이를 막는 SQL 쓰기
- [ ] PG 타임아웃 → UNKNOWN → 조회 → 확정 흐름을 시퀀스 다이어그램으로 그리기
- [ ] 결제·환불·정산 입금을 이중 기입 분개로 적고 합이 0 인지 확인하기
- [ ] 대사 불일치 세 유형에 대한 자동 처리 규칙 정하기
