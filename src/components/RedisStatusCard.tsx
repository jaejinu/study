import { getRedisStatus } from "@/lib/redis";
import { Badge, Card, RedisDown } from "./ui";

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분 ${s % 60}초`;
}

export async function RedisStatusCard() {
  const st = await getRedisStatus();
  if (!st.ok || !st.info) return <RedisDown error={st.error} url={st.url} />;
  const i = st.info;
  const hitRate = i.keyspaceHits + i.keyspaceMisses ? ((i.keyspaceHits / (i.keyspaceHits + i.keyspaceMisses)) * 100).toFixed(1) + "%" : "-";
  const items: [string, string][] = [
    ["버전", `${i.version} (${i.mode})`],
    ["업타임", uptime(i.uptimeSeconds)],
    ["키 개수", i.dbKeys.toLocaleString()],
    ["메모리", `${i.usedMemoryHuman} / ${i.maxmemoryHuman}`],
    ["축출 정책", i.maxmemoryPolicy],
    ["클라이언트", String(i.connectedClients)],
    ["누적 명령", i.totalCommands.toLocaleString()],
    ["캐시 히트율", hitRate],
    ["AOF", i.aofEnabled ? "켜짐" : "꺼짐"],
  ];
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-ok" />
        <span className="text-sm font-semibold">Redis 연결됨</span>
        <code className="text-xs text-muted">{st.url}</code>
        <Badge tone="ok">PONG</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] uppercase tracking-wide text-muted">{k}</dt>
            <dd className="font-mono text-[13px]">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
