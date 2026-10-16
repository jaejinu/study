import { ensureConnected, getRedis } from "@/lib/redis";
import type { Experiment } from "./types";

async function requiresModules(...names: string[]): Promise<string | null> {
  try {
    const r = getRedis();
    await ensureConnected(r);
    const list = (await r.call("MODULE", "LIST")) as unknown[][];
    const loaded = list.map((m) => String(m[1]).toLowerCase());
    const missing = names.filter((n) => !loaded.includes(n.toLowerCase()));
    if (missing.length) return `이 Redis 에는 ${missing.join(", ")} 모듈이 없습니다. brew 빌드에는 모듈이 없으니 Docker 로 띄운 Redis 8 (pnpm redis:docker, redis:8-alpine) 에 연결하세요.`;
    return null;
  } catch (e) {
    return `Redis 에 연결할 수 없습니다: ${(e as Error).message}`;
  }
}

/** JSON.* 는 `$` 경로일 때 배열 JSON 문자열을 돌려준다 (서버/클라이언트에 따라 이미 파싱되어 오기도) */
function jsonFirst(raw: unknown): unknown {
  const v = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(v) ? v[0] : v;
}

/** FT.SEARCH / FT.AGGREGATE 응답을 구/신 형식 모두에서 {total, ids} 로 정규화 */
function searchResult(res: unknown): { total: number; ids: string[] } {
  const arr = res as unknown[];
  if (arr[0] === "attributes" || arr.includes("total_results")) {
    // Redis 8 기본 형식: ["attributes",[],"format","STRING","results",[["id",key,"extra_attributes",[...]], ...],"total_results",N,...]
    const results = (arr[arr.indexOf("results") + 1] as unknown[][]) ?? [];
    const ti = arr.indexOf("total_results");
    const total = ti >= 0 ? Number(arr[ti + 1]) : results.length;
    const ids = results.map((r) => String(r[r.indexOf("id") + 1] ?? ""));
    return { total, ids };
  }
  // 구 형식: [N, key1, [field, value...], key2, ...]
  const total = Number(arr[0]);
  const ids: string[] = [];
  for (let i = 1; i < arr.length; i += 2) ids.push(String(arr[i]));
  return { total, ids };
}

export const jsonBasics: Experiment = {
  id: "json-basics",
  title: "JSON: 문서를 경로로 읽고 쓰기",
  category: "모듈 (Redis 8)",
  summary: "JSON.SET/GET 과 JSONPath, 숫자 증가·배열 추가를 필드 단위로, Hash 와의 차이",
  notes: ["15-redis8-modules", "02-data-types"],
  description: `
Redis 8 은 JSON 타입을 내장한다 (예전 RedisJSON 모듈). 문자열 JSON 과 달리 **경로(JSONPath)** 로 일부만 읽고 쓰며, 중첩 구조와 배열을 지원한다.
Hash 는 1단계 필드만 되지만 JSON 은 \`$.address.city\`, \`$.tags[0]\` 같은 깊은 접근이 된다. 대신 메모리는 더 쓴다.
`,
  code: `JSON.SET user:1 $ '{"name":"alice","age":30,"tags":["a"],"address":{"city":"seoul"}}'
JSON.GET user:1 $.name                   # ["alice"]
JSON.GET user:1 $.address.city
JSON.NUMINCRBY user:1 $.age 1            # [31]
JSON.ARRAPPEND user:1 $.tags '"b"'       # [2]
JSON.SET user:1 $.address.zip '"04524"'
JSON.OBJKEYS user:1 $
JSON.TYPE user:1 $.tags
JSON.DEL user:1 $.tags`,
  requires: () => requiresModules("ReJSON"),
  async run({ redis, rec, k }) {
    const key = k("user:1");
    await redis.call("JSON.SET", key, "$", JSON.stringify({ name: "alice", age: 30, tags: ["a"], address: { city: "seoul" } }));
    const name = jsonFirst(await redis.call("JSON.GET", key, "$.name"));
    rec.check("경로로 필드 하나만 읽기", name === "alice", name);
    await redis.call("JSON.GET", key, "$.address.city");
    const age = jsonFirst(await redis.call("JSON.NUMINCRBY", key, "$.age", 1));
    rec.check("중첩 숫자 원자적 증가", Number(age) === 31, age);
    const len = jsonFirst(await redis.call("JSON.ARRAPPEND", key, "$.tags", '"b"'));
    rec.check("배열에 추가, 길이 2", Number(len) === 2, len);
    await redis.call("JSON.SET", key, "$.address.zip", '"04524"');
    await redis.call("JSON.OBJKEYS", key, "$");
    await redis.call("JSON.TYPE", key, "$.tags");
    await redis.call("JSON.DEL", key, "$.tags");
    const whole = JSON.parse((await redis.call("JSON.GET", key)) as string) as { tags?: unknown; address: { zip?: string } };
    rec.check("tags 삭제됨, zip 추가됨", whole.tags === undefined && whole.address.zip === "04524", whole);
    rec.check("TYPE 은 ReJSON-RL", (await redis.type(key)) === "ReJSON-RL");
  },
};

