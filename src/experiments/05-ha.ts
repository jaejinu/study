import { execFile } from "node:child_process";
import path from "node:path";
import Redis, { Cluster } from "ioredis";
import { createRedis, ensureConnected } from "@/lib/redis";
import type { Experiment } from "./types";

const HA = { master: 6381, replicas: [6382, 6383], sentinels: [26381, 26382, 26383] };
const CLUSTER_PORTS = [7001, 7002, 7003, 7004, 7005, 7006];

async function pingPort(port: number): Promise<boolean> {
  const c = createRedis({ port, host: "127.0.0.1" });
  try {
    await ensureConnected(c);
    return (await c.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    c.disconnect();
  }
}

async function requiresHa(): Promise<string | null> {
  const ok = await Promise.all([HA.master, ...HA.replicas, ...HA.sentinels].map(pingPort));
  if (ok.some((v) => !v)) return "복제/Sentinel 실습 환경이 꺼져 있습니다. 터미널에서 `pnpm redis:ha` 를 실행한 뒤 다시 시도하세요. (끝나면 `pnpm redis:ha:down`)";
  return null;
}

async function requiresCluster(): Promise<string | null> {
  const ok = await Promise.all(CLUSTER_PORTS.map(pingPort));
  if (ok.some((v) => !v)) return "Cluster 실습 환경이 꺼져 있습니다. 터미널에서 `pnpm redis:cluster` 를 실행한 뒤 다시 시도하세요. (끝나면 `pnpm redis:cluster:down`)";
  return null;
}

function parseInfo(raw: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const l of raw.split("\n")) {
    const i = l.indexOf(":");
    if (i > 0 && !l.startsWith("#")) o[l.slice(0, i)] = l.slice(i + 1).trim();
  }
  return o;
}

export const replicationBasics: Experiment = {
  id: "replication-basics",
  title: "복제: 마스터에 쓰면 레플리카에서 읽힌다",
  category: "고가용성",
  summary: "master 1 + replica 2 에서 비동기 복제 확인, 레플리카 쓰기 거부(READONLY), WAIT 으로 복제 확인",
  notes: ["11-replication-sentinel-cluster"],
  description: `
복제는 **비동기**다. 마스터는 응답을 먼저 보내고 레플리카로 명령을 전파한다. 그래서 바로 레플리카에서 읽으면 아주 짧은 순간 옛 값이 보일 수 있다.
\`WAIT numreplicas timeout\` 은 "이 커넥션의 이전 쓰기가 N개 레플리카에 도달할 때까지" 기다려 준다. 레플리카는 기본 읽기 전용(\`replica-read-only yes\`)이다.

사전 준비: \`pnpm redis:ha\`
`,
  code: `redis-cli -p 6381 INFO replication      # role:master, connected_slaves:2
redis-cli -p 6381 SET greeting hello
redis-cli -p 6382 GET greeting          # hello (레플리카)
redis-cli -p 6382 SET x 1               # (error) READONLY
redis-cli -p 6381 WAIT 2 1000           # 2 (레플리카 2개가 ACK)
redis-cli -p 6383 ROLE`,
  requires: requiresHa,
  async run({ rec, k, newClient }) {
    const master = await newClient("master:6381", { port: HA.master });
    const r1 = await newClient("replica:6382", { port: HA.replicas[0] });
    const r2 = await newClient("replica:6383", { port: HA.replicas[1] });

    const info = parseInfo(await master.info("replication"));
    rec.check("마스터에 레플리카 2개 연결", info.role === "master" && info.connected_slaves === "2", `role=${info.role} connected_slaves=${info.connected_slaves}`);

    await master.set(k("greeting"), "hello");
    await rec.sleep(50);
    const v1 = await r1.get(k("greeting"));
    const v2 = await r2.get(k("greeting"));
    rec.check("두 레플리카 모두에서 읽힌다", v1 === "hello" && v2 === "hello", [v1, v2]);

    try {
      await r1.set(k("x"), 1);
      rec.check("레플리카 쓰기는 거부되어야 한다", false);
    } catch (e) {
      rec.check("레플리카 쓰기 → READONLY 에러", /READONLY/.test((e as Error).message), (e as Error).message);
    }

    rec.note("WAIT: 이전 쓰기가 레플리카 N개에 도달할 때까지 대기");
    await master.set(k("counter"), 1);
    const acked = await master.wait(2, 1000);
    rec.check("레플리카 2개가 ACK", acked === 2, acked);

    const role = (await r2.role()) as unknown[];
    rec.check("ROLE 은 slave + 마스터 주소", role[0] === "slave" && role[2] === HA.master, role.slice(0, 3));
    const rinfo = parseInfo(await r1.info("replication"));
    rec.note(`레플리카 상태: master_link_status=${rinfo.master_link_status}, offset=${rinfo.slave_repl_offset}`);
    await master.del(k("greeting"), k("counter"));
  },
};

