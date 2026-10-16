import { Kafka, logLevel } from "kafkajs";
import { Client } from "pg";
import { KAFKA_BROKERS } from "./kafka";
import { PG_URL } from "./postgres";
import type { CodeExperiment } from "./types";

const CONNECT = "http://127.0.0.1:18083";

async function connectApi<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T | null }> {
  try {
    const r = await fetch(`${CONNECT}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    return { ok: r.ok, status: r.status, body: text ? (JSON.parse(text) as T) : null };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

export const cdcOutboxDebezium: CodeExperiment = {
  id: "cdc-outbox-debezium",
  subject: "kafka",
  title: "CDC: Debezium 이 PostgreSQL outbox 테이블의 INSERT 를 Kafka 이벤트로 바꾼다",
  category: "통합",
  summary: "Kafka Connect 에 Debezium PostgreSQL 커넥터를 등록하고(논리 복제 슬롯), outbox 테이블에 행을 넣으면 폴링 없이 Kafka 토픽에 이벤트가 도착하는 것을 확인. EventRouter SMT 로 aggregate 별 토픽 라우팅",
  notes: ["06-streams-connect-schema", "04-delivery-guarantees"],
  description: `
**이중 쓰기 문제**(DB 저장과 이벤트 발행 사이에 죽으면 불일치)의 정석 해법 = Outbox + CDC.
앱은 같은 트랜잭션에서 \`orders\` 와 \`outbox\` 에 쓰고, **Debezium** 이 PostgreSQL 의 WAL(논리 복제)을 읽어 outbox 행을 Kafka 로 보낸다. 앱은 Kafka 를 몰라도 된다.
\`EventRouter\` SMT 는 outbox 행의 \`aggregatetype\` 으로 토픽을 정하고 \`aggregateid\` 를 키로 써서 같은 주문의 이벤트 순서를 보장한다.
사전 준비: \`pnpm cdc:up\` (kafka + postgres(wal_level=logical) + connect, 처음엔 1~2분).
`,
  code: `# 커넥터 등록 (Connect REST)
curl -X POST localhost:18083/connectors -H 'Content-Type: application/json' -d '{ "name": "study-outbox", "config": {
  "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
  "database.hostname": "postgres", "database.user": "study", "database.password": "study", "database.dbname": "study",
  "topic.prefix": "pg", "plugin.name": "pgoutput", "slot.name": "study_outbox", "publication.autocreate.mode": "filtered",
  "table.include.list": "public.outbox",
  "transforms": "outbox", "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
  "transforms.outbox.route.topic.replacement": "outbox.\${routedByValue}" } }'
# 앱 트랜잭션
BEGIN; INSERT INTO orders …; INSERT INTO outbox (id, aggregatetype, aggregateid, type, payload) VALUES (gen_random_uuid(), 'order', '42', 'OrderCreated', '{"amount": 89000}'); COMMIT;
# Kafka 토픽 outbox.order 에 key=42, value={"amount":89000} 도착
SELECT slot_name, active, confirmed_flush_lsn FROM pg_replication_slots;`,
  requires: async () => {
    const r = await connectApi<string[]>("/connectors");
    if (!r.ok) return "Kafka Connect(18083) 에 연결할 수 없습니다. `pnpm cdc:up` 후 1~2분 기다리세요 (docker logs study-connect).";
    const c = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 3000 });
    try {
      await c.connect();
      const wal = (await c.query("show wal_level")).rows[0].wal_level;
      if (wal !== "logical") return `PostgreSQL wal_level 이 ${wal} 입니다. logical 이어야 합니다 (compose 의 postgres command 확인 후 --force-recreate).`;
      return null;
    } catch {
      return "PostgreSQL 에 연결할 수 없습니다 (`pnpm pg:up`).";
    } finally {
      await c.end().catch(() => {});
    }
  },
  async run({ rec }) {
    const pg = new Client({ connectionString: PG_URL });
    await pg.connect();
    const kafka = new Kafka({ clientId: "cdc-lab", brokers: KAFKA_BROKERS, logLevel: logLevel.NOTHING });
    const admin = kafka.admin();
    const consumer = kafka.consumer({ groupId: `cdc-lab-${Date.now()}` });
    const name = "study-outbox";
    const topic = "outbox.order";
    try {
      await pg.query(`create table if not exists outbox (id uuid primary key, aggregatetype text not null, aggregateid text not null, type text not null, payload jsonb not null, created_at timestamptz default now())`);
      await pg.query(`create table if not exists orders (id serial primary key, amount int, created_at timestamptz default now())`);
      await connectApi(`/connectors/${name}`, { method: "DELETE" });
      await pg.query("select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = 'study_outbox' and not active").catch(() => {});
      const reg = await rec.measure("POST /connectors (Debezium PostgresConnector + EventRouter SMT)", () =>
        connectApi<{ name: string }>("/connectors", {
          method: "POST",
          body: JSON.stringify({
            name,
            config: {
              "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
              "database.hostname": "postgres", "database.port": "5432", "database.user": "study", "database.password": "study", "database.dbname": "study",
              "topic.prefix": "pg", "plugin.name": "pgoutput", "slot.name": "study_outbox", "publication.name": "study_pub", "publication.autocreate.mode": "filtered",
              "table.include.list": "public.outbox", "tombstones.on.delete": "false",
              "transforms": "outbox", "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
              "transforms.outbox.table.field.event.key": "aggregateid",
              "transforms.outbox.route.topic.replacement": "outbox.${routedByValue}",
              "key.converter": "org.apache.kafka.connect.storage.StringConverter",
              "value.converter": "org.apache.kafka.connect.json.JsonConverter", "value.converter.schemas.enable": "false",
            },
          }),
        }),
      );
      rec.check("커넥터 등록 (201)", reg.status === 201 || reg.status === 409, reg.status);
      const state = await rec.measure("커넥터 RUNNING 대기", async () => {
        for (let i = 0; i < 40; i++) {
          const st = await connectApi<{ connector: { state: string }; tasks: { state: string; trace?: string }[] }>(`/connectors/${name}/status`);
          const t = st.body?.tasks?.[0];
          if (st.body?.connector?.state === "RUNNING" && t?.state === "RUNNING") return "RUNNING";
          if (t?.state === "FAILED") throw new Error(`task FAILED: ${(t.trace ?? "").split("\n")[0]}`);
          if (st.body?.connector?.state === "FAILED") throw new Error("connector FAILED");
          await new Promise((r) => setTimeout(r, 1500));
        }
        throw new Error("커넥터가 RUNNING 이 되지 않음");
      });
      void state;
      const slot = (await pg.query("select slot_name, active, plugin from pg_replication_slots where slot_name = 'study_outbox'")).rows[0];
      rec.steps.push({ cmd: "pg_replication_slots", result: slot, ms: 0 });
      rec.check("논리 복제 슬롯이 active (Debezium 이 WAL 을 읽는 중)", slot?.active === true, slot);

      await admin.connect();
      await consumer.connect();
      await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] }).catch(() => {});
      await consumer.subscribe({ topic, fromBeginning: true });
      const got: { key: string; value: string; ms: number }[] = [];
      const t0 = performance.now();
      await consumer.run({ eachMessage: async ({ message }) => void got.push({ key: message.key?.toString() ?? "", value: message.value?.toString() ?? "", ms: Math.round(performance.now() - t0) }) });

      rec.note("앱 트랜잭션: orders + outbox 를 한 트랜잭션에 (이중 쓰기 없음)");
      const orderId = `${Date.now() % 100000}`;
      await pg.query("begin");
      await pg.query("insert into orders (amount) values ($1)", [89000]);
      await pg.query("insert into outbox (id, aggregatetype, aggregateid, type, payload) values (gen_random_uuid(), 'order', $1, 'OrderCreated', $2)", [orderId, JSON.stringify({ orderId, amount: 89000 })]);
      await pg.query("insert into outbox (id, aggregatetype, aggregateid, type, payload) values (gen_random_uuid(), 'order', $1, 'OrderPaid', $2)", [orderId, JSON.stringify({ orderId, method: "card" })]);
      await pg.query("commit");
      rec.steps.push({ cmd: "BEGIN; INSERT orders; INSERT outbox ×2 (OrderCreated, OrderPaid); COMMIT", result: `aggregateid=${orderId}`, ms: 0 });

      await rec.measure("Kafka 토픽 outbox.order 에 이벤트 2개 도착 대기", async () => {
        for (let i = 0; i < 60; i++) {
          if (got.filter((g) => g.key === orderId).length >= 2) return `${got.filter((g) => g.key === orderId).map((g) => g.ms + "ms").join(", ")}`;
          await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error("이벤트가 도착하지 않음");
      });
      const mine = got.filter((g) => g.key === orderId);
      rec.steps.push({ cmd: "수신 이벤트 (key / value)", result: mine.map((g) => `${g.key} → ${g.value.slice(0, 120)}`), ms: 0 });
      rec.check("같은 aggregateid 가 키 → 같은 파티션 → 순서 보장 (Created 가 Paid 보다 먼저)", mine.length >= 2 && mine[0].value.includes("89000") && mine[1].value.includes("card"));
      rec.note("앱 코드 어디에도 Kafka 호출이 없다. DB 트랜잭션이 커밋되면 반드시 이벤트가 나간다(at-least-once) — 소비자는 멱등.");
      const lsn = (await pg.query("select confirmed_flush_lsn, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) lag from pg_replication_slots where slot_name='study_outbox'")).rows[0];
      rec.note(`슬롯 LSN 지연 ${lsn?.lag} — Connect 가 멈추면 이 값이 자라며 WAL 디스크를 채운다. 모니터링 필수.`);
    } finally {
      await consumer.disconnect().catch(() => {});
      await admin.disconnect().catch(() => {});
      await connectApi(`/connectors/${name}`, { method: "DELETE" });
      await new Promise((r) => setTimeout(r, 1500));
      await pg.query("select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = 'study_outbox' and not active").catch(() => {});
      await pg.query("drop publication if exists study_pub").catch(() => {});
      await pg.end();
    }
  },
};
