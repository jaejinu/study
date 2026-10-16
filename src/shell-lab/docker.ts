import path from "node:path";
import { exec } from "./runner";
import type { ShellCtx, ShellExperiment } from "./types";

const LAB_DIR = path.join(process.cwd(), "docker", "lab");

async function requiresDocker(): Promise<string | null> {
  const r = await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 6000 });
  if (!r.ok) return /ENOENT|not found/i.test(r.err) ? "docker CLI 가 없습니다. Docker Desktop 또는 OrbStack 을 설치하세요." : "Docker 데몬에 연결할 수 없습니다. Docker Desktop 을 실행하세요.";
  return null;
}

async function cleanupLab(ctx: ShellCtx) {
  const ps = await exec("docker", ["ps", "-aq", "--filter", "name=^lab-"]);
  if (ps.out) await ctx.sh("docker", ["rm", "-f", ...ps.out.split("\n")], { allowFail: true });
  const vols = await exec("docker", ["volume", "ls", "-q", "--filter", "name=^lab-"]);
  if (vols.out) await ctx.sh("docker", ["volume", "rm", ...vols.out.split("\n")], { allowFail: true });
  const nets = await exec("docker", ["network", "ls", "-q", "--filter", "name=^lab-"]);
  if (nets.out) await ctx.sh("docker", ["network", "rm", ...nets.out.split("\n")], { allowFail: true });
}

