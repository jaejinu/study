import { Kafka, logLevel, type Consumer, type EachMessagePayload } from "kafkajs";
import type { CodeExperiment } from "./types";

export const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "127.0.0.1:19092").split(",");

export function kafkaClient(clientId = "study") {
  return new Kafka({ clientId, brokers: KAFKA_BROKERS, logLevel: logLevel.NOTHING, connectionTimeout: 3000, requestTimeout: 10000, retry: { retries: 3 } });
}

export async function requiresKafka(): Promise<string | null> {
  const admin = kafkaClient("study-check").admin();
  try {
    await admin.connect();
    await admin.listTopics();
    return null;
  } catch {
    return `Kafka 브로커(${KAFKA_BROKERS.join(",")})에 연결할 수 없습니다. 터미널에서 \`pnpm kafka:up\` 을 실행하고 30초쯤 기다린 뒤 다시 시도하세요.`;
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

type Received = { partition: number; offset: string; key: string | null; value: string };

/** 컨슈머를 돌려 N개 받을 때까지 (또는 timeout) 수집하고 멈춘다 */
async function collect(consumer: Consumer, expected: number, timeoutMs = 15000, onMessage?: (p: EachMessagePayload) => void): Promise<Received[]> {
  const got: Received[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));
  await consumer.run({
    eachMessage: async (p) => {
      got.push({ partition: p.partition, offset: p.message.offset, key: p.message.key?.toString() ?? null, value: p.message.value?.toString() ?? "" });
      onMessage?.(p);
      if (got.length >= expected) resolveDone();
    },
  });
  await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
  return got;
}

export const kafkaProduceConsume: CodeExperiment = {
  id: "kafka-produce-consume",
  subject: "kafka",
  title: "토픽·파티션·키: 같은 키는 같은 파티션, 순서는 파티션 안에서만",
  category: "기초",
  summary: "파티션 3개 토픽을 만들고 키가 있는 메시지 9개를 보내 파티션 배치와 오프셋, 파티션 내 순서 보장을 확인",
  notes: ["01-kafka-overview", "02-topics-partitions"],
  description: `
토픽은 **파티션**들로 나뉘고, 각 파티션은 append-only 로그다. 프로듀서가 키를 주면 \`hash(key) % 파티션수\` 로 파티션이 정해져
**같은 키의 메시지는 항상 같은 파티션에, 보낸 순서대로** 쌓인다. 키가 없으면 라운드로빈/스티키로 흩어진다.
순서 보장은 파티션 단위다 — 토픽 전체 순서는 없다. 그래서 "주문 ID 를 키로" 같은 설계가 중요하다.

사전 준비: \`pnpm kafka:up\`
`,
  code: `# 토픽 생성 (파티션 3)
kafka-topics.sh --bootstrap-server localhost:19092 --create --topic lab.orders --partitions 3
# 키 있는 메시지 생산
kafka-console-producer.sh --bootstrap-server localhost:19092 --topic lab.orders --property parse.key=true --property key.separator=:
> order-1:created
> order-1:paid
> order-2:created
# 파티션·오프셋과 함께 소비
kafka-console-consumer.sh --bootstrap-server localhost:19092 --topic lab.orders --from-beginning \\
  --property print.key=true --property print.partition=true --property print.offset=true`,
  requires: requiresKafka,
  async run({ rec, k }) {
    const topic = k("orders");
    const kafka = kafkaClient();
    const admin = kafka.admin();
    const producer = kafka.producer();
    const consumer = kafka.consumer({ groupId: `${topic}-g1` });
    try {
      await admin.connect();
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await rec.measure(`admin.createTopics(${topic}, partitions=3)`, () => admin.createTopics({ topics: [{ topic, numPartitions: 3 }], waitForLeaders: true }));
      const meta = await admin.fetchTopicMetadata({ topics: [topic] });
      rec.check("파티션 3개", meta.topics[0].partitions.length === 3, meta.topics[0].partitions.map((p) => `p${p.partitionId} leader=${p.leader}`));

      await producer.connect();
      const keys = ["order-1", "order-2", "order-3"];
      const events = ["created", "paid", "shipped"];
      const sent = await rec.measure("producer.send 9개 (키 3종 × 이벤트 3개)", async () => {
        const out: { key: string; partition: number; offset: string }[] = [];
        for (const key of keys)
          for (const ev of events) {
            const [m] = await producer.send({ topic, messages: [{ key, value: `${key}:${ev}` }] });
            out.push({ key, partition: m.partition, offset: m.baseOffset ?? "?" });
          }
        return out;
      });
      const byKey = new Map<string, Set<number>>();
      for (const s of sent) byKey.set(s.key, (byKey.get(s.key) ?? new Set()).add(s.partition));
      rec.check("같은 키는 항상 같은 파티션", [...byKey.values()].every((set) => set.size === 1), Object.fromEntries([...byKey].map(([k, v]) => [k, [...v]])));

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });
      const got = await rec.measure("consumer 가 9개 받을 때까지", () => collect(consumer, 9));
      rec.check("9개 수신", got.length === 9, got.length);
      rec.steps.push({ cmd: "수신 메시지 (partition / offset / key / value)", result: got.map((g) => `p${g.partition}@${g.offset} ${g.key} → ${g.value}`), ms: 0, note: true });
      const orderOk = keys.every((key) => got.filter((g) => g.key === key).map((g) => g.value.split(":")[1]).join(",") === events.join(","));
      rec.check("키별로 created → paid → shipped 순서 유지", orderOk);
      const perPartition = [...new Set(got.map((g) => g.partition))].map((p) => `p${p}: ${got.filter((g) => g.partition === p).length}개`);
      rec.note(`파티션별 메시지 수: ${perPartition.join(", ")} (키 해시에 따라 치우칠 수 있다)`);
    } finally {
      await consumer.disconnect().catch(() => {});
      await producer.disconnect().catch(() => {});
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.disconnect().catch(() => {});
    }
  },
};

