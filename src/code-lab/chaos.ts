import { Client } from "pg";
import { Kafka, logLevel } from "kafkajs";
import { createRedis, ensureConnected, getRedis } from "@/lib/redis";
import { exec } from "@/shell-lab/runner";
import { KAFKA_BROKERS } from "./kafka";
import { PG_URL } from "./postgres";
import type { CodeExperiment } from "./types";

/** 장애 주입 실험: 실제 컨테이너를 멈추거나 자원을 고갈시키고, 앱 쪽 복원력 패턴이 어떻게 동작하는지 측정한다. */

async function containerRunning(name: string): Promise<boolean> {
  const r = await exec("docker", ["inspect", "-f", "{{.State.Status}}", name], { timeout: 5000 });
  return r.ok && r.out === "running";
}

export const chaosRedisHang: CodeExperiment = {
  id: "chaos-redis-hang",
  subject: "chaos",
  title: "Redis 가 멈추면(hang) 앱은? — 타임아웃·fail-open 캐시·자동 재연결",
  category: "의존성 장애",
  summary: "docker pause 로 Redis 를 얼린 뒤 commandTimeout 이 있는 클라이언트와 없는 클라이언트의 차이, 캐시 fail-open 폴백, unpause 후 재연결 시간을 측정",
  notes: ["01-chaos-principles", "02-failure-catalog"],
  description: `
가장 흔하고 까다로운 장애는 "죽음" 이 아니라 **멈춤(hang)** 이다. 연결은 살아 있어 TCP 는 정상인데 응답이 없다.
- 타임아웃이 없는 클라이언트는 영원히 기다린다 → 이벤트 루프·스레드 고갈 → 앱 전체 장애.
- \`commandTimeout\` 을 둔 클라이언트는 N ms 뒤 에러 → 캐시 용도면 DB 로 폴백(fail-open).
이 실험은 study-redis 컨테이너를 SIGSTOP 으로 얼리고(docker pause) 두 클라이언트의 동작과 복구 시간을 잰다. 사전 준비: Docker 의 study-redis (\`pnpm redis:docker\`).
`,
  code: `docker pause study-redis
redis-cli -p 6379 ping              # 응답 없음 (연결은 됨)
# 앱: commandTimeout 300ms 클라이언트 → 300ms 후 "Command timed out" → DB 폴백
# 앱: 타임아웃 없는 클라이언트 → 무한 대기 (이 실험은 2초에서 포기)
docker unpause study-redis
redis-cli ping                      # PONG — ioredis 는 끊김 없이 바로 재사용`,
  requires: async () => ((await containerRunning("study-redis")) ? null : "Docker 의 study-redis 컨테이너가 실행 중이어야 합니다 (`pnpm redis:docker`). 이 실험은 그 컨테이너를 약 3초 멈춥니다."),
  async run({ rec }) {
    const withTimeout = createRedis({ host: "127.0.0.1", port: 6379, commandTimeout: 300, enableOfflineQueue: false });
    const noTimeout = createRedis({ host: "127.0.0.1", port: 6379, enableOfflineQueue: false });
    await ensureConnected(withTimeout);
    await ensureConnected(noTimeout);
    let dbCalls = 0;
    const fakeDb = async () => {
      dbCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return "from-db";
    };
    const cachedGet = async (client: typeof withTimeout) => {
      try {
        const v = await client.get("chaos:key");
        if (v) return "from-cache";
      } catch {
        /* fail-open */
      }
      return fakeDb();
    };
    await withTimeout.set("chaos:key", "v", "EX", 60);
    rec.check("정상 상태: 캐시 히트", (await cachedGet(withTimeout)) === "from-cache");

    rec.note("Redis 를 얼린다 (docker pause)");
    await exec("docker", ["pause", "study-redis"]);
    try {
      const t0 = performance.now();
      const r1 = await cachedGet(withTimeout);
      const ms1 = Math.round(performance.now() - t0);
      rec.steps.push({ cmd: "commandTimeout=300ms 클라이언트로 cachedGet()", result: `${r1} (${ms1}ms, DB 폴백)`, ms: ms1 });
      rec.check("타임아웃 후 DB 로 폴백 (fail-open), 약 300ms", r1 === "from-db" && ms1 >= 280 && ms1 < 1500, ms1);

      const t1 = performance.now();
      const r2 = await Promise.race([noTimeout.get("chaos:key").then(() => "answered"), new Promise<string>((r) => setTimeout(() => r("still-waiting"), 2000))]);
      const ms2 = Math.round(performance.now() - t1);
      rec.steps.push({ cmd: "타임아웃 없는 클라이언트로 GET (2초 상한)", result: `${r2} (${ms2}ms)`, ms: ms2 });
      rec.check("타임아웃이 없으면 영원히 기다린다 — 요청이 쌓이면 앱이 멈춘다", r2 === "still-waiting");

      rec.note("동시에 20 요청이 오면? 타임아웃 클라이언트는 전부 300ms 안에 폴백한다");
      dbCalls = 0;
      const t2 = performance.now();
      await Promise.all(Array.from({ length: 20 }, () => cachedGet(withTimeout)));
      const ms3 = Math.round(performance.now() - t2);
      rec.steps.push({ cmd: "20개 동시 cachedGet (Redis 멈춤 중)", result: `모두 완료 ${ms3}ms, DB 호출 ${dbCalls}회`, ms: ms3 });
      rec.check("전체가 약 300~400ms 에 끝남 (직렬 대기 아님)", ms3 < 1200, ms3);
    } finally {
      await exec("docker", ["unpause", "study-redis"]);
    }
    rec.note("복구: unpause 후 재연결/재사용 시간");
    const t3 = performance.now();
    let recovered = false;
    for (let i = 0; i < 50 && !recovered; i++) {
      try {
        recovered = (await withTimeout.ping()) === "PONG";
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const ms4 = Math.round(performance.now() - t3);
    rec.check(`복구 후 PONG 까지 ${ms4}ms (연결이 끊긴 게 아니라 멈춘 것이라 거의 즉시)`, recovered && ms4 < 3000, ms4);
    rec.note("교훈: 모든 외부 호출에 타임아웃. 캐시는 fail-open, 락/결제는 fail-closed 로 정책을 정한다 (Redis 클라이언트 설계 노트).");
    withTimeout.disconnect();
    noTimeout.disconnect();
    await getRedis().del("chaos:key").catch(() => {});
  },
};

export const chaosRedisOom: CodeExperiment = {
  id: "chaos-redis-oom",
  subject: "chaos",
  title: "Redis 메모리가 꽉 차면? — noeviction 의 OOM 에러 vs allkeys-lru 의 조용한 축출",
  category: "자원 고갈",
  summary: "maxmemory 를 아주 작게 줄이고 두 정책에서 쓰기가 어떻게 실패/성공하는지, evicted_keys 가 어떻게 늘어나는지 관찰한 뒤 설정을 원복",
  notes: ["02-failure-catalog"],
  description: `
메모리 한도에 닿았을 때 Redis 의 행동은 \`maxmemory-policy\` 가 정한다.
- \`noeviction\`: 쓰기 명령이 **OOM 에러**. 앱이 에러를 처리하지 않으면 전부 500.
- \`allkeys-lru\`: 오래 안 쓴 키를 **조용히** 지운다. 캐시엔 맞지만, 세션·락이 사라지면 "로그아웃됨/락 유실" 같은 이상한 장애로 나타난다.
같은 인스턴스에 캐시와 중요 데이터를 섞으면 안 되는 이유. 사전 준비: Docker 의 study-redis. 설정은 실험 후 원복한다.
`,
  code: `CONFIG GET maxmemory maxmemory-policy
CONFIG SET maxmemory 2mb
CONFIG SET maxmemory-policy noeviction
SET big <1MB> …                      # (error) OOM command not allowed when used memory > 'maxmemory'
CONFIG SET maxmemory-policy allkeys-lru
SET big <1MB> …                      # OK — 대신 다른 키가 사라진다 (INFO stats evicted_keys)
CONFIG SET maxmemory 256mb ; CONFIG SET maxmemory-policy allkeys-lru`,
  requires: async () => ((await containerRunning("study-redis")) ? null : "Docker 의 study-redis 컨테이너가 필요합니다 (`pnpm redis:docker`)."),
  async run({ rec, k }) {
    const r = getRedis();
    await ensureConnected(r);
    const [, origMax] = (await r.config("GET", "maxmemory")) as string[];
    const [, origPolicy] = (await r.config("GET", "maxmemory-policy")) as string[];
    rec.note(`현재 설정: maxmemory=${origMax} policy=${origPolicy} (실험 후 원복)`);
    const used = Number(((await r.info("memory")).match(/used_memory:(\d+)/) ?? [])[1] ?? 0);
    const limit = used + 2 * 1024 * 1024;
    try {
      await r.config("SET", "maxmemory", String(limit));
      await r.config("SET", "maxmemory-policy", "noeviction");
      rec.steps.push({ cmd: `CONFIG SET maxmemory ${limit} (현재 사용량 + 2MB) · policy noeviction`, result: "OK", ms: 0 });
      const payload = "x".repeat(512 * 1024);
      let oomAt = -1;
      for (let i = 0; i < 20; i++) {
        try {
          await r.set(k(`fill:${i}`), payload);
        } catch (e) {
          oomAt = i;
          rec.steps.push({ cmd: `SET fill:${i} <512KB>`, result: (e as Error).message, ms: 0, error: true });
          break;
        }
      }
      rec.check("noeviction: 한도에 닿자 OOM 에러로 쓰기가 거부된다", oomAt >= 0, { oomAt });

      const ev0 = Number(((await r.info("stats")).match(/evicted_keys:(\d+)/) ?? [])[1] ?? 0);
      await r.config("SET", "maxmemory-policy", "allkeys-lru");
      let ok = 0;
      for (let i = 20; i < 30; i++) {
        await r.set(k(`fill:${i}`), payload);
        ok++;
      }
      const ev1 = Number(((await r.info("stats")).match(/evicted_keys:(\d+)/) ?? [])[1] ?? 0);
      rec.steps.push({ cmd: "CONFIG SET maxmemory-policy allkeys-lru 후 SET ×10", result: `모두 OK, evicted_keys ${ev0} → ${ev1}`, ms: 0 });
      rec.check("allkeys-lru: 쓰기는 성공하지만 다른 키가 축출된다", ok === 10 && ev1 > ev0, { evicted: ev1 - ev0 });
      const survivors = (await Promise.all(Array.from({ length: 10 }, (_, i) => r.exists(k(`fill:${i}`))))).reduce((a, b) => a + b, 0);
      rec.note(`처음 넣은 fill:0~9 중 남은 것 ${survivors}/10 — 세션 키였다면 사용자가 로그아웃된 것`);
      rec.note("모니터 페이지와 Grafana 의 evicted_keys, 알림 규칙 RedisEvictions(warning) 이 이 상황을 잡는다");
    } finally {
      await r.config("SET", "maxmemory", origMax);
      await r.config("SET", "maxmemory-policy", origPolicy);
      rec.steps.push({ cmd: `원복: maxmemory ${origMax}, policy ${origPolicy}`, result: "OK", ms: 0 });
      let cursor = "0";
      do {
        const [next, keys] = await r.scan(cursor, "MATCH", k("fill:*"), "COUNT", 100);
        cursor = next;
        if (keys.length) await r.del(...keys);
      } while (cursor !== "0");
    }
  },
};

export const chaosKafkaBroker: CodeExperiment = {
  id: "chaos-kafka-broker-restart",
  subject: "chaos",
  title: "Kafka 브로커가 재시작되면? — 프로듀서 재시도·버퍼링과 복구 후 전달",
  category: "의존성 장애",
  summary: "브로커를 docker stop 한 상태에서 send() 가 어떻게 실패/대기하는지, start 후 재시도가 성공하는지, 컨슈머가 메시지를 받는지 측정",
  notes: ["02-failure-catalog"],
  description: `
브로커 재시작(배포·패치)은 흔하다. 프로듀서는 \`retries\`·\`retry.backoff\`·\`delivery.timeout\` 안에서 재시도하고, 그 밖이면 에러를 호출자에게 돌려준다.
앱은 (1) 에러를 삼키지 말고 (2) 멱등 키로 재시도하거나 (3) 로컬 버퍼/outbox 로 나중에 보내야 한다.
이 실험은 단일 브로커를 약 20초 멈춘다 — 멀티 브로커 운영에선 리더 재선출로 대부분 투명하게 넘어간다. 사전 준비: \`pnpm kafka:up\`.
`,
  code: `docker stop study-kafka
# producer.send() → 재시도 … → KafkaJSNumberOfRetriesExceeded (약 10초)
docker start study-kafka              # 30초쯤 걸려 healthy
# producer.send() → OK, 컨슈머가 수신`,
  requires: async () => ((await containerRunning("study-kafka")) ? null : "Docker 의 study-kafka 컨테이너가 실행 중이어야 합니다 (`pnpm kafka:up`). 이 실험은 브로커를 약 20초 정지합니다."),
  async run({ rec, k }) {
    const topic = k("events").replace(/_/g, ".");
    const kafka = new Kafka({ clientId: "chaos", brokers: KAFKA_BROKERS, logLevel: logLevel.NOTHING, retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 2000 } });
    const admin = kafka.admin();
    const producer = kafka.producer({ retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 2000 } });
    const consumer = kafka.consumer({ groupId: `${topic}-g` });
    try {
      await admin.connect();
      await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true }).catch(() => {});
      await producer.connect();
      await producer.send({ topic, messages: [{ value: "before" }] });
      rec.steps.push({ cmd: "정상 상태 send('before')", result: "OK", ms: 0 });

      rec.note("브로커 정지 (docker stop)");
      await exec("docker", ["stop", "study-kafka"], { timeout: 60_000 });
      const t0 = performance.now();
      let err = "";
      try {
        await producer.send({ topic, messages: [{ value: "during" }] });
      } catch (e) {
        err = (e as Error).message;
      }
      const ms = Math.round(performance.now() - t0);
      rec.steps.push({ cmd: "send('during') (브로커 다운, retries=3)", result: err || "OK?", ms, error: !!err });
      rec.check(`재시도 후 에러로 호출자에게 돌아온다 (${ms}ms)`, !!err, err.slice(0, 120));
      rec.note("이 에러를 어떻게 다룰지가 설계다: 큐에 보관(outbox), 사용자에게 503, 또는 일시 저장 후 재전송");

      rec.note("브로커 시작 (docker start) — healthy 까지 대기");
      await exec("docker", ["start", "study-kafka"], { timeout: 60_000 });
      const t1 = performance.now();
      for (let i = 0; i < 60; i++) {
        const h = await exec("docker", ["inspect", "-f", "{{.State.Health.Status}}", "study-kafka"]);
        if (h.out === "healthy") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      rec.steps.push({ cmd: "브로커 healthy 대기", result: `${Math.round((performance.now() - t1) / 1000)}s`, ms: Math.round(performance.now() - t1) });
      let sent = false;
      for (let i = 0; i < 10 && !sent; i++) {
        try {
          await producer.send({ topic, messages: [{ value: "after" }] });
          sent = true;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      rec.check("복구 후 send('after') 성공 (같은 프로듀서 객체가 재연결)", sent);

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });
      const got: string[] = [];
      await consumer.run({ eachMessage: async ({ message }) => void got.push(message.value?.toString() ?? "") });
      for (let i = 0; i < 30 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 500));
      rec.check("컨슈머는 before, after 만 받는다 — during 은 유실 (보내지 못했으므로)", got.includes("before") && got.includes("after") && !got.includes("during"), got);
      rec.note("교훈: 실패한 send 는 '안 보낸 것'. at-least-once 를 원하면 호출자가 재시도·outbox 로 책임진다.");
    } finally {
      await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.disconnect().catch(() => {});
      await exec("docker", ["start", "study-kafka"], { timeout: 60_000 });
    }
  },
};

