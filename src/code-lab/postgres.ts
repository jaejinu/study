import { Client } from "pg";
import type { CodeExperiment } from "./types";

export const PG_URL = process.env.PG_URL ?? "postgres://study:study@127.0.0.1:15432/study";

export function pgClient() {
  return new Client({ connectionString: PG_URL, connectionTimeoutMillis: 3000, statement_timeout: 20000 });
}

export async function requiresPg(): Promise<string | null> {
  const c = pgClient();
  try {
    await c.connect();
    await c.query("select 1");
    return null;
  } catch {
    return `PostgreSQL(${PG_URL.replace(/:[^:@]+@/, ":***@")})에 연결할 수 없습니다. 터미널에서 \`pnpm pg:up\` 을 실행한 뒤 다시 시도하세요.`;
  } finally {
    await c.end().catch(() => {});
  }
}

function planLines(rows: { "QUERY PLAN": string }[]): string[] {
  return rows.map((r) => r["QUERY PLAN"]);
}

export const pgIndexExplain: CodeExperiment = {
  id: "pg-index-explain",
  subject: "postgres",
  title: "인덱스와 실행 계획: Seq Scan 이 Index Scan 으로 바뀌는 순간",
  category: "성능",
  summary: "10만 행 테이블에서 EXPLAIN ANALYZE 로 비용·시간을 재고, 인덱스를 만든 뒤 계획과 시간이 어떻게 달라지는지 비교",
  notes: ["02-indexes-explain"],
  description: `
옵티마이저는 통계(\`ANALYZE\`)를 보고 가장 싼 계획을 고른다. 인덱스가 없으면 전체를 읽는 **Seq Scan**, 있으면 **Index Scan**(또는 Bitmap/Index Only).
\`EXPLAIN ANALYZE\` 는 실제로 실행해 예상 행 수와 실제 행 수, 시간을 함께 보여준다 — 두 숫자가 크게 다르면 통계가 낡은 것이다.
인덱스는 공짜가 아니다: 쓰기마다 갱신 비용, 디스크, 그리고 선택도가 낮은 조건(전체의 수십 %)엔 Seq Scan 이 오히려 빠르다.

사전 준비: \`pnpm pg:up\`
`,
  code: `CREATE TABLE lab_users (id serial PRIMARY KEY, email text, age int, created_at timestamptz);
INSERT INTO lab_users (email, age, created_at)
  SELECT 'user' || g || '@ex.com', (random()*80)::int, now() - (g || ' seconds')::interval FROM generate_series(1,100000) g;
ANALYZE lab_users;
EXPLAIN ANALYZE SELECT * FROM lab_users WHERE email = 'user77777@ex.com';   -- Seq Scan
CREATE INDEX lab_users_email_idx ON lab_users (email);
EXPLAIN ANALYZE SELECT * FROM lab_users WHERE email = 'user77777@ex.com';   -- Index Scan
EXPLAIN ANALYZE SELECT * FROM lab_users WHERE age > 10;                      -- 선택도 낮음 → 여전히 Seq Scan`,
  requires: requiresPg,
  async run({ rec, k }) {
    const t = k("users");
    const c = pgClient();
    await c.connect();
    try {
      await c.query(`drop table if exists ${t}`);
      await rec.measure(`CREATE TABLE ${t} + 100,000행 INSERT`, async () => {
        await c.query(`create table ${t} (id serial primary key, email text, age int, created_at timestamptz)`);
        await c.query(`insert into ${t} (email, age, created_at) select 'user' || g || '@ex.com', (random()*80)::int, now() - (g || ' seconds')::interval from generate_series(1,100000) g`);
        await c.query(`analyze ${t}`);
        return "100000 rows";
      });
      const q = `select * from ${t} where email = 'user77777@ex.com'`;
      const before = planLines((await c.query(`explain analyze ${q}`)).rows);
      rec.steps.push({ cmd: `EXPLAIN ANALYZE ${q}`, result: before, ms: 0 });
      rec.check("인덱스 없음 → Seq Scan", before.some((l) => l.includes("Seq Scan")));
      const tBefore = Number(/Execution Time: ([\d.]+)/.exec(before.join("\n"))?.[1] ?? 0);

      await rec.measure(`CREATE INDEX ${t}_email_idx ON ${t}(email)`, () => c.query(`create index ${t}_email_idx on ${t} (email)`));
      const after = planLines((await c.query(`explain analyze ${q}`)).rows);
      rec.steps.push({ cmd: `EXPLAIN ANALYZE ${q}`, result: after, ms: 0 });
      rec.check("인덱스 생성 후 → Index Scan", after.some((l) => /Index Scan|Index Only Scan|Bitmap/.test(l)));
      const tAfter = Number(/Execution Time: ([\d.]+)/.exec(after.join("\n"))?.[1] ?? 0);
      rec.note(`실행 시간 ${tBefore}ms → ${tAfter}ms (${tAfter ? (tBefore / tAfter).toFixed(0) : "?"}배)`);
      rec.check("인덱스가 더 빠르다", tAfter < tBefore);

      rec.note("선택도가 낮은 조건은 인덱스가 있어도 Seq Scan 을 고른다");
      await c.query(`create index ${t}_age_idx on ${t} (age)`);
      const low = planLines((await c.query(`explain analyze select * from ${t} where age > 10`)).rows);
      rec.steps.push({ cmd: `EXPLAIN ANALYZE select * from ${t} where age > 10 (약 85% 행)`, result: low.slice(0, 3), ms: 0 });
      rec.check("대부분의 행을 읽는 조건 → Seq Scan", low.some((l) => l.includes("Seq Scan")));
      const idxSize = (await c.query(`select pg_size_pretty(pg_relation_size('${t}_email_idx')) s, pg_size_pretty(pg_relation_size('${t}')) t`)).rows[0];
      rec.note(`크기: 테이블 ${idxSize.t}, email 인덱스 ${idxSize.s}`);
    } finally {
      await c.query(`drop table if exists ${t}`).catch(() => {});
      await c.end();
    }
  },
};

