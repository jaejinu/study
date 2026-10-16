import type { Experiment } from "./types";

export const stringsBasics: Experiment = {
  id: "strings-basics",
  title: "String: 가장 기본이 되는 값",
  category: "자료구조",
  summary: "SET/GET, 숫자 증감(INCR), 부분 조회, 한 번에 여러 키 다루기",
  notes: ["02-data-types"],
  description: `
Redis 의 String 은 최대 512MB 의 **바이너리 안전** 바이트열이다. 문자열이지만 정수로 파싱되면 \`INCR\`/\`DECRBY\` 같은
원자적 숫자 연산이 가능하다. 카운터, 세션, 직렬화된 객체(JSON) 캐시가 대표적 용도다.

- \`SET key value\` 는 항상 덮어쓴다. 기존 값을 돌려받고 싶으면 \`SET ... GET\` (6.2+) 또는 \`GETSET\`.
- \`INCR\` 은 단일 스레드 명령 실행 덕분에 여러 클라이언트가 동시에 호출해도 유실되지 않는다.
- \`MSET\`/\`MGET\` 은 라운드트립(RTT)을 한 번으로 줄인다.
`,
  code: `SET user:1:name "alice"
GET user:1:name
SET page:views 0
INCR page:views          # 1
INCRBY page:views 10     # 11
DECR page:views          # 10
APPEND user:1:name " kim"
STRLEN user:1:name
GETRANGE user:1:name 0 4
MSET a 1 b 2 c 3
MGET a b c missing       # 없는 키는 nil
SET user:1:name "bob" GET   # 이전 값을 반환`,
  async run({ redis, rec, k }) {
    rec.note("문자열 저장/조회");
    await redis.set(k("name"), "alice");
    rec.check("GET 은 저장한 값을 반환", (await redis.get(k("name"))) === "alice");

    rec.note("숫자처럼 쓰기: INCR 계열은 원자적이다");
    await redis.set(k("views"), 0);
    await redis.incr(k("views"));
    await redis.incrby(k("views"), 10);
    const v = await redis.decr(k("views"));
    rec.check("0 → +1 → +10 → -1 = 10", v === 10, v);

    rec.note("문자열 조작");
    await redis.append(k("name"), " kim");
    await redis.strlen(k("name"));
    await redis.getrange(k("name"), 0, 4);

    rec.note("여러 키를 한 번의 왕복으로");
    await redis.mset(k("a"), 1, k("b"), 2, k("c"), 3);
    const m = await redis.mget(k("a"), k("b"), k("c"), k("missing"));
    rec.check("없는 키는 null 로 온다", m[3] === null, m);

    rec.note("SET ... GET 으로 이전 값을 함께 받기 (Redis 6.2+)");
    const prev = await redis.set(k("name"), "bob", "GET");
    rec.check("이전 값 alice kim 반환", prev === "alice kim", prev);
  },
};

export const expireTtl: Experiment = {
  id: "expire-ttl",
  title: "만료(TTL): 키는 스스로 사라질 수 있다",
  category: "자료구조",
  summary: "EX/PX 옵션, TTL 조회, PERSIST, 실제로 만료되는 순간 관찰",
  notes: ["03-keys-expiration", "08-caching-patterns"],
  description: `
캐시의 핵심은 **만료**다. Redis 는 키 단위로 TTL 을 둘 수 있고, 만료된 키는 두 가지 방식으로 제거된다.

1. **지연(lazy) 삭제**: 접근 시점에 만료됐으면 지우고 nil 을 돌려준다.
2. **능동(active) 삭제**: 백그라운드에서 주기적으로 만료 키를 샘플링해 지운다.

주의: \`SET\` 으로 값을 덮어쓰면 TTL 이 **사라진다** (\`KEEPTTL\` 옵션으로 유지 가능).
`,
  code: `SET session:abc "data" EX 10   # 10초 뒤 만료
TTL session:abc                 # 남은 초 (키 없음: -2, TTL 없음: -1)
PERSIST session:abc             # TTL 제거
TTL session:abc                 # -1
SET flash "hi" PX 200           # 200ms
PTTL flash
# ... 300ms 대기 ...
GET flash                       # nil
SET session:abc "new"           # TTL 이 사라진다!
SET session:abc "new" KEEPTTL   # TTL 유지`,
  async run({ redis, rec, k }) {
    await redis.set(k("session"), "data", "EX", 10);
    const ttl = await redis.ttl(k("session"));
    rec.check("TTL 은 10초 이하의 양수", ttl > 0 && ttl <= 10, ttl);

    await redis.persist(k("session"));
    rec.check("PERSIST 후 TTL = -1 (만료 없음)", (await redis.ttl(k("session"))) === -1);
    rec.check("없는 키의 TTL = -2", (await redis.ttl(k("nope"))) === -2);

    rec.note("밀리초 단위 만료를 실제로 관찰해 보자");
    await redis.set(k("flash"), "hi", "PX", 200);
    await redis.pttl(k("flash"));
    await rec.measure("300ms 대기", () => rec.sleep(300));
    const after = await redis.get(k("flash"));
    rec.check("만료 후 GET 은 null", after === null, after);

    rec.note("덮어쓰기와 TTL 의 관계");
    await redis.set(k("session"), "x", "EX", 100);
    await redis.set(k("session"), "overwritten");
    rec.check("일반 SET 은 TTL 을 제거한다", (await redis.ttl(k("session"))) === -1);
    await redis.set(k("session"), "y", "EX", 100);
    await redis.set(k("session"), "kept", "KEEPTTL");
    rec.check("KEEPTTL 이면 TTL 유지", (await redis.ttl(k("session"))) > 0);
  },
};

