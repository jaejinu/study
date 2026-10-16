import { armDeadman, type Deadman } from "@/lib/deadman";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

/**
 * 네트워크 프로토콜 실험 — 사용자 정의 Docker 네트워크에 서버·클라이언트 컨테이너를 두고,
 * 한쪽 컨테이너의 eth0 에 tc netem 으로 지연·손실·대역폭 제한을 건 뒤 TCP·HTTP 의 반응을 잰다.
 *
 * - 이미지 study-netp:2 = nginx:1.27-alpine + iproute2 · curl · iperf3 · ethtool · ping (처음 실행할 때 빌드)
 * - 컨테이너: lab-netp-srv · lab-netp-cli, 네트워크: lab-netp-net (호스트 포트를 열지 않는다)
 * - netem 은 컨테이너 자신의 네트워크 네임스페이스에만 걸리므로 호스트·다른 컨테이너에는 영향이 없다
 * - 데드맨 스위치: 실험이 중간에 끊겨도 10분 뒤 lab 컨테이너·네트워크가 지워진다
 */

const IMAGE = "study-netp:2";
const NET = "lab-netp-net";
const SRV = "lab-netp-srv";
const CLI = "lab-netp-cli";
const DOCKERFILE = "FROM nginx:1.27-alpine\nRUN apk add --no-cache iproute2 curl iperf3 iputils ethtool\n";

async function requiresDocker(): Promise<string | null> {
  const d = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 8000 });
  if (!d.ok) return "Docker 데몬이 필요합니다 (Docker Desktop 실행). 이 실험은 컨테이너 안에서 tc netem 으로 지연·손실을 주입합니다.";
  return null;
}

async function ensureImage(ctx: ShellCtx) {
  const has = await exec("docker", ["image", "inspect", IMAGE], { timeout: 10_000 });
  if (has.ok) return;
  await ctx.sh("docker", ["build", "-q", "-t", IMAGE, "-"], { input: DOCKERFILE, timeout: 600_000, label: `docker build -t ${IMAGE} -   # nginx:1.27-alpine + iproute2·curl·iperf3·ethtool (첫 실행만)` });
}

async function teardown(ctx: ShellCtx) {
  await ctx.sh("docker", ["rm", "-f", SRV, CLI], { allowFail: true, label: `docker rm -f ${SRV} ${CLI}   # 정리` });
  await ctx.sh("docker", ["network", "rm", NET], { allowFail: true, label: `docker network rm ${NET}` });
}

/** 서버(iperf3 -s + nginx)와 클라이언트를 띄우고, 정확한 netem 을 위해 두 컨테이너의 세그먼트 오프로드를 끈다 */
async function setup(ctx: ShellCtx): Promise<Deadman> {
  await ensureImage(ctx);
  await exec("docker", ["rm", "-f", SRV, CLI]);
  await exec("docker", ["network", "rm", NET]);
  const guard = armDeadman(`docker rm -f ${SRV} ${CLI}; docker network rm ${NET}`, 600);
  ctx.note(`데드맨 스위치 장전 (pid ${guard.pid}): 실험이 중단돼도 10분 뒤 lab 컨테이너·네트워크를 지운다`);
  await ctx.sh("docker", ["network", "create", NET]);
  await ctx.sh("docker", ["run", "-d", "--name", SRV, "--network", NET, "--cap-add", "NET_ADMIN", IMAGE, "sh", "-c", 'iperf3 -s -D; exec nginx -g "daemon off;"'], { label: `docker run -d --name ${SRV} --cap-add NET_ADMIN ${IMAGE}   # iperf3 서버 + nginx` });
  await ctx.sh("docker", ["run", "-d", "--name", CLI, "--network", NET, "--cap-add", "NET_ADMIN", IMAGE, "sleep", "3600"], { label: `docker run -d --name ${CLI} --cap-add NET_ADMIN ${IMAGE} sleep 3600` });
  for (const c of [SRV, CLI]) {
    await ctx.sh("docker", ["exec", c, "ethtool", "-K", "eth0", "gso", "off", "tso", "off", "gro", "off"], { allowFail: true, label: `docker exec ${c} ethtool -K eth0 gso off tso off gro off   # netem 이 64KB 묶음이 아니라 실제 패킷 단위로 보게` });
  }
  await ctx.poll("iperf3 서버 준비 (5201 LISTEN)", async () => ((await exec("docker", ["exec", SRV, "sh", "-c", "netstat -lnt | grep -q ':5201 '"])).ok ? true : undefined), { timeoutMs: 20_000, intervalMs: 500 });
  return guard;
}