export const pgIsolation: CodeExperiment = {
  id: "pg-transaction-isolation",
  subject: "postgres",
  title: "트랜잭션 격리: READ COMMITTED 와 REPEATABLE READ 의 차이",
  category: "트랜잭션",
  summary: "두 커넥션으로 non-repeatable read 를 재현하고, REPEATABLE READ 에선 스냅샷 덕분에 같은 값이 유지되는 것을 확인",
  notes: ["03-mvcc-isolation"],
  description: `
PostgreSQL 은 **MVCC** 로 읽기와 쓰기가 서로를 막지 않는다. 격리 수준은 "내 트랜잭션이 어느 시점의 스냅샷을 보느냐" 를 정한다.
- \`READ COMMITTED\` (기본): **문장마다** 새 스냅샷. 같은 행을 두 번 읽으면 사이에 커밋된 변경이 보인다 (non-repeatable read).
- \`REPEATABLE READ\`: **트랜잭션 시작 시점** 스냅샷을 끝까지 유지. 다른 트랜잭션이 바꾼 행을 갱신하려 하면 직렬화 오류.
- \`SERIALIZABLE\`: 직렬 실행과 동등함을 보장. 충돌 시 재시도 필요.

사전 준비: \`pnpm pg:up\`
`,
  code: `-- 세션 A                                  -- 세션 B
BEGIN;                                       
SELECT balance FROM acct WHERE id=1;  -- 100  
                                             UPDATE acct SET balance=50 WHERE id=1; COMMIT;
SELECT balance FROM acct WHERE id=1;  -- 50  (READ COMMITTED: 바뀐 값이 보인다)
COMMIT;

BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT balance ...;                   -- 50
                                             UPDATE acct SET balance=10 WHERE id=1; COMMIT;
SELECT balance ...;                   -- 50  (스냅샷 유지)
UPDATE acct SET balance=balance-1;    -- ERROR: could not serialize access`,
  requires: requiresPg,
  async run({ rec, k }) {
    const t = k("acct");
    const a = pgClient();
    const b = pgClient();
    await a.connect();
    await b.connect();
    try {
      await a.query(`drop table if exists ${t}`);
      await a.query(`create table ${t} (id int primary key, balance int)`);
      await a.query(`insert into ${t} values (1, 100)`);

      rec.note("READ COMMITTED (기본)");
      await a.query("begin");
      const r1 = (await a.query(`select balance from ${t} where id=1`)).rows[0].balance;
      rec.steps.push({ cmd: "[A] BEGIN; SELECT balance", result: r1, ms: 0 });
      await b.query(`update ${t} set balance = 50 where id = 1`);
      rec.steps.push({ cmd: "[B] UPDATE balance=50 (autocommit)", result: "UPDATE 1", ms: 0 });
      const r2 = (await a.query(`select balance from ${t} where id=1`)).rows[0].balance;
      rec.steps.push({ cmd: "[A] SELECT balance (같은 트랜잭션 안에서 다시)", result: r2, ms: 0 });
      await a.query("commit");
      rec.check("non-repeatable read: 100 → 50 으로 바뀌어 보인다", r1 === 100 && r2 === 50, [r1, r2]);

      rec.note("REPEATABLE READ");
      await a.query("begin isolation level repeatable read");
      const s1 = (await a.query(`select balance from ${t} where id=1`)).rows[0].balance;
      rec.steps.push({ cmd: "[A] BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT", result: s1, ms: 0 });
      await b.query(`update ${t} set balance = 10 where id = 1`);
      rec.steps.push({ cmd: "[B] UPDATE balance=10", result: "UPDATE 1", ms: 0 });
      const s2 = (await a.query(`select balance from ${t} where id=1`)).rows[0].balance;
      rec.steps.push({ cmd: "[A] SELECT balance (다시)", result: s2, ms: 0 });
      rec.check("스냅샷 유지: 두 번 다 50", s1 === 50 && s2 === 50, [s1, s2]);
      let serErr = "";
      try {
        await a.query(`update ${t} set balance = balance - 1 where id = 1`);
      } catch (e) {
        serErr = (e as Error).message;
      }
      rec.steps.push({ cmd: "[A] UPDATE balance = balance - 1 (B 가 바꾼 행)", result: serErr || "UPDATE 1", ms: 0, error: !!serErr });
      await a.query("rollback");
      rec.check("REPEATABLE READ 에서 갱신 충돌 → could not serialize access", /serialize/.test(serErr), serErr);
      const final = (await b.query(`select balance from ${t} where id=1`)).rows[0].balance;
      rec.check("최종 값은 B 가 커밋한 10", final === 10, final);
    } finally {
      await a.query("rollback").catch(() => {});
      await a.query(`drop table if exists ${t}`).catch(() => {});
      await a.end();
      await b.end();
    }
  },
};

