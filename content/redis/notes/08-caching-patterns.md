---
title: 캐싱 패턴과 함정
order: 8
level: 중급
summary: Cache-Aside, Write-Through, Write-Behind 비교와 stampede·stale·불일치 문제의 해법
tags: [캐시, cache-aside, stampede, 무효화, TTL]
experiments: [cache-aside, cache-stampede, expire-ttl]
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

## 패턴별 일관성과 실패 모드

| 패턴 | 읽기 지연 | 쓰기 지연 | 불일치 창 | 캐시 장애 시 |
|---|---|---|---|---|
| Cache-aside + 쓰기 시 DEL | 첫 미스만 느림 | DB 만큼 | 짧음(경쟁 시 TTL 까지) | DB 로 우회, 부하 급증 |
| Read-through(라이브러리가 대신 조회) | 동일 | 동일 | 동일 | 라이브러리 정책 |
| Write-through | 빠름 | DB + 캐시 | 거의 없음 | 쓰기 실패 처리 필요 |
| Write-behind | 빠름 | 아주 빠름 | DB 반영 지연 | **데이터 유실** |
| Refresh-ahead(만료 전 갱신) | 항상 빠름 | DB 만큼 | 갱신 주기 | DB 로 우회 |

## Cache-aside 의 경쟁 조건 — 시간축으로

```
요청 A (읽기)                     요청 B (쓰기)
GET user:1  → miss
DB 읽기 → v1 (옛 값)
                                  DB 쓰기 → v2
                                  DEL user:1
SET user:1 v1 EX 300   ← 옛 값을 캐시에 넣음! TTL 동안 v1 이 보인다
```

이 창은 "A 의 DB 읽기가 B 의 쓰기보다 먼저인데, A 의 SET 은 B 의 DEL 보다 늦게" 일 때만 생긴다. 드물지만 트래픽이 많으면 반드시 일어난다. 대응:

| 대응 | 원리 | 비용 |
|---|---|---|
| 짧은 TTL | 틀려도 금방 회복 | 적중률↓ |
| 지연 이중 삭제 | B 가 수백 ms 후 한 번 더 DEL | 지연 큐 필요 |
| 버전 비교 | 값에 version 을 넣고 SET 은 더 큰 버전만(Lua) | 구현 복잡 |
| CDC 무효화 | DB 커밋 로그(binlog/WAL)를 보고 DEL | Debezium 등 인프라([Kafka — CDC 와 Outbox](/kafka/notes/08-cdc-outbox-debezium)) |

## 스탬피드 방지 코드 — 뮤텍스 + stale 응답

```ts
async function getCached(key: string, load: () => Promise<string>, ttl = 300) {
  const raw = await redis.get(key);
  if (raw) {
    const { v, softExp } = JSON.parse(raw);
    if (Date.now() < softExp) return v;                     // 신선
    // 논리적으로 만료 → 한 명만 갱신, 나머지는 stale 반환
    if (await redis.set(`lock:${key}`, "1", "PX", 5000, "NX")) {
      void load().then((nv) => redis.set(key, JSON.stringify({ v: nv, softExp: Date.now() + ttl * 1000 }), "EX", ttl * 2));
    }
    return v;
  }
  // 완전 미스: 락을 얻은 요청만 DB, 나머지는 잠깐 기다렸다 재시도
  if (await redis.set(`lock:${key}`, "1", "PX", 5000, "NX")) {
    const v = await load();
    await redis.set(key, JSON.stringify({ v, softExp: Date.now() + ttl * 1000 }), "EX", ttl * 2);
    return v;
  }
  await new Promise((r) => setTimeout(r, 50));
  return getCached(key, load, ttl);
}
```

핵심은 **물리 TTL(ttl×2) > 논리 만료(ttl)** 로 두어, 만료 직후에도 옛 값을 돌려줄 수 있게 하는 것이다. 실험실의 **캐시 스탬피드** 실험이 이 차이를 DB 호출 수로 보여 준다(보호 없음 vs 뮤텍스).

## 무엇을 키에 넣을 것인가

| 키 설계 | 문제 |
|---|---|
| `page:/products?sort=price&page=2` 그대로 | 쿼리 파라미터 순서만 달라도 다른 키 → 적중률↓ |
| 정규화(파라미터 정렬, 기본값 제거) | ✓ |
| 사용자별 데이터를 공용 키에 | **다른 사람 데이터 노출** — 보안 사고 |
| 버전 접두어 `v3:product:42` | 배포 시 스키마가 바뀌어도 옛 캐시와 충돌 없음 ✓ |

캐시 계층 전체(브라우저·CDN·앱·Redis)에서의 키와 무효화는 [아키텍처 — 캐시 계층과 CDN](/architecture/notes/10-cache-layers-cdn)에서 이어진다.

## 측정 — 적중률만으로는 부족하다