export const chaosPgConnections: CodeExperiment = {
  id: "chaos-pg-connection-exhaustion",
  subject: "chaos",
  title: "PostgreSQL 커넥션이 고갈되면? — too many connections 와 풀 크기의 의미",
  category: "자원 고갈",
  summary: "max_connections 까지 커넥션을 열어 새 연결이 거부되는 순간을 만들고, pg_stat_activity 로 상태를 보고, 풀 크기·PgBouncer 가 왜 필요한지 확인",
  notes: ["02-failure-catalog"],
  description: `
앱 인스턴스 10대 × 풀 20 = 200 커넥션. PostgreSQL 기본 \`max_connections=100\` 이면 배포 중 새 Pod 이 뜨는 순간 **too many connections** 가 난다.
이 실험은 한도까지 연결을 열어 거부를 재현한다. 연결마다 백엔드 프로세스(수 MB)가 생기므로 커넥션 폭증은 메모리 장애로도 이어진다. 사전 준비: \`pnpm pg:up\`.
`,
  code: `SHOW max_connections;                        -- 100
SELECT count(*) FROM pg_stat_activity;
-- 커넥션을 98개 열면: FATAL: sorry, too many clients already (superuser 예약 3개 제외)
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;
-- 해법: 앱 풀 크기 축소, PgBouncer(transaction 모드), idle_in_transaction_session_timeout`,
  requires: async () => {
    const c = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 3000 });
    try {
      await c.connect();
      return null;
    } catch {
      return "PostgreSQL 에 연결할 수 없습니다 (`pnpm pg:up`).";
    } finally {
      await c.end().catch(() => {});
    }
  },
  async run({ rec }) {
    const probe = new Client({ connectionString: PG_URL });
    await probe.connect();
    const max = Number((await probe.query("show max_connections")).rows[0].max_connections);
    const reserved = Number((await probe.query("show superuser_reserved_connections")).rows[0].superuser_reserved_connections);
    const current = Number((await probe.query("select count(*)::int c from pg_stat_activity where backend_type = 'client backend'")).rows[0].c);
    rec.note(`max_connections=${max}, superuser_reserved=${reserved}, 현재 클라이언트 연결 ${current}`);
    const clients: Client[] = [];
    let rejectedAt = -1;
    let errMsg = "";
    try {
      const t0 = performance.now();
      for (let i = 0; i < max + 5; i++) {
        const c = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 5000 });
        try {
          await c.connect();
          clients.push(c);
        } catch (e) {
          rejectedAt = i;
          errMsg = (e as Error).message;
          break;
        }
      }
      const ms = Math.round(performance.now() - t0);
      rec.steps.push({ cmd: `커넥션을 계속 연다 (${ms}ms)`, result: `${clients.length}개 성공 후 ${rejectedAt + 1}번째 거부: ${errMsg}`, ms, error: true });
      rec.check("한도 근처에서 거부된다 (study 는 superuser 라 예약분까지 쓸 수 있음)", /too many/i.test(errMsg) || /remaining connection slots/i.test(errMsg), errMsg);
      const states = (await probe.query("select coalesce(state,'(none)') state, count(*)::int n from pg_stat_activity where backend_type='client backend' group by 1 order by 2 desc")).rows;
      rec.steps.push({ cmd: "pg_stat_activity 상태별 집계", result: states, ms: 0 });
      rec.check("대부분 idle — 열어 두고 안 쓰는 연결이 자원을 먹는다", states.some((s: { state: string; n: number }) => s.state === "idle" && s.n > max * 0.8));
      const mem = (await probe.query("select pg_size_pretty(sum(pg_total_relation_size(oid))) s from pg_class")).rows[0].s;
      void mem;
      rec.note("각 연결은 백엔드 프로세스(수 MB). 100개 ≈ 수백 MB. PgBouncer 는 수천 클라이언트를 수십 서버 연결로 다중화한다.");
    } finally {
      await Promise.allSettled(clients.map((c) => c.end()));
    }
    const after = Number((await probe.query("select count(*)::int c from pg_stat_activity where backend_type = 'client backend'")).rows[0].c);
    rec.check(`정리 후 연결 ${after}개 (원래 수준)`, after <= current + 2, after);
    rec.note("앱 측 처방: 풀 크기 = 코어×2~4, 인스턴스 수 × 풀 ≤ max_connections × 0.8, idle_in_transaction_session_timeout, 배포 시 순차 기동");
    await probe.end();
  },
};

