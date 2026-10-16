import fs from "node:fs/promises";
import path from "node:path";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { CodeExperiment } from "./types";

/**
 * ClickHouse 주제 실험. `pnpm clickhouse:up` (HTTP 127.0.0.1:18123, study/study)
 * 모든 실험은 전용 데이터베이스 lab_ch 를 만들고 끝나면 지운다.
 */
const CH_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:18123";
const LOKI = "http://127.0.0.1:13100";
const DB = "lab_ch";

function ch(): ClickHouseClient {
  return createClient({ url: CH_URL, username: "study", password: "study", request_timeout: 120_000, clickhouse_settings: { wait_end_of_query: 1, send_progress_in_http_headers: 1, http_headers_progress_interval_ms: "10000" } });
}

async function requiresClickhouse(): Promise<string | null> {
  try {
    const r = await fetch(`${CH_URL}/?user=study&password=study&query=SELECT%201`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? null : `ClickHouse 응답 ${r.status}. \`pnpm clickhouse:up\` 후 다시.`;
  } catch {
    return "ClickHouse(18123) 가 꺼져 있습니다. `pnpm clickhouse:up` 을 실행하세요 (첫 실행은 이미지 다운로드 1분).";
  }
}

async function rows<T>(c: ClickHouseClient, query: string, query_id?: string): Promise<T[]> {
  const rs = await c.query({ query, format: "JSONEachRow", query_id });
  return (await rs.json()) as T[];
}

type QStat = { query_duration_ms: string; read_rows: string; read_bytes: string; memory_usage: string };

/** 질의를 실행하고 system.query_log 에서 읽은 행·바이트·시간을 가져온다 */
async function profiled<T>(c: ClickHouseClient, label: string, query: string): Promise<{ data: T[]; stat: { ms: number; readRows: number; readMB: number; memMB: number } }> {
  const id = `lab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = await rows<T>(c, query, id);
  await c.command({ query: "SYSTEM FLUSH LOGS" });
  const [s] = await rows<QStat>(c, `SELECT query_duration_ms, read_rows, read_bytes, memory_usage FROM system.query_log WHERE query_id = '${id}' AND type = 'QueryFinish' LIMIT 1`);
  void label;
  return { data, stat: { ms: Number(s?.query_duration_ms ?? 0), readRows: Number(s?.read_rows ?? 0), readMB: Number(s?.read_bytes ?? 0) / 1e6, memMB: Number(s?.memory_usage ?? 0) / 1e6 } };
}

/** DDL·INSERT 실행 후 기록용 요약만 돌려준다 (응답 헤더 전체 대신) */
async function exec(c: ClickHouseClient, query: string, settings?: Record<string, string>): Promise<{ written_rows?: string; read_rows?: string; elapsed_ms?: number }> {
  const r = await c.command({ query, clickhouse_settings: settings });
  const sm = r.summary as { written_rows?: string; read_rows?: string; elapsed_ns?: string } | undefined;
  return { written_rows: sm?.written_rows, read_rows: sm?.read_rows, elapsed_ms: sm?.elapsed_ns ? Math.round(Number(sm.elapsed_ns) / 1e6) : undefined };
}

async function dropDb(c: ClickHouseClient) {
  await c.command({ query: `DROP DATABASE IF EXISTS ${DB} SYNC` }).catch(() => {});
}

// ---------------------------------------------------------------- 1. 로그 분석: ClickHouse vs Loki
type LokiRes = { data: { result: { metric?: Record<string, string>; value?: [number, string] }[]; stats?: { summary?: { execTime?: number; totalBytesProcessed?: number; totalLinesProcessed?: number } } } };

async function lokiInstant(query: string): Promise<{ res: LokiRes | null; wallMs: number }> {
  const t0 = performance.now();
  try {
    const u = new URL(`${LOKI}/loki/api/v1/query`);
    u.searchParams.set("query", query);
    u.searchParams.set("time", String(Date.now() * 1e6));
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    return { res: r.ok ? ((await r.json()) as LokiRes) : null, wallMs: Math.round(performance.now() - t0) };
  } catch {
    return { res: null, wallMs: Math.round(performance.now() - t0) };
  }
}

const LEVELS = ["info", "info", "info", "info", "info", "info", "warn", "warn", "error", "debug"];
const ROUTES = ["/", "/redis", "/kafka/notes/08-cdc-outbox-debezium", "/api/ask", "/api/metrics", "/search", "/redis/lab", "/glossary", "/sre/notes/03-burn-rate-alerting", "/clickhouse"];

export const chLogAnalytics: CodeExperiment = {
  id: "ch-log-analytics",
  subject: "clickhouse",
  title: "로그 분석: 같은 로그를 ClickHouse 와 Loki 에 넣고 레벨별 건수·경로별 순위·p95 를 물어 본다",
  category: "로그 분석",
  summary: "이 앱의 logs/app.jsonl 과 합성 로그 50만 줄을 MergeTree 에 적재해 레벨별 건수·상위 경로·p95 지연을 질의하고 읽은 행·바이트·시간을 system.query_log 로 잰다. 같은 합성 로그 2만 줄을 Loki 에도 밀어 넣고 같은 질문을 LogQL 로 던져 두 저장소의 질의 모델 차이(인덱스 없는 전수 스캔 vs 열 스캔)를 비교한다",
  notes: ["05-log-trace-analytics", "01-olap-columnar", "02-mergetree-engine"],
  description: `
로그는 "쓰기는 많고, 읽기는 가끔이지만 넓게" 다. Loki 는 **레이블만 인덱싱**하고 본문은 압축 청크로 저장한 뒤 질의 때 통째로 풀어 훑는다(싸게 저장, 질의는 무거움). ClickHouse 는 로그를 **열로 쪼개 저장**하고 필요한 열만 읽는다(level·path·duration 집계는 그 열만 스캔).
이 실험은 같은 데이터를 두 저장소에 넣고 같은 질문 세 개를 던진다. 숫자를 비교할 때 주의: Loki 는 2만 줄 표본만 넣었고(밀어 넣기 비용), ClickHouse 는 50만 줄 전체와 같은 2만 줄 표본을 모두 잰다.
`,
  code: `CREATE TABLE lab_ch.logs (
  ts DateTime64(3), level LowCardinality(String), service LowCardinality(String),
  route LowCardinality(String), status UInt16, duration_ms UInt32, trace_id String, msg String
) ENGINE = MergeTree PARTITION BY toDate(ts) ORDER BY (service, level, ts);

-- 50만 줄을 서버 안에서 생성 (전송 없이)
INSERT INTO lab_ch.logs SELECT now64() - rand() % 86400, ['info','warn','error','debug'][...], ... FROM numbers(500000);

SELECT level, count() FROM lab_ch.logs GROUP BY level;                         -- 레벨별
SELECT route, count() c FROM lab_ch.logs GROUP BY route ORDER BY c DESC LIMIT 5; -- 상위 경로
SELECT quantile(0.95)(duration_ms) FROM lab_ch.logs WHERE level != 'debug';   -- p95
SELECT query_duration_ms, read_rows, read_bytes FROM system.query_log WHERE query_id = ...;

# Loki: 같은 질문
sum by (level) (count_over_time({source="ch-lab"}[2h]))
topk(5, sum by (route) (count_over_time({source="ch-lab"} | json [2h])))
quantile_over_time(0.95, {source="ch-lab"} | json | unwrap duration_ms [2h]) by (source)`,
  requires: requiresClickhouse,
  async run({ rec }) {
    const c = ch();
    const run = `r${Date.now().toString(36)}`;
    try {
      await dropDb(c);
      await c.command({ query: `CREATE DATABASE ${DB}` });
      await rec.measure("CREATE TABLE lab_ch.logs — MergeTree, PARTITION BY toDate(ts), ORDER BY (service, level, ts)", () =>
        exec(c,
          `CREATE TABLE ${DB}.logs (
            ts DateTime64(3), source LowCardinality(String), level LowCardinality(String), service LowCardinality(String),
            route LowCardinality(String), status UInt16, duration_ms UInt32, trace_id String, msg String
          ) ENGINE = MergeTree PARTITION BY toDate(ts) ORDER BY (service, level, ts)`,
        ),
      );

      // 1) 이 앱의 실제 로그
      const raw = await fs.readFile(path.join(process.cwd(), "logs/app.jsonl"), "utf8").catch(() => "");
      const real = raw
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            const j = JSON.parse(l) as Record<string, unknown>;
            return [{ ts: String(j.ts ?? new Date().toISOString()).replace("T", " ").replace("Z", ""), source: "app", level: String(j.level ?? "info"), service: String(j.service ?? "study-app"), route: String(j.slug ? `/${j.subject}/notes/${j.slug}` : (j.msg ?? "")), status: 200, duration_ms: Number(j.durationMs ?? j.totalMs ?? 0), trace_id: String(j.trace_id ?? ""), msg: String(j.msg ?? "") }];
          } catch {
            return [];
          }
        });
      if (real.length) await c.insert({ table: `${DB}.logs`, values: real, format: "JSONEachRow" });
      rec.steps.push({ cmd: "INSERT … FORMAT JSONEachRow  ← logs/app.jsonl (이 앱의 구조화 로그)", result: `${real.length}줄`, ms: 0 });

      // 2) 서버 안에서 50만 줄 생성
      await rec.measure("INSERT INTO lab_ch.logs SELECT … FROM numbers(500000)  — 서버 안에서 합성 로그 50만 줄 생성", () =>
        exec(c,
          `INSERT INTO ${DB}.logs SELECT
              now64(3) - toIntervalMillisecond(rand(1) % 86400000) AS ts, 'synthetic',
              ['info','info','info','info','info','info','warn','warn','error','debug'][rand(2) % 10 + 1],
              ['study-app','study-app','study-app','study-worker'][rand(3) % 4 + 1],
              ['/','/redis','/kafka/notes/08-cdc-outbox-debezium','/api/ask','/api/metrics','/search','/redis/lab','/glossary','/sre/notes/03-burn-rate-alerting','/clickhouse'][least(rand(4) % 13, 9) + 1],
              [200,200,200,200,200,200,200,304,404,500][rand(5) % 10 + 1],
              toUInt32(exp(randNormal(3.5, 0.9))),
              lower(hex(randomString(16))),
              concat('request handled route=', toString(number % 997))
            FROM numbers(500000)`,
        ),
      );
      await c.command({ query: `OPTIMIZE TABLE ${DB}.logs FINAL` });
      const [size] = await rows<{ rows: string; parts: string; comp: string; uncomp: string }>(c, `SELECT sum(rows) rows, count() parts, formatReadableSize(sum(data_compressed_bytes)) comp, formatReadableSize(sum(data_uncompressed_bytes)) uncomp FROM system.parts WHERE database='${DB}' AND table='logs' AND active`);
      rec.steps.push({ cmd: "system.parts — 활성 파트·행·압축 전후 크기", result: size, ms: 0 });

      // 3) 같은 2만 줄을 Loki 와 ClickHouse 에 (표본)
      const now = Date.now();
      const sample = Array.from({ length: 20000 }, (_, i) => {
        const level = LEVELS[(i * 7919) % LEVELS.length];
        const route = ROUTES[Math.min((i * 104729) % 13, 9)];
        const duration_ms = Math.round(Math.exp(3.5 + 0.9 * (((i * 2654435761) % 1000) / 1000 - 0.5) * 3.4));
        const ts = now - ((i * 37) % 3_600_000);
        return { ts, level, route, duration_ms, status: level === "error" ? 500 : 200, trace_id: (i * 2654435761).toString(16).padStart(16, "0").slice(-16) };
      });
      await c.insert({ table: `${DB}.logs`, values: sample.map((s) => ({ ...s, ts: new Date(s.ts).toISOString().replace("T", " ").replace("Z", ""), source: run, service: "ch-lab", msg: "sample" })), format: "JSONEachRow" });
      let lokiOk = true;
      await rec.measure(`POST ${LOKI}/loki/api/v1/push — 같은 표본 2만 줄 (레이블 source="ch-lab", run="${run}", level)`, async () => {
        for (let b = 0; b < sample.length; b += 5000) {
          const byLevel = new Map<string, [string, string][]>();
          for (const s of sample.slice(b, b + 5000)) {
            const arr = byLevel.get(s.level) ?? [];
            arr.push([String(s.ts * 1e6), JSON.stringify({ level: s.level, route: s.route, duration_ms: s.duration_ms, status: s.status, trace_id: s.trace_id })]);
            byLevel.set(s.level, arr);
          }
          const body = { streams: [...byLevel.entries()].map(([level, values]) => ({ stream: { source: "ch-lab", run, level }, values: values.sort((a, b2) => (a[0] < b2[0] ? -1 : 1)) })) };
          const r = await fetch(`${LOKI}/loki/api/v1/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }).catch(() => null);
          if (!r || r.status >= 300) lokiOk = false;
        }
        return lokiOk ? "ok" : "Loki 밀어 넣기 실패 (꺼져 있음?) — Loki 비교는 건너뜀";
      });

      // 4) 질문 3개를 ClickHouse 에
      const qs = [
        { name: "레벨별 건수", full: `SELECT level, count() n FROM ${DB}.logs GROUP BY level ORDER BY n DESC`, sample: `SELECT level, count() n FROM ${DB}.logs WHERE source='${run}' GROUP BY level ORDER BY n DESC` },
        { name: "상위 경로 5개", full: `SELECT route, count() n FROM ${DB}.logs GROUP BY route ORDER BY n DESC LIMIT 5`, sample: `SELECT route, count() n FROM ${DB}.logs WHERE source='${run}' GROUP BY route ORDER BY n DESC LIMIT 5` },
        { name: "p95 지연(debug 제외)", full: `SELECT round(quantile(0.95)(duration_ms)) p95 FROM ${DB}.logs WHERE level != 'debug'`, sample: `SELECT round(quantile(0.95)(duration_ms)) p95 FROM ${DB}.logs WHERE source='${run}' AND level != 'debug'` },
      ];
      const lokiQs = [
        `sum by (level) (count_over_time({source="ch-lab", run="${run}"}[2h]))`,
        `topk(5, sum by (route) (count_over_time({source="ch-lab", run="${run}"} | json [2h])))`,
        `quantile_over_time(0.95, {source="ch-lab", run="${run}"} | json | level != "debug" | unwrap duration_ms [2h]) by (run)`,
      ];
      const table: string[][] = [];
      let p95ch = 0;
      let p95loki = 0;
      for (let i = 0; i < qs.length; i++) {
        const full = await profiled<Record<string, unknown>>(c, qs[i].name, qs[i].full);
        const smp = await profiled<Record<string, unknown>>(c, qs[i].name, qs[i].sample);
        rec.steps.push({ cmd: `ClickHouse · ${qs[i].name} (전체)\n${qs[i].full}`, result: full.data, ms: full.stat.ms });
        table.push([qs[i].name, "ClickHouse 전체(52만)", `${full.stat.ms}ms`, full.stat.readRows.toLocaleString(), `${full.stat.readMB.toFixed(2)}MB`]);
        table.push([qs[i].name, "ClickHouse 표본(2만)", `${smp.stat.ms}ms`, smp.stat.readRows.toLocaleString(), `${smp.stat.readMB.toFixed(2)}MB`]);
        if (i === 2) p95ch = Number((smp.data[0] as { p95?: number })?.p95 ?? 0);
        if (lokiOk) {
          await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 0));
          const l = await lokiInstant(lokiQs[i]);
          const sum = l.res?.data.stats?.summary;
          rec.steps.push({ cmd: `Loki · ${qs[i].name} (표본)\n${lokiQs[i]}`, result: l.res?.data.result.map((x) => ({ ...x.metric, v: x.value?.[1] })) ?? "실패", ms: l.wallMs });
          table.push([qs[i].name, "Loki 표본(2만)", `${l.wallMs}ms`, `${sum?.totalLinesProcessed?.toLocaleString() ?? "?"} 줄`, `${((sum?.totalBytesProcessed ?? 0) / 1e6).toFixed(2)}MB`]);
          if (i === 2) p95loki = Number(l.res?.data.result[0]?.value?.[1] ?? 0);
        }
      }
      rec.note("ClickHouse '표본' 질의도 52만 행을 읽은 것에 주목: source 는 정렬 키(service, level, ts)에 없어서 source 열 전체를 훑어 걸렀다. 그래도 읽은 양은 그 열 하나뿐이라 0.5MB 수준이다.");
      rec.steps.push({ cmd: "같은 질문, 두 저장소 — 시간 · 읽은 행(줄) · 읽은 바이트", result: { columns: ["질문", "어디서", "시간", "읽은 행/줄", "읽은 양"], rows: table }, ms: 0 });
      rec.check("ClickHouse 는 필요한 열만 읽는다 — 레벨별 건수(전체)는 52만 행이지만 수 MB 만 읽음", table[0][4] !== "" && Number(table[0][4].replace("MB", "")) < 20, table[0]);
      if (lokiOk && p95loki) {
        rec.check("두 저장소의 표본 p95 가 거의 같다 (quantile 근사 오차 범위)", Math.abs(p95ch - p95loki) / Math.max(p95ch, 1) < 0.15, { clickhouse: p95ch, loki: Math.round(p95loki) });
        rec.note("Loki 는 표본 2만 줄 전체를 풀어 JSON 파싱한 뒤 집계했다(처리 바이트 ≈ 원문 크기). ClickHouse 는 level·route·duration_ms 열만, 그것도 압축된 열 블록을 읽었다. 로그가 수 TB 가 되면 이 차이가 비용 차이가 된다 — 대신 ClickHouse 는 스키마와 적재 파이프라인이 필요하다.");
      } else rec.note("Loki 가 꺼져 있어 ClickHouse 쪽만 측정했다 (pnpm obs:up 후 다시 돌리면 비교표가 완성된다).");
      rec.note(`Loki 에 넣은 표본은 레이블 source="ch-lab", run="${run}" 으로 남는다(보존 기간이 지나면 사라짐). Grafana Explore 에서 같은 질의를 직접 실행해 보자.`);
    } finally {
      await dropDb(c);
      await c.close();
    }
  },
};

