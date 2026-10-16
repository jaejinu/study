---
title: "합의 — FLP, Paxos 의 직관, Raft 의 모든 것"
order: 5
level: 심화
summary: 합의 문제의 정의와 FLP 불가능성, 왜 그래도 Paxos·Raft 가 동작하는지(부분 동기·무작위 타임아웃), Paxos 의 두 단계 직관, Raft 상세(텀·리더 선출·로그 복제·커밋 규칙·안전성 증명의 핵심·스냅샷·멤버십 변경·선형화 읽기), etcd·ZooKeeper(ZAB)·Kafka KRaft 비교, 그리고 합의를 직접 구현하지 말아야 하는 이유
tags: [합의, FLP, Paxos, Raft, 리더 선출, 로그 복제, 쿼럼, etcd, ZooKeeper, KRaft]
experiments: []
---

## 합의(consensus)란

여러 노드가 **하나의 값에 동의**하는 문제. "누가 리더인가", "이 로그 항목 i 의 내용은 무엇인가", "이 트랜잭션은 커밋인가" 가 전부 합의다. 형식적 요구:

| 성질 | 뜻 | 종류 |
|---|---|---|
| **Agreement** | 올바른 노드들은 같은 값을 결정 | 안전성(safety) |
| **Validity** | 결정된 값은 누군가 제안한 값 | 안전성 |
| **Integrity** | 각 노드는 한 번만 결정 | 안전성 |
| **Termination** | 올바른 노드는 언젠가 결정 | 진행(liveness) |

안전성 = "나쁜 일은 절대 안 일어남", 진행 = "좋은 일이 언젠가 일어남". 이 둘의 긴장이 합의 알고리즘 전체를 관통한다.

![Raft 리더 선출과 로그 복제](/diagrams/ds-raft.svg)

## FLP 불가능성 (1985)

Fischer, Lynch, Paterson: **비동기 네트워크에서 노드 하나만 죽을 수 있어도, 결정적(deterministic) 합의 알고리즘은 종료를 보장할 수 없다.** 직관: 느린 노드와 죽은 노드를 구분할 수 없으므로, 어떤 알고리즘이든 "결정을 미루는 것이 항상 가능한" 실행이 존재한다.

그런데 Paxos·Raft 는 실제로 동작한다. 모순이 아니다 — FLP 를 **우회**한다:

1. **안전성은 항상, 진행은 조건부**: 네트워크가 "충분히 오래 동기적" 이면 종료. 그렇지 않은 동안엔 멈춰 있을 뿐 잘못 결정하지 않는다(부분 동기 모델).
2. **무작위성**: Raft 의 선거 타임아웃은 무작위(150~300ms). 결정적이지 않으므로 FLP 의 가정에서 벗어난다. 확률적으로 언젠가 리더가 뽑힌다.
3. **장애 감지기**: 타임아웃을 "불완전한 장애 감지기" 로 보고, 결국 정확해진다고 가정(◇W).

> 교훈: 합의 시스템은 네트워크가 나쁠 때 **멈추는 것이 정상**이다(etcd 리더 없음 → k8s API 쓰기 불가). 멈춤을 피하려고 안전성을 깨는 것이 최악이다.

## Paxos — 직관만

Lamport 의 Paxos(1989/1998)는 단일 값 합의(single-decree)다. 역할: **proposer**(제안), **acceptor**(수락, 과반이 필요), **learner**.

```
Phase 1 (Prepare):  proposer 가 번호 n 을 골라 과반 acceptor 에 "n 보다 작은 제안은 이제 거절해 줘" 요청
                    acceptor: n 이 지금까지 본 최대면 약속하고, 이미 수락한 (번호, 값) 이 있으면 알려 줌
Phase 2 (Accept):   proposer 는 응답 중 가장 큰 번호의 값이 있으면 **그 값**을, 없으면 자기 값을 n 으로 제안
                    과반 acceptor 가 수락하면 결정(chosen)
```

