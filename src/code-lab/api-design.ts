import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import Redis from "ioredis";
import type { CodeExperiment } from "./types";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 실험용 서비스 정의. 파일로도 읽히도록 실행 시 임시 디렉터리에 쓴다 */
export const CATALOG_PROTO = `syntax = "proto3";
package study.catalog.v1;

service Catalog {
  rpc GetItem(GetItemRequest) returns (Item);                 // unary
  rpc ListItems(ListItemsRequest) returns (stream Item);      // 서버 스트리밍
  rpc SlowWork(SlowWorkRequest) returns (SlowWorkReply);      // 느린 작업 (데드라인·취소 실험)
  rpc Chain(SlowWorkRequest) returns (SlowWorkReply);         // 내부에서 SlowWork 를 다시 부른다 (전파 실험)
}

message GetItemRequest { int32 id = 1; }
message ListItemsRequest { int32 count = 1; }
message Item {
  int32 id = 1;
  string name = 2;
  int64 price = 3;           // 원 단위 정수 — 돈은 float 로 보내지 않는다
  repeated string tags = 4;
  bool in_stock = 5;
}
message SlowWorkRequest { int32 ms = 1; bool propagate = 2; }
message SlowWorkReply { int32 steps_done = 1; }
`;

type Item = { id: number; name: string; price: number; tags: string[]; inStock: boolean };
type CatalogClient = grpc.Client & {
  GetItem: (req: { id: number }, cb: (err: grpc.ServiceError | null, res: Item) => void) => grpc.ClientUnaryCall;
  ListItems: (req: { count: number }) => grpc.ClientReadableStream<Item>;
  SlowWork: (req: { ms: number; propagate?: boolean }, opts: grpc.CallOptions, cb: (err: grpc.ServiceError | null, res: { stepsDone: number }) => void) => grpc.ClientUnaryCall;
  Chain: (req: { ms: number; propagate?: boolean }, opts: grpc.CallOptions, cb: (err: grpc.ServiceError | null, res: { stepsDone: number }) => void) => grpc.ClientUnaryCall;
};

function loadCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "study-proto-"));
  const file = path.join(dir, "catalog.proto");
  fs.writeFileSync(file, CATALOG_PROTO);
  const def = protoLoader.loadSync(file, { keepCase: false, longs: Number, defaults: true });
  fs.rmSync(dir, { recursive: true, force: true });
  const pkg = grpc.loadPackageDefinition(def) as unknown as { study: { catalog: { v1: { Catalog: grpc.ServiceClientConstructor } } } };
  return { def, Catalog: pkg.study.catalog.v1.Catalog };
}

function makeItem(id: number): Item {
  return { id, name: `상품-${id} 무선 키보드 텐키리스`, price: 39_000 + (id % 50) * 1000, tags: ["keyboard", id % 2 ? "wireless" : "wired", "sale"], inStock: id % 7 !== 0 };
}

function listen(server: grpc.Server): Promise<number> {
  return new Promise((resolve, reject) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) => (err ? reject(err) : resolve(port))));
}

function shutdown(server: grpc.Server): Promise<void> {
  return new Promise((r) => server.tryShutdown(() => r()));
}

const unary = <T,>(fn: (cb: (err: grpc.ServiceError | null, res: T) => void) => void) => new Promise<T>((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));

