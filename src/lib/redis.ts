import Redis, { type RedisOptions } from "ioredis";
import { isReadOnly, ReadOnlyError } from "./read-only";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const baseOptions: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 1500,
  retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
};

declare global {
  // Next.js dev 모드의 HMR 에서도 커넥션이 중복 생성되지 않도록 global 에 보관한다.
  var __redisClient: Redis | undefined;
  var __redisDisabledClient: Redis | undefined;
}

/**
 * 읽기 전용 공개판(STUDY_READ_ONLY=1)용: 절대 연결하지 않는 클라이언트.
 * connect() 가 즉시 실패하므로 명령은 enableOfflineQueue=false 에 따라 바로 거절되고, 소켓·타임아웃 대기가 없다.
 * 읽는 함수들은 이미 실패 시 빈 값을 돌려주도록 되어 있어 Redis 없는 배포에서도 페이지가 빠르게 뜬다.
 */
function disabledClient(): Redis {
  const client = new Redis(REDIS_URL, { ...baseOptions, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
  client.connect = () => Promise.reject(new ReadOnlyError("Redis 연결 안 함"));
  client.on("error", () => {});
  return client;
}

/** 애플리케이션 전역에서 공유하는 단일 커넥션 */
export function getRedis(): Redis {
  if (isReadOnly()) return (globalThis.__redisDisabledClient ??= disabledClient());
  if (!globalThis.__redisClient) {
    const client = new Redis(REDIS_URL, baseOptions);
    client.on("error", () => {
      /* 연결 실패는 호출 측에서 처리한다. 로그 폭주 방지. */
    });
    globalThis.__redisClient = client;
  }
  return globalThis.__redisClient;
}

/** Pub/Sub, 블로킹 명령, WATCH 경쟁 재현 등을 위해 별도 커넥션이 필요할 때 사용 */
export function createRedis(overrides: RedisOptions = {}): Redis {
  if (isReadOnly()) return disabledClient();
  // host/port/sentinels 를 직접 지정하면 REDIS_URL 대신 그 옵션으로 접속한다
  const client = overrides.host || overrides.port || overrides.sentinels ? new Redis({ ...baseOptions, ...overrides }) : new Redis(REDIS_URL, { ...baseOptions, ...overrides });
  client.on("error", () => {});
  return client;
}

export async function ensureConnected(client: Redis): Promise<void> {
  if (isReadOnly()) throw new ReadOnlyError("Redis 연결 안 함");
  if (client.status === "ready") return;
  if (client.status === "wait" || client.status === "end") {
    await client.connect();
    return;
  }
  // connecting / reconnecting 상태라면 ready 를 기다린다.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Redis 연결 대기 시간 초과")), 2000);
    client.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export interface RedisStatus {
  ok: boolean;
  url: string;
  error?: string;
  info?: {
    version: string;
    mode: string;
    uptimeSeconds: number;
    usedMemoryHuman: string;
    maxmemoryHuman: string;
    maxmemoryPolicy: string;
    connectedClients: number;
    totalCommands: number;
    keyspaceHits: number;
    keyspaceMisses: number;
    dbKeys: number;
    aofEnabled: boolean;
    rdbLastSave: number;
  };
}

function parseInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf(":");
    if (idx > 0) out[t.slice(0, idx)] = t.slice(idx + 1);
  }
  return out;
}

export async function getRedisStatus(): Promise<RedisStatus> {
  const client = getRedis();
  try {
    await ensureConnected(client);
    const [raw, dbsize] = await Promise.all([client.info(), client.dbsize()]);
    const info = parseInfo(raw);
    return {
      ok: true,
      url: REDIS_URL,
      info: {
        version: info.redis_version ?? "?",
        mode: info.redis_mode ?? "standalone",
        uptimeSeconds: Number(info.uptime_in_seconds ?? 0),
        usedMemoryHuman: info.used_memory_human ?? "?",
        maxmemoryHuman: info.maxmemory_human ?? "0B",
        maxmemoryPolicy: info.maxmemory_policy ?? "noeviction",
        connectedClients: Number(info.connected_clients ?? 0),
        totalCommands: Number(info.total_commands_processed ?? 0),
        keyspaceHits: Number(info.keyspace_hits ?? 0),
        keyspaceMisses: Number(info.keyspace_misses ?? 0),
        dbKeys: dbsize,
        aofEnabled: info.aof_enabled === "1",
        rdbLastSave: Number(info.rdb_last_save_time ?? 0),
      },
    };
  } catch (e) {
    return { ok: false, url: REDIS_URL, error: e instanceof Error ? e.message : String(e) };
  }
}