export const kafkaConsumerGroups: CodeExperiment = {
  id: "kafka-consumer-groups",
  subject: "kafka",
  title: "컨슈머 그룹: 같은 그룹은 나눠 받고, 다른 그룹은 전부 받는다",
  category: "소비",
  summary: "한 그룹의 컨슈머 2개가 파티션을 분배받는 것과, 별도 그룹이 같은 메시지를 독립적으로 받는 fan-out 을 확인",
  notes: ["03-consumer-groups"],
  description: `
**컨슈머 그룹** 안에서 파티션은 컨슈머들에게 배타적으로 할당된다 (파티션 3개, 컨슈머 2개 → 2:1). 컨슈머가 파티션보다 많으면 노는 컨슈머가 생긴다.
그룹이 다르면 각자 **독립된 오프셋**으로 전체를 읽는다 — Pub/Sub 의 fan-out 과 큐의 분배를 그룹 하나로 모두 표현한다.
컨슈머가 들어오고 나갈 때 **리밸런스**가 일어나 파티션이 재배치된다.

사전 준비: \`pnpm kafka:up\`
`,
  code: `kafka-topics.sh --create --topic lab.events --partitions 3 --bootstrap-server localhost:19092
# 터미널 A, B: 같은 그룹 → 파티션 분배
kafka-console-consumer.sh --topic lab.events --group workers --bootstrap-server localhost:19092
kafka-console-consumer.sh --topic lab.events --group workers --bootstrap-server localhost:19092
# 터미널 C: 다른 그룹 → 전부 수신
kafka-console-consumer.sh --topic lab.events --group audit --from-beginning --bootstrap-server localhost:19092
kafka-consumer-groups.sh --describe --group workers --bootstrap-server localhost:19092   # 파티션별 할당·LAG`,
  requires: requiresKafka,
  async run({ rec, k }) {
    const topic = k("events");
    const kafka = kafkaClient();
    const admin = kafka.admin();
    const producer = kafka.producer();
    const w1 = kafka.consumer({ groupId: `${topic}-workers` });
    const w2 = kafka.consumer({ groupId: `${topic}-workers` });
    const audit = kafka.consumer({ groupId: `${topic}-audit` });
    try {
      await admin.connect();
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.createTopics({ topics: [{ topic, numPartitions: 3 }], waitForLeaders: true });
      await producer.connect();

      rec.note("workers 그룹에 컨슈머 2개를 넣고 파티션 할당을 본다");
      const assignments: Record<string, number[]> = { w1: [], w2: [] };
      for (const [name, c] of [["w1", w1], ["w2", w2]] as const) {
        await c.connect();
        await c.subscribe({ topic, fromBeginning: true });
        c.on(c.events.GROUP_JOIN, (e) => {
          assignments[name] = (e.payload.memberAssignment[topic] ?? []).slice();
        });
      }
      const gotW1: Received[] = [];
      const gotW2: Received[] = [];
      await w1.run({ eachMessage: async (p) => void gotW1.push({ partition: p.partition, offset: p.message.offset, key: null, value: p.message.value?.toString() ?? "" }) });
      await w2.run({ eachMessage: async (p) => void gotW2.push({ partition: p.partition, offset: p.message.offset, key: null, value: p.message.value?.toString() ?? "" }) });
      await rec.measure("두 컨슈머가 파티션을 나눠 가질 때까지 대기", async () => {
        for (let i = 0; i < 100; i++) {
          if (assignments.w1.length + assignments.w2.length === 3 && assignments.w1.length > 0 && assignments.w2.length > 0) return assignments;
          await new Promise((r) => setTimeout(r, 200));
        }
        return assignments;
      });
      rec.check("3개 파티션이 2:1 로 분배됨", assignments.w1.length + assignments.w2.length === 3 && assignments.w1.length > 0 && assignments.w2.length > 0, assignments);

      await rec.measure("producer.send 30개 (키 없음 → 파티션 분산)", () => producer.send({ topic, messages: Array.from({ length: 30 }, (_, i) => ({ value: `e${i}` })) }));
      await rec.measure("workers 그룹이 30개를 모두 받을 때까지", async () => {
        for (let i = 0; i < 100; i++) {
          if (gotW1.length + gotW2.length >= 30) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        return { w1: gotW1.length, w2: gotW2.length };
      });
      rec.check("합쳐서 30개, 중복 없음 (각 메시지는 그룹 내 한 컨슈머만)", gotW1.length + gotW2.length === 30 && new Set([...gotW1, ...gotW2].map((g) => `${g.partition}@${g.offset}`)).size === 30, { w1: gotW1.length, w2: gotW2.length });
      rec.check("w1 과 w2 가 받은 파티션이 겹치지 않음", !gotW1.some((a) => gotW2.some((b) => a.partition === b.partition)));

      rec.note("audit 그룹은 독립적으로 전체를 받는다");
      await audit.connect();
      await audit.subscribe({ topic, fromBeginning: true });
      const gotAudit = await rec.measure("audit 그룹 수신", () => collect(audit, 30));
      rec.check("audit 그룹도 30개 전부", gotAudit.length === 30, gotAudit.length);

      const offsets = await admin.fetchOffsets({ groupId: `${topic}-workers`, topics: [topic] });
      rec.steps.push({ cmd: `admin.fetchOffsets(${topic}-workers) — 커밋된 오프셋`, result: offsets[0].partitions.map((p) => `p${p.partition}: ${p.offset}`), ms: 0 });
    } finally {
      await Promise.allSettled([w1.disconnect(), w2.disconnect(), audit.disconnect(), producer.disconnect()]);
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.deleteGroups([`${topic}-workers`, `${topic}-audit`]).catch(() => {});
      await admin.disconnect().catch(() => {});
    }
  },
};

export const kafkaOffsetsReplay: CodeExperiment = {
  id: "kafka-offsets-replay",
  subject: "kafka",
  title: "오프셋과 재처리: 커밋 지점을 되돌려 다시 읽기",
  category: "소비",
  summary: "소비 후 커밋된 오프셋을 확인하고, 그룹 오프셋을 처음으로 리셋해 같은 메시지를 다시 받는 replay 를 수행",
  notes: ["03-consumer-groups", "04-delivery-guarantees"],
  description: `
Kafka 는 메시지를 소비해도 지우지 않는다(보존 기간까지). 컨슈머 그룹은 "어디까지 읽었나" 를 **오프셋**으로 커밋할 뿐이다.
그래서 버그를 고친 뒤 \`--reset-offsets --to-earliest\` 로 되돌려 **재처리**할 수 있다. 이것이 큐(List)와 가장 다른 점이다.
오프셋 커밋 시점에 따라 at-most-once / at-least-once 가 갈린다.

사전 준비: \`pnpm kafka:up\`
`,
  code: `kafka-consumer-groups.sh --describe --group replay --bootstrap-server localhost:19092
#   CURRENT-OFFSET  LOG-END-OFFSET  LAG
# 그룹을 멈춘 뒤 처음으로 리셋
kafka-consumer-groups.sh --reset-offsets --to-earliest --execute --group replay --topic lab.replay --bootstrap-server localhost:19092
# 다시 소비하면 같은 메시지가 또 온다`,
  requires: requiresKafka,
  async run({ rec, k }) {
    const topic = k("replay");
    const groupId = `${topic}-g`;
    const kafka = kafkaClient();
    const admin = kafka.admin();
    const producer = kafka.producer();
    try {
      await admin.connect();
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true });
      await producer.connect();
      await rec.measure("producer.send 5개", () => producer.send({ topic, messages: Array.from({ length: 5 }, (_, i) => ({ value: `m${i}` })) }));

      const c1 = kafka.consumer({ groupId });
      await c1.connect();
      await c1.subscribe({ topic, fromBeginning: true });
      const first = await rec.measure("1차 소비", () => collect(c1, 5));
      await c1.disconnect();
      rec.check("5개 수신", first.length === 5, first.map((g) => g.value));
      const committed = await admin.fetchOffsets({ groupId, topics: [topic] });
      rec.check("커밋된 오프셋 = 5 (다음에 읽을 위치)", committed[0].partitions[0].offset === "5", committed[0].partitions);

      const c2 = kafka.consumer({ groupId });
      await c2.connect();
      await c2.subscribe({ topic, fromBeginning: true });
      const again = await rec.measure("같은 그룹으로 다시 소비 (3초 대기)", () => collect(c2, 1, 3000));
      await c2.disconnect();
      rec.check("커밋 이후라 새 메시지 없음 (0개)", again.length === 0, again.length);

      await rec.measure("admin.resetOffsets(earliest)", () => admin.resetOffsets({ groupId, topic, earliest: true }));
      const c3 = kafka.consumer({ groupId });
      await c3.connect();
      await c3.subscribe({ topic, fromBeginning: true });
      const replayed = await rec.measure("리셋 후 재소비", () => collect(c3, 5));
      await c3.disconnect();
      rec.check("같은 5개를 다시 받는다 (replay)", replayed.length === 5 && replayed.map((g) => g.value).join() === first.map((g) => g.value).join(), replayed.map((g) => g.value));
    } finally {
      await producer.disconnect().catch(() => {});
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.deleteGroups([groupId]).catch(() => {});
      await admin.disconnect().catch(() => {});
    }
  },
};