// ------------------------------------------------------------------ unary vs 스트리밍 vs JSON
export const apiGrpcUnaryVsStream: CodeExperiment = {
  id: "api-grpc-unary-vs-stream",
  subject: "api-design",
  title: "gRPC unary × 1000 vs 서버 스트리밍 1회 vs JSON/HTTP: 같은 1000개 상품을 세 방식으로 보내고 시간·바이트를 잰다",
  category: "gRPC",
  summary: "프로세스 안에 gRPC 서버(임의 포트)와 JSON HTTP 서버를 띄우고, 1000개 항목을 unary 순차·unary 동시(HTTP/2 다중화)·서버 스트리밍·JSON 한 번에·JSON 1000번으로 받아 지연을 비교하고, Protobuf 와 JSON(gzip 포함)의 바이트 크기를 잰다",
  notes: ["03-protobuf-grpc", "01-rest-principles", "04-errors-retries-deadlines"],
  description: `
API 설계의 많은 결정은 **왕복 횟수**와 **바이트 수**로 귀결된다.
- unary 를 1000번 **순차로** 부르면 1000 RTT 를 낸다. 로컬이라 RTT 가 작아도 호출마다 직렬화·HTTP/2 프레임·콜백 비용이 쌓인다.
- 같은 1000번을 **동시에** 부르면 HTTP/2 가 한 연결 위에 스트림 1000개를 다중화한다. HTTP/1.1 이면 연결 수만큼만 병렬이다.
- **서버 스트리밍**은 요청 1번에 응답 메시지 1000개를 흘려보낸다. 페이지네이션 없이 큰 결과를 내보내는 gRPC 다운 방법이다.
- Protobuf 는 필드 이름 대신 **필드 번호 + 와이어 타입**을 쓰고 정수를 varint 로 줄인다. JSON 은 사람이 읽을 수 있는 대신 키 이름을 매번 싣는다. gzip 을 걸면 차이가 줄어든다 — 반복이 많은 JSON 은 압축이 잘 된다.
모든 서버는 실험 안에서 \`127.0.0.1:0\` (OS 가 고른 빈 포트)에 떴다가 끝나면 닫힌다.
`,
  code: `// 서버
server.addService(Catalog.service, {
  GetItem: (call, cb) => cb(null, items[call.request.id]),
  ListItems: (call) => { for (let i = 0; i < call.request.count; i++) call.write(items[i]); call.end(); },
});
// 클라이언트
for (let i = 0; i < 1000; i++) await getItem({ id: i });              // 순차 unary
await Promise.all(ids.map((id) => getItem({ id })));                 // 동시 unary (HTTP/2 다중화)
const s = client.ListItems({ count: 1000 }); for await (const it of s) …  // 서버 스트리밍
// 크기
def["study.catalog.v1.Catalog"].GetItem.responseSerialize(item).length   // Protobuf 바이트
Buffer.byteLength(JSON.stringify(item))                                  // JSON 바이트`,
  async run({ rec }) {
    const { def, Catalog } = loadCatalog();
    const COUNT = 1000;
    const items = Array.from({ length: COUNT }, (_, i) => makeItem(i));
    const server = new grpc.Server();
    server.addService(Catalog.service, {
      GetItem: (call: grpc.ServerUnaryCall<{ id: number }, Item>, cb: grpc.sendUnaryData<Item>) => {
        const it = items[call.request.id];
        if (!it) return cb({ code: grpc.status.NOT_FOUND, details: `item ${call.request.id} 없음` });
        cb(null, it);
      },
      ListItems: (call: grpc.ServerWritableStream<{ count: number }, Item>) => {
        for (let i = 0; i < Math.min(call.request.count, COUNT); i++) call.write(items[i]);
        call.end();
      },
    });
    const port = await listen(server);
    const httpServer = http.createServer((req, res) => {
      if (req.url === "/items") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(items));
      }
      const m = /^\/items\/(\d+)$/.exec(req.url ?? "");
      if (m) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(items[Number(m[1])]));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    const httpPort = (httpServer.address() as { port: number }).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const getJson = (p: string) =>
      new Promise<string>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: httpPort, path: p, agent }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        }).on("error", reject);
      });
    const client = new Catalog(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as unknown as CatalogClient;
    rec.note(`gRPC 서버 127.0.0.1:${port}, JSON HTTP 서버 127.0.0.1:${httpPort} (keep-alive, 연결 1개)`);
    try {
      const getItem = (id: number) => unary<Item>((cb) => client.GetItem({ id }, cb));
      await getItem(0);
      await getJson("/items/0");

      const t = async <T,>(fn: () => Promise<T>) => {
        const t0 = performance.now();
        const r = await fn();
        return { ms: Math.round((performance.now() - t0) * 10) / 10, r };
      };
      const seq = await rec.measure("gRPC unary 1000번 순차 (await 하나씩)", () =>
        t(async () => {
          let n = 0;
          for (let i = 0; i < COUNT; i++) n += (await getItem(i)).id === i ? 1 : 0;
          return n;
        }),
      );
      const par = await rec.measure("gRPC unary 1000번 동시 (Promise.all — HTTP/2 한 연결에 스트림 1000개)", () => t(async () => (await Promise.all(items.map((it) => getItem(it.id)))).length));
      const stream = await rec.measure("gRPC 서버 스트리밍 1번 (ListItems count=1000)", () =>
        t(async () => {
          let n = 0;
          for await (const it of client.ListItems({ count: COUNT }) as AsyncIterable<Item>) if (it.name) n++;
          return n;
        }),
      );
      const jsonOne = await rec.measure("JSON/HTTP 1번 (GET /items — 배열 1000개)", () => t(async () => (JSON.parse(await getJson("/items")) as Item[]).length));
      const jsonSeq = await rec.measure("JSON/HTTP 1000번 순차 (GET /items/:id, keep-alive)", () =>
        t(async () => {
          let n = 0;
          for (let i = 0; i < COUNT; i++) n += (JSON.parse(await getJson(`/items/${i}`)) as Item).id === i ? 1 : 0;
          return n;
        }),
      );
      const rows = [
        ["gRPC unary 순차 ×1000", seq.ms, seq.r],
        ["gRPC unary 동시 ×1000", par.ms, par.r],
        ["gRPC 서버 스트리밍 ×1", stream.ms, stream.r],
        ["JSON/HTTP 배열 ×1", jsonOne.ms, jsonOne.r],
        ["JSON/HTTP 순차 ×1000", jsonSeq.ms, jsonSeq.r],
      ] as const;
      rec.steps.push({ cmd: "지연 비교 (같은 1000개 항목)", result: rows.map(([way, ms, n]) => ({ 방식: way, "ms": ms, "받은 항목": n, "항목당(µs)": Math.round((ms / COUNT) * 1000) })), ms: 0 });

      const svc = (def as Record<string, Record<string, { responseSerialize: (v: unknown) => Buffer }>>)["study.catalog.v1.Catalog"];
      const pbBytes = items.reduce((a, it) => a + svc.GetItem.responseSerialize(it).length, 0);
      const jsonBytes = items.reduce((a, it) => a + Buffer.byteLength(JSON.stringify(it)), 0);
      const jsonArray = Buffer.from(JSON.stringify(items));
      const gz = zlib.gzipSync(jsonArray).length;
      const pbAll = Buffer.concat(items.map((it) => svc.GetItem.responseSerialize(it)));
      const pbGz = zlib.gzipSync(pbAll).length;
      const sample = svc.GetItem.responseSerialize(items[1]);
      rec.steps.push({
        cmd: "페이로드 크기 (항목 1000개)",
        result: [
          { 형식: "Protobuf (항목 합)", 바이트: pbBytes, 항목당: Math.round(pbBytes / COUNT) },
          { 형식: "JSON (항목 합)", 바이트: jsonBytes, 항목당: Math.round(jsonBytes / COUNT) },
          { 형식: "JSON 배열 + gzip", 바이트: gz, 항목당: Math.round(gz / COUNT) },
          { 형식: "Protobuf + gzip", 바이트: pbGz, 항목당: Math.round(pbGz / COUNT) },
        ],
        ms: 0,
      });
      rec.steps.push({ cmd: `items[1] 의 Protobuf 바이트 (hex) — 08=필드1 varint, 12=필드2 길이접두, 18=필드3 varint, 22=필드4 반복 문자열, 28=필드5 bool`, result: sample.toString("hex").replace(/(..)/g, "$1 ").trim(), ms: 0 });
      rec.check("1000개를 모든 방식에서 다 받았다", rows.every(([, , n]) => n === COUNT));
      rec.check("서버 스트리밍 1회가 unary 1000회 순차보다 빠르다 (왕복 1번 vs 1000번)", stream.ms < seq.ms, { stream: stream.ms, seq: seq.ms });
      rec.check("HTTP/2 다중화 덕에 동시 unary 가 순차 unary 보다 빠르다", par.ms < seq.ms, { par: par.ms, seq: seq.ms });
      rec.check("Protobuf 가 JSON 보다 작다 (필드 이름 대신 번호, 정수 varint)", pbBytes < jsonBytes, { pbBytes, jsonBytes, ratio: Math.round((pbBytes / jsonBytes) * 100) + "%" });
      rec.note(`압축 전에는 Protobuf 가 JSON 의 ${Math.round((pbBytes / jsonBytes) * 100)}% 지만, gzip 을 걸면 JSON ${gz.toLocaleString()}B · Protobuf ${pbGz.toLocaleString()}B 로 둘 다 크게 줄고 차이가 작아진다(이 데이터는 반복이 많아 압축이 특히 잘 된다). 크기만이 이유라면 JSON+압축으로 충분할 때가 많다. gRPC 의 진짜 이점은 스키마 계약·코드 생성·스트리밍·데드라인이다.`);
      rec.note(`덤으로 보이는 사실: 한 번에 배열로 받는 JSON(${jsonOne.ms}ms)이 메시지 1000개를 흘리는 스트리밍(${stream.ms}ms)보다 빠르다. 스트리밍은 메시지마다 프레이밍·직렬화·콜백 비용을 낸다. 스트리밍의 가치는 '전체가 메모리에 다 올라오기 전에 첫 항목을 처리하는 것'과 '끝이 없는 흐름'에 있지, 작은 고정 목록의 속도에 있지 않다.`);
    } finally {
      client.close();
      agent.destroy();
      await new Promise<void>((r) => httpServer.close(() => r()));
      await shutdown(server);
    }
  },
};

