---
title: "액터·CSP·async/await·구조적 동시성 — 공유하지 않고 협력하기"
order: 7
level: 심화
summary: "공유 메모리 대신 메시지로 협력하는 두 모델 — 액터(Erlang·Akka: 우편함과 감독)와 CSP(Go: 채널과 select) — 의 차이, 유한 채널과 백프레셔, async/await 와 함수 색깔 문제, 구조적 동시성(작업의 수명을 블록에 묶기)과 취소 전파, Java 가상 스레드와 Node 이벤트 루프의 위치, 그리고 메시지 전달이 분산 시스템으로 넘어가는 경계"
tags: [액터, CSP, 채널, 메시지 전달, 백프레셔, async/await, 구조적 동시성, 취소, 가상 스레드]
experiments: [conc-channel-csp]
---

## 공유하지 않으면 경합도 없다

2~6편은 **공유 메모리**를 안전하게 다루는 방법이었다. 이 노트는 반대 방향이다. 상태를 **한 주인만** 가지게 하고, 다른 실행 단위는 **메시지**로 요청한다. 락이 코드에서 사라지는 대신 메시지 순서·유실·지연·흐름 제어를 생각해야 한다 — 그리고 그 생각은 그대로 분산 시스템으로 이어진다.

## 액터 모델

**액터(Hewitt 1973, Erlang, Akka, Orleans)**: 상태 + 우편함(mailbox) + 행동. 액터는 메시지를 **하나씩** 처리하므로 자기 상태에 대해 경합이 없다. 메시지를 받으면 할 수 있는 일은 세 가지뿐이다: 다른 액터에 메시지 보내기, 새 액터 만들기, 다음 메시지를 처리할 행동(상태) 정하기.

```erlang
loop(Balance) ->
  receive
    {deposit, Amt}        -> loop(Balance + Amt);
    {withdraw, Amt, From} when Amt =< Balance -> From ! ok, loop(Balance - Amt);
    {withdraw, _, From}   -> From ! insufficient, loop(Balance)
  end.
```

[경합 조건](/concurrency/notes/02-race-conditions-critical-sections)의 잔액 문제가 구조적으로 사라진다. 확인과 차감이 한 메시지 처리 안에서 일어나고, 그 사이 다른 메시지는 우편함에서 기다리기 때문이다.

Erlang 의 진짜 힘은 **감독 트리(supervision tree)** 다. 액터가 죽으면 부모(감독자)가 정책(그 하나만 재시작, 형제까지 재시작…)에 따라 다시 띄운다. "**죽게 두라(let it crash)**" — 방어 코드 대신 깨끗한 재시작에 기대는 설계는 Kubernetes 의 Pod 재시작([Kubernetes 03](/kubernetes/notes/03-pod-deployment))과 같은 철학이다.

## CSP — 채널로 잇기

**CSP(Communicating Sequential Processes, Hoare 1978)**: 독립 프로세스들이 **채널**로 값을 주고받는다. Go 의 고루틴과 채널, Clojure core.async, Kotlin 채널이 이 계열이다.

| | 액터 | CSP |
|---|---|---|
| 주소 | 액터에 이름(주소)이 있다 | 채널에 이름이 있고 프로세스는 익명 |
| 버퍼 | 우편함은 보통 무제한 | 채널은 버퍼 크기 지정 (0 = 동기) |
| 보내기 | 비동기 (보내고 잊음) | 버퍼가 차면 **막힘** |
| 여러 입력 기다리기 | 패턴 매칭 receive | `select` |
| 분산 | Erlang 은 노드 너머로 투명 | 주로 한 프로세스 안 |

```go
jobs := make(chan Job, 16)          // 유한 버퍼 → 생산자가 너무 빠르면 막힌다(백프레셔)
results := make(chan Result)
for w := 0; w < 4; w++ { go worker(jobs, results) }
select {
case r := <-results: handle(r)
case <-time.After(2 * time.Second): log.Println("timeout")
case <-ctx.Done(): return          // 취소
}
```