| 지표 | 계산 | 해석 |
|---|---|---|
| 적중률 | hits / (hits + misses) | 80~95% 가 흔함. 낮으면 TTL·키 설계 점검 |
| 바이트 적중률 | 캐시로 아낀 바이트 / 전체 | 큰 값 위주면 이게 더 중요 |
| DB 부하 절감 | 캐시 도입 전후 DB QPS | 진짜 목적 |
| p99 지연 | 미스 경로의 지연 | 미스가 드물어도 p99 를 지배 |
| `evicted_keys` | 축출 속도 | 메모리 부족으로 적중률이 떨어지는 중인지 |

```
127.0.0.1:6379> INFO stats
keyspace_hits:182733
keyspace_misses:20419       ← 적중률 89.9%
evicted_keys:0
```

`keyspace_hits/misses` 는 **서버 전체** 기준이다. 캐시가 아닌 키(세션·카운터)의 GET 도 섞인다. 캐시 적중률은 앱에서 캐시 레이어별로 메트릭을 내는 것이 정확하다(`study_cache_hits_total{cache="product"}` 같은 카운터, [관측성 — 계측](/observability/notes/03-instrumentation-exporters)).

## 예시로 보기 — 이 프로젝트에서

이 사이트는 Redis 를 캐시로 쓰지 않는다 — 노트는 파일에서 읽고, Redis 는 학습 기록의 **원본**이다. 그래서 축출 정책이 `allkeys-lru` 인 환경에서 메모리가 차면 학습 기록이 지워질 수 있다. 원본 데이터와 캐시를 같은 인스턴스에 두는 흔한 실수다. 해결 방법은 둘 중 하나다:

1. 인스턴스를 나눈다(캐시용 `allkeys-lru`, 원본용 `noeviction`).
2. 같이 쓴다면 캐시 키에만 TTL 을 주고 `volatile-lru` 로 둔다 — TTL 없는 원본 키는 축출 대상이 아니다.

이 사이트가 노트 렌더링 결과를 캐시하게 된다면 2번이 가장 간단하다.

## 실전에서는 어디에 쓰이나

> 읽기가 쓰기보다 훨씬 많고 DB 가 먼저 지치는 서비스에서 가장 먼저 도입되는 것이 캐시다. 도입은 쉽지만 만료 순간·불일치·없는 키 조회가 실제 장애의 원인이 된다.

| 어디서 | 무엇을 풀려고 | 어떻게 쓰나 | 다른 선택지 |
|---|---|---|---|
| 커머스 상품 상세 | DB 조회 부하 감소 | Cache-aside, 쓰기 시 `DEL`, 버전 접두어 키 | Read replica |
| 미디어 메인 화면 인기 콘텐츠 | 인기 키 만료 순간의 DB 폭주 | 뮤텍스 + stale 응답(논리 만료 < 물리 TTL) | CDN 캐싱, 미리 갱신하는 배치 |
| 공개 API 의 없는 ID 조회 | 캐시 관통(penetration) | 짧은 TTL null 캐싱, Bloom 필터 | WAF·레이트리밋 |
| 핀테크 잔액 조회 화면 | 표시값과 DB 의 불일치 창 줄이기 | 짧은 TTL, CDC 기반 무효화 | 캐시하지 않고 DB 직접 조회 |
| 게임 이벤트 페이지 | 한 키에 트래픽 집중(hot key) | 앱 로컬 캐시(2-tier), 키 복제 | 클라이언트 측 캐싱(`CLIENT TRACKING`) |

**이럴 땐 안 맞는다**
- 사용자마다 다르고 재사용이 거의 없는 데이터 — 적중률이 낮아 메모리만 쓴다.
- 강한 일관성이 필요한 판단(출금 가능 여부, 재고 확정) — 표시용 캐시와 분리하고 판단은 DB 에서 한다.

**누가 매일 만나나** — 백엔드 개발자가 느린 API 를 캐시로 빠르게 만들 때, SRE 가 캐시 장애로 미스가 몰려 DB 까지 쓰러지는 사고를 대응할 때.

**면접·실무 단골 질문**
- Q. 쓰기 때 캐시를 갱신하지 않고 지우는 이유 → 동시 갱신 순서가 꼬여 옛 값이 남는 것을 막고, 다음 읽기가 최신으로 채운다.
- Q. 캐시 스탬피드를 어떻게 막나 → 뮤텍스, 확률적 조기 갱신, TTL 지터, stale-while-revalidate.

## 실습 체크리스트

- [ ] 실험실의 캐시 어사이드 실험과 스탬피드 실험을 돌리고 DB 호출 수 차이 기록하기
- [ ] 위 경쟁 조건 시간축을 두 콘솔로 재현해 옛 값이 캐시에 남는 것 확인하기
- [ ] `INFO stats` 로 적중률을 계산하고, 캐시가 아닌 키가 섞여 있다는 점을 설명하기
- [ ] `volatile-lru` 와 `allkeys-lru` 에서 TTL 없는 키가 축출되는지 비교하기
- [ ] 이 사이트에서 캐시할 만한 것(예: 노트 목록)을 하나 골라 키 설계와 TTL 을 정하기