/** 컨테이너 eth0 의 root qdisc 를 netem 으로 (없으면 add, 있으면 replace) */
async function netem(ctx: ShellCtx, container: string, spec: string) {
  await ctx.sh("docker", ["exec", container, "sh", "-c", `tc qdisc replace dev eth0 root netem ${spec}`], { label: `docker exec ${container} tc qdisc replace dev eth0 root netem ${spec}` });
}

async function clearNetem(container: string) {
  await exec("docker", ["exec", container, "tc", "qdisc", "del", "dev", "eth0", "root"]);
}

type Iperf = { mbps: number; retrans: number; rttMs: number };

/** 클라이언트 → 서버 업로드 처리량 (iperf3 JSON) */
async function iperf(ctx: ShellCtx, seconds: number, cc: string, label: string): Promise<Iperf> {
  const r = await ctx.sh("docker", ["exec", CLI, "iperf3", "-c", SRV, "-t", String(seconds), "-J", "-C", cc], { allowFail: true, timeout: (seconds + 30) * 1000, label });
  try {
    const d = JSON.parse(r.out) as { end: { sum_received: { bits_per_second: number }; sum_sent: { retransmits?: number }; streams?: { sender?: { mean_rtt?: number } }[] } };
    return { mbps: d.end.sum_received.bits_per_second / 1e6, retrans: d.end.sum_sent.retransmits ?? 0, rttMs: (d.end.streams?.[0]?.sender?.mean_rtt ?? 0) / 1000 };
  } catch {
    return { mbps: 0, retrans: 0, rttMs: 0 };
  }
}

/** Mathis et al. (1997): 손실률 p, 왕복 RTT 에서 Reno 류 TCP 의 처리량 상한 ≈ MSS/RTT · 1.22/√p */
function mathisMbps(rttMs: number, loss: number, mss = 1448): number {
  if (loss <= 0 || rttMs <= 0) return Infinity;
  return ((mss / (rttMs / 1000)) * (1.22 / Math.sqrt(loss)) * 8) / 1e6;
}

const f1 = (n: number) => (Number.isFinite(n) ? (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) : "—");

