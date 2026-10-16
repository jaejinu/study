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

## 체크리스트

- [ ] `SET key token NX PX ttl` 한 명령으로 획득하는가
- [ ] 토큰은 프로세스마다 유일한가 (UUID, random bytes)
- [ ] 해제는 Lua 로 토큰을 검증하는가
- [ ] 작업 시간이 TTL 을 넘을 수 있는가 → watchdog 또는 fencing
- [ ] 락 없이도 멱등하게 만들 수 있는가 (가장 좋은 락은 필요 없는 락)