export const listQueue: Experiment = {
  id: "list-queue",
  title: "List: 큐와 스택, 최근 N개",
  category: "자료구조",
  summary: "LPUSH/RPOP 으로 FIFO 큐, LTRIM 으로 고정 길이 타임라인, BRPOP 블로킹 소비",
  notes: ["02-data-types", "07-pubsub-streams"],
  description: `
List 는 양쪽 끝 삽입/삭제가 O(1) 인 연결 리스트(내부적으로 quicklist = listpack 조각들의 연결)다.

- \`LPUSH\` + \`RPOP\` = FIFO 큐, \`LPUSH\` + \`LPOP\` = 스택
- \`LPUSH\` + \`LTRIM 0 N-1\` = "최근 N개만 유지" 패턴 (타임라인, 최근 본 상품)
- \`BRPOP key timeout\` 은 요소가 올 때까지 **블로킹**한다. 폴링 없이 워커를 구현할 수 있다.
- 중간 인덱스 접근(\`LINDEX\`)은 O(N) 이므로 큰 리스트에 남발하지 말 것.
`,
  code: `LPUSH jobs job1 job2 job3     # 왼쪽으로 쌓인다: [job3, job2, job1]
LRANGE jobs 0 -1
RPOP jobs                     # job1 (가장 먼저 들어온 것)
LLEN jobs

# 최근 5개만 유지하는 타임라인
LPUSH timeline e1 e2 e3 e4 e5 e6 e7
LTRIM timeline 0 4
LRANGE timeline 0 -1          # [e7, e6, e5, e4, e3]

# 블로킹 소비: 다른 클라이언트가 넣을 때까지 최대 1초 대기
BRPOP jobs 1`,
  async run({ redis, rec, k, newClient }) {
    rec.note("FIFO 큐");
    await redis.lpush(k("jobs"), "job1", "job2", "job3");
    await redis.lrange(k("jobs"), 0, -1);
    const first = await redis.rpop(k("jobs"));
    rec.check("RPOP 은 가장 먼저 넣은 job1", first === "job1", first);
    await redis.llen(k("jobs"));

    rec.note("고정 길이 타임라인 (LPUSH + LTRIM)");
    await redis.lpush(k("timeline"), "e1", "e2", "e3", "e4", "e5", "e6", "e7");
    await redis.ltrim(k("timeline"), 0, 4);
    const tl = await redis.lrange(k("timeline"), 0, -1);
    rec.check("최근 5개만 남는다", tl.length === 5 && tl[0] === "e7", tl);

    rec.note("블로킹 소비: 워커가 BRPOP 으로 기다리는 동안 다른 클라이언트가 LPUSH");
    const worker = await newClient("worker");
    await redis.del(k("jobs"));
    const waiting = worker.brpop(k("jobs"), 2);
    await rec.sleep(100);
    await redis.lpush(k("jobs"), "late-job");
    const got = await waiting;
    rec.check("BRPOP 이 깨어나 late-job 을 받는다", got?.[1] === "late-job", got);
  },
};

export const hashObject: Experiment = {
  id: "hash-object",
  title: "Hash: 필드가 있는 객체",
  category: "자료구조",
  summary: "HSET/HGETALL 로 객체 저장, 필드 단위 증가, 메모리 효율적인 소형 해시",
  notes: ["02-data-types", "12-memory-performance"],
  description: `
Hash 는 \`key → {field: value}\` 구조다. 사용자 프로필처럼 필드 단위 읽기/쓰기가 필요하면
JSON 문자열 하나로 저장하는 것보다 Hash 가 낫다. 특정 필드만 갱신하거나 \`HINCRBY\` 로 원자적 증가가 가능하기 때문이다.

필드 수가 적고(기본 128개 이하) 값이 짧으면(64바이트 이하) **listpack** 인코딩을 써서 메모리를 매우 적게 쓴다.
`,
  code: `HSET user:1 name alice age 30 city seoul
HGET user:1 name
HGETALL user:1
HINCRBY user:1 age 1
HEXISTS user:1 email        # 0
HDEL user:1 city
HKEYS user:1
HLEN user:1
OBJECT ENCODING user:1      # listpack`,
  async run({ redis, rec, k }) {
    await redis.hset(k("user:1"), { name: "alice", age: 30, city: "seoul" });
    await redis.hget(k("user:1"), "name");
    const all = await redis.hgetall(k("user:1"));
    rec.check("HGETALL 은 객체로 돌아온다", all.name === "alice" && all.age === "30", all);

    const age = await redis.hincrby(k("user:1"), "age", 1);
    rec.check("HINCRBY 로 필드만 원자적으로 증가", age === 31, age);

    rec.check("없는 필드 HEXISTS = 0", (await redis.hexists(k("user:1"), "email")) === 0);
    await redis.hdel(k("user:1"), "city");
    await redis.hkeys(k("user:1"));
    await redis.hlen(k("user:1"));

    const enc = await redis.object("ENCODING", k("user:1"));
    rec.check("소형 해시는 listpack 인코딩", enc === "listpack", enc);
  },
};

