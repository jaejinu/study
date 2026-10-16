---
title: 고가용성 — 복제, Sentinel, Cluster
order: 11
level: 심화
summary: 마스터-레플리카 복제의 동작, Sentinel 의 자동 장애 조치, Cluster 의 해시 슬롯과 제약
tags: [복제, Sentinel, Cluster, 해시슬롯, failover]
experiments: [replication-basics, sentinel-failover, cluster-hash-slots]
---

## 복제 (Replication)

```
# 레플리카에서
REPLICAOF 10.0.0.1 6379
INFO replication
```

- **비동기** 복제. 마스터는 쓰기를 응답한 뒤 레플리카로 전파한다. 마스터가 죽으면 마지막 몇 ms 의 쓰기는 레플리카에 없을 수 있다.
- 첫 동기화: 마스터가 RDB 를 만들어 전송(full sync), 이후 복제 버퍼의 명령 스트림을 계속 전송.
- 끊겼다 재접속하면 `replication backlog` 안에 있으면 부분 재동기화(PSYNC), 아니면 다시 full sync.
- 레플리카는 기본 읽기 전용. 읽기 부하 분산에 쓰되 **지연된 값**을 읽을 수 있음을 감수한다.
- `WAIT 1 1000`: 최소 1개 레플리카가 ACK 할 때까지 최대 1초 대기. 내구성을 조금 올리지만 완전한 동기 복제는 아니다.
- `min-replicas-to-write 1` / `min-replicas-max-lag 10`: 연결된 레플리카가 부족하면 쓰기를 거부해 split-brain 피해를 줄인다.

## Sentinel

복제만으로는 마스터가 죽었을 때 누군가 수동으로 승격해야 한다. **Sentinel** 은 별도 프로세스(보통 3개 이상)로 마스터를 감시하고 자동 승격한다.

1. 각 Sentinel 이 마스터에 PING. 응답 없으면 **SDOWN** (주관적 다운).
2. 과반(`quorum`) Sentinel 이 동의하면 **ODOWN** (객관적 다운).
3. Sentinel 들이 리더를 뽑고, 리더가 레플리카 하나를 `REPLICAOF NO ONE` 으로 승격.
4. 나머지 레플리카를 새 마스터로 재지정. 클라이언트는 Sentinel 에게 "현재 마스터가 누구냐" 를 물어 접속한다.

```
sentinel monitor mymaster 10.0.0.1 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 60000
```

클라이언트(ioredis) 는 `new Redis({ sentinels: [...], name: 'mymaster' })` 로 자동 추적한다.
한계: 데이터는 여전히 한 마스터에 다 들어간다 (수직 확장만 가능).

![복제와 Sentinel](/diagrams/redis-replication-sentinel.svg)

## Cluster

데이터를 **16384 개 해시 슬롯**으로 나누고 여러 마스터가 슬롯을 나눠 가진다. 각 마스터는 레플리카를 둔다.

```
slot = CRC16(key) mod 16384
```

- 클라이언트가 엉뚱한 노드에 요청하면 `-MOVED 3999 10.0.0.2:6379` 응답. 스마트 클라이언트는 슬롯 맵을 캐시해서 바로 맞는 노드로 보낸다.
- 리샤딩 중에는 `-ASK` 로 임시 리다이렉트.
- 장애 조치는 Cluster 자체가 수행 (Sentinel 불필요). 과반 마스터가 살아 있어야 한다. 최소 3 마스터 + 3 레플리카.

### 제약

- **다중 키 명령은 같은 슬롯**이어야 한다. `MGET a b` 는 a, b 가 다른 슬롯이면 `CROSSSLOT` 에러.
  → **해시태그** `{user:1}:profile`, `{user:1}:orders` 처럼 `{}` 안의 부분만 해싱해 같은 슬롯에 둔다.
- `MULTI`, Lua 도 같은 슬롯의 키만.
- `SELECT` 불가 (DB 0 만).
- `KEYS`, `SCAN` 은 노드별로 돌려야 한다.
- Pub/Sub 은 전 노드 브로드캐스트 → `SSUBSCRIBE` 사용.

![Cluster 해시 슬롯](/diagrams/redis-cluster-slots.svg)

### 예시로 보기: 앱 코드는 어떻게 달라지나