export const searchBasics: Experiment = {
  id: "search-basics",
  title: "Search: 인덱스를 만들고 전문·숫자·태그 검색",
  category: "모듈 (Redis 8)",
  summary: "FT.CREATE 로 Hash 를 인덱싱하고 FT.SEARCH 로 텍스트·범위·태그 조건 질의, 정렬과 집계",
  notes: ["15-redis8-modules"],
  description: `
Redis Query Engine(예전 RediSearch)은 Hash/JSON 에 **2차 인덱스**를 만든다. 접두어로 대상 키를 정하고 스키마(TEXT, NUMERIC, TAG, VECTOR)를 선언하면
이후 쓰기가 자동으로 인덱싱된다. 키를 스캔하지 않고 "이름에 keyboard 가 들어가고 가격 10만 미만, 카테고리 input" 같은 질의가 가능하다.
벡터 검색(KNN)도 같은 엔진이라 RAG 저장소로도 쓰인다.
`,
  code: `FT.CREATE idx:prod ON HASH PREFIX 1 prod: SCHEMA name TEXT price NUMERIC SORTABLE category TAG
HSET prod:1 name "mechanical keyboard" price 89000 category input
HSET prod:2 name "wireless mouse" price 35000 category input
HSET prod:3 name "4k monitor" price 420000 category display
FT.SEARCH idx:prod "keyboard"                          # 전문 검색
FT.SEARCH idx:prod "@price:[0 100000]" SORTBY price ASC RETURN 2 name price
FT.SEARCH idx:prod "@category:{input} -mouse"
FT.AGGREGATE idx:prod "*" GROUPBY 1 @category REDUCE COUNT 0 AS n
FT.INFO idx:prod
FT.DROPINDEX idx:prod`,
  requires: () => requiresModules("search"),
  async run({ redis, rec, k }) {
    const idx = k("idx");
    const prefix = k("prod:");
    try {
      await redis.call("FT.CREATE", idx, "ON", "HASH", "PREFIX", "1", prefix, "SCHEMA", "name", "TEXT", "price", "NUMERIC", "SORTABLE", "category", "TAG");
      await redis.hset(`${prefix}1`, { name: "mechanical keyboard", price: 89000, category: "input" });
      await redis.hset(`${prefix}2`, { name: "wireless mouse", price: 35000, category: "input" });
      await redis.hset(`${prefix}3`, { name: "4k monitor", price: 420000, category: "display" });
      await rec.sleep(100);
      const r1 = searchResult(await redis.call("FT.SEARCH", idx, "keyboard", "RETURN", "1", "name"));
      rec.check("전문 검색 1건", r1.total === 1, r1);
      const r2 = searchResult(await redis.call("FT.SEARCH", idx, "@price:[0 100000]", "SORTBY", "price", "ASC", "RETURN", "2", "name", "price"));
      rec.check("가격 범위 2건, 저렴한 순 (mouse 먼저)", r2.total === 2 && r2.ids[0].endsWith("2"), r2);
      const r3 = searchResult(await redis.call("FT.SEARCH", idx, "@category:{input} -mouse", "RETURN", "1", "name"));
      rec.check("태그 + 제외어", r3.total === 1, r3);
      const aggRaw = (await redis.call("FT.AGGREGATE", idx, "*", "GROUPBY", "1", "@category", "REDUCE", "COUNT", "0", "AS", "n")) as unknown[];
      const groups = aggRaw.includes("results") ? (aggRaw[aggRaw.indexOf("results") + 1] as unknown[]).length : Number(aggRaw[0]);
      rec.check("카테고리별 집계 2그룹", groups === 2, aggRaw);
      const info = (await redis.call("FT.INFO", idx)) as unknown[];
      const docs = info[info.indexOf("num_docs") + 1];
      rec.note(`FT.INFO num_docs=${docs}`);
    } finally {
      await redis.call("FT.DROPINDEX", idx).catch(() => {});
    }
  },
};

