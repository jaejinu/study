---
title: "분산 트랜잭션과 코디네이션 — 2PC, Saga, 분산 락, 펜싱 토큰, 정확히 한 번의 실체"
order: 6
level: 심화
summary: "원자적 커밋 문제와 2PC 의 동작·블로킹 문제·3PC, Saga 의 보상 트랜잭션과 설계 규칙, 합의 서비스 위의 리더 선출과 리스, 분산 락이 안전하지 않은 이유와 펜싱 토큰, Redlock 논쟁의 양쪽 주장, 멱등 키·중복 제거로 만드는 '사실상 정확히 한 번', Kafka 트랜잭션의 실제 범위"
tags: [2PC, 3PC, Saga, 분산 락, 펜싱 토큰, 리스, Redlock, 멱등성, exactly-once, Kafka 트랜잭션]
experiments: []
---

## 원자적 커밋(atomic commit) 문제

여러 노드(샤드, 서로 다른 DB, DB+메시지 큐)에 걸친 작업을 **전부 커밋하거나 전부 롤백**해야 한다. 단일 노드의 트랜잭션은 WAL 한 줄("커밋")로 원자성을 얻지만, 노드가 여럿이면 "노드 A 는 커밋했는데 B 는 실패" 가 가능하다. 합의와 비슷해 보이지만 다르다: 합의는 "과반이 동의하면 결정", 원자적 커밋은 "**전원**이 yes 여야 커밋, 하나라도 no 면 중단".

## 2단계 커밋(2PC)

**코디네이터**와 **참여자**(participants).

```
Phase 1 (Prepare / Vote):
  코디네이터 → 각 참여자: "커밋할 수 있나?"
  참여자: 로컬로 트랜잭션을 실행하고 WAL 에 PREPARED 기록(fsync) — 이제 어떤 장애에도 커밋할 수 있음을 **약속**. "yes" 응답
         (못 하면 "no")
Phase 2 (Commit / Abort):
  모두 yes → 코디네이터가 자기 로그에 COMMIT 기록(이것이 결정 시점) → 참여자에 COMMIT
  하나라도 no 또는 타임아웃 → ABORT
  참여자: 결정을 적용하고 ack. 코디네이터는 모두 ack 하면 완료.
```

**핵심 약속 두 개**: 참여자는 yes 라고 하면 **어떤 일이 있어도** 커밋할 수 있어야 하고(락 유지, 디스크 보장), 코디네이터는 결정을 로그에 쓴 뒤엔 **번복 불가**.

### 블로킹 문제

참여자가 yes 를 보낸 뒤 코디네이터가 죽으면? 참여자는 **결정을 모른 채** 락을 쥐고 기다린다(in-doubt). 다른 참여자에게 물어볼 수도 있지만, 모두 yes 만 보냈고 결정을 못 받았으면 아무도 모른다 — 코디네이터가 복구돼 로그를 읽어 줄 때까지 **블로킹**. 그동안 해당 행들은 잠겨 있다. PostgreSQL 의 `PREPARE TRANSACTION` 이 남긴 고아 prepared 트랜잭션이 vacuum 을 막는 사고가 전형이다.

### 3PC 와 그 이후

3PC 는 "pre-commit" 단계를 넣어 코디네이터 장애 시 참여자끼리 결정할 수 있게 하지만, **네트워크 분단**에서는 안전하지 않다(양쪽이 다른 결정). 현실의 답은 **코디네이터를 합의로 복제**(Spanner: Paxos 그룹이 코디네이터, 코디네이터 로그가 복제돼 죽지 않음)하거나, 2PC 자체를 피하는 것이다.

### XA 와 실제 쓰임

XA 는 2PC 의 표준 API(JTA, PostgreSQL `PREPARE TRANSACTION`, MySQL XA). 이기종(DB + JMS 큐) 트랜잭션을 가능하게 하지만: 느리고(fsync 2회 + RTT 2회), 블로킹하고, 코디네이터(앱 서버)가 단일 장애점. 마이크로서비스에서는 거의 쓰지 않는다. 대신 → Saga, Outbox.

## Saga — 긴 트랜잭션을 보상으로 되돌린다

