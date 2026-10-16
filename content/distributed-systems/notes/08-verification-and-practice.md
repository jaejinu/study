---
title: "심화 — 정형 검증과 현실: TLA+, Jepsen, 그리고 설계 체크리스트"
order: 8
level: 심화
summary: 분산 시스템 버그가 테스트로 잡히지 않는 이유, TLA+/PlusCal 로 설계를 모델 검사하는 방법과 실제 성과(AWS, MongoDB), Jepsen 이 etcd·Kafka·PostgreSQL·Redis 에서 찾아낸 버그들의 패턴, 결정적 시뮬레이션 테스트(FoundationDB), 속성 기반 테스트, 카오스 실험과의 연결, 그리고 설계 리뷰에 바로 쓰는 체크리스트
tags: [TLA+, 모델 검사, Jepsen, 선형화 검사, 결정적 시뮬레이션, 속성 기반 테스트, 카오스, 설계 리뷰]
experiments: []
---

## 왜 테스트로 안 잡히나

분산 시스템 버그는 **드문 인터리빙**(메시지 순서, 장애 타이밍)에서만 나타난다. 노드 3개, 메시지 10개면 가능한 순서가 수만 가지고, 그중 하나에서만 안전성이 깨진다. 단위 테스트는 한 순서만 본다. 통합 테스트는 "정상 순서" 만 본다. 운영에서 1년에 한 번 나타나면 재현도 못 한다.

> Amazon(2014, "How Amazon Web Services Uses Formal Methods"): 코드 리뷰·테스트·설계 문서로 못 찾은 버그를 TLA+ 가 S3·DynamoDB 설계에서 찾았다. 어떤 버그는 **35단계** 의 이벤트 순서가 필요했다.

접근법은 두 축이다: **설계 단계**에서 상태 공간을 전부 탐색(모델 검사), **구현 단계**에서 장애를 주입하고 결과를 **검증기**로 확인(Jepsen, 시뮬레이션).

## TLA+ — 설계를 수학으로 쓰고 전부 탐색한다

Lamport 의 TLA+(Temporal Logic of Actions)는 시스템을 **상태 + 전이** 로 기술하는 언어다. TLC 모델 검사기가 작은 인스턴스(노드 3개, 메시지 2개)의 **모든 상태**를 탐색해 불변식(invariant) 위반이나 진행 실패를 찾고, **반례 경로**를 보여 준다.

### PlusCal 로 쓴 2PC 맛보기

```
--algorithm TwoPhaseCommit {
  variables rmState = [r \in RM |-> "working"], tmState = "init", msgs = {};
  define {
    Consistent == \A r1, r2 \in RM : ~(rmState[r1] = "committed" /\ rmState[r2] = "aborted")   \* 불변식
  }
  process (rm \in RM) {
    prepare: either { rmState[self] := "prepared"; msgs := msgs \cup {[type |-> "Prepared", rm |-> self]} }
             or     { rmState[self] := "aborted" };
    decide:  await \E m \in msgs : m.type \in {"Commit", "Abort"};
             with (m \in {m \in msgs : m.type \in {"Commit","Abort"}}) {
               rmState[self] := IF m.type = "Commit" THEN "committed" ELSE "aborted" }
  }
  process (tm = "TM") {
    wait: await \A r \in RM : [type |-> "Prepared", rm |-> r] \in msgs;
          msgs := msgs \cup {[type |-> "Commit"]}
  }
}
```

TLC 는 RM={r1,r2,r3} 에 대해 모든 인터리빙을 돌려 `Consistent` 가 항상 참인지 확인한다. 여기에 "TM 이 죽을 수 있음" 을 추가하면 **블로킹**(진행 실패)이 반례로 나온다 — 2PC 의 알려진 약점이 자동으로 드러난다.

### 무엇을 모델링하나

| 모델링 대상 | 예 |
|---|---|
| 안전성 불변식 | "두 리더가 같은 텀에 없다", "커밋된 값은 바뀌지 않는다", "잔액 ≥ 0" |
| 진행(liveness) | "요청은 언젠가 응답받는다" — 공정성 가정 필요 |
| 장애 | 메시지 유실·중복·재정렬, 노드 크래시·재시작(휘발 상태 초기화) |
| 작은 인스턴스 | 노드 3, 키 2, 값 2 — "작은 모델 가설": 버그는 작은 인스턴스에서도 나타난다 |

