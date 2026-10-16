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