export const chaosK8sPodKill: CodeExperiment = {
  id: "chaos-k8s-pod-kill-under-load",
  subject: "chaos",
  title: "트래픽 중에 Pod 을 죽이면? — 복제본 2개 + readiness 가 지키는 가용성",
  category: "인프라 장애",
  summary: "클러스터 안에서 web 서비스에 0.5초 간격으로 요청을 보내는 동안 web Pod 하나를 강제 삭제하고, 실패 요청 수를 센다",
  notes: ["02-failure-catalog"],
  description: `
Kubernetes 의 자가 치유는 "Pod 이 다시 뜬다" 지 "요청이 안 깨진다" 가 아니다. 요청이 안 깨지려면 (1) 복제본 ≥ 2, (2) readinessProbe 로 준비된 Pod 에만 트래픽, (3) graceful 종료(SIGTERM 처리 + preStop) 가 필요하다.
이 실험은 study 네임스페이스의 web(복제본 2)에 부하를 걸고 Pod 하나를 \`--grace-period=0\` 으로 죽인다. 사전 준비: kind 에 web 배포(\`pnpm k8s:up\`).
`,
  code: `kubectl -n study run lab-load --image=curlimages/curl --restart=Never -- sh -c 'for i in $(seq 1 60); do curl -s -o /dev/null -w "%{http_code}\\n" http://web:3000/api/metrics; sleep 0.5; done'
kubectl -n study delete pod -l app=web --field-selector=... --grace-period=0 --force     # 하나만
kubectl -n study logs lab-load | sort | uniq -c       # 200 이 몇 개, 000/5xx 가 몇 개`,
  requires: async () => {
    const r = await exec("kubectl", ["-n", "study", "get", "deploy", "web", "-o", "jsonpath={.status.readyReplicas}", "--request-timeout=5s"], { timeout: 8000 });
    if (!r.ok) return "kind 클러스터와 study/web Deployment 가 필요합니다 (`pnpm k8s:cluster`, `pnpm docker:build && pnpm k8s:load && pnpm k8s:up`). 현재 컨텍스트를 kind-study 로.";
    if (Number(r.out) < 2) return `web 의 Ready 복제본이 ${r.out || 0}개입니다. 2개 이상이어야 합니다 (kubectl -n study scale deploy/web --replicas=2).`;
    return null;
  },
  async run({ rec }) {
    const K = (...a: string[]) => ["-n", "study", ...a];
    await exec("kubectl", K("delete", "pod", "lab-load", "--ignore-not-found", "--grace-period=0", "--force"));
    await exec("kubectl", K("run", "lab-load", "--image=curlimages/curl:8.10.1", "--restart=Never", "--labels=lab=true", "--", "sh", "-c", 'for i in $(seq 1 60); do curl -s -o /dev/null -m 2 -w "%{http_code}\\n" http://web:3000/api/metrics; sleep 0.5; done'));
    rec.steps.push({ cmd: "부하 Pod 시작: 30초간 0.5초 간격 60 요청 → web:3000/api/metrics", result: "started", ms: 0 });
    await new Promise((r) => setTimeout(r, 6000));
    const pods = (await exec("kubectl", K("get", "pods", "-l", "app=web", "-o", "jsonpath={.items[*].metadata.name}"))).out.split(/\s+/).filter(Boolean);
    const victim = pods[0];
    const t0 = performance.now();
    await exec("kubectl", K("delete", "pod", victim, "--grace-period=0", "--force"));
    rec.steps.push({ cmd: `kubectl delete pod ${victim} --grace-period=0 --force (트래픽 중)`, result: "deleted", ms: 0 });
    let ready = 0;
    for (let i = 0; i < 60; i++) {
      const r = await exec("kubectl", K("get", "deploy", "web", "-o", "jsonpath={.status.readyReplicas}"));
      ready = Number(r.out || 0);
      if (ready >= 2) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    rec.steps.push({ cmd: "새 Pod 이 Ready 2/2 가 될 때까지", result: `${Math.round((performance.now() - t0) / 1000)}s`, ms: Math.round(performance.now() - t0) });
    for (let i = 0; i < 40; i++) {
      const ph = await exec("kubectl", K("get", "pod", "lab-load", "-o", "jsonpath={.status.phase}"));
      if (ph.out === "Succeeded" || ph.out === "Failed") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const logs = (await exec("kubectl", K("logs", "lab-load"))).out.split("\n").filter(Boolean);
    const counts: Record<string, number> = {};
    for (const l of logs) counts[l] = (counts[l] ?? 0) + 1;
    rec.steps.push({ cmd: "부하 Pod 로그 집계 (HTTP 코드별)", result: counts, ms: 0 });
    const ok = counts["200"] ?? 0;
    const bad = logs.length - ok;
    rec.check(`${logs.length}요청 중 성공 ${ok}, 실패 ${bad} — 복제본 2 + readiness 덕분에 대부분 유지`, logs.length >= 50 && ok / logs.length >= 0.9, { ok, bad });
    rec.note(bad > 0 ? `실패 ${bad}건은 Service endpoints 갱신과 kube-proxy 규칙 반영 사이의 창. preStop sleep 과 terminationGracePeriod 로 줄인다.` : "실패 0 — 삭제 순간 요청이 다른 Pod 으로 갔다.");
    await exec("kubectl", K("delete", "pod", "lab-load", "--ignore-not-found", "--grace-period=0", "--force"));
  },
};

// ---------------------------------------------------------------- 서킷 브레이커
type BreakerState = "closed" | "open" | "half-open";

/** 교과서적 서킷 브레이커: 연속 실패 N 회 → open(fail-fast) → openMs 뒤 half-open(1회 시도) → 성공이면 closed */
class CircuitBreaker {
  state: BreakerState = "closed";
  failures = 0;
  openedAt = 0;
  transitions: { at: number; from: BreakerState; to: BreakerState; why: string }[] = [];
  constructor(private threshold: number, private openMs: number, private t0 = performance.now()) {}
  private go(to: BreakerState, why: string) {
    if (to === this.state) return;
    this.transitions.push({ at: Math.round(performance.now() - this.t0), from: this.state, to, why });
    this.state = to;
  }
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (performance.now() - this.openedAt >= this.openMs) this.go("half-open", `open 유지 ${this.openMs}ms 경과 → 시험 호출 1회 허용`);
      else throw new Error("circuit open (fail-fast)");
    }
    try {
      const r = await fn();
      this.failures = 0;
      if (this.state === "half-open") this.go("closed", "시험 호출 성공");
      return r;
    } catch (e) {
      this.failures++;
      if (this.state === "half-open") {
        this.openedAt = performance.now();
        this.go("open", "시험 호출 실패 → 다시 open");
      } else if (this.failures >= this.threshold) {
        this.openedAt = performance.now();
        this.go("open", `연속 실패 ${this.failures}회 ≥ 임계 ${this.threshold}`);
      }
      throw e;
    }
  }
}