export const sentinelFailover: Experiment = {
  id: "sentinel-failover",
  title: "Sentinel: 마스터를 죽이면 자동으로 승격된다",
  category: "고가용성",
  summary: "마스터 SHUTDOWN → Sentinel 과반이 ODOWN 판정 → 레플리카 승격 → 클라이언트 자동 재연결 → 옛 마스터 복귀 시 레플리카로 합류",
  notes: ["11-replication-sentinel-cluster", "09-distributed-lock"],
  description: `
Sentinel 3개가 \`mymaster\` 를 감시한다 (\`down-after-milliseconds 1000\`, quorum 2). 마스터가 죽으면:
1. 각 Sentinel 이 **SDOWN**(주관적) → 2개 이상 동의하면 **ODOWN**(객관적)
2. Sentinel 리더 선출 → 레플리카 하나를 \`REPLICAOF NO ONE\` 으로 승격
3. 나머지 레플리카를 새 마스터로 재지정, \`+switch-master\` 이벤트 발행
4. ioredis 같은 Sentinel 지원 클라이언트는 이 이벤트를 받아 새 마스터로 재연결

옛 마스터가 돌아오면 Sentinel 이 새 마스터의 레플리카로 강등시킨다. 실험 마지막에 옛 마스터 프로세스를 다시 띄워 이를 확인한다.
failover 중 몇 초간 쓰기가 실패하거나 지연되고, 비동기 복제라 **마지막 몇 ms 의 쓰기는 유실**될 수 있다.

사전 준비: \`pnpm redis:ha\`
`,
  code: `redis-cli -p 26381 SENTINEL get-master-addr-by-name mymaster   # 127.0.0.1 6381
redis-cli -p 6381 SHUTDOWN NOSAVE                              # 마스터 사망
# 1~3초 후
redis-cli -p 26381 SENTINEL get-master-addr-by-name mymaster   # 127.0.0.1 6382 (또는 6383)
redis-cli -p 6382 ROLE                                         # master
tail -n 20 redis/ha/run/26381.log       # +sdown → +odown → +vote-for-leader → +switch-master
redis/ha/node.sh 6381 6382              # 옛 마스터를 다시 띄우면
redis-cli -p 6381 ROLE                  # slave (Sentinel 이 강등)`,
  requires: requiresHa,
  async run({ rec, k, newClient, raw }) {
    void raw;
    const sentinel = await newClient("sentinel:26381", { port: HA.sentinels[0] });
    // 폴링은 기록되지 않는 원본 클라이언트로 (로그 폭주 방지)
    const sentinelRaw = createRedis({ port: HA.sentinels[0], host: "127.0.0.1" });
    await ensureConnected(sentinelRaw);
    const addr = (await sentinel.call("SENTINEL", "get-master-addr-by-name", "mymaster")) as [string, string];
    const oldPort = Number(addr[1]);
    rec.check("Sentinel 이 아는 현재 마스터", [HA.master, ...HA.replicas].includes(oldPort), `${addr[0]}:${addr[1]}`);
    const replicasInfo = (await sentinel.call("SENTINEL", "replicas", "mymaster")) as unknown[];
    rec.note(`Sentinel 이 아는 레플리카 수: ${replicasInfo.length}`);

    rec.note("Sentinel 을 통해 접속하는 클라이언트 (failover 후 자동으로 새 마스터를 찾는다)");
    const viaSentinel = await newClient("via-sentinel", {
      sentinels: HA.sentinels.map((port) => ({ host: "127.0.0.1", port })),
      name: "mymaster",
      enableOfflineQueue: true,
      maxRetriesPerRequest: 30,
      retryStrategy: (t) => Math.min(t * 100, 1000),
      sentinelRetryStrategy: (t) => Math.min(t * 100, 1000),
    });
    await viaSentinel.set(k("before"), "written-before-failover");

    rec.note(`마스터(${oldPort})를 죽인다`);
    const victim = createRedis({ port: oldPort, host: "127.0.0.1" });
    await ensureConnected(victim);
    const t0 = performance.now();
    try {
      await victim.shutdown("NOSAVE");
    } catch {
      /* 연결이 끊기며 에러가 나는 것이 정상 */
    }
    victim.disconnect();
    rec.steps.push({ cmd: `[master:${oldPort}] SHUTDOWN NOSAVE`, result: "connection closed", ms: 0 });

    let newPort = oldPort;
    await rec.measure("Sentinel 이 새 마스터를 선출할 때까지 대기", async () => {
      for (let i = 0; i < 60; i++) {
        const a = (await sentinelRaw.call("SENTINEL", "get-master-addr-by-name", "mymaster")) as [string, string];
        if (Number(a[1]) !== oldPort) {
          newPort = Number(a[1]);
          return `새 마스터 ${a[0]}:${a[1]} (${Math.round(performance.now() - t0)}ms)`;
        }
        await rec.sleep(250);
      }
      throw new Error("15초 안에 failover 가 일어나지 않음");
    });
    rec.check("새 마스터는 옛 레플리카 중 하나", HA.replicas.includes(newPort) || newPort === HA.master, newPort);

    const newMaster = await newClient(`new-master:${newPort}`, { port: newPort });
    const role = (await newMaster.role()) as unknown[];
    rec.check("ROLE master", role[0] === "master", role[0]);
    rec.check("failover 전 데이터가 살아 있다", (await newMaster.get(k("before"))) === "written-before-failover");

    rec.note("Sentinel 클라이언트는 재연결 후 새 마스터에 쓴다");
    await rec.measure("via-sentinel SET (재연결 대기 포함)", async () => {
      for (let i = 0; i < 40; i++) {
        try {
          return await viaSentinel.set(k("after"), "written-after-failover");
        } catch {
          await rec.sleep(250);
        }
      }
      throw new Error("Sentinel 클라이언트가 재연결하지 못함");
    });
    rec.check("새 마스터에서 읽힘", (await newMaster.get(k("after"))) === "written-after-failover");

    rec.note(`옛 마스터(${oldPort})를 다시 띄우면 레플리카로 합류한다`);
    await rec.measure(`redis/ha/node.sh ${oldPort} ${newPort}`, () => new Promise<string>((resolve, reject) => {
      execFile(path.join(process.cwd(), "redis", "ha", "node.sh"), [String(oldPort), String(newPort)], { timeout: 10_000 }, (err, so, se) => (err ? reject(new Error(se || err.message)) : resolve(so.trim() || "started")));
    }));
    const rejoinedRaw = createRedis({ port: oldPort, host: "127.0.0.1" });
    await rec.measure("옛 마스터가 레플리카로 동기화될 때까지", async () => {
      for (let i = 0; i < 40; i++) {
        try {
          await ensureConnected(rejoinedRaw);
          const info = parseInfo(await rejoinedRaw.info("replication"));
          if (info.role === "slave" && info.master_link_status === "up") return `role=slave master_port=${info.master_port} link=up`;
        } catch {
          /* 아직 시작 중 */
        }
        await rec.sleep(250);
      }
      throw new Error("옛 마스터가 레플리카로 합류하지 못함");
    });
    rejoinedRaw.disconnect();
    sentinelRaw.disconnect();
    const rejoined = await newClient(`old-master:${oldPort}`, { port: oldPort });
    const info = parseInfo(await rejoined.info("replication"));
    rec.check("옛 마스터가 레플리카로 합류 (role=slave, link=up)", info.role === "slave" && info.master_link_status === "up", `master_port=${info.master_port}`);
    rec.check("옛 마스터에서 failover 후 쓴 값이 읽힌다", (await rejoined.get(k("after"))) === "written-after-failover");
    await newMaster.del(k("before"), k("after"));
  },
};