// ---------------------------------------------------------------- 2. 정렬 키 · 스킵 인덱스
export const chSortKeySkipIndex: CodeExperiment = {
  id: "ch-sort-key-skip-index",
  subject: "clickhouse",
  title: "정렬 키가 질의를 정한다: 같은 100만 행, 정렬 키만 다른 두 테이블과 bloom_filter 스킵 인덱스",
  category: "MergeTree",
  summary: "이벤트 100만 행을 ORDER BY ts 와 ORDER BY (user_id, ts) 두 테이블에 넣고 user_id 필터·시간 범위 필터 질의의 read_rows·read_bytes·시간을 비교한다. 이어서 정렬 키에 없는 trace_id 로 점 조회할 때 전 그래뉼을 읽던 질의가 bloom_filter 스킵 인덱스 추가 후 몇 그래뉼만 읽는지 EXPLAIN indexes=1 로 확인한다",
  notes: ["03-partition-sortkey-skip-index", "02-mergetree-engine"],
  description: `
MergeTree 의 **기본 키 인덱스는 희소(sparse)** 하다. 8,192행(그래뉼)마다 정렬 키의 첫 값 하나만 메모리에 둔다. 질의 조건이 **정렬 키 앞부분**과 맞으면 이진 탐색으로 읽을 그래뉼만 고르고, 맞지 않으면 전부 읽는다.
그래서 ClickHouse 설계의 절반은 "어떤 조건으로 가장 자주 거르나" 에 맞춰 **ORDER BY 를 고르는 일** 이다. 정렬 키에 넣을 수 없는 고카디널리티 열(trace_id)은 **스킵 인덱스**(그래뉼 묶음마다 bloom filter·min/max 를 저장)로 "이 묶음엔 없다" 를 빨리 판정한다.
`,
  code: `CREATE TABLE ev_by_ts   (...) ENGINE = MergeTree ORDER BY ts;
CREATE TABLE ev_by_user (...) ENGINE = MergeTree ORDER BY (user_id, ts);
SELECT count() FROM ev_by_ts   WHERE user_id = 4242;   -- 100만 행 전부 읽음
SELECT count() FROM ev_by_user WHERE user_id = 4242;   -- 그래뉼 1~2개
EXPLAIN indexes = 1 SELECT ... ;                        -- PrimaryKey: Granules 2/123
ALTER TABLE ev_by_ts ADD INDEX idx_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE ev_by_ts MATERIALIZE INDEX idx_trace SETTINGS mutations_sync = 2;
SELECT * FROM ev_by_ts WHERE trace_id = '...';          -- Skip: idx_trace Granules 1/123`,
  requires: requiresClickhouse,
  async run({ rec }) {
    const c = ch();
    try {
      await dropDb(c);
      await c.command({ query: `CREATE DATABASE ${DB}` });
      const cols = "ts DateTime, user_id UInt32, event LowCardinality(String), amount UInt32, trace_id String";
      await c.command({ query: `CREATE TABLE ${DB}.ev_by_ts (${cols}) ENGINE = MergeTree ORDER BY ts` });
      await c.command({ query: `CREATE TABLE ${DB}.ev_by_user (${cols}) ENGINE = MergeTree ORDER BY (user_id, ts)` });
      const gen = `SELECT toDateTime('2026-10-01 00:00:00') + intDiv(number, 2) AS ts, rand(1) % 50000 AS user_id,
                     ['view','view','view','click','click','buy'][rand(2) % 6 + 1], rand(3) % 100000, lower(hex(MD5(toString(number))))
                   FROM numbers(1000000)`;
      await rec.measure("같은 100만 행을 두 테이블에 — ORDER BY ts / ORDER BY (user_id, ts)", async () => {
        await c.command({ query: `INSERT INTO ${DB}.ev_by_ts ${gen}` });
        await c.command({ query: `INSERT INTO ${DB}.ev_by_user ${gen}` });
        await c.command({ query: `OPTIMIZE TABLE ${DB}.ev_by_ts FINAL` });
        await c.command({ query: `OPTIMIZE TABLE ${DB}.ev_by_user FINAL` });
      });
      const [g] = await rows<{ marks: string }>(c, `SELECT sum(marks) marks FROM system.parts WHERE database='${DB}' AND table='ev_by_ts' AND active`);
      rec.steps.push({ cmd: "system.parts.marks — 그래뉼(8,192행) 수", result: `${g.marks}개`, ms: 0 });
      const [probe] = await rows<{ user_id: number; trace_id: string }>(c, `SELECT user_id, trace_id FROM ${DB}.ev_by_ts ORDER BY ts DESC LIMIT 1`);
      const uid = probe.user_id;
      const tid = probe.trace_id;

      const cases = [
        { name: `user_id = ${uid}`, where: `user_id = ${uid}` },
        { name: "시간 범위 1시간", where: "ts BETWEEN '2026-10-02 00:00:00' AND '2026-10-02 01:00:00'" },
        { name: `user_id = ${uid} AND 1일`, where: `user_id = ${uid} AND ts BETWEEN '2026-10-02 00:00:00' AND '2026-10-03 00:00:00'` },
      ];
      const table: string[][] = [];
      const read: Record<string, number> = {};
      for (const k of cases) {
        for (const t of ["ev_by_ts", "ev_by_user"]) {
          const p = await profiled<{ n: string }>(c, k.name, `SELECT count() n FROM ${DB}.${t} WHERE ${k.where}`);
          read[`${t}|${k.name}`] = p.stat.readRows;
          table.push([k.name, t === "ev_by_ts" ? "ORDER BY ts" : "ORDER BY (user_id, ts)", p.data[0]?.n ?? "?", p.stat.readRows.toLocaleString(), `${p.stat.readMB.toFixed(2)}MB`, `${p.stat.ms}ms`]);
        }
      }
      rec.steps.push({ cmd: "같은 조건, 정렬 키만 다른 두 테이블", result: { columns: ["조건", "정렬 키", "결과", "읽은 행", "읽은 양", "시간"], rows: table }, ms: 0 });
      rec.check(`user_id 조건: (user_id, ts) 정렬은 ts 정렬보다 훨씬 적게 읽는다`, read[`ev_by_user|user_id = ${uid}`] * 20 < read[`ev_by_ts|user_id = ${uid}`], { byTs: read[`ev_by_ts|user_id = ${uid}`], byUser: read[`ev_by_user|user_id = ${uid}`] });
      rec.check("시간 범위 조건: 반대로 ts 정렬이 적게 읽는다 (정렬 키 첫 열이 아닌 조건은 거의 전수 스캔)", read["ev_by_ts|시간 범위 1시간"] * 20 < read["ev_by_user|시간 범위 1시간"], { byTs: read["ev_by_ts|시간 범위 1시간"], byUser: read["ev_by_user|시간 범위 1시간"] });

      const explain = async (q: string) => (await rows<{ explain: string }>(c, `EXPLAIN indexes = 1 ${q}`)).map((r) => r.explain).filter((l) => /PrimaryKey|Skip|Name|Granules|Parts/.test(l)).map((l) => l.trim());
      rec.note(`정렬 키에 없는 고카디널리티 열 trace_id 로 점 조회 — 스킵 인덱스 전후`);
      const before = await profiled<{ n: string }>(c, "trace before", `SELECT count() n FROM ${DB}.ev_by_ts WHERE trace_id = '${tid}'`);
      rec.steps.push({ cmd: `EXPLAIN indexes=1 … WHERE trace_id = '${tid.slice(0, 8)}…'  (인덱스 없음)`, result: await explain(`SELECT count() FROM ${DB}.ev_by_ts WHERE trace_id = '${tid}'`), ms: 0 });
      await rec.measure("ALTER TABLE ev_by_ts ADD INDEX idx_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 1; MATERIALIZE INDEX (mutations_sync=2)", async () => {
        await exec(c, `ALTER TABLE ${DB}.ev_by_ts ADD INDEX idx_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 1`);
        await exec(c, `ALTER TABLE ${DB}.ev_by_ts MATERIALIZE INDEX idx_trace`, { mutations_sync: "2" });
        return "인덱스 생성 + 기존 파트에 구축 완료";
      });
      const after = await profiled<{ n: string }>(c, "trace after", `SELECT count() n FROM ${DB}.ev_by_ts WHERE trace_id = '${tid}'`);
      rec.steps.push({ cmd: `EXPLAIN indexes=1 … WHERE trace_id = …  (bloom_filter 후)`, result: await explain(`SELECT count() FROM ${DB}.ev_by_ts WHERE trace_id = '${tid}'`), ms: 0 });
      const [idxSize] = await rows<{ size: string }>(c, `SELECT formatReadableSize(sum(secondary_indices_compressed_bytes)) size FROM system.parts WHERE database='${DB}' AND table='ev_by_ts' AND active`);
      rec.steps.push({ cmd: "trace_id 점 조회 — 스킵 인덱스 전후", result: { columns: ["", "읽은 행", "읽은 양", "시간"], rows: [["인덱스 없음", before.stat.readRows.toLocaleString(), `${before.stat.readMB.toFixed(2)}MB`, `${before.stat.ms}ms`], ["bloom_filter", after.stat.readRows.toLocaleString(), `${after.stat.readMB.toFixed(2)}MB`, `${after.stat.ms}ms`], ["인덱스 크기", idxSize.size, "", ""]] }, ms: 0 });
      rec.check("bloom_filter 가 그래뉼 대부분을 건너뛴다 (읽은 행 1/20 이하)", after.stat.readRows * 20 <= before.stat.readRows && Number(after.data[0]?.n) === 1, { before: before.stat.readRows, after: after.stat.readRows });
      rec.note("스킵 인덱스는 '없다' 만 확실히 말한다. 값이 흔한 열(event 같은)에 bloom_filter 를 걸면 거의 모든 그래뉼에 값이 있어 아무것도 못 건너뛰고 쓰기 비용만 늘어난다 — 카디널리티가 높고 드물게 찾는 열에만.");
    } finally {
      await dropDb(c);
      await c.close();
    }
  },
};

