import type { Experiment } from "./types";

export const cacheAside: Experiment = {
  id: "cache-aside",
  title: "Cache-Aside: 미스 → DB 조회 → 캐시 적재",
  category: "패턴·활용",
  summary: "느린 DB 호출을 흉내 내고 캐시 히트/미스 시간을 비교, 무효화까지",
  notes: ["08-caching-patterns"],
  description: `
가장 흔한 캐시 패턴. 읽을 때 캐시를 먼저 보고, 없으면 원본(DB)에서 읽어 캐시에 TTL 과 함께 넣는다.
쓸 때는 DB 를 갱신하고 캐시를 **삭제**(무효화)한다. 갱신이 아닌 삭제를 하는 이유는 경쟁 상태에서 stale 값이 남는 것을 줄이기 위해서다.

같은 키에 미스가 동시에 몰리면(**cache stampede**) DB 가 터질 수 있다 → 락, 확률적 조기 갱신, TTL 지터 등으로 완화.
`,
  code: `GET product:42              # (nil) → 미스
# DB 조회 (느림) ...
SET product:42 "{...}" EX 60
GET product:42              # 히트 (빠름)

# 갱신 시: DB 업데이트 후 캐시 삭제
DEL product:42`,
  async run({ redis, rec, k }) {
    const key = k("product:42");
    const slowDb = async () => {
      await rec.sleep(80);
      return JSON.stringify({ id: 42, name: "키보드", price: 89000 });
    };
    const getProduct = async () => {
      const hit = await redis.get(key);
      if (hit) return { source: "cache", value: hit };
      const value = await rec.measure("DB 조회 (80ms 지연 흉내)", slowDb);
      await redis.set(key, value, "EX", 60);
      return { source: "db", value };
    };

    const r1 = await rec.measure("1회차 getProduct", getProduct);
    rec.check("첫 호출은 DB 에서", r1.source === "db", r1.source);
    const r2 = await rec.measure("2회차 getProduct", getProduct);
    rec.check("두 번째는 캐시 히트", r2.source === "cache", r2.source);
    const [s1, s2] = rec.steps.filter((s) => s.cmd.includes("회차"));
    rec.note(`미스 ${s1.ms}ms vs 히트 ${s2.ms}ms`);

    rec.note("상품 가격이 바뀌었다 → 캐시 무효화");
    await redis.del(key);
    const r3 = await getProduct();
    rec.check("무효화 후 다시 DB 에서", r3.source === "db", r3.source);
  },
};

export const rateLimiter: Experiment = {
  id: "rate-limiter",
  title: "Rate Limiter: 고정 윈도우 vs 슬라이딩 윈도우",
  category: "패턴·활용",
  summary: "INCR+EXPIRE 고정 윈도우와 ZSET 슬라이딩 윈도우를 구현하고 한도 초과를 확인",
  notes: ["10-rate-limiting"],
  description: `
**고정 윈도우**: \`INCR key\` 후 처음이면 \`EXPIRE\`. 단순하지만 윈도우 경계에서 2배 트래픽이 통과할 수 있다.

**슬라이딩 윈도우 로그**: ZSET 에 요청 시각을 score 로 넣고, 윈도우 밖은 \`ZREMRANGEBYSCORE\` 로 제거 후 \`ZCARD\` 로 센다.
정확하지만 요청마다 멤버를 저장하므로 메모리를 더 쓴다. 보통 MULTI 로 묶어 원자적으로 처리한다.
`,
  code: `# 고정 윈도우: 1초에 3번
INCR rl:user:1            # 1 → 처음이면 EXPIRE 1
INCR rl:user:1            # 2
INCR rl:user:1            # 3
INCR rl:user:1            # 4 > 3 → 거부

# 슬라이딩 윈도우 (1초, 3번)
MULTI
ZREMRANGEBYSCORE sl:user:1 0 <now-1000>
ZADD sl:user:1 <now> <now-unique>
ZCARD sl:user:1
EXPIRE sl:user:1 1
EXEC   # ZCARD > 3 이면 거부`,
  async run({ redis, rec, k }) {
    rec.note("고정 윈도우 (limit 3 / 1s)");
    const fixed = async () => {
      const key = k("fixed");
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, 1);
      return n <= 3;
    };
    const fixedResults: boolean[] = [];
    for (let i = 0; i < 5; i++) fixedResults.push(await fixed());
    rec.check("4번째부터 거부", fixedResults.join(",") === "true,true,true,false,false", fixedResults);

    rec.note("슬라이딩 윈도우 로그 (limit 3 / 1s)");
    const sliding = async () => {
      const key = k("sliding");
      const now = Date.now();
      const res = await redis
        .multi()
        .zremrangebyscore(key, 0, now - 1000)
        .zadd(key, now, `${now}-${Math.random()}`)
        .zcard(key)
        .expire(key, 1)
        .exec();
      return Number(res?.[2][1]) <= 3;
    };
    const slidingResults: boolean[] = [];
    for (let i = 0; i < 5; i++) slidingResults.push(await sliding());
    rec.check("4번째부터 거부", slidingResults.join(",") === "true,true,true,false,false", slidingResults);

    await rec.measure("1.1초 대기 (윈도우 통과)", () => rec.sleep(1100));
    rec.check("윈도우가 지나면 다시 허용", await sliding());
  },
};