export const clusterHashSlots: Experiment = {
  id: "cluster-hash-slots",
  title: "Cluster: 해시 슬롯, MOVED 리다이렉트, 해시태그",
  category: "고가용성",
  summary: "키가 어느 슬롯·노드로 가는지 확인하고, 엉뚱한 노드에 보내면 MOVED, 다중 키는 CROSSSLOT, {해시태그} 로 해결",
  notes: ["11-replication-sentinel-cluster"],
  description: `
Cluster 는 \`CRC16(key) mod 16384\` 로 슬롯을 정하고, 각 마스터가 슬롯 범위를 나눠 갖는다 (3 마스터면 약 5461개씩).
- 단순 클라이언트가 엉뚱한 노드에 보내면 \`MOVED <slot> <host:port>\` 에러. 스마트 클라이언트(ioredis Cluster)는 이 응답으로 슬롯 맵을 갱신해 다시 보낸다.
- 여러 키를 한 명령에 쓰려면 같은 슬롯이어야 한다. \`{user:1}:a\`, \`{user:1}:b\` 처럼 **중괄호 안만 해싱**하는 해시태그로 묶는다.

사전 준비: \`pnpm redis:cluster\`
`,
  code: `redis-cli -p 7001 CLUSTER INFO | head -3
redis-cli -p 7001 CLUSTER KEYSLOT user:1          # 10778
redis-cli -p 7001 CLUSTER KEYSLOT user:2          # 14916
redis-cli -p 7001 CLUSTER KEYSLOT {user:1}:orders # 10778 (user:1 과 같은 슬롯)
redis-cli -p 7001 SET user:1 a                    # (error) MOVED 10778 127.0.0.1:7002
redis-cli -p 7002 SET user:1 a                    # OK
redis-cli -c -p 7001 MGET user:1 user:2           # (error) CROSSSLOT
redis-cli -c -p 7001 MSET {user:1}:a 1 {user:1}:b 2   # OK`,
  requires: requiresCluster,
  async run({ rec, k }) {
    const n1 = createRedis({ port: CLUSTER_PORTS[0], host: "127.0.0.1" });
    const cluster = new Cluster([{ host: "127.0.0.1", port: CLUSTER_PORTS[0] }], { redisOptions: { connectTimeout: 2000 }, lazyConnect: true });
    cluster.on("error", () => {});
    const wrappedN1 = rec.wrap(n1, "node:7001");
    const wrappedCluster = rec.wrap(cluster as unknown as Redis, "cluster-client");
    try {
      await ensureConnected(n1);
      await cluster.connect();
      const info = parseInfo((await n1.cluster("INFO")) as string);
      rec.check("cluster_state ok, 노드 6개", info.cluster_state === "ok" && info.cluster_known_nodes === "6", `state=${info.cluster_state} nodes=${info.cluster_known_nodes} slots_ok=${info.cluster_slots_ok}`);
      const nodes = ((await n1.cluster("NODES")) as string).trim().split("\n");
      const masters = nodes.filter((l) => l.includes("master")).map((l) => l.split(" ")[1].split("@")[0]);
      rec.note(`마스터: ${masters.join(", ")} / 레플리카 ${nodes.length - masters.length}개`);

      const a = k("user:1");
      const b = k("user:2");
      const tagged = `{${a}}:orders`;
      const slotA = (await wrappedN1.cluster("KEYSLOT", a)) as number;
      const slotB = (await wrappedN1.cluster("KEYSLOT", b)) as number;
      const slotT = (await wrappedN1.cluster("KEYSLOT", tagged)) as number;
      rec.check("해시태그 {…} 안만 해싱되어 같은 슬롯", slotA === slotT, { slotA, slotT });

      rec.note("단순 클라이언트로 7001 에 보내면 슬롯 주인이 아닐 때 MOVED");
      let movedTo: string | null = null;
      try {
        await wrappedN1.set(a, "a");
        rec.note("7001 이 마침 이 슬롯의 주인이라 OK (다른 키로 재시도)");
      } catch (e) {
        const m = /MOVED (\d+) ([\d.]+:\d+)/.exec((e as Error).message);
        movedTo = m?.[2] ?? null;
        rec.check("MOVED 에러에 슬롯과 담당 노드가 들어 있다", !!m, (e as Error).message);
      }
      if (!movedTo) {
        try {
          await wrappedN1.set(b, "b");
        } catch (e) {
          const m = /MOVED (\d+) ([\d.]+:\d+)/.exec((e as Error).message);
          movedTo = m?.[2] ?? null;
          rec.check("MOVED 에러에 슬롯과 담당 노드가 들어 있다", !!m, (e as Error).message);
        }
      }
      if (movedTo) {
        const [host, port] = movedTo.split(":");
        const owner = createRedis({ host, port: Number(port) });
        try {
          await ensureConnected(owner);
          const r = await rec.wrap(owner, `node:${port}`).set(k("moved"), "ok-after-redirect");
          rec.note(`지시된 노드 ${movedTo} 에 직접 보내면 ${r}`);
        } catch {
          /* 키가 또 다른 슬롯일 수 있음 */
        } finally {
          owner.disconnect();
        }
      }

      rec.note("클러스터 클라이언트는 MOVED 를 알아서 처리한다");
      await wrappedCluster.set(a, "alice");
      await wrappedCluster.set(b, "bob");
      rec.check("여러 노드에 흩어진 키를 투명하게 읽는다", (await wrappedCluster.get(a)) === "alice" && (await wrappedCluster.get(b)) === "bob");

      try {
        await wrappedCluster.mget(a, b);
        rec.check("다른 슬롯 MGET 은 CROSSSLOT 이어야 한다", false);
      } catch (e) {
        rec.check("다른 슬롯의 다중 키 → CROSSSLOT", /CROSSSLOT/.test((e as Error).message), (e as Error).message);
      }
      await wrappedCluster.mset(`{${a}}:x`, 1, `{${a}}:y`, 2);
      const both = await wrappedCluster.mget(`{${a}}:x`, `{${a}}:y`);
      rec.check("해시태그로 같은 슬롯에 두면 다중 키 OK", both.join(",") === "1,2", both);
      await wrappedCluster.del(a, b, `{${a}}:x`, `{${a}}:y`, k("moved")).catch(() => {});
      await Promise.allSettled([cluster.del(k("moved")), cluster.del(a), cluster.del(b), cluster.del(`{${a}}:x`), cluster.del(`{${a}}:y`)]);
      void slotB;
    } finally {
      n1.disconnect();
      cluster.disconnect();
    }
  },
};
