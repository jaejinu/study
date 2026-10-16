import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { Kafka, logLevel } from "kafkajs";
import { Client } from "pg";
import { KAFKA_BROKERS } from "./kafka";
import { PG_URL } from "./postgres";
import type { CodeExperiment } from "./types";

/**
 * 데이터 엔지니어링 주제 실험. 엔진은 DuckDB(@duckdb/node-api, 프로세스 안에서 동작).
 * S3 호환 저장소는 실험이 직접 띄우는 versitygw 컨테이너(lab-de-s3, 127.0.0.1:19102)를 쓴다.
 */

async function duck(): Promise<{ c: DuckDBConnection; q: <T = Record<string, unknown>>(sql: string) => Promise<T[]>; close: () => void }> {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  const q = async <T,>(sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as unknown as T[];
  return { c, q, close: () => c.closeSync() };
}

function sh(bin: string, args: string[], timeout = 120_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => execFile(bin, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || stderr).trim() })));
}

const fmtMB = (b: number) => `${(b / 1e6).toFixed(2)}MB`;

async function timeIt<T>(fn: () => Promise<T>, repeat = 3): Promise<{ v: T; ms: number }> {
  let best = Infinity;
  let v!: T;
  for (let i = 0; i < repeat; i++) {
    const t0 = performance.now();
    v = await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { v, ms: Math.round(best * 10) / 10 };
}

// ---------------------------------------------------------------- 1. CSV vs Parquet, 행 그룹 통계
export const deParquetDuckdb: CodeExperiment = {
  id: "de-parquet-duckdb",
  subject: "data-engineering",
  title: "같은 100만 행을 CSV 와 Parquet 로: 파일 크기, 열 하나 집계 시간, 행 그룹 통계로 건너뛰기",
  category: "파일 포맷",
  summary: "DuckDB 로 합성 이벤트 100만 행을 CSV, Parquet(무압축·Snappy·ZSTD) 로 쓰고 파일 크기와 'event 별 amount 평균' 집계 시간을 비교한다. 이어서 시간순 정렬 파일과 섞은 파일의 행 그룹 min/max 통계를 parquet_metadata 로 읽어 '1시간 범위' 질의가 몇 개 행 그룹을 건너뛸 수 있는지 센다",
  notes: ["02-columnar-formats-lakehouse", "01-batch-vs-streaming"],
  description: `
레이크하우스의 바닥은 **파일 포맷** 이다. CSV 는 행 단위 텍스트라 열 하나를 읽으려 해도 전부 파싱해야 한다. **Parquet** 은 행을 **행 그룹**(기본 10만~100만 행)으로 나누고, 그 안에서 **열마다 따로** 압축해 저장하며, 행 그룹·열마다 **min/max 통계** 를 꼬리(footer)에 둔다.
그래서 (1) 필요한 열만 읽고(projection pushdown), (2) 통계로 조건에 맞지 않는 행 그룹을 통째로 건너뛴다(predicate pushdown). 단, 건너뛰기는 **데이터가 그 열로 정렬돼 있을 때만** 효과가 있다 — 이 실험이 그 차이를 숫자로 보여 준다.
`,
  code: `CREATE TABLE ev AS SELECT TIMESTAMP '2026-10-01' + to_seconds(i) ts, hash(i) % 50000 user_id,
  ['view','view','view','click','buy'][hash(i*7) % 5 + 1] event, (hash(i*13) % 100000) / 100.0 amount
  FROM range(1000000) t(i);
COPY ev TO 'ev.csv' (HEADER);
COPY ev TO 'ev_zstd.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000);
SELECT event, avg(amount) FROM 'ev_zstd.parquet' GROUP BY event;
SELECT row_group_id, stats_min, stats_max FROM parquet_metadata('ev_zstd.parquet') WHERE path_in_schema = 'ts';`,
  async run({ rec }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "de-parquet-"));
    const { q, close } = await duck();
    const f = (n: string) => path.join(dir, n);
    try {
      await rec.measure("CREATE TABLE ev — 합성 이벤트 100만 행 (1초 간격 시간순)", () =>
        q(`CREATE TABLE ev AS SELECT TIMESTAMP '2026-10-01' + to_seconds(i) AS ts, (hash(i) % 50000)::INT AS user_id,
             ['view','view','view','click','buy'][(hash(i * 7) % 5)::INT + 1] AS event, ((hash(i * 13) % 100000) / 100.0)::DOUBLE AS amount,
             ['KR','KR','KR','JP','US','DE'][(hash(i * 17) % 6)::INT + 1] AS country
           FROM range(1000000) t(i)`),
      );
      const variants: [string, string][] = [
        ["ev.csv", `COPY ev TO '${f("ev.csv")}' (HEADER)`],
        ["ev_plain.parquet", `COPY ev TO '${f("ev_plain.parquet")}' (FORMAT parquet, COMPRESSION uncompressed, ROW_GROUP_SIZE 100000)`],
        ["ev_snappy.parquet", `COPY ev TO '${f("ev_snappy.parquet")}' (FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE 100000)`],
        ["ev_zstd.parquet", `COPY ev TO '${f("ev_zstd.parquet")}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)`],
      ];
      const table: string[][] = [];
      const size: Record<string, number> = {};
      const agg: Record<string, number> = {};
      for (const [name, sql] of variants) {
        const w = await timeIt(() => q(sql), 1);
        size[name] = (await fs.stat(f(name))).size;
        const reader = name.endsWith(".csv") ? `read_csv('${f(name)}', header = true)` : `read_parquet('${f(name)}')`;
        const r = await timeIt(() => q(`SELECT event, round(avg(amount), 2) avg FROM ${reader} GROUP BY event ORDER BY event`));
        agg[name] = r.ms;
        table.push([name, fmtMB(size[name]), `${w.ms}ms`, `${r.ms}ms`]);
      }
      rec.steps.push({ cmd: "같은 100만 행 — 파일 크기 · 쓰기 시간 · 'event 별 avg(amount)' 집계 시간(3회 중 최소)", result: { columns: ["파일", "크기", "쓰기", "집계"], rows: table }, ms: 0 });
      rec.check("ZSTD Parquet 는 CSV 의 1/3 이하 크기", size["ev_zstd.parquet"] * 3 < size["ev.csv"], { csv: fmtMB(size["ev.csv"]), zstd: fmtMB(size["ev_zstd.parquet"]) });
      rec.check("열 두 개만 읽는 집계는 Parquet 가 CSV 보다 빠르다 (CSV 는 모든 열을 파싱)", agg["ev_zstd.parquet"] < agg["ev.csv"], { csv: agg["ev.csv"], parquet: agg["ev_zstd.parquet"] });

      rec.note("행 그룹 통계: 시간순으로 쓴 파일 vs 무작위로 섞어 쓴 파일");
      await q(`COPY (SELECT * FROM ev ORDER BY hash(user_id, ts)) TO '${f("ev_shuffled.parquet")}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)`);
      const lo = "2026-10-05 00:00:00";
      const hi = "2026-10-05 01:00:00";
      const groups = async (file: string) => q<{ row_group_id: number; stats_min: string; stats_max: string }>(`SELECT row_group_id, stats_min, stats_max FROM parquet_metadata('${f(file)}') WHERE path_in_schema = 'ts' ORDER BY row_group_id`);
      const sortedG = await groups("ev_zstd.parquet");
      const shuffledG = await groups("ev_shuffled.parquet");
      const overlap = (g: { stats_min: string; stats_max: string }[]) => g.filter((x) => !(x.stats_max < lo || x.stats_min > hi)).length;
      rec.steps.push({ cmd: "parquet_metadata(...) WHERE path_in_schema='ts' — 정렬 파일의 행 그룹 min/max (앞 3개)", result: sortedG.slice(0, 3), ms: 0 });
      rec.steps.push({ cmd: "parquet_metadata(...) — 섞은 파일의 행 그룹 min/max (앞 3개)", result: shuffledG.slice(0, 3), ms: 0 });
      const qRange = (file: string) => timeIt(() => q(`SELECT count(*) n, round(sum(amount)) s FROM read_parquet('${f(file)}') WHERE ts BETWEEN TIMESTAMP '${lo}' AND TIMESTAMP '${hi}'`));
      const s1 = await qRange("ev_zstd.parquet");
      const s2 = await qRange("ev_shuffled.parquet");
      rec.steps.push({
        cmd: `WHERE ts BETWEEN '${lo}' AND '${hi}' — 통계상 읽어야 하는 행 그룹 / 전체`,
        result: { columns: ["파일", "후보 행 그룹", "결과", "시간"], rows: [["시간순 정렬", `${overlap(sortedG)} / ${sortedG.length}`, JSON.stringify(s1.v[0]), `${s1.ms}ms`], ["섞음", `${overlap(shuffledG)} / ${shuffledG.length}`, JSON.stringify(s2.v[0]), `${s2.ms}ms`]] },
        ms: 0,
      });
      rec.check("정렬된 파일은 1시간 범위에 행 그룹 1~2개만 후보", overlap(sortedG) <= 2, overlap(sortedG));
      rec.check("섞은 파일은 모든 행 그룹이 후보 — 통계가 아무것도 못 거른다", overlap(shuffledG) === shuffledG.length, overlap(shuffledG));
      rec.note("레이크하우스에서 '쓰기 전에 무엇으로 정렬(또는 클러스터링)하나' 가 질의 비용을 정한다. Iceberg 의 sort order·Z-order, ClickHouse 의 ORDER BY, Delta 의 OPTIMIZE ZORDER 가 모두 같은 이야기다.");
    } finally {
      close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};

// ---------------------------------------------------------------- 2. CDC → Kafka → S3 Parquet → DuckDB
const CONNECT = "http://127.0.0.1:18083";
const S3_PORT = 19102;
const S3_NAME = "lab-de-s3";

async function connectApi<T>(p: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T | null }> {
  try {
    const r = await fetch(`${CONNECT}${p}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    return { ok: r.ok, status: r.status, body: text ? (JSON.parse(text) as T) : null };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

async function startS3(): Promise<boolean> {
  await sh("docker", ["rm", "-f", S3_NAME]);
  const r = await sh("docker", ["run", "-d", "--name", S3_NAME, "-p", `127.0.0.1:${S3_PORT}:7070`, "-e", "ROOT_ACCESS_KEY=study", "-e", "ROOT_SECRET_KEY=study-secret", "--entrypoint", "sh", "versity/versitygw:latest", "-c", "mkdir -p /data/lake && exec versitygw posix /data"], 300_000);
  if (!r.ok) return false;
  for (let i = 0; i < 30; i++) {
    const ok = await fetch(`http://127.0.0.1:${S3_PORT}/`, { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false);
    if (ok) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

export const deCdcToLake: CodeExperiment = {
  id: "de-cdc-to-lake",
  subject: "data-engineering",
  title: "작은 레이크하우스: PostgreSQL 변경 → Debezium → Kafka → S3 Parquet → DuckDB 로 원본과 대조",
  category: "파이프라인",
  summary: "PG 테이블에 행을 넣고 Debezium 커넥터를 등록해 스냅샷을 받은 뒤 UPDATE·DELETE·INSERT 를 섞는다. Kafka 토픽의 변경 이벤트를 소비해 마이크로배치마다 Parquet 로 S3(versitygw) 에 쓰고, DuckDB 가 S3 의 Parquet 를 읽어 '키별 최신 버전' 을 복원했을 때 PG 원본과 건수·합계·삭제 반영이 정확히 일치하는지 확인한다",
  notes: ["01-batch-vs-streaming", "02-columnar-formats-lakehouse", "07-tiny-lakehouse-design"],
  description: `
운영 DB 를 분석하고 싶을 때 가장 나쁜 방법은 운영 DB 에 무거운 분석 질의를 거는 것이다. 정석은 **CDC** 로 변경을 빼내 **객체 저장소에 열 포맷으로 쌓고**, 분석 엔진이 그 파일을 읽는 것이다.
변경 로그는 "행의 현재 상태" 가 아니라 "일어난 일의 목록" 이다. 같은 id 의 INSERT·UPDATE·DELETE 가 차례로 쌓이므로, 질의할 때 **키별로 가장 늦은 이벤트만 남기고(merge-on-read)** 삭제 표시가 된 것은 버려야 현재 상태가 된다. Iceberg·Delta·Hudi 는 이 병합과 파일 관리를 테이블 포맷 수준에서 해 준다 — 이 실험은 그걸 손으로 해 본다.
사전 준비: \`pnpm cdc:up\` (Kafka + PostgreSQL + Kafka Connect). S3 는 실험이 versitygw 컨테이너를 잠깐 띄운다.
`,
  code: `-- PG
CREATE TABLE de_orders (id int PRIMARY KEY, customer text, amount double precision, status text);
-- Debezium (ExtractNewRecordState 로 평평한 레코드 + __op, __deleted)
POST /connectors { "connector.class": "...PostgresConnector", "table.include.list": "public.de_orders", "topic.prefix": "de",
  "transforms": "unwrap", "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
  "transforms.unwrap.add.fields": "op,source.ts_ms", "transforms.unwrap.delete.tombstone.handling.mode": "rewrite" }
-- 소비 → 배치마다 Parquet 를 S3 에
COPY (SELECT * FROM read_json_auto('batch.ndjson')) TO 's3://lake/orders_cdc/batch=0001/part.parquet';
-- 현재 상태 복원 (merge-on-read)
SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY id ORDER BY _offset DESC) rn
               FROM read_parquet('s3://lake/orders_cdc/*/*.parquet')) WHERE rn = 1 AND __deleted = 'false';`,
  requires: async () => {
    const c = await connectApi("/connectors");
    if (!c.ok) return "Kafka Connect(18083) 가 꺼져 있습니다. `pnpm cdc:up` 후 1~2분 기다리세요.";
    const d = await sh("docker", ["version", "--format", "{{.Server.Version}}"], 6000);
    if (!d.ok) return "Docker 가 필요합니다 (S3 호환 저장소 컨테이너).";
    return null;
  },
  async run({ rec }) {
    const pg = new Client({ connectionString: PG_URL });
    await pg.connect();
    const kafka = new Kafka({ clientId: "de-lab", brokers: KAFKA_BROKERS, logLevel: logLevel.NOTHING });
    const admin = kafka.admin();
    const consumer = kafka.consumer({ groupId: `de-lab-${Date.now()}` });
    const name = "de-lake";
    // 실행마다 고유한 토픽 접두어 — 이전 실행의 토픽 삭제와 Debezium 의 재생성이 겹치는 경쟁을 피한다
    const prefix = `delab${Date.now().toString(36)}`;
    const topic = `${prefix}.public.de_orders`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "de-cdc-"));
    const { q, close } = await duck();
    const cleanupConnector = async () => {
      await connectApi(`/connectors/${name}`, { method: "DELETE" });
      for (let i = 0; i < 10; i++) {
        const r = await pg.query("select active from pg_replication_slots where slot_name = 'de_lake'");
        if (!r.rows.length || !r.rows[0].active) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      await pg.query("select pg_drop_replication_slot('de_lake') from pg_replication_slots where slot_name = 'de_lake'").catch(() => {});
      await pg.query("drop publication if exists de_pub").catch(() => {});
    };
    try {
      await cleanupConnector();
      await admin.connect();
      const stale = (await admin.listTopics().catch(() => [] as string[])).filter((t) => /^delab[0-9a-z]+\.public\.de_orders$/.test(t));
      if (stale.length) await admin.deleteTopics({ topics: stale }).catch(() => {});
      await pg.query("drop table if exists de_orders");
      await pg.query("create table de_orders (id int primary key, customer text not null, amount double precision not null, status text not null)");
      await pg.query(`insert into de_orders select i, 'c' || (i % 37), round((random() * 1000)::numeric, 2), 'placed' from generate_series(1, 200) i`);
      rec.steps.push({ cmd: "PG: CREATE TABLE de_orders + INSERT 200행 (커넥터 등록 전 — 스냅샷으로 들어갈 것)", result: "ok", ms: 0 });

      const s3ok = await rec.measure(`docker run ${S3_NAME} — S3 호환 저장소 versitygw (127.0.0.1:${S3_PORT}, 버킷 lake)`, startS3);
      rec.check("S3 저장소가 떴다", s3ok);
      await q("INSTALL httpfs; LOAD httpfs;");
      await q(`CREATE SECRET lake (TYPE s3, KEY_ID 'study', SECRET 'study-secret', ENDPOINT '127.0.0.1:${S3_PORT}', URL_STYLE 'path', USE_SSL false, REGION 'us-east-1')`);

      const reg = await rec.measure("POST /connectors — Debezium PostgresConnector + ExtractNewRecordState", async () => {
        const r = await connectApi("/connectors", {
          method: "POST",
          body: JSON.stringify({
            name,
            config: {
              "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
              "database.hostname": "postgres", "database.port": "5432", "database.user": "study", "database.password": "study", "database.dbname": "study",
              "topic.prefix": prefix, "plugin.name": "pgoutput", "slot.name": "de_lake", "publication.name": "de_pub", "publication.autocreate.mode": "filtered",
              "table.include.list": "public.de_orders", "snapshot.mode": "initial",
              "transforms": "unwrap", "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
              "transforms.unwrap.add.fields": "op,source.ts_ms", "transforms.unwrap.delete.tombstone.handling.mode": "rewrite",
              "key.converter": "org.apache.kafka.connect.json.JsonConverter", "key.converter.schemas.enable": "false",
              "value.converter": "org.apache.kafka.connect.json.JsonConverter", "value.converter.schemas.enable": "false",
            },
          }),
        });
        return { status: r.status };
      });
      rec.check("커넥터 등록", reg.status === 201 || reg.status === 409, reg.status);
      await rec.measure("커넥터 RUNNING 대기", async () => {
        for (let i = 0; i < 40; i++) {
          const st = await connectApi<{ connector: { state: string }; tasks: { state: string; trace?: string }[] }>(`/connectors/${name}/status`);
          const t = st.body?.tasks?.[0];
          if (st.body?.connector?.state === "RUNNING" && t?.state === "RUNNING") return "RUNNING";
          if (t?.state === "FAILED") throw new Error(`task FAILED: ${(t.trace ?? "").split("\n")[0]}`);
          await new Promise((r) => setTimeout(r, 1500));
        }
        throw new Error("커넥터가 RUNNING 이 되지 않음");
      });

      type Ev = Record<string, unknown> & { _offset: number };
      const got: Ev[] = [];
      await consumer.connect();
      for (let i = 0; i < 40; i++) {
        const md = await admin.fetchTopicMetadata({ topics: [topic] }).catch(() => null);
        if (md?.topics?.[0]?.partitions?.length && md.topics[0].partitions.every((p) => p.leader >= 0)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await consumer.subscribe({ topic, fromBeginning: true });
      await consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          got.push({ ...(JSON.parse(message.value.toString()) as Record<string, unknown>), _offset: Number(message.offset) });
        },
      });
      const waitFor = async (n: number, label: string) =>
        rec.measure(label, async () => {
          for (let i = 0; i < 120; i++) {
            if (got.length >= n) return `${got.length}건`;
            await new Promise((r) => setTimeout(r, 500));
          }
          throw new Error(`이벤트가 ${got.length}/${n} 건만 도착`);
        });
      await waitFor(200, "스냅샷 이벤트 200건 도착 대기 (__op = r)");

      const writeBatch = async (no: number, evs: Ev[]) => {
        const file = path.join(dir, `batch-${no}.ndjson`);
        await fs.writeFile(file, evs.map((e) => JSON.stringify(e)).join("\n"));
        const key = `s3://lake/orders_cdc/batch=${String(no).padStart(4, "0")}/part.parquet`;
        await q(`COPY (SELECT id::INT id, customer, amount::DOUBLE amount, status, __op, __deleted, __source_ts_ms::BIGINT __source_ts_ms, _offset::BIGINT _offset FROM read_json_auto('${file}')) TO '${key}' (FORMAT parquet, COMPRESSION zstd)`);
        return key;
      };
      const k1 = await rec.measure("마이크로배치 1 → S3 Parquet (스냅샷 200건)", () => writeBatch(1, got.slice(0, 200)));
      void k1;

      await pg.query("update de_orders set status = 'paid', amount = amount + 10 where id % 4 = 0");
      await pg.query("delete from de_orders where id % 20 = 1");
      await pg.query(`insert into de_orders select i, 'c' || (i % 37), round((random() * 1000)::numeric, 2), 'placed' from generate_series(201, 220) i`);
      await pg.query("update de_orders set status = 'shipped' where id in (4, 8, 12)");
      rec.steps.push({ cmd: "PG: UPDATE 50행(paid) · DELETE 10행 · INSERT 20행 · UPDATE 3행(shipped, 같은 행을 두 번 변경)", result: "변경 83건", ms: 0 });
      await waitFor(283, "변경 이벤트 83건 추가 도착 대기 (u · d · c)");
      await rec.measure("마이크로배치 2 → S3 Parquet (변경 83건)", () => writeBatch(2, got.slice(200, 283)));

      const ops = await q<{ __op: string; n: number }>(`SELECT __op, count(*) n FROM read_parquet('s3://lake/orders_cdc/*/*.parquet') GROUP BY __op ORDER BY __op`);
      rec.steps.push({ cmd: "S3 의 Parquet 전체 — 연산 종류별 이벤트 수 (r=스냅샷, c=insert, u=update, d=delete)", result: ops, ms: 0 });
      const lake = await q<{ n: number; s: number; maxid: number }>(`
        WITH latest AS (
          SELECT *, row_number() OVER (PARTITION BY id ORDER BY _offset DESC) rn
          FROM read_parquet('s3://lake/orders_cdc/*/*.parquet'))
        SELECT count(*) n, round(sum(amount), 2) s, max(id) maxid FROM latest WHERE rn = 1 AND __deleted = 'false'`);
      const src = (await pg.query("select count(*)::int n, round(sum(amount)::numeric, 2)::float s, max(id) maxid from de_orders")).rows[0] as { n: number; s: number; maxid: number };
      const shipped = await q<{ n: number }>(`SELECT count(*) n FROM (SELECT *, row_number() OVER (PARTITION BY id ORDER BY _offset DESC) rn FROM read_parquet('s3://lake/orders_cdc/*/*.parquet')) WHERE rn = 1 AND status = 'shipped'`);
      rec.steps.push({ cmd: "현재 상태 복원(merge-on-read) vs PG 원본", result: { columns: ["", "행 수", "amount 합", "max(id)"], rows: [["레이크(DuckDB)", String(lake[0].n), String(lake[0].s), String(lake[0].maxid)], ["PG 원본", String(src.n), String(src.s), String(src.maxid)]] }, ms: 0 });
      rec.check("행 수·합계·최대 id 가 원본과 정확히 같다", Number(lake[0].n) === src.n && Math.abs(Number(lake[0].s) - src.s) < 0.01 && Number(lake[0].maxid) === src.maxid, { lake: lake[0], pg: src });
      rec.check("같은 행을 두 번 바꾼 경우 마지막 상태(shipped 3건)가 남는다", Number(shipped[0].n) === 3, shipped[0]);
      const naive = await q<{ n: number }>(`SELECT count(*) n FROM read_parquet('s3://lake/orders_cdc/*/*.parquet')`);
      rec.note(`병합 없이 파일을 그냥 세면 ${naive[0].n}건 — 변경 로그는 '현재 상태' 가 아니다. 키별 최신만 남기고 __deleted 를 거르는 병합(또는 Iceberg/Delta 의 MERGE)이 필요하다.`);
      const objs = await sh("docker", ["exec", S3_NAME, "sh", "-c", "find /data/lake -type f | sort"]);
      rec.steps.push({ cmd: "S3 버킷의 객체 (versitygw 는 디렉터리 = 버킷)", result: objs.out.split("\n").map((l) => l.replace("/data/", "s3://")), ms: 0 });
    } finally {
      await consumer.disconnect().catch(() => {});
      await cleanupConnector().catch(() => {});
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.disconnect().catch(() => {});
      await pg.query("drop table if exists de_orders").catch(() => {});
      await pg.end().catch(() => {});
      close();
      await sh("docker", ["rm", "-f", S3_NAME]);
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
};

// ---------------------------------------------------------------- 3. 데이터 품질 검사 (dbt 식 테스트)
export const deQualityChecks: CodeExperiment = {
  id: "de-quality-checks",
  subject: "data-engineering",
  title: "데이터 품질 검사: dbt 식 테스트 6종을 SQL 로 짜서 일부러 오염시킨 데이터의 불량 행을 찾아낸다",
  category: "품질",
  summary: "고객 1천·주문 1만 행에 결측 이메일 5건, 중복 주문 id 3건, 허용 밖 상태값 4건, 없는 고객을 가리키는 주문 6건, 음수 금액 2건, 계약에 없는 새 열 1개를 심는다. not_null·unique·accepted_values·relationships·범위·스키마 계약 테스트를 DuckDB SQL 로 실행해 각 테스트가 심은 개수만큼 정확히 잡는지, 신선도(freshness) 경고가 어떻게 나오는지 본다",
  notes: ["06-data-quality-lineage-contracts", "04-transformation-dbt"],
  description: `
dbt 의 테스트는 결국 **"이 조건을 어기는 행을 돌려주는 SELECT"** 다. 0행이면 통과, 1행 이상이면 실패. not_null·unique·accepted_values·relationships 가 기본 4종이고, 범위·신선도·스키마 계약은 패키지(dbt-utils, dbt-expectations)나 직접 작성으로 추가한다.
품질 검사는 파이프라인의 **어디에** 두느냐가 중요하다. 원천 바로 뒤(소스 테스트), 변환 뒤(모델 테스트), 소비자 앞(계약). 이 실험은 오염된 데이터를 일부러 만들고 테스트가 정확히 그 행들을 잡는지 확인한다.
`,
  code: `-- not_null
SELECT * FROM customers WHERE email IS NULL;
-- unique
SELECT id, count(*) FROM orders GROUP BY id HAVING count(*) > 1;
-- accepted_values
SELECT * FROM orders WHERE status NOT IN ('placed','paid','shipped','cancelled');
-- relationships (참조 무결성)
SELECT o.* FROM orders o LEFT JOIN customers c ON o.customer_id = c.id WHERE c.id IS NULL;
-- 범위
SELECT * FROM orders WHERE amount < 0;
-- 스키마 계약: 기대한 열 목록과 실제 비교
SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' EXCEPT SELECT unnest(['id','customer_id','status','amount','created_at']);
-- 신선도
SELECT max(created_at) FROM orders;  -- now() - 24h 보다 오래되면 warn`,
  async run({ rec }) {
    const { q, close } = await duck();
    try {
      await q(`CREATE TABLE customers AS SELECT i AS id, CASE WHEN i IN (17, 230, 451, 702, 988) THEN NULL ELSE 'user' || i || '@example.com' END AS email,
                 ['KR','JP','US'][(i % 3) + 1] AS country FROM range(1, 1001) t(i)`);
      await q(`CREATE TABLE orders AS SELECT i AS id, (hash(i) % 1000)::INT + 1 AS customer_id,
                 ['placed','paid','shipped','cancelled'][(hash(i * 3) % 4)::INT + 1] AS status,
                 ((hash(i * 7) % 50000) / 100.0)::DOUBLE AS amount,
                 TIMESTAMP '2026-10-15 00:00:00' + to_minutes((i % 1440)::INT) AS created_at
               FROM range(1, 10001) t(i)`);
      rec.steps.push({ cmd: "깨끗한 데이터: customers 1,000행, orders 10,000행", result: "ok", ms: 0 });
      await q(`INSERT INTO orders SELECT * FROM orders WHERE id IN (100, 200, 300)`); // 중복 id 3
      await q(`UPDATE orders SET status = 'shiped' WHERE id IN (11, 22)`); // 오타
      await q(`UPDATE orders SET status = 'PAID' WHERE id IN (33, 44)`); // 대소문자
      await q(`UPDATE orders SET customer_id = 5000 + id WHERE id IN (501, 502, 503, 504, 505, 506)`); // 고아 6
      await q(`UPDATE orders SET amount = -amount - 1 WHERE id IN (777, 888)`); // 음수 2
      await q(`ALTER TABLE orders ADD COLUMN discount DOUBLE`); // 계약에 없는 열
      rec.steps.push({ cmd: "오염 심기", result: { "결측 email": 5, "중복 주문 id": 3, "허용 밖 status": 4, "고아 customer_id": 6, "음수 amount": 2, "계약 밖 열": "discount" }, ms: 0 });

      const tests: { name: string; model: string; sql: string; expect: number; severity: "error" | "warn" }[] = [
        { name: "not_null(email)", model: "customers", sql: "SELECT id FROM customers WHERE email IS NULL", expect: 5, severity: "error" },
        { name: "unique(id)", model: "orders", sql: "SELECT id FROM orders GROUP BY id HAVING count(*) > 1", expect: 3, severity: "error" },
        { name: "accepted_values(status)", model: "orders", sql: "SELECT id, status FROM orders WHERE status NOT IN ('placed','paid','shipped','cancelled')", expect: 4, severity: "error" },
        { name: "relationships(customer_id → customers.id)", model: "orders", sql: "SELECT o.id, o.customer_id FROM orders o LEFT JOIN customers c ON o.customer_id = c.id WHERE c.id IS NULL", expect: 6, severity: "error" },
        { name: "range(amount >= 0)", model: "orders", sql: "SELECT id, amount FROM orders WHERE amount < 0", expect: 2, severity: "error" },
        { name: "contract(columns)", model: "orders", sql: "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' EXCEPT SELECT unnest(['id','customer_id','status','amount','created_at'])", expect: 1, severity: "error" },
      ];
      const rows: string[][] = [];
      let allExact = true;
      for (const t of tests) {
        const r = await timeIt(() => q<Record<string, unknown>>(t.sql), 1);
        const n = r.v.length;
        if (n !== t.expect) allExact = false;
        rows.push([t.name, t.model, n === 0 ? "PASS" : `FAIL (${t.severity})`, String(n), JSON.stringify(r.v.slice(0, 3)).slice(0, 90), `${r.ms}ms`]);
      }
      rec.steps.push({ cmd: "테스트 실행 — 실패 행을 돌려주는 SELECT (0행 = 통과)", result: { columns: ["테스트", "모델", "결과", "실패 행", "예시", "시간"], rows }, ms: 0 });
      rec.check("각 테스트가 심은 불량을 정확히 그 개수만큼 잡았다", allExact, rows.map((r) => `${r[0]}=${r[3]}`));

      const now = "2026-10-17 12:00:00";
      const [fresh] = await q<{ latest: string; lag_hours: number }>(`SELECT max(created_at)::VARCHAR latest, date_diff('hour', max(created_at), TIMESTAMP '${now}') lag_hours FROM orders`);
      const level = fresh.lag_hours > 48 ? "error" : fresh.lag_hours > 24 ? "warn" : "pass";
      rec.steps.push({ cmd: `freshness — max(created_at) 이 기준 시각(${now}) 보다 얼마나 늦었나 (warn 24h, error 48h)`, result: { ...fresh, level }, ms: 0 });
      rec.check("신선도: 최신 주문이 24~48시간 전이라 warn (실패는 아니지만 알림)", level === "warn", fresh);

      rec.note("심각도를 나눠라: unique·relationships 위반은 하류 집계를 틀리게 하므로 error 로 파이프라인을 멈추고, 신선도·소수의 이상값은 warn 으로 알리고 진행한다. 실패 행을 별도 테이블에 저장(dbt --store-failures)해 두면 원인 조사가 빨라진다.");
      const quarantine = await q<{ n: number }>(`SELECT count(*) n FROM orders WHERE status NOT IN ('placed','paid','shipped','cancelled') OR amount < 0 OR customer_id NOT IN (SELECT id FROM customers)`);
      rec.steps.push({ cmd: "격리(quarantine): 불량 행을 빼고 정상 행만 하류로 — 격리 대상 행 수", result: quarantine[0], ms: 0 });
    } finally {
      close();
    }
  },
};
