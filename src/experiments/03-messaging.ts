import type { Experiment } from "./types";

export const pubsub: Experiment = {
  id: "pubsub",
  title: "Pub/Sub: 구독자에게 즉시 전달, 저장은 없음",
  category: "메시징",
  summary: "SUBSCRIBE 한 커넥션이 PUBLISH 메시지를 받는다. 구독 전 메시지는 유실됨을 확인",
  notes: ["07-pubsub-streams"],
  description: `
Pub/Sub 은 **fire-and-forget** 이다. 발행 시점에 구독 중인 클라이언트에게만 전달되고 어디에도 저장되지 않는다.
구독 커넥션은 다른 명령을 보낼 수 없는 구독 모드로 바뀌므로 **별도 커넥션**을 써야 한다.

실시간 알림·채팅·캐시 무효화 브로드캐스트에 적합하고, 유실이 허용되지 않으면 Stream 을 써야 한다.
`,
  code: `# 커넥션 1 (구독자)
SUBSCRIBE news
# 커넥션 2 (발행자)
PUBLISH news "hello"     # 1 ← 받은 구독자 수
# 구독자 커넥션에 message 이벤트 도착: ["message","news","hello"]

# 아무도 구독하지 않을 때 발행하면
PUBLISH nobody "lost"    # 0 ← 메시지는 사라진다`,
  async run({ redis, rec, k, newClient }) {
    const ch = k("news");
    rec.note("구독 전에 발행하면 아무도 받지 못한다");
    const lost = await redis.publish(ch, "early");
    rec.check("수신자 0", lost === 0, lost);

    const sub = await newClient("subscriber");
    const received: string[] = [];
    sub.on("message", (_c: string, m: string) => received.push(m));
    await sub.subscribe(ch);

    const n = await redis.publish(ch, "hello");
    rec.check("수신 구독자 1명", n === 1, n);
    await rec.sleep(100);
    rec.check("구독자가 hello 를 받음", received.includes("hello"), received);
    await sub.unsubscribe(ch);
  },
};

export const streamsBasics: Experiment = {
  id: "streams",
  title: "Stream: 저장되는 로그와 컨슈머 그룹",
  category: "메시징",
  summary: "XADD/XRANGE, 컨슈머 그룹으로 분배, XACK 로 처리 확인, 미처리(PENDING) 추적",
  notes: ["07-pubsub-streams"],
  description: `
Stream 은 append-only 로그다. 각 엔트리는 \`<ms>-<seq>\` ID 를 가지며 Pub/Sub 과 달리 **저장**된다.

- \`XREAD\` 로 임의 위치부터 읽기 (Kafka 의 offset 과 유사)
- **컨슈머 그룹**: 같은 그룹의 소비자들에게 메시지를 나눠주고, 각 메시지는 \`XACK\` 될 때까지 PEL(Pending Entries List)에 남는다
- 소비자가 죽으면 \`XPENDING\`/\`XCLAIM\`/\`XAUTOCLAIM\` 으로 다른 소비자가 가져간다
- \`MAXLEN ~ 1000\` 으로 길이를 제한한다
`,
  code: `XADD orders * item apple qty 3
XADD orders * item pear qty 1
XLEN orders
XRANGE orders - +

XGROUP CREATE orders workers 0
XREADGROUP GROUP workers w1 COUNT 1 STREAMS orders >   # w1 이 첫 메시지
XREADGROUP GROUP workers w2 COUNT 1 STREAMS orders >   # w2 가 두 번째
XPENDING orders workers                                # 2개 미확인
XACK orders workers <id1>
XPENDING orders workers                                # 1개`,
  async run({ redis, rec, k }) {
    const s = k("orders");
    const id1 = await redis.xadd(s, "*", "item", "apple", "qty", 3);
    const id2 = await redis.xadd(s, "*", "item", "pear", "qty", 1);
    rec.check("ID 는 단조 증가", String(id1) < String(id2), [id1, id2]);
    await redis.xlen(s);
    await redis.xrange(s, "-", "+");

    rec.note("컨슈머 그룹으로 분배");
    await redis.xgroup("CREATE", s, "workers", "0");
    const r1 = await redis.xreadgroup("GROUP", "workers", "w1", "COUNT", 1, "STREAMS", s, ">");
    const r2 = await redis.xreadgroup("GROUP", "workers", "w2", "COUNT", 1, "STREAMS", s, ">");
    const first = (r1 as unknown as [string, [string, string[]][]][])[0][1][0][0];
    const second = (r2 as unknown as [string, [string, string[]][]][])[0][1][0][0];
    rec.check("w1, w2 가 서로 다른 메시지를 받음", first !== second, [first, second]);

    const pending = await redis.xpending(s, "workers");
    rec.check("ACK 전 PENDING 2개", Number((pending as unknown[])[0]) === 2, pending);
    await redis.xack(s, "workers", first);
    const pending2 = await redis.xpending(s, "workers");
    rec.check("ACK 후 PENDING 1개", Number((pending2 as unknown[])[0]) === 1, pending2);

    rec.note("길이 제한: MAXLEN ~ 로 대략적 트리밍 (성능 우선)");
    for (let i = 0; i < 20; i++) await redis.xadd(s, "MAXLEN", "~", 10, "*", "i", i);
    const len = await redis.xlen(s);
    rec.check("길이가 제한 근처로 유지됨", len <= 30, len);
  },
};
