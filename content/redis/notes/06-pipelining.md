---
title: 파이프라인 — RTT 를 없애라
order: 6
level: 중급
summary: 왕복 지연이 성능을 지배하는 이유, 파이프라인과 MULTI 의 차이, 클라이언트 라이브러리 활용
tags: [pipeline, RTT, 성능, 배치]
experiments: [pipeline-vs-sequential]
---

## 병목은 서버가 아니라 왕복

Redis 명령 하나는 µs 단위로 끝난다. 그런데 클라이언트가 명령을 보내고 응답을 기다리는 **왕복 시간(RTT)** 은 로컬 루프백도 50~100µs, 같은 데이터센터면 0.2~1ms, 리전 간이면 수십 ms 다.

1000개의 `SET` 을 순차 실행하면 서버는 1ms 도 안 쓰는데 클라이언트는 1000 × RTT 를 기다린다.

## 파이프라인

응답을 기다리지 않고 명령을 연속으로 보내고, 응답을 한꺼번에 읽는다.

```
# redis-cli
printf "SET a 1\r\nSET b 2\r\nINCR c\r\n" | redis-cli --pipe

# ioredis
const p = redis.pipeline();
for (let i = 0; i < 1000; i++) p.set(`k:${i}`, i);
const results = await p.exec();   // [[err, res], ...]
```

- RTT 가 N 번 → 1 번.
- 서버 입장에서도 syscall 수가 줄어 처리량이 올라간다 (read/write 묶음).
- 원자성은 **없다**. 중간에 다른 클라이언트 명령이 끼어들 수 있다. 필요하면 `MULTI/EXEC` 와 함께 쓴다 (ioredis `redis.multi()` 는 파이프라인 + 트랜잭션).

## 얼마나 묶을까

- 응답이 서버 메모리에 버퍼링되므로 한 번에 수십만 개를 보내면 메모리가 튄다. **수천~1만 개** 단위로 끊는 게 보통.
- 응답을 바로 봐야 하는 로직(읽은 값으로 분기)은 파이프라인으로 못 묶는다 → Lua.

## MGET/MSET, 가변 인자 명령

`MGET k1 k2 ... k100` 처럼 한 명령이 여러 키를 받으면 파이프라인조차 필요 없다. 가능하면 **다중 키 명령을 먼저** 고려하자.

| 방식 | RTT | 원자성 | 결과로 분기 |
|---|---|---|---|
| 순차 | N | 명령 단위 | 가능 |
| 파이프라인 | 1 | 없음 | 불가 |
| MULTI/EXEC | 1 | 전체 | 불가 |
| Lua | 1 | 전체 | 가능 |

## 클러스터에서의 파이프라인

키가 여러 슬롯에 흩어져 있으면 노드별로 파이프라인을 나눠야 한다. ioredis 의 `Cluster` 는 이를 자동으로 분할하지만, `MULTI` 는 같은 슬롯의 키끼리만 가능하다.

> 실험실의 **Pipeline** 실험에서 1000개 SET 을 두 방식으로 실행해 시간 차이를 직접 확인하자. 로컬에서도 수 배 이상 차이가 난다.

## 숫자로 보는 RTT 의 무게

명령 1000개를 보낼 때(서버 처리 1µs/명령 가정):

| 환경 | RTT | 순차 실행 | 파이프라인(1회) | 차이 |
|---|---|---|---|---|
| 같은 머신(루프백) | 0.05ms | 50ms | ~1ms | 50배 |
| 같은 AZ | 0.3ms | 300ms | ~2ms | 150배 |
| 다른 리전 | 30ms | 30초 | ~31ms | 1000배 |

서버가 실제로 일한 시간은 어느 경우든 1ms 남짓이다. **지연의 대부분은 빛의 속도와 커널을 오가는 비용**이다. 그래서 같은 코드도 운영 환경(원격 Redis)에서 로컬보다 수십 배 느려지고, 로컬 테스트로는 이 문제가 안 보인다.

## 서버 쪽에서는 무슨 일이

순차 실행이면 명령 하나마다 `read()` 시스템 콜 1회 + `write()` 1회 + 이벤트 루프 1바퀴가 돈다. 파이프라인이면 한 번의 `read()` 로 명령 수백 개를 버퍼에 받고, 응답을 모아 한 번에 `write()` 한다. 시스템 콜은 유저↔커널 전환 비용(수백 ns~µs)이 있어서, 서버 처리량 자체도 올라간다([운영체제 — 시스템 콜과 인터럽트](/os-internals/notes/05-syscalls-interrupts)).

```
$ redis-benchmark -t set -n 200000 -q
SET: 104712.05 requests per second
$ redis-benchmark -t set -n 200000 -q -P 16      # 파이프라인 16
SET: 1176470.62 requests per second              ← 같은 서버, 11배
```

운영체제 주제의 `os-context-switch` 실험은 같은 원리를 컨텍스트 스위치 수로 보여 준다 — 요청 1000개당 자발적 스위치가 파이프라인 16에서 70분의 1로 준다.

## 파이프라인의 함정