export const setOps: Experiment = {
  id: "set-ops",
  title: "Set: 중복 없는 집합과 집합 연산",
  category: "자료구조",
  summary: "SADD/SISMEMBER, 교집합·합집합·차집합으로 태그/팔로우 관계 계산",
  notes: ["02-data-types"],
  description: `
Set 은 순서 없는 유일 문자열 집합이다. 멤버 확인 \`SISMEMBER\` 가 O(1) 이라 "이미 처리한 ID인가?" 같은 중복 체크에 쓰인다.
\`SINTER\`/\`SUNION\`/\`SDIFF\` 로 서버에서 집합 연산을 바로 수행할 수 있다 (공통 친구, 공통 태그).
`,
  code: `SADD tags:post:1 redis cache db
SADD tags:post:2 redis queue
SISMEMBER tags:post:1 redis   # 1
SADD tags:post:1 redis        # 0 (이미 있음)
SINTER tags:post:1 tags:post:2   # redis
SUNION tags:post:1 tags:post:2   # redis cache db queue
SDIFF tags:post:1 tags:post:2    # cache db
SCARD tags:post:1
SRANDMEMBER tags:post:1 2`,
  async run({ redis, rec, k }) {
    await redis.sadd(k("p1"), "redis", "cache", "db");
    await redis.sadd(k("p2"), "redis", "queue");
    rec.check("SISMEMBER = 1", (await redis.sismember(k("p1"), "redis")) === 1);
    const dup = await redis.sadd(k("p1"), "redis");
    rec.check("중복 추가는 0 을 반환", dup === 0, dup);

    const inter = await redis.sinter(k("p1"), k("p2"));
    rec.check("교집합 = [redis]", inter.length === 1 && inter[0] === "redis", inter);
    const union = await redis.sunion(k("p1"), k("p2"));
    rec.check("합집합 크기 4", union.length === 4, union);
    const diff = await redis.sdiff(k("p1"), k("p2"));
    rec.check("차집합 = cache, db", diff.sort().join(",") === "cache,db", diff);
    await redis.scard(k("p1"));
    await redis.srandmember(k("p1"), 2);
  },
};

export const sortedSetLeaderboard: Experiment = {
  id: "zset-leaderboard",
  title: "Sorted Set: 실시간 랭킹",
  category: "자료구조",
  summary: "ZADD/ZINCRBY 로 점수 갱신, ZREVRANGE 상위 N, ZRANK 로 내 순위, 점수 범위 조회",
  notes: ["02-data-types", "10-rate-limiting"],
  description: `
Sorted Set 은 각 멤버가 **score(double)** 를 가지며 항상 점수순으로 정렬되어 있다 (skiplist + hash).
순위 조회·범위 조회가 O(log N) 이라 게임 리더보드, 지연 큐(score=실행시각), 슬라이딩 윈도우 카운터 등에 쓰인다.

점수가 같으면 멤버의 사전순으로 정렬된다.
`,
  code: `ZADD leaderboard 100 alice 250 bob 180 carol
ZINCRBY leaderboard 90 alice            # alice = 190
ZREVRANGE leaderboard 0 2 WITHSCORES    # 상위 3명
ZREVRANK leaderboard alice              # 0부터 시작하는 순위
ZSCORE leaderboard alice
ZRANGEBYSCORE leaderboard 150 200       # 점수 구간
ZCARD leaderboard
ZREMRANGEBYRANK leaderboard 0 0         # 꼴찌 제거`,
  async run({ redis, rec, k }) {
    await redis.zadd(k("lb"), 100, "alice", 250, "bob", 180, "carol");
    const s = await redis.zincrby(k("lb"), 90, "alice");
    rec.check("alice = 190", Number(s) === 190, s);

    const top = await redis.zrevrange(k("lb"), 0, 2, "WITHSCORES");
    rec.check("1위는 bob(250)", top[0] === "bob" && top[1] === "250", top);

    const rank = await redis.zrevrank(k("lb"), "alice");
    rec.check("alice 는 2위(index 1)", rank === 1, rank);
    await redis.zscore(k("lb"), "alice");
    const range = await redis.zrangebyscore(k("lb"), 150, 200);
    rec.check("150~200 구간엔 carol, alice", range.length === 2, range);
    await redis.zcard(k("lb"));
    await redis.zremrangebyrank(k("lb"), 0, 0);
    rec.check("꼴찌 제거 후 2명", (await redis.zcard(k("lb"))) === 2);
  },
};