export const bloomFilter: Experiment = {
  id: "bloom-filter",
  title: "Bloom / Cuckoo 필터: '없다' 는 확실히, '있다' 는 아마도",
  category: "모듈 (Redis 8)",
  summary: "BF.RESERVE 로 오차율을 정하고 1,000개를 넣은 뒤 비멤버 1,000개로 실제 거짓 양성률 측정, Cuckoo 는 삭제 가능",
  notes: ["13-probabilistic", "15-redis8-modules"],
  description: `
Bloom 필터는 k 개 해시로 비트 배열을 찍는다. \`BF.EXISTS\` 가 0 이면 **확실히 없고**, 1 이면 설정한 오차율만큼 거짓 양성이 있을 수 있다.
멤버를 저장하지 않으므로 Set 보다 훨씬 작다. 삭제는 불가 (Cuckoo 필터 \`CF.*\` 는 가능).
용도: 이미 본 URL/추천 제외, 캐시 penetration 방지, 중복 이벤트 1차 필터.
`,
  code: `BF.RESERVE seen 0.01 1000        # 오차 1%, 예상 1000개
BF.MADD seen u1 u2 u3 ...
BF.EXISTS seen u1                # 1
BF.EXISTS seen nope              # 0 (확실히 없음) 또는 1 (거짓 양성 ~1%)
BF.INFO seen
MEMORY USAGE seen
CF.RESERVE cf 1000
CF.ADD cf a ; CF.EXISTS cf a ; CF.DEL cf a ; CF.EXISTS cf a   # 삭제 가능`,
  requires: () => requiresModules("bf"),
  async run({ redis, raw, rec, k }) {
    const key = k("seen");
    await redis.call("BF.RESERVE", key, "0.01", "1000");
    const members = Array.from({ length: 1000 }, (_, i) => `u${i}`);
    await rec.measure("BF.MADD 1000개", () => raw.call("BF.MADD", key, ...members));
    rec.check("멤버는 1", (await redis.call("BF.EXISTS", key, "u42")) === 1);
    const probe = Array.from({ length: 1000 }, (_, i) => `x${i}`);
    const res = (await raw.call("BF.MEXISTS", key, ...probe)) as number[];
    const fp = res.filter((v) => v === 1).length;
    rec.check(`비멤버 1000개 중 거짓 양성 ${fp}개 (${(fp / 10).toFixed(1)}%, 목표 ≤ 1% 근처)`, fp <= 30, fp);
    await redis.call("BF.INFO", key);
    const mem = Number(await redis.memory("USAGE", key));
    rec.note(`메모리 ${mem} bytes — 같은 1000개를 Set 으로 저장하면 보통 40KB 이상`);

    rec.note("Cuckoo 필터는 삭제가 된다");
    const cf = k("cf");
    await redis.call("CF.RESERVE", cf, "1000");
    await redis.call("CF.ADD", cf, "a");
    rec.check("추가 후 EXISTS 1", (await redis.call("CF.EXISTS", cf, "a")) === 1);
    await redis.call("CF.DEL", cf, "a");
    rec.check("삭제 후 EXISTS 0", (await redis.call("CF.EXISTS", cf, "a")) === 0);
  },
};

