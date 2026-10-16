import amqp from "amqplib";
import Redis from "ioredis";
import { AckPolicy, connect as natsConnect, DeliverPolicy, nanos, StorageType, type NatsConnection } from "nats";
import { KAFKA_BROKERS, kafkaClient } from "./kafka";
import type { CodeExperiment } from "./types";

export const RABBIT_URL = process.env.RABBIT_URL ?? "amqp://study:study@127.0.0.1:5673";
export const NATS_URL = process.env.NATS_URL ?? "127.0.0.1:14222";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function canRabbit(): Promise<boolean> {
  try {
    const c = await amqp.connect(RABBIT_URL, { timeout: 2000 });
    await c.close();
    return true;
  } catch {
    return false;
  }
}

async function canNats(): Promise<boolean> {
  try {
    const nc = await natsConnect({ servers: NATS_URL, timeout: 2000, reconnect: false });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

async function canRedis(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 2000, retryStrategy: () => null });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

async function canKafka(): Promise<boolean> {
  const admin = kafkaClient("mq-check").admin();
  try {
    await Promise.race([admin.connect().then(() => admin.listTopics()), sleep(4000).then(() => Promise.reject(new Error("timeout")))]);
    return true;
  } catch {
    return false;
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

const MQ_HINT = "`pnpm mq:up` 으로 RabbitMQ(5673)·NATS(14222)를 띄우고 10초쯤 기다리세요.";

// ------------------------------------------------------------------ RabbitMQ: DLX + TTL 재시도
export const mqRabbitDlxRetry: CodeExperiment = {
  id: "mq-rabbit-dlx-retry",
  subject: "messaging",
  title: "RabbitMQ 재시도: nack 된 메시지가 DLX → TTL 대기 큐 → 원래 큐로 돌아오다 3번 실패하면 dead 큐로",
  category: "RabbitMQ",
  summary: "work·retry·dead 큐와 두 익스체인지를 선언하고, 정상·한 번 실패(flaky)·항상 실패(poison) 메시지를 보내 각 메시지의 배달 경로와 시각, x-death 헤더를 추적한다. 퍼블리셔 확인(confirm)도 함께",
  notes: ["02-rabbitmq", "04-delivery-guarantees-delay", "07-operations-observability"],
  description: `
RabbitMQ 에는 "N초 뒤 재시도" 기능이 내장돼 있지 않다. 대신 **DLX(Dead Letter Exchange)** 와 **메시지 TTL** 을 조합한다.
1. work 큐는 \`x-dead-letter-exchange = retry.x\` 로 선언한다. 소비자가 \`nack(requeue=false)\` 하면 메시지는 버려지지 않고 retry.x 로 간다.
2. retry 큐는 소비자가 없고 \`x-message-ttl = 400\` 과 \`x-dead-letter-exchange = work.x\` 를 가진다. 400ms 가 지나면 만료되어 다시 work 로 돌아온다.
3. RabbitMQ 는 이 여정을 \`x-death\` 헤더에 (큐, 이유, 횟수) 로 기록한다. 소비자는 그 횟수를 보고 3번째 실패에서 dead 큐로 보내고 ack 한다.

\`requeue=true\` 로 nack 하면 즉시 큐 앞으로 돌아와 **바로 다시 실패**하는 루프(핫 루프)가 생긴다. 지연 재시도가 필요한 이유다.
사전 준비: ${MQ_HINT}
`,
  code: `const ch = await conn.createConfirmChannel();
await ch.assertExchange("work.x", "direct");  await ch.assertExchange("retry.x", "direct");
await ch.assertQueue("work",  { arguments: { "x-dead-letter-exchange": "retry.x" } });
await ch.assertQueue("retry", { arguments: { "x-message-ttl": 400, "x-dead-letter-exchange": "work.x" } });
await ch.assertQueue("dead");
await ch.bindQueue("work", "work.x", "job");  await ch.bindQueue("retry", "retry.x", "job");

await ch.consume("work", (m) => {
  const deaths = m.properties.headers["x-death"]?.find((d) => d.queue === "work")?.count ?? 0;
  const attempt = deaths + 1;
  if (handle(m)) return ch.ack(m);
  if (attempt >= 3) { ch.sendToQueue("dead", m.content, { headers: m.properties.headers }); return ch.ack(m); }
  ch.nack(m, false, false);          // requeue=false → DLX(retry.x) → TTL 400ms → work.x
}, { noAck: false });`,
  requires: async () => ((await canRabbit()) ? null : `RabbitMQ(${RABBIT_URL.replace(/\/\/.*@/, "//")}) 에 연결할 수 없습니다. ${MQ_HINT}`),
  async run({ rec, k }) {
    const conn = await amqp.connect(RABBIT_URL);
    const ch = await conn.createConfirmChannel();
    const ex = { work: k("work.x"), retry: k("retry.x") };
    const q = { work: k("work"), retry: k("retry"), dead: k("dead") };
    const TTL = 400;
    try {
      await rec.measure("assertExchange × 2, assertQueue × 3 (work·retry·dead), bindQueue × 2", async () => {
        await ch.assertExchange(ex.work, "direct", { durable: true });
        await ch.assertExchange(ex.retry, "direct", { durable: true });
        await ch.assertQueue(q.work, { durable: true, arguments: { "x-dead-letter-exchange": ex.retry } });
        await ch.assertQueue(q.retry, { durable: true, arguments: { "x-message-ttl": TTL, "x-dead-letter-exchange": ex.work } });
        await ch.assertQueue(q.dead, { durable: true });
        await ch.bindQueue(q.work, ex.work, "job");
        await ch.bindQueue(q.retry, ex.retry, "job");
        return { work: "x-dead-letter-exchange=retry.x", retry: `x-message-ttl=${TTL}, x-dead-letter-exchange=work.x` };
      });

      type Event = { ms: number; id: string; attempt: number; action: string };
      const events: Event[] = [];
      const done = new Map<string, string>();
      const t0 = performance.now();
      const tag = await ch.consume(
        q.work,
        (m) => {
          if (!m) return;
          const id = String(m.properties.messageId);
          const deaths = (m.properties.headers?.["x-death"] as { queue: string; reason: string; count: number }[] | undefined) ?? [];
          const attempt = (deaths.find((d) => d.queue === q.work && d.reason === "rejected")?.count ?? 0) + 1;
          const ms = Math.round(performance.now() - t0);
          const ok = id === "good" || (id === "flaky" && attempt >= 2);
          if (ok) {
            ch.ack(m);
            events.push({ ms, id, attempt, action: "처리 성공 → ack" });
            done.set(id, `성공 (${attempt}번째 시도)`);
          } else if (attempt >= 3) {
            ch.sendToQueue(q.dead, m.content, { headers: { ...m.properties.headers, "x-final-attempt": attempt }, messageId: id, persistent: true });
            ch.ack(m);
            events.push({ ms, id, attempt, action: "3번째 실패 → dead 큐로 보내고 ack" });
            done.set(id, `dead (${attempt}번 시도)`);
          } else {
            ch.nack(m, false, false);
            events.push({ ms, id, attempt, action: `실패 → nack(requeue=false) → retry 큐(TTL ${TTL}ms)` });
          }
        },
        { noAck: false },
      );

      await rec.measure("publish × 3 (good · flaky · poison) + waitForConfirms (퍼블리셔 확인)", async () => {
        for (const id of ["good", "flaky", "poison"]) ch.publish(ex.work, "job", Buffer.from(JSON.stringify({ id, amount: 1000 })), { messageId: id, persistent: true, contentType: "application/json" });
        await ch.waitForConfirms();
        return "브로커가 3건 모두 디스크/큐에 받았다고 확인 (basic.ack)";
      });

      await rec.measure("세 메시지가 모두 끝날 때까지 대기", async () => {
        for (let i = 0; i < 100 && done.size < 3; i++) await sleep(50);
        if (done.size < 3) throw new Error(`끝나지 않음: ${[...done.keys()].join(",")}`);
        return Object.fromEntries(done);
      });
      await ch.cancel(tag.consumerTag);

      rec.steps.push({ cmd: "배달 타임라인 (ms 는 첫 발행 기준)", result: events.map((e) => `${String(e.ms).padStart(5)}ms  ${e.id.padEnd(6)}  시도 ${e.attempt}  ${e.action}`), ms: 0 });
      const poison = events.filter((e) => e.id === "poison");
      const gaps = poison.slice(1).map((e, i) => e.ms - poison[i].ms);
      rec.steps.push({ cmd: "poison 의 재배달 간격 (ms)", result: gaps, ms: 0 });

      const dead = await ch.get(q.dead, { noAck: true });
      const xDeath = dead ? (dead.properties.headers?.["x-death"] as { queue: string; reason: string; count: number; exchange: string }[]) : [];
      rec.steps.push({ cmd: "dead 큐의 메시지 x-death 헤더 (RabbitMQ 가 기록한 여정)", result: xDeath?.map((d) => ({ queue: d.queue, reason: d.reason, count: d.count, exchange: d.exchange })), ms: 0 });

      rec.check("good 은 첫 시도에 성공", done.get("good") === "성공 (1번째 시도)", done.get("good"));
      rec.check("flaky 는 한 번 실패 후 TTL 대기를 거쳐 2번째에 성공", done.get("flaky") === "성공 (2번째 시도)", done.get("flaky"));
      rec.check("poison 은 3번 시도 후 dead 큐로 (무한 재시도 없음)", done.get("poison") === "dead (3번 시도)" && !!dead && dead.properties.messageId === "poison", done.get("poison"));
      rec.check(`재시도 간격이 TTL(${TTL}ms) 이상 — 즉시 재배달(핫 루프)이 아니다`, gaps.length === 2 && gaps.every((g) => g >= TTL - 20), gaps);
      const counts = await Promise.all([q.work, q.retry, q.dead].map(async (name) => [name.split("_").pop(), (await ch.checkQueue(name)).messageCount]));
      rec.steps.push({ cmd: "checkQueue — 남은 메시지 수", result: Object.fromEntries(counts), ms: 0 });
      rec.note("운영에선 retry 큐를 지연 단계별로 여러 개(1s·10s·60s) 두거나, 큐 전체 TTL 대신 메시지별 expiration 을 쓴다. 단 메시지별 TTL 은 큐 머리에 있을 때만 만료되므로(앞 메시지가 길면 뒤가 갇힘) 단계별 큐가 안전하다.");
    } finally {
      for (const name of Object.values(q)) await ch.deleteQueue(name).catch(() => {});
      for (const name of Object.values(ex)) await ch.deleteExchange(name).catch(() => {});
      await ch.close().catch(() => {});
      await conn.close().catch(() => {});
    }
  },
};

// ------------------------------------------------------------------ NATS JetStream: ack / 재전달 / max_deliver / 중복 제거
export const mqNatsJetstreamAck: CodeExperiment = {
  id: "mq-nats-jetstream-ack",
  subject: "messaging",
  title: "NATS JetStream: ack 안 한 메시지는 ack_wait 뒤 다시 오고, max_deliver 에 닿으면 어드바이저리가 울린다",
  category: "NATS",
  summary: "메모리 스트림과 풀 컨슈머(ack_wait 1s, max_deliver 3)를 만들고 세 메시지를 각각 ack·무시·nak(300ms) 해서 재전달 횟수와 간격을 재고, max_deliver 도달 어드바이저리와 msgID 중복 제거(duplicate window)를 확인한다",
  notes: ["03-nats-jetstream", "04-delivery-guarantees-delay"],
  description: `
core NATS 는 **at-most-once** 다. 구독자가 없거나 느리면 메시지는 사라진다. JetStream 은 그 위에 **스트림(저장)** 과 **컨슈머(읽는 위치 + ack 상태)** 를 얹어 at-least-once 를 만든다.
- \`ack_wait\` 안에 ack 가 없으면 서버가 같은 메시지를 다시 보낸다. 처리 중인데 오래 걸리면 \`working()\` 으로 시간을 연장한다.
- \`nak(delay)\` 는 "지금은 못 하니 delay 뒤에 다시" — RabbitMQ 의 DLX+TTL 조합을 한 줄로.
- \`max_deliver\` 에 닿으면 더는 보내지 않고 \`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.<stream>.<consumer>\` 어드바이저리를 발행한다. 이것을 구독해 dead letter 처리를 한다.
- 발행 시 \`msgID\` 를 주면 duplicate window(기본 2분) 안의 같은 ID 는 저장하지 않는다. 프로듀서 재시도로 생기는 중복을 서버가 막는다.
사전 준비: ${MQ_HINT}
`,
  code: `const jsm = await nc.jetstreamManager();
await jsm.streams.add({ name: "ORDERS", subjects: ["orders.>"], storage: StorageType.Memory });
await jsm.consumers.add("ORDERS", { durable_name: "worker", ack_policy: AckPolicy.Explicit, ack_wait: nanos(1000), max_deliver: 3 });
const js = nc.jetstream();
await js.publish("orders.created", data, { msgID: "order-42" });   // 같은 msgID 재발행 → duplicate: true
const c = await js.consumers.get("ORDERS", "worker");
for await (const m of await c.consume()) {
  m.info.deliveryCount;          // 1, 2, 3 …
  m.ack() | m.nak(300) | m.working() | m.term();
}`,
  requires: async () => ((await canNats()) ? null : `NATS(${NATS_URL}) 에 연결할 수 없습니다. ${MQ_HINT}`),
  async run({ rec, k }) {
    const nc = await natsConnect({ servers: NATS_URL, timeout: 3000 });
    const stream = k("orders").replace(/[^A-Za-z0-9_-]/g, "_").toUpperCase();
    const subj = `${stream.toLowerCase()}`;
    const durable = "worker";
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.delete(stream).catch(() => {});
      await rec.measure(`jsm.streams.add({ name: "${stream}", subjects: ["${subj}.>"], storage: Memory })`, async () => {
        const si = await jsm.streams.add({ name: stream, subjects: [`${subj}.>`], storage: StorageType.Memory, duplicate_window: nanos(120_000) });
        return { retention: si.config.retention, storage: si.config.storage, duplicate_window_s: Number(si.config.duplicate_window) / 1e9 };
      });
      await rec.measure(`jsm.consumers.add(durable "${durable}", ack_policy Explicit, ack_wait 1s, max_deliver 3)`, async () => {
        const ci = await jsm.consumers.add(stream, { durable_name: durable, ack_policy: AckPolicy.Explicit, ack_wait: nanos(1000), max_deliver: 3, deliver_policy: DeliverPolicy.All });
        return { ack_wait_ms: Number(ci.config.ack_wait) / 1e6, max_deliver: ci.config.max_deliver };
      });

      const advisories: { stream_seq: number; deliveries: number }[] = [];
      const advSub = nc.subscribe(`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${stream}.${durable}`);
      void (async () => {
        for await (const m of advSub) {
          const a = m.json<{ stream_seq: number; deliveries: number }>();
          advisories.push({ stream_seq: a.stream_seq, deliveries: a.deliveries });
        }
      })();

      const js = nc.jetstream();
      const acks = await rec.measure("js.publish × 3 (A: ack 할 것 · B: 무시할 것 · C: nak 할 것), msgID 지정", async () => {
        const out: Record<string, { seq: number; duplicate: boolean }> = {};
        for (const id of ["A", "B", "C"]) {
          const pa = await js.publish(`${subj}.created`, new TextEncoder().encode(JSON.stringify({ id })), { msgID: `order-${id}` });
          out[id] = { seq: pa.seq, duplicate: pa.duplicate };
        }
        return out;
      });
      const dup = await rec.measure('js.publish(같은 msgID "order-A" 재발행 — 프로듀서 재시도 흉내)', async () => {
        const pa = await js.publish(`${subj}.created`, new TextEncoder().encode(JSON.stringify({ id: "A" })), { msgID: "order-A" });
        return { seq: pa.seq, duplicate: pa.duplicate };
      });
      rec.check("같은 msgID 는 duplicate=true 로 저장되지 않는다 (서버 측 중복 제거)", dup.duplicate === true && dup.seq === acks.A.seq, dup);

      type Delivery = { id: string; n: number; ms: number; action: string };
      const deliveries: Delivery[] = [];
      const consumer = await js.consumers.get(stream, durable);
      const t0 = performance.now();
      const iter = await consumer.consume({ max_messages: 10, expires: 1000 });
      const stopAt = setTimeout(() => iter.stop(), 5500);
      await rec.measure("consume 5.5초 — A 는 ack, B 는 아무것도 안 함, C 는 첫 배달에 nak(300ms) 후 두 번째에 ack", async () => {
        for await (const m of iter) {
          const id = m.json<{ id: string }>().id;
          const n = m.info.deliveryCount;
          const ms = Math.round(performance.now() - t0);
          if (id === "A") {
            m.ack();
            deliveries.push({ id, n, ms, action: "ack" });
          } else if (id === "B") {
            deliveries.push({ id, n, ms, action: "무응답 (ack_wait 만료 대기)" });
          } else if (n === 1) {
            m.nak(300);
            deliveries.push({ id, n, ms, action: "nak(300ms)" });
          } else {
            m.ack();
            deliveries.push({ id, n, ms, action: "ack" });
          }
        }
        return `${deliveries.length}회 배달`;
      });
      clearTimeout(stopAt);
      rec.steps.push({ cmd: "배달 기록 (ms 는 consume 시작 기준)", result: deliveries.map((d) => `${String(d.ms).padStart(5)}ms  ${d.id}  deliveryCount=${d.n}  ${d.action}`), ms: 0 });

      const b = deliveries.filter((d) => d.id === "B");
      const bGaps = b.slice(1).map((d, i) => d.ms - b[i].ms);
      const c = deliveries.filter((d) => d.id === "C");
      rec.check("A 는 한 번만 배달된다", deliveries.filter((d) => d.id === "A").length === 1);
      rec.check("B 는 max_deliver(3) 번 배달되고 멈춘다", b.length === 3 && b.map((d) => d.n).join(",") === "1,2,3", b.map((d) => d.n));
      rec.check("B 의 재배달 간격 ≈ ack_wait(1s)", bGaps.every((g) => g >= 900 && g < 2000), bGaps);
      rec.check("C 는 nak(300ms) 뒤 약 300ms 후 다시 와서 ack 된다", c.length === 2 && c[1].ms - c[0].ms >= 250 && c[1].ms - c[0].ms < 900, c.map((d) => d.ms));
      await sleep(300);
      rec.steps.push({ cmd: `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${stream}.${durable}`, result: advisories, ms: 0 });
      rec.check("max_deliver 도달 어드바이저리가 B(stream_seq) 로 발행됐다 — 이걸 구독해 dead letter 처리", advisories.some((a) => a.stream_seq === acks.B.seq), advisories);
      const ci = await jsm.consumers.info(stream, durable);
      rec.steps.push({ cmd: "jsm.consumers.info — 컨슈머 상태", result: { delivered_stream_seq: ci.delivered.stream_seq, ack_floor_stream_seq: ci.ack_floor.stream_seq, num_ack_pending: ci.num_ack_pending, num_redelivered: ci.num_redelivered, num_pending: ci.num_pending }, ms: 0 });
      rec.note("B 는 스트림에 그대로 남아 있다(Limits 보존). JetStream 의 'dead letter' 는 큐가 아니라 어드바이저리 + 원본 seq 로 다시 읽어 오는 패턴이다.");
      advSub.unsubscribe();
    } finally {
      await jsm.streams.delete(stream).catch(() => {});
      await nc.drain().catch(() => {});
    }
  },
};

// ------------------------------------------------------------------ 같은 워크로드, 다섯 경로
type BenchRow = { broker: string; guarantee: string; status: string; publishMs?: number; totalMs?: number; rate?: number; p50?: number; p99?: number; max?: number; received?: number };

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(broker: string, guarantee: string, sendAt: Float64Array, recvAt: Float64Array, n: number, publishMs: number): BenchRow {
  const lat: number[] = [];
  let first = Infinity, last = 0, received = 0;
  for (let i = 0; i < n; i++) {
    if (recvAt[i] === 0) continue;
    received++;
    lat.push(recvAt[i] - sendAt[i]);
    first = Math.min(first, sendAt[i]);
    last = Math.max(last, recvAt[i]);
  }
  lat.sort((a, b) => a - b);
  const totalMs = last - first;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { broker, guarantee, status: "측정", publishMs: Math.round(publishMs), totalMs: Math.round(totalMs), rate: Math.round((received / totalMs) * 1000), p50: r1(pct(lat, 50)), p99: r1(pct(lat, 99)), max: r1(lat[lat.length - 1] ?? NaN), received };
}

async function waitAll(recvAt: Float64Array, n: number, timeoutMs: number): Promise<void> {
  const t = performance.now();
  for (;;) {
    let c = 0;
    for (let i = 0; i < n; i++) if (recvAt[i] !== 0) c++;
    if (c >= n) return;
    if (performance.now() - t > timeoutMs) throw new Error(`시간 초과: ${c}/${n} 수신`);
    await sleep(20);
  }
}

const N = 10_000;
const SIZE = 256;
function payload(i: number): Buffer {
  const b = Buffer.alloc(SIZE, 120);
  b.writeUInt32BE(i, 0);
  return b;
}

async function benchRedis(prefix: string): Promise<BenchRow> {
  const pub = new Redis(REDIS_URL), sub = new Redis(REDIS_URL);
  const key = `${prefix}:stream`;
  const sendAt = new Float64Array(N), recvAt = new Float64Array(N);
  try {
    await pub.del(key);
    let stop = false;
    const reader = (async () => {
      let id = "0";
      while (!stop) {
        const res = (await sub.xreadBuffer("COUNT", 2000, "BLOCK", 200, "STREAMS", key, id)) as [Buffer, [Buffer, Buffer[]][]][] | null;
        if (!res) continue;
        const now = performance.now();
        for (const [, entries] of res) {
          for (const [eid, fields] of entries) {
            recvAt[fields[1].readUInt32BE(0)] = now;
            id = eid.toString();
          }
        }
      }
    })();
    const t0 = performance.now();
    for (let i = 0; i < N; i += 500) {
      const p = pub.pipeline();
      for (let j = i; j < Math.min(N, i + 500); j++) {
        sendAt[j] = performance.now();
        p.xadd(key, "*", "d", payload(j));
      }
      await p.exec();
    }
    const publishMs = performance.now() - t0;
    await waitAll(recvAt, N, 30_000);
    stop = true;
    await reader;
    return summarize("Redis Streams", "AOF 설정에 따름 (기본 everysec)", sendAt, recvAt, N, publishMs);
  } finally {
    await pub.del(key).catch(() => {});
    pub.disconnect();
    sub.disconnect();
  }
}

async function benchKafka(prefix: string): Promise<BenchRow> {
  const kafka = kafkaClient("mq-bench");
  const admin = kafka.admin();
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  const consumer = kafka.consumer({ groupId: `${prefix}-g`, maxWaitTimeInMs: 50 });
  const topic = `${prefix}.bench`;
  const sendAt = new Float64Array(N), recvAt = new Float64Array(N);
  try {
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    let joined = false;
    consumer.on(consumer.events.GROUP_JOIN, () => (joined = true));
    await consumer.run({
      eachBatch: async ({ batch }) => {
        const now = performance.now();
        for (const m of batch.messages) if (m.value) recvAt[m.value.readUInt32BE(0)] = now;
      },
    });
    for (let i = 0; i < 200 && !joined; i++) await sleep(50);
    const t0 = performance.now();
    for (let i = 0; i < N; i += 500) {
      const messages = [];
      for (let j = i; j < Math.min(N, i + 500); j++) {
        sendAt[j] = performance.now();
        messages.push({ value: payload(j) });
      }
      await producer.send({ topic, acks: -1, messages });
    }
    const publishMs = performance.now() - t0;
    await waitAll(recvAt, N, 40_000);
    return summarize("Kafka", "acks=all (복제 1)", sendAt, recvAt, N, publishMs);
  } finally {
    await consumer.disconnect().catch(() => {});
    await producer.disconnect().catch(() => {});
    await admin.deleteTopics({ topics: [topic] }).catch(() => {});
    await admin.disconnect().catch(() => {});
  }
}

async function benchRabbit(prefix: string): Promise<BenchRow> {
  const conn = await amqp.connect(RABBIT_URL);
  const pubCh = await conn.createConfirmChannel();
  const subCh = await conn.createChannel();
  const q = `${prefix}.bench`;
  const sendAt = new Float64Array(N), recvAt = new Float64Array(N);
  try {
    await pubCh.assertQueue(q, { durable: true });
    await subCh.prefetch(1000);
    await subCh.consume(q, (m) => {
      if (!m) return;
      recvAt[m.content.readUInt32BE(0)] = performance.now();
      subCh.ack(m);
    });
    const t0 = performance.now();
    for (let i = 0; i < N; i += 500) {
      for (let j = i; j < Math.min(N, i + 500); j++) {
        sendAt[j] = performance.now();
        pubCh.sendToQueue(q, payload(j), { persistent: true });
      }
      await pubCh.waitForConfirms();
    }
    const publishMs = performance.now() - t0;
    await waitAll(recvAt, N, 40_000);
    return summarize("RabbitMQ", "persistent + publisher confirm", sendAt, recvAt, N, publishMs);
  } finally {
    await pubCh.deleteQueue(q).catch(() => {});
    await conn.close().catch(() => {});
  }
}

async function benchNatsCore(prefix: string): Promise<BenchRow> {
  const nc: NatsConnection = await natsConnect({ servers: NATS_URL });
  const subj = `${prefix}.core`;
  const sendAt = new Float64Array(N), recvAt = new Float64Array(N);
  try {
    const sub = nc.subscribe(subj);
    void (async () => {
      for await (const m of sub) recvAt[Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength).readUInt32BE(0)] = performance.now();
    })();
    await nc.flush();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      sendAt[i] = performance.now();
      nc.publish(subj, payload(i));
      if (i % 500 === 499) await nc.flush();
    }
    await nc.flush();
    const publishMs = performance.now() - t0;
    await waitAll(recvAt, N, 20_000).catch(() => {});
    sub.unsubscribe();
    return summarize("NATS core", "at-most-once (저장 없음)", sendAt, recvAt, N, publishMs);
  } finally {
    await nc.drain().catch(() => {});
  }
}