Saga(Garcia-Molina, 1987): 트랜잭션을 **로컬 트랜잭션의 연속** T1, T2, …, Tn 으로 쪼개고, 각 Ti 에 **보상 트랜잭션** Ci 를 둔다. Tk 가 실패하면 C(k-1) … C1 을 실행해 의미적으로 되돌린다.

```
주문 Saga: T1 주문 생성 → T2 결제 승인 → T3 재고 차감 → T4 배송 예약
T3 실패(재고 없음): C2 결제 취소 → C1 주문 취소(상태 = 취소)
```

| 조정 방식 | 동작 | 장단점 |
|---|---|---|
| **코레오그래피** | 각 서비스가 이벤트를 듣고 다음 단계 수행·발행 | 결합 낮음, 흐름이 코드에 흩어져 추적 어려움 |
| **오케스트레이션** | Saga 오케스트레이터가 각 단계 명령·결과 수신 | 흐름이 한 곳에, 상태 머신 명시적. 오케스트레이터 자체의 내구성 필요(Temporal, 워크플로 엔진) |

### Saga 설계 규칙

1. **보상은 "되돌리기" 가 아니라 "상쇄"** 다. 이메일 발송은 되돌릴 수 없으니 "취소 메일" 을 보낸다. 되돌릴 수 없는 단계(결제 확정)는 **마지막에** 두어 보상 필요성을 줄인다(pivot 트랜잭션).
2. **격리가 없다**: T1 커밋 후 T3 실패 전까지 다른 트랜잭션이 "주문 생성됨" 을 본다(dirty read 에 해당). 대책: 의미적 락(`status=PENDING` 으로 표시), 교환 가능한 갱신(증감), 재읽기(읽은 버전 확인), 비관적 순서(위험한 단계를 먼저).
3. **모든 단계와 보상은 멱등**해야 한다 — 메시지가 중복되고 재시도되므로.
4. 단계 상태를 **영속화**(DB 또는 이벤트 로그)해 오케스트레이터가 죽어도 재개.
5. 메시지 발행과 DB 갱신은 [Outbox](/kafka/notes/08-cdc-outbox-debezium) 로 묶는다 — 아니면 Saga 자체가 이중 쓰기 문제를 갖는다.

[비동기 메시징과 일관성](/architecture/notes/03-async-messaging-consistency) 의 Saga 절과 함께 읽을 것.

## 리더 선출과 리스

"작업은 한 노드만 해야 한다"(크론 잡, 파티션 소유, 프라이머리 DB). 방법: 합의 서비스(etcd/ZooKeeper/Consul)에 **TTL 키**를 만든다. 키를 만든 노드가 리더, 주기적으로 TTL 을 갱신(keepalive). 죽으면 TTL 만료 → 다른 노드가 키를 만들어 리더가 된다. 이것이 **리스(lease)** 다.

```
etcd:  lease = grant(10s); put("/leader", "node-A", lease) if not exists  → 리더
       매 3초 keepalive(lease). 실패하면 리더 아님으로 간주하고 작업 중단
ZooKeeper: ephemeral sequential 노드 /election/n_000001 … 가장 작은 번호가 리더, 바로 앞 노드를 watch
Kubernetes: coordination.k8s.io Lease 오브젝트 — controller-manager, scheduler 가 이렇게 리더 선출
```

문제는 **리스가 만료됐는데 노드가 모르는 순간**이다(GC 멈춤, 네트워크 지연). "나는 리더" 라는 로컬 믿음과 실제가 어긋난다.

## 분산 락과 펜싱 토큰

분산 락은 리스와 같은 구조(TTL 키)다. 그리고 같은 문제를 가진다.

```
1. 클라이언트 A: 락 획득 (TTL 10s)
2. A: 멈춤 (GC 15초 / 네트워크 단절)
3. 락 만료. 클라이언트 B: 락 획득, 저장소에 쓰기
4. A: 깨어남. 자기가 락 주인인 줄 알고 저장소에 쓰기 → B 의 쓰기를 덮어씀. 손상.
```

락 서비스가 아무리 완벽해도(ZooKeeper 여도) 이 시나리오는 막을 수 없다. 클라이언트가 멈춘 동안 락 서비스는 할 수 있는 게 없다. 해법은 **저장소가 검사**하는 것 — **펜싱 토큰(fencing token)**:

- 락 서비스가 락을 줄 때 **단조 증가 토큰**을 함께 준다(ZooKeeper 의 zxid, etcd 의 revision, 직접 INCR).
- 클라이언트는 저장소에 쓸 때 토큰을 보낸다.
- 저장소는 **지금까지 본 최대 토큰보다 작은 토큰의 쓰기를 거부**한다.

```
A: 토큰 33 으로 락. 멈춤.  B: 토큰 34 로 락, 쓰기(34) → 저장소 max=34
A: 깨어나 쓰기(33) → 33 < 34 거부 ✓
```

저장소가 토큰 검사를 지원해야 한다: 파일 시스템이면 불가, DB 면 `WHERE version = ?` 조건 갱신(낙관적 잠금), S3 면 조건부 PUT(`If-Match`), Kafka 면 프로듀서 에포크. **펜싱이 불가능한 저장소에 분산 락으로 "상호 배제" 를 보장할 수 없다.**

### Redlock 논쟁 (2016)

Redis 의 Redlock 은 독립 Redis N개(5)에 과반 락을 걸어 단일 Redis 의 페일오버 문제를 피하려는 알고리즘이다. Martin Kleppmann 의 비판과 antirez 의 반론, 양쪽 모두 알아 둘 것:

| Kleppmann 의 비판 | antirez 의 반론 |
|---|---|
| 위의 GC 멈춤 시나리오 → 펜싱 토큰 없이는 어떤 락도 안전하지 않다. Redlock 은 토큰이 없다 | 토큰은 저장소 지원이 필요하고, 그렇다면 애초에 락이 아니라 CAS 로 풀 수 있다 |
| Redlock 은 **벽시계**에 의존(TTL 계산). 시계 점프 시 두 클라이언트가 동시에 락 | 시계 점프는 운영 문제, 대부분 환경에서 드물다 |
| "효율성 목적"(중복 작업 방지)이면 단일 Redis 로 충분, "정확성 목적" 이면 ZooKeeper 처럼 합의 + 토큰 | Redlock 은 그 중간의 실용적 선택 |

실무 결론: **락은 효율성 도구로**(같은 일을 두 번 하지 않기 위해) 쓰고, **정확성은 저장소의 원자 연산**(조건부 갱신, 유일 제약, 펜싱)으로 지킨다. [Redis 분산 락](/redis/notes/09-distributed-lock) 의 구현(SET NX PX + Lua 해제)이 그 "효율성 락" 의 올바른 형태다.

## 멱등성 — 분산 시스템의 만능 접착제

재시도는 필수이고(부분 실패), 재시도는 중복을 만든다. 연산이 **멱등**(여러 번 적용해도 한 번과 같음)이면 중복이 무해해진다.

| 연산 | 멱등? | 멱등하게 만들기 |
|---|---|---|
| `SET k v` | ✓ | — |
| `INCR k` | ✗ | 요청 ID 로 중복 제거: `SET req:{id} 1 NX` 성공 시에만 INCR (Lua 로 원자화) |
| `INSERT` | ✗ | 유일 제약(PK = 요청 ID) + `ON CONFLICT DO NOTHING` |
| 결제 API 호출 | ✗ | 멱등 키 헤더(Stripe `Idempotency-Key`) — 서버가 키별 응답을 저장해 재요청에 같은 응답 |
| 이메일 발송 | ✗ | 발송 로그 테이블(메시지 ID 유일) 확인 후 발송 |
| 상태 전이 `PENDING→PAID` | ✓(조건부) | `UPDATE … WHERE status='PENDING'` — 두 번째는 0행 |

**멱등 키 저장소**에 필요한 것: 원자적 "없으면 넣기"(Redis `SET NX`, DB 유일 제약), 만료(TTL — 키가 영원히 쌓이지 않게, 단 재시도 창보다 길게), 그리고 **처리 중** 상태(동시에 같은 키 두 요청이 오면 하나는 대기/거부).

## "정확히 한 번(exactly-once)" 의 실체

메시지 전달에서 exactly-once 는 **불가능**하다(수신 확인이 유실되면 재전송 or 유실 중 택일 — 두 장군 문제). 가능한 것은 **at-least-once 전달 + 멱등 처리 = 사실상 정확히 한 번(effectively-once)** 이다.

### Kafka 트랜잭션의 범위

