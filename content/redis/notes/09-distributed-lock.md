---
title: 분산 락
order: 9
level: 중급
summary: SET NX PX 기반 락의 정확한 구현, 왜 토큰과 Lua 가 필요한지, Redlock 논쟁과 fencing token
tags: [락, SET NX, Redlock, fencing, 동시성]
experiments: [distributed-lock, lua-atomic]
---

## 요구사항

여러 프로세스/서버 중 **하나만** 임계 영역에 들어가야 한다. 예: 같은 주문을 두 워커가 동시에 처리하지 않기, 스케줄 작업의 중복 실행 방지.

## 올바른 단일 인스턴스 락

```
# 획득: 없을 때만, 만료와 함께, 한 명령으로
SET lock:order:1 <random-token> NX PX 30000     # OK 면 획득

# 해제: 내 토큰일 때만 삭제 (Lua 로 원자적으로)
EVAL "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end" 1 lock:order:1 <random-token>
```

각 요소가 필요한 이유:

| 요소 | 없으면 |
|---|---|
| `NX` | 이미 잡힌 락을 덮어쓴다 |
| `PX` (TTL) | 락 소유자가 죽으면 영원히 잠긴다 (deadlock) |
| 한 명령 (`SET NX PX`) | `SETNX` 후 `EXPIRE` 사이에 죽으면 TTL 없는 락이 남는다 |
| 랜덤 토큰 | 내 락이 만료된 뒤 남이 잡은 락을 내가 `DEL` 해 버린다 |
| Lua 해제 | `GET` 확인과 `DEL` 사이에 만료+재획득이 일어날 수 있다 |

## TTL 과 작업 시간

TTL 보다 작업이 오래 걸리면 락이 풀린 상태에서 두 워커가 동시에 돈다. 선택지:

1. TTL 을 넉넉히 (복구 시간과 트레이드오프).
2. **Watchdog**: 작업 중 주기적으로 `PEXPIRE` 연장 (토큰 확인 Lua 로). Redisson 이 이렇게 한다.
3. **Fencing token**: 락을 잡을 때마다 증가하는 번호(`INCR lock:seq`)를 받아 보호 대상 리소스(DB, 스토리지)에 함께 전달. 리소스는 더 작은 토큰의 요청을 거부한다. Martin Kleppmann 이 제안한, 락이 풀려도 안전한 유일한 방법.

## 재시도

획득 실패 시 즉시 재시도하면 서버를 두드린다. 짧은 랜덤 백오프(예: 50~150ms) 후 재시도하고, 최대 대기 시간을 둔다.
알림이 필요하면 락 해제 시 `PUBLISH lock:order:1 released` 로 대기자를 깨울 수 있다.

## Redlock 과 그 논쟁

단일 인스턴스는 마스터 장애 시 레플리카에 락이 복제되지 않았을 수 있어 두 클라이언트가 동시에 락을 가질 수 있다.
**Redlock** 은 독립적인 N(보통 5)개 인스턴스 중 과반에서 락을 획득하는 알고리즘이다.

반론(Kleppmann): 시계 점프, GC 멈춤, 네트워크 지연 때문에 어떤 타이밍 가정도 깨질 수 있고, 결국 **fencing token 없이는 정확성(correctness)을 보장 못 한다**. Redlock 은 "효율성(같은 일을 두 번 하지 않기)" 용도로는 충분하지만 "정확성(절대 둘이 동시에 하면 안 됨)" 용도로는 Zookeeper/etcd 같은 합의 시스템을 쓰라는 입장.

실무 결론:
- 중복 실행이 "비효율" 수준이면 단일 인스턴스 `SET NX PX` + 토큰 + Lua 로 충분.
- 중복 실행이 "데이터 손상" 수준이면 fencing token 을 리소스 측에서 검증하거나, 애초에 멱등하게 설계한다.

## 설계 체크리스트

- [ ] `SET key token NX PX ttl` 한 명령으로 획득하는가
- [ ] 토큰은 프로세스마다 유일한가 (UUID, random bytes)
- [ ] 해제는 Lua 로 토큰을 검증하는가
- [ ] 작업 시간이 TTL 을 넘을 수 있는가 → watchdog 또는 fencing
- [ ] 락 없이도 멱등하게 만들 수 있는가 (가장 좋은 락은 필요 없는 락)

## 락이 깨지는 시나리오 — 시간축으로

```
시각   클라이언트 A                       Redis                      스토리지
t0     SET lock tokA NX PX 10000 → OK
t1     (GC 멈춤 / 네트워크 지연 15초)
t10                                       lock 만료
t11                                       B: SET lock tokB NX → OK
t12                                                                  B 가 write(…)
t16    깨어남, 아직 락을 가졌다고 믿음
t16    write(…)                                                      ✗ A 의 옛 쓰기가 B 의 것을 덮음
t17    EVAL 해제 (tokA ≠ tokB → 0)        ← 해제는 안전했지만 이미 늦었다
```

토큰 + Lua 해제는 **남의 락을 지우는 사고**만 막는다. "락이 풀린 줄 모르고 쓰는 사고" 는 막지 못한다. 그건 **스토리지가 거절**해야만 막을 수 있다 — 펜싱 토큰이다.

