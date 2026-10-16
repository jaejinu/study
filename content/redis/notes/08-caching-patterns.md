---
title: 캐싱 패턴과 함정
order: 8
level: 중급
summary: Cache-Aside, Write-Through, Write-Behind 비교와 stampede·stale·불일치 문제의 해법
tags: [캐시, cache-aside, stampede, 무효화, TTL]
experiments: [cache-aside, expire-ttl]
---

## Cache-Aside (Lazy Loading)

가장 널리 쓰는 패턴. 애플리케이션이 캐시와 DB 를 직접 다룬다.

```
읽기:  v = GET key
       if v == nil: v = DB.read(); SET key v EX ttl
       return v
쓰기:  DB.write(); DEL key        # 갱신이 아닌 삭제
```

- 요청된 데이터만 캐시된다 (메모리 효율).
- 첫 요청은 느리다 (cold miss).
- 쓰기 시 **SET 이 아니라 DEL** 을 하는 이유: 두 요청이 동시에 DB 를 갱신하고 캐시를 SET 하면 순서가 꼬여 오래된 값이 남을 수 있다. 삭제하면 다음 읽기가 최신 값을 채운다.

## Write-Through

쓰기가 캐시를 거쳐 DB 로 간다. 캐시는 항상 최신이지만 쓰기 지연이 커지고, 읽히지 않을 데이터도 캐시된다.

## Write-Behind (Write-Back)

캐시에만 쓰고 DB 반영은 비동기로 모아서 한다. 쓰기가 매우 빠르지만 캐시 장애 시 유실 위험. 조회수 집계처럼 "조금 잃어도 되는" 데이터에 적합. Redis 로 구현하려면 Stream/List 에 변경을 쌓고 워커가 DB 에 flush.

## 함정 1 — Cache Stampede (Thundering Herd)

인기 키가 만료되는 순간 수백 요청이 동시에 miss → DB 폭주.

해법:
1. **뮤텍스**: miss 시 `SET lock:key 1 NX PX 3000` 을 얻은 요청만 DB 를 읽고, 나머지는 잠시 대기 후 캐시 재시도.
2. **확률적 조기 갱신 (PER)**: TTL 이 얼마 안 남았을 때 일부 요청이 미리 갱신. `if now - delta*beta*log(rand()) >= expiry: refresh`.
3. **TTL 지터**: 동시 만료 자체를 피한다.
4. **Stale-while-revalidate**: 만료된 값도 일단 돌려주고 백그라운드에서 갱신. 논리적 만료 시각을 값 안에 넣고 물리 TTL 은 더 길게.

## 함정 2 — Cache Penetration

존재하지 않는 키를 계속 조회하면 매번 DB 로 간다 (악의적일 수도).
- **null 캐싱**: 없다는 사실도 짧은 TTL 로 캐시 (`SET key "" EX 60`).
- **Bloom filter**: 존재할 수 있는 키 집합을 미리 올려 두고 없으면 즉시 거절.

## 함정 3 — 불일치 (Stale Data)

DB 갱신과 캐시 삭제 사이의 작은 창에서 다른 요청이 옛 값을 다시 캐시할 수 있다.
- 허용 가능한 TTL 로 "결국 일관성" 수용.
- **지연 이중 삭제**: 삭제 → DB 갱신 → 수백 ms 후 다시 삭제.
- CDC(binlog) 기반으로 DB 변경을 캐시 무효화 이벤트로 전파.

## 함정 4 — Hot Key

단일 키에 트래픽이 몰리면 클러스터여도 한 노드만 바쁘다.
- 로컬(인프로세스) 캐시를 앞단에 둔다 (2-tier).
- 키를 복제해 `key:{0..9}` 중 무작위로 읽는다.

## 무엇을 캐시할까

- 읽기 ≫ 쓰기인 데이터.
- 계산 비용이 큰 결과 (집계, 추천, 렌더링된 HTML 조각).
- 직렬화 형식: JSON 은 편하고, MessagePack/Protobuf 는 작다. 값이 크면 압축도 고려.

## 측정

```
INFO stats     # keyspace_hits / keyspace_misses → 히트율
```
히트율이 낮다면 TTL 이 너무 짧거나, 키 설계가 분산돼 있거나, 캐시할 가치가 없는 데이터일 수 있다. 대시보드에서 현재 히트율을 볼 수 있다.