### 유한 채널과 백프레셔

[CSP 채널 실험](/concurrency/lab/conc-channel-csp)은 SharedArrayBuffer 링 버퍼로 생산자-소비자 채널을 만들어 메시지 10만 개를 버퍼 1·16·1024 로 보낸다.

- **버퍼 1** 은 거의 동기 채널이다. 메시지마다 생산자와 소비자가 서로를 깨우며 핑퐁하므로 생산자 대기 횟수가 가장 많고 처리량이 가장 낮다.
- **버퍼가 크면** 메시지가 묶음으로 흘러 깨우기(컨텍스트 스위치)가 줄고 처리량이 오른다.
- 그러나 큰 버퍼는 **지연을 숨기는 큐**다. 소비자가 느려졌다는 신호(생산자가 막힘)가 늦게 온다. 네트워크의 [버퍼블로트](/network-protocols/notes/05-loss-latency-throughput)와 같은 원리다.

**무제한 큐는 백프레셔가 없다.** 액터 우편함이 무제한이면 느린 액터 앞에 메시지가 쌓여 메모리가 터진다. 그래서 Akka 는 bounded mailbox 와 Akka Streams(리액티브 스트림)를, Kafka 는 소비자가 당겨 가는(pull) 모델을 쓴다([메시징 01](/messaging/notes/01-queue-topic-log-models)).

## async/await — 스레드 없이 기다리기

async/await 는 이벤트 루프·코루틴 위에서 **비동기 코드를 순차 코드처럼** 쓰게 해 준다. 스레드를 막지 않고 기다리므로 적은 스레드로 많은 동시 작업을 다룬다.

```js
const [user, orders] = await Promise.all([getUser(id), getOrders(id)]);   // 동시에
```

대가는 **함수 색깔 문제**다. `async` 함수는 `async` 함수에서만 기다릴 수 있으므로 비동기가 호출 사슬을 따라 위로 번진다. 한편 [경합 조건](/concurrency/notes/02-race-conditions-critical-sections)에서 보았듯 `await` 지점마다 다른 작업이 끼어들 수 있다.

Java 21 의 **가상 스레드**는 다른 해법이다. 코드는 평범한 블로킹 코드(색깔 없음)인데, 블로킹 지점에서 런타임이 가상 스레드를 캐리어 스레드에서 떼어 낸다. 스레드 수십만 개를 "그냥 블로킹" 으로 쓸 수 있다([Java 13편: 가상 스레드](/java/notes/13-virtual-threads-structured) 주제). Node 는 이벤트 루프 + async/await 쪽이다([Node.js](/nodejs) 주제).

## 구조적 동시성 — 작업의 수명을 블록에 묶기

`go f()`, `new Thread().start()`, 기다리지 않는 Promise 는 **goto 처럼** 제어 흐름을 흩뿌린다. 시작한 작업이 언제 끝나는지, 실패를 누가 받는지, 취소는 누가 전하는지 알 수 없다.

**구조적 동시성**: 동시 작업을 **블록(스코프) 안에서만** 시작할 수 있고, 블록을 나갈 때 그 안의 모든 작업이 끝나 있어야 한다.

```java
// Java 21+ (preview → JEP 505)
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
  var user  = scope.fork(() -> findUser(id));
  var order = scope.fork(() -> fetchOrder(id));
  scope.join().throwIfFailed();          // 하나가 실패하면 나머지는 취소된다
  return new View(user.get(), order.get());
}                                         // 여기서 새는 작업이 없다는 것이 보장된다
```

| 언어 | 구조적 동시성 도구 |
|---|---|
| Kotlin | `coroutineScope { }`, 부모-자식 Job |
| Swift | `async let`, `TaskGroup` |
| Python | Trio nursery, `asyncio.TaskGroup` (3.11) |
| Java | `StructuredTaskScope` |
| Go | `errgroup.Group` + `context` (관례) |
| JavaScript | `Promise.all` + `AbortController` (관례, 언어 차원은 아님) |