// ------------------------------------------------------------------ 데드라인·취소·전파
export const apiGrpcDeadlineCancel: CodeExperiment = {
  id: "api-grpc-deadline-cancel",
  subject: "api-design",
  title: "gRPC 데드라인과 취소: 200ms 데드라인은 서버의 작업까지 멈추게 하고, parent 로 넘기면 하위 호출에도 전파된다",
  category: "gRPC",
  summary: "1초 걸리는 핸들러를 200ms 데드라인으로 부르면 DEADLINE_EXCEEDED 가 오고 서버가 call.cancelled 를 보고 작업을 멈추는지, 클라이언트 cancel() 이 CANCELLED 로 서버에 전달되는지, Chain→SlowWork 2단 호출에서 데드라인을 전파할 때와 안 할 때 하위 서버가 헛일을 얼마나 하는지 잰다",
  notes: ["04-errors-retries-deadlines", "03-protobuf-grpc"],
  description: `
**타임아웃은 호출마다, 데드라인은 요청 전체에.** 사용자 요청이 300ms 안에 끝나야 한다면 그 아래 모든 호출이 "남은 시간" 을 알아야 한다.
- gRPC 클라이언트가 \`deadline\` 을 주면 \`grpc-timeout\` 헤더로 서버에 전달된다. 시간이 지나면 클라이언트는 \`DEADLINE_EXCEEDED\` 를 받고, 서버 쪽 call 에는 \`cancelled\` 가 켜진다.
- 서버 핸들러가 \`call.cancelled\` 를 보지 않으면 **아무도 기다리지 않는 응답을 끝까지 계산**한다. 큐가 밀린 상황에서 이 헛일이 장애를 키운다.
- 서버가 다시 하위 서비스를 부를 때 \`{ parent: call }\` 을 넘기면 grpc-js 가 데드라인과 취소를 **자동 전파**한다. 안 넘기면 하위 호출은 자기만의 시계로 끝까지 간다.
`,
  code: `// 서버: 50ms 마다 취소 여부를 확인하며 일한다
SlowWork(call, cb) {
  for (let step = 0; step < call.request.ms / 50; step++) {
    if (call.cancelled) return;          // 클라이언트가 떠났다 → 멈춘다
    await sleep(50);
  }
  cb(null, { stepsDone });
}
// 중계 서버: parent 로 넘기면 데드라인·취소가 전파된다
Chain(call, cb) {
  downstream.SlowWork(call.request, call.request.propagate ? { parent: call } : {}, cb);
}
// 클라이언트
client.SlowWork({ ms: 1000 }, { deadline: Date.now() + 200 }, cb);   // → DEADLINE_EXCEEDED (4)
const c = client.SlowWork({ ms: 2000 }, {}, cb); setTimeout(() => c.cancel(), 300);   // → CANCELLED (1)`,
  async run({ rec }) {
    const { Catalog } = loadCatalog();
    type Seen = { label: string; started: number; stoppedAt?: number; stepsDone: number; cancelledSeen: boolean; deadlineMsLeft?: number; finished: boolean };
    const seen: Seen[] = [];
    let currentLabel = "";
    const server = new grpc.Server();
    let downstream: CatalogClient | null = null;
    server.addService(Catalog.service, {
      GetItem: (_c: unknown, cb: grpc.sendUnaryData<Item>) => cb(null, makeItem(0)),
      ListItems: (c: grpc.ServerWritableStream<unknown, Item>) => c.end(),
      SlowWork: async (call: grpc.ServerUnaryCall<{ ms: number }, { stepsDone: number }>, cb: grpc.sendUnaryData<{ stepsDone: number }>) => {
        const dl = call.getDeadline();
        const rec2: Seen = { label: (call.metadata.get("x-label")[0] as string) ?? currentLabel, started: performance.now(), stepsDone: 0, cancelledSeen: false, finished: false, deadlineMsLeft: dl instanceof Date ? dl.getTime() - Date.now() : typeof dl === "number" && Number.isFinite(dl) ? dl - Date.now() : undefined };
        seen.push(rec2);
        const steps = Math.ceil(call.request.ms / 50);
        for (let i = 0; i < steps; i++) {
          if (call.cancelled) {
            rec2.cancelledSeen = true;
            rec2.stoppedAt = Math.round(performance.now() - rec2.started);
            return;
          }
          await sleep(50);
          rec2.stepsDone++;
        }
        rec2.finished = true;
        rec2.stoppedAt = Math.round(performance.now() - rec2.started);
        cb(null, { stepsDone: rec2.stepsDone });
      },
      Chain: (call: grpc.ServerUnaryCall<{ ms: number; propagate: boolean }, { stepsDone: number }>, cb: grpc.sendUnaryData<{ stepsDone: number }>) => {
        const md = new grpc.Metadata();
        md.set("x-label", call.request.propagate ? "downstream-propagated" : "downstream-isolated");   // 메타데이터 값은 ASCII 만 (바이너리는 -bin 키)
        const opts: grpc.CallOptions = call.request.propagate ? { parent: call as unknown as grpc.ServerUnaryCall<unknown, unknown> } : {};
        (downstream as unknown as { SlowWork: (r: unknown, m: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, r: { stepsDone: number }) => void) => void }).SlowWork({ ms: call.request.ms }, md, opts, (err, res) => (err ? cb(err) : cb(null, res)));
      },
    });
    const port = await listen(server);
    const client = new Catalog(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as unknown as CatalogClient;
    downstream = new Catalog(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as unknown as CatalogClient;
    const call = (fn: "SlowWork" | "Chain", req: { ms: number; propagate?: boolean }, opts: grpc.CallOptions, cancelAfter?: number) =>
      new Promise<{ code: number; name: string; ms: number }>((resolve) => {
        const t0 = performance.now();
        const c = client[fn](req, opts, (err) => {
          const code = err ? err.code : grpc.status.OK;
          resolve({ code, name: grpc.status[code], ms: Math.round(performance.now() - t0) });
        });
        if (cancelAfter) setTimeout(() => c.cancel(), cancelAfter);
      });
    const waitServer = async (label: string) => {
      for (let i = 0; i < 60; i++) {
        const s = seen.find((x) => x.label === label);
        if (s && s.stoppedAt !== undefined) return s;
        await sleep(50);
      }
      return seen.find((x) => x.label === label);
    };
    try {
      currentLabel = "데드라인 200ms";
      const a = await rec.measure("SlowWork({ ms: 1000 }, { deadline: now + 200ms })", () => call("SlowWork", { ms: 1000 }, { deadline: Date.now() + 200 }));
      const sa = await waitServer(currentLabel);
      rec.check("클라이언트는 약 200ms 에 DEADLINE_EXCEEDED(4) 를 받는다", a.code === grpc.status.DEADLINE_EXCEEDED && a.ms >= 180 && a.ms < 450, a);
      rec.check("서버 핸들러도 call.cancelled 를 보고 1초 작업을 중간에 멈췄다", !!sa?.cancelledSeen && (sa?.stoppedAt ?? 9999) < 500, sa);

      currentLabel = "클라이언트 취소 300ms";
      const b = await rec.measure("SlowWork({ ms: 2000 }) 후 300ms 에 call.cancel()", () => call("SlowWork", { ms: 2000 }, {}, 300));
      const sb = await waitServer(currentLabel);
      rec.check("클라이언트는 CANCELLED(1), 서버는 취소를 감지해 멈춤", b.code === grpc.status.CANCELLED && !!sb?.cancelledSeen && (sb?.stoppedAt ?? 9999) < 600, { client: b, server: sb });

      currentLabel = "";
      const c = await rec.measure("Chain({ ms: 1000, propagate: true }, deadline 300ms) → 하위 SlowWork 에 { parent: call }", () => call("Chain", { ms: 1000, propagate: true }, { deadline: Date.now() + 300 }));
      const sc = await waitServer("downstream-propagated");
      const d = await rec.measure("Chain({ ms: 1000, propagate: false }, deadline 300ms) → 하위 호출에 데드라인 없음", () => call("Chain", { ms: 1000, propagate: false }, { deadline: Date.now() + 300 }));
      const sd = await waitServer("downstream-isolated");
      rec.steps.push({
        cmd: "2단 호출: 하위 서버가 본 남은 시간과 실제로 한 일",
        result: [
          { 경우: "전파함 (parent: call)", 클라이언트: `${c.name} @${c.ms}ms`, "하위가 받은 남은 시간(ms)": sc?.deadlineMsLeft ?? "없음", "하위가 멈춘 시점(ms)": sc?.stoppedAt, "끝까지 했나": sc?.finished },
          { 경우: "전파 안 함", 클라이언트: `${d.name} @${d.ms}ms`, "하위가 받은 남은 시간(ms)": sd?.deadlineMsLeft ?? "없음 (무한)", "하위가 멈춘 시점(ms)": sd?.stoppedAt, "끝까지 했나": sd?.finished },
        ],
        ms: 0,
      });
      rec.check("전파하면 하위도 300ms 안쪽 데드라인을 받고 곧 멈춘다", c.code === grpc.status.DEADLINE_EXCEEDED && (sc?.deadlineMsLeft ?? 9999) <= 300 && !sc?.finished, sc);
      rec.check("전파하지 않으면 사용자는 이미 떠났는데 하위는 1초 작업을 끝까지 한다 (헛일)", d.code === grpc.status.DEADLINE_EXCEEDED && !!sd?.finished && (sd?.stoppedAt ?? 0) >= 950, sd);
      rec.note("HTTP/REST 에도 같은 원리가 있다: 요청 시작 시각 + 예산을 헤더(예: x-request-deadline)로 넘기고, 각 홉이 남은 시간으로 하위 타임아웃을 정한다. AbortController 를 fetch·DB 드라이버까지 넘기면 취소도 전파된다.");
    } finally {
      client.close();
      downstream.close();
      await shutdown(server);
    }
  },
};

// ------------------------------------------------------------------ 멱등 키
export const apiIdempotencyKey: CodeExperiment = {
  id: "api-idempotency-key",
  subject: "api-design",
  title: "Idempotency-Key: 같은 결제 요청을 동시에 10번 보내도 결제는 한 번, 나머지 9번은 같은 결과를 재생한다",
  category: "REST",
  summary: "Node HTTP 서버로 POST /payments 를 만들고 Redis SET NX 로 키를 선점한다. 같은 키 동시 재시도 10개 → 결제 1건·응답 10개 동일, 같은 키에 다른 본문 → 422, 키 없이 10번 → 결제 10건을 비교한다",
  notes: ["01-rest-principles", "06-gateway-auth-ratelimit"],
  description: `
POST 는 멱등이 아니다. 네트워크가 끊겨 클라이언트가 **응답을 못 받으면** 결제가 됐는지 모른 채 재시도한다. 그 재시도가 결제를 두 번 만든다.
해법은 클라이언트가 요청마다 고유한 \`Idempotency-Key\` 를 붙이고, 서버가 그 키로 **첫 요청만 처리하고 결과를 저장했다가 재요청에 그대로 돌려주는** 것이다(Stripe 방식, IETF 초안 \`Idempotency-Key\` 헤더).
1. \`SET idem:<key> {processing, 요청해시} NX EX 86400\` — 원자적 선점. 실패하면 이미 누가 처리 중이거나 끝났다.
2. 처리 중이면 잠깐 기다렸다가 결과를 주거나 409, 끝났으면 저장된 응답을 그대로(\`Idempotent-Replayed: true\`).
3. 같은 키에 **다른 본문**이면 클라이언트 버그다 → 422.
더 깊은 원장·정산 이야기는 [결제와 원장 정합성](/architecture/notes/09-payments-ledger-consistency).
사전 준비: Redis(6379)
`,
  code: `POST /payments  Idempotency-Key: 7c1e…   { "amount": 39000 }
const ok = await redis.set(\`idem:\${key}\`, JSON.stringify({ state: "processing", hash }), "EX", 86400, "NX");
if (!ok) {
  const saved = JSON.parse(await redis.get(\`idem:\${key}\`));
  if (saved.hash !== hash) return 422;                       // 같은 키, 다른 요청
  if (saved.state === "processing") return waitOrConflict(); // 처리 중
  return replay(saved.response);                             // Idempotent-Replayed: true
}
const payment = await charge(body);                          // 실제 부작용은 여기서 한 번
await redis.set(\`idem:\${key}\`, JSON.stringify({ state: "done", hash, response }), "EX", 86400);`,
  requires: async () => {
    const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    try {
      await r.connect();
      await r.ping();
      return null;
    } catch {
      return "Redis(6379) 에 연결할 수 없습니다. `pnpm redis:docker` 또는 `pnpm redis`.";
    } finally {
      r.disconnect();
    }
  },
  async run({ rec, k }) {
    const redis = new Redis(REDIS_URL);
    const chargesKey = k("charges");
    const idemKey = (key: string) => k(`idem:${key}`);
    const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
    let paymentSeq = 0;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString();
      const key = req.headers["idempotency-key"] as string | undefined;
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      const charge = async () => {
        await redis.incr(chargesKey);
        await sleep(80);
        return { id: `pay_${++paymentSeq}`, amount: (JSON.parse(body) as { amount: number }).amount, status: "succeeded" };
      };
      if (!key) return send(201, await charge());
      const hash = hashOf(body);
      const claimed = await redis.set(idemKey(key), JSON.stringify({ state: "processing", hash }), "EX", 600, "NX");
      if (claimed) {
        const payment = await charge();
        await redis.set(idemKey(key), JSON.stringify({ state: "done", hash, status: 201, response: payment }), "EX", 600);
        return send(201, payment);
      }
      for (let i = 0; i < 50; i++) {
        const saved = JSON.parse((await redis.get(idemKey(key))) ?? "{}") as { state?: string; hash?: string; status?: number; response?: unknown };
        if (saved.hash && saved.hash !== hash) return send(422, { error: "같은 Idempotency-Key 에 다른 요청 본문" });
        if (saved.state === "done") return send(saved.status ?? 200, saved.response, { "Idempotent-Replayed": "true" });
        await sleep(20);
      }
      return send(409, { error: "같은 키의 요청이 아직 처리 중" });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const post = (body: unknown, key?: string) =>
      new Promise<{ status: number; replayed: boolean; body: { id?: string; error?: string } }>((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: "127.0.0.1", port, path: "/payments", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...(key ? { "Idempotency-Key": key } : {}) } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, replayed: res.headers["idempotent-replayed"] === "true", body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
        });
        req.on("error", reject);
        req.end(data);
      });
    try {
      await redis.del(chargesKey);
      const key = `order-42-${Date.now()}`;
      const same = await rec.measure(`같은 Idempotency-Key 로 POST /payments 10개 동시 전송 (key=${key})`, () => Promise.all(Array.from({ length: 10 }, () => post({ amount: 39000 }, key))));
      const charges1 = Number(await redis.get(chargesKey));
      const ids = new Set(same.map((r) => r.body.id));
      rec.steps.push({ cmd: "응답 10개 요약", result: { status: [...new Set(same.map((r) => r.status))], 결제ID: [...ids], 재생응답: same.filter((r) => r.replayed).length, 실제결제: charges1 }, ms: 0 });
      rec.check("실제 결제는 1번", charges1 === 1, charges1);
      rec.check("10개 응답이 모두 같은 결제 ID — 9개는 저장된 응답 재생(Idempotent-Replayed)", ids.size === 1 && same.filter((r) => r.replayed).length === 9, { ids: [...ids] });
      const mismatch = await rec.measure("같은 키에 다른 금액으로 재요청", () => post({ amount: 99000 }, key));
      rec.check("같은 키 + 다른 본문 → 422 (클라이언트 버그를 조용히 넘기지 않는다)", mismatch.status === 422, mismatch);
      const later = await rec.measure("같은 키·같은 본문으로 한참 뒤 재요청 (재시도)", () => post({ amount: 39000 }, key));
      rec.check("나중 재시도도 같은 결과를 재생하고 결제는 늘지 않는다", later.replayed && later.body.id === [...ids][0] && Number(await redis.get(chargesKey)) === 1, later);
      await redis.del(chargesKey);
      const noKey = await rec.measure("키 없이 POST /payments 10개 동시 전송", () => Promise.all(Array.from({ length: 10 }, () => post({ amount: 39000 }))));
      const charges2 = Number(await redis.get(chargesKey));
      rec.check("키가 없으면 재시도 10번 = 결제 10건 (이중 결제)", charges2 === 10 && new Set(noKey.map((r) => r.body.id)).size === 10, charges2);
      const ttl = await redis.ttl(idemKey(key));
      rec.note(`키는 ${ttl}초 후 만료된다(실험은 600초, 운영은 보통 24시간). 만료 뒤의 재시도는 새 요청으로 처리되므로, 클라이언트의 재시도 기간보다 길게 잡는다. 처리 도중 서버가 죽으면 'processing' 이 남는다 — 짧은 처리 TTL 을 두고 만료되면 재처리하거나, 결제 대행사의 멱등 키에 같은 값을 넘겨 이중 청구를 그쪽에서도 막는다.`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      const keys = await redis.keys(`${k("")}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
  },
};