| 함정 | 증상 | 대처 |
|---|---|---|
| 한 번에 너무 많이 | 서버 `client-output-buffer` 증가, 메모리 급증, 다른 클라이언트 지연 | 1천~1만 개씩 끊기 |
| 결과 순서를 가정 안 함 | 결과 배열 인덱스로 매칭해야 함 | `exec()` 결과는 보낸 순서와 같다 |
| 에러가 섞임 | 중간 명령이 실패해도 나머지는 성공 | `[err, res]` 를 하나씩 확인 |
| 블로킹 명령(`BRPOP`) 포함 | 뒤 명령이 모두 대기 | 블로킹 명령은 따로 |
| 원자성 착각 | 다른 클라이언트 명령이 끼어듦 | 필요하면 `multi()` |

## 자동 파이프라이닝

ioredis 의 `enableAutoPipelining: true` 는 **같은 이벤트 루프 틱에 호출된 명령을 자동으로 하나의 파이프라인으로** 묶는다. 코드는 그대로인데 동시 요청이 많은 서버에서 RTT 수가 줄어든다.

```ts
const redis = new Redis({ enableAutoPipelining: true });
// 아래 세 호출이 한 번의 write 로 나간다
const [a, b, c] = await Promise.all([redis.get("a"), redis.get("b"), redis.get("c")]);
```

GraphQL 의 DataLoader 와 같은 아이디어다 — 한 틱 동안 모은 요청을 배치로 바꾼다([API 설계 — GraphQL 비교](/api-design/notes/05-graphql-comparison)).

## N+1 은 Redis 에서도 생긴다

```ts
// ✗ 노트 20개의 학습 시간을 하나씩 — 왕복 20번
for (const n of notes) times[n.slug] = Number(await r.get(`study:time:redis/${n.slug}`));

// ✓ MGET 한 번
const vals = await r.mget(...notes.map((n) => `study:time:redis/${n.slug}`));
```

HTTP 요청 하나가 Redis 를 몇 번 부르는지를 **증폭 계수**라고 한다. 성능 공학 주제의 `perf-k6-redis-path` 실험이 이 사이트 첫 화면의 증폭 계수를 실제로 쟀고, 그 결과로 첫 화면의 읽은 노트 수 집계가 주제마다 SMEMBERS 하던 것에서 한 번으로 바뀌었다([성능 — 데이터 접근 병목](/performance/notes/05-data-access-bottlenecks)).

## 예시로 보기 — 이 프로젝트에서

`src/lib/study.ts` 의 `getSubjectStudySeconds` 는 SCAN 으로 키를 찾고 MGET 으로 값을 한 번에 가져온다.

```ts
const [next, keys] = await r.scan(cursor, "MATCH", `study:time:${subject}/*`, "COUNT", 100);
if (keys.length) total += (await r.mget(...keys)).reduce((a, v) => a + Number(v ?? 0), 0);
```

반면 `addStudyTime` 은 세 명령을 `Promise.all` 로 동시에 보낸다. ioredis 는 하나의 커넥션 위에 명령을 순서대로 써 넣으므로(파이프라인처럼 응답을 기다리지 않고 연속 전송), 왕복은 사실상 1번이다. 다만 원자적이지는 않다 — 중간에 서버가 죽으면 INCRBY 만 반영될 수 있다. 학습 시간 통계라 감수하는 트레이드오프다.

## 파이프라인 크기를 정하는 실험

배치 크기를 1, 10, 100, 1000, 10000 으로 바꿔 가며 1만 개 SET 의 총 시간을 재면 대개 이런 모양이 나온다.

| 배치 크기 | 왕복 수 | 총 시간(로컬 Docker) | 서버 메모리 순간 증가 |
|---|---|---|---|
| 1 (순차) | 10,000 | ~900ms | 없음 |
| 10 | 1,000 | ~110ms | 작음 |
| 100 | 100 | ~25ms | 작음 |
| 1,000 | 10 | ~15ms | 수십 KB |
| 10,000 | 1 | ~14ms | 수백 KB(응답 버퍼) |

100~1000 부근에서 이득이 거의 포화된다. 그 이상은 시간은 거의 안 줄고 서버·클라이언트 버퍼만 커진다. 그래서 "수천 개 단위" 가 권장값이다. Docker Desktop 의 가상 네트워크는 루프백보다 RTT 가 커서 이 차이가 더 크게 보인다 — 이 사이트 벤치마크 페이지에서 파이프라인 유무가 30k vs 450k ops/s 로 벌어지는 이유다.

## 실습 체크리스트

- [ ] `redis-benchmark -t set -n 100000 -q` 와 `-P 16` 의 처리량 비교하기
- [ ] 실험실 파이프라인 실험을 돌리고 순차 대비 몇 배인지 기록하기
- [ ] ioredis 로 `enableAutoPipelining` 을 켜고 끈 상태에서 `Promise.all` 로 GET 1000개 시간 비교하기
- [ ] `MONITOR` 를 짧게 켜 놓고 파이프라인 요청이 서버에 어떻게 찍히는지 보기(운영에서는 금지)
- [ ] 이 사이트에서 N+1 패턴이 있는 곳을 하나 찾아 MGET 이나 파이프라인으로 바꾸는 방법 적기