export const chaosCircuitBreaker: CodeExperiment = {
  id: "chaos-circuit-breaker",
  subject: "chaos",
  title: "서킷 브레이커: Redis 가 멈추면 open 으로 끊어 fail-fast, 살아나면 half-open 시험 후 closed",
  category: "복원력 패턴",
  summary: "commandTimeout 300ms 의 ioredis 호출을 서킷 브레이커로 감싸고 study-redis 를 docker pause. 연속 실패 3회에 open 되어 이후 호출이 0ms 에 거부되는 것(타임아웃을 기다리지 않음), unpause 뒤 half-open 시험 호출로 closed 복귀까지의 상태 전이 타임라인을 기록",
  notes: ["03-resilience-patterns-verified", "02-failure-catalog"],
  description: `
타임아웃만 있으면 장애 중 **모든 요청이 타임아웃만큼 기다린다**. 300ms × 요청 수가 그대로 지연이 되고, 멈춘 의존성에 계속 부하를 준다.
서킷 브레이커는 "이미 죽은 걸 안다" 를 상태로 기억해 **즉시 거부(fail-fast)** 하고, 일정 시간 뒤 **시험 호출 한 번**으로 복구를 감지한다. 상태 머신은 세 개: closed(정상) → open(차단) → half-open(시험).
이 실험은 그 전이를 실제 Redis 멈춤으로 만들어 타임라인으로 보여 준다. 사전 준비: Docker 의 study-redis.
`,
  code: `// closed: 호출 통과, 실패 카운트
// open:   즉시 throw (의존성에 요청 안 보냄), openMs 뒤 half-open
// half-open: 1회 시험 → 성공 closed / 실패 open
const breaker = new CircuitBreaker({ threshold: 3, openMs: 2000 });
await breaker.call(() => redis.get("k"));   // Redis 멈춤 중: 1~3회는 300ms 타임아웃, 4회부터 0ms 거부
docker pause study-redis / docker unpause study-redis`,
  requires: async () => ((await containerRunning("study-redis")) ? null : "Docker 의 study-redis 컨테이너가 실행 중이어야 합니다 (`pnpm redis:docker`). 이 실험은 그 컨테이너를 약 4초 멈춥니다."),
  async run({ rec }) {
    const redis = createRedis({ host: "127.0.0.1", port: 6379, commandTimeout: 300, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    await ensureConnected(redis);
    const breaker = new CircuitBreaker(3, 2000);
    const attempt = async (label: string) => {
      const t = performance.now();
      try {
        await breaker.call(() => redis.get("chaos:cb"));
        return { label, ok: true, ms: Math.round(performance.now() - t), state: breaker.state };
      } catch (e) {
        return { label, ok: false, ms: Math.round(performance.now() - t), state: breaker.state, err: (e as Error).message.slice(0, 40) };
      }
    };
    await redis.set("chaos:cb", "1", "EX", 60);
    rec.check("정상: closed 상태에서 호출 성공", (await attempt("정상")).ok);

    rec.note("Redis 를 얼린다 (docker pause). 타임아웃 300ms 인 호출이 연속 실패한다");
    const rows: { label: string; ok: boolean; ms: number; state: string; err?: string }[] = [];
    try {
      await exec("docker", ["pause", "study-redis"]);
      for (let i = 1; i <= 6; i++) rows.push(await attempt(`멈춤 중 #${i}`));
      const slow = rows.slice(0, 3), fast = rows.slice(3);
      rec.steps.push({ cmd: "멈춤 중 호출 6회 (지연 ms / 상태)", result: rows.map((r) => `${r.label}: ${r.ms}ms ${r.state}${r.err ? ` (${r.err})` : ""}`), ms: 0 });
      rec.check("처음 3회는 타임아웃(≈300ms)을 기다렸다", slow.every((r) => !r.ok && r.ms >= 250));
      rec.check("4회째부터 open — 거의 0ms 에 fail-fast (Redis 에 요청을 보내지 않음)", fast.every((r) => !r.ok && r.ms < 20 && r.state === "open"), fast.map((r) => r.ms));
      const tOpen = performance.now();
      const burst = await Promise.all(Array.from({ length: 50 }, () => attempt("burst")));
      const burstMs = Math.round(performance.now() - tOpen);
      rec.steps.push({ cmd: "open 상태에서 50개 동시 호출", result: `${burstMs}ms 에 전부 거부 — 타임아웃만 있었다면 ≥300ms + 멈춘 Redis 에 50 요청 적재`, ms: burstMs });
      rec.check("open 중 50 요청이 수십 ms 안에 끝난다", burstMs < 100 && burst.every((b) => !b.ok));
      await new Promise((r) => setTimeout(r, 2100));
      const trial = await attempt("open 2초 경과 후 시험 호출 (Redis 아직 멈춤)");
      rec.steps.push({ cmd: trial.label, result: `${trial.ms}ms → ${trial.state} (${trial.err})`, ms: trial.ms });
      rec.check("half-open 시험 호출이 실패하면 다시 open", trial.state === "open" && !trial.ok);
    } finally {
      await exec("docker", ["unpause", "study-redis"]);
    }
    rec.note("Redis 복구(unpause). 다음 시험 호출이 성공하면 closed 로 돌아온다");
    await new Promise((r) => setTimeout(r, 2100));
    const recover = await attempt("복구 후 시험 호출");
    rec.steps.push({ cmd: recover.label, result: `${recover.ms}ms → ${recover.state}`, ms: recover.ms });
    rec.check("half-open 시험 성공 → closed", recover.ok && breaker.state === "closed");
    rec.check("이후 호출은 정상 통과", (await attempt("정상 복귀")).ok);
    rec.steps.push({ cmd: "상태 전이 타임라인 (ms, from → to, 이유)", result: breaker.transitions.map((t) => `${t.at}ms ${t.from} → ${t.to}: ${t.why}`), ms: 0 });
    rec.check("전이 순서: closed→open→half-open→open→half-open→closed", breaker.transitions.map((t) => t.to).join(",") === "open,half-open,open,half-open,closed", breaker.transitions.map((t) => t.to));
    rec.note("실무 포인트: 임계는 '연속 실패' 보다 '최근 N초 실패율' 이 낫다(간헐 실패에 과민하지 않음). open 중엔 폴백(캐시된 값·기본값·빈 결과)을 돌려주고, 상태 전이를 메트릭(circuit_state)으로 내보내 대시보드·알림에 쓴다. opossum·resilience4j 가 이 상태 머신을 구현한다.");
    redis.disconnect();
    await getRedis().del("chaos:cb").catch(() => {});
  },
};

// ---------------------------------------------------------------- 재시도 폭풍
export const chaosRetryStorm: CodeExperiment = {
  id: "chaos-retry-storm",
  subject: "chaos",
  title: "재시도 폭풍: 백오프 없는 즉시 재시도 vs 지수 백오프+지터 — 장애 중 Redis 가 받는 요청 수",
  category: "복원력 패턴",
  summary: "Redis 가 멈춘(docker pause) 3초 동안 30개 클라이언트가 각각 실패하면 바로 재시도(성공할 때까지, 최대 60회)하는 경우와 지수 백오프+풀 지터로 재시도하는 경우의 총 시도 횟수·초당 최대 시도·복구 직후 동시 도착(thundering herd)을 비교한다. 시도는 commandTimeout 100ms 의 실제 ioredis 호출",
  notes: ["03-resilience-patterns-verified", "02-failure-catalog"],
  description: `
재시도는 **일시적** 실패를 숨기는 도구다. 하지만 의존성이 **정말** 죽었을 때 모두가 즉시 재시도하면 요청이 N×재시도 배로 불어나 복구 중인 시스템을 다시 눕힌다 — **재시도 폭풍**. 그리고 같은 간격으로 재시도하면 복구 순간 모두가 **동시에** 몰린다(thundering herd).
처방은 **지수 백오프 + 지터**(간격을 늘리고 무작위로 흩뿌림) 와 **재시도 예산**(전체 트래픽의 10% 이상이면 재시도 중단). 이 실험은 둘을 같은 장애에 걸어 숫자로 비교한다. 사전 준비: Docker 의 study-redis.
`,
  code: `// A: 즉시 재시도           for (i<60) { try { await redis.get(k); break } catch { /* 바로 다시 */ } }
// B: 지수 백오프 + 풀 지터   delay = random(0, min(cap, base * 2^attempt))
docker pause study-redis   # 3초
docker unpause study-redis
# 비교: 총 시도 수, 초당 피크 시도, 복구 후 1초 안에 몰린 시도 수`,
  requires: async () => ((await containerRunning("study-redis")) ? null : "Docker 의 study-redis 컨테이너가 실행 중이어야 합니다 (`pnpm redis:docker`). 이 실험은 그 컨테이너를 두 번, 각 3초 멈춥니다."),
  async run({ rec }) {
    const clients = Array.from({ length: 30 }, () => createRedis({ host: "127.0.0.1", port: 6379, commandTimeout: 100, enableOfflineQueue: false, maxRetriesPerRequest: 0 }));
    await Promise.all(clients.map((c) => ensureConnected(c)));
    type Attempt = { at: number; ok: boolean };
    const runScenario = async (label: string, backoff: (attempt: number) => number) => {
      const attempts: Attempt[] = [];
      const t0 = performance.now();
      await exec("docker", ["pause", "study-redis"]);
      const unpauseAt = 3000;
      const unpauser = new Promise<void>((r) => setTimeout(async () => { await exec("docker", ["unpause", "study-redis"]); r(); }, unpauseAt));
      try {
        await Promise.all(
          clients.map(async (c) => {
            for (let attempt = 0; attempt < 60; attempt++) {
              const t = performance.now() - t0;
              try {
                await c.get("chaos:retry");
                attempts.push({ at: t, ok: true });
                return;
              } catch {
                attempts.push({ at: t, ok: false });
                await new Promise((r) => setTimeout(r, backoff(attempt)));
              }
            }
          }),
        );
      } finally {
        await unpauser;
        await exec("docker", ["unpause", "study-redis"]);
      }
      const total = attempts.length;
      const perSec = new Map<number, number>();
      for (const a of attempts) perSec.set(Math.floor(a.at / 1000), (perSec.get(Math.floor(a.at / 1000)) ?? 0) + 1);
      const peak = Math.max(...perSec.values());
      const herd = attempts.filter((a) => a.at >= unpauseAt && a.at < unpauseAt + 500).length;
      const succeeded = attempts.filter((a) => a.ok).length;
      const spread = attempts.filter((a) => a.at >= unpauseAt);
      const lastOk = Math.max(0, ...attempts.filter((a) => a.ok).map((a) => a.at));
      rec.steps.push({ cmd: `${label}: 초별 시도 수`, result: [...perSec.entries()].sort((x, y) => x[0] - y[0]).map(([s, n]) => `${s}s: ${n}`), ms: 0 });
      return { label, total, peak, herd, succeeded, recoveredBy: Math.round(lastOk), after: spread.length };
    };
    rec.note("시나리오 A — 실패하면 즉시 재시도 (성공할 때까지, 간격 0ms)");
    const a = await runScenario("A 즉시 재시도", () => 0);
    await new Promise((r) => setTimeout(r, 1000));
    rec.note("시나리오 B — 지수 백오프 + 풀 지터 (base 200ms, cap 2s)");
    const b = await runScenario("B 백오프+지터", (n) => Math.floor(Math.random() * Math.min(2000, 200 * 2 ** n)));
    rec.steps.push({ cmd: "비교", result: { A: a, B: b }, ms: 0 });
    rec.check("즉시 재시도는 백오프보다 총 시도가 훨씬 많다 (멈춘 Redis 에 부하)", a.total > b.total * 1.5, { A: a.total, B: b.total });
    rec.check("즉시 재시도의 초당 피크가 더 높다", a.peak > b.peak, { A: a.peak, B: b.peak });
    rec.check("두 시나리오 모두 30 클라이언트가 결국 성공했다", a.succeeded === 30 && b.succeeded === 30, { A: a.succeeded, B: b.succeeded });
    rec.note(`복구 직후 0.5초 안에 몰린 시도: A=${a.herd}, B=${b.herd} — 지터가 복구 순간의 몰림을 흩뿌린다`);
    rec.note("실무 포인트: 재시도는 멱등 요청에만, 횟수보다 총 시간 예산으로 제한, 상위 계층과 중첩 재시도 금지(3×3×3=27배), 재시도율 메트릭을 알림에. 서킷 브레이커와 함께 쓰면 open 중엔 재시도조차 하지 않는다.");
    for (const c of clients) c.disconnect();
    await getRedis().del("chaos:retry").catch(() => {});
  },
};