핵심 발명: Phase 2 에서 **이미 과반이 수락했을 수 있는 값을 자기 값 대신 채택**한다. 그래서 한 번 결정된 값은 이후 어떤 제안자도 뒤집을 수 없다(안전성). 진행은 두 proposer 가 번호를 계속 올리며 서로 막는 "결투(dueling)" 로 깨질 수 있어 → 리더(distinguished proposer)를 둔다. 값 하나가 아니라 로그 전체에 대해 반복하는 것이 **Multi-Paxos**인데, 논문에 세부가 없어 구현마다 달랐다. 그 불만에서 Raft 가 나왔다.

## Raft (Ongaro & Ousterhout, 2014) — 이해 가능성을 목표로

Raft 는 Multi-Paxos 와 같은 문제(복제 로그 합의)를 풀되 **리더를 중심으로** 문제를 셋으로 쪼갠다: 리더 선출, 로그 복제, 안전성.

### 상태와 텀

- 노드 상태: **Follower / Candidate / Leader**. 평상시 리더 하나, 나머지 팔로워.
- **텀(term)**: 단조 증가 정수 = 논리 시계. 텀마다 리더는 최대 하나. 모든 메시지에 텀을 싣고, 더 큰 텀을 보면 즉시 팔로워로 전환하고 텀을 갱신("오래된 리더는 자동 퇴위").
- 영속 상태(디스크에 fsync): `currentTerm`, `votedFor`, `log[]`. 휘발: `commitIndex`, `lastApplied`, 리더의 `nextIndex[]`·`matchIndex[]`.

### 리더 선출

```
팔로워: 리더 하트비트(AppendEntries)를 election timeout(무작위 150~300ms) 안에 못 받으면
  → currentTerm++, Candidate 로, 자기에게 투표, 모두에게 RequestVote(term, lastLogIndex, lastLogTerm)
팔로워가 투표하는 조건:
  - 요청의 term ≥ 내 term
  - 이 term 에 아직 아무에게도 투표 안 함 (votedFor 가 디스크에 — 재시작해도 두 번 투표 안 함)
  - 후보의 로그가 내 로그보다 **최신이거나 같음** (lastLogTerm 비교, 같으면 lastLogIndex 비교)   ← 안전성의 핵심
과반 득표 → Leader. 즉시 하트비트로 다른 후보 억제.
분할 투표(아무도 과반 못 얻음) → 타임아웃 후 재선거. 타임아웃이 무작위라 대개 금방 해결.
```

세 번째 조건(**선출 제한**, election restriction)이 "커밋된 항목을 가진 노드만 리더가 된다" 를 보장한다. 커밋 = 과반에 복제 → 과반 중 누군가는 가짐 → 그보다 덜 최신인 후보는 그 과반에게서 표를 못 얻는다.

### 로그 복제

```
클라이언트 → 리더: 명령 c
리더: log 에 (term, c) 추가 → 모든 팔로워에 AppendEntries(prevLogIndex, prevLogTerm, entries[], leaderCommit)
팔로워: prevLogIndex 위치의 텀이 prevLogTerm 과 같아야 수락(일관성 검사). 다르면 거절 → 리더가 nextIndex 를 줄여 재시도(충돌 항목은 덮어씀)
리더: 과반이 저장했다고 응답하면 commitIndex 를 올림 → 상태 머신에 적용 → 클라이언트에 응답
팔로워: 다음 AppendEntries 의 leaderCommit 을 보고 자기도 적용
```

**로그 매칭 성질**: 두 로그의 어떤 위치의 (index, term) 이 같으면 그 이전 로그는 모두 같다. 귀납적으로 일관성 검사가 보장한다. 리더는 자기 로그를 **절대 덮어쓰지 않고** 팔로워를 자기에게 맞춘다(append-only leader).

### 커밋 규칙의 미묘함 (Figure 8)