async function benchNatsJs(prefix: string): Promise<BenchRow> {
  const nc = await natsConnect({ servers: NATS_URL });
  const stream = `${prefix}_BENCH`.replace(/[^A-Za-z0-9_-]/g, "_").toUpperCase();
  const subj = `${stream.toLowerCase()}.data`;
  const jsm = await nc.jetstreamManager();
  const sendAt = new Float64Array(N), recvAt = new Float64Array(N);
  try {
    await jsm.streams.delete(stream).catch(() => {});
    await jsm.streams.add({ name: stream, subjects: [subj], storage: StorageType.File });
    await jsm.consumers.add(stream, { durable_name: "bench", ack_policy: AckPolicy.Explicit, max_ack_pending: 5000 });
    const js = nc.jetstream();
    const consumer = await js.consumers.get(stream, "bench");
    const iter = await consumer.consume({ max_messages: 2000 });
    void (async () => {
      for await (const m of iter) {
        recvAt[Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength).readUInt32BE(0)] = performance.now();
        m.ack();
      }
    })();
    const t0 = performance.now();
    for (let i = 0; i < N; i += 500) {
      const batch = [];
      for (let j = i; j < Math.min(N, i + 500); j++) {
        sendAt[j] = performance.now();
        batch.push(js.publish(subj, payload(j)));
      }
      await Promise.all(batch);
    }
    const publishMs = performance.now() - t0;
    await waitAll(recvAt, N, 40_000);
    iter.stop();
    return summarize("NATS JetStream", "파일 저장 + PubAck + 명시적 ack", sendAt, recvAt, N, publishMs);
  } finally {
    await jsm.streams.delete(stream).catch(() => {});
    await nc.drain().catch(() => {});
  }
}

