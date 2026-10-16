import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureConnected, getRedis } from "@/lib/redis";
import { pgClient, requiresPg } from "./postgres";
import type { CodeExperiment } from "./types";

function quantile(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// ---------------------------------------------------------------- 1. B-tree 페이지를 직접 읽는다
export const dbiBtreePageinspect: CodeExperiment = {
  id: "dbi-btree-pageinspect",
  subject: "db-internals",
  title: "B-tree 를 페이지 단위로 열어 본다: 메타·루트·리프, 채움률, fillfactor, 그리고 무작위 키가 만드는 분할",
  category: "B-tree",
  summary: "pageinspect 로 PostgreSQL B-tree 의 메타 페이지(루트·레벨)·루트 아이템(하향 포인터)·리프 아이템(키 → ctid)을 읽고, 같은 2만 행을 순차 키 / 무작위 키 / fillfactor 50 으로 색인했을 때 리프 페이지 수와 평균 채움률이 어떻게 달라지는지 표로 비교한다",
  notes: ["02-btree-pages-buffer-pool", "05-index-structures"],
  description: `
인덱스는 추상 자료구조가 아니라 **8KB 페이지의 배열**이다. 메타 페이지(0번)가 루트의 위치와 트리 높이를 알려 주고, 내부 페이지는 "이 키 이상은 저쪽 자식" 인 하향 포인터를, 리프 페이지는 **키 → 힙 튜플 주소(ctid)** 를 담는다.
키를 **오름차순**으로 넣으면 항상 맨 오른쪽 리프에만 추가돼 페이지가 꽉 차고(PG 는 맨 오른쪽 분할을 특별 취급), **무작위**로 넣으면 중간 분할이 일어나 리프가 절반쯤 빈 채로 남는다. \`fillfactor\` 는 처음부터 여유를 남겨 두는 설정이다 — UPDATE 가 많은 테이블에서 분할을 줄인다.
\`pageinspect\` 확장은 이것을 전부 SQL 로 보여 준다.
`,
  code: `CREATE EXTENSION pageinspect;
SELECT * FROM bt_metap('lab_seq_idx');                  -- root 블록, level(높이-1)
SELECT type, live_items, avg_item_size, free_size FROM bt_page_stats('lab_seq_idx', 1);
SELECT itemoffset, ctid, itemlen, data FROM bt_page_items('lab_seq_idx', 1) LIMIT 5;   -- 리프: 키(data) → 힙 ctid
-- 리프 전체 채움률
SELECT avg(100.0 * (8192 - free_size) / 8192) FROM generate_series(1, relpages-1) b, bt_page_stats('lab_seq_idx', b) WHERE type = 'l';
CREATE INDEX lab_rand_idx ON lab_rand (k);              -- 무작위 키: 분할로 ~70% 채움
CREATE INDEX lab_ff50_idx ON lab_seq (k) WITH (fillfactor = 50);`,
  requires: requiresPg,
  async run({ rec, k }) {
    const c = pgClient();
    await c.connect();
    const seq = k("seq"), rand = k("rand");
    try {
      await c.query("create extension if not exists pageinspect");
      await c.query(`drop table if exists ${seq}, ${rand}`);
      rec.note("인덱스를 먼저 만들고 행을 넣는다. (이미 있는 데이터에 CREATE INDEX 를 하면 정렬해서 빽빽하게 '빌드' 하므로 삽입 순서의 효과가 사라진다)");
      await rec.measure("빈 테이블 + 인덱스 3개 생성 후 20,000행 삽입: 순차 키 / 무작위 키", async () => {
        await c.query(`create table ${seq} (k int, pad text)`);
        await c.query(`create index ${seq}_idx on ${seq} (k)`);
        await c.query(`create index ${seq}_ff50 on ${seq} (k) with (fillfactor = 50)`);
        await c.query(`create table ${rand} (k int, pad text)`);
        await c.query(`create index ${rand}_idx on ${rand} (k)`);
        await c.query(`insert into ${seq} select g, repeat('x', 20) from generate_series(1, 20000) g`);
        await c.query(`insert into ${rand} select g, repeat('x', 20) from generate_series(1, 20000) g order by random()`);
        return "40,000 rows";
      });

      const meta = (await c.query(`select magic, version, root, level, fastroot, fastlevel from bt_metap('${seq}_idx')`)).rows[0];
      rec.steps.push({ cmd: `SELECT * FROM bt_metap('${seq}_idx')`, result: meta, ms: 0 });
      rec.check("메타 페이지가 루트 블록 번호와 레벨(트리 높이 - 1)을 알려 준다 — 2만 행은 높이 2 (루트 + 리프)", Number(meta.level) === 1, meta);
      const root = (await c.query(`select type, live_items, avg_item_size, free_size, btpo_prev, btpo_next from bt_page_stats('${seq}_idx', ${meta.root})`)).rows[0];
      rec.steps.push({ cmd: `bt_page_stats('${seq}_idx', ${meta.root})   -- 루트 페이지`, result: root, ms: 0 });
      rec.check("루트는 type 'r', 아이템 수 = 자식(리프) 페이지 수", root.type === "r" && Number(root.live_items) > 10, root);
      const rootItems = (await c.query(`select itemoffset, ctid, data from bt_page_items('${seq}_idx', ${meta.root}) limit 4`)).rows;
      rec.steps.push({ cmd: `bt_page_items('${seq}_idx', ${meta.root}) LIMIT 4   -- 하향 포인터: ctid 의 블록 = 자식 페이지, data = 그 자식의 최소 키`, result: rootItems, ms: 0 });
      const leafItems = (await c.query(`select itemoffset, ctid, itemlen, data from bt_page_items('${seq}_idx', 1) limit 4`)).rows;
      rec.steps.push({ cmd: `bt_page_items('${seq}_idx', 1) LIMIT 4   -- 리프: data = 키(little-endian int), ctid = 힙 (페이지, 오프셋)`, result: leafItems, ms: 0 });
      rec.note("리프의 첫 아이템은 'high key'(이 페이지의 상한) 이고 두 번째부터 실제 키다. ctid (0,1) 은 힙 0번 페이지 1번 튜플 — Index Scan 은 이 주소로 힙을 찾아간다.");

      const stat = async (idx: string) => {
        const r = (await c.query(`
          with p as (select (pg_relation_size($1::text::regclass) / 8192)::int as relpages)
          select count(*)::int as leaf_pages,
                 round(avg(100.0 * (8192 - s.free_size) / 8192), 1)::float as fill_pct,
                 round(avg(s.live_items))::int as items_per_leaf,
                 (select level from bt_metap($1::text)) as level,
                 pg_size_pretty(pg_relation_size($1::text::regclass)) as size
          from p, generate_series(1, p.relpages - 1) b, lateral bt_page_stats($1::text, b) s
          where s.type = 'l'`, [idx])).rows[0];
        return r as { leaf_pages: number; fill_pct: number; items_per_leaf: number; level: number; size: string };
      };
      const rows = {
        "순차 키 (fillfactor 90 기본)": await stat(`${seq}_idx`),
        "무작위 키 (분할 발생)": await stat(`${rand}_idx`),
        "순차 키 + fillfactor 50": await stat(`${seq}_ff50`),
      };
      rec.steps.push({ cmd: "리프 페이지 수 · 평균 채움률 · 리프당 아이템 · 크기 (같은 20,000 키)", result: rows, ms: 0 });
      const a = rows["순차 키 (fillfactor 90 기본)"], b = rows["무작위 키 (분할 발생)"], f = rows["순차 키 + fillfactor 50"];
      rec.check("순차 삽입은 리프가 ~90% 차 있다 (맨 오른쪽 리프 분할은 fillfactor 만큼 채우고 넘긴다)", a.fill_pct >= 80, a.fill_pct);
      rec.check("무작위 삽입은 중간 분할(50:50) 때문에 채움률이 낮고(~70%) 리프 페이지가 더 많다", b.fill_pct < a.fill_pct - 5 && b.leaf_pages > a.leaf_pages, { seq: a, rand: b });
      rec.check("fillfactor 50 은 순차 삽입에서도 페이지를 약 2배 쓴다 — 대신 나중 UPDATE 가 분할 없이 들어간다", f.leaf_pages >= a.leaf_pages * 1.6, { ff50: f.leaf_pages, base: a.leaf_pages });
      rec.note("같은 데이터에 CREATE INDEX 를 '나중에' 하면? 정렬 빌드라 셋 다 같은 모양이 된다 — 그래서 대량 적재는 인덱스를 지우고 넣은 뒤 다시 만드는 것이 빠르고 조밀하다.");

      rec.note("무작위 키 인덱스에 행을 더 넣으면 분할이 계속 일어난다. 2,000행 추가 후 페이지 수 변화:");
      await c.query(`insert into ${rand} select g, 'y' from generate_series(20001, 22000) g order by random()`);
      const after = await stat(`${rand}_idx`);
      rec.steps.push({ cmd: `INSERT 2,000행(무작위) → bt_page_stats 재집계`, result: { before: b.leaf_pages, after: after.leaf_pages, fill_pct: after.fill_pct }, ms: 0 });
      rec.note(`UUID v4 같은 무작위 PK 가 큰 테이블에서 느린 이유가 이것이다: 모든 리프가 분할 후보라 쓰기 증폭·캐시 미스·WAL 이 는다. 시간순 키(ULID, UUID v7, bigserial)는 맨 오른쪽 페이지만 건드린다 ([PostgreSQL 인덱스](/postgres/notes/02-indexes-explain)).`);
    } finally {
      await c.query(`drop table if exists ${seq}, ${rand}`).catch(() => {});
      await c.end();
    }
  },
};

// ---------------------------------------------------------------- 2. 저널 모드와 쓰기 증폭 (node:sqlite)
export const dbiWriteAmplification: CodeExperiment = {
  id: "dbi-write-amplification",
  subject: "db-internals",
  title: "쓰기 증폭과 fsync: 롤백 저널 vs WAL, synchronous FULL vs NORMAL 이 커밋 지연과 디스크 쓰기량을 어떻게 바꾸나",
  category: "WAL",
  summary: "Node 22 내장 SQLite 로 같은 2,000건의 단일 행 커밋을 journal_mode=DELETE/WAL × synchronous=FULL/NORMAL 네 조합으로 돌려 커밋당 지연(p50/p99)과 파일 크기 변화(논리 바이트 대비 실제 쓰기 = 쓰기 증폭)를 재고, 트랜잭션으로 묶었을 때 얼마나 달라지는지 본다",
  notes: ["01-disk-memory-hierarchy", "04-wal-checkpoint-recovery"],
  description: `
"한 행을 INSERT 했는데 디스크에는 몇 바이트가 써질까?" 이 비율이 **쓰기 증폭**이다. 저장 엔진은 원자성·내구성을 위해 데이터 외에 로그(저널·WAL)를 쓰고, 페이지 단위로 쓰며, 체크포인트에 다시 쓴다.
**롤백 저널**(SQLite 기본)은 변경 전 페이지를 저널에 복사한 뒤 데이터 파일을 제자리에서 고친다 — 커밋마다 저널 fsync + 데이터 fsync. **WAL** 은 변경을 로그 끝에 순차 추가만 하고 데이터 파일은 나중에 체크포인트로 — 커밋마다 fsync 한 번, 순차 I/O.
\`synchronous=NORMAL\` 은 WAL 에서 커밋마다 fsync 를 생략하고 체크포인트 때만 한다(전원 장애 시 마지막 트랜잭션 몇 개 유실 가능, 손상은 없음). PostgreSQL 의 \`synchronous_commit=off\`, Redis 의 \`appendfsync everysec\` 와 같은 트레이드오프다.
`,
  code: `PRAGMA journal_mode = WAL;        -- vs DELETE(롤백 저널)
PRAGMA synchronous = NORMAL;      -- vs FULL (커밋마다 fsync)
-- 2,000 × (BEGIN; INSERT 1행; COMMIT)  → 커밋당 지연, 파일 크기 증가량 / 논리 바이트
-- 1 × (BEGIN; INSERT 2,000행; COMMIT)  → 배치 커밋
PRAGMA wal_checkpoint(TRUNCATE);`,
  async run({ rec }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbi-sqlite-"));
    const N = 2000;
    const row = "x".repeat(100);
    const logicalBytes = N * (100 + 8);
    const sizeOf = async (f: string) => (await fs.stat(f).catch(() => ({ size: 0 }))).size;
    rec.note("쓰기량 측정법: 롤백 저널은 journal_mode=PERSIST(DELETE 와 같지만 파일을 지우지 않음)로 '커밋 1회의 저널 크기' 를 읽고, WAL 은 wal_autocheckpoint=0 으로 체크포인트를 막아 WAL 파일 전체 크기를 읽는다. 데이터 파일 증가분을 더한다.");
    const results: Record<string, { p50_ms: number; p99_ms: number; total_ms: number; bytes_per_commit: number; amplification: string }> = {};
    for (const journal of ["PERSIST", "WAL"]) {
      for (const sync of ["FULL", "NORMAL"]) {
        const file = path.join(dir, `${journal}-${sync}.db`);
        const db = new DatabaseSync(file);
        db.exec(`PRAGMA journal_mode = ${journal}; PRAGMA synchronous = ${sync}; PRAGMA wal_autocheckpoint = 0; create table t (id integer primary key, v text)`);
        const ins = db.prepare("insert into t (v) values (?)");
        const dbBefore = await sizeOf(file);
        const lat: number[] = [];
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          const s = performance.now();
          db.exec("BEGIN");
          ins.run(row);
          db.exec("COMMIT");
          lat.push(performance.now() - s);
        }
        const total = performance.now() - t0;
        const journalBytes = journal === "PERSIST" ? (await sizeOf(file + "-journal")) * N : await sizeOf(file + "-wal");
        const dataBytes = journal === "PERSIST" ? (await sizeOf(file)) - dbBefore : 0; // WAL 모드는 체크포인트 전이라 데이터 파일에 아직 안 썼다
        const written = journalBytes + dataBytes;
        if (journal === "WAL") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
        results[`${journal === "PERSIST" ? "롤백 저널" : "WAL"} / ${sync}`] = { p50_ms: Number(quantile(lat, 0.5).toFixed(3)), p99_ms: Number(quantile(lat, 0.99).toFixed(3)), total_ms: Math.round(total), bytes_per_commit: Math.round(written / N), amplification: `${(written / logicalBytes).toFixed(0)}×` };
      }
    }
    rec.steps.push({ cmd: `${N} × 단일 행 커밋 (행당 논리 108B) — journal_mode × synchronous`, result: results, ms: 0 });
    const dFull = results["롤백 저널 / FULL"], wFull = results["WAL / FULL"], wNormal = results["WAL / NORMAL"];
    rec.check("WAL(FULL) 이 롤백 저널(FULL) 보다 커밋이 빠르다 — fsync 1회 + 순차 추가", wFull.total_ms < dFull.total_ms, { journal: dFull.total_ms, wal: wFull.total_ms });
    rec.check("synchronous=NORMAL 은 커밋마다 fsync 를 생략해 더 빠르다 (내구성 ↔ 지연 트레이드오프)", wNormal.total_ms <= wFull.total_ms, { full: wFull.total_ms, normal: wNormal.total_ms });
    rec.check("108 바이트 행 하나를 커밋하는 데 수 KB 가 써진다 — 페이지 단위 + 로그 (쓰기 증폭 수십 배)", dFull.bytes_per_commit > 4096 && wFull.bytes_per_commit >= 4096, { journal: dFull.bytes_per_commit, wal: wFull.bytes_per_commit });
    rec.note(`롤백 저널은 커밋마다 '원본 페이지 복사(저널) + 데이터 페이지 덮어쓰기' 두 곳에 쓰고 fsync 도 두 번, WAL 은 프레임(페이지 4096B + 헤더 24B)을 로그 끝에 한 번만 쓴다. macOS 의 fsync 는 디스크 캐시까지 비우지 않을 수 있어 절대값은 Linux 서버보다 낙관적이다.`);

    rec.note("같은 2,000행을 한 트랜잭션으로 — 그룹 커밋/배치가 왜 빠른지");
    const file = path.join(dir, "batch.db");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; create table t (id integer primary key, v text)");
    const ins = db.prepare("insert into t (v) values (?)");
    const t0 = performance.now();
    db.exec("BEGIN");
    for (let i = 0; i < N; i++) ins.run(row);
    db.exec("COMMIT");
    const batchMs = Math.round(performance.now() - t0);
    const walSize = await sizeOf(file + "-wal");
    db.close();
    rec.steps.push({ cmd: `1 × BEGIN; INSERT ${N}행; COMMIT (WAL/FULL)`, result: { total_ms: batchMs, wal_bytes: walSize, amplification: `${(walSize / logicalBytes).toFixed(1)}×` }, ms: batchMs });
    rec.check("배치 커밋은 단일 행 커밋 2,000번보다 수십 배 빠르다 (fsync 1번, 페이지 공유)", batchMs * 10 < wFull.total_ms, { batch: batchMs, single: wFull.total_ms });
    rec.note("DB 가 내부적으로 하는 '그룹 커밋' 도 같은 원리다: 동시에 들어온 커밋들의 fsync 를 한 번으로 합친다 ([PostgreSQL 운영](/postgres/notes/05-operations), [Kafka 내부](/kafka/notes/05-internals-storage-replication)의 배치와 같은 이야기).");
    await fs.rm(dir, { recursive: true, force: true });
  },
};