### 실제 성과

- AWS: S3, DynamoDB, EBS 의 설계 버그. "TLA+ 가 없었으면 운영에서 발견했을 것".
- MongoDB: Raft 기반 복제 프로토콜의 TLA+ 스펙과 구현을 **추적 검사**(trace checking)로 대조.
- CockroachDB, TiDB(TLA+), Azure Cosmos DB, Elasticsearch(새 코디네이션 레이어).
- Raft 논문 자체가 TLA+ 스펙을 동반(Ongaro 박사 논문).

한계: **설계**를 검사하지 구현을 검사하지 않는다. 스펙과 코드의 괴리가 버그의 온상이라 추적 검사·시뮬레이션이 보완한다. 상태 폭발로 큰 인스턴스는 불가. 배우는 데 시간이 든다(그래도 "Specifying Systems" 1~2주면 2PC·락 정도는 쓴다).

## Jepsen — 구현을 때리고 이력을 검증한다

Kyle Kingsbury 의 Jepsen 은 **실제 시스템**(5노드)에 클라이언트 요청을 보내며 **장애를 주입**(네트워크 분단, 시계 조작, 프로세스 kill/pause)하고, 모든 요청의 호출·응답 **이력(history)** 을 기록한 뒤 검사기(Knossos, Elle)로 "이 이력이 주장한 일관성 모델과 양립하는가" 를 판정한다.

```
이력:  {:process 1 :type :invoke :f :write :value 3}
       {:process 2 :type :invoke :f :read}
       {:process 1 :type :ok :f :write :value 3}
       {:process 2 :type :ok :f :read :value 0}     ← 겹쳤으니 0 도 OK
       {:process 3 :type :invoke :f :read} … :value 0   ← write 완료 후 시작했는데 0 → 선형화 위반!
```

선형화 검사는 NP-완전이라 Knossos 는 작은 이력만, **Elle** 는 트랜잭션 의존성 그래프의 사이클(G0/G1/G2 이상 현상)을 찾아 큰 이력도 검사한다 — [격리 수준](/postgres/notes/03-mvcc-isolation) 의 이상 현상 이름이 그대로 쓰인다.

### 찾아낸 버그의 패턴 (이 프로젝트와 관련된 것들)

| 시스템 | 발견 | 패턴 |
|---|---|---|
| **etcd** (2014, 2020) | 초기: 분단 시 stale 읽기. 2020: 락 API 가 "상호 배제" 를 보장한다고 문서화했으나 프로세스 멈춤 시 깨짐 | 선형화 읽기 미보장 / **락 ≠ 상호 배제**(펜싱 필요, [6장](/distributed-systems/notes/06-transactions-coordination)) |
| **Kafka** (2013) | `unclean.leader.election=true`(당시 기본)로 확인된 쓰기 유실 | 가용성 우선 기본값이 내구성 약속을 깸 → 기본값 false 로 변경 |
| **Redis Sentinel/Cluster** (2013) | 분단 시 옛 마스터가 쓰기를 계속 받아 페일오버 후 유실 | 비동기 복제 + 펜싱 없음. `min-replicas-to-write` 추가로 완화 |
| **PostgreSQL** (2020) | `SERIALIZABLE` 에서도 특정 조건(동시 삽입·`REPEATABLE READ`)에서 G2-item 이상 현상. 12.3 에서 수정 | 수십 년 된 DB 도 Elle 가 새 버그를 찾음 |
| **MongoDB** (2020) | 기본 write/read concern 에서 확인된 쓰기 유실, "snapshot" 이 스냅샷 아님 | **기본값**이 약함 — 사용자는 기본값을 믿는다 |
| **ZooKeeper** (2013) | 통과 — 문서대로 동작한 드문 사례 | 합의 + 세션 보장을 제대로 구현 |
| **CockroachDB** (2017) | 시계 오차가 설정 상한을 넘으면 일관성 깨짐(설계대로, 문서화됨) | 시계 의존성은 **명시적 가정**이어야 |