export const hyperloglog: Experiment = {
  id: "hyperloglog",
  title: "HyperLogLog: 12KB 로 수백만 유니크 카운트",
  category: "패턴·활용",
  summary: "PFADD/PFCOUNT 로 10,000개 고유값의 근사 카운트와 오차, 메모리 사용량 확인",
  notes: ["13-probabilistic"],
  description: `
HyperLogLog 는 집합의 **카디널리티(고유 개수)** 를 약 0.81% 오차로 추정하는 확률적 구조다.
멤버를 저장하지 않으므로 아무리 많이 넣어도 최대 **12KB** 다. 일간 순방문자(UV) 같은 "대략 몇 명?" 에 적합하다.
멤버가 존재하는지는 물어볼 수 없다.
`,
  code: `PFADD uv:today u1 u2 u3 ... u10000
PFCOUNT uv:today            # ≈ 10000 (오차 ~1%)
MEMORY USAGE uv:today       # ~ 12KB 근처
PFADD uv:yesterday u9000 ... u12000
PFMERGE uv:2days uv:today uv:yesterday
PFCOUNT uv:2days`,
  async run({ redis, rec, k }) {
    const N = 10_000;
    const members = Array.from({ length: N }, (_, i) => `u${i}`);
    await rec.measure(`PFADD ${N}개 (파이프라인)`, async () => {
      const p = redis.pipeline();
      for (let i = 0; i < N; i += 500) p.pfadd(k("uv:today"), ...members.slice(i, i + 500));
      return (await p.exec())?.length;
    });
    const count = await redis.pfcount(k("uv:today"));
    const errPct = Math.abs(count - N) / N * 100;
    rec.check(`근사값 ${count}, 오차 ${errPct.toFixed(2)}% (< 3%)`, errPct < 3, count);
    const mem = await redis.memory("USAGE", k("uv:today"));
    rec.check("메모리 20KB 미만", Number(mem) < 20_000, `${mem} bytes`);

    await redis.pfadd(k("uv:yesterday"), ...Array.from({ length: 3000 }, (_, i) => `u${9000 + i}`));
    await redis.pfmerge(k("uv:2days"), k("uv:today"), k("uv:yesterday"));
    const merged = await redis.pfcount(k("uv:2days"));
    rec.check("합집합 ≈ 12000", Math.abs(merged - 12000) / 12000 < 0.03, merged);
  },
};

export const bitmapDau: Experiment = {
  id: "bitmap-dau",
  title: "Bitmap: 비트 하나로 사용자 출석 체크",
  category: "패턴·활용",
  summary: "SETBIT/GETBIT/BITCOUNT 로 일별 활성 사용자, BITOP AND 로 연속 출석자",
  notes: ["13-probabilistic"],
  description: `
String 을 비트 배열로 다룬다. 사용자 ID 를 오프셋으로 쓰면 1억 명도 **12.5MB** 로 "오늘 접속했나?" 를 저장할 수 있다.
\`BITCOUNT\` 로 활성 사용자 수, \`BITOP AND/OR\` 로 "이틀 연속 접속" 같은 교차 분석이 가능하다.
ID 가 희소(sparse)하면 비효율적이다.
`,
  code: `SETBIT dau:2026-10-15 7 1     # user 7 접속
SETBIT dau:2026-10-15 42 1
SETBIT dau:2026-10-16 7 1
GETBIT dau:2026-10-16 42       # 0
BITCOUNT dau:2026-10-15        # 2
BITOP AND dau:both dau:2026-10-15 dau:2026-10-16
BITCOUNT dau:both              # 1 (user 7)
STRLEN dau:2026-10-15          # 6 bytes (오프셋 42 까지)`,
  async run({ redis, rec, k }) {
    const d1 = k("dau:d1");
    const d2 = k("dau:d2");
    await redis.setbit(d1, 7, 1);
    await redis.setbit(d1, 42, 1);
    await redis.setbit(d2, 7, 1);
    rec.check("user 42 는 둘째 날 미접속", (await redis.getbit(d2, 42)) === 0);
    rec.check("첫째 날 활성 2명", (await redis.bitcount(d1)) === 2);
    await redis.bitop("AND", k("dau:both"), d1, d2);
    rec.check("이틀 연속 접속 1명", (await redis.bitcount(k("dau:both"))) === 1);
    const len = await redis.strlen(d1);
    rec.check("오프셋 42 까지 6바이트", len === 6, len);
  },
};