```ts
// 단일/Sentinel: 키 제약 없음
await redis.mget("user:1", "user:2");
// Cluster: 다른 슬롯이면 CROSSSLOT → 해시태그로 묶거나 키별로 나눠 보낸다 (클러스터 클라이언트가 파이프라인을 노드별 분할)
await cluster.mget("{u1}:profile", "{u1}:settings");
const [a, b] = await Promise.all([cluster.get("user:1"), cluster.get("user:2")]);
```
[클라이언트 설계 심화](/redis/notes/17-client-design)에 Sentinel/Cluster 옵션이 정리되어 있다.

## 어떤 걸 고를까

| 요구 | 선택 |
|---|---|
| 데이터가 한 노드 메모리에 들어가고, 자동 장애 조치만 필요 | 복제 + Sentinel |
| 데이터/쓰기 처리량이 한 노드를 넘음 | Cluster |
| 운영을 맡기고 싶음 | 관리형 (ElastiCache, Redis Cloud, Upstash 등) |

## 로컬에서 체험하기

이 프로젝트에는 두 가지 실습 환경 스크립트가 있다 (brew 로 설치한 redis-server 를 호스트에서 여러 개 띄운다).

```bash
pnpm redis:ha          # master 6381 + replica 6382/6383 + sentinel 26381-26383
redis-cli -p 6381 INFO replication
redis-cli -p 26381 SENTINEL get-master-addr-by-name mymaster
redis-cli -p 6381 SHUTDOWN NOSAVE          # 마스터를 죽이면 1~3초 뒤 승격
redis-cli -p 26381 SENTINEL get-master-addr-by-name mymaster   # 바뀐 주소
tail -f redis/ha/run/26381.log             # +sdown, +odown, +switch-master 로그
pnpm redis:ha:down

pnpm redis:cluster     # master 3 + replica 3, 포트 7001-7006
redis-cli -p 7001 cluster nodes
redis-cli -p 7001 cluster keyslot user:1
redis-cli -p 7001 SET user:1 a             # (error) MOVED 10778 127.0.0.1:7002
redis-cli -c -p 7001 SET user:1 a          # -c: 리다이렉트 따라가기
pnpm redis:cluster:down
```

실험실의 **복제**, **Sentinel failover**, **Cluster 해시 슬롯** 실험이 이 환경에서 실제 장애 조치와 MOVED 리다이렉트를 재현한다.

## 복제 버퍼와 PSYNC — 끊겼다 붙을 때 무슨 일이

마스터는 레플리카로 보낸 명령 스트림을 **복제 백로그(repl-backlog)** 라는 원형 버퍼에 남긴다. 레플리카는 자신이 받은 위치(**replication offset**)를 기억한다.

```
레플리카 재접속: PSYNC <replid> <offset>
 ├─ replid 가 같고 offset 이 백로그 안 → +CONTINUE (빠진 부분만 전송, 부분 동기화)
 └─ 아니면                              → +FULLRESYNC (RDB 전체 생성·전송, 비쌈)
```

| 설정 / 지표 | 의미 |
|---|---|
| `repl-backlog-size` (기본 1MB) | 끊긴 동안 쌓일 쓰기량보다 커야 부분 동기화 가능. 쓰기 10MB/s × 끊김 30초 = 300MB |
| `master_repl_offset` vs 레플리카 `slave_repl_offset` | 차이가 복제 지연(바이트) |
| `sync_full`, `sync_partial_ok` | 전체·부분 동기화 횟수 — full 이 늘면 백로그가 작다는 신호 |
| `client-output-buffer-limit replica 256mb 64mb 60` | full sync 중 쌓이는 버퍼 한도 — 넘으면 끊기고 다시 full sync(무한 루프 위험) |

```
127.0.0.1:6381> INFO replication
role:master
connected_slaves:2
slave0:ip=127.0.0.1,port=6382,state=online,offset=88231,lag=0
slave1:ip=127.0.0.1,port=6383,state=online,offset=88231,lag=1
master_repl_offset:88231
repl_backlog_size:1048576
```

## 복제가 보장하지 않는 것

비동기 복제에서 마스터가 OK 를 돌려준 쓰기는 레플리카에 아직 없을 수 있다. 그 순간 마스터가 죽고 레플리카가 승격되면 **확인 응답한 쓰기가 사라진다**. 이걸 막을 수 없으므로 Redis 는 **선형화 가능(linearizable)** 하지 않다.

| 질문 | Redis(복제+Sentinel) |
|---|---|
| 확인된 쓰기가 장애 조치 후 사라질 수 있나 | 예(마지막 수 ms) |
| 레플리카 읽기가 최신인가 | 아니오(복제 지연만큼 옛 값) |
| 분단 시 두 마스터가 동시에 쓰기를 받나 | 짧게 가능 → `min-replicas-to-write` 로 완화 |
| `WAIT 2 100` 이면 안전한가 | 더 안전하지만 장애 조치가 그 레플리카를 고른다는 보장은 없음 |