// ------------------------------------------------------------------------------------------ 1. 손실·지연과 처리량
export const netpLossThroughput: ShellExperiment = {
  id: "netp-loss-throughput",
  subject: "network-protocols",
  title: "손실·지연과 TCP 처리량: 같은 링크라도 RTT 와 손실률이 처리량을 수십 배 갈라놓는다",
  category: "TCP",
  summary: "클라이언트 컨테이너의 송신 방향에 netem 으로 지연 0/25/100ms × 손실 0/1/5% 를 걸고 iperf3 로 5초씩 업로드 처리량을 잰 뒤, 손실이 있을 때 Mathis 공식(MSS/RTT·1.22/√p)의 예측과 나란히 놓는다",
  notes: ["05-loss-latency-throughput", "04-congestion-control"],
  description: `
TCP 는 "보낼 수 있는 만큼" 보내지 않는다. 혼잡 윈도(cwnd)만큼만 보내고 ACK 가 돌아와야 다음을 보내므로 **처리량 ≈ cwnd / RTT** 다.
손실이 생기면 cwnd 를 깎으므로, 손실률 p 와 RTT 가 정하는 상한이 생긴다 — Mathis 공식 \`처리량 ≲ MSS/RTT · 1.22/√p\`.
이 실험은 같은 Docker 네트워크(사실상 무한 대역폭)에서 **지연과 손실만** 바꿔 처리량이 얼마나 무너지는지 9칸 표로 보여 준다.
netem 은 클라이언트 eth0 의 송신 방향에만 걸어 데이터 경로(클라이언트 → 서버)에 지연과 손실을 준다. RTT 는 거의 지연값 그대로가 된다.
`,
  code: `docker network create lab-netp-net
docker run -d --name lab-netp-srv --network lab-netp-net --cap-add NET_ADMIN study-netp:2 sh -c 'iperf3 -s -D; exec nginx -g "daemon off;"'
docker run -d --name lab-netp-cli --network lab-netp-net --cap-add NET_ADMIN study-netp:2 sleep 3600
docker exec lab-netp-cli ethtool -K eth0 gso off tso off gro off
docker exec lab-netp-cli tc qdisc replace dev eth0 root netem delay 100ms loss 1%
docker exec lab-netp-cli iperf3 -c lab-netp-srv -t 5 -J | jq '.end.sum_received.bits_per_second/1e6'
docker exec lab-netp-cli ss -ti   # cwnd·rtt·retrans 를 소켓 단위로`,
  requires: requiresDocker,
  cleanup: teardown,
  async run(ctx) {
    const guard = await setup(ctx);
    try {
      const delays = [0, 25, 100];
      const losses = [0, 0.01, 0.05];
      const rows: string[][] = [];
      const grid = new Map<string, Iperf>();
      for (const d of delays) {
        for (const p of losses) {
          const spec = `${d ? `delay ${d}ms` : ""}${p ? ` loss ${p * 100}%` : ""}`.trim() || "delay 0ms";
          await netem(ctx, CLI, spec);
          const r = await iperf(ctx, 5, "cubic", `iperf3 -c ${SRV} -t 5   # ${spec}`);
          grid.set(`${d}/${p}`, r);
          const pred = p > 0 ? mathisMbps(Math.max(d, 0.2), p) : Infinity;
          rows.push([`${d}ms`, `${p * 100}%`, f1(r.mbps), String(r.retrans), f1(r.rttMs), p > 0 ? f1(pred) : "제한 없음", p > 0 && Number.isFinite(pred) ? `${(r.mbps / pred).toFixed(1)}×` : "—"]);
        }
      }
      await clearNetem(CLI);
      ctx.table("업로드 처리량 (iperf3 5초, cubic)", ["추가 지연", "손실", "Mbit/s", "재전송", "측정 RTT(ms)", "Mathis 예측(Mbit/s)", "측정/예측"], rows);
      const g = (d: number, p: number) => grid.get(`${d}/${p}`)?.mbps ?? 0;
      ctx.check("모든 칸에서 데이터가 흘렀다", [...grid.values()].every((x) => x.mbps > 0.05), JSON.stringify([...grid.entries()].map(([k, v]) => [k, v.mbps.toFixed(2)])));
      ctx.check("지연 100ms 에서 손실 0% → 1% → 5% 로 갈수록 처리량이 줄어든다", g(100, 0) > g(100, 0.01) && g(100, 0.01) > g(100, 0.05), `${g(100, 0).toFixed(1)} > ${g(100, 0.01).toFixed(2)} > ${g(100, 0.05).toFixed(2)}`);
      ctx.check("손실 1% 에서 지연 25ms → 100ms 로 늘면 처리량이 줄어든다 (처리량 ∝ 1/RTT)", g(25, 0.01) > g(100, 0.01), `${g(25, 0.01).toFixed(2)} > ${g(100, 0.01).toFixed(2)}`);
      const m1 = g(100, 0.01) / mathisMbps(100, 0.01);
      ctx.check("지연 100ms·손실 1% 의 측정값이 Mathis 예측과 같은 자릿수 (0.2×~5×)", m1 > 0.2 && m1 < 5, `${m1.toFixed(2)}×`);
      ctx.note(`손실이 없어도 지연 100ms 에서 ${f1(g(100, 0))} Mbit/s 에 머무는 이유는 대역폭이 아니라 윈도/RTT 다: 소켓 송신 버퍼 최대 4MB(tcp_wmem) / 0.1s ≈ 320 Mbit/s 가 BDP 상한이고, 5초 안에 슬로 스타트가 다 올라가지도 못한다.`);
      ctx.note("Mathis 는 Reno 류의 거친 상한이다. CUBIC 은 손실 후 회복이 빨라 같은 조건에서 예측보다 조금 높게 나오는 경우가 많다(측정/예측 > 1). 손실 5% 처럼 극단에서는 타임아웃(RTO)이 섞여 예측보다 낮아질 수 있다.");
    } finally {
      await teardown(ctx);
      guard.disarm();
    }
  },
};