export const geoSearch: Experiment = {
  id: "geo-search",
  title: "Geo: 반경 내 가까운 지점 찾기",
  category: "패턴·활용",
  summary: "GEOADD 로 서울 지점 등록, GEODIST, GEOSEARCH 로 반경 검색",
  notes: ["02-data-types"],
  description: `
Geo 는 Sorted Set 위에 구현되어 있다. 좌표를 52비트 geohash 정수로 바꿔 score 로 저장하므로 ZSET 명령도 쓸 수 있다.
\`GEOSEARCH ... BYRADIUS\` 로 반경 검색, \`GEODIST\` 로 두 지점 거리 계산. 근처 매장·배달 기사 찾기에 사용.
`,
  code: `GEOADD stores 126.9780 37.5665 cityhall 127.0276 37.4979 gangnam 126.9270 37.5270 hongdae
GEODIST stores cityhall gangnam km
GEOSEARCH stores FROMLONLAT 126.97 37.56 BYRADIUS 7 km ASC WITHDIST
GEOPOS stores hongdae
ZRANGE stores 0 -1 WITHSCORES    # 내부는 ZSET`,
  async run({ redis, rec, k }) {
    await redis.geoadd(k("stores"), 126.978, 37.5665, "cityhall", 127.0276, 37.4979, "gangnam", 126.927, 37.527, "hongdae");
    const dist = await redis.call("GEODIST", k("stores"), "cityhall", "gangnam", "km");
    rec.check("시청↔강남 약 8~9km", Number(dist) > 7 && Number(dist) < 10, dist);
    const near = (await redis.call("GEOSEARCH", k("stores"), "FROMLONLAT", 126.97, 37.56, "BYRADIUS", 7, "km", "ASC", "WITHDIST")) as unknown[];
    rec.check("7km 안에는 시청·홍대 (강남은 제외)", near.length === 2, near);
    await redis.geopos(k("stores"), "hongdae");
    await redis.zrange(k("stores"), "0", "-1", "WITHSCORES");
  },
};

export const encodingsAndScan: Experiment = {
  id: "encodings-scan",
  title: "내부 인코딩과 SCAN: 메모리와 안전한 순회",
  category: "내부 동작",
  summary: "같은 타입이 값에 따라 인코딩이 바뀌는 모습, KEYS 대신 SCAN 으로 순회",
  notes: ["12-memory-performance", "02-data-types"],
  description: `
Redis 는 같은 논리 타입이라도 크기에 따라 다른 내부 구조를 쓴다.
- String: 정수면 \`int\`, 44바이트 이하면 \`embstr\`, 그 이상 \`raw\`
- Hash/ZSet: 작으면 \`listpack\`, 크면 \`hashtable\`/\`skiplist\`
- Set: 정수만 있으면 \`intset\`, 작으면 \`listpack\`, 크면 \`hashtable\`

\`KEYS *\` 는 O(N) 으로 서버를 멈추게 한다. 운영에서는 커서 기반 \`SCAN\` 으로 나눠서 순회한다.
`,
  code: `SET n 12345            → OBJECT ENCODING n   # int
SET s "hello"          → OBJECT ENCODING s   # embstr
SET l <50자 이상>       → OBJECT ENCODING l   # raw
SADD ints 1 2 3        → OBJECT ENCODING ints  # intset
HSET small a 1         → OBJECT ENCODING small # listpack
HSET big f1..f600      → OBJECT ENCODING big   # hashtable (기본 임계값 512개)

SCAN 0 MATCH lab:* COUNT 100   # [다음 커서, 키 목록] 반복`,
  async run({ redis, rec, k }) {
    await redis.set(k("n"), 12345);
    await redis.set(k("s"), "hello");
    await redis.set(k("l"), "x".repeat(60));
    rec.check("정수 → int", (await redis.object("ENCODING", k("n"))) === "int");
    rec.check("짧은 문자열 → embstr", (await redis.object("ENCODING", k("s"))) === "embstr");
    rec.check("긴 문자열 → raw", (await redis.object("ENCODING", k("l"))) === "raw");

    await redis.sadd(k("ints"), 1, 2, 3);
    rec.check("정수 집합 → intset", (await redis.object("ENCODING", k("ints"))) === "intset");
    await redis.hset(k("small"), "a", 1);
    rec.check("작은 해시 → listpack", (await redis.object("ENCODING", k("small"))) === "listpack");
    const big: Record<string, number> = {};
    for (let i = 0; i < 600; i++) big[`f${i}`] = i;
    await redis.hset(k("big"), big);
    rec.check("큰 해시(600필드, 임계값 512 초과) → hashtable", (await redis.object("ENCODING", k("big"))) === "hashtable");
    await redis.memory("USAGE", k("small"));
    await redis.memory("USAGE", k("big"));

    rec.note("SCAN 으로 이 실험의 키만 순회");
    let cursor = "0";
    const found: string[] = [];
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", k("*"), "COUNT", 100);
      cursor = next;
      found.push(...keys);
    } while (cursor !== "0");
    rec.check("키 6개 발견", found.length === 6, found.sort());
  },
};