## 펜싱 토큰 — 스토리지 쪽 구현

```lua
-- 락 획득과 동시에 단조 증가 번호를 받는다
-- KEYS[1]=lock, KEYS[2]=fence seq, ARGV[1]=token, ARGV[2]=ttl
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return redis.call('INCR', KEYS[2])     -- 33, 34, 35 …
end
return -1
```

```sql
-- 스토리지(PostgreSQL)는 더 작은 펜스의 쓰기를 거부한다
UPDATE jobs SET result = $1, fence = $2
 WHERE id = $3 AND fence < $2;           -- A(33) 의 늦은 쓰기는 B(34) 이후라 0 rows
```

분산 시스템 주제의 `ds-fencing-token` 실험이 이 시나리오(만료 후 깨어난 옛 소유자의 쓰기 거부)를 Redis 로 재현한다. 원리와 Redlock 논쟁의 전체 맥락은 [분산 시스템 — 트랜잭션과 코디네이션](/distributed-systems/notes/06-transactions-coordination)에 있다.

## 워치독 — 작업이 길 때 TTL 연장

```ts
async function withLock<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  if (!(await redis.set(key, token, "PX", ttl, "NX"))) throw new Error("locked");
  const extend = setInterval(() => {
    // 내 토큰일 때만 연장 (Lua)
    void redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) end return 0", 1, key, token, ttl);
  }, ttl / 3);
  try {
    return await fn();
  } finally {
    clearInterval(extend);
    await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, token);
  }
}
```

워치독은 "프로세스가 살아 있는 동안은 락 유지, 죽으면 TTL 후 해제" 를 만든다. 하지만 **프로세스가 살아 있는데 멈춘(GC·스왑)** 경우엔 연장도 멈추므로 결국 위 시나리오가 다시 가능하다. 그래서 정확성이 필요하면 워치독이 있어도 펜싱이 필요하다.

## 락 대신 쓸 수 있는 것들

| 원하는 것 | 락 없는 방법 |
|---|---|
| 같은 요청 두 번 처리 금지 | 멱등 키: `SET idem:<key> <result> NX EX 86400` |
| 재고 동시 차감 | 단일 명령(`DECR`) 또는 Lua 조건부 차감([트랜잭션과 Lua](/redis/notes/05-transactions-lua)) |
| 스케줄 작업 중복 방지 | 리더 1명만 실행(k8s CronJob `concurrencyPolicy: Forbid`) |
| 큐 메시지 하나를 한 워커만 | 컨슈머 그룹(Stream) — 브로커가 배분 |
| 같은 사용자 요청 순서 보장 | 사용자 ID 로 파티션(같은 키 → 같은 워커) |

"가장 좋은 락은 필요 없는 락" 이다. 락은 장애 시 모든 대기자를 멈추게 하는 단일 실패점이 되기 쉽다.

## 운영 관점

| 증상 | 원인 | 확인 |
|---|---|---|
| 락 획득 실패율 급증 | 소유자가 죽고 TTL 대기 중, 혹은 작업 지연 | `PTTL lock:*` |
| 같은 작업 중복 실행 | TTL < 작업 시간 | 작업 시간 p99 vs TTL |
| 모든 요청 지연 | 재시도가 백오프 없이 Redis 를 두드림 | `instantaneous_ops_per_sec` 급증 |
| 장애 조치 후 이중 소유 | 비동기 복제로 락 키 유실 | Sentinel 로그 `+switch-master` 시각 |

## 예시로 보기 — 이 프로젝트에서

- 실험실의 **분산 락** 실험은 두 워커가 같은 락을 다툴 때 `NX` 가 한 쪽만 통과시키는 것과, 토큰 없는 `DEL` 이 남의 락을 지우는 사고를 재현한다.
- 장애 실험실의 실험들은 "Redis 를 잠깐 멈추는" 장애를 주입한다. 그 사이 TTL 이 지나 락이 풀리는지 관찰하면 위 시간축이 그대로 보인다. 장애 주입 실험은 멈춘 Redis 를 반드시 되돌리도록 **데드맨 스위치**(일정 시간 뒤 자동 복구)를 둔다 — 실험이 중간에 죽으면 Redis 가 몇 시간이나 멈춰 있을 수 있기 때문이다([SRE — 사고와 포스트모템](/sre/notes/05-incident-postmortem)).

## 실습 체크리스트

- [ ] 두 콘솔에서 `SET lock t1 NX PX 5000` 과 `SET lock t2 NX PX 5000` 을 쳐 한쪽만 OK 인 것 확인하기
- [ ] 토큰 없는 `DEL` 로 남의 락을 지우는 사고를 재현하고, Lua 해제로 막히는 것 확인하기
- [ ] 위 펜싱 Lua 를 실행해 락을 잡을 때마다 번호가 증가하는 것 보기
- [ ] 분산 시스템 주제의 펜싱 토큰 실험을 돌리고 옛 소유자의 쓰기가 거부되는 단계를 찾기
- [ ] 이 사이트에서 락 없이 멱등 키로 바꿀 수 있는 곳이 있는지 생각해 보기