// ------------------------------------------------------------------------------------------ 2. HTTP/1.1 vs HTTP/2
export const netpH1VsH2: ShellExperiment = {
  id: "netp-h1-vs-h2",
  subject: "network-protocols",
  title: "HTTP/1.1 vs HTTP/2: 파일 50개를 지연 50ms 링크로 — 다중화가 이기는 조건과 지는 조건",
  category: "HTTP",
  summary: "nginx(http2 on, 평문 h2c)에서 파일 50개를 curl --parallel 로 받는다. 1KB(요청 왕복이 지배)와 20KB(데이터량이 지배) 두 크기로, HTTP/1.1 연결 1개·6개와 HTTP/2 다중화 1연결을 지연 0ms / 50ms / 50ms+손실 2% 에서 3회씩 재 중앙값을 비교한다. 다중화의 이득, 한 연결의 슬로 스타트 한계, TCP 머리 막힘을 한 표에서 본다",
  notes: ["01-http1-http2-http3", "02-quic", "04-congestion-control"],
  description: `
HTTP/1.1 은 한 연결에서 요청을 하나씩만 주고받는다(파이프라이닝은 사실상 사용되지 않음). 그래서 브라우저는 출처당 **연결 6개**를 열고, 50개 리소스는 최소 50/6 ≈ 9 왕복이 걸린다.
HTTP/2 는 한 연결 위에 스트림을 **다중화**해 50개 요청을 한 왕복에 보낸다. 리소스가 작아 **요청 왕복이 지배**하면 HTTP/2 가 크게 이긴다.
하지만 데이터가 많아지면 다른 한계가 나온다. 연결 하나의 혼잡 윈도는 초기 10 세그먼트에서 슬로 스타트로 커지는데, 연결 6개는 처음부터 **6배의 윈도**로 시작한다. 그리고 HTTP/2 의 모든 스트림은 TCP 한 줄을 공유하므로 패킷 하나의 손실이 모든 스트림을 세운다 — **TCP 머리 막힘**. HTTP/3(QUIC)이 UDP 위에서 스트림별 순서와 혼잡 제어를 따로 두는 이유다.
`,
  code: `# nginx: server { listen 80; http2 on; root /usr/share/nginx/html; }   (평문 h2c — curl 은 prior knowledge 로)
docker exec lab-netp-srv tc qdisc replace dev eth0 root netem delay 50ms
curl -s --http1.1 --parallel --parallel-max 6  -o /dev/null … http://lab-netp-srv/s/f{1..50}.bin
curl -s --http2-prior-knowledge --parallel --parallel-max 50 -o /dev/null … http://lab-netp-srv/s/f{1..50}.bin
curl -s -w '%{http_version} %{num_connects}\\n' …   # 실제 버전과 새 연결 수`,
  requires: requiresDocker,
  cleanup: teardown,
  async run(ctx) {
    const guard = await setup(ctx);
    try {
      const conf = "server { listen 80; http2 on; root /usr/share/nginx/html; keepalive_requests 1000; }";
      await ctx.sh("docker", ["exec", SRV, "sh", "-c", `mkdir -p /usr/share/nginx/html/s /usr/share/nginx/html/m && for i in $(seq 1 50); do head -c 1000 /dev/urandom > /usr/share/nginx/html/s/f$i.bin; head -c 20000 /dev/urandom > /usr/share/nginx/html/m/f$i.bin; done; echo '${conf}' > /etc/nginx/conf.d/default.conf; nginx -s reload`], { label: `nginx: 1KB(s/)·20KB(m/) 파일 50개씩 생성, ${conf}` });
      const modes: { key: string; label: string; args: string[] }[] = [
        { key: "h1x1", label: "HTTP/1.1 · 연결 1개", args: ["--http1.1", "--parallel", "--parallel-max", "1"] },
        { key: "h1x6", label: "HTTP/1.1 · 연결 6개", args: ["--http1.1", "--parallel", "--parallel-max", "6"] },
        { key: "h2", label: "HTTP/2 · 다중화 1연결", args: ["--http2-prior-knowledge", "--parallel", "--parallel-max", "50"] },
      ];
      const conds: { key: string; spec: string | null }[] = [
        { key: "0ms", spec: null },
        { key: "50ms", spec: "delay 50ms" },
        { key: "50ms+손실2%", spec: "delay 50ms loss 2%" },
      ];
      const sizes = [
        { key: "s", label: "1KB × 50" },
        { key: "m", label: "20KB × 50" },
      ];
      const result = new Map<string, { ms: number; versions: string; conns: number }>();
      for (const c of conds) {
        if (c.spec) await netem(ctx, SRV, c.spec);
        else await clearNetem(SRV);
        for (const z of sizes) {
          const urls = Array.from({ length: 50 }, (_, i) => `http://${SRV}/${z.key}/f${i + 1}.bin`);
          const outs = urls.flatMap(() => ["-o", "/dev/null"]);
          for (const m of modes) {
            const times: number[] = [];
            let versions = "";
            let conns = 0;
            for (let i = 0; i < 3; i++) {
              const t0 = performance.now();
              const r = await exec("docker", ["exec", CLI, "curl", "-s", ...m.args, "-w", "%{http_version} %{num_connects}\\n", ...outs, ...urls], { timeout: 120_000 });
              times.push(performance.now() - t0);
              const lines = r.out.split("\n").filter(Boolean);
              versions = [...new Set(lines.map((l) => l.split(" ")[0]))].join(",");
              conns = lines.reduce((a, l) => a + Number(l.split(" ")[1] ?? 0), 0);
            }
            times.sort((a, b) => a - b);
            result.set(`${c.key}/${z.key}/${m.key}`, { ms: Math.round(times[1]), versions, conns });
          }
        }
      }
      await clearNetem(SRV);
      ctx.note(`curl 명령 예 (총 ${conds.length * sizes.length * modes.length * 3}회 실행): docker exec ${CLI} curl -s --http2-prior-knowledge --parallel --parallel-max 50 -w '%{http_version} %{num_connects}' -o /dev/null … http://${SRV}/s/f1.bin … f50.bin`);
      const ms = (c: string, z: string, m: string) => result.get(`${c}/${z}/${m}`)?.ms ?? 0;
      for (const z of sizes) {
        ctx.table(`${z.label} 전체 수신 시간 — 3회 중앙값 ms (docker exec 오버헤드 ~수십 ms 포함)`, ["방식", ...conds.map((c) => c.key), "50ms 에서 버전 · 새 연결"], modes.map((m) => [m.label, ...conds.map((c) => String(ms(c.key, z.key, m.key))), `HTTP/${result.get(`50ms/${z.key}/${m.key}`)?.versions} · ${result.get(`50ms/${z.key}/${m.key}`)?.conns}`]));
      }
      const h2 = result.get("50ms/s/h2");
      ctx.check("HTTP/2 는 연결 1개로 50개를 받았다 (다중화)", (h2?.versions ?? "") === "2" && (h2?.conns ?? 99) <= 2, `${h2?.versions} · 새 연결 ${h2?.conns}`);
      ctx.check("지연 50ms 에서 HTTP/1.1 연결 6개는 연결 1개보다 빠르다 (1KB)", ms("50ms", "s", "h1x6") < ms("50ms", "s", "h1x1"), `${ms("50ms", "s", "h1x6")} < ${ms("50ms", "s", "h1x1")} ms`);
      ctx.check("요청 왕복이 지배하는 1KB × 50 에서는 HTTP/2 가 HTTP/1.1 연결 6개보다 빠르다 (≈9 왕복 → 1~2 왕복)", ms("50ms", "s", "h2") < ms("50ms", "s", "h1x6"), `${ms("50ms", "s", "h2")} < ${ms("50ms", "s", "h1x6")} ms`);
      const slowStart = ms("50ms", "m", "h2") >= ms("50ms", "m", "h1x6");
      ctx.note(
        slowStart
          ? `20KB × 50(1MB)에서는 HTTP/2(${ms("50ms", "m", "h2")}ms)가 HTTP/1.1×6(${ms("50ms", "m", "h1x6")}ms)보다 느렸다. 데이터가 많으면 연결 하나의 혼잡 윈도(초기 10 세그먼트 ≈ 14KB)가 슬로 스타트로 커지는 데 여러 RTT 가 걸리는데, 연결 6개는 처음부터 윈도가 6배다. 다중화는 '요청 왕복' 을 없애 줄 뿐 한 연결의 대역폭 상승 속도는 그대로다.`
          : `20KB × 50(1MB)에서도 HTTP/2(${ms("50ms", "m", "h2")}ms)가 HTTP/1.1×6(${ms("50ms", "m", "h1x6")}ms)보다 빨랐다. 이 실행에서는 슬로 스타트 한계보다 요청 왕복 절약이 컸다 — 데이터가 더 커지면 역전된다.`,
      );
      const pen = (z: string, m: string) => ms("50ms+손실2%", z, m) / Math.max(1, ms("50ms", z, m));
      ctx.note(`손실 2% 를 더했을 때 느려진 배수 — 20KB: HTTP/2 ${pen("m", "h2").toFixed(2)}배, HTTP/1.1×6 ${pen("m", "h1x6").toFixed(2)}배. HTTP/2 가 더 크게 흔들리면 그것이 TCP 머리 막힘이다 — 연결 하나의 손실이 50개 스트림 모두를 세운다. 연결 6개는 손실이 한 연결에만 영향을 준다. (작은 표본이라 실행마다 순서가 바뀔 수 있다)`);
      ctx.note("HTTP/3 은 이 이미지의 nginx 가 http_v3_module 을 갖고 있지만 alpine curl 에 HTTP3 지원이 없어 여기서는 재지 않았다. 설정과 측정 방법은 노트 01·02 에.");
    } finally {
      await teardown(ctx);
      guard.disarm();
    }
  },
};