export const timeseriesBasics: Experiment = {
  id: "timeseries-basics",
  title: "TimeSeries: 센서 값을 넣고 구간 평균으로 묶기",
  category: "모듈 (Redis 8)",
  summary: "TS.ADD 로 시계열 적재, RETENTION 과 라벨, TS.RANGE AGGREGATION, 다운샘플링 규칙(TS.CREATERULE)",
  notes: ["15-redis8-modules"],
  description: `
TimeSeries 는 (timestamp, double) 쌍을 압축 저장하고, 범위 조회·집계(avg/max/sum…)·라벨 기반 다중 조회(\`TS.MRANGE\`)를 제공한다.
\`TS.CREATERULE\` 로 원본을 자동 다운샘플링해 1분 평균 같은 요약 시계열을 유지할 수 있다. 메트릭·IoT 센서 값에 적합하다.
`,
  code: `TS.CREATE temp:room1 RETENTION 3600000 LABELS sensor temp room 1
TS.ADD temp:room1 * 21.5
TS.ADD temp:room1 * 22.0
TS.RANGE temp:room1 - +
TS.RANGE temp:room1 - + AGGREGATION avg 200     # 버킷은 epoch 기준으로 정렬된다
TS.MRANGE - + FILTER sensor=temp
TS.CREATE temp:room1:1m
TS.CREATERULE temp:room1 temp:room1:1m AGGREGATION avg 60000
TS.INFO temp:room1`,
  requires: () => requiresModules("timeseries"),
  async run({ redis, raw, rec, k }) {
    const key = k("temp:room1");
    await redis.call("TS.CREATE", key, "RETENTION", "3600000", "LABELS", "sensor", "temp", "room", "1");
    const base = Math.floor(Date.now() / 1000) * 1000; // 버킷 경계(200ms 배수)에 맞춘다
    const values = [21.5, 22.0, 22.5, 23.0, 21.0, 20.5];
    await rec.measure("TS.ADD 6개 (100ms 간격 타임스탬프)", async () => {
      for (let i = 0; i < values.length; i++) await raw.call("TS.ADD", key, String(base + i * 100), String(values[i]));
      return values.length;
    });
    const all = (await redis.call("TS.RANGE", key, "-", "+")) as [number, string][];
    rec.check("6개 샘플", all.length === 6, all.length);
    const agg = (await redis.call("TS.RANGE", key, "-", "+", "AGGREGATION", "avg", "200")) as [number, string][];
    rec.check("200ms 버킷 평균 3개 (2개씩 묶임)", agg.length === 3 && Number(agg[0][1]) === 21.75, agg);
    const maxv = (await redis.call("TS.RANGE", key, "-", "+", "AGGREGATION", "max", "100000")) as [number, string][];
    rec.check("전체 최대 23", Number(maxv[0][1]) === 23, maxv);
    const m = (await redis.call("TS.MRANGE", "-", "+", "FILTER", "sensor=temp")) as unknown[];
    rec.check("라벨로 시계열 찾기", m.length >= 1, m.length);
    await redis.call("TS.CREATE", k("temp:room1:1m"));
    await redis.call("TS.CREATERULE", key, k("temp:room1:1m"), "AGGREGATION", "avg", "60000");
    const info = (await redis.call("TS.INFO", key)) as unknown[];
    rec.note(`TS.INFO: totalSamples=${info[info.indexOf("totalSamples") + 1]}, rules=${JSON.stringify(info[info.indexOf("rules") + 1])}`);
  },
};
