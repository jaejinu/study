import type { Experiment } from "./types";

export const keyspaceNotifications: Experiment = {
  id: "keyspace-notifications",
  title: "Keyspace 알림: 키가 만료되는 순간을 구독하기",
  category: "메시징",
  summary: "notify-keyspace-events 를 켜고 __keyevent@0__:expired 채널로 만료 이벤트를 실시간 수신",
  notes: ["03-keys-expiration", "07-pubsub-streams"],
  description: `
Redis 는 키 변경·만료 이벤트를 Pub/Sub 채널로 내보낼 수 있다 (\`notify-keyspace-events\`). 기본은 꺼져 있다(성능).
- \`__keyevent@0__:expired\` : "어떤 키가" 만료됐는지 (키 이름이 메시지)
- \`__keyspace@0__:<key>\` : "이 키에" 무슨 일이 있었는지 (이벤트 이름이 메시지)

세션 만료 처리, 지연 작업 트리거에 쓰이지만 **Pub/Sub 이므로 구독 중이 아니면 유실**된다. 정확성이 필요하면 ZSET 지연 큐나 Stream 을 쓴다.
만료 이벤트는 키가 실제로 삭제되는 시점(lazy/active expiry)에 발행되므로 TTL 이 0 이 된 뒤 수백 ms 늦을 수 있다.
`,
  code: `CONFIG GET notify-keyspace-events
CONFIG SET notify-keyspace-events Ex        # E=keyevent 채널, x=expired 이벤트
# 커넥션 2
SUBSCRIBE __keyevent@0__:expired
# 커넥션 1
SET session:abc 1 PX 300
# ~300ms 후 구독 커넥션에: ["message","__keyevent@0__:expired","session:abc"]
CONFIG SET notify-keyspace-events ""        # 원복`,
  async run({ redis, rec, k, newClient }) {
    const prev = ((await redis.config("GET", "notify-keyspace-events")) as string[])[1] ?? "";
    await redis.config("SET", "notify-keyspace-events", "Ex");
    try {
      const sub = await newClient("subscriber");
      const received: { channel: string; message: string; at: number }[] = [];
      sub.on("message", (channel: string, message: string) => received.push({ channel, message, at: performance.now() }));
      await sub.subscribe("__keyevent@0__:expired");

      const key = k("session:abc");
      const t0 = performance.now();
      await redis.set(key, "1", "PX", 300);
      await rec.measure("만료 이벤트 대기 (최대 3초)", async () => {
        for (let i = 0; i < 60; i++) {
          const hit = received.find((r) => r.message === key);
          if (hit) return `${Math.round(hit.at - t0)}ms 뒤 수신 (TTL 300ms + 만료 스캔 지연)`;
          await rec.sleep(50);
        }
        throw new Error("만료 이벤트를 받지 못함");
      });
      rec.check("수신한 메시지가 만료된 키 이름", received.some((r) => r.channel === "__keyevent@0__:expired" && r.message === key), received);
      await sub.unsubscribe("__keyevent@0__:expired");
    } finally {
      await redis.config("SET", "notify-keyspace-events", prev);
    }
  },
};

export const cacheStampede: Experiment = {
  id: "cache-stampede",
  title: "Cache Stampede: 동시 미스 50건 vs 락으로 1건만 DB 조회",
  category: "패턴·활용",
  summary: "같은 키에 요청 50개가 동시에 미스되면 DB 호출이 50번. SET NX 락으로 한 요청만 적재하고 나머지는 캐시를 기다리게 한다",
  notes: ["08-caching-patterns", "09-distributed-lock"],
  description: `
인기 키가 만료되는 순간 수십 요청이 동시에 miss → 전부 DB 로 간다. 이것이 **stampede(thundering herd)**.

완화: miss 한 요청들 중 \`SET lock:key NX PX 2000\` 을 얻은 **하나만** DB 를 읽어 캐시에 넣고, 나머지는 짧게 기다렸다가 캐시를 다시 본다.
이 실험은 느린 DB(100ms) 를 흉내 내어 두 방식의 **DB 호출 수**와 전체 소요 시간을 비교한다. 개별 명령은 50×N 개라 기록하지 않고 요약만 남긴다.
`,
  code: `# 방식 1: 그냥 cache-aside — 50개 동시 요청이 모두 miss → DB 50회
# 방식 2: 락
GET product:1                       # miss
SET lock:product:1 <token> NX PX 2000
#   OK  → DB 조회 → SET product:1 ... EX 60 → DEL lock (토큰 검증)
#   nil → 20ms 대기 후 GET product:1 재시도 (캐시가 채워질 때까지)`,
  async run({ raw, rec, k }) {
    const N = 50;
    const key = k("product:1");
    let dbCalls = 0;
    const slowDb = async () => {
      dbCalls++;
      await new Promise((r) => setTimeout(r, 100));
      return JSON.stringify({ id: 1, name: "키보드", loadedAt: Date.now() });
    };

    rec.note(`방식 1: 락 없음 — ${N}개 동시 요청`);
    const naive = async () => {
      const hit = await raw.get(key);
      if (hit) return hit;
      const v = await slowDb();
      await raw.set(key, v, "EX", 60);
      return v;
    };
    dbCalls = 0;
    const t1 = await rec.measure(`${N}개 동시 getProduct (락 없음)`, async () => {
      await Promise.all(Array.from({ length: N }, naive));
      return `DB 호출 ${dbCalls}회`;
    });
    rec.check(`락 없음: DB 호출 ${dbCalls}회 (거의 전부 miss)`, dbCalls >= N * 0.8, dbCalls);
    await raw.del(key);

    rec.note(`방식 2: SET NX 락 — ${N}개 동시 요청`);
    const lockKey = k("lock:product:1");
    const withLock = async (): Promise<string> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const hit = await raw.get(key);
        if (hit) return hit;
        const token = `${process.pid}-${Math.random()}`;
        const got = await raw.set(lockKey, token, "PX", 2000, "NX");
        if (got === "OK") {
          try {
            const v = await slowDb();
            await raw.set(key, v, "EX", 60);
            return v;
          } finally {
            await raw.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`, 1, lockKey, token);
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("캐시가 채워지지 않음");
    };
    dbCalls = 0;
    const t2 = await rec.measure(`${N}개 동시 getProduct (락)`, async () => {
      await Promise.all(Array.from({ length: N }, withLock));
      return `DB 호출 ${dbCalls}회`;
    });
    rec.check(`락: DB 호출 ${dbCalls}회`, dbCalls <= 2, dbCalls);
    const ms1 = rec.steps.find((s) => s.cmd.includes("(락 없음)"))?.ms ?? 0;
    const ms2 = rec.steps.find((s) => s.cmd.includes("(락)"))?.ms ?? 0;
    rec.note(`소요 시간: 락 없음 ${ms1}ms vs 락 ${ms2}ms — DB 부하는 ${N}배 차이, 지연은 비슷하다 (모두 1회 DB 조회 시간을 기다리므로)`);
    void t1;
    void t2;
    await raw.del(key, lockKey);
  },
};