// ---------------------------------------------------------------- 3. 코덱 · 압축 · LowCardinality
export const chCodecsCompression: CodeExperiment = {
  id: "ch-codecs-compression",
  subject: "clickhouse",
  title: "열마다 다른 압축: 타임스탬프·카운터·게이지·문자열에 코덱을 바꿔 가며 압축률을 잰다",
  category: "저장",
  summary: "같은 100만 행을 열 하나씩 코덱만 다르게(LZ4, ZSTD, Delta, DoubleDelta, Gorilla, T64, LowCardinality) 저장하고 system.columns 의 압축 전·후 바이트로 압축률 표를 만든다. 정렬된 시계열에서 DoubleDelta 가, 반복 많은 문자열에서 LowCardinality 가 왜 압도적인지 숫자로 본다",
  notes: ["06-compression-codecs", "01-olap-columnar"],
  description: `
열 저장의 진짜 무기는 **같은 종류의 값이 붙어 있다** 는 것이다. 1초 간격으로 증가하는 타임스탬프는 차이(Delta)를 저장하면 거의 상수, 차이의 차이(DoubleDelta)는 거의 0 이 되어 몇 비트로 줄어든다. 천천히 변하는 실수(게이지)는 XOR 기반 **Gorilla** 가, 몇 종류뿐인 문자열은 **LowCardinality**(사전 + 정수 코드)가 잘 줄인다.
코덱은 **변환 코덱(Delta·DoubleDelta·Gorilla·T64) + 범용 압축(LZ4·ZSTD)** 을 이어 붙여 쓴다. 이 실험은 같은 데이터를 코덱만 바꿔 저장해 압축률을 직접 비교한다.
`,
  code: `CREATE TABLE codecs (
  ts_lz4   DateTime CODEC(LZ4),
  ts_dd    DateTime CODEC(DoubleDelta, LZ4),
  cnt_delta UInt64  CODEC(Delta, ZSTD(1)),
  gauge_gorilla Float64 CODEC(Gorilla, LZ4),
  level_str String CODEC(LZ4),
  level_lc  LowCardinality(String),
  ...
) ENGINE = MergeTree ORDER BY ts_lz4;
SELECT name, type, compression_codec, data_uncompressed_bytes, data_compressed_bytes
FROM system.columns WHERE database='lab_ch' AND table='codecs';`,
  requires: requiresClickhouse,
  async run({ rec }) {
    const c = ch();
    try {
      await dropDb(c);
      await c.command({ query: `CREATE DATABASE ${DB}` });
      const defs: [string, string, string][] = [
        // [이름, 타입+코덱, 생성식]
        ["ts_lz4", "DateTime CODEC(LZ4)", "toDateTime('2026-10-01 00:00:00') + number"],
        ["ts_zstd", "DateTime CODEC(ZSTD(3))", "toDateTime('2026-10-01 00:00:00') + number"],
        ["ts_delta", "DateTime CODEC(Delta, ZSTD(1))", "toDateTime('2026-10-01 00:00:00') + number"],
        ["ts_doubledelta", "DateTime CODEC(DoubleDelta, LZ4)", "toDateTime('2026-10-01 00:00:00') + number"],
        ["counter_lz4", "UInt64 CODEC(LZ4)", "number * 37 + rand(1) % 5"],
        ["counter_delta", "UInt64 CODEC(Delta, ZSTD(1))", "number * 37 + rand(1) % 5"],
        ["counter_t64", "UInt64 CODEC(T64, LZ4)", "number * 37 + rand(1) % 5"],
        ["gauge_lz4", "Float64 CODEC(LZ4)", "round(50 + 10 * sin(intDiv(number, 15) / 40), 1)"],
        ["gauge_gorilla", "Float64 CODEC(Gorilla, LZ4)", "round(50 + 10 * sin(intDiv(number, 15) / 40), 1)"],
        ["gauge_noisy_gorilla", "Float64 CODEC(Gorilla, LZ4)", "50 + 10 * sin(number / 600) + (rand(2) % 100) / 1000"],
        ["level_str", "String CODEC(LZ4)", "['info','info','info','info','warn','error','debug'][rand(3) % 7 + 1]"],
        ["level_lc", "LowCardinality(String)", "['info','info','info','info','warn','error','debug'][rand(3) % 7 + 1]"],
        ["path_str", "String CODEC(ZSTD(3))", "concat('/api/v1/', ['users','orders','items','search'][rand(4) % 4 + 1], '/', toString(rand(5) % 1000))"],
        ["uuid_str", "String CODEC(ZSTD(3))", "toString(generateUUIDv4())"],
      ];
      await exec(c, `CREATE TABLE ${DB}.codecs (${defs.map(([n, t]) => `${n} ${t}`).join(", ")}) ENGINE = MergeTree ORDER BY ts_lz4`);
      await rec.measure("INSERT 100만 행 (같은 값을 코덱만 다른 열들에) + OPTIMIZE FINAL", async () => {
        await c.command({ query: `INSERT INTO ${DB}.codecs SELECT ${defs.map(([, , e]) => e).join(", ")} FROM numbers(1000000)` });
        await c.command({ query: `OPTIMIZE TABLE ${DB}.codecs FINAL` });
      });
      const cols = await rows<{ name: string; type: string; codec: string; raw: string; comp: string }>(
        c,
        `SELECT name, type, compression_codec codec, data_uncompressed_bytes raw, data_compressed_bytes comp FROM system.columns WHERE database='${DB}' AND table='codecs' ORDER BY position`,
      );
      const ratio: Record<string, number> = {};
      const comp: Record<string, number> = {};
      const table = cols.map((x) => {
        const r = Number(x.raw) / Math.max(Number(x.comp), 1);
        ratio[x.name] = r;
        comp[x.name] = Number(x.comp);
        return [x.name, x.type.replace(/^LowCardinality/, "LowCardinality"), x.codec || "(기본 LZ4)", `${(Number(x.raw) / 1e6).toFixed(2)}MB`, `${(Number(x.comp) / 1e6).toFixed(3)}MB`, `${r.toFixed(1)}×`];
      });
      rec.steps.push({ cmd: "system.columns — 열별 압축 전 · 후 · 배율 (100만 행)", result: { columns: ["열", "타입", "코덱", "압축 전", "압축 후", "배율"], rows: table }, ms: 0 });
      rec.check("1초 간격 타임스탬프: DoubleDelta 가 LZ4 단독보다 10배 이상 더 줄인다", ratio.ts_doubledelta > ratio.ts_lz4 * 10, { lz4: ratio.ts_lz4.toFixed(1), doubleDelta: ratio.ts_doubledelta.toFixed(1) });
      rec.check("증가하는 카운터: Delta 가 LZ4 단독보다 잘 줄인다", ratio.counter_delta > ratio.counter_lz4, { lz4: ratio.counter_lz4.toFixed(1), delta: ratio.counter_delta.toFixed(1) });
      rec.check("15초마다 바뀌는 게이지: Gorilla 가 LZ4 단독보다 잘 줄인다 (같은 값의 XOR = 0)", ratio.gauge_gorilla > ratio.gauge_lz4, { lz4: ratio.gauge_lz4.toFixed(1), gorilla: ratio.gauge_gorilla.toFixed(1), noisyGorilla: ratio.gauge_noisy_gorilla.toFixed(1) });
      rec.check("반복 많은 문자열: LowCardinality 가 String+LZ4 보다 디스크를 덜 쓴다 (압축 후 바이트)", comp.level_lc < comp.level_str, { strMB: (comp.level_str / 1e6).toFixed(3), lcMB: (comp.level_lc / 1e6).toFixed(3) });
      rec.note("LowCardinality 는 '압축 전' 크기부터 다르다(문자열 대신 1바이트 사전 코드). 그래서 배율보다 압축 후 바이트로 비교해야 한다. 노이즈가 섞인 실수는 Gorilla 로도 잘 안 줄어든다 — 센서 값을 필요한 정밀도로 반올림하는 것이 코덱 선택보다 효과가 크다.");
      rec.note(`무작위 UUID 는 어떤 코덱으로도 거의 안 줄어든다(${ratio.uuid_str.toFixed(1)}×) — 엔트로피가 이미 최대. 로그의 trace_id 열이 저장 용량을 지배하는 이유다. 반대로 정렬 키 덕분에 붙어 있는 시간·레벨 열은 거의 공짜.`);
      const scan = await profiled<{ n: string }>(c, "lc vs str", `SELECT count() n FROM ${DB}.codecs WHERE level_lc = 'error'`);
      const scan2 = await profiled<{ n: string }>(c, "lc vs str", `SELECT count() n FROM ${DB}.codecs WHERE level_str = 'error'`);
      rec.steps.push({ cmd: "WHERE level = 'error' — LowCardinality vs String (읽은 바이트·시간)", result: { columns: ["열", "읽은 양", "시간"], rows: [["level_lc", `${scan.stat.readMB.toFixed(2)}MB`, `${scan.stat.ms}ms`], ["level_str", `${scan2.stat.readMB.toFixed(2)}MB`, `${scan2.stat.ms}ms`]] }, ms: 0 });
      rec.check("LowCardinality 는 필터할 때도 덜 읽는다 (사전 코드만 비교)", scan.stat.readMB < scan2.stat.readMB, { lc: scan.stat.readMB, str: scan2.stat.readMB });
    } finally {
      await dropDb(c);
      await c.close();
    }
  },
};