공통 교훈: (1) 문서의 보장과 실제가 다르다, (2) 기본값이 위험하다, (3) 네트워크 분단과 **프로세스 멈춤**이 가장 생산적인 장애다, (4) 클라이언트 재시도 로직이 서버만큼 중요하다(타임아웃된 쓰기는 성공했을 수도).

## 결정적 시뮬레이션 테스트 (FoundationDB 방식)

FoundationDB 는 네트워크·디스크·시계를 전부 **시뮬레이터**로 바꿔 단일 스레드에서 전체 클러스터를 실행한다. 모든 무작위성이 **시드** 하나에서 나오므로 실패를 **정확히 재현**한다. 하루에 수백만 "시뮬레이션 시간" 년을 돌린다. 결과: 운영 버그가 거의 없고, "우리는 Jepsen 을 돌릴 필요가 없다" (Jepsen 측도 인정).

같은 철학의 도구: **Antithesis**(결정적 하이퍼바이저로 아무 시스템이나), TigerBeetle(VOPR), Dropbox/Resonate. 요구 조건: 코드가 시간·I/O·난수를 **주입 가능**하게 설계돼야 한다 — 처음부터 그렇게 짜야 하고, 후에 넣기는 어렵다. 그래도 **의존성 주입된 시계와 전송 계층**만 갖춰도 단위 테스트에서 "메시지 순서 뒤섞기·유실" 을 돌릴 수 있다.

## 속성 기반 테스트와 모델 기반 테스트

더 가벼운 도구: **속성 기반 테스트**(fast-check, Hypothesis, QuickCheck)는 무작위 입력·연산 순서를 생성해 속성("멱등: f(f(x)) = f(x)", "CRDT 병합은 교환 가능")을 검사하고, 실패하면 **최소 반례**로 축소(shrinking)한다. **모델 기반**: 단순한 참조 모델(메모리 Map)과 실제 시스템(Redis 클라이언트 + 재시도)에 같은 명령 시퀀스를 넣고 결과 비교.

```ts
// fast-check: 레이트리밋 토큰 버킷이 "창 안에 N 초과 허용 안 함" 을 어떤 요청 타이밍에서도 지키는가
fc.assert(fc.property(fc.array(fc.nat(1000), { maxLength: 200 }), (gaps) => {
  const b = new TokenBucket({ capacity: 10, refillPerSec: 5 }); let t = 0; let allowedInWindow: number[] = [];
  for (const g of gaps) { t += g; if (b.tryTake(t)) allowedInWindow.push(t); allowedInWindow = allowedInWindow.filter((x) => x > t - 1000); if (allowedInWindow.length > 15) return false; }
  return true;
}));
```

## 카오스 실험과의 연결

[장애 실험실](/chaos/notes/01-chaos-principles) 은 Jepsen 의 "장애 주입" 절반이다. 빠진 절반이 **검증기**다. `chaos-redis-hang` 은 "타임아웃이 동작하는가" 를 보고, Jepsen 은 "그 동안의 모든 읽기·쓰기 이력이 일관성 모델을 지켰는가" 를 본다. 자기 시스템에 Jepsen 급 검증을 붙이는 현실적 단계:

1. 모든 요청의 (호출 시각, 응답 시각, 결과) 를 기록 — 이미 트레이스가 있으면 거의 공짜([트레이싱](/observability/notes/06-tracing-otel)).
2. 장애 중에 **불변식**을 주기적으로 검사: "주문 합계 = 결제 합계", "재고 ≥ 0", "리더는 하나".
3. 장애 후 **수렴** 검사: 복제본 간 diff, outbox 와 토픽 메시지 수 대조.
4. 타임아웃된 쓰기를 "모름" 으로 분류해 검증기에 알려 준다(성공 가능성 있음).

## 설계 리뷰 체크리스트

분산 시스템 설계 문서를 볼 때 이 질문들을 던진다. 하나라도 "모르겠다" 면 설계가 끝나지 않은 것이다.

**모델과 가정**
- [ ] 장애 모델은? (crash-recovery? 비잔틴?) 네트워크 분단과 프로세스 멈춤을 가정했나?
- [ ] 시계를 어디에 의존하나? 오차 상한을 넘으면 무엇이 깨지나?
- [ ] 각 데이터의 일관성 모델을 명시했나? (선형화가 필요한 연산은 무엇?)