### 취소 전파

사용자가 페이지를 떠났거나 상위 요청이 타임아웃되면, 그 아래의 모든 작업을 멈춰야 자원이 낭비되지 않는다. Go 의 `context`, JavaScript 의 `AbortSignal`, gRPC 의 데드라인 전파([API 설계 04](/api-design/notes/04-errors-retries-deadlines))가 같은 문제를 푼다. 구조적 동시성은 취소를 **트리 모양으로 자동 전파**한다.

## 분산으로 넘어가는 경계

메시지 전달을 프로세스 밖으로 꺼내면 분산 시스템이다. 같은 질문이 더 거칠게 돌아온다.

| 한 프로세스 안 | 분산 |
|---|---|
| 메시지는 유실되지 않는다 | 유실·중복·지연·재정렬 ([분산 시스템 01](/distributed-systems/notes/01-why-hard)) |
| 받은 쪽이 죽으면 같이 죽는다 | 부분 실패 — 상대가 죽었는지 느린지 모른다 |
| 채널 버퍼 = 백프레셔 | 큐 깊이·소비자 랙 감시 ([메시징 07](/messaging/notes/07-operations-observability)) |
| 메시지 순서 = 송신 순서 | 파티션 안에서만 순서 ([Kafka 02](/kafka/notes/02-topics-partitions)) |
| 정확히 한 번 | 최소 한 번 + 멱등 소비자 ([메시징 04](/messaging/notes/04-delivery-guarantees-delay)) |
| 액터 감독 트리 | 오케스트레이터 재시작, 사가의 보상 |

Erlang 은 처음부터 이 경계를 지우려 했다. 노드 너머의 액터에도 똑같이 메시지를 보낸다. 대신 "메시지는 유실될 수 있다" 를 처음부터 모델에 넣었다. 로컬 메시지 전달을 쓸 때부터 **유실·중복을 견디는 설계**를 습관으로 들이면 분산으로 넘어갈 때 다시 짤 일이 줄어든다.

## 예시로 보기 — 이 프로젝트에서

| 이 사이트 | 이 노트의 개념 |
|---|---|
| [CSP 채널 실험](/concurrency/lab/conc-channel-csp) | 유한 채널, 버퍼 크기와 백프레셔 |
| 실험 러너의 워커 (`worker_threads` + `postMessage`) | 메시지 전달 — 워커는 결과를 복사해 보낸다 |
| Kafka 컨슈머 그룹 | 파티션 = 소비자 하나가 소유하는 채널 (단일 작성자 원칙) |
| [RabbitMQ prefetch](/messaging/notes/02-rabbitmq) | 소비자 쪽 백프레셔 — 처리 중인 메시지 수 상한 |
| AI 에게 묻기의 `AbortController` | 사용자가 '중단' 을 누르면 스트림·툴 루프까지 취소가 전파된다 |

## 실습 체크리스트

- [ ] [CSP 채널 실험](/concurrency/lab/conc-channel-csp)을 돌려 버퍼 1·16·1024 의 처리량과 생산자 대기 횟수를 비교하기
- [ ] 같은 은행 계좌 문제를 (a) 락으로 (b) 액터(메시지 큐 + 처리 루프 하나)로 구현해 보기
- [ ] Node 에서 `AbortController` 로 `Promise.all` 의 하위 작업을 모두 취소하는 코드를 써 보기
- [ ] "무제한 큐는 백프레셔가 없다" 를 실제로 메모리가 불어나는 예로 보여 주기
- [ ] 로컬 메시지 전달 코드를 분산으로 옮길 때 새로 생각해야 할 것 다섯 가지를 위 표에서 골라 설명하기