일관성 모델과 쿼럼으로 이 한계를 정확히 말하는 법은 [분산 시스템 — 일관성 모델](/distributed-systems/notes/03-consistency-models)과 [복제](/distributed-systems/notes/04-replication)에 있다.

## Sentinel 장애 조치 타임라인

| 시각 | 이벤트 | 로그 |
|---|---|---|
| 0s | 마스터 정지 | — |
| 5s (`down-after-milliseconds`) | 각 Sentinel 이 주관적 다운 판정 | `+sdown master mymaster` |
| 5~6s | quorum 동의 | `+odown master mymaster #quorum 2/2` |
| 6s | Sentinel 리더 선출(Raft 와 비슷한 투표) | `+vote-for-leader`, `+elected-leader` |
| 6~7s | 레플리카 선택(우선순위·offset·runid) → 승격 | `+selected-slave`, `+promoted-slave` |
| 7~8s | 나머지 재지정, 클라이언트에 새 주소 | `+switch-master mymaster 127.0.0.1 6381 127.0.0.1 6382` |

**클라이언트 관점의 다운타임 = 감지(5s) + 승격(1~3s) + 클라이언트 재연결**. `down-after-milliseconds` 를 줄이면 빨라지지만 일시적 지연(GC·네트워크)에 오판(불필요한 장애 조치)이 늘어난다. 실험실의 **Sentinel failover** 실험이 이 구간을 실제로 재고, 장애 실험실·SRE 주제는 이를 알림·SLO 관점에서 다룬다.

## Cluster 리샤딩과 장애

| 동작 | 명령 | 클라이언트가 보는 것 |
|---|---|---|
| 슬롯 이동 | `redis-cli --cluster reshard` | 이동 중 키는 `-ASK`, 끝나면 `-MOVED` |
| 노드 추가 | `--cluster add-node` + reshard | 슬롯 맵 갱신 |
| 마스터 장애 | 레플리카 자동 승격(`cluster-node-timeout`, 기본 15s) | 그 슬롯만 잠시 실패 |
| 과반 마스터 장애 | 클러스터 전체 `CLUSTERDOWN` | 전체 실패(`cluster-require-full-coverage` 설정 따라) |

**슬롯 불균형**은 키 분포가 아니라 **트래픽** 기준으로 봐야 한다. 해시태그를 남용해 `{tenant:big}` 하나에 모든 키를 몰면 그 슬롯의 노드만 바쁘다. 파티셔닝의 일반 원리(핫스팟·리밸런스)는 [분산 시스템 — 파티셔닝](/distributed-systems/notes/07-partitioning)에 있다.

## 예시로 보기 — 이 프로젝트에서

| 환경 | 포트 | 무엇을 연습하나 |
|---|---|---|
| `pnpm redis:ha` | 6381~6383, 26381~26383 | 비동기 복제, Sentinel 장애 조치, `WAIT` |
| `pnpm redis:cluster` | 7001~7006 | 해시 슬롯, MOVED/ASK, 해시태그, CROSSSLOT |
| kind `study` 클러스터의 Redis StatefulSet | 클러스터 안 6379 | Pod 재시작 후 PVC 로 데이터 유지 |

```bash
# 복제 지연을 눈으로 보기: 마스터에 쓰고 레플리카에서 바로 읽기
redis-cli -p 6381 SET k v1 && redis-cli -p 6382 GET k   # 대개 v1, 부하 중엔 nil 일 수도
redis-cli -p 6381 SET k v2 && redis-cli -p 6381 WAIT 2 100 && redis-cli -p 6382 GET k   # WAIT 후엔 v2
```

## 실습 체크리스트

- [ ] `pnpm redis:ha` 로 띄우고 `INFO replication` 의 offset 과 lag 읽기
- [ ] 마스터를 죽인 뒤 Sentinel 로그에서 sdown → odown → switch-master 까지의 시간 재기
- [ ] 레플리카를 잠깐 끊었다 붙여 `sync_partial_ok` 가 오르는지, 백로그를 줄였을 때 `sync_full` 이 오르는지 비교하기
- [ ] `pnpm redis:cluster` 에서 `MGET` 으로 CROSSSLOT 에러를 내고 해시태그로 해결하기
- [ ] 실험실의 복제·Sentinel·Cluster 실험 세 개를 차례로 돌리기