**안전성**
- [ ] "하나만" 보장(리더·락·유일 ID)에 펜싱/에포크가 있나?
- [ ] 재시도는 멱등한가? 멱등 키의 저장소와 TTL 은?
- [ ] 두 시스템에 쓰는 곳(이중 쓰기)이 있나? Outbox/CDC 로 바꿨나?
- [ ] 타임아웃된 요청의 결과를 "모름" 으로 다루나?

**진행과 복구**
- [ ] 과반을 잃으면 무엇이 멈추나? 멈추는 것이 올바른가(C) 아니면 계속해야 하나(A)?
- [ ] 노드 복구 시 상태를 어디서 되찾나(WAL, 스냅샷, 로그 재생)? 재생은 멱등한가?
- [ ] 리밸런스·페일오버 중에도 읽기·쓰기가 가능한가? 자동인가 수동인가?

**검증**
- [ ] 핵심 불변식을 한 문장으로 적을 수 있나? 그걸 운영 중 검사하는 지표/알림이 있나?
- [ ] 장애 주입 실험(분단·멈춤·시계 점프)을 했나? 그 동안의 이력을 검증했나?
- [ ] 기본 설정값이 약한 보장을 주지 않나? (acks, unclean election, synchronous_commit, write concern)

## 예시로 보기 — 이 프로젝트에서

**Redis 분산 락**의 TLA+ 모델은 20줄이면 된다: 상태 = {락 소유자, TTL 타이머, 각 클라이언트의 "소유한다고 믿음"}, 전이 = 획득·만료·멈춤·깨어남·쓰기. 불변식 "임계 구역에 둘 이상 없음" 은 "멈춤" 전이를 넣는 순간 깨진다 — 반례가 [6장](/distributed-systems/notes/06-transactions-coordination) 의 GC 시나리오 그대로 나온다. 펜싱 토큰 검사를 저장소 전이에 넣으면 통과한다. 이 작은 연습이 모델 검사의 가치를 보여 준다.

**Kafka 설정 리뷰**: 이 프로젝트의 단일 브로커는 `min.insync.replicas=1` 이다. 체크리스트의 "기본값" 항목으로 보면 운영에서는 복제 3·ISR 2·`unclean.leader.election.enable=false`·프로듀서 `acks=all` + `enable.idempotence=true` 가 되어야 Jepsen 의 2013 발견을 피한다 ([전달 보장](/kafka/notes/04-delivery-guarantees)).

**PostgreSQL 격리**: `pg-isolation` 류 실험([MVCC·격리](/postgres/notes/03-mvcc-isolation))에서 `REPEATABLE READ` 의 write skew 를 재현한다. Elle 가 찾는 G2 이상 현상이 바로 그것이고, `SERIALIZABLE`(SSI)이 막는다 — 직접 돌린 작은 Jepsen 이다.

**카오스 + 불변식**: `chaos-pg-connection-exhaustion` 실험 뒤에 "주문 수 = outbox 이벤트 수" 같은 대조를 추가하면 장애 실험이 검증 실험이 된다. [장애 카탈로그](/chaos/notes/02-failure-catalog) 의 각 항목에 "이 장애 중 깨질 수 있는 불변식" 열을 더해 보자.

## 실습 체크리스트

- [ ] TLA+ Toolbox(또는 VS Code 확장)를 설치하고 위 2PC PlusCal 을 TLC 로 돌려 `Consistent` 통과를 확인한 뒤, TM 크래시를 추가해 블로킹 반례를 본다
- [ ] Redis 락을 TLA+ 로 모델링해 "멈춤" 전이가 불변식을 깨는 반례를 얻고, 펜싱 토큰으로 고친다
- [ ] Jepsen 의 etcd 2020 분석(jepsen.io/analyses/etcd-3.4.3)을 읽고 "락이 상호 배제를 보장하지 않는" 이력을 자기 말로 설명한다
- [ ] fast-check 로 이 프로젝트의 레이트리밋 또는 멱등 키 로직에 속성 테스트를 하나 붙인다
- [ ] 카오스 실험 하나에 불변식 검사(장애 전후 데이터 대조)를 추가해 PASS/FAIL 기준으로 만든다