리더는 **현재 텀의 항목**이 과반에 복제됐을 때만 commitIndex 를 올린다. 이전 텀 항목은 현재 텀 항목이 커밋되면서 간접적으로 커밋된다. 이유: 이전 텀 항목이 과반에 복제됐더라도, 그걸 갖지 않은 노드가 더 큰 텀으로 리더가 돼 덮어쓸 수 있는 시나리오(논문 Figure 8)가 존재한다. 그래서 etcd 등은 새 리더가 즉시 **no-op 항목**을 현재 텀으로 추가해 이전 항목들을 안전하게 커밋한다.

### 안전성 증명의 핵심 한 줄

"리더 완전성(Leader Completeness): 어떤 텀에 커밋된 항목은 그 이후 모든 텀의 리더 로그에 존재한다." 선출 제한 + 커밋 규칙이 이를 보장하고, 로그 매칭이 "같은 인덱스에 같은 명령" 을 보장한다 → 모든 상태 머신이 같은 순서로 같은 명령을 적용(상태 머신 안전성).

### 스냅샷과 로그 압축

로그가 무한히 자라므로 상태 머신 스냅샷(lastIncludedIndex, lastIncludedTerm)을 찍고 그 이전 로그를 버린다. 너무 뒤처진 팔로워에겐 `InstallSnapshot` RPC 로 스냅샷을 보낸다. etcd 는 기본 10,000 항목마다 스냅샷.

### 멤버십 변경

노드 집합을 바꾸는 중에 **두 개의 과반**(옛 설정의 과반, 새 설정의 과반)이 서로 다른 리더를 뽑을 수 있다. Raft 의 해법: 한 번에 **하나의 노드만** 추가/제거(옛·새 과반이 반드시 겹침) 또는 joint consensus(두 설정의 과반을 모두 요구하는 전환 단계). etcd 는 전자(+ learner 상태: 투표권 없이 따라잡은 뒤 승격 — 새 노드가 쿼럼을 깨지 않도록).

### 선형화 읽기

리더에서 읽어도 "내가 아직 리더인가" 를 확인해야 한다(분단된 옛 리더 문제). 방법:
- **Read Index**: 읽기 전 과반에 하트비트 → 확인되면 현재 commitIndex 까지 적용 후 응답. RTT 1회.
- **Lease Read**: 하트비트 후 election timeout 동안은 "리더임" 을 가정하고 바로 읽기. 시계 드리프트에 의존 — etcd 는 기본 ReadIndex, 옵션으로 lease(`--experimental...`). 
- **Follower Read**: 팔로워가 리더에게 commitIndex 를 물어 그 지점까지 적용 후 읽기(etcd `serializable` 옵션은 이것도 생략 → stale 허용).

### 실무 매개변수

| 매개변수 | etcd 기본 | 의미 |
|---|---|---|
| heartbeat-interval | 100ms | 리더 → 팔로워 |
| election-timeout | 1000ms | 이걸 넘으면 선거. 하트비트의 10배가 권장. 리전 간이면 늘려야 |
| snapshot-count | 10,000 | 항목 수마다 스냅샷 |
| quota-backend-bytes | 2GB | DB 크기 상한 — 넘으면 **읽기 전용 알람** (k8s 클러스터 장애의 흔한 원인) |

fsync 지연이 합의 지연의 하한이다: etcd 는 `wal_fsync_duration_seconds` p99 < 10ms 를 요구. 느린 디스크 = 리더 교체 반복.

## Paxos vs Raft vs ZAB

| | Multi-Paxos | Raft | ZAB (ZooKeeper) |
|---|---|---|---|
| 리더 | 선택적(최적화) | 필수, 강한 리더 | 필수 |
| 로그 공백 | 허용(병렬 제안) | **불허**(연속) | 불허 |
| 선출 | 리더가 아무 로그여도 되고 빠진 걸 채움 | 가장 최신 로그만 | 가장 최신 |
| 이해/구현 | 어려움, 변종 많음 | 쉬움, 레퍼런스 구현 풍부 | ZK 전용 |
| 사용 | Chubby, Spanner, Cassandra LWT | etcd, Consul, TiKV, CockroachDB, Kafka KRaft, RabbitMQ 쿼럼 큐 | ZooKeeper, (과거) Kafka |

## 예시로 보기 — 이 프로젝트에서