export const pgRowLocks: CodeExperiment = {
  id: "pg-row-locks",
  subject: "postgres",
  title: "행 잠금: FOR UPDATE 로 막히는 시간 재기, SKIP LOCKED 큐 패턴",
  category: "트랜잭션",
  summary: "A 가 FOR UPDATE 로 잠근 행을 B 가 갱신하려 할 때 커밋까지 대기하는 시간을 측정하고, SKIP LOCKED 로 워커가 서로 다른 작업을 가져가는 것을 확인",
  notes: ["04-locks-deadlocks"],
  description: `
\`UPDATE\` 와 \`SELECT ... FOR UPDATE\` 는 행 단위 배타 잠금을 잡고, 같은 행을 잡으려는 다른 트랜잭션은 **커밋/롤백까지 대기**한다.
MVCC 덕분에 일반 \`SELECT\` 는 막히지 않는다. 잠금 대기가 길어지면 \`lock_timeout\` 으로 포기할 수 있다.
\`FOR UPDATE SKIP LOCKED\` 는 잠긴 행을 건너뛰어 **여러 워커가 큐 테이블에서 서로 다른 작업을 집어 가게** 한다 (DB 기반 작업 큐의 정석).

사전 준비: \`pnpm pg:up\`
`,
  code: `-- 세션 A                                       -- 세션 B
BEGIN; SELECT * FROM stock WHERE id=1 FOR UPDATE;
                                                  UPDATE stock SET qty=qty-1 WHERE id=1;  -- 대기…
COMMIT;                                           -- 이제 진행
-- SKIP LOCKED 큐
BEGIN; SELECT * FROM jobs WHERE done=false ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;
                                                  BEGIN; SELECT ... FOR UPDATE SKIP LOCKED;  -- 다른 행
SELECT pg_blocking_pids(pid), state, wait_event_type, query FROM pg_stat_activity WHERE wait_event_type='Lock';`,
  requires: requiresPg,
  async run({ rec, k }) {
    const t = k("stock");
    const jobs = k("jobs");
    const a = pgClient();
    const b = pgClient();
    const w1 = pgClient();
    const w2 = pgClient();
    await Promise.all([a.connect(), b.connect(), w1.connect(), w2.connect()]);
    try {
      await a.query(`drop table if exists ${t}; create table ${t} (id int primary key, qty int); insert into ${t} values (1, 10)`);
      await a.query("begin");
      await a.query(`select * from ${t} where id = 1 for update`);
      rec.steps.push({ cmd: "[A] BEGIN; SELECT ... WHERE id=1 FOR UPDATE", result: "행 잠금 획득", ms: 0 });

      const t0 = performance.now();
      const bUpdate = b.query(`update ${t} set qty = qty - 1 where id = 1`).then(() => Math.round(performance.now() - t0));
      await new Promise((r) => setTimeout(r, 300));
      const waiting = (await a.query(`select pid, state, wait_event_type, wait_event, left(query, 60) q from pg_stat_activity where wait_event_type = 'Lock'`)).rows;
      rec.steps.push({ cmd: "[A] pg_stat_activity 에서 Lock 대기 중인 세션", result: waiting, ms: 0 });
      rec.check("B 가 Lock 대기 상태로 보인다", waiting.length >= 1, waiting.length);
      const blocking = (await a.query(`select pg_blocking_pids(pid) blockers from pg_stat_activity where wait_event_type = 'Lock' limit 1`)).rows[0]?.blockers;
      rec.note(`B 를 막고 있는 pid: ${JSON.stringify(blocking)} (A 의 백엔드)`);

      await new Promise((r) => setTimeout(r, 500));
      await a.query("commit");
      rec.steps.push({ cmd: "[A] COMMIT", result: "잠금 해제", ms: 0 });
      const waitedMs = await bUpdate;
      rec.steps.push({ cmd: "[B] UPDATE qty = qty - 1 (A 커밋을 기다림)", result: `완료, ${waitedMs}ms 대기`, ms: waitedMs });
      rec.check("B 는 A 가 커밋할 때까지 약 800ms 막혔다", waitedMs >= 700, waitedMs);
      rec.check("최종 qty = 9", (await a.query(`select qty from ${t} where id=1`)).rows[0].qty === 9);

      rec.note("lock_timeout: 기다리지 않고 포기하기");
      await a.query("begin");
      await a.query(`select * from ${t} where id = 1 for update`);
      await b.query("set lock_timeout = '200ms'");
      let lockErr = "";
      try {
        await b.query(`update ${t} set qty = 0 where id = 1`);
      } catch (e) {
        lockErr = (e as Error).message;
      }
      await b.query("set lock_timeout = 0");
      await a.query("rollback");
      rec.check("lock_timeout 200ms 초과 → canceling statement due to lock timeout", /lock timeout/.test(lockErr), lockErr);

      rec.note("SKIP LOCKED 로 워커 2개가 서로 다른 작업을 가져간다");
      await a.query(`drop table if exists ${jobs}; create table ${jobs} (id serial primary key, payload text, done bool default false)`);
      await a.query(`insert into ${jobs} (payload) select 'job-' || g from generate_series(1, 5) g`);
      await w1.query("begin");
      await w2.query("begin");
      const pick = `select id, payload from ${jobs} where done = false order by id limit 1 for update skip locked`;
      const j1 = (await w1.query(pick)).rows[0];
      const j2 = (await w2.query(pick)).rows[0];
      rec.steps.push({ cmd: `[w1] ${pick}`, result: j1, ms: 0 });
      rec.steps.push({ cmd: `[w2] ${pick}`, result: j2, ms: 0 });
      rec.check("두 워커가 서로 다른 작업을 집었다 (w2 는 w1 이 잠근 행을 건너뜀)", j1.id !== j2.id, [j1.id, j2.id]);
      await w1.query(`update ${jobs} set done = true where id = $1`, [j1.id]);
      await w1.query("commit");
      await w2.query("rollback");
      const remaining = (await a.query(`select count(*)::int c from ${jobs} where done = false`)).rows[0].c;
      rec.check("w1 처리 완료 1건, w2 롤백 → 남은 작업 4건", remaining === 4, remaining);
    } finally {
      for (const c of [a, b, w1, w2]) await c.query("rollback").catch(() => {});
      await a.query(`drop table if exists ${t}; drop table if exists ${jobs}`).catch(() => {});
      await Promise.allSettled([a.end(), b.end(), w1.end(), w2.end()]);
    }
  },
};