export const mqBrokerBenchmark: CodeExperiment = {
  id: "mq-broker-benchmark",
  subject: "messaging",
  title: "같은 워크로드, 다섯 경로: 1만 메시지(256B)를 Redis Streams·Kafka·RabbitMQ·NATS core·JetStream 으로 보내고 받기",
  category: "비교",
  summary: "한 프로세스에서 소비자를 먼저 띄우고 1만 건을 500개 묶음으로 발행해, 브로커별 발행 시간·종단 처리량·p50/p99 지연을 표로 비교한다. 떠 있지 않은 브로커는 건너뛴다 (30~60초)",
  notes: ["06-four-brokers-same-workload", "01-queue-topic-log-models", "05-when-not-kafka"],
  description: `
숫자는 **이 노트북에서, Docker Desktop 포트 포워딩을 거친, 브로커 하나짜리** 환경의 값이다. 운영 클러스터의 절대 성능이 아니라 **같은 조건에서의 상대적 성격**을 보는 실험이다.
- 모든 경로가 **보장 수준이 다르다**. NATS core 는 저장도 ack 도 없다. Kafka 는 acks=all(복제 1), RabbitMQ 는 persistent + 퍼블리셔 확인, JetStream 은 파일 저장 + PubAck + 소비자 ack. 표의 '보장' 열을 같이 읽어야 한다.
- 지연은 "발행 직전 시각 → 소비 콜백 시각" 이다. 한 프로세스라 시계가 같다.
- 발행은 500개 묶음(파이프라인·배치·confirm 윈도)으로 보낸다. 한 건씩 기다리면 모든 브로커가 RTT 에 묶여 수천/초로 떨어진다 — [파이프라인](/redis/notes/06-pipelining) 과 같은 원리.
사전 준비: \`pnpm redis:docker\`, ${MQ_HINT} (Kafka 는 \`pnpm kafka:up\`, 없으면 건너뜀)
`,
  code: `// 공통: 소비자 먼저 → 500개씩 발행 → 전부 받을 때까지 대기
sendAt[i] = performance.now();  publish(payload(i));        // payload 앞 4바이트 = i
onMessage: recvAt[payload.readUInt32BE(0)] = performance.now();
latency = recvAt - sendAt;  rate = N / (lastRecv - firstSend)

Redis   : pipeline XADD × 500  /  XREAD BLOCK 200 COUNT 2000
Kafka   : producer.send({ acks: -1, messages: 500 })  /  eachBatch
Rabbit  : confirm channel sendToQueue × 500 + waitForConfirms  /  prefetch 1000 + ack
NATS    : nc.publish × 500 + flush  /  subscribe
JetStream: Promise.all(js.publish × 500)  /  consumer.consume + ack`,
  requires: async () => {
    const [r, rb, n] = await Promise.all([canRedis(), canRabbit(), canNats()]);
    const missing = [!r && "Redis(6379)", !rb && "RabbitMQ(5673)", !n && "NATS(14222)"].filter(Boolean);
    return missing.length ? `${missing.join(", ")} 에 연결할 수 없습니다. \`pnpm redis:docker\` 와 ${MQ_HINT}` : null;
  },
  async run({ rec, k }) {
    const prefix = k("b").replace(/_/g, "-");
    const kafkaUp = await canKafka();
    rec.note(`메시지 ${N.toLocaleString()}건 × ${SIZE}B, 500개 묶음 발행. Kafka: ${kafkaUp ? `연결됨 (${KAFKA_BROKERS.join(",")})` : "꺼져 있음 → 건너뜀"}`);
    const rows: BenchRow[] = [];
    const runs: [string, string, () => Promise<BenchRow>][] = [
      ["Redis Streams", "AOF 설정에 따름", () => benchRedis(prefix)],
      ["Kafka", "acks=all (복제 1)", () => benchKafka(prefix)],
      ["RabbitMQ", "persistent + publisher confirm", () => benchRabbit(prefix)],
      ["NATS core", "at-most-once (저장 없음)", () => benchNatsCore(prefix)],
      ["NATS JetStream", "파일 저장 + PubAck + 명시적 ack", () => benchNatsJs(prefix)],
    ];
    for (const [name, guarantee, fn] of runs) {
      if (name === "Kafka" && !kafkaUp) {
        rows.push({ broker: name, guarantee, status: "건너뜀 (브로커 없음)" });
        continue;
      }
      try {
        rows.push(await rec.measure(`${name}: ${N.toLocaleString()}건 발행 → 소비`, fn));
      } catch (e) {
        rows.push({ broker: name, guarantee, status: `실패: ${(e as Error).message.slice(0, 80)}` });
      }
    }
    rec.steps.push({
      cmd: "결과 (ms·msg/s, 이 노트북·Docker Desktop·단일 브로커 기준)",
      result: rows.map((r) => (r.status === "측정" ? { 브로커: r.broker, 보장: r.guarantee, "발행(ms)": r.publishMs, "종단(ms)": r.totalMs, "처리량(msg/s)": r.rate, "p50(ms)": r.p50, "p99(ms)": r.p99, "max(ms)": r.max, 수신: r.received } : { 브로커: r.broker, 보장: r.guarantee, 상태: r.status })),
      ms: 0,
    });
    const measured = rows.filter((r) => r.status === "측정");
    const must = ["Redis Streams", "RabbitMQ", "NATS JetStream"];
    rec.check("Redis·RabbitMQ·NATS JetStream 은 1만 건을 전부 받았다", must.every((b) => measured.find((r) => r.broker === b)?.received === N), measured.map((r) => `${r.broker}:${r.received}`));
    const core = measured.find((r) => r.broker === "NATS core");
    if (core) rec.note(`NATS core 수신 ${core.received}/${N} — 저장·ack 가 없어 소비자가 느리면 버려진다(slow consumer). 그래서 가장 빠르지만 '잃어도 되는' 메시지에만 쓴다.`);
    const fastest = [...measured].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
    const lowest = [...measured].sort((a, b) => (a.p99 ?? 0) - (b.p99 ?? 0))[0];
    rec.note(`처리량 1위 ${fastest?.broker} (${fastest?.rate?.toLocaleString()} msg/s), p99 최저 ${lowest?.broker} (${lowest?.p99}ms). 묶음 발행이라 지연에는 '묶음이 다 나갈 때까지' 기다리는 시간이 섞여 있다 — 처리량과 지연은 늘 트레이드오프다.`);
  },
};