**etcd 가 Kubernetes 의 진실이다**: kind 클러스터의 모든 오브젝트(Pod, Deployment, Secret)는 etcd 의 Raft 로그에 들어간다. `kubectl apply` 는 API 서버 → etcd 리더 → 과반 fsync → 응답. 단일 노드 kind 면 과반 = 1 이라 빠르지만, 3노드 컨트롤 플레인에서는 모든 쓰기가 합의를 거친다. [Kubernetes 구조](/kubernetes/notes/01-kubernetes-overview) 에서 "API 서버는 상태가 없고 etcd 가 전부" 인 이유.

```bash
kubectl -n kube-system exec etcd-study-control-plane -- sh -c \
  'ETCDCTL_API=3 etcdctl --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key endpoint status -w table'
# RAFT TERM, RAFT INDEX, LEADER 가 보인다
```

**Kafka KRaft**: 이 프로젝트의 `apache/kafka:3.9.1` 은 ZooKeeper 없이 **컨트롤러 쿼럼이 Raft** 로 메타데이터 로그(`__cluster_metadata` 토픽)에 합의한다. 브로커·토픽·파티션 리더 정보가 전부 Raft 로그의 레코드다. 단일 노드라 과반=1. [Kafka 내부](/kafka/notes/05-internals-storage-replication) 참고. 데이터 파티션 복제는 Raft 가 **아니다**(ISR 기반, 리더가 컨트롤러에 의해 지정) — "메타데이터는 합의, 데이터는 리더 기반 복제" 라는 흔한 분업.

**Redis Sentinel**: Raft 의 리더 선출 부분만 빌려 썼다(투표 요청에 에포크, 과반, 무작위 지연). 로그 복제는 없고, 선출된 Sentinel 이 페일오버를 **수행**한다. Redis Cluster 의 복제본 승격도 비슷하게 마스터들의 투표. 합의의 "값" 이 "누가 새 마스터인가" 하나뿐이라 단순하다.

**Patroni(PG HA)**: PostgreSQL 자체엔 선출이 없어 etcd/Consul 의 **리스**(TTL 키)로 "리더 키를 가진 노드가 프라이머리" 를 구현한다. 합의 시스템을 **락 서비스**로 쓰는 전형. 이 설계의 함정(GC 멈춤 후 옛 리더)은 [다음 노트](/distributed-systems/notes/06-transactions-coordination) 의 펜싱 토큰에서.

## 직접 구현하지 말아야 하는 이유

Raft 는 "이해 가능" 하지만 **정확히** 구현하기는 여전히 어렵다. Jepsen 이 etcd·Consul·RethinkDB·TiKV 에서 찾은 버그는 대부분 Raft 코어가 아니라 **그 주변**(클라이언트 재시도, 리스 읽기, 멤버십 변경, 스냅샷 복원)에 있었다. 결론: 합의가 필요하면 etcd/ZooKeeper/Consul 을 쓰거나, 검증된 라이브러리(etcd/raft, hashicorp/raft)를 쓰고, 그 위의 코디네이션 로직(락, 리더 선출)은 [8장](/distributed-systems/notes/08-verification-and-practice) 의 기법으로 검증한다.

## 실습 체크리스트

- [ ] Raft 시각화(thesecretlivesofdata.com/raft)를 보며 분할 투표와 네트워크 분단 시나리오를 따라간다
- [ ] kind 의 etcd 에 `etcdctl endpoint status` 로 텀·인덱스·리더를 확인하고, `kubectl apply` 한 번에 인덱스가 몇 늘어나는지 본다
- [ ] Figure 8 시나리오를 종이에 그려 "이전 텀 항목을 과반 복제만으로 커밋하면 왜 위험한지" 설명한다
- [ ] Kafka 의 `__cluster_metadata` 토픽을 `kafka-metadata-shell` 또는 `kafka-dump-log` 로 들여다본다
- [ ] election timeout 을 하트비트의 2배로 두면 어떤 일이 생길지(리더 교체 폭풍) 추론하고, etcd 문서의 권장값 근거를 확인한다