Kafka "exactly-once semantics(EOS)" 는 정확히 다음을 뜻한다:
- **멱등 프로듀서**: 프로듀서 ID + 시퀀스 번호로 브로커가 중복 쓰기 제거(재시도 중복 방지). 한 세션·한 파티션 내.
- **트랜잭션**: 여러 파티션에 쓰기 + 컨슈머 오프셋 커밋을 **원자적**으로. "읽기 → 처리 → 쓰기" 가 Kafka 안에서 닫힐 때(Kafka Streams) 정확히 한 번.
- 범위 밖: 외부 DB 쓰기, 외부 API 호출. 거기서는 다시 멱등 키가 필요하다.

구현은 2PC 의 변형이다: 트랜잭션 코디네이터(브로커)가 `__transaction_state` 에 PREPARE/COMMIT 마커를 쓰고, 각 파티션에 **컨트롤 레코드**(commit/abort 마커)를 넣는다. `isolation.level=read_committed` 컨슈머는 마커 전까지의 레코드를 숨긴다. [전달 보장](/kafka/notes/04-delivery-guarantees) 참고.

## 예시로 보기 — 이 프로젝트에서

**분산 락 실험**(`/redis/lab`, [분산 락 노트](/redis/notes/09-distributed-lock)): `SET lock:x <token> NX PX 5000` 으로 획득, Lua 로 "내 토큰일 때만 DEL". 실험에서 TTL 을 짧게 두고 작업을 길게 하면 **두 클라이언트가 임계 구역에 동시에 있는 순간**을 만들 수 있다 — 위의 GC 시나리오와 동일하다. 펜싱을 흉내 내려면 보호 대상 키에 `WATCH`/Lua 로 "토큰 ≥ 마지막 토큰" 조건을 넣어 보라.

**Kubernetes Lease**: `kubectl -n kube-system get lease` 에 `kube-controller-manager`, `kube-scheduler` 의 holderIdentity 와 renewTime 이 보인다. `leaseDurationSeconds: 15`, 갱신 10초마다. 컨트롤러가 15초 멈추면 다른 복제본이 리더가 된다 — 그리고 옛 리더가 깨어나면? 컨트롤러의 모든 쓰기는 **resourceVersion 조건부 갱신**(낙관적 잠금)이라 옛 리더의 stale 쓰기는 409 Conflict 로 거부된다. 펜싱 토큰이 API 에 내장된 셈이다.

**Outbox + CDC 실험**(`cdc-outbox-debezium`): 2PC 없이 "DB 쓰기와 이벤트 발행" 의 원자성을 얻는다. 같은 로컬 트랜잭션에 넣고 WAL 을 구독하므로 코디네이터가 필요 없다. 그 대가로 소비자는 at-least-once 를 받으니 outbox.id 로 멱등 처리 — 이 노트의 모든 개념이 그 실험 하나에 들어 있다.

**PostgreSQL `PREPARE TRANSACTION`**: `max_prepared_transactions` 가 기본 0 이라 꺼져 있다. 켜고 `PREPARE TRANSACTION 'x'` 후 세션을 끊어 보면 `pg_prepared_xacts` 에 고아가 남고 락이 유지된다 — 2PC 블로킹의 실물.

## 실습 체크리스트

- [ ] PG 에서 `max_prepared_transactions=10` 으로 켜고 PREPARE 후 연결을 끊어 `pg_prepared_xacts` 와 잠긴 행을 확인, `ROLLBACK PREPARED` 로 정리
- [ ] Redis 락 실험에서 TTL 2초·작업 3초로 "두 클라이언트 동시 진입" 을 재현하고, 토큰 비교 Lua 로 두 번째 쓰기를 거부하게 고친다
- [ ] 주문 Saga 를 오케스트레이션 방식 상태 머신으로 그리고, 각 단계의 보상과 "되돌릴 수 없는 단계" 의 위치를 정한다
- [ ] 멱등 키 미들웨어(Express/Next 핸들러)를 Redis `SET NX` + 응답 캐시로 구현하고 같은 키로 두 번 호출해 본다
- [ ] Kafka 트랜잭션 프로듀서로 두 토픽에 쓰고 abort 했을 때 `read_committed` 컨슈머에 안 보이는지 확인한다
