import { Pool, type PoolClient } from "pg";
import { PG_URL } from "./postgres";
import type { CodeExperiment } from "./types";

/**
 * 이벤트 소싱 실험. PostgreSQL 한 테이블을 append-only 이벤트 스토어로 쓰고
 * 낙관적 동시성·프로젝션 재구축·스냅샷·업캐스팅을 실제로 재본다.
 */

async function requiresPg(): Promise<string | null> {
  const pool = new Pool({ connectionString: PG_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("select 1");
    return null;
  } catch {
    return "PostgreSQL(15432)에 연결할 수 없습니다. `pnpm pg:up` 을 실행하세요.";
  } finally {
    await pool.end().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function storeDdl(t: string, unique = true): string {
  return `create table ${t} (
    global_position bigserial primary key,
    stream_id text not null,
    version int not null,
    type text not null,
    data jsonb not null,
    created_at timestamptz not null default now()${unique ? `,\n    unique (stream_id, version)` : ""}
  )`;
}

type Ev = { version: number; type: string; data: { amount: number } };

/** 스트림을 읽어 잔액을 접는다 (집합 로딩) */
async function loadAccount(c: PoolClient | Pool, t: string, stream: string): Promise<{ balance: number; version: number }> {
  const { rows } = await c.query<Ev>(`select version, type, data from ${t} where stream_id = $1 order by version`, [stream]);
  let balance = 0;
  for (const e of rows) balance += e.type === "MoneyDeposited" ? e.data.amount : -e.data.amount;
  return { balance, version: rows.at(-1)?.version ?? 0 };
}

// ---------------------------------------------------------------- 1. 낙관적 동시성
export const esOptimisticConcurrency: CodeExperiment = {
  id: "es-optimistic-concurrency",
  subject: "event-sourcing",
  title: "낙관적 동시성: 같은 계좌 스트림에 동시 출금 20건 — expected_version 이 잔액 불변식을 지킨다",
  category: "이벤트 스토어",
  summary: "잔액 100 인 계좌에 10원 출금 명령 20개를 동시에 보낸다. unique(stream_id, version) 로 expected_version 을 검사하는 스토어는 충돌난 명령을 다시 시도하게 해 정확히 10건만 성공하고 잔액이 0 에서 멈춘다. 버전 검사가 없는 스토어에선 같은 잔액을 본 명령들이 모두 출금해 잔액이 음수가 된다",
  notes: ["03-event-store", "01-state-vs-facts"],
  description: `
이벤트 소싱에서 명령 처리는 **읽기 → 결정 → 추가** 다. 스트림을 읽어 현재 상태(잔액 100, 버전 5)를 만들고, 규칙(잔액 ≥ 출금액)을 검사한 뒤, 새 이벤트를 **버전 6** 으로 추가한다.
두 명령이 동시에 같은 버전 5 를 읽으면 둘 다 "가능" 이라고 결정한다. 스토어가 \`(stream_id, version)\` 유일 제약으로 두 번째 추가를 거부해야 불변식이 지켜진다 — 이것이 **expected_version** 기반 낙관적 동시성이다. 거부당한 명령은 스트림을 다시 읽고 다시 결정한다.
이 실험은 같은 워크로드를 유일 제약이 있는 스토어와 없는 스토어에서 돌려 결과를 비교한다.
`,
  code: `-- 이벤트 스토어
create table events (global_position bigserial primary key, stream_id text, version int, type text, data jsonb,
                     unique (stream_id, version));
-- 명령 처리: 읽기 → 결정 → 추가(expected_version)
select version, type, data from events where stream_id = 'acc-1' order by version;   -- 잔액 100, 버전 5
insert into events (stream_id, version, type, data) values ('acc-1', 6, 'MoneyWithdrawn', '{"amount":10}');
-- 동시에 버전 6 을 넣으려던 다른 명령 → 23505 unique_violation → 다시 읽고 다시 결정`,
  requires: requiresPg,
  async run({ rec, k }) {
    const pool = new Pool({ connectionString: PG_URL, max: 20 });
    const safe = k("events"), naive = k("events_naive");
    try {
      await pool.query(`drop table if exists ${safe}, ${naive}`);
      await pool.query(storeDdl(safe, true));
      await pool.query(storeDdl(naive, false));
      rec.steps.push({ cmd: `create table ${safe} (… unique (stream_id, version))  ·  ${naive} (유일 제약 없음)`, result: "OK", ms: 0 });
      for (const t of [safe, naive]) await pool.query(`insert into ${t} (stream_id, version, type, data) values ('acc-1', 1, 'MoneyDeposited', '{"amount":100}')`);
      rec.note("두 스토어 모두 계좌 acc-1 에 100 을 입금해 둔다. 이제 10원 출금 명령 20개를 동시에 보낸다");

      const withdraw = async (t: string, retry: boolean) => {
        let attempts = 0;
        for (;;) {
          attempts++;
          const c = await pool.connect();
          try {
            const { balance, version } = await loadAccount(c, t, "acc-1");
            if (balance < 10) return { result: "rejected" as const, attempts };
            await sleep(Math.random() * 5); // 결정에 걸리는 시간 — 경쟁 창을 넓힌다
            try {
              await c.query(`insert into ${t} (stream_id, version, type, data) values ('acc-1', $1, 'MoneyWithdrawn', '{"amount":10}')`, [version + 1]);
              return { result: "ok" as const, attempts };
            } catch (e) {
              if ((e as { code?: string }).code !== "23505") throw e;
              if (!retry) return { result: "conflict" as const, attempts };
              await sleep(Math.random() * 10);
            }
          } finally {
            c.release();
          }
        }
      };

      const summarize = async (t: string, label: string, retry: boolean) => {
        const t0 = performance.now();
        const results = await Promise.all(Array.from({ length: 20 }, () => withdraw(t, retry)));
        const ms = Math.round(performance.now() - t0);
        const ok = results.filter((r) => r.result === "ok").length;
        const rejected = results.filter((r) => r.result === "rejected").length;
        const conflicts = results.filter((r) => r.result === "conflict").length;
        const retries = results.reduce((a, r) => a + r.attempts - 1, 0);
        const { balance, version } = await loadAccount(pool, t, "acc-1");
        const dupVersions = Number((await pool.query(`select count(*) - count(distinct version) d from ${t} where stream_id = 'acc-1'`)).rows[0].d);
        return { label, ok, rejected, conflicts, retries, balance, version, dupVersions, ms };
      };

      const a = await summarize(safe, "유일 제약 + 재시도", true);
      await pool.query(`delete from ${safe} where version > 1`);
      const b = await summarize(safe, "유일 제약, 재시도 없음", false);
      const c = await summarize(naive, "버전 검사 없음", false);
      rec.steps.push({
        cmd: "동시 출금 20건 (각 10원, 시작 잔액 100)",
        result: [a, b, c].map((x) => `${x.label}: 성공 ${x.ok} · 잔액부족 거절 ${x.rejected} · 충돌 ${x.conflicts} · 재시도 ${x.retries}회 → 최종 잔액 ${x.balance} (버전 ${x.version}, 중복 버전 ${x.dupVersions}) ${x.ms}ms`),
        ms: a.ms + b.ms + c.ms,
      });
      rec.check("유일 제약 + 재시도: 정확히 10건 성공, 잔액 0, 음수 없음", a.ok === 10 && a.balance === 0 && a.rejected === 10, a);
      rec.check("유일 제약 + 재시도: 경쟁 때문에 재시도가 실제로 일어났다", a.retries > 0, a.retries);
      rec.check("재시도 없음: 충돌난 명령은 사용자에게 409 로 돌아가고, 잔액은 여전히 음수가 아니다", b.balance >= 0 && b.conflicts > 0, b);
      rec.check("버전 검사 없음: 같은 잔액을 본 명령들이 모두 출금해 잔액이 음수가 된다 (같은 버전이 여러 번 기록됨)", c.balance < 0 && c.dupVersions > 0, c);
      rec.note(`요약: 낙관적 동시성은 락을 잡지 않는 대신 '나중에 온 쪽을 거절' 한다. 경쟁이 잦은 스트림(인기 상품 재고 하나)은 재시도가 폭주하므로 집합 경계를 다시 나누거나(재고를 창고·슬롯별로) 명령을 직렬화한다.`);
    } finally {
      await pool.query(`drop table if exists ${safe}, ${naive}`).catch(() => {});
      await pool.end();
    }
  },
};

// ---------------------------------------------------------------- 2. 프로젝션 재구축·스냅샷
export const esProjectionRebuild: CodeExperiment = {
  id: "es-projection-rebuild",
  subject: "event-sourcing",
  title: "프로젝션 재구축과 스냅샷: 10만 이벤트로 잔액 읽기 모델을 만들고, 체크포인트 증분 갱신과 처음부터 재생, 스냅샷 로딩을 잰다",
  category: "프로젝션",
  summary: "계좌 1,000개에 10만 이벤트를 넣고 잔액 프로젝션을 처음부터 재생(배치 5,000)해 SQL 집계와 정확히 같은지 확인한다. 이벤트 1,000개를 더한 뒤 체크포인트에서 이어 처리하는 증분 갱신 시간과 비교하고, 이벤트 2만 개짜리 뜨거운 집합을 스냅샷 없이·있이 로딩한 시간과 읽은 행 수를 표로 만든다",
  notes: ["04-projections-replay", "05-snapshots-performance"],
  description: `
읽기 모델(프로젝션)은 이벤트 로그에서 **파생**된다. 언제든 지우고 처음부터 다시 만들 수 있다는 것이 이벤트 소싱의 큰 장점이지만, 이벤트가 쌓이면 재구축 시간이 운영 문제가 된다.
평소에는 **체크포인트**(마지막으로 처리한 global_position)부터 새 이벤트만 처리한다. 버그를 고친 프로젝션은 처음부터 다시 만든다.
명령 처리 쪽에서는 이벤트가 많은 집합의 **로딩 시간**이 문제다. 스냅샷(어느 버전에서의 상태)을 저장해 두고 그 뒤 이벤트만 접으면 된다.
`,
  code: `-- 프로젝션: 체크포인트 이후만 처리
select global_position, stream_id, type, data from events where global_position > :checkpoint order by global_position limit 5000;
insert into balances (account, balance) values … on conflict (account) do update set balance = balances.balance + excluded.balance;
update checkpoints set position = :last where name = 'balances';     -- 같은 트랜잭션에서!
-- 스냅샷: 버전 19,900 의 상태 + 그 뒤 100개만
select state, version from snapshots where stream_id = 'hot-1';
select … from events where stream_id = 'hot-1' and version > 19900 order by version;`,
  requires: requiresPg,
  async run({ rec, k }) {
    const pool = new Pool({ connectionString: PG_URL, max: 4 });
    const ev = k("events"), bal = k("balances"), cp = k("checkpoints"), snap = k("snapshots");
    try {
      await pool.query(`drop table if exists ${ev}, ${bal}, ${cp}, ${snap}`);
      await pool.query(storeDdl(ev, true));
      await pool.query(`create table ${bal} (account text primary key, balance bigint not null)`);
      await pool.query(`create table ${cp} (name text primary key, position bigint not null)`);
      await pool.query(`create table ${snap} (stream_id text primary key, version int not null, state jsonb not null)`);
      await rec.measure("이벤트 10만 개 적재 (계좌 1,000개 × 100, 입금·출금 섞음)", () =>
        pool.query(`insert into ${ev} (stream_id, version, type, data)
          select 'acc-' || a, v, case when (a + v) % 4 = 0 then 'MoneyWithdrawn' else 'MoneyDeposited' end,
                 jsonb_build_object('amount', ((a * 7 + v * 13) % 90) + 10)
          from generate_series(1, 1000) a, generate_series(1, 100) v
          order by v, a`).then((r) => `${r.rowCount} 행`),
      );

      type Row = { global_position: string; stream_id: string; type: string; data: { amount: number } };
      const project = async (from: number): Promise<{ processed: number; last: number; batches: number }> => {
        let pos = from, processed = 0, batches = 0;
        for (;;) {
          const { rows } = await pool.query<Row>(`select global_position, stream_id, type, data from ${ev} where global_position > $1 order by global_position limit 5000`, [pos]);
          if (rows.length === 0) break;
          const delta = new Map<string, number>();
          for (const r of rows) delta.set(r.stream_id, (delta.get(r.stream_id) ?? 0) + (r.type === "MoneyDeposited" ? r.data.amount : -r.data.amount));
          pos = Number(rows.at(-1)!.global_position);
          const c = await pool.connect();
          try {
            await c.query("begin");
            await c.query(`insert into ${bal} (account, balance) select * from unnest($1::text[], $2::bigint[]) on conflict (account) do update set balance = ${bal}.balance + excluded.balance`, [[...delta.keys()], [...delta.values()]]);
            await c.query(`insert into ${cp} (name, position) values ('balances', $1) on conflict (name) do update set position = excluded.position`, [pos]);
            await c.query("commit");
          } finally {
            c.release();
          }
          processed += rows.length;
          batches++;
        }
        return { processed, last: pos, batches };
      };
      const truth = async () => (await pool.query(`select count(*) n from (select stream_id, sum(case when type='MoneyDeposited' then (data->>'amount')::int else -(data->>'amount')::int end) s from ${ev} group by stream_id) t join ${bal} b on b.account = t.stream_id and b.balance = t.s`)).rows[0].n as string;

      const t1 = performance.now();
      const full = await project(0);
      const fullMs = Math.round(performance.now() - t1);
      rec.steps.push({ cmd: "처음부터 재생 (배치 5,000, 배치마다 프로젝션 갱신 + 체크포인트를 한 트랜잭션에)", result: `${full.processed} 이벤트 · ${full.batches} 배치 · ${fullMs}ms (${Math.round(full.processed / (fullMs / 1000))} 이벤트/초)`, ms: fullMs });
      rec.check("재생한 잔액 1,000개가 SQL 직접 집계와 모두 일치", Number(await truth()) === 1000);

      await pool.query(`insert into ${ev} (stream_id, version, type, data)
        select 'acc-' || a, 100 + v, 'MoneyDeposited', jsonb_build_object('amount', 5)
        from generate_series(1, 1000) a, generate_series(1, 1) v`);
      const cpBefore = Number((await pool.query(`select position from ${cp} where name = 'balances'`)).rows[0].position);
      const t2 = performance.now();
      const inc = await project(cpBefore);
      const incMs = Math.round(performance.now() - t2);
      rec.steps.push({ cmd: `새 이벤트 1,000개 추가 후 체크포인트(${cpBefore})부터 증분 갱신`, result: `${inc.processed} 이벤트 · ${incMs}ms`, ms: incMs });
      rec.check("증분 갱신도 SQL 집계와 일치", Number(await truth()) === 1000);
      rec.check("증분 갱신은 새 이벤트만 처리했다", inc.processed === 1000, inc.processed);

      await pool.query(`truncate ${bal}; delete from ${cp}`);
      const t3 = performance.now();
      const again = await project(0);
      const againMs = Math.round(performance.now() - t3);
      rec.steps.push({ cmd: "프로젝션 버그를 고쳤다고 가정하고 읽기 모델을 지우고 처음부터 재구축", result: `${again.processed} 이벤트 · ${againMs}ms — 이벤트가 1억 개라면 같은 속도로 약 ${Math.round((1e8 / again.processed) * againMs / 60000)}분`, ms: againMs });

      rec.note("스냅샷 — 이벤트 2만 개짜리 뜨거운 집합 hot-1");
      await pool.query(`insert into ${ev} (stream_id, version, type, data) select 'hot-1', v, 'MoneyDeposited', jsonb_build_object('amount', 1) from generate_series(1, 20000) v`);
      const loadFull = async () => {
        const t = performance.now();
        const s = await loadAccount(pool, ev, "hot-1");
        return { ...s, ms: performance.now() - t, rows: s.version };
      };
      const loadSnap = async () => {
        const t = performance.now();
        const sn = (await pool.query<{ version: number; state: { balance: number } }>(`select version, state from ${snap} where stream_id = 'hot-1'`)).rows[0];
        const { rows } = await pool.query<Ev>(`select version, type, data from ${ev} where stream_id = 'hot-1' and version > $1 order by version`, [sn.version]);
        let balance = sn.state.balance;
        for (const e of rows) balance += e.type === "MoneyDeposited" ? e.data.amount : -e.data.amount;
        return { balance, version: rows.at(-1)?.version ?? sn.version, ms: performance.now() - t, rows: rows.length + 1 };
      };
      await loadFull();
      const f = [await loadFull(), await loadFull(), await loadFull()].sort((x, y) => x.ms - y.ms)[1];
      const st = await loadAccount(pool, ev, "hot-1");
      const snapVersion = st.version - 100;
      const stAt = (await pool.query(`select sum((data->>'amount')::int) s from ${ev} where stream_id = 'hot-1' and version <= $1`, [snapVersion])).rows[0].s as string;
      await pool.query(`insert into ${snap} (stream_id, version, state) values ('hot-1', $1, $2)`, [snapVersion, JSON.stringify({ balance: Number(stAt) })]);
      await loadSnap();
      const s = [await loadSnap(), await loadSnap(), await loadSnap()].sort((x, y) => x.ms - y.ms)[1];
      rec.steps.push({ cmd: "집합 로딩 (중앙값, 3회)", result: [`스냅샷 없음: 이벤트 ${f.rows}행 읽기 · ${f.ms.toFixed(1)}ms`, `스냅샷(버전 ${snapVersion}) + 꼬리 100행: ${s.rows}행 · ${s.ms.toFixed(1)}ms`], ms: 0 });
      rec.check("스냅샷 로딩 결과가 전체 재생과 같다 (잔액·버전)", s.balance === f.balance && s.version === f.version, { full: f.balance, snap: s.balance });
      rec.check("스냅샷이 읽는 행 수를 99% 이상 줄인다", s.rows < f.rows / 100, { full: f.rows, snap: s.rows });
      rec.note(`스냅샷은 최적화일 뿐 진실이 아니다 — 지워도 이벤트로 다시 만든다. 스냅샷 형식이 바뀌면 버리고 재생성한다.`);
    } finally {
      await pool.query(`drop table if exists ${ev}, ${bal}, ${cp}, ${snap}`).catch(() => {});
      await pool.end();
    }
  },
};

// ---------------------------------------------------------------- 3. 업캐스팅
type AnyEvent = { type: string; schema: number; data: Record<string, unknown> };
type State = Record<string, number>;

function reduceV2(events: { type: string; data: { amount: number; currency: string } }[]): State {
  const s: State = {};
  for (const e of events) {
    if (typeof e.data.currency !== "string") throw new Error(`currency 없음: ${JSON.stringify(e.data)}`);
    const cur = e.data.currency;
    s[cur] = (s[cur] ?? 0) + (e.type === "MoneyDeposited" ? e.data.amount : -e.data.amount);
  }
  return s;
}

/** v1 → v2: 통화가 없던 시절 이벤트는 모두 원화였다는 도메인 사실을 코드로 */
function upcast(e: AnyEvent): { type: string; data: { amount: number; currency: string } } {
  if (e.schema === 1) return { type: e.type, data: { amount: Number(e.data.amount), currency: "KRW" } };
  return { type: e.type, data: e.data as { amount: number; currency: string } };
}

export const esUpcasting: CodeExperiment = {
  id: "es-upcasting",
  subject: "event-sourcing",
  title: "업캐스팅: 통화가 없던 v1 이벤트를 읽을 때 v2 로 올려 재생하면 같은 상태가 나온다",
  category: "스키마 진화",
  summary: "MoneyDeposited{amount}(v1) 이벤트 위에 {amount, currency}(v2) 이벤트가 쌓인 스트림을 v2 리듀서로 재생한다. 업캐스터가 없으면 첫 v1 이벤트에서 깨지고(또는 통화가 'undefined' 인 잔액이 생기고), 읽기 시점 업캐스터를 넣으면 원래 의도한 상태(통화별 잔액)가 나온다. 저장된 이벤트는 한 줄도 바꾸지 않는다",
  notes: ["06-schema-evolution", "03-event-store"],
  description: `
이벤트는 과거의 사실이라 **고치지 않는다**. 그런데 코드는 계속 바뀐다. 다중 통화를 지원하면서 \`MoneyDeposited\` 에 \`currency\` 가 생겼다면, 이미 저장된 v1 이벤트는 어떻게 읽어야 할까?
**업캐스터**는 읽는 길목에서 옛 스키마를 새 스키마로 바꿔 주는 순수 함수다(v1 → v2: currency = "KRW"). 리듀서는 최신 스키마만 알면 된다. 저장소의 이벤트를 다시 쓰는 "복사·변환" 마이그레이션보다 안전하지만, 업캐스터 체인이 길어지면 읽기 비용과 복잡도가 쌓인다.
`,
  code: `// 저장된 이벤트 (바꾸지 않는다)
{ type: "MoneyDeposited", schema: 1, data: { amount: 5000 } }
{ type: "MoneyDeposited", schema: 2, data: { amount: 30, currency: "USD" } }
// 업캐스터: 읽을 때만 변환
const upcast = (e) => e.schema === 1 ? { ...e, schema: 2, data: { ...e.data, currency: "KRW" } } : e;
const state = reduceV2(events.map(upcast));   // { KRW: …, USD: … }`,
  requires: requiresPg,
  async run({ rec, k }) {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const t = k("events");
    try {
      await pool.query(`drop table if exists ${t}`);
      await pool.query(`create table ${t} (global_position bigserial primary key, stream_id text, version int, type text, schema int, data jsonb, unique (stream_id, version))`);
      const rows: [string, number, unknown][] = [
        ["MoneyDeposited", 1, { amount: 5000 }],
        ["MoneyDeposited", 1, { amount: 2000 }],
        ["MoneyWithdrawn", 1, { amount: 1500 }],
        ["MoneyDeposited", 2, { amount: 30, currency: "USD" }],
        ["MoneyDeposited", 2, { amount: 1000, currency: "KRW" }],
        ["MoneyWithdrawn", 2, { amount: 10, currency: "USD" }],
      ];
      for (const [i, [type, schema, data]] of rows.entries()) await pool.query(`insert into ${t} (stream_id, version, type, schema, data) values ('acc-1', $1, $2, $3, $4)`, [i + 1, type, schema, JSON.stringify(data)]);
      rec.steps.push({ cmd: "스트림 acc-1: v1 이벤트 3개(통화 없음) 뒤에 v2 이벤트 3개(통화 있음)", result: rows.map(([ty, sc, d]) => `v${sc} ${ty} ${JSON.stringify(d)}`), ms: 0 });
      const stored = (await pool.query<AnyEvent>(`select type, schema, data from ${t} where stream_id = 'acc-1' order by version`)).rows;
      const before = JSON.stringify(stored);

      let brokeAt = "";
      try {
        reduceV2(stored as unknown as { type: string; data: { amount: number; currency: string } }[]);
      } catch (e) {
        brokeAt = (e as Error).message;
      }
      rec.steps.push({ cmd: "업캐스터 없이 v2 리듀서로 재생", result: brokeAt ? `실패 — ${brokeAt}` : "통과?!", ms: 0, error: !!brokeAt });
      rec.check("업캐스터가 없으면 첫 v1 이벤트에서 재생이 깨진다", brokeAt.includes("currency 없음"));

      const lenient: State = {};
      for (const e of stored) {
        const cur = String((e.data as { currency?: string }).currency);
        lenient[cur] = (lenient[cur] ?? 0) + (e.type === "MoneyDeposited" ? Number(e.data.amount) : -Number(e.data.amount));
      }
      rec.steps.push({ cmd: "검사를 빼고 '관대하게' 재생하면", result: lenient, ms: 0 });
      rec.check("관대한 리듀서는 깨지지 않는 대신 통화 'undefined' 계정을 만든다 — 조용한 데이터 오염", "undefined" in lenient);

      const state = reduceV2(stored.map(upcast));
      rec.steps.push({ cmd: "읽기 시점 업캐스터(v1 → v2, currency='KRW')를 거쳐 재생", result: state, ms: 0 });
      rec.check("업캐스팅 재생 결과: KRW 6500, USD 20", state.KRW === 6500 && state.USD === 20, state);
      const after = JSON.stringify((await pool.query(`select type, schema, data from ${t} where stream_id = 'acc-1' order by version`)).rows);
      rec.check("저장된 이벤트는 한 바이트도 바뀌지 않았다 (업캐스팅은 읽기 경로의 변환)", before === after);
      const n = 200_000;
      const many: AnyEvent[] = Array.from({ length: n }, (_, i) => (i % 2 ? { type: "MoneyDeposited", schema: 1, data: { amount: 1 } } : { type: "MoneyDeposited", schema: 2, data: { amount: 1, currency: "KRW" } }));
      const ta = performance.now();
      reduceV2(many.filter((e) => e.schema === 2) as unknown as { type: string; data: { amount: number; currency: string } }[]);
      const plainMs = performance.now() - ta;
      const tb = performance.now();
      reduceV2(many.map(upcast));
      const upMs = performance.now() - tb;
      rec.steps.push({ cmd: `업캐스터 비용 (메모리 안 이벤트 ${n.toLocaleString()}개, 절반이 v1)`, result: `업캐스팅 포함 재생 ${upMs.toFixed(1)}ms · v2 만 재생 ${plainMs.toFixed(1)}ms (이벤트 수 절반)`, ms: Math.round(upMs) });
      rec.note("업캐스터 체인이 길어지면(v1→v2→v3→…) 스냅샷을 최신 스키마로 다시 만들거나, 조용한 시간에 '복사·변환' 으로 새 스트림을 만들어 체인을 끊는다.");
    } finally {
      await pool.query(`drop table if exists ${t}`).catch(() => {});
      await pool.end();
    }
  },
};