export const pgDeadlock: CodeExperiment = {
  id: "pg-deadlock",
  subject: "postgres",
  title: "데드락: 서로 반대 순서로 잠그면 PostgreSQL 이 하나를 죽인다",
  category: "트랜잭션",
  summary: "A 는 1→2, B 는 2→1 순서로 행을 갱신해 데드락을 만들고, deadlock_timeout 후 한쪽이 40P01 에러로 중단되는 것을 확인",
  notes: ["04-locks-deadlocks"],
  description: `
A 가 행 1 을 잠근 채 행 2 를 기다리고, B 가 행 2 를 잠근 채 행 1 을 기다리면 영원히 끝나지 않는다.
PostgreSQL 은 \`deadlock_timeout\`(기본 1초) 마다 대기 그래프에서 사이클을 찾아 **한 트랜잭션을 강제 종료**한다 (SQLSTATE 40P01).
예방법: **항상 같은 순서로 잠그기**(예: id 오름차순), 트랜잭션 짧게, 필요한 행을 한 번에 \`FOR UPDATE\` 로 잡기.

사전 준비: \`pnpm pg:up\`
`,
  code: `-- 세션 A                                -- 세션 B
BEGIN; UPDATE t SET v=v+1 WHERE id=1;    BEGIN; UPDATE t SET v=v+1 WHERE id=2;
UPDATE t SET v=v+1 WHERE id=2;  -- 대기   UPDATE t SET v=v+1 WHERE id=1;  -- 대기
-- 1초 후 한쪽: ERROR: deadlock detected (40P01)
SHOW deadlock_timeout;`,
  requires: requiresPg,
  async run({ rec, k }) {
    const t = k("t");
    const a = pgClient();
    const b = pgClient();
    await Promise.all([a.connect(), b.connect()]);
    try {
      await a.query(`drop table if exists ${t}; create table ${t} (id int primary key, v int); insert into ${t} values (1,0),(2,0)`);
      const dt = (await a.query("show deadlock_timeout")).rows[0].deadlock_timeout;
      rec.note(`deadlock_timeout = ${dt}`);
      await a.query("begin");
      await b.query("begin");
      await a.query(`update ${t} set v = v + 1 where id = 1`);
      rec.steps.push({ cmd: "[A] UPDATE id=1", result: "잠금", ms: 0 });
      await b.query(`update ${t} set v = v + 1 where id = 2`);
      rec.steps.push({ cmd: "[B] UPDATE id=2", result: "잠금", ms: 0 });
      const t0 = performance.now();
      const pa = a.query(`update ${t} set v = v + 1 where id = 2`).then(() => "ok").catch((e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 100));
      const pb = b.query(`update ${t} set v = v + 1 where id = 1`).then(() => "ok").catch((e: Error) => e.message);
      const [ra, rb] = await Promise.all([pa, pb]);
      const ms = Math.round(performance.now() - t0);
      rec.steps.push({ cmd: "[A] UPDATE id=2 (B 가 잠근 행)", result: ra, ms, error: ra !== "ok" });
      rec.steps.push({ cmd: "[B] UPDATE id=1 (A 가 잠근 행)", result: rb, ms, error: rb !== "ok" });
      const victim = ra !== "ok" ? "A" : rb !== "ok" ? "B" : null;
      rec.check(`약 ${ms}ms 뒤 한쪽(${victim})이 deadlock detected 로 중단됨`, victim !== null && /deadlock detected/.test(ra + rb), { A: ra, B: rb });
      rec.check("다른 쪽은 정상 진행", (ra === "ok") !== (rb === "ok"));
      await a.query(ra === "ok" ? "commit" : "rollback");
      await b.query(rb === "ok" ? "commit" : "rollback");
      const rows = (await a.query(`select id, v from ${t} order by id`)).rows;
      rec.steps.push({ cmd: "최종 값 (살아남은 트랜잭션만 반영)", result: rows, ms: 0 });
    } finally {
      await a.query("rollback").catch(() => {});
      await b.query("rollback").catch(() => {});
      await a.query(`drop table if exists ${t}`).catch(() => {});
      await Promise.allSettled([a.end(), b.end()]);
    }
  },
};