// ---------------------------------------------------------------- 3. PG WAL vs Redis AOF 의 내구성 설정
export const dbiWalVsAof: CodeExperiment = {
  id: "dbi-wal-vs-aof",
  subject: "db-internals",
  title: "같은 쓰기 워크로드를 PostgreSQL(synchronous_commit on/off)과 Redis(appendfsync always/everysec)로: 내구성 설정이 지연을 결정한다",
  category: "WAL",
  summary: "단일 행 INSERT 500건을 synchronous_commit=on 과 off 로, Redis SET 500건을 appendfsync=always 와 everysec 로 돌려 p50/p99 를 비교하고, 각 설정이 '전원이 나가면 무엇을 잃는가' 를 정리한다. 실험 후 설정을 원복",
  notes: ["04-wal-checkpoint-recovery", "01-disk-memory-hierarchy"],
  description: `
저장소마다 이름은 달라도 손잡이는 하나다: **커밋이 돌아오기 전에 로그를 fsync 하는가?**
- PostgreSQL \`synchronous_commit = on\` : WAL fsync 후 응답. \`off\` : WAL 버퍼에만 쓰고 응답, 최대 \`wal_writer_delay × 3\`(~600ms) 분량 유실 가능. 손상은 없다.
- Redis \`appendfsync = always\` : 명령마다 AOF fsync. \`everysec\` : 1초마다 백그라운드 fsync, 최대 1초 유실. \`no\` : OS 에 맡김.
둘 다 **"유실 가능 시간 창"** 을 사서 **지연** 을 줄인다. 어느 쪽이 옳은지는 데이터의 성격(결제 vs 조회수)이 정한다.
`,
  code: `-- PostgreSQL
SET synchronous_commit = on;   -- 500 × INSERT (autocommit) → p50/p99
SET synchronous_commit = off;  -- 같은 것
-- Redis
CONFIG SET appendonly yes
CONFIG SET appendfsync always   -- 500 × SET
CONFIG SET appendfsync everysec -- 500 × SET
CONFIG GET appendfsync / INFO persistence (aof_pending_bio_fsync, aof_delayed_fsync)`,
  requires: async () => {
    const pg = await requiresPg();
    if (pg) return pg;
    try {
      const r = getRedis();
      await ensureConnected(r);
      return null;
    } catch {
      return "Redis(6379)가 필요합니다 (pnpm redis 또는 pnpm redis:docker).";
    }
  },
  async run({ rec, k }) {
    const N = 500;
    const c = pgClient();
    await c.connect();
    const t = k("wal");
    const pgRes: Record<string, { p50_ms: number; p99_ms: number; total_ms: number }> = {};
    try {
      await c.query(`drop table if exists ${t}`);
      await c.query(`create table ${t} (id serial primary key, v text)`);
      for (const mode of ["on", "off"]) {
        await c.query(`set synchronous_commit = ${mode}`);
        const lat: number[] = [];
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          const s = performance.now();
          await c.query(`insert into ${t} (v) values ($1)`, ["x".repeat(100)]);
          lat.push(performance.now() - s);
        }
        pgRes[`synchronous_commit=${mode}`] = { p50_ms: Number(quantile(lat, 0.5).toFixed(2)), p99_ms: Number(quantile(lat, 0.99).toFixed(2)), total_ms: Math.round(performance.now() - t0) };
      }
      rec.steps.push({ cmd: `PostgreSQL: ${N} × INSERT (autocommit, 네트워크 왕복 포함)`, result: pgRes, ms: 0 });
      const on = pgRes["synchronous_commit=on"], off = pgRes["synchronous_commit=off"];
      rec.check("off 가 on 보다 빠르거나 같다 (WAL fsync 를 커밋 경로에서 뺀다)", off.total_ms <= on.total_ms * 1.05, { on, off });
      rec.note(on.total_ms - off.total_ms < on.total_ms * 0.15 ? "차이가 작다 — Docker Desktop 의 가상 디스크/페이지 캐시 때문에 fsync 가 싸다. 진짜 디스크(특히 네트워크 볼륨)에서는 on/off 가 수 배 차이 난다." : `fsync 비용 ≈ 커밋당 ${((on.total_ms - off.total_ms) / N).toFixed(2)}ms`);
      await c.query(`set synchronous_commit = on`);
    } finally {
      await c.query(`drop table if exists ${t}`).catch(() => {});
      await c.end();
    }

    const r = getRedis();
    await ensureConnected(r);
    const origAppendonly = (await r.config("GET", "appendonly"))[1] as string;
    const origFsync = (await r.config("GET", "appendfsync"))[1] as string;
    rec.steps.push({ cmd: "CONFIG GET appendonly / appendfsync (원래 값)", result: { appendonly: origAppendonly, appendfsync: origFsync }, ms: 0 });
    const redisRes: Record<string, { p50_ms: number; p99_ms: number; total_ms: number }> = {};
    try {
      await r.config("SET", "appendonly", "yes");
      await rec.sleep(300);
      for (const mode of ["always", "everysec"]) {
        await r.config("SET", "appendfsync", mode);
        const lat: number[] = [];
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          const s = performance.now();
          await r.set(`${k("aof")}:${i}`, "x".repeat(100));
          lat.push(performance.now() - s);
        }
        redisRes[`appendfsync=${mode}`] = { p50_ms: Number(quantile(lat, 0.5).toFixed(3)), p99_ms: Number(quantile(lat, 0.99).toFixed(3)), total_ms: Math.round(performance.now() - t0) };
      }
      rec.steps.push({ cmd: `Redis: ${N} × SET (AOF 켬)`, result: redisRes, ms: 0 });
      const al = redisRes["appendfsync=always"], ev = redisRes["appendfsync=everysec"];
      rec.check("everysec 가 always 보다 빠르거나 같다 (fsync 를 1초에 한 번, 백그라운드로)", ev.total_ms <= al.total_ms * 1.05, { always: al, everysec: ev });
      const info = await r.info("persistence");
      const pick = (key: string) => info.match(new RegExp(`${key}:(\\S+)`))?.[1];
      rec.steps.push({ cmd: "INFO persistence (발췌)", result: { aof_enabled: pick("aof_enabled"), aof_pending_bio_fsync: pick("aof_pending_bio_fsync"), aof_delayed_fsync: pick("aof_delayed_fsync"), aof_current_size: pick("aof_current_size") }, ms: 0 });
      rec.note("aof_delayed_fsync 가 늘면 디스크가 everysec 의 fsync 를 1초 안에 못 끝내 메인 스레드가 2초까지 기다리게 된다 — Redis 지연 스파이크의 흔한 원인 ([Redis 영속성](/redis/notes/04-persistence)).");
    } finally {
      await r.config("SET", "appendfsync", origFsync).catch(() => {});
      await r.config("SET", "appendonly", origAppendonly).catch(() => {});
      const keys = await r.keys(`${k("aof")}:*`);
      if (keys.length) await r.del(...keys);
      rec.steps.push({ cmd: "CONFIG SET 원복 + 키 정리", result: { appendonly: origAppendonly, appendfsync: origFsync, deleted: keys.length }, ms: 0 });
    }
    rec.steps.push({
      cmd: "전원이 나가면 무엇을 잃는가",
      result: {
        "PG synchronous_commit=on": "커밋된 것은 전부 남음",
        "PG synchronous_commit=off": "최근 ~600ms 의 커밋 유실 가능, 손상 없음",
        "Redis appendfsync=always": "명령마다 fsync — 거의 유실 없음, 가장 느림",
        "Redis appendfsync=everysec": "최대 1초 유실",
        "Redis appendonly=no (RDB 만)": "마지막 스냅샷 이후 전부 유실",
      },
      ms: 0,
    });
  },
};