// ------------------------------------------------------------------------------------------ 3. 혼잡 제어 · 버퍼블로트
export const netpCongestionControl: ShellExperiment = {
  id: "netp-congestion-control",
  subject: "network-protocols",
  title: "혼잡 제어와 버퍼블로트: Reno vs CUBIC 을 같은 손실 링크에서, 그리고 깊은 큐가 지연을 부풀리는 모습",
  category: "TCP",
  summary: "이 Docker VM 커널이 제공하는 혼잡 제어 알고리즘(BBR 유무)을 확인하고, 지연 50ms·손실 0.5% 링크에서 iperf3 -C reno / cubic 을 3회씩 비교한다. 이어 10Mbit/s 병목에 큐 깊이 1000 vs 20 패킷을 두고 업로드 중 ping RTT 를 재 버퍼블로트를 보여 준다",
  notes: ["04-congestion-control", "05-loss-latency-throughput"],
  description: `
혼잡 제어는 "네트워크가 얼마나 받아 줄 수 있나" 를 손실·지연 신호로 추정한다. **Reno** 는 손실마다 윈도를 절반으로 줄이고 RTT 당 1 MSS 씩 키운다. **CUBIC**(리눅스 기본)은 손실 직전 윈도를 기억하고 3차 함수로 빠르게 되돌아가 고-BDP 경로에서 강하다. **BBR** 은 손실이 아니라 측정한 병목 대역폭·최소 RTT 로 보내는 속도를 정한다.
손실 기반 알고리즘의 부작용이 **버퍼블로트**다. 병목 앞 큐가 깊으면 TCP 는 큐가 넘칠 때까지 윈도를 키우고, 그동안 같은 링크를 쓰는 모든 패킷이 큐에서 기다린다 — 처리량은 그대로인데 지연만 수백 ms 로 부푼다.
`,
  code: `cat /proc/sys/net/ipv4/tcp_available_congestion_control      # 이 커널: reno cubic (bbr 없음)
docker exec lab-netp-cli tc qdisc replace dev eth0 root netem delay 50ms loss 0.5%
docker exec lab-netp-cli iperf3 -c lab-netp-srv -t 5 -C reno
docker exec lab-netp-cli iperf3 -c lab-netp-srv -t 5 -C cubic
# 버퍼블로트: 10Mbit/s 병목 + 큐 1000 패킷 vs 20 패킷
docker exec lab-netp-cli tc qdisc replace dev eth0 root netem rate 10mbit limit 1000
docker exec -d lab-netp-cli iperf3 -c lab-netp-srv -t 8 ; docker exec lab-netp-cli ping -c 4 lab-netp-srv`,
  requires: requiresDocker,
  cleanup: teardown,
  async run(ctx) {
    const guard = await setup(ctx);
    try {
      const avail = (await ctx.sh("docker", ["exec", CLI, "cat", "/proc/sys/net/ipv4/tcp_available_congestion_control"], { label: "cat /proc/sys/net/ipv4/tcp_available_congestion_control   # 이 커널이 가진 알고리즘" })).out.trim();
      const algos = avail.split(/\s+/);
      ctx.note(algos.includes("bbr") ? "이 커널은 BBR 을 지원한다 — 비교에 bbr 도 넣는다." : `이 커널(Docker Desktop linuxkit)에는 BBR 이 없다(${avail}). 모듈을 올릴 수도 없으므로 손실 기반인 reno 와 cubic 을 비교하고, BBR 은 노트 04 에서 원리와 운영 사례로 다룬다.`);
      const ccs = ["reno", "cubic", ...(algos.includes("bbr") ? ["bbr"] : [])].filter((c) => algos.includes(c));
      await netem(ctx, CLI, "delay 50ms loss 0.5%");
      const res = new Map<string, number[]>();
      for (let round = 0; round < 3; round++) {
        for (const cc of ccs) {
          const r = await iperf(ctx, 5, cc, `iperf3 -c ${SRV} -t 5 -C ${cc}   # 지연 50ms·손실 0.5%, ${round + 1}회차`);
          res.set(cc, [...(res.get(cc) ?? []), r.mbps]);
        }
      }
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      ctx.table("지연 50ms · 손실 0.5% 에서 업로드 처리량 (Mbit/s, 3회)", ["알고리즘", "1회", "2회", "3회", "중앙값"], ccs.map((cc) => [cc, ...(res.get(cc) ?? []).map(f1), f1(med(res.get(cc) ?? [0]))]));
      ctx.check("모든 알고리즘이 손실 링크에서 데이터를 보냈다", ccs.every((cc) => med(res.get(cc) ?? [0]) > 0.1));
      const ratio = med(res.get("cubic") ?? [0]) / Math.max(0.01, med(res.get("reno") ?? [0]));
      ctx.note(`CUBIC/Reno = ${ratio.toFixed(2)}배. 손실 직후 회복이 RTT 당 1 MSS(선형)인 Reno 보다 CUBIC 이 손실 직전 윈도로 빨리 돌아가므로, 고-BDP·간헐 손실 경로에서 CUBIC 이 대개 앞선다. RTT 가 짧은 LAN 에서는 둘이 거의 같다.`);

      // 버퍼블로트
      ctx.note("버퍼블로트 — 10Mbit/s 병목 앞 큐 깊이만 바꾼다");
      const bloat: string[][] = [];
      const pingAvg = async (label: string) => {
        const p = await ctx.sh("docker", ["exec", CLI, "ping", "-c", "5", "-i", "0.4", "-q", SRV], { allowFail: true, label });
        const m = p.out.match(/= [\d.]+\/([\d.]+)\//);
        return m ? Number(m[1]) : NaN;
      };
      const loaded: Record<string, { idle: number; busy: number; mbps: number }> = {};
      for (const limit of [1000, 20]) {
        await netem(ctx, CLI, `rate 10mbit limit ${limit}`);
        const idle = await pingAvg(`ping ×5   # 큐 ${limit} 패킷, 유휴`);
        const bg = exec("docker", ["exec", CLI, "iperf3", "-c", SRV, "-t", "8", "-J"], { timeout: 40_000 });
        await ctx.sleep(2500);
        const busy = await pingAvg(`ping ×5   # 큐 ${limit} 패킷, 업로드로 링크 포화 중`);
        const r = await bg;
        let mbps = 0;
        try {
          mbps = (JSON.parse(r.out) as { end: { sum_received: { bits_per_second: number } } }).end.sum_received.bits_per_second / 1e6;
        } catch {
          /* ignore */
        }
        loaded[String(limit)] = { idle, busy, mbps };
        bloat.push([`${limit} 패킷 (≈ ${Math.round((limit * 1500 * 8) / 10e6 * 1000)}ms 분량)`, f1(idle), f1(busy), f1(mbps)]);
      }
      await clearNetem(CLI);
      ctx.table("업로드 중 같은 링크의 ping 평균 RTT", ["병목 큐 깊이", "유휴 RTT(ms)", "포화 중 RTT(ms)", "업로드 Mbit/s"], bloat);
      const deep = loaded["1000"], shallow = loaded["20"];
      ctx.check("깊은 큐(1000)에서 포화 중 RTT 가 유휴보다 크게 부푼다 (10배 이상)", deep.busy > deep.idle * 10, `${f1(deep.idle)} → ${f1(deep.busy)} ms`);
      ctx.check("얕은 큐(20)는 같은 포화에서 지연이 깊은 큐보다 훨씬 작다", shallow.busy < deep.busy / 2, `${f1(shallow.busy)} < ${f1(deep.busy)} / 2`);
      ctx.check("큐를 얕게 해도 처리량은 거의 그대로 (깊은 큐의 70% 이상)", shallow.mbps > deep.mbps * 0.7, `${f1(shallow.mbps)} vs ${f1(deep.mbps)} Mbit/s`);
      ctx.note("깊은 큐는 처리량을 늘리지 않고 지연만 늘린다. 실무 해법은 큐를 짧게 유지하는 AQM(fq_codel·CAKE)과, 손실이 아니라 지연·대역폭으로 속도를 정하는 BBR 이다. 사용자가 느끼는 '업로드만 하면 화상회의가 끊긴다' 가 이 현상이다.");
    } finally {
      await teardown(ctx);
      guard.disarm();
    }
  },
};