export const dockerImageLayers: ShellExperiment = {
  id: "docker-image-layers",
  subject: "docker",
  title: "이미지 레이어와 빌드 캐시",
  category: "이미지",
  summary: "작은 Dockerfile 을 두 번 빌드해 캐시 효과를 재고, 레이어별 크기로 '같은 RUN 에서 지워야 작아진다' 를 확인",
  notes: ["03-images-dockerfile", "06-optimization-security"],
  description: `
\`docker/lab/Dockerfile\` 은 일부러 세 가지 패턴을 넣었다.
1. 5MB 파일을 만들고 **같은 RUN** 에서 지움 → 레이어 크기 거의 0
2. 5MB 파일을 만들고 **다음 RUN** 에서 지움 → 만든 레이어는 5MB 그대로, 지운 레이어는 0 (whiteout 만 기록)
3. \`COPY payload.txt\` → 파일 내용이 바뀌면 그 아래 레이어 캐시가 모두 무효화

두 번째 빌드는 모든 레이어가 CACHED 라 훨씬 빠르다.
`,
  code: `docker build -t lab-layers docker/lab           # 첫 빌드
docker build -t lab-layers docker/lab           # 두 번째: 전부 CACHED
docker history --human=false lab-layers         # 레이어별 바이트
docker image inspect lab-layers --format '{{.Size}}'
docker run --rm lab-layers`,
  requires: requiresDocker,
  cleanup: async (ctx) => {
    await cleanupLab(ctx);
    await ctx.sh("docker", ["rmi", "-f", "lab-layers"], { allowFail: true });
  },
  async run(ctx) {
    const first = await ctx.measure("첫 빌드", () => ctx.sh("docker", ["build", "-t", "lab-layers", "--progress=plain", LAB_DIR], { timeout: 300_000 }));
    const second = await ctx.measure("두 번째 빌드 (캐시)", () => ctx.sh("docker", ["build", "-t", "lab-layers", "--progress=plain", LAB_DIR], { timeout: 300_000 }));
    const cached = (second.value.err.match(/CACHED/g) ?? []).length;
    ctx.check(`두 번째 빌드에서 CACHED ${cached}회, ${first.ms}ms → ${second.ms}ms`, cached >= 4 && second.ms < first.ms);

    const hist = await ctx.sh("docker", ["history", "--human=false", "--no-trunc", "--format", "{{.Size}}\t{{.CreatedBy}}", "lab-layers"]);
    const rows = hist.out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [size, ...rest] = l.split("\t");
        return { size: Number(size), createdBy: rest.join("\t").replace(/^(RUN )?(\/bin\/sh -c )?(#\(nop\) )?/, "").replace(/ # buildkit$/, "").slice(0, 120) };
      })
      .reverse();
    ctx.layers("레이어별 크기 (아래가 베이스, 위가 최신)", rows);
    const big = rows.find((r) => /of=\/tmp\/b/.test(r.createdBy));
    const small = rows.find((r) => /of=\/tmp\/a/.test(r.createdBy));
    const rm = rows.find((r) => /^rm \/tmp\/b/.test(r.createdBy));
    ctx.check("같은 RUN 에서 지운 레이어는 거의 0", !!small && small.size < 100_000, `${small?.size} bytes`);
    ctx.check("다음 RUN 에서 지운 파일의 레이어는 5MB 그대로", !!big && big.size >= 5 * 1024 * 1024, `${big?.size} bytes`);
    ctx.check("rm 레이어는 whiteout 메타데이터만 (수 KB)", !!rm && rm.size < 64 * 1024, `${rm?.size} bytes`);
    await ctx.sh("docker", ["image", "inspect", "lab-layers", "--format", "총 크기 {{.Size}} bytes, 레이어 {{len .RootFS.Layers}}개"]);
    await ctx.sh("docker", ["run", "--rm", "lab-layers"]);
  },
};

export const dockerLifecycle: ShellExperiment = {
  id: "docker-container-lifecycle",
  subject: "docker",
  title: "컨테이너 생명주기: run → logs → exec → stop → start → rm",
  category: "컨테이너",
  summary: "Redis 컨테이너로 기본 명령을 순서대로 실행하고, stop/start 사이에 데이터가 남는지, rm 뒤엔 사라지는지 확인",
  notes: ["02-first-container"],
  description: `
컨테이너는 이미지 위에 **쓰기 가능한 레이어**를 얹은 프로세스다. \`stop\` 은 프로세스만 종료하고 레이어는 남겨 두므로 \`start\` 하면 데이터가 그대로다.
\`rm\` 은 레이어를 지우므로 데이터도 사라진다. 그래서 지속 데이터는 볼륨에 둔다 (다음 실험).
호스트 포트는 다른 Redis 와 겹치지 않게 16379 를 쓴다.
`,
  code: `docker run -d --name lab-redis -p 127.0.0.1:16379:6379 redis:8-alpine
docker ps --filter name=lab-redis
docker logs lab-redis | tail -n 3
docker exec lab-redis redis-cli SET k v
docker stop lab-redis && docker start lab-redis
docker exec lab-redis redis-cli GET k         # "v" 남아 있음
docker rm -f lab-redis
docker run -d --name lab-redis redis:8-alpine
docker exec lab-redis redis-cli GET k         # (nil)`,
  requires: requiresDocker,
  cleanup: cleanupLab,
  async run(ctx) {
    await ctx.sh("docker", ["run", "-d", "--name", "lab-redis", "-p", "127.0.0.1:16379:6379", "redis:8-alpine"], { timeout: 120_000 });
    await ctx.poll("redis 가 응답할 때까지", async () => ((await exec("docker", ["exec", "lab-redis", "redis-cli", "ping"])).out === "PONG" ? true : undefined), { timeoutMs: 30_000, intervalMs: 500 });
    await ctx.sh("docker", ["ps", "--filter", "name=lab-redis", "--format", "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"]);
    const logs = await ctx.sh("docker", ["logs", "--tail", "3", "lab-redis"]);
    ctx.check("로그에 Ready to accept connections", /Ready to accept connections/.test(logs.out + logs.err));
    await ctx.sh("docker", ["exec", "lab-redis", "redis-cli", "SET", "k", "v"]);
    await ctx.sh("docker", ["top", "lab-redis"]);

    ctx.note("stop → start: 쓰기 레이어가 유지된다");
    await ctx.sh("docker", ["stop", "lab-redis"]);
    await ctx.sh("docker", ["ps", "-a", "--filter", "name=lab-redis", "--format", "{{.Names}} {{.Status}}"]);
    await ctx.sh("docker", ["start", "lab-redis"]);
    await ctx.poll("재시작 후 응답", async () => ((await exec("docker", ["exec", "lab-redis", "redis-cli", "ping"])).out === "PONG" ? true : undefined), { timeoutMs: 30_000, intervalMs: 500 });
    const v = await ctx.sh("docker", ["exec", "lab-redis", "redis-cli", "GET", "k"]);
    ctx.check("데이터가 남아 있다 (RDB 저장 + 컨테이너 레이어)", v.out === "v", v.out);

    ctx.note("rm → 새 컨테이너: 레이어가 사라진다");
    await ctx.sh("docker", ["rm", "-f", "lab-redis"]);
    await ctx.sh("docker", ["run", "-d", "--name", "lab-redis", "redis:8-alpine"]);
    await ctx.poll("응답", async () => ((await exec("docker", ["exec", "lab-redis", "redis-cli", "ping"])).out === "PONG" ? true : undefined), { timeoutMs: 30_000, intervalMs: 500 });
    const gone = await ctx.sh("docker", ["exec", "lab-redis", "redis-cli", "GET", "k"]);
    ctx.check("새 컨테이너엔 k 가 없다", gone.out === "", gone.out || "(nil)");
    await ctx.sh("docker", ["inspect", "-f", "{{.State.Status}} exit={{.State.ExitCode}} pid={{.State.Pid}}", "lab-redis"]);
  },
};

export const dockerVolumes: ShellExperiment = {
  id: "docker-volumes",
  subject: "docker",
  title: "볼륨: 컨테이너를 지워도 데이터는 남는다",
  category: "스토리지",
  summary: "named volume 에 Redis 데이터를 두고 컨테이너를 삭제·재생성해 데이터 유지 확인, bind mount 로 설정 파일 주입",
  notes: ["04-volumes-networks"],
  description: `
볼륨은 Docker 가 관리하는 호스트 디렉터리로, 컨테이너 생명주기와 분리된다. 같은 볼륨을 새 컨테이너에 붙이면 데이터가 그대로 보인다.
bind mount 는 호스트의 특정 파일/디렉터리를 그대로 넣는다 (설정 파일, 소스 코드). 이 프로젝트의 \`redis/redis.conf\` 를 읽기 전용으로 넣어 본다.
`,
  code: `docker volume create lab-data
docker run -d --name lab-v1 -v lab-data:/data redis:8-alpine --appendonly yes
docker exec lab-v1 redis-cli SET persisted yes
docker rm -f lab-v1
docker run -d --name lab-v2 -v lab-data:/data redis:8-alpine --appendonly yes
docker exec lab-v2 redis-cli GET persisted          # yes
docker run --rm -v $PWD/redis/redis.conf:/etc/redis.conf:ro redis:8-alpine cat /etc/redis.conf | head`,
  requires: requiresDocker,
  cleanup: cleanupLab,
  async run(ctx) {
    await ctx.sh("docker", ["volume", "create", "lab-data"]);
    await ctx.sh("docker", ["run", "-d", "--name", "lab-v1", "-v", "lab-data:/data", "redis:8-alpine", "--appendonly", "yes"]);
    await ctx.poll("응답", async () => ((await exec("docker", ["exec", "lab-v1", "redis-cli", "ping"])).out === "PONG" ? true : undefined), { timeoutMs: 30_000, intervalMs: 500 });
    await ctx.sh("docker", ["exec", "lab-v1", "redis-cli", "SET", "persisted", "yes"]);
    await ctx.sh("docker", ["exec", "lab-v1", "ls", "-la", "/data"]);
    await ctx.sh("docker", ["rm", "-f", "lab-v1"]);
    await ctx.sh("docker", ["volume", "inspect", "lab-data", "--format", "{{.Mountpoint}}"]);

    await ctx.sh("docker", ["run", "-d", "--name", "lab-v2", "-v", "lab-data:/data", "redis:8-alpine", "--appendonly", "yes"]);
    await ctx.poll("응답", async () => ((await exec("docker", ["exec", "lab-v2", "redis-cli", "ping"])).out === "PONG" ? true : undefined), { timeoutMs: 30_000, intervalMs: 500 });
    const v = await ctx.sh("docker", ["exec", "lab-v2", "redis-cli", "GET", "persisted"]);
    ctx.check("새 컨테이너에서도 값이 보인다 (AOF 가 볼륨에)", v.out === "yes", v.out);

    ctx.note("bind mount 로 프로젝트의 redis.conf 를 읽기 전용으로 넣기");
    const conf = path.join(process.cwd(), "redis", "redis.conf");
    const head = await ctx.sh("docker", ["run", "--rm", "-v", `${conf}:/etc/redis.conf:ro`, "redis:8-alpine", "sh", "-c", "head -n 5 /etc/redis.conf && (echo x >> /etc/redis.conf || echo 'read-only: 쓰기 거부됨')"]);
    ctx.check("읽기 전용이라 쓰기가 거부된다", /Read-only|read-only/i.test(head.out + head.err));
  },
};

export const dockerNetwork: ShellExperiment = {
  id: "docker-network",
  subject: "docker",
  title: "네트워크: 컨테이너 이름이 DNS 가 된다",
  category: "네트워킹",
  summary: "사용자 정의 브리지 네트워크에서 이름으로 접속하고, 기본 bridge 에서는 안 되는 것을 비교",
  notes: ["04-volumes-networks", "05-compose"],
  description: `
사용자 정의 네트워크(\`docker network create\`)에는 내장 DNS 가 있어 **컨테이너 이름으로** 통신할 수 있다. 기본 \`bridge\` 네트워크에는 없다.
Compose 가 서비스 이름으로 접속되는 이유도 프로젝트마다 네트워크를 만들어 주기 때문이다.
`,
  code: `docker network create lab-net
docker run -d --name lab-redis --network lab-net redis:8-alpine
docker run --rm --network lab-net redis:8-alpine redis-cli -h lab-redis ping    # PONG
docker run --rm redis:8-alpine redis-cli -h lab-redis ping                      # 기본 bridge: 이름 해석 실패
docker network inspect lab-net`,
  requires: requiresDocker,
  cleanup: cleanupLab,
  async run(ctx) {
    await ctx.sh("docker", ["network", "create", "lab-net"]);
    await ctx.sh("docker", ["run", "-d", "--name", "lab-redis", "--network", "lab-net", "redis:8-alpine"]);
    await ctx.poll("응답", async () => ((await exec("docker", ["exec", "lab-redis", "redis-cli", "ping"])).out === "PONG" ? true : undefined), { timeoutMs: 30_000, intervalMs: 500 });
    const ok = await ctx.sh("docker", ["run", "--rm", "--network", "lab-net", "redis:8-alpine", "redis-cli", "-h", "lab-redis", "ping"]);
    ctx.check("같은 네트워크에서 이름으로 PONG", ok.out === "PONG", ok.out);
    const fail = await ctx.sh("docker", ["run", "--rm", "redis:8-alpine", "redis-cli", "-h", "lab-redis", "-t", "2", "ping"], { allowFail: true, timeout: 20_000 });
    ctx.check("기본 bridge 에서는 이름을 못 찾는다", !fail.ok || /Could not|not known|resolve|Connection|error/i.test(fail.out + fail.err), (fail.out + fail.err).split("\n")[0]);
    await ctx.sh("docker", ["network", "inspect", "lab-net", "--format", "{{range .Containers}}{{.Name}} → {{.IPv4Address}}\n{{end}}"]);
    await ctx.sh("docker", ["exec", "lab-redis", "cat", "/etc/resolv.conf"]);
  },
};
